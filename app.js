/* ─────────────────────────────────────────────────────────
   Flow — Consultant Time Tracker
   app.js — All application logic
   ───────────────────────────────────────────────────────── */

'use strict';

// ── Constants ──────────────────────────────────────────────
const GIST_FILENAME = 'flow-time-tracker.json';
const DAY_START     = 7;   // 7am
const DAY_END       = 22;  // 10pm
const SLOT_MINS     = 30;
const CORS_PROXY    = 'https://corsproxy.io/?';

const PRESET_COLORS = [
  '#6c63ff', '#f59e0b', '#34d399', '#f87171',
  '#60a5fa', '#e879f9', '#fb923c', '#a3e635',
  '#38bdf8', '#f472b6', '#4ade80', '#facc15'
];

// ── State ──────────────────────────────────────────────────
const State = {
  pat:          null,
  gistId:       null,
  icalUrl:      null,
  clients:      [],   // { id, name, color, rate }
  projects:     [],   // { id, clientId, name }
  blocks:       {},   // { 'YYYY-MM-DD': { 'HH:MM': { clientId, projectId, notes } } }
  currentDay:   new Date(),
  summaryMonth: new Date(),
  summaryRangeMode: 'month',    // 'week' | 'month' | 'quarter' | 'ytd' | 'custom'
  summaryRangeRef:  new Date(), // anchor date for week/month/quarter nav
  summaryCustomStart: null,
  summaryCustomEnd:   null,
  summaryShowEarnings: false,   // toggle stat cards between hrs and $
  activeTab:    'today',
  calEvents:    [],   // parsed events for current day
  editingBlock: null, // { date, slot }
  editingClientId: null,
  editingProjectId: null,
  syncing:      false,
  initialized:  false,
  invoices:     {},   // { 'YYYY-MM': { clientId: { sentDate, paidDate } } }
  editingInvoiceYM:       null,
  editingInvoiceClientId: null,
  weeklyHoursTarget: 50,  // user-adjustable weekly hours upper bound
};

// ── Local Storage helpers ──────────────────────────────────
const LS = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};

// ── ID generator ───────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Date helpers ───────────────────────────────────────────
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function slotKey(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseSlot(slot) {
  const [h, m] = slot.split(':').map(Number);
  return { h, m };
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfWeek(d) {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() - day);
  r.setHours(0, 0, 0, 0);
  return r;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatShortDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatMonthYear(d) {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function isToday(d) {
  const t = new Date();
  return d.getFullYear() === t.getFullYear() &&
         d.getMonth() === t.getMonth() &&
         d.getDate() === t.getDate();
}

// ── Toast ──────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, dur = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

// ── Sync indicator ─────────────────────────────────────────
function setSyncing(v) {
  State.syncing = v;
  document.getElementById('sync-indicator').style.display = v ? 'block' : 'none';
}

// ── GitHub Gist API ────────────────────────────────────────
const Gist = {
  headers() {
    return {
      'Authorization': `token ${State.pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  },

  async load() {
    const res = await fetch(`https://api.github.com/gists/${State.gistId}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Gist load failed: ${res.status}`);
    const data = await res.json();
    const file = data.files[GIST_FILENAME];
    if (!file || !file.content) return;
    const parsed = JSON.parse(file.content);
    // Merge remote into State
    State.clients  = parsed.clients  || [];
    State.projects = parsed.projects || [];
    State.blocks   = parsed.blocks   || {};
    State.icalUrl  = parsed.icalUrl  || State.icalUrl;
    // Migrate invoices to per-client-per-month format:
    // v1: { 'YYYY-MM': true }
    // v2: { 'YYYY-MM': { sentDate, paidDate } }
    // v3 (current): { 'YYYY-MM': { clientId: { sentDate, paidDate } } }
    const rawInvoices = parsed.invoices || {};
    State.invoices = {};
    for (const [ym, val] of Object.entries(rawInvoices)) {
      if (!val) continue;
      // Detect old per-month formats (v1/v2): val is true, or has sentDate/paidDate/legacy at top level
      const isOldFormat = val === true || val.sentDate !== undefined || val.paidDate !== undefined || val.legacy === true;
      if (isOldFormat) {
        // Find which client(s) had hours in this month from already-loaded blocks
        const [y, m] = ym.split('-').map(Number);
        const clientHours = {};
        let d2 = new Date(y, m - 1, 1);
        const mEnd = new Date(y, m, 0);
        while (d2 <= mEnd) {
          const dk2 = dateKey(d2);
          for (const block of Object.values(State.blocks[dk2] || {})) {
            if (block && block.clientId) clientHours[block.clientId] = (clientHours[block.clientId] || 0) + 0.5;
          }
          d2 = addDays(d2, 1);
        }
        const clientIds = Object.keys(clientHours);
        if (clientIds.length === 1) {
          // Unambiguous single client — migrate cleanly
          const invData = val === true
            ? { sentDate: null, paidDate: null }
            : { sentDate: val.sentDate || null, paidDate: val.paidDate || null };
          State.invoices[ym] = { [clientIds[0]]: invData };
        }
        // If multiple or no clients, drop the legacy record (can't assign unambiguously)
      } else {
        // Already v3 per-client format
        State.invoices[ym] = val;
      }
    }
    State.weeklyHoursTarget = parsed.weeklyHoursTarget || 50;
  },

  async save() {
    const payload = {
      clients:           State.clients,
      projects:          State.projects,
      blocks:            State.blocks,
      icalUrl:           State.icalUrl || null,
      invoices:          State.invoices,
      weeklyHoursTarget: State.weeklyHoursTarget,
    };
    const res = await fetch(`https://api.github.com/gists/${State.gistId}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) }
        }
      }),
    });
    if (!res.ok) throw new Error(`Gist save failed: ${res.status}`);
  },

  async create(pat) {
    const payload = {
      clients: [], projects: [], blocks: {}, icalUrl: null
    };
    const res = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        'Authorization': `token ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        description: 'Flow Time Tracker Data',
        public: false,
        files: {
          [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) }
        }
      }),
    });
    if (!res.ok) throw new Error(`Gist create failed: ${res.status}`);
    const data = await res.json();
    return data.id;
  },

  async syncWithRetry() {
    setSyncing(true);
    try {
      await this.save();
    } catch (err) {
      showToast('Sync failed — ' + err.message);
    } finally {
      setSyncing(false);
    }
  }
};

// ── iCal parser ────────────────────────────────────────────
const ICal = {
  async fetchForDay(day) {
    if (!State.icalUrl) return [];
    try {
      const url = CORS_PROXY + encodeURIComponent(State.icalUrl);
      const res = await fetch(url);
      if (!res.ok) return [];
      const text = await res.text();
      return this.parseForDay(text, day);
    } catch {
      return [];
    }
  },

  parseForDay(icsText, day) {
    const events = [];
    const lines = icsText.replace(/\r\n /g, '').replace(/\r\n\t/g, '').split(/\r?\n/);
    let current = null;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') {
        current = {};
      } else if (line === 'END:VEVENT' && current) {
        if (current.start && current.end && current.summary) {
          events.push(current);
        }
        current = null;
      } else if (current) {
        if (line.startsWith('SUMMARY:')) {
          current.summary = line.slice(8).trim();
        } else if (line.startsWith('DTSTART')) {
          current.start = this.parseDate(line.split(':')[1]);
        } else if (line.startsWith('DTEND')) {
          current.end = this.parseDate(line.split(':')[1]);
        }
      }
    }
    // Filter events that overlap with day
    const dayStr = dateKey(day);
    return events.filter(ev => {
      if (!ev.start || !ev.end) return false;
      return dateKey(ev.start) === dayStr;
    });
  },

  parseDate(str) {
    if (!str) return null;
    str = str.trim();
    // YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS or YYYYMMDD
    const m = str.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
    if (!m) return null;
    const [, y, mo, d, h = '00', mi = '00'] = m;
    const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:00`);
    return isNaN(date.getTime()) ? null : date;
  },

  // Returns which 30-min slots an event covers
  eventSlots(ev) {
    const slots = [];
    let cur = new Date(ev.start);
    // Round down to nearest 30
    cur.setMinutes(cur.getMinutes() < 30 ? 0 : 30, 0, 0);
    const end = new Date(ev.end);
    while (cur < end) {
      const h = cur.getHours();
      const m = cur.getMinutes();
      if (h >= DAY_START && h < DAY_END) {
        slots.push(slotKey(h, m));
      }
      cur = new Date(cur.getTime() + 30 * 60000);
    }
    return slots;
  }
};

// ── Data access ────────────────────────────────────────────
function getClient(id) { return State.clients.find(c => c.id === id); }
function getProject(id) { return State.projects.find(p => p.id === id); }
function getBlock(date, slot) {
  return (State.blocks[date] || {})[slot] || null;
}
function setBlock(date, slot, data) {
  if (!State.blocks[date]) State.blocks[date] = {};
  State.blocks[date][slot] = data;
}
function clearBlock(date, slot) {
  if (State.blocks[date]) {
    delete State.blocks[date][slot];
    if (Object.keys(State.blocks[date]).length === 0) {
      delete State.blocks[date];
    }
  }
}

// Calculate total hours for a set of slots
function slotsToHours(count) { return (count * 0.5); }

// ── Aggregate helpers ──────────────────────────────────────
function aggregateRange(startDate, endDate) {
  // Returns { byClient: { clientId: { hours, byProject: { projectId: hours } } } }
  const result = {};
  let d = new Date(startDate);
  d.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  while (d <= end) {
    const dk = dateKey(d);
    const dayBlocks = State.blocks[dk] || {};
    for (const [, block] of Object.entries(dayBlocks)) {
      if (!block || !block.clientId) continue;
      const { clientId, projectId } = block;
      if (!result[clientId]) result[clientId] = { hours: 0, byProject: {} };
      result[clientId].hours += 0.5;
      if (projectId) {
        if (!result[clientId].byProject[projectId]) result[clientId].byProject[projectId] = 0;
        result[clientId].byProject[projectId] += 0.5;
      }
    }
    d = addDays(d, 1);
  }
  return result;
}

// ── Summary range helper ────────────────────────────────────
function getSummaryDateRange() {
  const ref = State.summaryRangeRef;
  switch (State.summaryRangeMode) {
    case 'week': {
      const start = startOfWeek(new Date(ref));
      const end   = addDays(start, 6);
      return { start, end };
    }
    case 'quarter': {
      const q     = Math.floor(ref.getMonth() / 3);
      const start = new Date(ref.getFullYear(), q * 3, 1);
      const end   = new Date(ref.getFullYear(), q * 3 + 3, 0);
      return { start, end };
    }
    case 'ytd': {
      const now   = new Date();
      const start = new Date(now.getFullYear(), 0, 1);
      const end   = now;
      return { start, end };
    }
    case 'custom': {
      const start = State.summaryCustomStart || startOfMonth(new Date());
      const end   = State.summaryCustomEnd   || endOfMonth(new Date());
      return { start, end };
    }
    default: { // month
      return { start: startOfMonth(ref), end: endOfMonth(ref) };
    }
  }
}

function formatRangeLabel() {
  const { start, end } = getSummaryDateRange();
  switch (State.summaryRangeMode) {
    case 'week':
      return `${formatShortDate(start)} – ${formatShortDate(end)}`;
    case 'quarter': {
      const q = Math.floor(start.getMonth() / 3) + 1;
      return `Q${q} ${start.getFullYear()}`;
    }
    case 'ytd':
      return `Jan 1 – ${formatShortDate(new Date())} ${new Date().getFullYear()}`;
    case 'custom':
      return `${formatShortDate(start)} – ${formatShortDate(end)}`;
    default:
      return formatMonthYear(State.summaryRangeRef);
  }
}

// ── Chart builders ─────────────────────────────────────────
function buildDonutSVG(data, totalHours) {
  if (totalHours === 0) return '';
  const r    = 54;
  const cx   = 68, cy = 68;
  const circ = 2 * Math.PI * r;
  const GAP  = circ > 30 ? 1.5 : 0;
  let offset = 0;
  let paths  = '';
  for (const [clientId, { hours }] of Object.entries(data)) {
    const client = getClient(clientId);
    const color  = client ? client.color : '#6c63ff';
    const arc    = (hours / totalHours) * circ;
    paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="18"
      stroke-dasharray="${Math.max(arc - GAP, 0).toFixed(2)} ${(circ - arc + GAP).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})" />`;
    offset += arc;
  }
  return `<svg viewBox="0 0 136 136">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg3)" stroke-width="18"/>
    ${paths}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-center-label">${totalHours.toFixed(1)}</text>
    <text x="${cx}" y="${cy + 11}" text-anchor="middle" class="donut-center-sub">hours</text>
  </svg>`;
}

function buildDailyBarSVG(startDate, endDate) {
  // Collect per-day hours
  const days = [];
  let d = new Date(startDate);
  d.setHours(0, 0, 0, 0);
  const endD = new Date(endDate);
  endD.setHours(23, 59, 59, 999);
  while (d <= endD) {
    const dk       = dateKey(d);
    const dayData  = State.blocks[dk] || {};
    const hours    = Object.keys(dayData).length * 0.5;
    // pick dominant client color for bar
    const counts   = {};
    for (const b of Object.values(dayData)) {
      if (b && b.clientId) counts[b.clientId] = (counts[b.clientId] || 0) + 1;
    }
    const topClient = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const client    = topClient ? getClient(topClient[0]) : null;
    const color     = client ? client.color : 'var(--accent)';
    days.push({ date: new Date(d), hours, color });
    d = addDays(d, 1);
  }

  // Aggregate into bars (daily if ≤31 days, weekly otherwise)
  let bars;
  if (days.length > 31) {
    const weeks = new Map();
    for (const day of days) {
      const ws = startOfWeek(day.date);
      const wk = dateKey(ws);
      if (!weeks.has(wk)) weeks.set(wk, { date: ws, hours: 0, colorHours: {} });
      const entry = weeks.get(wk);
      entry.hours += day.hours;
      // Accumulate hours per color so dominant color wins (not just first day)
      if (day.hours > 0 && day.color !== 'var(--accent)') {
        entry.colorHours[day.color] = (entry.colorHours[day.color] || 0) + day.hours;
      }
    }
    bars = [...weeks.values()];
    bars.forEach((b, i) => {
      const top = Object.entries(b.colorHours).sort((a, z) => z[1] - a[1])[0];
      b.color = top ? top[0] : 'var(--accent)';
      b.label = `W${i + 1}`;
    });
  } else {
    bars = days;
    const DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    bars.forEach(b => {
      b.label = days.length <= 14
        ? DAYS[b.date.getDay()]
        : String(b.date.getDate());
    });
  }

  const maxH  = Math.max(...bars.map(b => b.hours), 1);
  const n     = bars.length;
  // Scale bar slot width so the chart fills at least 260px without distorting
  const SLOT  = Math.max(14, Math.floor(260 / n));
  const BAR   = Math.round(SLOT * 0.72);
  const W     = n * SLOT;
  const CHART = 52;
  const TOTAL = 68;
  let rects = '', labels = '';
  for (let i = 0; i < n; i++) {
    const b    = bars[i];
    const bH   = (b.hours / maxH) * CHART;
    const x    = i * SLOT + Math.round((SLOT - BAR) / 2);
    rects += `<rect x="${x}" y="${(CHART - bH).toFixed(1)}" width="${BAR}" height="${Math.max(bH, 1).toFixed(1)}" rx="2" fill="${b.color}" opacity="0.85"/>`;
    if (n <= 14 || i % Math.ceil(n / 12) === 0 || i === n - 1) {
      labels += `<text x="${x + BAR / 2}" y="${TOTAL - 2}" text-anchor="middle" class="bar-axis-lbl">${b.label}</text>`;
    }
  }
  // Y-axis reference lines
  const gridLines = `
    <line x1="0" y1="0" x2="${W}" y2="0" stroke="var(--border)" stroke-width="0.5"/>
    <line x1="0" y1="${CHART / 2}" x2="${W}" y2="${CHART / 2}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3 3"/>
    <text x="0" y="9" class="bar-axis-top">${maxH.toFixed(0)}h</text>
    <text x="0" y="${CHART / 2 - 2}" class="bar-axis-top">${(maxH / 2).toFixed(0)}h</text>`;

  return `<div class="daily-bar-wrap"><svg class="daily-bar-svg" viewBox="0 0 ${W} ${TOTAL}" style="width:${W}px">
    ${gridLines}${rects}${labels}
  </svg></div>`;
}

// ── Rendering helpers ──────────────────────────────────────
function hexToRgba(hex, a = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Onboarding ─────────────────────────────────────────────
function showOnboarding() {
  document.getElementById('onboarding').classList.add('visible');
}
function hideOnboarding() {
  document.getElementById('onboarding').classList.remove('visible');
}

// ── Main App object ────────────────────────────────────────
const App = {

  // ── Boot ────────────────────────────────────────────────
  async init() {
    // Register service worker — force update check on every launch
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(reg => {
        reg.update(); // check for a newer SW immediately
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed') self.skipWaiting && sw.postMessage({ type: 'SKIP_WAITING' });
          });
        });
      }).catch(() => {});
      // Reload the page when a new SW takes control
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    }

    // Load credentials from LS
    State.pat    = LS.get('flow_pat');
    State.gistId = LS.get('flow_gist');
    State.icalUrl = LS.get('flow_ical') || null;

    if (!State.pat || !State.gistId) {
      showOnboarding();
      return;
    }

    await this.loadData();
    this.initSwipe();
    this.renderToday();
    this.initialized = true;
  },

  // Fix any hig_hist entries on or after 2025-12-01 that should be hig_curr
  migrateClientTags() {
    const CUTOFF = '2025-12-01';
    let fixed = 0;
    for (const [day, slots] of Object.entries(State.blocks)) {
      if (day < CUTOFF) continue;
      for (const block of Object.values(slots)) {
        if (block && block.clientId === 'hig_hist') {
          block.clientId = 'hig_curr';
          fixed++;
        }
      }
    }
    return fixed;
  },

  async loadData() {
    setSyncing(true);
    try {
      await Gist.load();
      // Fix any mistagged entries (hig_hist after Dec 1 2025 → hig_curr)
      const fixed = this.migrateClientTags();
      if (fixed > 0) {
        await Gist.save();
        showToast(`Fixed ${fixed} mistagged entries ✓`);
      }
      // Auto-seed historical data whenever blocks is empty
      if (Object.keys(State.blocks).length === 0 && typeof SEED_DATA !== 'undefined') {
        State.clients  = SEED_DATA.clients;
        State.projects = SEED_DATA.projects;
        State.blocks   = SEED_DATA.blocks;
        await Gist.save();
        // Navigate to the most recent day that has data
        const lastDay = Object.keys(State.blocks).sort().pop();
        if (lastDay) State.currentDay = new Date(lastDay + 'T12:00:00');
        showToast(`Loaded ${Object.keys(State.blocks).length} days of history`);
      }
    } catch (err) {
      showToast('Could not load data: ' + err.message);
    } finally {
      setSyncing(false);
    }
  },

  // ── Onboarding flow ─────────────────────────────────────
  onboardNextPAT() {
    const pat = document.getElementById('ob-pat').value.trim();
    if (!pat) { showToast('Please enter your GitHub token'); return; }
    State.pat = pat;
    document.getElementById('step-pat').classList.remove('active');
    document.getElementById('step-gist').classList.add('active');
  },

  onboardBack() {
    document.getElementById('step-gist').classList.remove('active');
    document.getElementById('step-pat').classList.add('active');
  },

  async onboardFinish() {
    const btn = document.getElementById('ob-gist-btn');
    const gistInput = document.getElementById('ob-gist').value.trim();
    btn.textContent = 'Connecting…';
    btn.disabled = true;

    try {
      if (gistInput) {
        State.gistId = gistInput;
        await Gist.load();
      } else {
        State.gistId = await Gist.create(State.pat);
        showToast('Created new Gist ✓');
      }
      LS.set('flow_pat', State.pat);
      LS.set('flow_gist', State.gistId);
      hideOnboarding();
      this.renderToday();
      this.initSwipe();
      State.initialized = true;
    } catch (err) {
      showToast('Error: ' + err.message);
      btn.textContent = 'Get Started';
      btn.disabled = false;
    }
  },

  // ── Tab navigation ───────────────────────────────────────
  switchTab(tab) {
    State.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.toggle('active', s.id === `screen-${tab}`);
    });
    if (tab === 'today')     this.renderToday();
    if (tab === 'dashboard') this.renderDashboard();
    if (tab === 'summary')   this.renderSummary();
    if (tab === 'billing')   this.renderBilling();
    if (tab === 'settings')  this.renderSettings();
  },

  // ── Day navigation ───────────────────────────────────────
  dayNav(delta) {
    State.currentDay = addDays(State.currentDay, delta);
    this.renderToday();
  },

  goToday() {
    State.currentDay = new Date();
    this.renderToday();
  },

  // ── Touch/swipe on timeline ──────────────────────────────
  initSwipe() {
    const el = document.getElementById('timeline-container');
    let startX = 0, startY = 0;
    el.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.dayNav(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
  },

  // ── Timeline rendering ───────────────────────────────────
  async renderToday() {
    const day = State.currentDay;
    const dk  = dateKey(day);

    // Header
    document.getElementById('day-display').textContent = formatDate(day);
    const todayFlag = isToday(day);
    document.getElementById('day-sub').textContent = todayFlag ? '' : formatShortDate(day);
    document.getElementById('today-btn').style.display = todayFlag ? 'none' : 'inline-block';

    // Day total strip
    const dayData = State.blocks[dk] || {};
    const daySlots = Object.values(dayData).filter(b => b && b.clientId);
    const dayHours = daySlots.length * 0.5;
    const dayEarnings = daySlots.reduce((sum, b) => {
      const c = getClient(b.clientId);
      return sum + (c ? 0.5 * (c.rate || 0) : 0);
    }, 0);
    const strip = document.getElementById('day-total-strip');
    if (strip) {
      if (dayHours > 0) {
        const earnStr = '$' + dayEarnings.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        strip.innerHTML = `<span class="dts-hours">${dayHours.toFixed(1)}h</span><span class="dts-sep">·</span><span class="dts-earn">${earnStr}</span>`;
        strip.style.display = 'flex';
      } else {
        strip.style.display = 'none';
      }
    }

    // Fetch calendar events asynchronously (don't block render)
    const calPromise = ICal.fetchForDay(day);

    // Build slot map from calendar events (initial render without cal)
    let calSlots = {};
    State.calEvents = [];

    const timeline = document.getElementById('timeline');
    timeline.innerHTML = this.buildTimelineHTML(dk, calSlots);

    // Once cal loads, overlay events
    calPromise.then(events => {
      State.calEvents = events;
      calSlots = {};
      for (const ev of events) {
        for (const slot of ICal.eventSlots(ev)) {
          if (!calSlots[slot]) calSlots[slot] = [];
          calSlots[slot].push(ev.summary);
        }
      }
      timeline.innerHTML = this.buildTimelineHTML(dk, calSlots);
    });
  },

  buildTimelineHTML(dk, calSlots) {
    // Build ordered slot list and compute merge roles
    const allSlots = [];
    for (let h = DAY_START; h < DAY_END; h++) {
      for (let m = 0; m < 60; m += SLOT_MINS) allSlots.push(slotKey(h, m));
    }
    const role = {};
    let i = 0;
    while (i < allSlots.length) {
      const s = allSlots[i];
      const b = getBlock(dk, s);
      if (!b || !b.clientId) { role[s] = 'single'; i++; continue; }
      let j = i + 1;
      while (j < allSlots.length) {
        const nb = getBlock(dk, allSlots[j]);
        if (!nb || nb.clientId !== b.clientId || (nb.projectId || '') !== (b.projectId || '')) break;
        j++;
      }
      const len = j - i;
      if (len === 1) {
        role[allSlots[i]] = 'single';
      } else {
        role[allSlots[i]] = 'start';
        for (let k = i + 1; k < j - 1; k++) role[allSlots[k]] = 'mid';
        role[allSlots[j - 1]] = 'end';
      }
      i = j;
    }

    let html = '';
    for (const slot of allSlots) {
      const block   = getBlock(dk, slot);
      const calEvts = calSlots[slot] || [];
      const { h, m } = parseSlot(slot);
      const r       = role[slot] || 'single';
      const timeLabel = m === 0 ? `${h > 12 ? h - 12 : h}${h >= 12 ? 'pm' : 'am'}` : '';
      const isCont  = r === 'mid' || r === 'end';
      html += `<div class="time-row${isCont ? ' merge-cont' : ''}">
        <div class="time-label">${timeLabel}</div>
        ${this.blockHTML(dk, slot, block, calEvts, r)}
      </div>`;
    }
    return html;
  },

  blockHTML(dk, slot, block, calEvts, role = 'single') {
    if (block && block.clientId) {
      const client  = getClient(block.clientId);
      const project = getProject(block.projectId);
      const color   = client ? client.color : '#6c63ff';
      const bg      = hexToRgba(color, 0.18);
      const radii   = { single: '8px', start: '8px 8px 0 0', mid: '0', end: '0 0 8px 8px' };
      const br      = radii[role] || '8px';
      const showContent = role === 'single' || role === 'start';
      return `<div class="time-block filled"
        style="background:${bg};border-left:3px solid ${color};color:${color};border-radius:${br}"
        onclick="App.openBlockModal('${dk}','${slot}')">
        ${showContent ? `<div class="time-block-content">
          <div class="block-client">${client ? esc(client.name) : '?'}</div>
          <div class="block-project" style="color:var(--text)">${project ? esc(project.name) : ''}</div>
          ${block.notes ? `<div class="block-notes" style="color:var(--text2)">${esc(block.notes)}</div>` : ''}
        </div>` : ''}
      </div>`;
    }
    if (calEvts.length > 0) {
      const title = calEvts.join(', ');
      return `<div class="time-block calendar-event"
        style="background:rgba(108,99,255,0.12);border-left:3px solid rgba(108,99,255,0.5)">
        <div class="time-block-content">
          <div class="block-client" style="color:var(--accent2)">Calendar</div>
          <div class="block-cal-title" style="color:var(--text2)">${esc(title)}</div>
        </div>
      </div>`;
    }
    return `<div class="time-block empty" onclick="App.openBlockModal('${dk}','${slot}')"></div>`;
  },

  // ── Block modal ──────────────────────────────────────────

  // Returns all slots in the merged run that contains `slot` (same client+project)
  getMergedRun(dk, slot) {
    const block = getBlock(dk, slot);
    if (!block || !block.clientId) return [slot];
    const allSlots = [];
    for (let h = DAY_START; h < DAY_END; h++) {
      for (let m = 0; m < 60; m += SLOT_MINS) allSlots.push(slotKey(h, m));
    }
    const idx = allSlots.indexOf(slot);
    if (idx === -1) return [slot];
    let start = idx;
    while (start > 0) {
      const b = getBlock(dk, allSlots[start - 1]);
      if (!b || b.clientId !== block.clientId || (b.projectId || '') !== (block.projectId || '')) break;
      start--;
    }
    let end = idx;
    while (end < allSlots.length - 1) {
      const b = getBlock(dk, allSlots[end + 1]);
      if (!b || b.clientId !== block.clientId || (b.projectId || '') !== (block.projectId || '')) break;
      end++;
    }
    return allSlots.slice(start, end + 1);
  },

  openBlockModal(dk, slot) {
    State.editingBlock    = { date: dk, slot };
    State.editingDuration = 1;
    State.editingRunSlots = null;
    const block = getBlock(dk, slot);
    const { h, m } = parseSlot(slot);

    // Populate client dropdown
    const clientSel = document.getElementById('bm-client');
    clientSel.innerHTML = '<option value="">Select client…</option>' +
      State.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    const durField  = document.getElementById('bm-duration-field');
    const runInfo   = document.getElementById('bm-run-info');
    const clearBtn  = document.getElementById('bm-clear-btn');
    const saveBtn   = document.querySelector('#block-modal .btn-primary');

    if (block) {
      // ── Editing existing block ──────────────────────
      const run = this.getMergedRun(dk, slot);
      State.editingRunSlots = run;

      // Title: show full run range
      const fSlot = run[0];
      const lSlot = run[run.length - 1];
      const { h: fh, m: fm } = parseSlot(fSlot);
      const { h: lh, m: lm } = parseSlot(lSlot);
      const endMin = lh * 60 + lm + 30;
      const fmtT = (th, tm) => {
        const hr = th > 12 ? th - 12 : th === 0 ? 12 : th;
        const ap = th >= 12 ? 'pm' : 'am';
        return tm === 0 ? `${hr}${ap}` : `${hr}:${String(tm).padStart(2,'0')}${ap}`;
      };
      document.getElementById('block-modal-title').textContent =
        `${fmtT(fh, fm)} — ${fmtT(Math.floor(endMin / 60), endMin % 60)}`;

      clientSel.value = block.clientId || '';
      this.updateBlockProjectDropdown(block.clientId, block.projectId);
      document.getElementById('bm-notes').value = block.notes || '';

      if (durField) durField.style.display = 'none';
      if (runInfo) {
        if (run.length > 1) {
          runInfo.textContent = `Edits all ${run.length} slots · ${(run.length * 0.5).toFixed(1)}h`;
          runInfo.style.display = '';
        } else {
          runInfo.style.display = 'none';
        }
      }
      if (clearBtn) { clearBtn.style.display = 'inline-flex'; clearBtn.textContent = 'Clear slot'; }
      if (saveBtn)  saveBtn.textContent = run.length > 1 ? 'Save block' : 'Save';

    } else {
      // ── New empty slot ──────────────────────────────
      const hour   = h > 12 ? h - 12 : h;
      const ampm   = h >= 12 ? 'pm' : 'am';
      const minStr = m === 0 ? '' : `:${String(m).padStart(2,'0')}`;
      document.getElementById('block-modal-title').textContent =
        `${hour}${minStr}${ampm} — ${String(m + SLOT_MINS === 60 ? h + 1 : h > 12 ? h - 12 : h)
          .replace(/^(\d)/, '$1')}:${String((m + SLOT_MINS) % 60).padStart(2,'0')}${h + (m + SLOT_MINS >= 60 ? 1 : 0) >= 12 ? 'pm' : 'am'}`;

      const maxSlots = Math.floor(((DAY_END * 60) - (h * 60 + m)) / 30);
      State.editingMaxDuration = maxSlots;
      document.getElementById('bm-notes').value = '';

      if (durField) { durField.style.display = ''; document.getElementById('bm-dur-display').textContent = '30 min'; }
      if (runInfo)  runInfo.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'none';
      if (saveBtn)  saveBtn.textContent = 'Save';

      // Pre-fill from slot immediately above
      const prev = this.getPrevBlock(dk, slot);
      if (prev) {
        clientSel.value = prev.clientId;
        this.updateBlockProjectDropdown(prev.clientId, prev.projectId);
      } else {
        this.updateBlockProjectDropdown(null, null);
      }
    }

    document.getElementById('block-modal').classList.add('open');
    setTimeout(() => document.getElementById('bm-notes').focus?.(), 400);
  },

  getPrevBlock(dk, slot) {
    const { h, m } = parseSlot(slot);
    const prevMin = h * 60 + m - 30;
    if (prevMin < DAY_START * 60) return null;
    return getBlock(dk, slotKey(Math.floor(prevMin / 60), prevMin % 60)) || null;
  },

  adjustDuration(delta) {
    State.editingDuration = Math.max(1, Math.min(State.editingMaxDuration || 60, (State.editingDuration || 1) + delta));
    const mins = State.editingDuration * 30;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    document.getElementById('bm-dur-display').textContent =
      h === 0 ? `${mins} min` : m === 0 ? `${h}h` : `${h}h ${m}m`;
  },

  blockModalClientChange() {
    const clientId = document.getElementById('bm-client').value;
    this.updateBlockProjectDropdown(clientId, null);
  },

  updateBlockProjectDropdown(clientId, selectedProjectId) {
    const projects = State.projects.filter(p => p.clientId === clientId);
    const sel = document.getElementById('bm-project');
    sel.innerHTML = '<option value="">Select project…</option>' +
      projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (selectedProjectId) sel.value = selectedProjectId;
  },

  closeBlockModal() {
    document.getElementById('block-modal').classList.remove('open');
    State.editingBlock = null;
  },

  async saveBlock() {
    const { date, slot } = State.editingBlock;
    const clientId  = document.getElementById('bm-client').value;
    const projectId = document.getElementById('bm-project').value;
    const notes     = document.getElementById('bm-notes').value.trim();
    if (!clientId) { showToast('Please select a client'); return; }

    if (State.editingRunSlots) {
      // Editing existing block: apply to entire merged run
      for (const s of State.editingRunSlots) {
        setBlock(date, s, { clientId, projectId, notes });
      }
      State.editingRunSlots = null;
    } else {
      // New block: fill n slots forward from tapped slot
      const n = State.editingDuration || 1;
      const { h, m } = parseSlot(slot);
      let totalMin = h * 60 + m;
      for (let i = 0; i < n; i++) {
        const sh = Math.floor(totalMin / 60);
        const sm = totalMin % 60;
        if (sh >= DAY_END) break;
        setBlock(date, slotKey(sh, sm), { clientId, projectId, notes });
        totalMin += 30;
      }
    }
    State.editingDuration = 1;
    this.closeBlockModal();
    this.renderToday();
    await Gist.syncWithRetry();
  },

  async clearBlock() {
    const { date, slot } = State.editingBlock;
    clearBlock(date, slot);
    this.closeBlockModal();
    this.renderToday();
    await Gist.syncWithRetry();
  },

  // ── Activity (Dashboard) ─────────────────────────────────
  renderDashboard() {
    const today     = new Date();
    const weekStart = startOfWeek(today);
    const prevStart = addDays(weekStart, -7);

    // ── Current week per-day data ────────────────────
    const DAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d  = addDays(weekStart, i);
      const dk = dateKey(d);
      const dayData = State.blocks[dk] || {};
      const hours   = Object.keys(dayData).length * 0.5;
      const counts  = {};
      for (const b of Object.values(dayData)) {
        if (b && b.clientId) counts[b.clientId] = (counts[b.clientId] || 0) + 1;
      }
      const top    = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const client = top ? getClient(top[0]) : null;
      weekDays.push({ date: d, hours, color: client ? client.color : null, today: isToday(d) });
    }
    const weekHours    = weekDays.reduce((s, d) => s + d.hours, 0);
    const weekData     = aggregateRange(weekStart, addDays(weekStart, 6));
    const weekEarnings = this.calcEarnings(weekData);
    const prevData     = aggregateRange(prevStart, addDays(prevStart, 6));
    const prevHours    = Object.values(prevData).reduce((s, v) => s + v.hours, 0);
    const delta        = weekHours - prevHours;
    const deltaStr     = (weekHours > 0 && prevHours > 0)
      ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}h vs last week` : '';
    const deltaColor   = delta >= 0 ? 'var(--success)' : 'var(--danger)';

    // ── Heatmap layout ───────────────────────────────
    const CELL = 12, GAP = 3, LABEL_W = 14;
    const contentW  = Math.min(window.innerWidth, 430) - 32;
    const WEEKS     = Math.floor((contentW - LABEL_W) / (CELL + GAP));
    const heatStart = startOfWeek(addDays(today, -(WEEKS - 1) * 7));

    // ── Work streak ──────────────────────────────────
    let streak = 0;
    let ck = new Date(today); ck.setHours(0, 0, 0, 0);
    if (Object.keys(State.blocks[dateKey(ck)] || {}).length === 0) ck = addDays(ck, -1);
    while (streak < 365) {
      if (Object.keys(State.blocks[dateKey(ck)] || {}).length === 0) break;
      streak++;
      ck = addDays(ck, -1);
    }

    // ── Build HTML ───────────────────────────────────
    const maxDayH = Math.max(...weekDays.map(d => d.hours), 1);
    const BAR_H   = 52;
    let html      = '<div style="height:16px"></div>';

    // — Week totals —
    html += `<div style="padding:0 20px 16px;display:flex;justify-content:space-between;align-items:flex-end">
      <div>
        <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:var(--text2);margin-bottom:3px">This Week</div>
        <div style="font-size:42px;font-weight:700;letter-spacing:-2px;line-height:1;color:var(--text)">${weekHours.toFixed(1)}<span style="font-size:20px;font-weight:500;color:var(--text2)">h</span></div>
        ${deltaStr ? `<div style="font-size:12px;color:${deltaColor};margin-top:4px;font-weight:500">${deltaStr}</div>` : '<div style="height:16px"></div>'}
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:var(--text2);margin-bottom:3px">Earned</div>
        <div style="font-size:32px;font-weight:700;letter-spacing:-1.5px;line-height:1;color:var(--success)">$${weekEarnings.toLocaleString()}</div>
      </div>
    </div>`;

    // — Day bars —
    html += `<div style="padding:0 16px 16px"><div style="display:flex;gap:4px">`;
    for (const day of weekDays) {
      const bh     = day.hours > 0 ? Math.max((day.hours / maxDayH) * BAR_H, 4) : 0;
      const color  = day.color || '#6c63ff';
      const filled = day.hours > 0;
      html += `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;border-radius:10px;padding:8px 0;${day.today ? 'background:rgba(108,99,255,0.07)' : ''}">
        <div style="height:${BAR_H}px;display:flex;align-items:flex-end;width:100%;justify-content:center">
          <div style="width:22px;height:${bh}px;background:${filled ? color : 'var(--bg3)'};border-radius:4px;opacity:${filled ? 0.9 : 1}"></div>
        </div>
        <div style="font-size:10px;font-weight:${day.today ? 700 : 500};color:${day.today ? 'var(--accent)' : 'var(--text3)'};line-height:1">${DAYS_SHORT[day.date.getDay()]}</div>
        <div style="font-size:10px;color:${filled ? 'var(--text2)' : 'var(--text3)'};line-height:1">${filled ? day.hours.toFixed(1) : '\xb7'}</div>
      </div>`;
    }
    html += `</div></div>`;

    // Divider
    html += `<div style="height:0.5px;background:var(--border);margin:0 16px 20px"></div>`;

    // — Activity heatmap —
    const HEAT_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    html += `<div style="padding:0 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:var(--text2)">Activity</div>
      </div>
      <div style="display:flex;gap:${GAP}px">`;
    html += `<div style="display:flex;flex-direction:column;gap:${GAP}px">`;
    for (let dow = 0; dow < 7; dow++) {
      html += `<div style="width:${LABEL_W - 4}px;height:${CELL}px;font-size:8px;color:var(--text3);display:flex;align-items:center;justify-content:flex-end;padding-right:2px">${[1, 3, 5].includes(dow) ? HEAT_LABELS[dow] : ''}</div>`;
    }
    html += `</div>`;
    for (let w = 0; w < WEEKS; w++) {
      const wStart = addDays(heatStart, w * 7);
      html += `<div style="display:flex;flex-direction:column;gap:${GAP}px">`;
      for (let dow = 0; dow < 7; dow++) {
        const d  = addDays(wStart, dow);
        const dk = dateKey(d);
        if (d > today) { html += `<div style="width:${CELL}px;height:${CELL}px"></div>`; continue; }
        const dayData = State.blocks[dk] || {};
        const hours   = Object.keys(dayData).length * 0.5;
        const counts  = {};
        for (const b of Object.values(dayData)) {
          if (b && b.clientId) counts[b.clientId] = (counts[b.clientId] || 0) + 1;
        }
        const top2 = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        const cc   = top2 ? getClient(top2[0]) : null;
        const base = cc ? cc.color : '#6c63ff';
        const bg   = hours === 0 ? 'var(--bg3)' : hexToRgba(base, Math.min(0.2 + (hours / 8) * 0.8, 1));
        const ring = isToday(d) ? `outline:1.5px solid var(--accent);outline-offset:1px;` : '';
        html += `<div style="width:${CELL}px;height:${CELL}px;border-radius:2.5px;background:${bg};${ring}"></div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
    html += `<div style="display:flex;align-items:center;gap:4px;margin-top:8px;justify-content:flex-end">
      <span style="font-size:9px;color:var(--text3);margin-right:1px">Less</span>
      ${[0, 0.25, 0.5, 0.75, 1].map(a =>
        `<div style="width:${CELL}px;height:${CELL}px;border-radius:2.5px;background:${a === 0 ? 'var(--bg3)' : `rgba(108,99,255,${a})`}"></div>`
      ).join('')}
      <span style="font-size:9px;color:var(--text3);margin-left:1px">More</span>
    </div>`;
    html += `</div>`;

    // Divider
    html += `<div style="height:0.5px;background:var(--border);margin:20px 16px 0"></div>`;

    // ── Monthly Pace Ring ────────────────────────────
    const monthStartP = startOfMonth(today);
    const monthEndP   = endOfMonth(today);
    let totalWorkdays = 0, elapsedWorkdays = 0;
    { let wd = new Date(monthStartP);
      while (wd <= monthEndP) {
        const dow = wd.getDay();
        if (dow !== 0 && dow !== 6) { totalWorkdays++; if (wd <= today) elapsedWorkdays++; }
        wd = addDays(wd, 1);
      }
    }
    const dailyTarget  = (State.weeklyHoursTarget || 50) / 5;
    const monthTarget  = totalWorkdays * dailyTarget;
    const paceTarget   = elapsedWorkdays * dailyTarget;
    const paceMonthData = aggregateRange(monthStartP, today);
    const currHours    = Object.values(paceMonthData).reduce((s, v) => s + v.hours, 0);
    const pacePct      = monthTarget > 0 ? Math.min(currHours / monthTarget, 1) : 0;
    const paceDelta    = currHours - paceTarget;
    const paceColor    = paceDelta >= 0 ? 'var(--success)' : (paceDelta >= -8 ? '#f59e0b' : 'var(--danger)');
    const remaining    = totalWorkdays - elapsedWorkdays;
    const paceStr      = elapsedWorkdays === 0 ? 'Month just started'
      : paceDelta === 0 ? 'Exactly on pace'
      : paceDelta > 0   ? `${paceDelta.toFixed(1)}h ahead of pace`
      :                   `${Math.abs(paceDelta).toFixed(1)}h behind pace`;

    const PR = 40, PCX = 52, PCY = 52;
    const pCirc = 2 * Math.PI * PR;
    const pFill = pacePct * pCirc;

    html += `<div style="padding:16px 16px 0">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:var(--text2);margin-bottom:12px">Monthly Pace</div>
      <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
        <div style="display:flex;align-items:center;gap:20px">
          <svg width="104" height="104" viewBox="0 0 104 104" style="flex-shrink:0">
            <circle cx="${PCX}" cy="${PCY}" r="${PR}" fill="none" stroke="var(--bg3)" stroke-width="10"/>
            ${pFill > 0.1 ? `<circle cx="${PCX}" cy="${PCY}" r="${PR}" fill="none" stroke="${paceColor}" stroke-width="10"
              stroke-dasharray="${pFill.toFixed(2)} ${(pCirc - pFill).toFixed(2)}"
              stroke-linecap="round"
              transform="rotate(-90 ${PCX} ${PCY})"/>` : ''}
            <text x="${PCX}" y="${PCY - 4}" text-anchor="middle" style="font-size:18px;font-weight:700;fill:var(--text);font-family:-apple-system,sans-serif">${currHours.toFixed(1)}</text>
            <text x="${PCX}" y="${PCY + 12}" text-anchor="middle" style="font-size:9px;fill:var(--text2);font-family:-apple-system,sans-serif">of ${monthTarget.toFixed(0)}h</text>
          </svg>
          <div style="flex:1">
            <div style="font-size:11px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;color:var(--text2)">${today.toLocaleDateString('en-US',{month:'long',year:'numeric'})}</div>
            <div style="font-size:30px;font-weight:700;letter-spacing:-1.2px;line-height:1;color:var(--text);margin:4px 0">${(pacePct*100).toFixed(0)}<span style="font-size:17px;font-weight:500;color:var(--text2)">%</span></div>
            <div style="font-size:12px;color:${paceColor};font-weight:600;margin-bottom:8px">${paceStr}</div>
            <div style="font-size:11px;color:var(--text3)">${remaining} workday${remaining!==1?'s':''} left</div>
            <div style="font-size:11px;color:var(--text3);margin-top:1px">Target: ${monthTarget.toFixed(0)}h (${State.weeklyHoursTarget}h/wk)</div>
          </div>
        </div>
      </div>
    </div>`;

    // Divider
    html += `<div style="height:0.5px;background:var(--border);margin:20px 16px 0"></div>`;

    // ── Work Rhythm ──────────────────────────────────
    const RHOURS    = [];
    for (let h = DAY_START; h < DAY_END; h++) RHOURS.push(h);
    const RDAY_LBLS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    // Count blocks per (dow=Mon-0..Sun-6, hour) and how many days each dow has data
    const rgrid    = {};
    const rdayCount = new Array(7).fill(0);
    for (const [dk2, dayData] of Object.entries(State.blocks)) {
      const slots = Object.values(dayData).filter(b => b && b.clientId);
      if (slots.length === 0) continue;
      const d2  = new Date(dk2 + 'T12:00:00');
      const dow = (d2.getDay() + 6) % 7;
      rdayCount[dow]++;
      for (const slot of Object.keys(dayData)) {
        const b = dayData[slot];
        if (!b || !b.clientId) continue;
        const h = parseInt(slot.split(':')[0]);
        if (!rgrid[dow]) rgrid[dow] = {};
        rgrid[dow][h] = (rgrid[dow][h] || 0) + 1;
      }
    }
    let rmaxNorm = 0;
    for (let dow = 0; dow < 7; dow++) {
      if (rdayCount[dow] === 0) continue;
      for (const h of RHOURS) {
        const n = (rgrid[dow]?.[h] || 0) / rdayCount[dow];
        if (n > rmaxNorm) rmaxNorm = n;
      }
    }
    if (rmaxNorm === 0) rmaxNorm = 1;

    const RLABEL_W  = 28;
    const RGAP      = 2;
    const rContentW = Math.min(window.innerWidth, 430) - 64; // screen padding + card padding
    const RCELL     = Math.max(14, Math.floor((rContentW - RLABEL_W - RGAP * (RHOURS.length - 1)) / RHOURS.length));

    let rhythmHtml = '';
    // Hour labels (top row, sparse)
    rhythmHtml += `<div style="display:flex;gap:${RGAP}px;margin-bottom:4px;margin-left:${RLABEL_W}px">`;
    for (const h of RHOURS) {
      const show  = [7, 10, 13, 16, 19].includes(h);
      const lbl   = show ? (h === 12 ? '12p' : h > 12 ? `${h-12}p` : `${h}a`) : '';
      rhythmHtml += `<div style="width:${RCELL}px;font-size:8px;color:var(--text3);text-align:center">${lbl}</div>`;
    }
    rhythmHtml += '</div>';
    // Day rows
    for (let dow = 0; dow < 7; dow++) {
      rhythmHtml += `<div style="display:flex;align-items:center;gap:${RGAP}px;margin-bottom:${RGAP}px">`;
      rhythmHtml += `<div style="width:${RLABEL_W - RGAP}px;font-size:10px;color:var(--text3);text-align:right;padding-right:4px">${RDAY_LBLS[dow]}</div>`;
      for (const h of RHOURS) {
        const count = rgrid[dow]?.[h] || 0;
        const norm  = rdayCount[dow] > 0 ? (count / rdayCount[dow]) / rmaxNorm : 0;
        const bg    = norm === 0 ? 'var(--bg3)' : hexToRgba('#6c63ff', Math.min(0.15 + norm * 0.85, 1));
        rhythmHtml += `<div style="width:${RCELL}px;height:${RCELL}px;border-radius:3px;background:${bg}"></div>`;
      }
      rhythmHtml += '</div>';
    }

    html += `<div style="padding:16px 16px 0">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:var(--text2);margin-bottom:12px">Work Rhythm</div>
      <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
        ${rhythmHtml}
        <div style="font-size:10px;color:var(--text3);text-align:right;margin-top:6px">Based on all tracked history</div>
      </div>
    </div>`;

    html += `<div style="height:0.5px;background:var(--border);margin:20px 16px 0"></div>`;

    // ── Momentum: 7-day rolling average line chart ──
    const moN     = 180;
    const moCardW = Math.min(window.innerWidth, 430) - 64;
    const moBW    = moCardW / moN;
    const MO_H    = 64;
    const moDays  = [];
    for (let mi = moN - 1; mi >= 0; mi--) moDays.push(addDays(today, -mi));

    // Daily hours + dominant client color per day
    const moDailyH  = moDays.map(md => Object.keys(State.blocks[dateKey(md)] || {}).length * 0.5);
    const moDailyCl = moDays.map(md => {
      const mdk = dateKey(md);
      const mc = {};
      for (const b of Object.values(State.blocks[mdk] || {})) {
        if (b && b.clientId) mc[b.clientId] = (mc[b.clientId] || 0) + 1;
      }
      const mt = Object.entries(mc).sort((a, b) => b[1] - a[1])[0];
      const mcl = mt ? getClient(mt[0]) : null;
      return mcl ? mcl.color : '#6c63ff';
    });

    // 7-day trailing rolling average
    const moRolling = moDailyH.map((_, i) => {
      const sl = moDailyH.slice(Math.max(0, i - 6), i + 1);
      return sl.reduce((s, v) => s + v, 0) / sl.length;
    });

    const moMaxH = Math.max(...moDailyH, 1);

    // Faint raw-day bars (backdrop)
    let moBarsStr = '';
    for (let mi = 0; mi < moN; mi++) {
      const bh = moDailyH[mi] > 0 ? Math.max((moDailyH[mi] / moMaxH) * MO_H, 1.5) : 0;
      if (bh > 0) {
        const sx = mi * moBW;
        moBarsStr += `<rect x="${sx.toFixed(2)}" y="${(MO_H - bh).toFixed(2)}" width="${Math.max(moBW - 0.3, 1).toFixed(2)}" height="${bh.toFixed(2)}" fill="${moDailyCl[mi]}" opacity="0.18" rx="0.3"/>`;
      }
    }

    // Rolling average polyline + area (data already smooth, polyline looks clean)
    const moLinePts  = moRolling.map((avg, i) => `${((i + 0.5) * moBW).toFixed(1)},${(MO_H - (avg / moMaxH) * MO_H).toFixed(1)}`).join(' ');
    const moAreaPts  = `${(0.5 * moBW).toFixed(1)},${MO_H} ${moLinePts} ${((moN - 0.5) * moBW).toFixed(1)},${MO_H}`;
    const moEndX     = ((moN - 0.5) * moBW).toFixed(1);
    const moEndY     = (MO_H - (moRolling[moN - 1] / moMaxH) * MO_H).toFixed(1);

    // Month boundary ticks + labels
    let moTicksStr = '';
    let moLastMo = -1;
    for (let mi = 0; mi < moN; mi++) {
      const md = moDays[mi];
      const mmo = md.getMonth();
      if (mmo !== moLastMo) {
        const sx = mi * moBW;
        const lbl = md.toLocaleDateString('en-US', { month: 'short' });
        moTicksStr += `<line x1="${sx.toFixed(2)}" y1="0" x2="${sx.toFixed(2)}" y2="${MO_H}" stroke="#888" stroke-opacity="0.12" stroke-width="0.5"/>`;
        moTicksStr += `<text x="${(sx + 2).toFixed(2)}" y="${MO_H + 11}" style="font-size:9px;fill:var(--text3);font-family:-apple-system,sans-serif">${lbl}</text>`;
        moLastMo = mmo;
      }
    }

    html += `<div style="padding:16px 16px 0">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:var(--text2)">Momentum</div>
        <div style="font-size:10px;color:var(--text3)">7-day avg · 6 months</div>
      </div>
      <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
        <svg width="${moCardW}" height="${MO_H + 16}" viewBox="0 0 ${moCardW} ${MO_H + 16}" style="display:block;overflow:visible">
          <defs>
            <linearGradient id="moGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#6c63ff" stop-opacity="0.3"/>
              <stop offset="100%" stop-color="#6c63ff" stop-opacity="0.02"/>
            </linearGradient>
          </defs>
          ${moTicksStr}
          ${moBarsStr}
          <polygon points="${moAreaPts}" fill="url(#moGrad)"/>
          <polyline points="${moLinePts}" fill="none" stroke="#6c63ff" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
          <circle cx="${moEndX}" cy="${moEndY}" r="2.5" fill="#6c63ff"/>
        </svg>
      </div>
    </div>`;

    html += `<div style="height:0.5px;background:var(--border);margin:20px 16px 0"></div>`;

    // ── Trends: month vs last month + projected year ─
    const curMoStart    = startOfMonth(today);
    const prevMoStart   = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const daysInPrevMo  = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
    const prevMoSameDay = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), daysInPrevMo));
    const curMoData     = aggregateRange(curMoStart, today);
    const curMoHours    = Object.values(curMoData).reduce((s, v) => s + v.hours, 0);
    const prevMoData    = aggregateRange(prevMoStart, prevMoSameDay);
    const prevMoHours   = Object.values(prevMoData).reduce((s, v) => s + v.hours, 0);
    const moGap         = curMoHours - prevMoHours;
    const moGapColor    = moGap >= 0 ? 'var(--success)' : 'var(--danger)';
    const prevMoName    = prevMoStart.toLocaleDateString('en-US', { month: 'short' });

    const ytdStart    = new Date(today.getFullYear(), 0, 1);
    const ytdData2    = aggregateRange(ytdStart, today);
    const ytdHours    = Object.values(ytdData2).reduce((s, v) => s + v.hours, 0);
    const ytdEarnings = this.calcEarnings(ytdData2);
    const elapsedDays = Math.max(1, Math.round((today - ytdStart) / 86400000) + 1);
    const projYrHours = Math.round(ytdHours / elapsedDays * 365);
    const projYrEarn  = Math.round(ytdEarnings / elapsedDays * 365);

    html += `<div style="padding:16px 16px 0">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:var(--text2);margin-bottom:12px">Trends</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:var(--radius);padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
          <div style="font-size:10px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.8px">vs Last Month</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-0.8px;color:${moGapColor}">${moGap >= 0 ? '+' : ''}${moGap.toFixed(1)}h</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">${curMoHours.toFixed(1)}h vs ${prevMoHours.toFixed(1)}h in ${prevMoName}</div>
        </div>
        <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:var(--radius);padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
          <div style="font-size:10px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.8px">Year Pace</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-0.8px;color:var(--text)">${projYrHours.toLocaleString()}h</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">$${projYrEarn.toLocaleString()} on current pace</div>
        </div>
      </div>
    </div>`;

    html += `<div style="height:24px"></div>`;

    document.getElementById('dashboard-content').innerHTML = html;
  },

  // ── Billing ───────────────────────────────────────────────
  renderBilling() {
    const today = new Date();
    const fmt$  = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Collect months with any tracked data
    const monthsSet = new Set();
    for (const dk of Object.keys(State.blocks)) {
      if (Object.keys(State.blocks[dk]).length > 0) monthsSet.add(dk.slice(0, 7));
    }
    for (const ym of Object.keys(State.invoices)) monthsSet.add(ym);
    monthsSet.add(dateKey(today).slice(0, 7));
    const billingYMs = [...monthsSet].sort().reverse().slice(0, 24);

    // Status helper for a per-client invoice record
    const getStatus = inv => {
      if (!inv) return 'draft';
      if (inv.paidDate) return 'paid';
      if (inv.sentDate) return 'invoiced';
      return 'draft';
    };

    const statusConfig = {
      draft:    { label: 'Not invoiced',     color: 'var(--text3)',   bg: 'rgba(0,0,0,0.05)' },
      invoiced: { label: 'Awaiting payment', color: '#f59e0b',        bg: 'rgba(245,158,11,0.12)' },
      paid:     { label: '\u2713 Paid',       color: 'var(--success)', bg: 'rgba(48,209,88,0.12)' },
    };

    // Build per-month sections: each section has rows per client
    let outstanding  = 0;
    const paidDaysList = [];
    let pendingCount = 0, draftCount = 0;
    const sections   = [];

    for (const ym of billingYMs) {
      const [y, m]  = ym.split('-').map(Number);
      const mData   = aggregateRange(new Date(y, m - 1, 1), new Date(y, m, 0));
      const invMonth = State.invoices[ym] || {};
      const label   = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

      const rows = [];
      for (const [clientId, { hours }] of Object.entries(mData)) {
        if (hours === 0) continue;
        const client = getClient(clientId);
        if (!client) continue;
        const earn   = hours * (client.rate || 0);
        const inv    = invMonth[clientId] || null;
        const status = getStatus(inv);

        if (status !== 'paid') outstanding += earn;
        if (status === 'invoiced') pendingCount++;
        if (status === 'draft')    draftCount++;

        if (inv && inv.sentDate && inv.paidDate) {
          const d1 = new Date(inv.sentDate + 'T00:00:00');
          const d2 = new Date(inv.paidDate + 'T00:00:00');
          paidDaysList.push(Math.round((d2 - d1) / 86400000));
        }

        rows.push({ clientId, client, hours, earn, inv, status });
      }

      if (rows.length > 0) sections.push({ ym, label, rows });
    }

    const avgDays = paidDaysList.length > 0
      ? Math.round(paidDaysList.reduce((s, d) => s + d, 0) / paidDaysList.length)
      : null;

    // Build HTML
    let html = '<div style="height:16px"></div>';

    // Stats row
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 16px 16px">
      <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:var(--radius);padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
        <div style="font-size:10px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.8px">Outstanding</div>
        <div style="font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-0.8px;color:${outstanding > 0 ? 'var(--danger)' : 'var(--success)'}">${fmt$(outstanding)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${draftCount} invoice${draftCount !== 1 ? 's' : ''} not sent</div>
      </div>
      <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:var(--radius);padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
        <div style="font-size:10px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.8px">Avg. Wait</div>
        <div style="font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-0.8px;color:var(--text)">${avgDays !== null ? avgDays + 'd' : '—'}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${pendingCount} awaiting payment</div>
      </div>
    </div>`;

    if (sections.length === 0) {
      html += `<div class="empty-state"><div class="empty-icon">🧾</div><div class="empty-title">No billing data yet</div><div class="empty-sub">Start tracking time to see invoices here</div></div>`;
    } else {
      for (const section of sections) {
        html += `<div style="padding:0 16px 12px">
          <div style="font-size:11px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:var(--text2);margin-bottom:8px">${section.label}</div>
          <div style="background:var(--bg2);border:0.5px solid var(--border);border-radius:var(--radius);overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06)">`;

        section.rows.forEach((row, i) => {
          const border = i < section.rows.length - 1 ? 'border-bottom:0.5px solid var(--border);' : '';
          const sc     = statusConfig[row.status];
          const inv    = row.inv;
          let daysLabel = '';
          if (inv && inv.sentDate && inv.paidDate) {
            const days = Math.round((new Date(inv.paidDate + 'T00:00:00') - new Date(inv.sentDate + 'T00:00:00')) / 86400000);
            daysLabel  = `${days}d to pay`;
          }
          html += `<div style="${border}padding:13px 16px;cursor:pointer;-webkit-tap-highlight-color:transparent"
            onclick="App.openInvoiceModal('${section.ym}','${row.clientId}')">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <div style="width:8px;height:8px;border-radius:50%;background:${row.client.color};flex-shrink:0"></div>
              <div style="font-size:14px;font-weight:600;color:var(--text);flex:1">${esc(row.client.name)}</div>
              <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;background:${sc.bg};color:${sc.color}">${sc.label}</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding-left:16px">
              <div style="font-size:12px;color:var(--text2)">${row.hours.toFixed(1)}h &middot; ${fmt$(row.earn)}</div>
              <div style="font-size:12px;color:var(--text3)">${daysLabel}</div>
            </div>
            ${inv && (inv.sentDate || inv.paidDate) ? `<div style="margin-top:5px;padding-left:16px;display:flex;gap:14px">
              ${inv.sentDate ? `<div style="font-size:11px;color:var(--text2)">Sent <span style="color:var(--text);font-weight:500">${formatShortDate(new Date(inv.sentDate + 'T00:00:00'))}</span></div>` : ''}
              ${inv.paidDate ? `<div style="font-size:11px;color:var(--text2)">Paid <span style="color:var(--success);font-weight:500">${formatShortDate(new Date(inv.paidDate + 'T00:00:00'))}</span></div>` : ''}
            </div>` : ''}
          </div>`;
        });

        html += `</div></div>`;
      }
    }

    html += `<div style="height:24px"></div>`;
    document.getElementById('billing-content').innerHTML = html;
  },

  openInvoiceModal(ym, clientId) {
    State.editingInvoiceYM       = ym;
    State.editingInvoiceClientId = clientId;
    const inv    = (State.invoices[ym] || {})[clientId] || {};
    const client = getClient(clientId);
    const [y, m] = ym.split('-').map(Number);
    const label  = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const fmt$   = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Per-client hours/earnings for this month
    const mData  = aggregateRange(new Date(y, m - 1, 1), new Date(y, m, 0));
    const hours  = mData[clientId]?.hours || 0;
    const earn   = hours * ((client?.rate) || 0);

    document.getElementById('inv-modal-title').textContent = label;
    document.getElementById('inv-modal-sub').textContent   = `${client ? esc(client.name) : clientId} · ${hours.toFixed(1)}h · ${fmt$(earn)}`;
    document.getElementById('inv-sent-date').value = inv.sentDate || '';
    document.getElementById('inv-paid-date').value = inv.paidDate || '';

    const hasDates = inv.sentDate || inv.paidDate;
    document.getElementById('inv-clear-btn').style.display = hasDates ? 'inline-flex' : 'none';

    document.getElementById('invoice-modal').classList.add('open');
  },

  async saveInvoiceModal() {
    const ym       = State.editingInvoiceYM;
    const clientId = State.editingInvoiceClientId;
    if (!ym || !clientId) return;

    const sentDate = document.getElementById('inv-sent-date').value || null;
    const paidDate = document.getElementById('inv-paid-date').value || null;

    if (!State.invoices[ym]) State.invoices[ym] = {};
    if (!sentDate && !paidDate) {
      delete State.invoices[ym][clientId];
      if (Object.keys(State.invoices[ym]).length === 0) delete State.invoices[ym];
    } else {
      State.invoices[ym][clientId] = { sentDate, paidDate };
    }

    document.getElementById('invoice-modal').classList.remove('open');
    State.editingInvoiceYM = null; State.editingInvoiceClientId = null;
    this.renderBilling();
    await Gist.syncWithRetry();
  },

  async clearInvoiceDates() {
    const ym       = State.editingInvoiceYM;
    const clientId = State.editingInvoiceClientId;
    if (!ym || !clientId) return;
    if (State.invoices[ym]) {
      delete State.invoices[ym][clientId];
      if (Object.keys(State.invoices[ym]).length === 0) delete State.invoices[ym];
    }
    document.getElementById('invoice-modal').classList.remove('open');
    State.editingInvoiceYM = null; State.editingInvoiceClientId = null;
    this.renderBilling();
    await Gist.syncWithRetry();
  },

  closeInvoiceModal() {
    document.getElementById('invoice-modal').classList.remove('open');
    State.editingInvoiceYM = null; State.editingInvoiceClientId = null;
  },

  calcEarnings(data) {
    let total = 0;
    for (const [clientId, { hours }] of Object.entries(data)) {
      const client = getClient(clientId);
      if (client) total += hours * (client.rate || 0);
    }
    return total;
  },

  // ── Summary ──────────────────────────────────────────────
  toggleSummaryEarnings() {
    State.summaryShowEarnings = !State.summaryShowEarnings;
    this.renderSummary();
  },

  setSummaryRange(mode) {
    State.summaryRangeMode = mode;
    // Sync ref to current date when switching modes
    if (mode !== 'custom') State.summaryRangeRef = new Date();

    // Toggle UI — hide nav arrows for ytd and custom (fixed ranges)
    const noNav    = mode === 'custom' || mode === 'ytd';
    const navEl    = document.getElementById('summary-range-nav');
    const customEl = document.getElementById('summary-custom-row');
    navEl.style.display    = noNav ? 'none' : '';
    customEl.style.display = mode === 'custom' ? '' : 'none';

    // Highlight active seg button
    document.querySelectorAll('.seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.range === mode);
    });

    // Pre-fill custom inputs with current range
    if (mode === 'custom') {
      const today = dateKey(new Date());
      const monthStart = dateKey(startOfMonth(new Date()));
      document.getElementById('summary-custom-start').value = State.summaryCustomStart ? dateKey(State.summaryCustomStart) : monthStart;
      document.getElementById('summary-custom-end').value   = State.summaryCustomEnd   ? dateKey(State.summaryCustomEnd)   : today;
      if (!State.summaryCustomStart) State.summaryCustomStart = startOfMonth(new Date());
      if (!State.summaryCustomEnd)   State.summaryCustomEnd   = new Date();
    }

    this.renderSummary();
  },

  setCustomDate(which, value) {
    if (!value) return;
    const d = new Date(value + 'T00:00:00');
    if (which === 'start') State.summaryCustomStart = d;
    else                   State.summaryCustomEnd   = d;
    this.renderSummary();
  },

  summaryNav(delta) {
    const ref  = State.summaryRangeRef;
    const mode = State.summaryRangeMode;
    if (mode === 'week') {
      State.summaryRangeRef = addDays(ref, delta * 7);
    } else if (mode === 'quarter') {
      State.summaryRangeRef = new Date(ref.getFullYear(), ref.getMonth() + delta * 3, 1);
    } else {
      State.summaryRangeRef = new Date(ref.getFullYear(), ref.getMonth() + delta, 1);
    }
    this.renderSummary();
  },

  renderSummary() {
    const { start, end } = getSummaryDateRange();
    document.getElementById('summary-range-label').textContent = formatRangeLabel();

    const data        = aggregateRange(start, end);
    const totalHours  = Object.values(data).reduce((s, v) => s + v.hours, 0);
    const totalEarned = this.calcEarnings(data);

    const content = document.getElementById('summary-content');

    if (Object.keys(data).length === 0) {
      content.innerHTML = `<div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No data for this period</div>
        <div class="empty-sub">Start tracking time on the Today tab</div>
      </div>`;
      return;
    }

    // ── Computed stats ─────────────────────────────────────
    // Clamp end to today so averages reflect elapsed time, not future days
    const today       = new Date(); today.setHours(23, 59, 59, 999);
    const clampedEnd  = end < today ? end : today;

    // Count elapsed weekdays (Mon–Fri) from start through clampedEnd (for avg/day)
    // Count distinct Sun–Sat weeks touched by the range (for avg/week, weekend hrs count)
    let elapsedWeekdays = 0;
    const weekSet = new Set();
    const d = new Date(start); d.setHours(0, 0, 0, 0);
    const ce = new Date(clampedEnd); ce.setHours(23, 59, 59, 999);
    while (d <= ce) {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) elapsedWeekdays++;
      // Roll back to Sunday to identify the Sun–Sat week
      const sun = new Date(d); sun.setDate(d.getDate() - dow);
      weekSet.add(sun.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    elapsedWeekdays = Math.max(1, elapsedWeekdays);
    const elapsedWeeks = Math.max(1, weekSet.size);

    const showEarn  = State.summaryShowEarnings;
    const fmt$      = v => '$' + v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    const fmtH      = v => v.toFixed(1) + 'h';
    const effRate   = totalHours > 0 ? totalEarned / totalHours : 0;

    // ── Charts ─────────────────────────────────────────────
    // Donut legend rows
    let legendHtml = '';
    for (const [clientId, { hours }] of Object.entries(data)) {
      const client = getClient(clientId);
      const color  = client ? client.color : '#6c63ff';
      const name   = client ? client.name  : 'Unknown';
      const pct    = totalHours > 0 ? Math.round((hours / totalHours) * 100) : 0;
      legendHtml += `<div class="legend-row">
        <div class="legend-dot" style="background:${color}"></div>
        <div class="legend-name">${esc(name)}</div>
        <div class="legend-val"><span class="legend-hours">${hours.toFixed(1)}h</span>${pct}%</div>
      </div>`;
    }

    let chartsHtml = `<div class="summary-charts">`;

    // Stats grid with hrs / $ toggle
    chartsHtml += `<div class="chart-card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="chart-title" style="margin-bottom:0">Overview</div>
        <button class="toggle-earn-btn" onclick="App.toggleSummaryEarnings()">
          ${showEarn ? 'hrs' : '$'}
        </button>
      </div>
      <div class="stats-grid-2">
        <div class="mini-stat">
          <div class="mini-stat-label">${showEarn ? 'Total Billed' : 'Total Hours'}</div>
          <div class="mini-stat-value ${showEarn ? 'text-success' : ''}">${showEarn ? fmt$(totalEarned) : fmtH(totalHours)}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-stat-label">${showEarn ? 'Avg $/Day' : 'Avg Hrs/Day'}</div>
          <div class="mini-stat-value">${showEarn ? fmt$(totalEarned / elapsedWeekdays) : fmtH(totalHours / elapsedWeekdays)}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-stat-label">${showEarn ? 'Avg $/Week' : 'Avg Hrs/Week'}</div>
          <div class="mini-stat-value">${showEarn ? fmt$(totalEarned / elapsedWeeks) : fmtH(totalHours / elapsedWeeks)}</div>
        </div>
        <div class="mini-stat">
          <div class="mini-stat-label">${showEarn ? 'Eff. Rate/hr' : 'Days Tracked'}</div>
          <div class="mini-stat-value">${showEarn ? fmt$(effRate) : elapsedWeekdays + 'wd'}</div>
        </div>
      </div>
    </div>`;

    // Donut chart
    chartsHtml += `<div class="chart-card">
      <div class="chart-title">Client Breakdown</div>
      <div class="donut-wrap">
        <div class="donut-svg-wrap">${buildDonutSVG(data, totalHours)}</div>
        <div class="donut-legend">${legendHtml}</div>
      </div>
    </div>`;

    // Daily/weekly bar chart
    chartsHtml += `<div class="chart-card">
      <div class="chart-title">Hours Over Time</div>
      ${buildDailyBarSVG(start, end)}
    </div>`;

    chartsHtml += `</div>`;

    // ── Per-client breakdown cards ──────────────────────────
    let cardsHtml = `<div style="padding-top:4px">`;
    for (const [clientId, { hours, byProject }] of Object.entries(data)) {
      const client   = getClient(clientId);
      const color    = client ? client.color : '#6c63ff';
      const name     = client ? client.name  : 'Unknown';
      const rate     = client ? (client.rate || 0) : 0;
      const earnings = hours * rate;

      cardsHtml += `<div class="summary-client" style="border-left-color:${color}">
        <div class="summary-client-header">
          <div class="client-dot" style="background:${color}"></div>
          <div class="summary-client-name">${esc(name)}</div>
          <div class="summary-client-total">$${earnings.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        </div>
        <div class="summary-project-row">
          <div class="summary-proj-name text-muted fs-sm">Rate</div>
          <div></div>
          <div class="summary-proj-amount fs-sm">$${rate}/hr</div>
        </div>
        <div class="summary-project-row">
          <div class="summary-proj-name text-muted fs-sm">Hours</div>
          <div class="summary-proj-hours">${hours.toFixed(1)} hrs</div>
          <div></div>
        </div>`;

      for (const [projectId, pHours] of Object.entries(byProject)) {
        const proj      = getProject(projectId);
        const pEarnings = pHours * rate;
        const pPct      = hours > 0 ? Math.round((pHours / hours) * 100) : 0;
        cardsHtml += `<div class="summary-project-row">
          <div class="summary-proj-name">${proj ? esc(proj.name) : 'Unassigned'}</div>
          <div class="summary-proj-hours">${pHours.toFixed(1)} hrs <span style="color:var(--text3)">(${pPct}%)</span></div>
          <div class="summary-proj-amount">$${pEarnings.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        </div>`;
      }

      cardsHtml += `</div>`;
    }
    cardsHtml += `<div style="height:20px"></div></div>`;

    content.innerHTML = chartsHtml + cardsHtml;
  },

  // ── CSV Export ───────────────────────────────────────────
  exportCSV() {
    const { start, end } = getSummaryDateRange();
    const data  = aggregateRange(start, end);

    const rows = [['Client', 'Project', 'Hours', 'Rate ($/hr)', 'Amount ($)']];
    for (const [clientId, { byProject }] of Object.entries(data)) {
      const client = getClient(clientId);
      const name   = client ? client.name  : 'Unknown';
      const rate   = client ? (client.rate || 0) : 0;
      for (const [projectId, hours] of Object.entries(byProject)) {
        const proj = getProject(projectId);
        const projName = proj ? proj.name : 'Unassigned';
        rows.push([name, projName, hours.toFixed(1), rate, (hours * rate).toFixed(2)]);
      }
    }

    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `workflow-${formatRangeLabel().replace(/[\s–]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exported');
  },

  // ── Settings ─────────────────────────────────────────────
  renderSettings() {
    let html = '';

    // Account section
    html += `<div class="section-label">Account</div>`;
    html += `<div class="card mb-0" style="padding:0">
      <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div class="setting-label">Gist ID</div>
        <div style="font-size:12px;font-family:monospace;color:var(--text2);word-break:break-all;user-select:all;-webkit-user-select:all">${State.gistId || '—'}</div>
      </div>
      <div class="setting-row">
        <div class="setting-label">Sync</div>
        <button class="setting-row-btn" onclick="App.manualSync()">Sync now</button>
      </div>
      <div class="setting-row" style="border-bottom:none">
        <div class="setting-label">Sign out</div>
        <button class="setting-row-btn" style="color:var(--danger)" onclick="App.signOut()">Sign out</button>
      </div>
    </div>`;

    // Calendar section
    html += `<div class="section-label">Calendar</div>`;
    html += `<div class="card" style="padding:16px">
      <div class="field mb-0">
        <label class="field-label">iCal URL (private .ics)</label>
        <input class="input" type="url" id="ical-url-input"
          placeholder="webcal://…"
          value="${State.icalUrl ? esc(State.icalUrl) : ''}" />
        <div class="onboard-note" style="margin-top:6px">Fetched via corsproxy.io. Paste your calendar's private iCal link from Google Calendar, Fantastical, etc.</div>
      </div>
      <button class="btn btn-secondary btn-full" style="margin-top:12px" onclick="App.saveIcal()">Save Calendar</button>
    </div>`;

    // Clients section
    html += `<div class="section-label" style="display:flex;justify-content:space-between;align-items:center;padding-right:20px">
      <span>Clients</span>
      <button class="btn btn-sm btn-secondary" onclick="App.openClientModal()">+ Add</button>
    </div>`;

    if (State.clients.length === 0) {
      html += `<div class="card"><div class="text-muted fs-sm">No clients yet. Add one to start tracking.</div></div>`;
    } else {
      html += `<div class="card" style="padding:0">`;
      for (const client of State.clients) {
        const projCount = State.projects.filter(p => p.clientId === client.id).length;
        html += `<div class="client-item" onclick="App.openClientModal('${client.id}')">
          <div class="client-color-dot" style="background:${client.color}"></div>
          <div class="client-name">${esc(client.name)}</div>
          <div class="client-meta">$${client.rate || 0}/hr · ${projCount} project${projCount !== 1 ? 's' : ''}</div>
          <div class="chevron">›</div>
        </div>`;

        // Projects under client
        const projects = State.projects.filter(p => p.clientId === client.id);
        for (const proj of projects) {
          html += `<div class="project-item" onclick="App.openProjectModal('${client.id}','${proj.id}')">
            <div style="padding-left:22px;font-size:14px;color:var(--text2)">${esc(proj.name)}</div>
            <div class="chevron" style="font-size:14px">›</div>
          </div>`;
        }
        html += `<div style="padding:8px 16px 12px;border-top:1px solid var(--border)">
          <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();App.openProjectModal('${client.id}')">+ Add Project</button>
        </div>`;
      }
      html += `</div>`;
    }

    // Data section
    // Targets section
    html += `<div class="section-label">Targets</div>`;
    html += `<div class="card">
      <div class="field mb-0">
        <label class="field-label">Weekly hours target</label>
        <div style="display:flex;gap:10px;align-items:center">
          <input class="input" type="number" id="weekly-target-input"
            value="${State.weeklyHoursTarget || 50}" min="1" max="168" style="flex:1" />
          <button class="btn btn-secondary" onclick="App.saveWeeklyTarget()">Save</button>
        </div>
        <div class="onboard-note" style="margin-top:6px">Sets your upper bound. Monthly pace target is calculated from actual workdays in the month.</div>
      </div>
    </div>`;

    html += `<div class="section-label">Data</div>`;
    html += `<div class="card mb-0" style="padding:0">
      <div class="setting-row" style="border-bottom:none">
        <div class="setting-label">Import JSON</div>
        <button class="setting-row-btn" onclick="document.getElementById('import-file-input').click()">Choose file</button>
      </div>
    </div>`;
    html += `<input type="file" id="import-file-input" accept=".json,application/json"
      style="display:none" onchange="App.importData(this)" />`;

    html += `<div style="height:20px"></div>`;
    document.getElementById('settings-content').innerHTML = html;
  },

  async saveWeeklyTarget() {
    const val = parseFloat(document.getElementById('weekly-target-input').value);
    if (!val || val < 1) { showToast('Enter a valid target'); return; }
    State.weeklyHoursTarget = val;
    await Gist.syncWithRetry();
    showToast('Target saved ✓');
  },

  async saveIcal() {
    const val = document.getElementById('ical-url-input').value.trim();
    State.icalUrl = val || null;
    LS.set('flow_ical', State.icalUrl || '');
    await Gist.syncWithRetry();
    showToast('Calendar saved');
  },

  async manualSync() {
    await this.loadData();
    this.renderSettings();
    showToast('Synced ✓');
  },

  // ── Import JSON data file ─────────────────────────────────
  importData(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      let parsed;
      try {
        parsed = JSON.parse(e.target.result);
      } catch {
        showToast('Invalid JSON file');
        input.value = '';
        return;
      }

      // Merge clients (add new, preserve existing by id)
      if (Array.isArray(parsed.clients)) {
        for (const c of parsed.clients) {
          if (c.id && !State.clients.find(x => x.id === c.id)) {
            State.clients.push(c);
          }
        }
      }

      // Merge projects (add new, preserve existing by id)
      if (Array.isArray(parsed.projects)) {
        for (const p of parsed.projects) {
          if (p.id && !State.projects.find(x => x.id === p.id)) {
            State.projects.push(p);
          }
        }
      }

      // Merge blocks (imported slots fill in; existing slots preserved)
      if (parsed.blocks && typeof parsed.blocks === 'object') {
        for (const [day, slots] of Object.entries(parsed.blocks)) {
          if (!State.blocks[day]) State.blocks[day] = {};
          for (const [slot, val] of Object.entries(slots)) {
            if (!State.blocks[day][slot]) {
              State.blocks[day][slot] = val;
            }
          }
        }
      }

      input.value = '';
      try {
        await Gist.syncWithRetry();
        this.renderSettings();
        showToast('Data imported ✓');
      } catch {
        showToast('Import saved locally — sync failed');
      }
    };
    reader.readAsText(file);
  },

  signOut() {
    if (!confirm('Sign out? Your data stays in the Gist.')) return;
    LS.del('flow_pat');
    LS.del('flow_gist');
    LS.del('flow_ical');
    location.reload();
  },

  // ── Client modal ─────────────────────────────────────────
  openClientModal(clientId) {
    State.editingClientId = clientId || null;
    const client = clientId ? getClient(clientId) : null;
    document.getElementById('client-modal-title').textContent = client ? 'Edit Client' : 'Add Client';
    document.getElementById('cm-name').value = client ? client.name : '';
    document.getElementById('cm-rate').value = client ? (client.rate || '') : '';
    document.getElementById('cm-delete-btn').style.display = client ? 'inline-flex' : 'none';

    // Render swatches
    const selectedColor = client ? client.color : PRESET_COLORS[0];
    document.getElementById('cm-swatches').innerHTML = PRESET_COLORS.map(c =>
      `<div class="color-swatch${c === selectedColor ? ' selected' : ''}"
        style="background:${c}" data-color="${c}"
        onclick="App.selectColor('${c}')">`
    ).join('</div>') + '</div>';
    this._selectedColor = selectedColor;

    document.getElementById('client-modal').classList.add('open');
    setTimeout(() => document.getElementById('cm-name').focus(), 300);
  },

  selectColor(color) {
    this._selectedColor = color;
    document.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.toggle('selected', s.dataset.color === color);
    });
  },

  closeClientModal() {
    document.getElementById('client-modal').classList.remove('open');
    State.editingClientId = null;
  },

  async saveClient() {
    const name  = document.getElementById('cm-name').value.trim();
    const rate  = parseFloat(document.getElementById('cm-rate').value) || 0;
    const color = this._selectedColor || PRESET_COLORS[0];
    if (!name) { showToast('Please enter a client name'); return; }

    if (State.editingClientId) {
      const idx = State.clients.findIndex(c => c.id === State.editingClientId);
      if (idx >= 0) State.clients[idx] = { ...State.clients[idx], name, color, rate };
    } else {
      State.clients.push({ id: uid(), name, color, rate });
    }

    this.closeClientModal();
    this.renderSettings();
    await Gist.syncWithRetry();
  },

  async deleteClient() {
    if (!State.editingClientId) return;
    if (!confirm('Delete this client? All associated time blocks will lose their client reference.')) return;
    State.clients  = State.clients.filter(c => c.id !== State.editingClientId);
    State.projects = State.projects.filter(p => p.clientId !== State.editingClientId);
    this.closeClientModal();
    this.renderSettings();
    await Gist.syncWithRetry();
  },

  // ── Project modal ────────────────────────────────────────
  openProjectModal(clientId, projectId) {
    State.editingClientId  = clientId;
    State.editingProjectId = projectId || null;
    const proj = projectId ? getProject(projectId) : null;
    document.getElementById('project-modal-title').textContent = proj ? 'Edit Project' : 'Add Project';
    document.getElementById('pm-name').value = proj ? proj.name : '';
    document.getElementById('pm-delete-btn').style.display = proj ? 'inline-flex' : 'none';
    document.getElementById('project-modal').classList.add('open');
    setTimeout(() => document.getElementById('pm-name').focus(), 300);
  },

  closeProjectModal() {
    document.getElementById('project-modal').classList.remove('open');
    State.editingProjectId = null;
  },

  async saveProject() {
    const name = document.getElementById('pm-name').value.trim();
    if (!name) { showToast('Please enter a project name'); return; }

    if (State.editingProjectId) {
      const idx = State.projects.findIndex(p => p.id === State.editingProjectId);
      if (idx >= 0) State.projects[idx] = { ...State.projects[idx], name };
    } else {
      State.projects.push({ id: uid(), clientId: State.editingClientId, name });
    }

    this.closeProjectModal();
    this.renderSettings();
    await Gist.syncWithRetry();
  },

  async deleteProject() {
    if (!State.editingProjectId) return;
    if (!confirm('Delete this project?')) return;
    State.projects = State.projects.filter(p => p.id !== State.editingProjectId);
    this.closeProjectModal();
    this.renderSettings();
    await Gist.syncWithRetry();
  },
};

// ── Utility ────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Close modals on backdrop tap ───────────────────────────
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) {
      backdrop.classList.remove('open');
    }
  });
});

// ── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
  }
});

// ── Boot ───────────────────────────────────────────────────
App.init();

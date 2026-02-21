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
  activeTab:    'today',
  calEvents:    [],   // parsed events for current day
  editingBlock: null, // { date, slot }
  editingClientId: null,
  editingProjectId: null,
  syncing:      false,
  initialized:  false,
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
  },

  async save() {
    const payload = {
      clients:  State.clients,
      projects: State.projects,
      blocks:   State.blocks,
      icalUrl:  State.icalUrl || null,
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
    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
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

  async loadData() {
    setSyncing(true);
    try {
      await Gist.load();
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
    let html = '';
    for (let h = DAY_START; h < DAY_END; h++) {
      for (let m = 0; m < 60; m += SLOT_MINS) {
        const slot    = slotKey(h, m);
        const block   = getBlock(dk, slot);
        const calEvts = calSlots[slot] || [];
        const showTime = m === 0;
        const timeLabel = showTime
          ? `${h > 12 ? h - 12 : h}${h >= 12 ? 'pm' : 'am'}`
          : '';

        html += `<div class="time-row">
          <div class="time-label">${timeLabel}</div>
          ${this.blockHTML(dk, slot, block, calEvts)}
        </div>`;
      }
    }
    return html;
  },

  blockHTML(dk, slot, block, calEvts) {
    if (block && block.clientId) {
      const client  = getClient(block.clientId);
      const project = getProject(block.projectId);
      const color   = client ? client.color : '#6c63ff';
      const bg      = hexToRgba(color, 0.18);
      const border  = hexToRgba(color, 0.45);
      return `<div class="time-block filled"
        style="background:${bg};border-left:3px solid ${color};color:${color}"
        onclick="App.openBlockModal('${dk}','${slot}')">
        <div class="time-block-content">
          <div class="block-client">${client ? esc(client.name) : '?'}</div>
          <div class="block-project" style="color:var(--text)">${project ? esc(project.name) : ''}</div>
          ${block.notes ? `<div class="block-notes" style="color:var(--text2)">${esc(block.notes)}</div>` : ''}
        </div>
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
  openBlockModal(dk, slot) {
    State.editingBlock = { date: dk, slot };
    const block = getBlock(dk, slot);
    const { h, m } = parseSlot(slot);
    const hour = h > 12 ? h - 12 : h;
    const ampm = h >= 12 ? 'pm' : 'am';
    const minStr = m === 0 ? '' : `:${String(m).padStart(2,'0')}`;
    document.getElementById('block-modal-title').textContent =
      `${hour}${minStr}${ampm} — ${String(m + SLOT_MINS === 60 ? h + 1 : h > 12 ? h - 12 : h)
        .replace(/^(\d)/, '$1')}:${String((m + SLOT_MINS) % 60).padStart(2,'0')}${h + (m + SLOT_MINS >= 60 ? 1 : 0) >= 12 ? 'pm' : 'am'}`;

    // Populate client dropdown
    const clientSel = document.getElementById('bm-client');
    clientSel.innerHTML = '<option value="">Select client…</option>' +
      State.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    if (block) {
      clientSel.value = block.clientId || '';
      this.updateBlockProjectDropdown(block.clientId, block.projectId);
      document.getElementById('bm-notes').value = block.notes || '';
      document.getElementById('bm-clear-btn').style.display = 'inline-flex';
    } else {
      document.getElementById('bm-project').innerHTML = '<option value="">Select project…</option>';
      document.getElementById('bm-notes').value = '';
      document.getElementById('bm-clear-btn').style.display = 'none';
    }

    document.getElementById('block-modal').classList.add('open');
    setTimeout(() => document.getElementById('bm-notes').focus?.(), 400);
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
    setBlock(date, slot, { clientId, projectId, notes });
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

  // ── Dashboard ────────────────────────────────────────────
  renderDashboard() {
    const today     = new Date();
    const weekStart = startOfWeek(today);
    const weekEnd   = addDays(weekStart, 6);
    const monthStart = startOfMonth(today);
    const monthEnd   = endOfMonth(today);

    const weekData  = aggregateRange(weekStart, weekEnd);
    const monthData = aggregateRange(monthStart, monthEnd);

    const weekHours  = Object.values(weekData).reduce((s, v) => s + v.hours, 0);
    const monthHours = Object.values(monthData).reduce((s, v) => s + v.hours, 0);
    const weekEarnings  = this.calcEarnings(weekData);
    const monthEarnings = this.calcEarnings(monthData);

    let html = '';

    // Summary stats
    html += `<div style="height:12px"></div>`;
    html += `<div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">This Week</div>
        <div class="stat-value">${weekHours.toFixed(1)}h</div>
        <div class="stat-sub">${formatShortDate(weekStart)} – ${formatShortDate(weekEnd)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Earnings</div>
        <div class="stat-value text-success">$${weekEarnings.toLocaleString()}</div>
        <div class="stat-sub">this week</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">This Month</div>
        <div class="stat-value">${monthHours.toFixed(1)}h</div>
        <div class="stat-sub">${formatMonthYear(today)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Earnings</div>
        <div class="stat-value text-success">$${monthEarnings.toLocaleString()}</div>
        <div class="stat-sub">this month</div>
      </div>
    </div>`;

    // Week bar chart
    html += `<div class="section-label">This Week by Client</div>`;
    html += `<div class="card mb-0">`;
    html += this.barChart(weekData, weekHours);
    html += `</div>`;

    // Month bar chart
    html += `<div class="section-label">This Month by Client</div>`;
    html += `<div class="card" style="margin-bottom:20px">`;
    html += this.barChart(monthData, monthHours);
    html += `</div>`;

    // By project breakdown (month)
    html += this.projectBreakdownHTML(monthData, 'Month by Project');

    document.getElementById('dashboard-content').innerHTML = html;
  },

  calcEarnings(data) {
    let total = 0;
    for (const [clientId, { hours }] of Object.entries(data)) {
      const client = getClient(clientId);
      if (client) total += hours * (client.rate || 0);
    }
    return Math.round(total);
  },

  barChart(data, totalHours) {
    if (Object.keys(data).length === 0) {
      return `<div class="empty-state" style="padding:24px 0">
        <div class="empty-sub">No tracked time</div>
      </div>`;
    }
    const max = Math.max(...Object.values(data).map(v => v.hours));
    let html = '<div class="bar-chart">';
    for (const [clientId, { hours }] of Object.entries(data)) {
      const client = getClient(clientId);
      const pct = max > 0 ? (hours / max * 100).toFixed(1) : 0;
      const color = client ? client.color : '#6c63ff';
      const name  = client ? client.name : 'Unknown';
      html += `<div class="bar-row">
        <div class="bar-label">${esc(name)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="bar-val">${hours.toFixed(1)}h</div>
      </div>`;
    }
    html += '</div>';
    return html;
  },

  projectBreakdownHTML(data, title) {
    if (Object.keys(data).length === 0) return '';
    let html = `<div class="section-label">${title}</div>`;
    for (const [clientId, { byProject }] of Object.entries(data)) {
      const client = getClient(clientId);
      if (!client) continue;
      for (const [projectId, hours] of Object.entries(byProject)) {
        const proj = getProject(projectId);
        html += `<div class="card" style="margin-bottom:8px;padding:12px 16px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-size:11px;font-weight:600;color:${client.color};text-transform:uppercase;letter-spacing:0.5px">${esc(client.name)}</div>
              <div style="font-size:14px;font-weight:600">${proj ? esc(proj.name) : 'Unassigned'}</div>
            </div>
            <div style="font-size:15px;font-weight:700">${hours.toFixed(1)}h</div>
          </div>
        </div>`;
      }
    }
    return html + `<div style="height:20px"></div>`;
  },

  // ── Summary ──────────────────────────────────────────────
  summaryNav(delta) {
    const d = State.summaryMonth;
    State.summaryMonth = new Date(d.getFullYear(), d.getMonth() + delta, 1);
    this.renderSummary();
  },

  renderSummary() {
    const month = State.summaryMonth;
    document.getElementById('summary-month-label').textContent = formatMonthYear(month);

    const start = startOfMonth(month);
    const end   = endOfMonth(month);
    const data  = aggregateRange(start, end);

    let html = '';

    if (Object.keys(data).length === 0) {
      html = `<div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No data this month</div>
        <div class="empty-sub">Start tracking time on the Today tab</div>
      </div>`;
      document.getElementById('summary-content').innerHTML = html;
      return;
    }

    for (const [clientId, { hours, byProject }] of Object.entries(data)) {
      const client   = getClient(clientId);
      const color    = client ? client.color : '#6c63ff';
      const name     = client ? client.name  : 'Unknown';
      const rate     = client ? (client.rate || 0) : 0;
      const earnings = hours * rate;

      html += `<div class="summary-client">
        <div class="summary-client-header">
          <div class="client-dot" style="background:${color}"></div>
          <div class="summary-client-name">${esc(name)}</div>
          <div class="summary-client-total">$${earnings.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        </div>`;

      // Rate row
      html += `<div class="summary-project-row">
        <div class="summary-proj-name text-muted fs-sm">Rate</div>
        <div></div>
        <div class="summary-proj-amount fs-sm">$${rate}/hr</div>
      </div>`;
      html += `<div class="summary-project-row">
        <div class="summary-proj-name text-muted fs-sm">Total hours</div>
        <div class="summary-proj-hours">${hours.toFixed(1)} hrs</div>
        <div></div>
      </div>`;

      for (const [projectId, pHours] of Object.entries(byProject)) {
        const proj = getProject(projectId);
        const pEarnings = pHours * rate;
        html += `<div class="summary-project-row">
          <div class="summary-proj-name">${proj ? esc(proj.name) : 'Unassigned'}</div>
          <div class="summary-proj-hours">${pHours.toFixed(1)} hrs</div>
          <div class="summary-proj-amount">$${pEarnings.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        </div>`;
      }

      html += `</div>`;
    }

    // Totals row
    const totalHours    = Object.values(data).reduce((s, v) => s + v.hours, 0);
    const totalEarnings = this.calcEarnings(data);
    html += `<div class="card" style="margin-top:4px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="stat-label">Total</div>
        <div style="font-size:20px;font-weight:700;margin-top:2px">${totalHours.toFixed(1)} hrs</div>
      </div>
      <div style="text-align:right">
        <div class="stat-label">Billed</div>
        <div style="font-size:20px;font-weight:700;color:var(--success);margin-top:2px">
          $${totalEarnings.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}
        </div>
      </div>
    </div>`;
    html += `<div style="height:20px"></div>`;

    document.getElementById('summary-content').innerHTML = html;
  },

  // ── CSV Export ───────────────────────────────────────────
  exportCSV() {
    const month = State.summaryMonth;
    const start = startOfMonth(month);
    const end   = endOfMonth(month);
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
    a.download = `flow-${formatMonthYear(month).replace(' ', '-')}.csv`;
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
      <div class="setting-row">
        <div class="setting-label">Gist ID</div>
        <div class="setting-value">${State.gistId ? State.gistId.slice(0, 8) + '…' : '—'}</div>
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

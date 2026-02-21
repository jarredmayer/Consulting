#!/usr/bin/env node
// generate-seed.js
// One-time script to build the historical seed JSON for the Flow app.
// Output: seed-data.json  (paste this into your private Gist)
//
// Rate rules:
//   < 2025-12-01  →  H.I.G. Capital (Historical)  $100/hr
//  >= 2025-12-01  →  H.I.G. Capital               $105/hr

'use strict';

const fs = require('fs');

// ── Raw data ─────────────────────────────────────────────────────────────────
// Day;Start;End  (rest of columns ignored)
const RAW = `
Mon Nov 18;8:30 AM;7:00 PM
Tue Nov 19;9:00 AM;7:00 PM
Wed Nov 20;8:30 AM;6:00 PM
Thu Nov 21;8:00 AM;7:00 PM
Fri Nov 22;7:00 AM;4:00 PM
Mon Nov 25;8:30 AM;6:00 PM
Tue Nov 26;8:30 AM;6:00 PM
Wed Nov 27;8:30 AM;6:00 PM
Mon Dec 2;8:30 AM;6:00 PM
Tue Dec 3;9:00 AM;6:30 PM
Wed Dec 4;8:30 AM;6:30 PM
Thu Dec 5;8:30 AM;5:30 PM
Fri Dec 6;8:30 AM;5:00 PM
Mon Dec 9;8:30 AM;7:00 PM
Tue Dec 10;8:30 AM;6:00 PM
Wed Dec 11;8:00 AM;6:00 PM
Thu Dec 12;8:00 AM;6:30 PM
Fri Dec 13;8:00 AM;5:30 PM
Mon Dec 16;8:30 AM;7:00 PM
Tue Dec 17;8:30 AM;7:00 PM
Wed Dec 18;8:00 AM;6:00 PM
Thu Dec 19;8:00 AM;5:00 PM
Fri Dec 20;8:00 AM;5:00 PM
Tue Dec 24;8:00 AM;5:00 PM
Thu Dec 26;8:00 AM;5:00 PM
Fri Dec 27;8:00 AM;5:00 PM
Mon Dec 30;8:00 AM;8:00 PM
Tue Dec 31;8:30 AM;5:30 PM
Thu Jan 2;8:30 AM;7:00 PM
Fri Jan 3;8:30 AM;6:30 PM
Mon Jan 6;8:30 AM;8:00 PM
Tue Jan 7;3:00 PM;6:00 PM
Wed Jan 8;8:00 AM;5:30 PM
Thu Jan 9;8:00 AM;6:00 PM
Fri Jan 10;8:30 AM;6:00 PM
Sat Jan 11;11:00 AM;3:00 PM
Mon Jan 13;8:00 AM;6:00 PM
Tue Jan 14;8:00 AM;6:00 PM
Wed Jan 15;8:00 AM;7:00 PM
Thu Jan 16;8:00 AM;6:30 PM
Fri Jan 17;8:30 AM;5:30 PM
Tue Jan 21;8:45 AM;6:00 PM
Wed Jan 22;8:30 AM;6:00 PM
Thu Jan 23;8:30 AM;6:00 PM
Fri Jan 24;8:30 AM;5:00 PM
Mon Jan 27;8:00 AM;6:30 PM
Tue Jan 28;8:00 AM;5:30 PM
Wed Jan 29;8:30 AM;6:30 PM
Thu Jan 30;8:30 AM;6:00 PM
Fri Jan 31;8:30 AM;6:00 PM
Mon Feb 3;8:00 AM;6:30 PM
Tue Feb 4;8:30 AM;6:30 PM
Wed Feb 5;8:00 AM;6:00 PM
Thu Feb 6;8:30 AM;6:00 PM
Fri Feb 7;8:30 AM;5:30 PM
Mon Feb 10;8:00 AM;7:00 PM
Tue Feb 11;8:00 AM;6:30 PM
Wed Feb 12;8:30 AM;6:30 PM
Thu Feb 13;8:00 AM;7:00 PM
Fri Feb 14;8:30 AM;4:00 PM
Tue Feb 18;8:00 AM;8:00 PM
Wed Feb 19;8:00 AM;6:00 PM
Thu Feb 20;8:00 AM;5:00 PM
Fri Feb 21;8:30 AM;5:30 PM
Mon Feb 24;8:00 AM;6:00 PM
Tue Feb 25;8:00 AM;7:00 PM
Wed Feb 26;8:00 AM;7:00 PM
Thu Feb 27;8:00 AM;7:00 PM
Fri Feb 28;9:00 AM;4:00 PM
Mon Mar 3;9:00 AM;6:30 PM
Tue Mar 4;8:00 AM;7:30 PM
Wed Mar 5;8:00 AM;6:00 PM
Thu Mar 6;8:00 AM;7:00 PM
Fri Mar 7;8:30 AM;4:00 PM
Mon Mar 10;8:30 AM;4:30 PM
Tue Mar 11;8:00 AM;7:00 PM
Wed Mar 12;8:00 AM;6:30 PM
Thu Mar 13;9:00 AM;7:30 PM
Fri Mar 14;11:00 AM;5:00 PM
Mon Mar 17;8:00 AM;5:30 PM
Tue Mar 18;8:30 AM;7:00 PM
Wed Mar 19;8:30 AM;5:30 PM
Thu Mar 20;8:00 AM;6:00 PM
Fri Mar 21;8:30 AM;5:30 PM
Mon Mar 24;8:30 AM;6:00 PM
Tue Mar 25;8:00 AM;6:00 PM
Wed Mar 26;8:00 AM;6:30 PM
Thu Mar 27;8:00 AM;6:30 PM
Fri Mar 28;8:30 AM;5:00 PM
Mon Mar 31;8:30 AM;6:00 PM
Tue Apr 1;9:00 AM;5:00 PM
Wed Apr 2;8:30 AM;6:30 PM
Thu Apr 3;8:00 AM;6:00 PM
Fri Apr 4;8:00 AM;4:30 PM
Mon Apr 7;8:00 AM;1:00 PM
Tue Apr 8;8:30 AM;6:30 PM
Wed Apr 9;9:30 AM;5:30 PM
Thu Apr 10;8:30 AM;6:30 PM
Fri Apr 11;11:00 AM;6:00 PM
Mon Apr 14;9:00 AM;6:00 PM
Tue Apr 15;8:00 AM;6:00 PM
Wed Apr 16;8:30 AM;5:00 PM
Thu Apr 17;8:30 AM;6:30 PM
Fri Apr 18;8:30 AM;3:30 PM
Mon Apr 21;8:30 AM;5:30 PM
Tue Apr 22;8:30 AM;6:00 PM
Wed Apr 23;8:30 AM;5:30 PM
Thu Apr 24;8:00 AM;7:00 PM
Fri Apr 25;7:30 AM;4:00 PM
Mon Apr 28;8:00 AM;6:00 PM
Tue Apr 29;8:00 AM;6:00 PM
Wed Apr 30;8:30 AM;5:00 PM
Thu May 1;8:30 AM;5:00 PM
Fri May 2;8:00 AM;4:30 PM
Mon May 5;9:30 AM;4:30 PM
Tue May 6;9:30 AM;7:30 PM
Wed May 7;9:00 AM;6:30 PM
Thu May 8;9:30 AM;6:30 PM
Fri May 9;8:30 AM;4:30 PM
Mon May 12;8:30 AM;6:00 PM
Tue May 13;8:00 AM;7:30 PM
Wed May 14;8:00 AM;7:30 PM
Thu May 15;9:00 AM;6:30 PM
Fri May 16;8:30 AM;3:00 PM
Mon May 19;8:30 AM;5:30 PM
Tue May 20;8:30 AM;6:30 PM
Wed May 21;8:30 AM;7:30 PM
Thu May 22;7:30 AM;3:30 PM
Mon Jun 2;8:00 AM;8:00 PM
Tue Jun 3;8:00 AM;8:30 PM
Wed Jun 4;9:00 AM;9:00 PM
Thu Jun 5;8:00 AM;4:00 PM
Fri Jun 6;9:00 AM;4:00 PM
Mon Jun 9;8:30 AM;5:30 PM
Tue Jun 10;9:30 AM;5:30 PM
Wed Jun 11;9:00 AM;5:30 PM
Thu Jun 12;8:00 AM;4:00 PM
Fri Jun 13;8:30 AM;3:00 PM
Mon Jun 16;8:00 AM;5:00 PM
Tue Jun 17;8:00 AM;5:00 PM
Wed Jun 18;8:00 AM;5:00 PM
Fri Jun 20;8:00 AM;5:00 PM
Mon Jun 23;9:00 AM;7:00 PM
Tue Jun 24;9:00 AM;6:30 PM
Wed Jun 25;9:00 AM;5:30 PM
Thu Jun 26;9:00 AM;5:30 PM
Mon Jun 30;8:00 AM;6:00 PM
Tue Jul 1;8:00 AM;7:30 PM
Wed Jul 2;9:00 AM;5:00 PM
Thu Jul 3;9:00 AM;3:30 PM
Mon Jul 7;8:30 AM;4:30 PM
Tue Jul 8;8:30 AM;5:30 PM
Wed Jul 9;8:00 AM;7:00 PM
Thu Jul 10;8:00 AM;2:00 PM
Fri Jul 11;7:00 AM;11:00 AM
Mon Jul 14;8:00 AM;7:00 PM
Tue Jul 15;8:30 AM;7:00 PM
Wed Jul 16;8:00 AM;8:00 PM
Thu Jul 17;8:00 AM;8:00 PM
Fri Jul 18;9:00 AM;6:30 PM
Mon Jul 21;8:30 AM;7:30 PM
Tue Jul 22;8:00 AM;6:30 PM
Wed Jul 23;8:00 AM;7:00 PM
Thu Jul 24;8:00 AM;6:00 PM
Fri Jul 25;8:00 AM;4:00 PM
Mon Jul 28;8:00 AM;6:00 PM
Tue Jul 29;8:00 AM;6:00 PM
Wed Jul 30;9:00 AM;6:00 PM
Thu Jul 31;9:00 AM;5:00 PM
Fri Aug 1;8:30 AM;6:00 PM
Mon Aug 4;8:30 AM;7:00 PM
Tue Aug 5;8:30 AM;7:00 PM
Wed Aug 6;8:30 AM;9:00 PM
Thu Aug 7;8:30 AM;7:00 PM
Fri Aug 8;9:30 AM;5:30 PM
Sun Aug 10;4:00 PM;8:00 PM
Mon Aug 11;6:00 AM;7:00 PM
Tue Aug 12;9:00 AM;6:00 PM
Wed Aug 13;8:30 AM;5:00 PM
Thu Aug 14;9:00 AM;6:00 PM
Fri Aug 15;9:00 AM;4:00 PM
Sat Aug 16;10:00 AM;12:00 PM
Mon Aug 18;8:30 AM;6:00 PM
Tue Aug 19;9:00 AM;6:00 PM
Wed Aug 20;8:00 AM;8:00 PM
Thu Aug 21;8:00 AM;5:00 PM
Fri Aug 22;8:00 AM;6:00 PM
Mon Aug 25;8:30 AM;8:00 PM
Tue Aug 26;8:30 AM;6:30 PM
Wed Aug 27;8:30 AM;5:00 PM
Thu Aug 28;9:00 AM;7:00 PM
Fri Aug 29;8:30 AM;4:30 PM
Mon Sep 1;1:00 PM;7:00 PM
Tue Sep 2;8:30 AM;7:30 PM
Wed Sep 3;8:30 AM;7:30 PM
Thu Sep 4;8:00 AM;7:00 PM
Fri Sep 5;8:00 AM;7:00 PM
Mon Sep 8;8:30 AM;8:30 PM
Tue Sep 9;8:30 AM;8:30 PM
Wed Sep 10;8:00 AM;10:00 PM
Thu Sep 11;8:00 AM;6:00 PM
Fri Sep 12;8:30 AM;8:30 PM
Sat Sep 13;10:30 AM;1:30 PM
Mon Sep 15;8:00 AM;8:00 PM
Tue Sep 16;8:00 AM;8:30 PM
Wed Sep 17;8:00 AM;8:30 PM
Thu Sep 18;8:00 AM;8:00 PM
Fri Sep 19;8:00 AM;7:00 PM
Sat Sep 20;10:30 AM;3:30 PM
Sun Sep 21;1:00 PM;4:00 PM
Mon Sep 22;8:00 AM;9:00 PM
Tue Sep 23;7:30 AM;7:30 PM
Wed Sep 24;8:00 AM;8:00 PM
Thu Sep 25;8:30 AM;7:30 PM
Fri Sep 26;9:30 AM;6:30 PM
Mon Sep 29;8:00 AM;6:00 PM
Tue Sep 30;8:00 AM;6:00 PM
Wed Oct 1;9:00 AM;8:30 PM
Thu Oct 2;8:00 AM;6:00 PM
Fri Oct 3;9:00 AM;4:00 PM
Sun Oct 5;1:00 PM;5:00 PM
Mon Oct 6;8:30 AM;6:30 PM
Tue Oct 7;8:00 AM;8:00 PM
Wed Oct 8;8:00 AM;8:00 PM
Thu Oct 9;8:30 AM;6:30 PM
Fri Oct 10;9:00 AM;3:00 PM
Mon Oct 13;9:00 AM;4:00 PM
Tue Oct 14;8:00 AM;5:00 PM
Wed Oct 15;8:00 AM;4:00 PM
Thu Oct 16;9:00 AM;5:00 PM
Fri Oct 17;9:00 AM;5:00 PM
Mon Oct 20;8:30 AM;5:30 PM
Tue Oct 21;8:30 AM;6:00 PM
Wed Oct 22;6:00 AM;5:00 PM
Thu Oct 23;9:00 AM;6:00 PM
Fri Oct 24;1:00 PM;3:00 PM
Mon Oct 27;8:00 AM;3:00 PM
Tue Oct 28;9:00 AM;6:00 PM
Wed Oct 29;9:00 AM;5:30 PM
Thu Oct 30;9:00 AM;6:00 PM
Fri Oct 31;9:00 AM;5:00 PM
Mon Nov 3;8:30 AM;6:30 PM
Tue Nov 4;8:00 AM;6:00 PM
Wed Nov 5;9:00 AM;7:00 PM
Thu Nov 6;8:00 AM;5:00 PM
Fri Nov 7;6:00 AM;10:00 AM
Mon Nov 10;6:00 AM;2:00 PM
Tue Nov 11;8:00 AM;6:00 PM
Wed Nov 12;8:00 AM;7:30 PM
Thu Nov 13;8:00 AM;9:00 PM
Fri Nov 14;9:00 AM;6:00 PM
Sun Nov 16;1:00 PM;4:00 PM
Mon Nov 17;8:30 AM;6:00 PM
Tue Nov 18;8:30 AM;7:00 PM
Wed Nov 19;8:30 AM;6:30 PM
Thu Nov 20;8:30 AM;8:00 PM
Fri Nov 21;8:30 AM;6:30 PM
Mon Nov 24;8:30 AM;6:30 PM
Tue Nov 25;8:00 AM;6:30 PM
Wed Nov 26;8:00 AM;6:30 PM
Mon Dec 1;9:00 AM;5:00 PM
Tue Dec 2;8:00 AM;6:30 PM
Wed Dec 3;8:30 AM;6:30 PM
Thu Dec 4;8:30 AM;6:30 PM
Fri Dec 5;9:00 AM;5:30 PM
Mon Dec 8;9:00 AM;9:00 PM
Tue Dec 9;8:30 AM;7:00 PM
Wed Dec 10;9:00 AM;5:00 PM
Thu Dec 11;8:30 AM;5:00 PM
Fri Dec 12;9:30 AM;6:00 PM
Mon Dec 15;9:00 AM;6:00 PM
Tue Dec 16;8:30 AM;6:30 PM
Wed Dec 17;8:00 AM;6:00 PM
Thu Dec 18;9:00 AM;5:00 PM
Fri Dec 19;9:00 AM;7:00 PM
Sat Dec 20;11:00 AM;1:00 PM
Sun Dec 21;1:00 PM;4:00 PM
Mon Dec 22;8:30 AM;5:30 PM
Tue Dec 23;9:00 AM;6:00 PM
Fri Dec 26;9:00 AM;5:00 PM
Mon Dec 29;9:00 AM;5:00 PM
Tue Dec 30;9:00 AM;5:00 PM
Wed Dec 31;8:30 AM;3:30 PM
Fri Jan 2;8:30 AM;5:30 PM
Mon Jan 5;8:30 AM;6:30 PM
Tue Jan 6;8:00 AM;7:30 PM
Wed Jan 7;8:00 AM;7:30 PM
Thu Jan 8;8:30 AM;7:00 PM
Fri Jan 9;7:30 AM;3:30 PM
Mon Jan 12;8:30 AM;7:00 PM
Tue Jan 13;9:30 AM;7:30 PM
Wed Jan 14;8:30 AM;8:30 PM
Thu Jan 15;8:00 AM;6:00 PM
Fri Jan 16;8:30 AM;7:30 PM
Mon Jan 19;3:30 PM;7:00 PM
Tue Jan 20;9:00 AM;7:30 PM
Wed Jan 21;9:00 AM;9:00 PM
Thu Jan 22;9:00 AM;8:00 PM
Fri Jan 23;10:00 AM;7:00 PM
Mon Jan 26;8:00 AM;6:00 PM
Tue Jan 27;8:00 AM;7:00 PM
Wed Jan 28;8:30 AM;7:30 PM
Thu Jan 29;8:30 AM;8:30 PM
Fri Jan 30;8:30 AM;4:00 PM
Mon Feb 2;8:30 AM;5:30 PM
Sun Feb 8;3:00 PM;7:00 PM
Mon Feb 9;8:00 AM;7:30 PM
Tue Feb 10;8:00 AM;7:30 PM
Wed Feb 11;8:00 AM;10:00 PM
Thu Feb 12;8:00 AM;9:00 PM
Fri Feb 13;8:00 AM;8:00 PM
Sun Feb 15;11:00 AM;2:00 PM
Mon Feb 16;8:00 AM;8:00 PM
Tue Feb 17;8:00 AM;6:00 PM
Wed Feb 18;7:30 AM;10:00 PM
Thu Feb 19;8:30 AM;7:30 PM
Fri Feb 20;9:00 AM;5:00 PM
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseTime(s) {
  if (!s || !s.trim()) return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min; // total minutes from midnight
}

// Generate slot keys (HH:MM) for every 30-min interval [startMins, endMins)
function slots(startMins, endMins) {
  const out = [];
  for (let t = startMins; t < endMins; t += 30) {
    const h = Math.floor(t / 60);
    const m = t % 60;
    out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return out;
}

// ── Client definitions ────────────────────────────────────────────────────────
const CLIENT_HIST = { id: 'hig_hist', name: 'H.I.G. Capital (Historical)', color: '#60a5fa', rate: 100 };
const CLIENT_CURR = { id: 'hig_curr', name: 'H.I.G. Capital',              color: '#6c63ff', rate: 105 };

// Rate change boundary (exclusive: this date and after → $105)
const RATE_CHANGE = new Date(2025, 11, 1); // Dec 1, 2025

// ── Parse entries ─────────────────────────────────────────────────────────────
const blocks = {};
let year = 2024;
let prevMonth = -1;

const lines = RAW.split('\n').filter(l => l.trim());

for (const line of lines) {
  const parts = line.split(';');
  const dayStr   = parts[0].trim(); // e.g. "Mon Nov 18"
  const startStr = parts[1] ? parts[1].trim() : '';
  const endStr   = parts[2] ? parts[2].trim() : '';

  const dayParts  = dayStr.split(' ');
  const monthName = dayParts[1];
  const dayNum    = parseInt(dayParts[2], 10);
  const monthNum  = MONTHS[monthName];

  if (monthNum === undefined || isNaN(dayNum)) continue;

  // Detect year rollover (month number went backwards)
  if (prevMonth !== -1 && monthNum < prevMonth) year++;
  prevMonth = monthNum;

  const start = parseTime(startStr);
  const end   = parseTime(endStr);
  if (start === null || end === null || end <= start) continue; // skip incomplete

  const date = new Date(year, monthNum, dayNum);
  const yy   = date.getFullYear();
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const dd   = String(date.getDate()).padStart(2, '0');
  const key  = `${yy}-${mm}-${dd}`;

  const clientId = date >= RATE_CHANGE ? CLIENT_CURR.id : CLIENT_HIST.id;

  const daySlots = slots(start, end);
  if (!blocks[key]) blocks[key] = {};
  for (const slot of daySlots) {
    blocks[key][slot] = { clientId, projectId: null, notes: '' };
  }
}

// ── Assemble output ───────────────────────────────────────────────────────────
const output = {
  clients:  [CLIENT_HIST, CLIENT_CURR],
  projects: [],
  blocks,
  icalUrl:  null,
};

const dayCount  = Object.keys(blocks).length;
const slotCount = Object.values(blocks).reduce((s, d) => s + Object.keys(d).length, 0);
const totalHrs  = slotCount * 0.5;

fs.writeFileSync('seed-data.json', JSON.stringify(output, null, 2));

console.log('✓ seed-data.json written');
console.log(`  Days   : ${dayCount}`);
console.log(`  Slots  : ${slotCount}  (${totalHrs.toFixed(1)} hrs)`);
console.log(`  Clients: ${CLIENT_HIST.name} ($${CLIENT_HIST.rate}/hr)  |  ${CLIENT_CURR.name} ($${CLIENT_CURR.rate}/hr)`);

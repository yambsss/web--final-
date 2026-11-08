'use strict';
/* =========================================================
   dnkq — pickleball system
   Everything is saved in the browser (localStorage), so the
   data stays after a refresh. No server or library needed.
   ========================================================= */

/* ---------- Settings ---------- */
const COURT_OPEN = 6;     // court opens at 6:00 AM
const COURT_CLOSE = 22;   // court closes at 10:00 PM
const OPENPLAY_DURATION = 240;
const OPENPLAY_CAPACITY = 16;
const OPENPLAY_MATCH_MINUTES = 15;
const DB_KEY = 'dnkq_db';
const SESSION_KEY = 'dnkq_session';

/* ---------- Small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const peso = n => '₱' + Number(n).toLocaleString('en-PH');
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad = n => String(n).padStart(2, '0');
// Escape text typed by users before putting it inside HTML
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function fmtDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtStamp(iso) {
  return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
}
function hourLabel(h) {
  return (h % 12 || 12) + ':00 ' + (h >= 12 ? 'PM' : 'AM');
}
function openPlayTimeSlots(date) {
  const slots = [];
  for (let h = COURT_OPEN; h + OPENPLAY_DURATION / 60 <= COURT_CLOSE; h += OPENPLAY_DURATION / 60) {
    const occupiedByBooking = db.bookings.some(b => b.date === date && b.status !== 'Cancelled' && b.hours.includes(h));
    const session = db.openplays.find(s => s.date === date && Number(s.startHour) === h && s.status !== 'Completed');
    slots.push({ hour: h, joinedCount: session ? session.players.length : 0, disabled: occupiedByBooking || Boolean(session) });
  }
  return slots;
}
// Turns [6,7,8,10] into "6:00 AM – 9:00 AM, 10:00 AM – 11:00 AM"
function hoursText(b) {
  if (b.type === 'whole') return 'Whole day (' + hourLabel(COURT_OPEN) + ' – ' + hourLabel(COURT_CLOSE) + ')';
  const hs = [...b.hours].sort((a, c) => a - c);
  const groups = [];
  hs.forEach(h => {
    const last = groups[groups.length - 1];
    if (last && last[1] === h - 1) last[1] = h; else groups.push([h, h]);
  });
  return groups.map(g => hourLabel(g[0]) + ' – ' + hourLabel(g[1] + 1)).join(', ');
}

/* =========================================================
   DATA (the "database")
   ========================================================= */
function seed() {
  return {
    settings: { hourRate: 200, dayRate: 1500 },
    users: [
      // The one and only owner account. Change this password in your Profile.
      { id: 'owner', role: 'owner', name: 'dnkq Owner', contact: '09000000000', username: 'owner', password: 'owner123', joined: new Date().toISOString(), avatar: '' }
    ],
    bookings: [],
    openplays: [],
    orders: [],
    items: [
      { id: 'i1', name: 'Bottled Water', type: 'beverage', price: 20, stock: 50 },
      { id: 'i2', name: 'Sports Drink', type: 'beverage', price: 45, stock: 40 },
      { id: 'i3', name: 'Iced Tea', type: 'beverage', price: 35, stock: 40 },
      { id: 'i4', name: 'Cold Brew Coffee', type: 'beverage', price: 60, stock: 30 },
      { id: 'i5', name: 'Paddle', type: 'rental', price: 50, stock: 10 },
      { id: 'i6', name: 'Pickleball', type: 'rental', price: 20, stock: 20 },
      { id: 'i7', name: 'Knee Support', type: 'rental', price: 30, stock: 8 },
      { id: 'i8', name: 'Protective Eyewear', type: 'rental', price: 30, stock: 8 },
      { id: 'i9', name: 'Wristband & Headband Set', type: 'rental', price: 15, stock: 15 }
    ]
  };
}

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.users)) {
        d.settings = d.settings || { hourRate: 200, dayRate: 1500 };
        d.openplays = Array.isArray(d.openplays) ? d.openplays : [];
        d.openplays.forEach(s => {
          if (!('startHour' in s)) s.startHour = COURT_OPEN;
          delete s.format;
          s.schedule = buildOpenPlaySchedule(s.players || []);
        });
        d.users.forEach(u => { if (!('avatar' in u)) u.avatar = ''; });
        return d;
      }
    }
  } catch (e) { /* ignore and start fresh */ }
  const fresh = seed();
  try { localStorage.setItem(DB_KEY, JSON.stringify(fresh)); } catch (e) { /* storage blocked */ }
  return fresh;
}
function saveDB() {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
  catch (e) { toast('Could not save your data in this browser.', 'error'); }
}

let db = loadDB();
let me = null;            // the logged-in user
let page = 'dashboard';   // the page being shown
const state = {           // temporary screen state
  resDate: todayStr(), resMode: 'slots', selHours: [],
  cart: {}, userFilter: '', resFilter: '', openplaySessionId: '', openplayDate: todayStr()
};

/* =========================================================
   BOOKING + STATS LOGIC
   ========================================================= */
const bSort = (a, b) => (a.date + pad(a.hours[0])).localeCompare(b.date + pad(b.hours[0]));
function bEnd(b) { return new Date(b.date + 'T' + pad(Math.max(...b.hours) + 1) + ':00:00'); }
function bStatus(b) {
  if (b.status === 'Cancelled') return 'Cancelled';
  return bEnd(b) < new Date() ? 'Completed' : 'Booked';
}
function takenHours(date) {
  const set = new Set();
  db.bookings.filter(b => b.date === date && b.status !== 'Cancelled').forEach(b => b.hours.forEach(h => set.add(h)));
  return set;
}
function isPast(date, h) {
  const t = todayStr();
  return date < t || (date === t && h <= new Date().getHours());
}
function userName(id) {
  const u = db.users.find(x => x.id === id);
  return u ? u.name : 'Deleted user';
}
function userAvatar(id, size = '') {
  const u = db.users.find(x => x.id === id);
  return u && u.avatar
    ? `<img class="avatar ${size}" src="${esc(u.avatar)}" alt="${esc(u.name)}">`
    : `<span class="avatar ${size}">${esc((u ? u.name : '?').charAt(0).toUpperCase())}</span>`;
}
function openPlayPlayers(session) {
  return session.players.map(id => db.users.find(u => u.id === id)).filter(Boolean);
}
function buildOpenPlaySchedule(playerIds) {
  const groupSize = 4;
  const ids = playerIds.slice();
  const slots = [];
  for (let slot = 0; slot < Math.floor(OPENPLAY_DURATION / OPENPLAY_MATCH_MINUTES); slot++) {
    const rotation = ids.map((_, i) => ids[(i + slot * groupSize) % ids.length]);
    const players = rotation.slice(0, Math.min(groupSize, ids.length));
    if (players.length === groupSize) {
      slots.push({
        slot: slot + 1,
        minute: slot * OPENPLAY_MATCH_MINUTES,
        players,
        teams: [players.slice(0, 2), players.slice(2, 4)]
      });
    }
  }
  return slots;
}
function openPlayStats(session) {
  const stats = {};
  session.players.forEach(id => { stats[id] = { wins: 0, matches: 0 }; });
  session.results.forEach(result => {
    result.winners.forEach(id => { if (stats[id]) stats[id].wins += 1; });
    result.players.forEach(id => { if (stats[id]) stats[id].matches += 1; });
  });
  return stats;
}
function openPlayAvatar(id) {
  return userAvatar(id, 'small');
}
function userStats(userId) {
  const bk = db.bookings.filter(b => b.userId === userId && b.status !== 'Cancelled');
  const od = db.orders.filter(o => o.userId === userId && o.status !== 'Cancelled');
  let bev = 0, rent = 0;
  od.forEach(o => o.items.forEach(i => { if (i.type === 'beverage') bev += i.qty; else rent += i.qty; }));
  return {
    bookings: bk.length,
    hours: bk.reduce((a, b) => a + b.hours.length, 0),
    wholeDays: bk.filter(b => b.type === 'whole').length,
    orders: od.length, bev, rent,
    spent: bk.reduce((a, b) => a + b.price, 0) + od.reduce((a, o) => a + o.total, 0)
  };
}
// Put stock back (used when an order is cancelled or a rental is returned)
function restoreStock(order, onlyRentals) {
  order.items.forEach(line => {
    const item = db.items.find(i => i.id === line.id);
    if (item && (!onlyRentals || line.type === 'rental')) item.stock += line.qty;
  });
}

const BADGES = [
  { icon: '🎯', name: 'First Serve', desc: 'Reserve the court for the first time', goal: 1, val: s => s.bookings },
  { icon: '🔥', name: 'Regular Player', desc: 'Make 5 reservations', goal: 5, val: s => s.bookings },
  { icon: '⏱️', name: '10 Hour Club', desc: 'Reserve 10 hours of court time', goal: 10, val: s => s.hours },
  { icon: '🏆', name: 'All-Day Champ', desc: 'Rent the court for a whole day', goal: 1, val: s => s.wholeDays },
  { icon: '🥤', name: 'Hydrated', desc: 'Order 5 beverages', goal: 5, val: s => s.bev },
  { icon: '🏓', name: 'Gear Up', desc: 'Rent a piece of equipment', goal: 1, val: s => s.rent }
];

/* =========================================================
   MENUS (left side) + SEARCH KEYWORDS
   ========================================================= */
const MENUS = {
  user: [
    { id: 'dashboard', label: 'Dashboard', icon: '🏠', keys: 'home overview summary welcome' },
    { id: 'profile', label: 'Profile', icon: '👤', keys: 'account name contact password settings' },
    { id: 'reserve', label: 'Reserve court', icon: '📅', keys: 'book booking schedule time slot rent whole day court hour' },
    { id: 'openplay', label: 'OpenPlay', icon: '🏓', keys: 'open play matchmaking doubles leaderboard players session round robin' },
    { id: 'order', label: 'Order & rent', icon: '🛒', keys: 'beverage drink water coffee tea paddle ball equipment rental shop buy' },
    { id: 'records', label: 'My records', icon: '📋', keys: 'history reservations orders bookings receipts cancel' },
    { id: 'contact', label: 'Contact Us', icon: '💬', keys: 'contact support help message phone email location hours' },
  ],
  owner: [
    { id: 'dashboard', label: 'Dashboard', icon: '🏠', keys: 'home overview revenue summary today' },
    { id: 'users', label: 'Players', icon: '👥', keys: 'users members information contact accounts registered' },
    { id: 'reservations', label: 'Reservations', icon: '📅', keys: 'bookings schedule court cancel date' },
    { id: 'openplay', label: 'OpenPlay', icon: '🏓', keys: 'open play sessions leaderboard matchmaking' },
    { id: 'orders', label: 'Orders', icon: '🧾', keys: 'beverages rentals pending complete return' },
    { id: 'inventory', label: 'Inventory & rates', icon: '📦', keys: 'items stock prices paddle ball drinks equipment court rate' },
    { id: 'profile', label: 'Profile', icon: '👤', keys: 'account name password settings' }
  ]
};

/* =========================================================
   VIEWS (each returns the HTML of one page)
   ========================================================= */
const V = {};

const stat = (label, value, icon) =>
  `<div class="stat"><span class="stat-icon">${icon}</span><div><p>${label}</p><h3>${value}</h3></div></div>`;

const badge = s => `<span class="badge ${s.replace(/[^A-Za-z]/g, '')}">${s}</span>`;

/* ----- Dashboard ----- */
V.dashboard = () => (me.role === 'owner' ? ownerDashboard() : userDashboard());

function userDashboard() {
  const s = userStats(me.id);
  const next = db.bookings.filter(b => b.userId === me.id && bStatus(b) === 'Booked').sort(bSort)[0];
  const { hourRate, dayRate } = db.settings;
  const active = db.bookings.filter(b => bStatus(b) === 'Booked').slice(0, 3);
  const upcoming = db.bookings.filter(b => bStatus(b) === 'Booked').sort(bSort).slice(0, 4);
  const usage = [32, 46, 38, 68, 51, 74, 58];
  const usageBars = [48, 62, 78, 55, 88, 72, 64];
  return `
    <div class="dashboard-grid dashboard-top">
      <section class="panel dashboard-card active-bookings"><div class="section-title"><h2>Active bookings</h2><span class="live-dot"></span></div>
        ${active.length ? active.map(b => `<div class="booking-mini"><strong>${esc(hoursText(b))}</strong><small>${fmtDate(b.date)} · ${esc(userName(b.userId))}</small></div>`).join('') : '<p class="empty">No active bookings.</p>'}
        <button class="btn btn-ball btn-sm" data-action="go" data-page="records">View more</button>
      </section>
      <section class="panel dashboard-card usage-card"><div class="section-title"><h2>Court usage overview</h2><span class="select-chip">Last week⌄</span></div>
        <div class="chart-pair"><div class="area-chart">${usage.map((v, i) => `<i style="height:${v}%"></i>`).join('')}</div><div class="bar-chart">${usageBars.map(v => `<i style="height:${v}%"></i>`).join('')}</div></div>
        <div class="chart-labels"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
        <button class="btn btn-ball btn-sm" data-action="go" data-page="reserve">View details</button>
      </section>
      <section class="panel dashboard-card member-stats"><h2>Member stats</h2>
        <div class="metric-row"><small>Active members</small><strong>${db.users.filter(u => u.role === 'user').length || 0}</strong></div>
        <div class="metric-row"><small>New this week</small><strong>${db.users.filter(u => u.role === 'user').length || 0}</strong></div>
        <div class="metric-row"><small>OpenPlay players</small><strong>${db.openplays.reduce((n, o) => n + o.players.length, 0)}</strong></div>
        <button class="btn btn-ball btn-sm" data-action="go" data-page="profile">Access profile</button>
      </section>
    </div>
    <div class="grid grid-4 dashboard-stats">
      ${stat('Reservations', s.bookings, '📅')}${stat('Hours reserved', s.hours, '⏱️')}${stat('Orders', s.orders, '🛒')}${stat('Total spent', peso(s.spent), '💰')}
    </div>
    <div class="dashboard-grid dashboard-bottom">
      <section class="panel dashboard-card"><h2>Upcoming events</h2>${upcoming.length ? upcoming.map(b => `<div class="event-row"><strong>${hoursText(b)}</strong><small>${fmtDate(b.date)}</small></div>`).join('') : '<p class="empty">No upcoming events.</p>'}</section>
      <section class="panel dashboard-card"><h2>Facility status</h2><div class="status-row"><span class="status-dot online"></span><span>Single court</span><small>Available</small></div><div class="status-row"><span class="status-dot online"></span><span>OpenPlay</span><small>Live</small></div><div class="status-row"><span class="status-dot offline"></span><span>Maintenance</span><small>None</small></div></section>
      <section class="panel dashboard-card rates-card"><h2>Court hours and rates</h2><p class="hint">Open daily, ${hourLabel(COURT_OPEN)} – ${hourLabel(COURT_CLOSE)}. One court.</p><strong>${peso(hourRate)} / hour</strong><strong>${peso(dayRate)} / whole day</strong></section>
    </div>`;
}

function ownerDashboard() {
  const players = db.users.filter(u => u.role === 'user');
  const today = todayStr();
  const todays = db.bookings.filter(b => b.date === today && b.status !== 'Cancelled').sort(bSort);
  const pending = db.orders.filter(o => o.status === 'Pending').length;
  const revenue = db.bookings.filter(b => b.status !== 'Cancelled').reduce((a, b) => a + b.price, 0)
                + db.orders.filter(o => o.status !== 'Cancelled').reduce((a, o) => a + o.total, 0);
  return `
    <div class="welcome">
      <h2>Owner dashboard</h2>
      <p>You are the only account that can see every player's information.</p>
      <button class="btn btn-ball" data-action="go" data-page="users">View players</button>
      <button class="btn btn-ghost" data-action="go" data-page="orders">Check orders</button>
    </div>
    <div class="grid grid-4">
      ${stat('Registered players', players.length, '👥')}
      ${stat('Reservations today', todays.length, '📅')}
      ${stat('Pending orders', pending, '🧾')}
      ${stat('Revenue (not cancelled)', peso(revenue), '💰')}
    </div>
    <div class="panel" style="margin-top:22px">
      <h2>Today's court schedule</h2>
      <p class="hint">${fmtDate(today)}</p>
      ${todays.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>Player</th><th>Type</th></tr></thead>
        <tbody>${todays.map(b => `<tr><td>${hoursText(b)}</td><td>${esc(userName(b.userId))}</td><td>${b.type === 'whole' ? 'Whole day' : 'Hourly'}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="empty">The court is free today.</p>'}
    </div>`;
}

/* ----- Reserve court (player) ----- */
function courtMatrix(date) {
  const hours = [COURT_OPEN, COURT_OPEN + 4, COURT_OPEN + 8, COURT_OPEN + 12];
  return `<div class="court-matrix"><div class="matrix-head"><span>Court</span>${hours.map(h => `<span>${hourLabel(h)}<small>– ${hourLabel(h + 4)}</small></span>`).join('')}</div><div class="matrix-row"><strong>Pickleball Court 1<small>Single court</small></strong>${hours.map(h => {
    const booked = takenHours(date).has(h);
    return `<button type="button" class="matrix-slot ${booked ? 'booked' : 'available'}" ${booked ? 'disabled' : ''}>${booked ? 'Booked' : 'Available'}</button>`;
  }).join('')}</div></div>`;
}
V.reserve = () => {
  const d = state.resDate;
  const taken = takenHours(d);
  const { dayRate } = db.settings;
  const now = new Date(), isToday = d === todayStr();
  const wholeBlocked = taken.size > 0 || d < todayStr() || (isToday && now.getHours() >= COURT_OPEN);
  const mine = db.bookings.filter(b => b.userId === me.id && bStatus(b) === 'Booked').sort(bSort);
  return `<div class="reserve-layout"><section class="panel reserve-calendar"><div class="panel-head"><div><h2>Reserve court</h2><p class="hint">Choose a date to view the live schedule matrix.</p></div><label class="date-row">Date<input type="date" id="resDate" value="${d}" min="${todayStr()}"></label></div>${courtMatrix(d)}<p class="hint">Available slots are highlighted. Whole-day rental and OpenPlay remain the active booking options.</p></section>
    <aside class="panel booking-summary"><h2>Booking summary</h2><div class="summary-line"><small>COURT</small><strong>Pickleball Court 1</strong></div><div class="summary-line"><small>DATE</small><strong>${fmtDate(d)}</strong></div><div class="summary-line"><small>TIME</small><strong>${hourLabel(COURT_OPEN)} - ${hourLabel(COURT_CLOSE)}</strong></div><div class="summary-line"><small>PLAYER</small><strong>${esc(me.name)}</strong></div><div class="summary-line"><small>PRICE</small><strong>${peso(dayRate)}</strong></div><button class="btn btn-primary btn-block" data-action="confirmBooking" ${wholeBlocked ? 'disabled' : ''}>Confirm booking</button><button class="btn btn-ghost btn-block" data-action="go" data-page="openplay">Join OpenPlay</button></aside></div>
    <div class="panel"><h2>My upcoming reservations</h2>${mine.length ? bookingTable(mine, true) : '<p class="empty">No upcoming reservations.</p>'}</div>`;
};

function openPlayLeaderboard(session) {
  const stats = openPlayStats(session);
  return session.players.slice().sort((a, b) => (stats[b].wins - stats[a].wins) || (stats[b].matches - stats[a].matches))
    .slice(0, 10).map((id, i) => `<tr><td>${i + 1}</td><td><div class="player-cell">${openPlayAvatar(id)}<span>${esc(userName(id))}</span></div></td><td>${stats[id].wins}</td><td>${stats[id].matches}</td></tr>`).join('');
}
function openPlaySchedule(session) {
  return session.schedule.map(match => `<tr><td>Match ${match.slot}</td><td>${Math.floor(match.minute / 60)}h ${match.minute % 60}m</td><td>${match.teams.map(team => team.map(id => esc(userName(id))).join(' + ')).join(' vs ')}</td></tr>`).join('');
}
function openPlayBracket(session) {
  const previewMatch = session.schedule[0] || {
    slot: 1, minute: 0,
    teams: [session.players.slice(0, 2), session.players.slice(2, 4)]
  };
  const matches = session.schedule.length ? session.schedule : [previewMatch];
  return `<div class="bracket">${matches.map((match, index) => {
    const result = session.results[index];
    return `<div class="bracket-match">
      <div class="bracket-match-head"><strong>Match ${match.slot}</strong><small>${Math.floor(match.minute / 60)}h ${String(match.minute % 60).padStart(2, '0')}m</small></div>
      ${match.teams.map(team => {
        const winner = result && team.some(id => result.winners.includes(id));
        const displayedTeam = team.length ? team : ['waiting'];
        return `<div class="bracket-team ${winner ? 'winner' : ''}">${displayedTeam.map(id => id === 'waiting'
          ? '<span class="avatar small">?</span><span>Waiting for player</span>'
          : `${openPlayAvatar(id)}<span>${esc(userName(id))}</span>`).join('')} ${winner ? '<b>W</b>' : ''}</div>`;
      }).join('<div class="bracket-vs">vs</div>')}
    </div>`;
  }).join('')}</div>`;
}
function openPlayCreateForm() {
  const date = state.openplayDate || todayStr();
  const slots = openPlayTimeSlots(date);
  const firstAvailable = slots.find(slot => !slot.disabled);
  return `<div class="panel"><h2>Choose an OpenPlay time</h2><p class="hint">Each session lasts 4 hours on the single court. Unavailable times are disabled.</p>
    <form data-form="openplay"><div class="form-grid"><label>Session date<input id="openPlayDate" name="date" type="date" min="${todayStr()}" value="${date}" required></label>
    <fieldset class="time-table"><legend>Available start time</legend>${slots.map(slot => `<label class="${slot.disabled ? 'unavailable' : ''}"><input type="radio" name="startHour" value="${slot.hour}" ${slot.disabled ? 'disabled' : ''} ${slot === firstAvailable ? 'checked' : ''}>${hourLabel(slot.hour)}<small>${hourLabel(slot.hour + 4)} · ${slot.joinedCount}/${OPENPLAY_CAPACITY} joined${slot.disabled && !slot.joinedCount ? ' · Unavailable' : ''}</small></label>`).join('')}</fieldset>
    </div>
    <button class="btn btn-primary" type="submit">Create OpenPlay session · ${peso(db.settings.hourRate * 4)}</button></form>
    ${db.openplays.filter(s => s.date === date && s.status !== 'Completed').map(s => `<div class="session-choice">
      <span><strong>${hourLabel(Number(s.startHour))} – ${hourLabel(Number(s.startHour) + 4)}</strong><small>${s.players.length}/${OPENPLAY_CAPACITY} joined</small></span>
      <button class="btn btn-ghost btn-sm" data-action="selectOpenPlay" data-id="${s.id}">View session</button>
    </div>`).join('')}</div>`;
}
V.openplay = () => {
  const sessions = db.openplays.filter(s => s.status !== 'Completed');
  const selected = sessions.find(s => s.id === state.openplaySessionId) || sessions[0];
  if (!selected) return `<div class="panel"><h2>OpenPlay</h2><p class="hint">A fixed ${OPENPLAY_DURATION / 60}-hour, single-court block with up to ${OPENPLAY_CAPACITY} players.</p></div>${openPlayCreateForm()}`;
  const joined = selected.players.includes(me.id);
  const full = selected.players.length >= OPENPLAY_CAPACITY;
  return `${openPlayCreateForm()}<div class="panel"><div class="panel-head"><div><h2>OpenPlay · ${fmtDate(selected.date)}</h2>
    <p class="hint">Doubles · ${hourLabel(Number(selected.startHour))} – ${hourLabel(Number(selected.startHour) + 4)} · 1 court · ${selected.players.length}/${OPENPLAY_CAPACITY} players · ${peso(selected.price)} court block</p></div>
    ${joined ? `<div class="actions"><span class="badge Completed">Joined</span><button class="btn btn-danger btn-sm" data-action="leaveOpenPlay" data-id="${selected.id}">Leave timeslot</button></div>` : `<button class="btn btn-ball" data-action="joinOpenPlay" data-id="${selected.id}" ${full ? 'disabled' : ''}>${full ? 'Session full' : 'Join session'}</button>`}</div>
    <div class="grid grid-2"><div><h3>Players</h3><div class="player-list">${openPlayPlayers(selected).map(u => `<div class="player-cell">${userAvatar(u.id, 'small')}<span>${esc(u.name)}</span></div>`).join('') || '<p class="empty">No players yet.</p>'}</div>
    <h3 style="margin-top:18px">Live bracket</h3><p class="hint">The bracket preview is shown immediately and updates as players join.</p>${openPlayBracket(selected)}
    <h3 style="margin-top:18px">Rotation schedule</h3><p class="hint">Balanced 15-minute rotations with court rest distributed across the group.</p>
    <div class="table-wrap"><table><thead><tr><th>Slot</th><th>Start</th><th>Players</th></tr></thead><tbody>${openPlaySchedule(selected)}</tbody></table></div></div>
    <div><h3>Leaderboard</h3><p class="hint">Top 10 by wins in this session.</p><div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th><th>Wins</th><th>Matches</th></tr></thead><tbody>${openPlayLeaderboard(selected) || '<tr><td colspan="4" class="empty">Results will appear after matches.</td></tr>'}</tbody></table></div>
    ${me.role === 'owner' ? `<button class="btn btn-ghost" data-action="recordOpenPlayResult" data-id="${selected.id}">Record match result</button>` : ''}</div></div></div>`;
};

function bookingTable(list, withCancel, showPlayer) {
  return `<div class="table-wrap"><table>
    <thead><tr>${showPlayer ? '<th>Player</th>' : ''}<th>Date</th><th>Time</th><th>Type</th><th>Price</th><th>Status</th>${withCancel ? '<th></th>' : ''}</tr></thead>
    <tbody>${list.map(b => {
      const st = bStatus(b);
      return `<tr>${showPlayer ? `<td>${esc(userName(b.userId))}</td>` : ''}
        <td>${fmtDate(b.date)}</td><td>${hoursText(b)}</td><td>${b.type === 'whole' ? 'Whole day' : 'Hourly'}</td>
        <td>${peso(b.price)}</td><td>${badge(st)}</td>
        ${withCancel ? `<td>${st === 'Booked' ? `<button class="btn btn-danger btn-sm" data-action="cancelBooking" data-id="${b.id}">Cancel</button>` : ''}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
}

/* ----- Order & rent (player) ----- */
function cartLines() {
  return Object.entries(state.cart)
    .map(([id, qty]) => ({ item: db.items.find(i => i.id === id), qty }))
    .filter(l => l.item && l.qty > 0);
}
function itemCard(i) {
  const qty = state.cart[i.id] || 0;
  const out = i.stock <= 0;
  return `<div class="item ${out ? 'out' : ''}">
    <span class="emoji">${i.type === 'beverage' ? '🥤' : '🏓'}</span>
    <h3>${esc(i.name)}</h3>
    <span class="price">${peso(i.price)}${i.type === 'rental' ? ' per rental' : ''}</span>
    <span class="stock">${out ? 'Out of stock' : i.stock + ' available'}</span>
    <div class="qty">
      <button data-action="qty" data-id="${i.id}" data-delta="-1" ${qty ? '' : 'disabled'} aria-label="Remove one">−</button>
      <span>${qty}</span>
      <button data-action="qty" data-id="${i.id}" data-delta="1" ${qty >= i.stock ? 'disabled' : ''} aria-label="Add one">+</button>
    </div></div>`;
}
V.order = () => {
  const bev = db.items.filter(i => i.type === 'beverage');
  const rent = db.items.filter(i => i.type === 'rental');
  const lines = cartLines();
  const total = lines.reduce((a, l) => a + l.item.price * l.qty, 0);
  return `<div class="grid grid-2">
    <div>
      <div class="panel"><h2>Beverages</h2><p class="hint">Cold drinks, served at the counter.</p>
        <div class="items">${bev.map(itemCard).join('') || '<p class="empty">No beverages yet.</p>'}</div></div>
      <div class="panel"><h2>Equipment rental</h2><p class="hint">Paddles, balls and other gear. Return it at the counter after your game.</p>
        <div class="items">${rent.map(itemCard).join('') || '<p class="empty">No equipment yet.</p>'}</div></div>
    </div>
    <div>
      <div class="panel">
        <h2>Your order</h2>
        ${lines.length ? lines.map(l => `<div class="cart-line"><span>${l.qty} × ${esc(l.item.name)}</span><strong>${peso(l.item.price * l.qty)}</strong></div>`).join('')
          : '<p class="empty">Your order is empty. Add items with the + button.</p>'}
        <p style="margin:14px 0;font-family:var(--font-head);font-size:2rem">${peso(total)}</p>
        <div class="actions">
          <button class="btn btn-primary" data-action="placeOrder" ${lines.length ? '' : 'disabled'}>Place order</button>
          <button class="btn btn-ghost" data-action="clearCart" ${lines.length ? '' : 'disabled'}>Clear</button>
        </div>
      </div>
    </div></div>`;
};

/* ----- My records (player) ----- */
function orderTable(list, withPlayer, role) {
  return `<div class="table-wrap"><table>
    <thead><tr>${withPlayer ? '<th>Player</th>' : ''}<th>Placed</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(o => `<tr>${withPlayer ? `<td>${esc(userName(o.userId))}</td>` : ''}
      <td>${fmtStamp(o.created)}</td>
      <td>${o.items.map(i => i.qty + ' × ' + esc(i.name)).join(', ')}</td>
      <td>${peso(o.total)}</td><td>${badge(o.status)}</td>
      <td><div class="actions">
        ${role === 'owner' && o.status === 'Pending' ? `<button class="btn btn-primary btn-sm" data-action="completeOrder" data-id="${o.id}">Order Received</button>` : ''}
        ${role === 'user' && o.status === 'Pending' ? `<button class="btn btn-primary btn-sm" data-action="completeOwnOrder" data-id="${o.id}">Order Completed</button>` : ''}
        ${o.status === 'Pending' ? `<button class="btn btn-danger btn-sm" data-action="cancelOrder" data-id="${o.id}">Cancel</button>` : ''}
      </div></td></tr>`).join('')}</tbody></table></div>`;
}
V.records = () => {
  const s = userStats(me.id);
  const bk = db.bookings.filter(b => b.userId === me.id).sort((a, b) => bSort(b, a));
  const od = db.orders.filter(o => o.userId === me.id).sort((a, b) => b.created.localeCompare(a.created));
  return `
    <div class="grid grid-4" style="margin-bottom:22px">
      ${stat('Reservations', s.bookings, '📅')}${stat('Hours reserved', s.hours, '⏱️')}
      ${stat('Items ordered', s.bev + s.rent, '🛒')}${stat('Total spent', peso(s.spent), '💰')}
    </div>
    <div class="panel"><h2>Reservation history</h2>
      ${bk.length ? bookingTable(bk, true) : '<p class="empty">No reservations yet.</p>'}</div>
    <div class="panel"><h2>Order history</h2>
      ${od.length ? orderTable(od, false, 'user') : '<p class="empty">No orders yet.</p>'}</div>`;
};

/* ----- Contact Us ----- */
V.contact = () => `
  <section class="panel contact-hero">
    <p class="eyebrow">We are here to help</p>
    <h2>Contact Us</h2>
    <p class="hint">Have a question about reservations, OpenPlay, orders, or rentals? Reach out and our team will be happy to help.</p>
  </section>
  <div class="grid grid-3 contact-grid">
    <section class="panel contact-card">
      <span class="contact-icon">📞</span>
      <h3>Call us</h3>
      <p class="hint">For quick questions and booking assistance.</p>
      <a href="tel:+639000000000">+63 900 000 0000</a>
    </section>
    <section class="panel contact-card">
      <span class="contact-icon">✉️</span>
      <h3>Email us</h3>
      <p class="hint">Send us your questions anytime.</p>
      <a href="mailto:hello@dnkq.ph">hello@dnkq.ph</a>
    </section>
    <section class="panel contact-card">
      <span class="contact-icon">📍</span>
      <h3>Visit us</h3>
      <p class="hint">Drop by the court during operating hours.</p>
      <strong>Open daily, 6:00 AM – 10:00 PM</strong>
    </section>
  </div>
  <section class="panel contact-message">
    <h2>Need assistance?</h2>
    <p class="hint">Include your username and reservation details when contacting us so we can assist you faster.</p>
    <div class="actions">
      <a class="btn btn-primary" href="mailto:hello@dnkq.ph?subject=dnkq%20support%20request">Send us a message</a>
      <a class="btn btn-ghost" href="tel:+639000000000">Call support</a>
    </div>
  </section>`;

/* ----- Achievements (player) ----- */
V.achievements = () => {
  const s = userStats(me.id);
  const done = BADGES.filter(b => b.val(s) >= b.goal).length;
  return `<div class="panel"><h2>Your achievements</h2>
      <p class="hint">${done} of ${BADGES.length} unlocked. They update as you reserve, order and rent.</p>
      <div class="badges">${BADGES.map(b => {
        const v = Math.min(b.val(s), b.goal), ok = v >= b.goal;
        return `<div class="achv ${ok ? '' : 'locked'}">
          <div class="medal">${b.icon}</div><h3>${b.name}</h3><p>${b.desc}</p>
          <div class="bar"><i style="width:${(v / b.goal) * 100}%"></i></div><small>${v} / ${b.goal}${ok ? ' · Unlocked' : ''}</small></div>`;
      }).join('')}</div></div>`;
};

/* ----- Profile (player and owner) ----- */
V.profile = () => {
  const s = me.role === 'owner' ? null : userStats(me.id);
  return `<div class="profile-layout"><section class="panel identity-card"><h2>User avatar card</h2>${userAvatar(me.id, 'profile-avatar')}
    <h1>${esc(me.name)}</h1><p class="hint">${me.role === 'owner' ? 'Owner' : 'Player'} · @${esc(me.username)}</p>
    <div class="identity-badges"><div><small>Membership status</small><strong>ELITE MEMBER</strong></div><div><small>Player rank</small><strong>P-4 · Rank 4</strong></div></div>
  </section><div class="profile-right"><section class="panel"><h2>Personal stats</h2>${s ? `<div class="profile-metric"><span>▦ Courts booked</span><strong>${s.bookings}</strong></div><div class="profile-metric"><span>◷ Game hours</span><strong>${s.hours}</strong></div><div class="profile-metric"><span>⌁ Games played</span><strong>${s.bookings}</strong></div><div class="profile-metric"><span>⌖ Favorite court</span><strong>Single court</strong></div>` : '<p class="empty">Owner profile</p>'}</section>
  <section class="panel preference-card"><h2>Preference settings</h2><div class="profile-metric"><span>Booking reminders</span><b class="toggle on"></b></div><div class="profile-metric"><span>Notification tone</span><strong>Quiet</strong></div><div class="profile-metric"><span>Favorite sport</span><strong>Pickleball</strong></div><div class="profile-metric"><span>Session updates</span><b class="toggle on"></b></div></section>
  <section class="panel profile-form-card"><h2>Profile preferences</h2><form data-form="profile">
    <div class="profile-head">${userAvatar(me.id, 'small')}<div><p class="hint">${me.role === 'owner' ? 'Owner' : 'Player'} · joined ${fmtDate(me.joined.slice(0, 10))}</p></div></div>
      <label>Profile picture<input id="avatarInput" type="file" accept="image/png,image/jpeg,image/webp"><small class="hint">Choose a JPG, PNG, or WebP image.</small></label>
      <div class="form-grid">
        <label>Full name<input name="name" value="${esc(me.name)}" required></label>
        <label>Contact number<input name="contact" value="${esc(me.contact)}" required></label>
        <label>Username<input value="${esc(me.username)}" disabled></label>
        <label>New password (leave empty to keep)<input name="password" type="password" minlength="4"></label>
      </div>
      <p class="form-error" id="profileError"></p>
      <button class="btn btn-primary" type="submit">Save changes</button>
    </form></section></div></div>
    ${s ? `<div class="panel profile-rewards"><h2>Recent activity / rewards</h2><div class="reward-grid"><span>Last game <strong>${s.bookings ? 'Recently' : '—'}</strong></span><span>Rewards points <strong>${s.bookings * 50}</strong></span><span>Next perk <strong>500 milestones</strong></span><span>Reward <strong>Free court hour</strong></span></div><h3>Achievements</h3><div class="badges">${BADGES.map(b => {
      const v = Math.min(b.val(s), b.goal), ok = v >= b.goal;
      return `<div class="achv ${ok ? '' : 'locked'}"><div class="medal">${b.icon}</div><h3>${b.name}</h3><p>${b.desc}</p><div class="bar"><i style="width:${(v / b.goal) * 100}%"></i></div><small>${v} / ${b.goal}${ok ? ' · Unlocked' : ''}</small></div>`;
    }).join('')}</div></div>` : ''}`;
};

/* ----- Owner: players ----- */
function usersRows() {
  const q = state.userFilter.trim().toLowerCase();
  const list = db.users.filter(u => u.role === 'user' && (!q || (u.name + ' ' + u.username + ' ' + u.contact).toLowerCase().includes(q)));
  if (!list.length) return '<tr><td colspan="8" class="empty">No players found.</td></tr>';
  return list.map(u => {
    const s = userStats(u.id);
    return `<tr><td><strong>${esc(u.name)}</strong></td><td>@${esc(u.username)}</td><td>${esc(u.contact)}</td>
      <td>${fmtDate(u.joined.slice(0, 10))}</td><td>${s.bookings}</td><td>${s.orders}</td><td>${peso(s.spent)}</td>
      <td><div class="actions">
        <button class="btn btn-ghost btn-sm" data-action="viewUser" data-id="${u.id}">View</button>
        <button class="btn btn-danger btn-sm" data-action="deleteUser" data-id="${u.id}">Delete</button>
      </div></td></tr>`;
  }).join('');
}
V.users = () => `<div class="panel">
  <div class="panel-head">
    <div><h2>Registered players</h2><p class="hint">Only the owner can see this information.</p></div>
    <input id="userFilter" placeholder="Filter by name, username or contact" value="${esc(state.userFilter)}" style="min-width:260px;margin:0">
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Username</th><th>Contact</th><th>Joined</th><th>Reservations</th><th>Orders</th><th>Spent</th><th></th></tr></thead>
    <tbody id="usersBody">${usersRows()}</tbody></table></div></div>`;

/* ----- Owner: reservations ----- */
V.reservations = () => {
  let list = db.bookings.slice().sort((a, b) => bSort(b, a));
  if (state.resFilter) list = list.filter(b => b.date === state.resFilter);
  return `<div class="panel">
    <div class="panel-head">
      <div><h2>All reservations</h2><p class="hint">One court. Newest dates first.</p></div>
      <div class="actions" style="align-items:flex-end">
        <label style="margin:0">Filter by date<input type="date" id="resFilter" value="${state.resFilter}" style="margin-top:5px"></label>
        <button class="btn btn-ghost" data-action="clearResFilter">Show all</button>
      </div>
    </div>
    ${list.length ? bookingTable(list, true, true) : '<p class="empty">No reservations found.</p>'}</div>`;
};

/* ----- Owner: orders ----- */
V.orders = () => {
  const list = db.orders.slice().sort((a, b) => b.created.localeCompare(a.created));
  return `<div class="panel"><h2>All orders</h2>
    <p class="hint">Marking an order as done returns any rented equipment to stock.</p>
    ${list.length ? orderTable(list, true, 'owner') : '<p class="empty">No orders yet.</p>'}</div>`;
};

/* ----- Owner: inventory + rates ----- */
V.inventory = () => {
  const { hourRate, dayRate } = db.settings;
  return `<div class="panel"><h2>Court rates</h2><p class="hint">New rates apply to new reservations only.</p>
      <form data-form="rates"><div class="form-grid">
        <label>Price per hour (₱)<input name="hourRate" type="number" min="0" value="${hourRate}" required></label>
        <label>Whole-day price (₱)<input name="dayRate" type="number" min="0" value="${dayRate}" required></label>
      </div><button class="btn btn-primary" type="submit">Save rates</button></form></div>
    <div class="panel">
      <div class="panel-head"><div><h2>Items</h2><p class="hint">Beverages are sold. Rentals are returned to stock when the order is done.</p></div>
        <button class="btn btn-ball" data-action="newItem">Add item</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Item</th><th>Type</th><th>Price</th><th>Stock</th><th></th></tr></thead>
        <tbody>${db.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.type === 'beverage' ? 'Beverage (sold)' : 'Equipment (rented)'}</td>
          <td>${peso(i.price)}</td><td>${i.stock}</td>
          <td><div class="actions"><button class="btn btn-ghost btn-sm" data-action="editItem" data-id="${i.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-action="deleteItem" data-id="${i.id}">Delete</button></div></td></tr>`).join('')}</tbody>
      </table></div></div>`;
};

/* =========================================================
   RENDERING
   ========================================================= */
function render() {
  const list = MENUS[me.role];
  if (!list.some(m => m.id === page)) page = 'dashboard';
  const cur = list.find(m => m.id === page);
  $('#menu').innerHTML = list.map(m =>
    `<button class="menu-item ${m.id === page ? 'active' : ''}" data-action="go" data-page="${m.id}"><span class="menu-icon">${m.icon}</span><span>${m.label}</span></button>`).join('');
  $('#pageTitle').textContent = cur.label;
  $('#userChip').innerHTML = `${userAvatar(me.id)}<div>${esc(me.name)}<small>${me.role === 'owner' ? 'Owner' : 'Player'}</small></div>`;
  $('#view').innerHTML = V[page]();
}
function go(id) {
  page = id;
  closeSidebar();
  hideSearch();
  render();
  window.scrollTo(0, 0);
}
function showApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  page = 'dashboard';
  render();
}
function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}
function openSidebar() { $('#sidebar').classList.add('open'); $('#overlay').classList.add('show'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#overlay').classList.remove('show'); }

/* ---------- Toast + modal ---------- */
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type + (String(msg).startsWith('dnkq!') ? ' dnkq' : '');
  t.textContent = msg;
  $('#toastRoot').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function openModal(html) {
  $('#modalRoot').innerHTML = `<div class="modal-back" data-action="modalBg"><div class="modal">${html}</div></div>`;
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

/* =========================================================
   SEARCH (upper right) — finds parts of the system
   ========================================================= */
let searchHits = [];
function runSearch(q) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const box = $('#searchResults');
  if (!words.length) { hideSearch(); return; }
  searchHits = [];
  MENUS[me.role].forEach(m => {
    const hay = (m.label + ' ' + m.keys).toLowerCase();
    if (words.every(w => hay.includes(w))) searchHits.push({ kind: 'page', id: m.id, label: m.label, icon: m.icon, note: 'Page' });
  });
  if (me.role === 'owner') {
    db.users.filter(u => u.role === 'user' && words.every(w => (u.name + ' ' + u.username).toLowerCase().includes(w)))
      .slice(0, 4).forEach(u => searchHits.push({ kind: 'user', id: u.id, label: u.name, icon: '👤', note: 'Player' }));
  }
  db.openplays.filter(s => words.every(w => (`openplay doubles ${s.date} ${s.players.map(userName).join(' ')}`).toLowerCase().includes(w)))
    .slice(0, 4).forEach(s => searchHits.push({ kind: 'openplay', id: s.id, label: `OpenPlay · ${s.date}`, icon: '🏓', note: 'Session' }));
  db.orders.filter(o => words.every(w => (`order ${o.status} ${o.items.map(i => i.name).join(' ')}`).toLowerCase().includes(w)))
    .slice(0, 4).forEach(o => searchHits.push({ kind: 'order', id: o.id, label: `Order · ${o.status}`, icon: '🧾', note: 'Record' }));
  box.innerHTML = searchHits.length
    ? searchHits.map((h, i) => `<button class="search-item" data-action="searchGo" data-idx="${i}"><span>${h.icon}</span><span>${esc(h.label)}</span><small>${h.note}</small></button>`).join('')
    : '<p class="search-empty">Nothing found. Try “reserve”, “orders” or “profile”.</p>';
  box.classList.remove('hidden');
}
function hideSearch() { $('#searchResults').classList.add('hidden'); }
function openHit(h) {
  $('#search').value = '';
  if (h.kind === 'user') { state.userFilter = db.users.find(u => u.id === h.id).username; go('users'); }
  else if (h.kind === 'openplay') { state.openplaySessionId = h.id; go('openplay'); }
  else if (h.kind === 'order') go('records');
  else go(h.id);
}

/* =========================================================
   ACTIONS
   ========================================================= */
function joinOpenPlay(id) {
  const session = db.openplays.find(s => s.id === id);
  if (!session || session.status === 'Completed' || session.players.includes(me.id)) return;
  if (session.players.length >= OPENPLAY_CAPACITY) { toast('This OpenPlay session is full.', 'error'); return; }
  session.players.push(me.id);
  session.schedule = buildOpenPlaySchedule(session.players);
  saveDB(); toast('dnkq! You joined OpenPlay.'); render();
}
function leaveOpenPlay(id) {
  const session = db.openplays.find(s => s.id === id);
  if (!session || !session.players.includes(me.id)) return;
  if (!confirm('Leave this OpenPlay timeslot?')) return;
  session.players = session.players.filter(playerId => playerId !== me.id);
  session.results = session.results.filter(result => !result.players.includes(me.id));
  session.schedule = buildOpenPlaySchedule(session.players);
  saveDB();
  toast('You left the OpenPlay timeslot. Choose another time.');
  render();
}
function recordOpenPlayResult(id) {
  const session = db.openplays.find(s => s.id === id);
  if (!session || session.players.length < 4) return;
  const match = session.schedule[session.results.length % session.schedule.length];
  if (!match) return;
  const winners = match.teams[0];
  session.results.push({ players: match.players, winners });
  saveDB(); toast('Match result recorded.'); render();
}
function createOpenPlay(form) {
  const f = Object.fromEntries(new FormData(form).entries());
  const date = f.date;
  const startHour = Number(f.startHour);
  if (!date || date < todayStr()) { toast('Choose a future session date.', 'error'); return; }
  if (!Number.isInteger(startHour) || startHour < COURT_OPEN || startHour + OPENPLAY_DURATION / 60 > COURT_CLOSE) { toast('Choose an available four-hour time slot.', 'error'); return; }
  const slot = openPlayTimeSlots(date).find(s => s.hour === startHour);
  if (!slot || slot.disabled) { toast('That OpenPlay time is no longer available.', 'error'); return; }
  const session = { id: uid('op'), date, startHour, players: [me.id], results: [], status: 'Open', price: db.settings.hourRate * 4, schedule: [] };
  session.schedule = buildOpenPlaySchedule(session.players);
  db.openplays.push(session); state.openplaySessionId = session.id; saveDB(); toast('dnkq! OpenPlay session created.'); render();
}
function confirmBooking() {
  const date = state.resDate;
  const taken = takenHours(date);
  const { dayRate } = db.settings;
  const now = new Date();
  if (taken.size || date < todayStr() || (date === todayStr() && now.getHours() >= COURT_OPEN)) { toast('The whole day is not available on this date.', 'error'); return; }
  const hours = [];
  for (let h = COURT_OPEN; h < COURT_CLOSE; h++) hours.push(h);
  const type = 'whole';
  const price = dayRate;
  db.bookings.push({ id: uid('b'), userId: me.id, date, type, hours, price, status: 'Booked', created: new Date().toISOString() });
  saveDB();
  state.selHours = [];
  toast('dnkq! Court reserved for ' + fmtDate(date) + '.');
  render();
}

function cancelBooking(id) {
  const b = db.bookings.find(x => x.id === id);
  if (!b || (me.role !== 'owner' && b.userId !== me.id) || bStatus(b) !== 'Booked') return;
  if (!confirm('Cancel this reservation?')) return;
  b.status = 'Cancelled';
  saveDB(); toast('Reservation cancelled.'); render();
}

function placeOrder() {
  const lines = cartLines();
  if (!lines.length) return;
  if (lines.some(l => l.qty > l.item.stock)) { toast('Not enough stock for one of the items.', 'error'); return; }
  const items = lines.map(l => ({ id: l.item.id, name: l.item.name, type: l.item.type, price: l.item.price, qty: l.qty }));
  lines.forEach(l => { l.item.stock -= l.qty; });
  db.orders.push({ id: uid('o'), userId: me.id, items, total: items.reduce((a, i) => a + i.price * i.qty, 0), status: 'Pending', created: new Date().toISOString() });
  saveDB();
  state.cart = {};
  toast('dnkq! Order placed. Pick it up at the counter.');
  render();
}

function cancelOrder(id) {
  const o = db.orders.find(x => x.id === id);
  if (!o || o.status !== 'Pending' || (me.role !== 'owner' && o.userId !== me.id)) return;
  if (!confirm('Cancel this order?')) return;
  restoreStock(o, false);
  o.status = 'Cancelled';
  saveDB(); toast('Order cancelled.'); render();
}
function completeOrder(id) {
  const o = db.orders.find(x => x.id === id);
  if (!o || me.role !== 'owner' || o.status !== 'Pending') return;
  restoreStock(o, true); // rented items come back to stock
  o.status = 'Received / Completed';
  saveDB(); toast('dnkq! Order received and completed.'); render();
}
function completeOwnOrder(id) {
  const o = db.orders.find(x => x.id === id);
  if (!o || me.role !== 'user' || o.userId !== me.id || o.status !== 'Pending') return;
  if (!confirm('Mark this order as completed?')) return;
  restoreStock(o, true);
  o.status = 'Received / Completed';
  saveDB(); toast('dnkq! Order completed.'); render();
}

function viewUser(id) {
  const u = db.users.find(x => x.id === id);
  if (!u) return;
  const s = userStats(u.id);
  const bk = db.bookings.filter(b => b.userId === u.id).sort((a, b) => bSort(b, a));
  const od = db.orders.filter(o => o.userId === u.id).sort((a, b) => b.created.localeCompare(a.created));
  openModal(`<h2>${esc(u.name)}</h2>
    <p class="hint">@${esc(u.username)} · ${esc(u.contact)} · joined ${fmtDate(u.joined.slice(0, 10))}</p>
    <div class="grid grid-4" style="margin-bottom:14px">${stat('Reservations', s.bookings, '📅')}${stat('Hours', s.hours, '⏱️')}${stat('Orders', s.orders, '🛒')}${stat('Spent', peso(s.spent), '💰')}</div>
    <h3 style="margin:10px 0 6px">Reservations</h3>${bk.length ? bookingTable(bk, false) : '<p class="empty">None</p>'}
    <h3 style="margin:10px 0 6px">Orders</h3>${od.length ? orderTable(od, false, 'view') .replace(/<th><\/th>/, '').replace(/<td><div class="actions">[\s\S]*?<\/div><\/td>/g, '') : '<p class="empty">None</p>'}
    <div class="modal-actions"><button class="btn btn-primary" data-action="closeModal">Close</button></div>`);
}
function deleteUser(id) {
  const u = db.users.find(x => x.id === id);
  if (!u || u.role === 'owner') return;
  if (!confirm('Delete ' + u.name + ' and all of their reservations and orders?')) return;
  db.orders.filter(o => o.userId === id && o.status === 'Pending').forEach(o => restoreStock(o, false));
  db.bookings = db.bookings.filter(b => b.userId !== id);
  db.orders = db.orders.filter(o => o.userId !== id);
  db.users = db.users.filter(x => x.id !== id);
  saveDB(); toast('Player deleted.'); render();
}

function itemModal(item) {
  const i = item || { id: '', name: '', type: 'beverage', price: 0, stock: 0 };
  openModal(`<h2>${item ? 'Edit item' : 'Add item'}</h2>
    <form data-form="item">
      <input type="hidden" name="id" value="${i.id}">
      <label>Name<input name="name" value="${esc(i.name)}" required></label>
      <label>Type<select name="type">
        <option value="beverage" ${i.type === 'beverage' ? 'selected' : ''}>Beverage (sold)</option>
        <option value="rental" ${i.type === 'rental' ? 'selected' : ''}>Equipment (rented)</option></select></label>
      <div class="form-grid">
        <label>Price (₱)<input name="price" type="number" min="0" value="${i.price}" required></label>
        <label>Stock<input name="stock" type="number" min="0" value="${i.stock}" required></label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-action="closeModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Save item</button>
      </div></form>`);
}

function handleAction(el, e) {
  const d = el.dataset;
  switch (d.action) {
    case 'authTab':
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === el));
      $('#loginForm').classList.toggle('hidden', d.tab !== 'login');
      $('#registerForm').classList.toggle('hidden', d.tab !== 'register');
      break;
    case 'logout': localStorage.removeItem(SESSION_KEY); me = null; state.cart = {}; state.selHours = []; closeSidebar(); showAuth(); break;
    case 'openSidebar': openSidebar(); break;
    case 'closeSidebar': closeSidebar(); break;
    case 'go': go(d.page); break;
    case 'searchGo': openHit(searchHits[Number(d.idx)]); break;
    case 'setMode': state.resMode = d.mode; state.selHours = []; render(); break;
    case 'toggleSlot': {
      const h = Number(d.hour);
      state.selHours = state.selHours.includes(h) ? state.selHours.filter(x => x !== h) : [...state.selHours, h].sort((a, b) => a - b);
      render(); break;
    }
    case 'confirmBooking': confirmBooking(); break;
    case 'cancelBooking': cancelBooking(d.id); break;
    case 'qty': {
      const item = db.items.find(i => i.id === d.id);
      const next = (state.cart[d.id] || 0) + Number(d.delta);
      if (item && next >= 0 && next <= item.stock) state.cart[d.id] = next;
      render(); break;
    }
    case 'clearCart': state.cart = {}; render(); break;
    case 'placeOrder': placeOrder(); break;
    case 'cancelOrder': cancelOrder(d.id); break;
    case 'completeOrder': completeOrder(d.id); break;
    case 'completeOwnOrder': completeOwnOrder(d.id); break;
    case 'joinOpenPlay': joinOpenPlay(d.id); break;
    case 'leaveOpenPlay': leaveOpenPlay(d.id); break;
    case 'selectOpenPlay': state.openplaySessionId = d.id; go('openplay'); break;
    case 'recordOpenPlayResult': recordOpenPlayResult(d.id); break;
    case 'viewUser': viewUser(d.id); break;
    case 'deleteUser': deleteUser(d.id); break;
    case 'clearResFilter': state.resFilter = ''; render(); break;
    case 'newItem': itemModal(null); break;
    case 'editItem': itemModal(db.items.find(i => i.id === d.id)); break;
    case 'deleteItem':
      if (confirm('Delete this item?')) { db.items = db.items.filter(i => i.id !== d.id); saveDB(); toast('Item deleted.'); render(); }
      break;
    case 'closeModal': closeModal(); break;
    case 'modalBg': if (e.target === el) closeModal(); break;
  }
}

/* =========================================================
   FORMS
   ========================================================= */
function handleForm(form) {
  const f = Object.fromEntries(new FormData(form).entries());
  switch (form.dataset.form) {
    case 'login': {
      const u = db.users.find(x => x.username.toLowerCase() === f.username.trim().toLowerCase() && x.password === f.password);
      if (!u) { $('#loginError').textContent = 'Wrong username or password.'; return; }
      $('#loginError').textContent = '';
      me = u; localStorage.setItem(SESSION_KEY, u.id); form.reset(); showApp();
      break;
    }
    case 'register': {
      const err = $('#registerError');
      const username = f.username.trim();
      if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) { err.textContent = 'Username: 3–20 letters, numbers, dot or underscore.'; return; }
      if (db.users.some(x => x.username.toLowerCase() === username.toLowerCase())) { err.textContent = 'That username is already taken.'; return; }
      if (!/^[0-9+\-\s]{7,15}$/.test(f.contact.trim())) { err.textContent = 'Enter a valid contact number.'; return; }
      err.textContent = '';
      const u = { id: uid('u'), role: 'user', name: f.name.trim(), contact: f.contact.trim(), username, password: f.password, joined: new Date().toISOString() };
      db.users.push(u); saveDB();
      me = u; localStorage.setItem(SESSION_KEY, u.id); form.reset(); showApp();
      toast('Welcome to dnkq, ' + u.name.split(' ')[0] + '!');
      break;
    }
    case 'profile': {
      if (f.password && f.password.length < 4) { $('#profileError').textContent = 'Password needs at least 4 characters.'; return; }
      me.name = f.name.trim(); me.contact = f.contact.trim();
      if (f.password) me.password = f.password;
      saveDB(); toast('dnkq! Profile saved.'); render();
      break;
    }
    case 'openplay': createOpenPlay(form); break;
    case 'rates':
      db.settings.hourRate = Number(f.hourRate); db.settings.dayRate = Number(f.dayRate);
      saveDB(); toast('Court rates saved.'); render();
      break;
    case 'item': {
      const data = { name: f.name.trim(), type: f.type, price: Number(f.price), stock: Number(f.stock) };
      if (f.id) Object.assign(db.items.find(i => i.id === f.id), data);
      else db.items.push({ id: uid('i'), ...data });
      saveDB(); closeModal(); toast('Item saved.'); render();
      break;
    }
  }
}

/* =========================================================
   EVENT LISTENERS (one set for the whole page) hehe
   ========================================================= */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) { handleAction(el, e); return; }
  if (!e.target.closest('.search-wrap')) hideSearch();
});
document.addEventListener('submit', e => {
  const form = e.target.closest('[data-form]');
  if (form) { e.preventDefault(); handleForm(form); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'resDate') {
    state.resDate = e.target.value && e.target.value >= todayStr() ? e.target.value : todayStr();
    state.selHours = []; render();
  }
  if (e.target.id === 'resFilter') { state.resFilter = e.target.value; render(); }
  if (e.target.id === 'openPlayDate') { state.openplayDate = e.target.value || todayStr(); render(); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'search') runSearch(e.target.value);
  if (e.target.id === 'userFilter') { state.userFilter = e.target.value; $('#usersBody').innerHTML = usersRows(); }
});
document.addEventListener('change', e => {
  if (e.target.id !== 'avatarInput' || !e.target.files[0]) return;
  const file = e.target.files[0];
  if (!file.type.startsWith('image/')) { toast('Choose an image file.', 'error'); return; }
  if (file.size > 2 * 1024 * 1024) { toast('Profile pictures must be 2 MB or smaller.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = () => { me.avatar = reader.result; saveDB(); toast('dnkq! Profile picture updated.'); render(); };
  reader.onerror = () => toast('Could not read that image.', 'error');
  reader.readAsDataURL(file);
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'search') {
    if (e.key === 'Enter' && searchHits.length) { e.preventDefault(); openHit(searchHits[0]); }
    if (e.key === 'Escape') { hideSearch(); e.target.blur(); }
  }
  if (e.key === 'Escape') closeModal();
});

/* =========================================================
   START
   ========================================================= */
(function init() {
  const savedId = localStorage.getItem(SESSION_KEY);
  const u = savedId && db.users.find(x => x.id === savedId);
  if (u) { me = u; showApp(); } else { showAuth(); }
})();
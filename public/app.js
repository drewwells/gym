// Multi-gym calendar with two views: "Classes" (the schedule) and "Open Floor"
// (when a dance-suitable studio room is free). Gym list + per-gym config come
// from /api/gyms; the server owns the open-floor gap math (/api/availability).

// After this local hour, default the initial view to tomorrow (today's classes
// are mostly over). The "Today" button still jumps to today literally.
const ROLLOVER_HOUR = 21;

const els = {
  gymSelect: document.getElementById('gymSelect'),
  modeBtns: [...document.querySelectorAll('.mode-btn')],
  dateHeader: document.getElementById('dateHeader'),
  eventList: document.getElementById('eventList'),
  loading: document.getElementById('loadingIndicator'),
  error: document.getElementById('errorIndicator'),
  modeHint: document.getElementById('modeHint'),
  prev: document.getElementById('prevDayBtn'),
  today: document.getElementById('todayBtn'),
  next: document.getElementById('nextDayBtn'),
  refresh: document.getElementById('refreshBtn'),
  share: document.getElementById('shareBtn'),
  sourceLink: document.getElementById('sourceLink'),
  footerLink: document.getElementById('footerLink'),
};

const gyms = new Map(); // id -> public gym config
const weekCache = new Map(); // `${gymId}:${weekStart}` -> events payload
let currentGymId = null;
let currentMode = 'classes';
let currentDate = null;
let defaultGymId = null; // first live gym; fallback for unknown deep links

init();

async function init() {
  els.prev.addEventListener('click', () => shiftDay(-1));
  els.next.addEventListener('click', () => shiftDay(1));
  els.today.addEventListener('click', () => { currentDate = todayInTz(gymTz()); render(); });
  els.refresh.addEventListener('click', () => render({ refresh: true }));
  els.gymSelect.addEventListener('change', () => {
    currentGymId = els.gymSelect.value;
    currentDate = defaultViewDate(gymTz());
    syncSourceLinks();
    pushUrl();
    render();
  });
  els.modeBtns.forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  els.share.addEventListener('click', copyLink);
  window.addEventListener('popstate', () => { applyState(parseUrl()); render(); });

  try {
    const res = await fetch('/api/gyms');
    const data = await res.json();
    for (const g of data.gyms) gyms.set(g.id, g);
    populatePicker(data.gyms);
  } catch (err) {
    showError(`Could not load gyms: ${err.message}`);
    return;
  }

  const firstLive = [...gyms.values()].find((g) => g.status === 'live') || [...gyms.values()][0];
  defaultGymId = firstLive.id;

  applyState(parseUrl());
  // Normalize the address bar to the canonical deep link for this gym/view.
  history.replaceState({}, '', canonicalUrl());
  render();
}

// Read gym + view from the URL. Deep link shape: /<gymId> with an optional
// ?view=open-floor (and ?gym= / ?date= still accepted as fallbacks).
function parseUrl() {
  const params = new URLSearchParams(location.search);
  let id = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));
  if (!id || !gyms.has(id)) id = params.get('gym') || '';
  const view = params.get('view') === 'open-floor' ? 'open-floor' : 'classes';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : null;
  return { id, view, date };
}

// Apply a parsed URL state to the app (gym, mode, date) without touching
// history. Unknown gyms fall back to the default.
function applyState({ id, view, date }) {
  currentGymId = id && gyms.has(id) ? id : defaultGymId;
  currentMode = view;
  els.modeBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.mode === currentMode));
  els.gymSelect.value = currentGymId;
  currentDate = date || defaultViewDate(gymTz());
  syncSourceLinks();
}

// The shareable URL for the current gym + view. Date is intentionally left
// out so a shared link always resolves to "today" for the recipient.
function canonicalUrl() {
  const q = currentMode === 'open-floor' ? '?view=open-floor' : '';
  return `/${encodeURIComponent(currentGymId)}${q}`;
}

function pushUrl() {
  history.pushState({}, '', canonicalUrl());
}

async function copyLink() {
  const url = location.origin + canonicalUrl();
  try {
    await navigator.clipboard.writeText(url);
    flashShare('Copied!');
  } catch {
    // Clipboard API can be blocked (e.g. non-HTTPS); fall back to a prompt.
    window.prompt('Copy this link:', url);
  }
}

function flashShare(text) {
  const original = els.share.textContent;
  els.share.textContent = text;
  els.share.disabled = true;
  setTimeout(() => { els.share.textContent = original; els.share.disabled = false; }, 1400);
}

function populatePicker(list) {
  els.gymSelect.innerHTML = '';
  for (const g of list) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.status === 'coming-soon' ? `${g.name} (coming soon)` : g.name;
    opt.disabled = g.status === 'coming-soon';
    els.gymSelect.appendChild(opt);
  }
}

function gym() { return gyms.get(currentGymId); }
function gymTz() { return gym()?.tz || 'America/Chicago'; }

function syncSourceLinks() {
  const url = gym()?.sourceUrl || '#';
  els.sourceLink.href = url;
  els.footerLink.href = url;
  els.footerLink.textContent = new URL(url).hostname.replace(/^www\./, '');
}

function setMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  els.modeBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
  pushUrl();
  render();
}

// ---- date helpers (per-gym timezone) ----

function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function hourInTz(tz) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit',
  }).format(new Date())) % 24;
}

function defaultViewDate(tz) {
  const today = todayInTz(tz);
  if (hourInTz(tz) < ROLLOVER_HOUR) return today;
  return addDays(today, 1);
}

function addDays(yyyy_mm_dd, delta) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function shiftDay(delta) {
  currentDate = addDays(currentDate, delta);
  render();
}

function formatDayHeader(yyyy_mm_dd) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(dt);
}

function formatTime(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: gymTz(), hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

function formatHHMM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const dt = new Date(Date.UTC(2000, 0, 1, h, m));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(dt);
}

function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
}

function humanDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// ---- rendering ----

function showError(msg) {
  els.loading.hidden = true;
  els.error.hidden = false;
  els.error.textContent = msg;
}

async function render({ refresh = false } = {}) {
  els.dateHeader.textContent = formatDayHeader(currentDate);
  els.error.hidden = true;
  els.error.textContent = '';

  const g = gym();
  if (g && g.status === 'coming-soon') {
    els.modeHint.hidden = true;
    renderNotice(`${g.name} hasn't opened yet — schedule coming soon.`);
    return;
  }

  if (currentMode === 'open-floor') return renderOpenFloor({ refresh });
  return renderClasses({ refresh });
}

async function renderClasses({ refresh }) {
  const g = gym();
  els.modeHint.hidden = false;
  els.modeHint.textContent = `All classes at ${g.name} for this day.`;

  let payload = !refresh ? findCachedWeek(currentDate) : null;
  if (!payload) {
    els.loading.hidden = false;
    els.eventList.innerHTML = '';
    try {
      payload = await fetchWeek(currentDate, refresh);
    } catch (err) {
      return showError(`Could not load classes: ${err.message}`);
    }
    els.loading.hidden = true;
  }

  const dayEvents = (payload.events || []).filter((e) => e.occurrenceDate === currentDate);
  if (dayEvents.length === 0) return renderNotice('No classes scheduled for this day.');
  els.eventList.innerHTML = '';
  for (const ev of dayEvents) els.eventList.appendChild(buildClassItem(ev));
}

async function renderOpenFloor({ refresh }) {
  const g = gym();
  els.loading.hidden = false;
  els.eventList.innerHTML = '';
  let data;
  try {
    const url = `/api/availability?gym=${encodeURIComponent(currentGymId)}&date=${currentDate}${refresh ? '&refresh=1' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    return showError(`Could not load open floor: ${err.message}`);
  }
  els.loading.hidden = true;

  els.modeHint.hidden = false;
  els.modeHint.textContent =
    `Open floor = the studio is class-free between ${formatHHMM(data.window.start)} and ${formatHHMM(data.window.end)}, gaps of ${data.minGapMinutes}m+.`;

  els.eventList.innerHTML = '';
  for (const room of data.rooms) {
    els.eventList.appendChild(buildRoomHeader(room));
    if (room.gaps.length === 0) {
      els.eventList.appendChild(buildNotice(`No open floor in ${room.room} today.`));
      continue;
    }
    for (const gap of room.gaps) els.eventList.appendChild(buildGapItem(gap));
  }
}

function renderNotice(text) {
  els.loading.hidden = true;
  els.eventList.innerHTML = '';
  els.eventList.appendChild(buildNotice(text));
}

function buildNotice(text) {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = text;
  return empty;
}

function buildClassItem(ev) {
  const item = document.createElement('article');
  item.className = 'event-item';

  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = `${formatTime(ev.startDT)} – ${formatTime(ev.endDT)}`;
  item.appendChild(time);

  const body = document.createElement('div');
  body.className = 'event-body';

  const name = document.createElement('h3');
  name.className = 'event-name';
  name.textContent = ev.name || '(unnamed class)';
  body.appendChild(name);

  if (ev.room) {
    const badge = document.createElement('span');
    badge.className = ev.danceSuitable ? 'room-badge room-badge--dance' : 'room-badge';
    badge.textContent = ev.room;
    name.appendChild(document.createTextNode(' '));
    name.appendChild(badge);
  }

  const desc = stripHtml(ev.description);
  if (desc) {
    const p = document.createElement('p');
    p.className = 'event-desc';
    p.textContent = desc.length > 220 ? `${desc.slice(0, 217)}…` : desc;
    body.appendChild(p);
  }

  const metaBits = [];
  if (ev.instructors && ev.instructors.length) metaBits.push(ev.instructors.join(', '));
  if (ev.seatsRemaining != null && ev.seatsTotal != null) {
    metaBits.push(`${ev.seatsRemaining}/${ev.seatsTotal} spots left`);
  }
  if (metaBits.length) {
    const meta = document.createElement('p');
    meta.className = 'event-meta';
    meta.textContent = metaBits.join(' · ');
    body.appendChild(meta);
  }
  item.appendChild(body);

  if (ev.deepLink) {
    const link = document.createElement('a');
    link.className = 'event-link';
    link.href = ev.deepLink;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Details ↗';
    item.appendChild(link);
  }
  return item;
}

function buildRoomHeader(room) {
  const h = document.createElement('h2');
  h.className = 'room-header';
  h.textContent = room.room;
  const sub = document.createElement('span');
  sub.className = 'room-header__sub';
  sub.textContent = room.classes.length
    ? ` · ${room.classes.length} class${room.classes.length === 1 ? '' : 'es'} today`
    : ' · no classes today';
  h.appendChild(sub);
  return h;
}

function buildGapItem(gap) {
  const item = document.createElement('article');
  item.className = 'event-item event-item--open';

  const time = document.createElement('div');
  time.className = 'event-time';
  time.textContent = `${formatTime(gap.startDT)} – ${formatTime(gap.endDT)}`;
  item.appendChild(time);

  const body = document.createElement('div');
  body.className = 'event-body';
  const name = document.createElement('h3');
  name.className = 'event-name';
  name.textContent = 'Open floor';
  body.appendChild(name);
  item.appendChild(body);

  const dur = document.createElement('span');
  dur.className = 'duration-badge';
  dur.textContent = humanDuration(gap.minutes);
  item.appendChild(dur);
  return item;
}

// ---- data ----

function findCachedWeek(date) {
  for (const [key, payload] of weekCache.entries()) {
    if (!key.startsWith(`${currentGymId}:`)) continue;
    if (date >= payload.weekStart && date <= maxDate(payload.events)) return payload;
  }
  return null;
}

function maxDate(events) {
  let max = '';
  for (const e of events) if (e.occurrenceDate && e.occurrenceDate > max) max = e.occurrenceDate;
  return max;
}

async function fetchWeek(date, refresh) {
  const url = `/api/events?gym=${encodeURIComponent(currentGymId)}&date=${date}${refresh ? '&refresh=1' : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  weekCache.set(`${currentGymId}:${payload.weekStart || date}`, payload);
  return payload;
}

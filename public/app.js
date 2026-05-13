const CRUX_TZ = 'America/Chicago';
const CRUX_CALENDAR_URL = 'https://www.cruxclimbingcenter.com/central-austin/calendar/';
const CRUX_PORTAL_BASE = 'https://crux.portal.approach.app';

function eventDeepLink(ev) {
  if (ev && ev.eventId != null && ev.id != null) {
    return `${CRUX_PORTAL_BASE}/event/${ev.eventId}/booking/${ev.id}/embed`;
  }
  return CRUX_CALENDAR_URL;
}

const dateHeaderEl = document.getElementById('dateHeader');
const eventListEl = document.getElementById('eventList');
const loadingEl = document.getElementById('loadingIndicator');
const errorEl = document.getElementById('errorIndicator');
const prevBtn = document.getElementById('prevDayBtn');
const todayBtn = document.getElementById('todayBtn');
const nextBtn = document.getElementById('nextDayBtn');
const refreshBtn = document.getElementById('refreshBtn');

// After this hour (Chicago local), default the initial view to tomorrow,
// since today's events are mostly over. The "Today" button still jumps to
// today literally — this only affects the first load.
const ROLLOVER_HOUR_CHICAGO = 21;

// Map<weekStartDate, payload>
const weekCache = new Map();
let currentDate = defaultViewDate();

prevBtn.addEventListener('click', () => shiftDay(-1));
nextBtn.addEventListener('click', () => shiftDay(1));
todayBtn.addEventListener('click', () => { currentDate = todayInChicago(); render(); });
refreshBtn.addEventListener('click', () => render({ refresh: true }));

render();

function todayInChicago() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CRUX_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function chicagoHour() {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: CRUX_TZ, hour12: false, hour: '2-digit',
  }).format(new Date()));
}

function defaultViewDate() {
  const today = todayInChicago();
  if (chicagoHour() < ROLLOVER_HOUR_CHICAGO) return today;
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function shiftDay(delta) {
  const [y, m, d] = currentDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  currentDate = dt.toISOString().slice(0, 10);
  render();
}

function formatDayHeader(yyyy_mm_dd) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  // Build a noon-UTC instant so the wall-clock day is unambiguous in any TZ.
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(dt);
}

function formatTime(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CRUX_TZ,
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
}

function findWeekContaining(date) {
  for (const [weekStart, payload] of weekCache.entries()) {
    if (date >= weekStart && date <= maxDate(payload.events)) {
      return { weekStart, payload };
    }
  }
  return null;
}

function maxDate(events) {
  let max = '';
  for (const e of events) {
    if (e.occurrenceDate && e.occurrenceDate > max) max = e.occurrenceDate;
  }
  return max;
}

async function fetchWeek(date, refresh) {
  const url = `/api/events?date=${date}${refresh ? '&refresh=1' : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  weekCache.set(payload.weekStart || date, payload);
  return payload;
}

async function render({ refresh = false } = {}) {
  dateHeaderEl.textContent = formatDayHeader(currentDate);
  errorEl.hidden = true;
  errorEl.textContent = '';

  let payload = !refresh ? findWeekContaining(currentDate)?.payload : null;
  if (!payload) {
    loadingEl.hidden = false;
    eventListEl.innerHTML = '';
    try {
      payload = await fetchWeek(currentDate, refresh);
    } catch (err) {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = `Could not load events: ${err.message}`;
      return;
    }
    loadingEl.hidden = true;
  }

  const dayEvents = (payload.events || []).filter(
    (e) => e.occurrenceDate === currentDate,
  );
  renderEvents(dayEvents);
}

function renderEvents(events) {
  eventListEl.innerHTML = '';
  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No events scheduled for this day.';
    eventListEl.appendChild(empty);
    return;
  }
  for (const ev of events) {
    eventListEl.appendChild(buildItem(ev));
  }
}

function buildItem(ev) {
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
  name.textContent = ev.name || '(unnamed event)';
  body.appendChild(name);

  const desc = stripHtml(ev.description);
  if (desc) {
    const p = document.createElement('p');
    p.className = 'event-desc';
    p.textContent = desc.length > 220 ? desc.slice(0, 217) + '…' : desc;
    body.appendChild(p);
  }

  const meta = document.createElement('p');
  meta.className = 'event-meta';
  const seats = (ev.seatsRemaining != null && ev.seatsTotal != null)
    ? `${ev.seatsRemaining}/${ev.seatsTotal} seats left`
    : '';
  meta.textContent = seats;
  body.appendChild(meta);

  item.appendChild(body);

  const link = document.createElement('a');
  link.className = 'event-link';
  link.href = eventDeepLink(ev);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Details on Crux ↗';
  item.appendChild(link);

  return item;
}

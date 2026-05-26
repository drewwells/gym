// Open Floor — answer-first mobile view of when each gym's dance-suitable
// studio is free. One screen: a top row (gym pill + product name), a swipeable
// 7-day strip, a hero that answers "can I dance right now?", and the day's open
// windows + blocking classes below it.
//
// The server owns the gap math: /api/gyms lists gyms, /api/availability returns
// per-day rooms with classes + open gaps (ISO datetimes). This client converts
// those instants to minutes-from-midnight in the gym's timezone and derives the
// hero state from (today's gaps, today's classes, now).

const STRIP_DAYS = 7;        // today + 6 days forward
const SWIPE_THRESHOLD = 70;  // px to commit a day swipe
const SWIPE_MS = 220;        // snap animation duration
const TICK_MS = 60 * 1000;   // re-evaluate "now" on this cadence
const STORE_KEY = 'openfloor:gym';
const DEFAULT_TZ = 'America/Chicago';

const els = {
  stage: document.querySelector('.stage'),
  gymBtn: document.getElementById('gymBtn'),
  gymName: document.getElementById('gymName'),
  dayStrip: document.getElementById('dayStrip'),
  swipe: document.getElementById('swipe'),
  track: document.getElementById('track'),
  sourceLink: document.getElementById('sourceLink'),
};

const gyms = new Map();      // id -> public gym config
let cycleList = [];          // gyms reachable by tapping the pill
let currentGymId = null;
let today = null;            // YYYY-MM-DD in the current gym's timezone
let dayOffset = 0;           // 0 = today, up to STRIP_DAYS-1

const dayCache = new Map();  // `${gymId}:${date}` -> parsed day | { error }
const inflight = new Map();  // `${gymId}:${date}` -> Promise
let tickTimer = null;

init();

async function init() {
  let data;
  try {
    const res = await fetch('/api/gyms');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    return showFatal(`Could not load gyms: ${err.message}`);
  }

  for (const g of data.gyms) gyms.set(g.id, g);
  cycleList = data.gyms.filter((g) => g.status !== 'coming-soon');
  if (cycleList.length === 0) cycleList = data.gyms.slice();
  const defaultId = (data.gyms.find((g) => g.status === 'live') || data.gyms[0]).id;

  const fromUrl = gymFromUrl();
  const fromStore = localStorage.getItem(STORE_KEY);
  currentGymId = fromUrl
    || (fromStore && gyms.has(fromStore) ? fromStore : null)
    || defaultId;
  today = todayInTz(gymTz());
  history.replaceState({}, '', canonicalUrl());

  els.gymBtn.addEventListener('click', cycleGym);
  window.addEventListener('popstate', () => {
    const id = gymFromUrl();
    if (id && id !== currentGymId) selectGym(id, { push: false });
  });
  attachSwipe();

  renderTopRow();
  buildDayStrip();
  renderSlides();
  await ensureDayLoaded(0);
  prefetchNeighbors(0);
  startTick();
}

// ---- gym selection ----

function gym(id = currentGymId) { return gyms.get(id); }
function gymTz(id = currentGymId) { return gym(id)?.tz || DEFAULT_TZ; }

// "Round Rock" from "Crunch — Round Rock"; the whole name if there's no dash.
function gymShort(g) {
  const i = g.name.indexOf('—');
  return i >= 0 ? g.name.slice(i + 1).trim() : g.name;
}

// The dance-suitable room label, e.g. "Group Fitness" / "Studio".
function gymRoom(g) {
  return (g.danceRooms && g.danceRooms[0]) || 'studio';
}

function cycleGym() {
  const idx = cycleList.findIndex((g) => g.id === currentGymId);
  const next = cycleList[(idx + 1) % cycleList.length];
  selectGym(next.id, { push: true });
}

function selectGym(id, { push }) {
  if (!gyms.has(id)) return;
  currentGymId = id;
  localStorage.setItem(STORE_KEY, id);
  today = todayInTz(gymTz());
  // Keep the day the user is looking at — switching gyms shouldn't yank them
  // back to today. dayOffset is relative to today, so the same calendar day is
  // shown (gyms share a timezone). Clamp in case the strip length ever changes.
  dayOffset = Math.max(0, Math.min(STRIP_DAYS - 1, dayOffset));
  if (push) history.pushState({}, '', canonicalUrl());
  renderTopRow();
  buildDayStrip();
  renderSlides();
  ensureDayLoaded(dayOffset);
  prefetchNeighbors(dayOffset);
}

function gymFromUrl() {
  const id = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));
  return gyms.has(id) ? id : null;
}

function canonicalUrl() {
  return `/${encodeURIComponent(currentGymId)}`;
}

function renderTopRow() {
  const g = gym();
  els.gymName.textContent = gymShort(g);
  const url = g.sourceUrl || '#';
  els.sourceLink.href = url;
  els.sourceLink.textContent = hostLabel(url);
}

function hostLabel(url) {
  try {
    return `${new URL(url).hostname.replace(/^www\./, '')} ↗`;
  } catch {
    return 'source ↗';
  }
}

// ---- date + time helpers (per-gym timezone) ----

function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Minute-of-day (0..1439) right now in the given timezone.
function nowMinutesInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

// Minute-of-day of an ISO instant, read in the gym's timezone.
function isoToMinutes(iso, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function addDays(yyyy_mm_dd, delta) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function dateParts(yyyy_mm_dd) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const fmt = (opt) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opt }).format(dt);
  return {
    dowShort: fmt({ weekday: 'short' }).toUpperCase().slice(0, 3),
    dowLong: fmt({ weekday: 'long' }),
    month: fmt({ month: 'short' }),
    dom: d,
  };
}

// Compact 12h: "6AM", "8:15PM".
function fmt12(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2, '0')}${ampm}`;
}

// Spaced 12h: "5:30 PM", "11:47 AM".
function fmt12Long(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

function durStr(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// ---- data ----

function cacheKey(date, id = currentGymId) { return `${id}:${date}`; }

function getCached(date, id = currentGymId) { return dayCache.get(cacheKey(date, id)); }

// Fetch + parse one day's availability, memoized per gym+date. Resolves to a
// parsed day, or an { error } record (never rejects).
function loadDay(date, id = currentGymId) {
  const key = cacheKey(date, id);
  if (dayCache.has(key)) return Promise.resolve(dayCache.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const p = fetch(`/api/availability?gym=${encodeURIComponent(id)}&date=${date}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const parsed = parseDay(data, date, gymTz(id));
      dayCache.set(key, parsed);
      inflight.delete(key);
      return parsed;
    })
    .catch((err) => {
      const rec = { error: err.message, date };
      dayCache.set(key, rec);
      inflight.delete(key);
      return rec;
    });

  inflight.set(key, p);
  return p;
}

// Flatten the availability response (one entry per dance room — in practice a
// single studio per gym) into sorted minute-based classes + gaps for the day.
function parseDay(data, date, tz) {
  const events = [];
  const gaps = [];
  for (const room of data.rooms || []) {
    for (const c of room.classes || []) {
      events.push({ name: c.name, start: isoToMinutes(c.startDT, tz), end: isoToMinutes(c.endDT, tz) });
    }
    for (const g of room.gaps || []) {
      gaps.push({ start: isoToMinutes(g.startDT, tz), end: isoToMinutes(g.endDT, tz), minutes: g.minutes });
    }
  }
  events.sort((a, b) => a.start - b.start);
  gaps.sort((a, b) => a.start - b.start);
  return {
    date,
    ...dateParts(date),
    events,
    gaps,
    totalOpenMin: gaps.reduce((s, g) => s + g.minutes, 0),
  };
}

// Load a day (if needed) and refresh any on-screen slide showing it. Skips
// coming-soon gyms (no live schedule) and out-of-range offsets.
async function ensureDayLoaded(offset) {
  if (offset < 0 || offset > STRIP_DAYS - 1) return;
  if (gym().status === 'coming-soon') return;
  const date = addDays(today, offset);
  if (getCached(date)) return;
  const id = currentGymId;
  await loadDay(date, id);
  if (id === currentGymId) refreshSlide(offset);
}

function prefetchNeighbors(offset) {
  ensureDayLoaded(offset - 1);
  ensureDayLoaded(offset + 1);
}

// ---- day strip ----

function buildDayStrip() {
  els.dayStrip.innerHTML = '';
  for (let i = 0; i < STRIP_DAYS; i++) {
    const p = dateParts(addDays(today, i));
    const chip = h('button', {
      class: 'day-chip',
      attrs: {
        type: 'button', role: 'tab',
        'aria-selected': String(i === dayOffset),
        'aria-label': `${p.dowLong} ${p.month} ${p.dom}`,
      },
    },
      h('div', { class: 'day-chip__dow', text: p.dowShort }),
      h('div', { class: 'day-chip__dom', text: String(p.dom) }),
    );
    if (i === 0) chip.classList.add('is-today');
    if (i === dayOffset) chip.classList.add('is-active');
    chip.addEventListener('click', () => goToDay(i));
    els.dayStrip.appendChild(chip);
  }
}

function syncDayStrip() {
  [...els.dayStrip.children].forEach((chip, i) => {
    chip.classList.toggle('is-active', i === dayOffset);
    chip.setAttribute('aria-selected', String(i === dayOffset));
  });
  const active = els.dayStrip.children[dayOffset];
  if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function goToDay(offset) {
  offset = Math.max(0, Math.min(STRIP_DAYS - 1, offset));
  dayOffset = offset;
  syncDayStrip();
  renderSlides();
  ensureDayLoaded(offset);
  prefetchNeighbors(offset);
}

// ---- swipe deck ----

// Rebuild the prev/cur/next slides centered on dayOffset, with the track reset
// to its resting position (no animation).
function renderSlides() {
  els.track.style.transition = 'none';
  els.track.style.transform = 'translateX(0)';
  els.track.innerHTML = '';
  for (const rel of [-1, 0, 1]) {
    const offset = dayOffset + rel;
    const slide = h('div', { class: 'slide' });
    slide.style.left = `${rel * 100}%`;
    slide.dataset.offset = String(offset);
    fillSlide(slide, offset);
    els.track.appendChild(slide);
  }
}

function fillSlide(slide, offset) {
  slide.innerHTML = '';
  if (offset < 0 || offset > STRIP_DAYS - 1) {
    slide.appendChild(h('div', { class: 'panel' })); // blank edge
    return;
  }
  const rec = gym().status === 'coming-soon' ? null : getCached(addDays(today, offset));
  slide.appendChild(buildPanel(rec, offset));
}

function refreshSlide(offset) {
  for (const slide of els.track.children) {
    if (Number(slide.dataset.offset) === offset) {
      const top = slide.scrollTop;
      fillSlide(slide, offset);
      slide.scrollTop = top;
    }
  }
}

function attachSwipe() {
  let startX = null, startY = null, captured = false, drag = 0;
  const width = () => els.swipe.clientWidth || 1;

  els.swipe.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; captured = false; drag = 0;
    els.track.style.transition = 'none';
  });

  window.addEventListener('pointermove', (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!captured) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        captured = true;
      } else if (Math.abs(dy) > 8) {
        startX = null; // vertical scroll — hand back to the browser
        return;
      } else {
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    drag = dx;
    els.track.style.transform = `translateX(${dx}px)`;
  }, { passive: false });

  const end = () => {
    if (startX == null) return;
    const dx = drag;
    startX = null;
    const w = width();
    els.track.style.transition = `transform ${SWIPE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    if (dx <= -SWIPE_THRESHOLD && dayOffset < STRIP_DAYS - 1) {
      els.track.style.transform = `translateX(${-w}px)`;
      window.setTimeout(() => commitSwipe(dayOffset + 1), SWIPE_MS);
    } else if (dx >= SWIPE_THRESHOLD && dayOffset > 0) {
      els.track.style.transform = `translateX(${w}px)`;
      window.setTimeout(() => commitSwipe(dayOffset - 1), SWIPE_MS);
    } else {
      els.track.style.transform = 'translateX(0)';
    }
    drag = 0;
  };

  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function commitSwipe(offset) {
  dayOffset = Math.max(0, Math.min(STRIP_DAYS - 1, offset));
  syncDayStrip();
  renderSlides();
  ensureDayLoaded(dayOffset);
  prefetchNeighbors(dayOffset);
}

// ---- panel rendering ----

function buildPanel(rec, offset) {
  const panel = h('div', { class: 'panel' });
  const g = gym();

  if (g.status === 'coming-soon') {
    panel.appendChild(comingSoonHero(g));
    return panel;
  }
  if (!rec) {
    panel.appendChild(messageHero('Reading the schedule', 'One sec'));
    return panel;
  }
  if (rec.error) {
    panel.appendChild(errorHero(rec, offset));
    return panel;
  }

  const isToday = offset === 0;
  const nowMin = nowMinutesInTz(gymTz());
  if (isToday) {
    const state = nowState(rec, nowMin);
    panel.appendChild(heroToday(rec, state, nowMin, g));
    panel.appendChild(buildList(rec, state, nowMin, true));
  } else {
    panel.appendChild(heroOther(rec));
    panel.appendChild(buildList(rec, null, nowMin, false));
  }
  return panel;
}

// Classify "now" against today's gaps + classes.
function nowState(day, t) {
  for (const g of day.gaps) {
    if (t >= g.start && t < g.end) return { kind: 'open', endsAt: g.end, remaining: g.end - t };
  }
  for (const e of day.events) {
    if (t >= e.start && t < e.end) {
      const nextGap = day.gaps.find((g) => g.start >= e.end);
      return { kind: 'inClass', cls: e, until: e.end, nextGap };
    }
  }
  const nextGap = day.gaps.find((g) => g.start > t);
  if (nextGap) return { kind: 'upcoming', nextGap };
  return { kind: 'doneForDay' };
}

function heroToday(day, s, nowMin, g) {
  const short = gymShort(g);
  const room = gymRoom(g).toLowerCase();

  if (s.kind === 'open') {
    return hero(
      'The floor is',
      heroHead(accent('Open'), br(), 'for the next', br(), accent(durStr(s.remaining), true), '.'),
      sub(`${short}'s ${room} is class-free until `, strong(fmt12Long(s.endsAt)), '.'),
      heroFooter(`Now · ${fmt12Long(nowMin)}`, fmt12Long(s.endsAt)),
    );
  }
  if (s.kind === 'inClass') {
    const left = s.until - nowMin;
    return hero(
      'Right now · floor in use',
      heroHead(accent(s.cls.name), br(), `for ${durStr(left)} more.`),
      s.nextGap
        ? sub('Floor opens at ', strong(fmt12Long(s.nextGap.start)), ` for ${durStr(s.nextGap.minutes)}.`)
        : sub('No more open windows today — see tomorrow below.'),
      heroFooter('In session', `ends ${fmt12(s.until)}`),
    );
  }
  if (s.kind === 'upcoming') {
    return hero(
      'Floor opens in',
      heroHead(accent(durStr(s.nextGap.start - nowMin)), ',', br(), `at ${fmt12(s.nextGap.start)}.`),
      sub('First open window runs until ', strong(fmt12Long(s.nextGap.end)), '.'),
    );
  }

  // doneForDay — preview tomorrow's first window.
  const tomorrow = addDays(today, 1);
  const tRec = getCached(tomorrow);
  const known = tRec && !tRec.error;
  if (!known) loadDay(tomorrow).then(() => refreshSlide(0));
  const tFirst = known ? tRec.gaps[0] : null;

  let subEl;
  if (tFirst) subEl = sub(strong('Tomorrow'), ' opens at ', strong(fmt12Long(tFirst.start)), ` for ${durStr(tFirst.minutes)}.`);
  else if (known) subEl = sub("Tomorrow's studio is fully booked.");
  else subEl = sub("Checking tomorrow's schedule…");

  const node = hero(
    "That's a wrap on today",
    heroHead("Floor's ", accent('done'), br(), 'for tonight.'),
    subEl,
  );
  if (tFirst) {
    const btn = h('button', { class: 'peek-btn', text: 'See tomorrow →', attrs: { type: 'button' } });
    btn.addEventListener('click', () => goToDay(1));
    node.appendChild(btn);
  }
  return node;
}

function heroOther(day) {
  const n = day.gaps.length;
  return hero(
    `${day.dowLong} · ${day.month} ${day.dom}`,
    heroHead(accent(durStr(day.totalOpenMin)), ' open', br(), 'across ', em(String(n)), ` ${n === 1 ? 'window' : 'windows'}.`),
    sub(`${day.events.length} ${day.events.length === 1 ? 'class' : 'classes'} on the floor.`),
  );
}

function comingSoonHero(g) {
  return hero(
    gymShort(g),
    heroHead('Opening ', accent('soon'), '.'),
    sub("This gym's schedule isn't live yet — check back once it opens."),
  );
}

function messageHero(headText, eyebrowText) {
  return hero(eyebrowText, heroHead(accent(headText)));
}

function errorHero(rec, offset) {
  const node = hero(
    "Couldn't reach the schedule",
    heroHead('Hmm', accent('.')),
    sub(rec.error || 'Something went wrong.'),
  );
  const btn = h('button', { class: 'peek-btn', text: 'Try again', attrs: { type: 'button' } });
  btn.addEventListener('click', () => {
    dayCache.delete(cacheKey(rec.date));
    refreshSlide(offset);
    ensureDayLoaded(offset);
  });
  node.appendChild(btn);
  return node;
}

function buildList(day, s, nowMin, isToday) {
  const list = h('div', { class: 'list' });

  // Which gaps to show: today filters to what's still ahead; other days show all.
  let gaps = day.gaps;
  if (isToday && s) {
    if (s.kind === 'open') gaps = day.gaps.filter((g) => g.start > s.endsAt);
    else if (s.kind === 'inClass') gaps = day.gaps.filter((g) => g.start > s.until);
    else if (s.kind === 'upcoming') gaps = day.gaps.filter((g) => g.start >= s.nextGap.start);
    else if (s.kind === 'doneForDay') gaps = [];
  }

  if (isToday && s && s.kind === 'open' && gaps.length) list.appendChild(sectionTitle('Later today'));
  else if (isToday && s && s.kind === 'inClass' && gaps.length) list.appendChild(sectionTitle('After this class'));
  else if (!isToday && day.gaps.length) list.appendChild(sectionTitle('Open windows'));

  if (!gaps.length && day.events.length === 0) {
    list.appendChild(h('div', { class: 'empty', text: "Studio's quiet — nothing on the books." }));
  } else {
    for (const g of gaps) list.appendChild(windowRow(g));
  }

  if (day.events.length) {
    list.appendChild(sectionTitle('Classes blocking the floor', true));
    for (const e of day.events) {
      const live = isToday && nowMin >= e.start && nowMin < e.end;
      list.appendChild(classRow(e, live));
    }
  }
  return list;
}

function windowRow(g) {
  return h('div', { class: 'window-row' },
    h('div', {},
      h('div', { class: 'window-time', text: `${fmt12(g.start)} – ${fmt12(g.end)}` }),
      h('div', { class: 'window-meta', text: 'Open · between classes' }),
    ),
    h('div', { class: 'window-dur', text: durStr(g.minutes) }),
  );
}

function classRow(e, live) {
  const name = h('span', {}, e.name);
  if (live) {
    name.appendChild(h('span', {
      class: 'live-badge', text: 'Live', attrs: { 'aria-label': 'currently in session' },
    }));
  }
  return h('div', { class: `class-row${live ? ' is-live' : ''}` },
    name,
    h('span', { class: 'class-row-time', text: `${fmt12(e.start)} – ${fmt12(e.end)}` }),
  );
}

// ---- small DOM builders ----

function hero(eyebrowText, headEl, subEl, footerEl) {
  const node = h('div', { class: 'hero' },
    h('div', { class: 'hero-eyebrow', text: eyebrowText }),
    headEl,
  );
  if (subEl) node.appendChild(subEl);
  if (footerEl) node.appendChild(footerEl);
  return node;
}

function heroHead(...kids) { return h('h1', { class: 'hero-head' }, ...kids); }
function sub(...kids) { return h('p', { class: 'hero-sub' }, ...kids); }
function heroFooter(leftText, numText) {
  return h('div', { class: 'hero-footer' },
    h('span', { text: leftText }),
    h('span', { class: 'hero-footer-num', text: numText }),
  );
}
function sectionTitle(text, spaced) {
  return h('div', { class: `section-title${spaced ? ' section-title--spaced' : ''}`, text });
}
function accent(text, nowrap) { return h('span', { class: `accent${nowrap ? ' nowrap' : ''}`, text }); }
function em(text) { return h('em', { text }); }
function strong(text) { return h('strong', { text }); }
function br() { return document.createElement('br'); }

// Minimal hyperscript: h(tag, { class, text, attrs }, ...children). String
// children become text nodes; class names / class content go in via textContent
// so gym/class names can't inject markup.
function h(tag, opts = {}, ...kids) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
  for (const kid of kids) {
    if (kid == null) continue;
    node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}

// ---- "now" ticking + fatal errors ----

function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (document.hidden || dayOffset !== 0) return;
    const t = todayInTz(gymTz());
    if (t !== today) { // crossed midnight — rebuild around the new today
      today = t;
      buildDayStrip();
      renderSlides();
      ensureDayLoaded(0);
      prefetchNeighbors(0);
      return;
    }
    refreshSlide(0);
  }, TICK_MS);
}

function showFatal(msg) {
  els.track.innerHTML = '';
  const slide = h('div', { class: 'slide' });
  slide.style.left = '0';
  slide.appendChild(h('div', { class: 'panel' },
    hero("Couldn't load", heroHead('Hmm', accent('.')), sub(msg)),
  ));
  els.track.appendChild(slide);
}

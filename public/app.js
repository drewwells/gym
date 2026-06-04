// Open Floor — global board + per-gym detail. Two views share the same shell:
//
//   Board (/)         answer-first view across every live gym for the picked
//                     date. Hero summarizes "is anyone open now?"; rows sort
//                     open-now → opening-later → done; tapping a row drills
//                     into the detail view for that gym.
//
//   Detail (/?gym=X)  per-gym swipe deck with the hero answering "can I
//                     dance right now?" and the day's open windows + classes
//                     beneath it. Top-row "back" returns to the board; the
//                     bottom-sheet picker still lets you jump gyms inline.
//
// Both views share the same date strip, the same "now" tick, and the same
// /api/availability cache for per-day rooms. The board additionally talks to
// /api/board, which folds all live gyms' open-floor summaries for a single
// date into one response (the server warms its weekly cache daily so this is
// always a cache hit in steady state).

const STRIP_DAYS = 7;
const SWIPE_THRESHOLD = 70;
const SWIPE_MS = 220;
const TICK_MS = 60 * 1000;
const DEFAULT_TZ = 'America/Chicago';

// Two-letter brand glyphs (Crunch vs Crux collide at "C", Gold's needs "GG"
// rather than just "G"). Unknown brands fall back to the first two letters.
const BRAND_MARK = {
  'Crunch': 'CR',
  'LA Fitness': 'LA',
  'Crux': 'CX',
  "Gold's Gym": 'GG',
};

const els = {
  stage: document.querySelector('.stage'),
  topRow: document.getElementById('topRow'),
  dayStrip: document.getElementById('dayStrip'),
  // Board view.
  boardView: document.getElementById('boardView'),
  boardHero: document.getElementById('boardHero'),
  boardList: document.getElementById('boardList'),
  // Detail view.
  detailView: document.getElementById('detailView'),
  swipe: document.getElementById('swipe'),
  track: document.getElementById('track'),
  sourceLink: document.getElementById('sourceLink'),
  // Picker sheet (used in detail view).
  sheet: document.getElementById('sheet'),
  sheetScrim: document.getElementById('sheetScrim'),
  sheetList: document.getElementById('sheetList'),
  sheetClose: document.getElementById('sheetClose'),
};

// ---- global state ----

const gyms = new Map();       // id -> public gym record
const gymOrder = [];          // ids in registry order
let view = 'board';           // 'board' | 'detail'
let currentGymId = null;      // detail only
let anchorTz = DEFAULT_TZ;    // tz used to compute "today" for the date strip
let today = null;             // YYYY-MM-DD in anchorTz, rolls at midnight
let dayOffset = 0;            // 0 = today, up to STRIP_DAYS-1

const dayCache = new Map();   // `${gymId}:${date}` -> parsed day | { error }
const dayInflight = new Map();
const boardCache = new Map(); // date -> { date, rows: parsed[] } | { error, date }
const boardInflight = new Map();

let tickTimer = null;

init();

async function init() {
  // 1. Bootstrap the gym registry.
  let data;
  try {
    const res = await fetch('/api/gyms');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    return showFatal(`Could not load gyms: ${err.message}`);
  }
  for (const g of data.gyms) { gyms.set(g.id, g); gymOrder.push(g.id); }
  const firstLive = data.gyms.find((g) => g.status === 'live') || data.gyms[0];
  anchorTz = firstLive ? firstLive.tz : DEFAULT_TZ;
  today = todayInTz(anchorTz);

  // 2. Wire shell-wide listeners (sheet, swipe, popstate).
  els.sheetScrim.addEventListener('click', closePicker);
  els.sheetClose.addEventListener('click', closePicker);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.sheet.hidden) closePicker();
  });
  window.addEventListener('popstate', () => route({ push: false }));
  attachSwipe();

  // 3. Read the URL once, then render.
  route({ push: false });
  startTick();
}

// ---- routing ----

// Map URL -> {view, gymId, date}. Supports the new query-string canonical
// (/?gym=X&date=Y) and the legacy "/<gym-id>" path so old shared links keep
// working — anything matching a known id gets folded into ?gym=.
function parseLocation() {
  const url = new URL(location.href);
  let gymId = url.searchParams.get('gym');
  let date = url.searchParams.get('date');
  // Legacy /<gym-id> path → upgrade in place.
  if (!gymId) {
    const slug = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
    if (slug && gyms.has(slug)) gymId = slug;
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = null;
  if (gymId && !gyms.has(gymId)) gymId = null;
  return { gymId, date };
}

function buildUrl({ gymId, date }) {
  const qs = new URLSearchParams();
  if (gymId) qs.set('gym', gymId);
  if (date) qs.set('date', date);
  const q = qs.toString();
  return q ? `/?${q}` : '/';
}

// Read the URL, snap state to it, then render. `push` controls whether we
// replace the entry (popstate / initial load) or push a new one (a fresh
// in-app nav).
function route({ push }) {
  const { gymId, date } = parseLocation();
  const newView = gymId ? 'detail' : 'board';
  const tz = gymId ? (gyms.get(gymId)?.tz || anchorTz) : anchorTz;
  today = todayInTz(tz);
  const targetDate = date || today;
  // Clamp date into the [today, today+6] strip; out-of-range dates fall back
  // to today (we don't pretend to support arbitrary historical dates).
  dayOffset = Math.max(0, Math.min(STRIP_DAYS - 1, daysBetween(today, targetDate)));
  view = newView;
  currentGymId = gymId;

  const canonical = buildUrl({ gymId, date: dayOffset === 0 ? null : addDays(today, dayOffset) });
  if (push) history.pushState({}, '', canonical);
  else history.replaceState({}, '', canonical);

  renderShell();
}

// Navigate to a new (view, gym, date) tuple, pushing onto history.
function navigate({ gymId = null, date = null }) {
  const url = buildUrl({ gymId, date });
  if (url === location.pathname + location.search) return;
  history.pushState({}, '', url);
  route({ push: false });
}

// Update just the date in-place (clicking a chip / swiping a day) without
// changing view or gym. Pushes a new history entry so back/forward works.
function setDayOffset(offset, { push = true } = {}) {
  offset = Math.max(0, Math.min(STRIP_DAYS - 1, offset));
  if (offset === dayOffset) return;
  dayOffset = offset;
  const date = offset === 0 ? null : addDays(today, offset);
  const url = buildUrl({ gymId: currentGymId, date });
  if (push) history.pushState({}, '', url);
  else history.replaceState({}, '', url);
  syncDayStrip();
  if (view === 'board') renderBoard();
  else renderDetailSlides();
}

// ---- shell rendering ----

function renderShell() {
  renderTopRow();
  buildDayStrip();
  if (view === 'board') {
    els.boardView.hidden = false;
    els.detailView.hidden = true;
    renderBoard();
    ensureBoardLoaded(dayOffset);
  } else {
    els.boardView.hidden = true;
    els.detailView.hidden = false;
    const g = gym(currentGymId);
    els.sourceLink.href = g?.sourceUrl || '#';
    els.sourceLink.textContent = `${g?.sourceHost || 'source'} ↗`;
    renderDetailSlides();
    ensureDayLoaded(dayOffset);
    prefetchNeighbors(dayOffset);
  }
}

function renderTopRow() {
  els.topRow.innerHTML = '';
  if (view === 'board') {
    // Identity on the board is the product itself — there's no single gym to
    // name. Left half doubles as a non-tappable identity block.
    els.topRow.appendChild(
      h('div', { class: 'gym-btn gym-btn--static', attrs: { 'aria-label': 'All floors' } },
        h('span', { class: 'gym-swatch', attrs: { 'aria-hidden': 'true' }, text: 'AF' }),
        h('span', { class: 'gym-btn-text' },
          h('span', { class: 'gym-brand', text: 'All Floors' }),
          h('span', { class: 'gym-short-line' },
            h('span', { class: 'gym-short', text: 'Austin' }),
          ),
        ),
      ),
    );
    els.topRow.appendChild(h('span', { class: 'product', text: 'Open Floor' }));
    return;
  }

  // Detail: a back button on the far left, the gym identity (tap to open the
  // picker), and the product label on the right.
  const g = gym(currentGymId);
  const back = h('button', {
    class: 'back-btn',
    attrs: { type: 'button', 'aria-label': 'Back to all floors' },
  }, '← All');
  back.addEventListener('click', () => navigate({ gymId: null, date: dayOffset === 0 ? null : addDays(today, dayOffset) }));

  const ident = h('button', {
    class: 'gym-btn',
    attrs: { type: 'button', 'aria-label': 'Change gym', 'aria-haspopup': 'dialog' },
  },
    h('span', { class: 'gym-swatch', attrs: { 'aria-hidden': 'true' }, text: brandMark(g?.brand) }),
    h('span', { class: 'gym-btn-text' },
      h('span', { class: 'gym-brand', text: g?.brand || '' }),
      h('span', { class: 'gym-short-line' },
        h('span', { class: 'gym-short', text: g?.short || g?.name || '' }),
        h('span', { class: 'caret', attrs: { 'aria-hidden': 'true' }, text: '▾' }),
      ),
    ),
  );
  ident.addEventListener('click', openPicker);

  els.topRow.appendChild(h('div', { class: 'top-row__left' }, back, ident));
  els.topRow.appendChild(h('span', { class: 'product', text: 'Open Floor' }));
}

// ---- date strip ----

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
    chip.addEventListener('click', () => setDayOffset(i));
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

// ---- board view ----

function renderBoard() {
  const date = addDays(today, dayOffset);
  const rec = boardCache.get(date);
  const isToday = dayOffset === 0;

  if (!rec) {
    els.boardHero.innerHTML = '';
    els.boardHero.appendChild(boardMessageHero('Reading every floor', 'One sec'));
    els.boardList.innerHTML = '';
    return;
  }
  if (rec.error) {
    els.boardHero.innerHTML = '';
    els.boardHero.appendChild(boardMessageHero(rec.error, "Couldn't load the board"));
    els.boardList.innerHTML = '';
    return;
  }

  const tz = anchorTz;
  const nowMs = Date.now();
  const rows = rec.rows.slice();
  sortBoardRows(rows, nowMs);

  // Hero.
  els.boardHero.innerHTML = '';
  els.boardHero.appendChild(buildBoardHero(rows, isToday, nowMs, tz, date));

  // Rows.
  els.boardList.innerHTML = '';
  for (const r of rows) els.boardList.appendChild(buildBoardRow(r, isToday, nowMs, tz));
}

// Compute "what's the headline for the board?" from the sorted rows + clock.
// See task spec §2 for the exact answer-first language.
function buildBoardHero(rows, isToday, nowMs, tz, date) {
  const live = rows.filter((r) => r.status === 'live' && r.day);
  const openNow = live.filter((r) => roomOpenNow(r, nowMs));

  if (isToday) {
    if (openNow.length) {
      // Best bet = the open floor with the most time left now.
      const best = openNow.reduce((a, b) => (timeLeft(a, nowMs) >= timeLeft(b, nowMs) ? a : b));
      const bestEnd = openGap(best, nowMs).endDT;
      const remaining = timeLeft(best, nowMs);
      return hero(
        'Right now',
        heroHead(accent(String(openNow.length)), ` ${openNow.length === 1 ? 'floor' : 'floors'}`, br(), 'open right now'),
        sub('Best bet: ', strong(best.short || best.name), ' — free for ', strong(durStr(Math.round(remaining / 60000))), ', until ', strong(fmt12LongIso(bestEnd, tz)), '.'),
        heroFooter(`Now · ${fmt12Long(nowMinutesInTz(tz))}`, fmt12LongIso(bestEnd, tz)),
      );
    }
    // Anyone opening later today?
    const upcoming = live
      .map((r) => ({ row: r, gap: nextGap(r, nowMs) }))
      .filter((x) => x.gap)
      .sort((a, b) => new Date(a.gap.startDT) - new Date(b.gap.startDT));
    if (upcoming.length) {
      const next = upcoming[0];
      const wait = new Date(next.gap.startDT).getTime() - nowMs;
      return hero(
        'Right now',
        heroHead('No floor open for ', accent(durStr(Math.round(wait / 60000)))),
        sub('Next up: ', strong(next.row.short || next.row.name), ' opens at ', strong(fmt12LongIso(next.gap.startDT, tz)), '.'),
        heroFooter(`Now · ${fmt12Long(nowMinutesInTz(tz))}`, fmt12LongIso(next.gap.startDT, tz)),
      );
    }
    return hero(
      "That's a wrap on today",
      heroHead("Every floor's ", accent('done'), br(), 'for tonight'),
    );
  }

  // Non-today dates: focus on coverage and total open time.
  const withOpen = live.filter((r) => r.day && r.day.windowCount > 0);
  const totalMin = live.reduce((s, r) => s + (r.day?.totalOpenMin || 0), 0);
  const p = dateParts(date);
  return hero(
    `${p.dowLong} · ${p.month} ${p.dom}`,
    heroHead(accent(String(withOpen.length)), ` of ${live.length} `, br(), `${live.length === 1 ? 'floor has' : 'floors have'} open time`),
    sub(strong(durStr(totalMin)), ' available across every floor.'),
  );
}

function buildBoardRow(row, isToday, nowMs, tz) {
  const live = row.status === 'live' && row.day;
  const soon = row.status === 'coming-soon';
  const node = h('button', {
    class: `board-row${live ? '' : ' is-muted'}${soon ? ' is-soon' : ''}${row.error ? ' is-error' : ''}`,
    attrs: {
      type: 'button', role: 'listitem',
      'aria-label': `${row.short || row.name} — ${row.brand || ''}`,
    },
  });

  // Left: brand swatch.
  const swatch = h('span', { class: 'board-row__swatch', attrs: { 'aria-hidden': 'true' }, text: brandMark(row.brand) });

  // Middle: name + brand + status line.
  const name = h('div', { class: 'board-row__name' },
    h('div', { class: 'board-row__brand', text: row.brand || '' }),
    h('div', { class: 'board-row__short', text: row.short || row.name || '' }),
    h('div', { class: 'board-row__status', text: rowStatusLine(row, isToday, nowMs, tz) }),
  );

  // Right: headline metric.
  const metric = h('div', { class: 'board-row__metric' }, ...rowMetric(row, isToday, nowMs, tz));

  node.appendChild(swatch);
  node.appendChild(name);
  node.appendChild(metric);

  if (!soon) {
    node.addEventListener('click', () => {
      const d = dayOffset === 0 ? null : addDays(today, dayOffset);
      navigate({ gymId: row.id || row.gymId, date: d });
    });
  } else {
    node.disabled = true;
  }
  return node;
}

function rowStatusLine(row, isToday, nowMs, tz) {
  if (row.status === 'coming-soon') return 'Coming soon';
  if (row.error || !row.day) return "Couldn't read schedule";
  if (isToday) {
    const og = openGap(row, nowMs);
    if (og) return `Open now · until ${fmt12LongIso(og.endDT, tz)}`;
    const ng = nextGap(row, nowMs);
    if (ng) return `Opens ${fmt12LongIso(ng.startDT, tz)} · ${durStr(ng.minutes)} free`;
    return 'Done for today';
  }
  if (row.day.windowCount === 0) return 'Fully booked';
  return `${row.day.windowCount} ${row.day.windowCount === 1 ? 'window' : 'windows'}`;
}

function rowMetric(row, isToday, nowMs, tz) {
  if (row.status === 'coming-soon') return [h('span', { class: 'board-row__metric-sm', text: '—' })];
  if (row.error || !row.day) return [h('span', { class: 'board-row__metric-sm', text: '—' })];
  if (isToday) {
    const og = openGap(row, nowMs);
    if (og) {
      const mins = Math.max(0, Math.round((new Date(og.endDT).getTime() - nowMs) / 60000));
      return [
        h('span', { class: 'board-row__metric-big', text: durStr(mins) }),
        h('span', { class: 'board-row__metric-sm', text: 'left' }),
      ];
    }
    const ng = nextGap(row, nowMs);
    if (ng) return [h('span', { class: 'board-row__metric-big', text: fmt12Iso(ng.startDT, tz) })];
    return [h('span', { class: 'board-row__metric-sm', text: '—' })];
  }
  // Non-today: show total open time for the day.
  if (!row.day.totalOpenMin) return [h('span', { class: 'board-row__metric-sm', text: '—' })];
  return [
    h('span', { class: 'board-row__metric-big', text: durStr(row.day.totalOpenMin) }),
    h('span', { class: 'board-row__metric-sm', text: 'open' }),
  ];
}

function boardMessageHero(headText, eyebrowText) {
  return hero(eyebrowText, heroHead(accent(headText)));
}

// ---- board sort (mirrors lib/board.js boardSortKey for consistency) ----

function sortBoardRows(rows, nowMs) {
  return rows.sort((a, b) => {
    const [ab, as] = boardSortKey(a, nowMs);
    const [bb, bs] = boardSortKey(b, nowMs);
    if (ab !== bb) return ab - bb;
    if (as !== bs) return as - bs;
    const an = a.short || a.name || a.id || '';
    const bn = b.short || b.name || b.id || '';
    if (an !== bn) return an < bn ? -1 : 1;
    return (a.id || '') < (b.id || '') ? -1 : 1;
  });
}

function boardSortKey(row, nowMs) {
  if (!row.day || row.status !== 'live' || !row.day.gaps?.length) return [2, 0];
  const og = openGap(row, nowMs);
  if (og) return [0, -(new Date(og.endDT).getTime() - nowMs)];
  const ng = nextGap(row, nowMs);
  if (ng) return [1, new Date(ng.startDT).getTime()];
  return [2, 0];
}

function openGap(row, nowMs) {
  if (!row.day) return null;
  return row.day.gaps.find((g) => nowMs >= new Date(g.startDT).getTime() && nowMs < new Date(g.endDT).getTime()) || null;
}

function nextGap(row, nowMs) {
  if (!row.day) return null;
  return row.day.gaps.find((g) => new Date(g.startDT).getTime() > nowMs) || null;
}

function roomOpenNow(row, nowMs) { return !!openGap(row, nowMs); }

function timeLeft(row, nowMs) {
  const og = openGap(row, nowMs);
  return og ? new Date(og.endDT).getTime() - nowMs : 0;
}

// ---- board data loading ----

function ensureBoardLoaded(offset) {
  const date = addDays(today, offset);
  if (boardCache.has(date) && !boardCache.get(date).error) return;
  if (boardInflight.has(date)) return boardInflight.get(date);
  const p = fetch(`/api/board?date=${date}`)
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then((data) => {
      boardCache.set(date, { date, rows: data.gyms });
      boardInflight.delete(date);
      if (view === 'board' && addDays(today, dayOffset) === date) renderBoard();
    })
    .catch((err) => {
      boardCache.set(date, { date, error: err.message });
      boardInflight.delete(date);
      if (view === 'board' && addDays(today, dayOffset) === date) renderBoard();
    });
  boardInflight.set(date, p);
  return p;
}

// ---- detail view ----

function renderDetailSlides() {
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
  const g = gym(currentGymId);
  if (!g) { slide.appendChild(h('div', { class: 'panel' })); return; }
  if (offset < 0 || offset > STRIP_DAYS - 1) {
    slide.appendChild(h('div', { class: 'panel' }));
    return;
  }
  const rec = g.status === 'coming-soon' ? null : getCachedDay(addDays(today, offset));
  slide.appendChild(buildDetailPanel(rec, offset, g));
}

function refreshDetailSlide(offset) {
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

function commitSwipe(offset) { setDayOffset(offset); }

function buildDetailPanel(rec, offset, g) {
  const panel = h('div', { class: 'panel' });
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
  const tz = g.tz || anchorTz;
  const nowMin = nowMinutesInTz(tz);
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

function nowState(day, t) {
  for (const g of day.gaps) {
    if (t >= g.start && t < g.end) return { kind: 'open', endsAt: g.end, remaining: g.end - t };
  }
  for (const e of day.events) {
    if (t >= e.start && t < e.end) {
      const nextG = day.gaps.find((g) => g.start >= e.end);
      return { kind: 'inClass', cls: e, until: e.end, nextGap: nextG };
    }
  }
  const nextG = day.gaps.find((g) => g.start > t);
  if (nextG) return { kind: 'upcoming', nextGap: nextG };
  return { kind: 'doneForDay' };
}

function heroToday(day, s, nowMin, g) {
  const short = g.short || g.name;
  const room = gymRoom(g).toLowerCase();

  if (s.kind === 'open') {
    return hero(
      'The floor is',
      heroHead(accent('Available'), br(), 'for the next', br(), accent(durStr(s.remaining), true)),
      sub(`${short}'s ${room} is class-free until `, strong(fmt12Long(s.endsAt)), '.'),
      heroFooter(`Now · ${fmt12Long(nowMin)}`, fmt12Long(s.endsAt)),
    );
  }
  if (s.kind === 'inClass') {
    const left = s.until - nowMin;
    return hero(
      'Right now · floor in use',
      heroHead(accent(s.cls.name), br(), `for ${durStr(left)} more`),
      s.nextGap
        ? sub('Floor opens at ', strong(fmt12Long(s.nextGap.start)), ` for ${durStr(s.nextGap.minutes)}.`)
        : sub('No more available windows today — see tomorrow below.'),
      heroFooter('In session', `ends ${fmt12(s.until)}`),
    );
  }
  if (s.kind === 'upcoming') {
    return hero(
      'Floor opens in',
      heroHead(accent(durStr(s.nextGap.start - nowMin)), ',', br(), `at ${fmt12(s.nextGap.start)}`),
      sub('First available window runs until ', strong(fmt12Long(s.nextGap.end)), '.'),
    );
  }

  // doneForDay — preview tomorrow's first window.
  const tomorrow = addDays(today, 1);
  const tRec = getCachedDay(tomorrow);
  const known = tRec && !tRec.error;
  if (!known) loadDay(tomorrow).then(() => refreshDetailSlide(0));
  const tFirst = known ? tRec.gaps[0] : null;

  let subEl;
  if (tFirst) subEl = sub(strong('Tomorrow'), ' opens at ', strong(fmt12Long(tFirst.start)), ` for ${durStr(tFirst.minutes)}.`);
  else if (known) subEl = sub("Tomorrow's studio is fully booked.");
  else subEl = sub("Checking tomorrow's schedule…");

  const node = hero(
    "That's a wrap on today",
    heroHead("Floor's ", accent('done'), br(), 'for tonight'),
    subEl,
  );
  if (tFirst) {
    const btn = h('button', { class: 'peek-btn', text: 'See tomorrow →', attrs: { type: 'button' } });
    btn.addEventListener('click', () => setDayOffset(1));
    node.appendChild(btn);
  }
  return node;
}

function heroOther(day) {
  const n = day.gaps.length;
  return hero(
    `${day.dowLong} · ${day.month} ${day.dom}`,
    heroHead(accent(durStr(day.totalOpenMin)), ' available', br(), 'across ', accent(String(n)), ` ${n === 1 ? 'window' : 'windows'}`),
    sub(`${day.events.length} ${day.events.length === 1 ? 'class' : 'classes'} on the floor.`),
  );
}

function comingSoonHero(g) {
  return hero(
    g.short || g.name,
    heroHead('Opening ', accent('soon')),
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
    dayCache.delete(`${currentGymId}:${rec.date}`);
    refreshDetailSlide(offset);
    ensureDayLoaded(offset);
  });
  node.appendChild(btn);
  return node;
}

function buildList(day, s, nowMin, isToday) {
  const list = h('div', { class: 'list' });
  let gaps = day.gaps;
  if (isToday && s) {
    if (s.kind === 'open') gaps = day.gaps.filter((g) => g.start > s.endsAt);
    else if (s.kind === 'inClass') gaps = day.gaps.filter((g) => g.start > s.until);
    else if (s.kind === 'upcoming') gaps = day.gaps.filter((g) => g.start >= s.nextGap.start);
    else if (s.kind === 'doneForDay') gaps = [];
  }

  if (isToday && s && s.kind === 'open' && gaps.length) list.appendChild(sectionTitle('Later today'));
  else if (isToday && s && s.kind === 'inClass' && gaps.length) list.appendChild(sectionTitle('After this class'));
  else if (!isToday && day.gaps.length) list.appendChild(sectionTitle('Available windows'));

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
      h('div', { class: 'window-meta', text: 'Available · between classes' }),
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

// ---- detail-day data loading ----

function cacheKey(date, id = currentGymId) { return `${id}:${date}`; }
function getCachedDay(date, id = currentGymId) { return dayCache.get(cacheKey(date, id)); }

function loadDay(date, id = currentGymId) {
  const key = cacheKey(date, id);
  if (dayCache.has(key)) return Promise.resolve(dayCache.get(key));
  if (dayInflight.has(key)) return dayInflight.get(key);

  const tz = gym(id)?.tz || anchorTz;
  const p = fetch(`/api/availability?gym=${encodeURIComponent(id)}&date=${date}`)
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then((data) => {
      const parsed = parseDay(data, date, tz);
      dayCache.set(key, parsed);
      dayInflight.delete(key);
      return parsed;
    })
    .catch((err) => {
      const rec = { error: err.message, date };
      dayCache.set(key, rec);
      dayInflight.delete(key);
      return rec;
    });
  dayInflight.set(key, p);
  return p;
}

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

async function ensureDayLoaded(offset) {
  if (offset < 0 || offset > STRIP_DAYS - 1) return;
  const g = gym(currentGymId);
  if (!g || g.status === 'coming-soon') return;
  const date = addDays(today, offset);
  if (getCachedDay(date)) return;
  const id = currentGymId;
  await loadDay(date, id);
  if (id === currentGymId) refreshDetailSlide(offset);
}

function prefetchNeighbors(offset) {
  ensureDayLoaded(offset - 1);
  ensureDayLoaded(offset + 1);
}

// ---- picker (detail's gym switcher) ----

function openPicker() {
  buildSheetList();
  els.sheetScrim.hidden = false;
  els.sheet.hidden = false;
  document.body.classList.add('has-sheet-open');
  requestAnimationFrame(() => {
    els.sheetScrim.classList.add('is-open');
    els.sheet.classList.add('is-open');
  });
}

function closePicker() {
  els.sheetScrim.classList.remove('is-open');
  els.sheet.classList.remove('is-open');
  document.body.classList.remove('has-sheet-open');
  window.setTimeout(() => {
    els.sheetScrim.hidden = true;
    els.sheet.hidden = true;
  }, 220);
}

function buildSheetList() {
  els.sheetList.innerHTML = '';
  const groups = [];
  const seen = new Map();
  for (const id of gymOrder) {
    const g = gyms.get(id);
    if (!g) continue;
    if (!seen.has(g.brand)) {
      seen.set(g.brand, groups.length);
      groups.push({ brand: g.brand, items: [] });
    }
    groups[seen.get(g.brand)].items.push(g);
  }
  for (const grp of groups) {
    els.sheetList.appendChild(h('div', { class: 'sheet-group-head', text: grp.brand }));
    for (const g of grp.items) {
      const active = g.id === currentGymId;
      const soon = g.status === 'coming-soon';
      const item = h('button', {
        class: `sheet-item${active ? ' is-active' : ''}${soon ? ' is-disabled' : ''}`,
        attrs: {
          type: 'button',
          'aria-current': active ? 'true' : 'false',
          ...(soon ? { 'aria-disabled': 'true', disabled: '' } : {}),
        },
      },
        h('span', { class: 'sheet-swatch', text: brandMark(g.brand) }),
        h('span', { class: 'sheet-name' },
          h('span', { class: 'sheet-short', text: g.short || g.name }),
          h('span', { class: 'sheet-hood', text: g.neighborhood || '' }),
        ),
        soon
          ? h('span', { class: 'sheet-soon', text: 'Coming soon' })
          : (active ? h('span', { class: 'sheet-check', text: 'Current' }) : null),
      );
      if (!soon) {
        item.addEventListener('click', () => {
          const d = dayOffset === 0 ? null : addDays(today, dayOffset);
          closePicker();
          navigate({ gymId: g.id, date: d });
        });
      }
      els.sheetList.appendChild(item);
    }
  }
}

// ---- helpers ----

function gym(id) { return gyms.get(id) || null; }

function brandMark(brand) {
  if (!brand) return '··';
  return BRAND_MARK[brand] || brand.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || brand.slice(0, 2).toUpperCase();
}

function gymRoom(g) { return g.room || (g.danceRooms && g.danceRooms[0]) || 'studio'; }

function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function nowMinutesInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

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

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const at = Date.UTC(ay, am - 1, ad);
  const bt = Date.UTC(by, bm - 1, bd);
  return Math.round((bt - at) / 86400000);
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

function fmt12(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2, '0')}${ampm}`;
}

function fmt12Long(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmt12Iso(iso, tz) { return fmt12(isoToMinutes(iso, tz)); }
function fmt12LongIso(iso, tz) { return fmt12Long(isoToMinutes(iso, tz)); }

function durStr(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
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
function strong(text) { return h('strong', { text }); }
function br() { return document.createElement('br'); }

function h(tag, opts = {}, ...kids) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
  for (const kid of kids) {
    if (kid == null) continue;
    if (typeof kid === 'string') node.appendChild(document.createTextNode(kid));
    else node.appendChild(kid);
  }
  return node;
}

// ---- "now" tick + midnight roll ----

function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (document.hidden) return;
    const t = todayInTz(view === 'detail' ? (gym(currentGymId)?.tz || anchorTz) : anchorTz);
    if (t !== today) {
      // Crossed midnight — rebuild around the new today; collapse to today.
      today = t;
      dayOffset = 0;
      buildDayStrip();
      if (view === 'board') {
        ensureBoardLoaded(0);
        renderBoard();
      } else {
        renderDetailSlides();
        ensureDayLoaded(0);
        prefetchNeighbors(0);
      }
      return;
    }
    if (dayOffset !== 0) return; // only "now" can change while we're on today
    if (view === 'board') renderBoard();
    else refreshDetailSlide(0);
  }, TICK_MS);
}

function showFatal(msg) {
  els.boardView.hidden = true;
  els.detailView.hidden = false;
  els.track.innerHTML = '';
  const slide = h('div', { class: 'slide' });
  slide.style.left = '0';
  slide.appendChild(h('div', { class: 'panel' },
    hero("Couldn't load", heroHead('Hmm', accent('.')), sub(msg)),
  ));
  els.track.appendChild(slide);
}

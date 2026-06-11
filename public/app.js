// Open Floor — brand-directory home + per-gym detail. Two views share one shell:
//
//   Board (/)         brand-directory home. The user picks "their" brand by
//                     starring its header; that brand is pinned open at the
//                     top, every other brand collapses to a one-line summary.
//                     The pinned choice persists in localStorage as
//                     `openFloor.myBrand`. The hero across the top stays
//                     scoped to every brand (it answers "anyone open right
//                     now?" globally, not just within your brand). Tapping a
//                     gym row drills into the detail view.
//
//   Detail (/?gym=X)  per-gym swipe deck (unchanged from the previous
//                     handoff). Top-row "back" returns to the directory; the
//                     bottom-sheet picker still lets you jump gyms inline.
//
// Both views share the same date strip, the same "now" tick, and the same
// /api/availability cache for per-day rooms. The board talks to /api/board,
// which folds all live gyms' open-floor summaries for a single date into one
// response (the server warms its weekly cache daily, so this is a cache hit
// in steady state). See design_handoff_brand_directory/README.md for the
// design tokens, exact measurements, and the persistence contract.

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
  // Board view (brand directory).
  boardView: document.getElementById('boardView'),
  boardHero: document.getElementById('boardHero'),
  boardList: document.getElementById('boardList'),
  boardFooter: document.getElementById('boardFooter'),
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

// Persistence contract: `localStorage["openFloor.myBrands"]` holds a JSON
// array of pinned brand names exactly as they appear in /api/gyms, e.g.
// `["Gold's Gym", "Crunch"]`. 0..N entries are valid:
//   - missing / parse error / non-array → default to [DEFAULT_BRAND] on the
//                                          first ever load (preserves the
//                                          README's "Gold's pinned by
//                                          default" contract).
//   - []                                 → explicitly nothing pinned. Hero
//                                          covers every brand, every group
//                                          starts expanded.
//   - one entry                          → that brand pinned. Hero scopes
//                                          to it; other groups start
//                                          collapsed.
//   - many entries                       → all pinned. Hero scopes to the
//                                          union of those brands' floors;
//                                          non-pinned groups start
//                                          collapsed.
// Reads/writes are wrapped in try/catch for private-mode browsers. Unknown
// stored brands are dropped from the loaded set (defensive against gym
// removals). The older singular `openFloor.myBrand` key is migrated once
// (string → array of one) so existing pins survive the rollout.
const MY_BRANDS_KEY = 'openFloor.myBrands';
const LEGACY_BRAND_KEY = 'openFloor.myBrand';
const DEFAULT_BRAND = "Gold's Gym";

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

// Brand-directory state. `myBrands` is the user's pinned set (persisted —
// 0..N brands); `brandCollapsed` tracks which groups are currently folded
// (session-only). `brandOrder` is the brand-rendering order, derived once
// we have data: pinned brands first (registry-order), then every other
// brand (also registry-order).
const myBrands = new Set();
const brandCollapsed = new Set();
let brandOrder = [];
// Registry order from /api/gyms — preserved separately so we can rebuild
// `brandOrder` whenever the pinned set changes.
let apiBrandOrder = [];

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

  // Brand registry-order from the API (deterministic per server-side sort).
  // Pick the user's saved pinned set; if empty, every group starts
  // expanded and the hero covers all brands. Otherwise pinned brands are
  // first (registry order, all expanded) and the rest start collapsed.
  apiBrandOrder = [];
  for (const g of data.gyms) if (!apiBrandOrder.includes(g.brand)) apiBrandOrder.push(g.brand);
  for (const b of loadMyBrands(apiBrandOrder, [DEFAULT_BRAND])) myBrands.add(b);
  brandOrder = orderBrandsPinnedFirst(apiBrandOrder, myBrands);
  if (myBrands.size > 0) {
    for (const b of apiBrandOrder) if (!myBrands.has(b)) brandCollapsed.add(b);
  }

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
    // Prefetch every strip-day in parallel. The server anchors its cache on
    // each gym's local today, so all 7 day-requests coalesce to one upstream
    // fetch per gym — making chip clicks instant once warm.
    prefetchBoardWeek();
  } else {
    els.boardView.hidden = true;
    els.detailView.hidden = false;
    const g = gym(currentGymId);
    els.sourceLink.href = g?.sourceUrl || '#';
    els.sourceLink.textContent = `${g?.sourceHost || 'source'} ↗`;
    renderDetailSlides();
    // Same idea for detail: pull the whole strip up front so swiping /
    // chip-clicks are instant. Server-side caching means one upstream call.
    prefetchDetailWeek();
  }
}

function prefetchBoardWeek() {
  for (let i = 0; i < STRIP_DAYS; i++) ensureBoardLoaded(i);
}

function prefetchDetailWeek() {
  for (let i = 0; i < STRIP_DAYS; i++) ensureDayLoaded(i);
}

function renderTopRow() {
  els.topRow.innerHTML = '';
  if (view === 'board') {
    // Brand-directory home: left = "OPEN FLOOR" wordmark, right = brand /
    // floor counts ("4 brands · 11 floors"). Both mono, 10.5px, uppercase.
    const liveCount = [...gyms.values()].filter((g) => g.status === 'live').length;
    const totalCount = gyms.size;
    const floors = totalCount === 1 ? '1 floor' : `${totalCount} floors`;
    const brands = brandOrder.length === 1 ? '1 brand' : `${brandOrder.length} brands`;
    els.topRow.appendChild(h('span', { class: 'top-row__wordmark', text: 'Open Floor' }));
    els.topRow.appendChild(h('span', {
      class: 'top-row__meta',
      text: `${brands} · ${floors}`,
      attrs: { 'aria-label': `${brandOrder.length} brands, ${liveCount} live of ${totalCount} total floors` },
    }));
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

// ---- board view (brand directory) ----

function renderBoard() {
  const date = addDays(today, dayOffset);
  const rec = boardCache.get(date);
  const isToday = dayOffset === 0;

  if (!rec) {
    els.boardHero.innerHTML = '';
    els.boardHero.appendChild(boardMessageHero('Reading every floor', 'One sec'));
    els.boardList.innerHTML = '';
    renderBoardFooter();
    return;
  }
  if (rec.error) {
    els.boardHero.innerHTML = '';
    els.boardHero.appendChild(boardMessageHero(rec.error, "Couldn't load the board"));
    els.boardList.innerHTML = '';
    renderBoardFooter();
    return;
  }

  const tz = anchorTz;
  const nowMs = Date.now();
  // The /api/board response already returns rows in deterministic
  // [brand, short, id] order (lib/board.js sortBoardRows). Decorate each row
  // with its typed status so the hero and within-group sort share one
  // computation — and so we don't have to re-walk `day.gaps` from the
  // template path.
  const decorated = rec.rows.map((row) => ({ row, st: gymStatus(row, nowMs, isToday) }));

  // Hero. Scope to the pinned brands when 1+ are set so the headline
  // answers "what's open in MY brands right now?" instead of broadcasting
  // across the city. Falls back to the all-brands hero when myBrands is
  // empty (the user explicitly un-pinned everything).
  const heroRows = myBrands.size > 0
    ? decorated.filter((r) => myBrands.has(r.row.brand))
    : decorated;
  els.boardHero.innerHTML = '';
  els.boardHero.appendChild(buildBoardHero(heroRows, isToday, nowMs, tz, date, scopeBrandName()));

  // Brand-grouped accordion.
  els.boardList.innerHTML = '';
  for (const brand of brandOrder) {
    const groupRows = decorated.filter((r) => r.row.brand === brand);
    if (!groupRows.length) continue;
    // Within a group: open-now (most time left first) → opens-later
    // (soonest first) → done / no-time last. Matches README spec.
    groupRows.sort((a, b) => statusRank(a.st) - statusRank(b.st) || statusTiebreak(a.st, b.st));
    els.boardList.appendChild(buildBrandGroupHeader(brand, groupRows, isToday));
    if (!brandCollapsed.has(brand)) {
      for (const { row, st } of groupRows) {
        els.boardList.appendChild(buildGymRow(row, st, tz));
      }
    }
  }

  renderBoardFooter();
}

// Per-gym typed status. `other` is the non-today branch; the today branch
// distinguishes between actively-open / class-blocking / opening-later /
// done so the hero and row UIs can speak in the right tense.
function gymStatus(row, nowMs, isToday) {
  if (row.status === 'coming-soon') return { kind: 'soon' };
  if (row.error || !row.day) return { kind: 'error' };
  if (!isToday) {
    const gaps = row.day.gaps || [];
    return {
      kind: 'other',
      totalOpenMin: row.day.totalOpenMin || 0,
      windowCount: row.day.windowCount || gaps.length,
      first: gaps[0] || null,
    };
  }
  const gaps = row.day.gaps || [];
  for (const g of gaps) {
    const start = new Date(g.startDT).getTime();
    const end = new Date(g.endDT).getTime();
    if (nowMs >= start && nowMs < end) {
      return { kind: 'open', remainingMs: end - nowMs, endDT: g.endDT, gap: g };
    }
  }
  const events = row.day.events || [];
  for (const e of events) {
    const start = new Date(e.startDT).getTime();
    const end = new Date(e.endDT).getTime();
    if (nowMs >= start && nowMs < end) {
      const nextGap = gaps.find((g) => new Date(g.startDT).getTime() >= end) || null;
      return { kind: 'inClass', cls: e, until: end, nextGap };
    }
  }
  const next = gaps.find((g) => new Date(g.startDT).getTime() > nowMs);
  if (next) return { kind: 'upcoming', nextGap: next };
  return { kind: 'done' };
}

function statusRank(st) {
  if (st.kind === 'open') return 0;
  if (st.kind === 'upcoming' || st.kind === 'inClass') return 1;
  if (st.kind === 'other') return st.windowCount > 0 ? 0 : 2;
  return 2; // done / error / soon
}

function statusTiebreak(a, b) {
  // Among "open" rows, most time left first. Among "upcoming/inClass", soonest
  // start first. Among "other" rows with time, most total time first.
  if (a.kind === 'open' && b.kind === 'open') return b.remainingMs - a.remainingMs;
  if (a.kind === 'upcoming' && b.kind === 'upcoming')
    return new Date(a.nextGap.startDT) - new Date(b.nextGap.startDT);
  if (a.kind === 'inClass' && b.kind === 'inClass') return a.until - b.until;
  if (a.kind === 'other' && b.kind === 'other') return b.totalOpenMin - a.totalOpenMin;
  return 0;
}

// Hero: answer-first "X floors open right now" / "No floor open for ⟨dur⟩" /
// "Every floor's done for tonight." (today branch), or
// "⟨n⟩ of ⟨m⟩ floors have open time." (other-day branch).
function buildBoardHero(decorated, isToday, nowMs, tz, date, scopeBrand) {
  const live = decorated.filter(({ row }) => row.status === 'live' && row.day);
  // Noun chunks. Use a hero-shortened brand label so a long registry name
  // ("Gold's Gym") collapses to the colloquial form ("Gold's") in 74px
  // display copy — keeps "N {brand} floor / open right now." to two
  // lines on narrow phones. When no brand or multiple brands are pinned
  // we drop the brand from the headline and fall back to "floor"/"floors".
  const brandShort = heroBrandLabel(scopeBrand);
  const nounSingular = brandShort ? `${brandShort} floor` : 'floor';
  const nounPlural = brandShort ? `${brandShort} floors` : 'floors';
  const possessive = brandShort ? `Every ${brandShort} floor's` : "Every floor's";

  if (isToday) {
    const openNow = live.filter(({ st }) => st.kind === 'open');
    const nowLabel = fmt12Long(nowMinutesInTz(tz));
    if (openNow.length) {
      // Best bet = the open floor with the most time left right now.
      const best = openNow.reduce((a, b) => (a.st.remainingMs >= b.st.remainingMs ? a : b));
      const remainingMin = Math.round(best.st.remainingMs / 60000);
      return hero(
        `Right now · ${nowLabel}`,
        heroHead(
          accent(String(openNow.length)),
          ' ',
          openNow.length === 1 ? nounSingular : nounPlural,
          br(),
          'open right now.',
        ),
        sub(
          'Best bet: ',
          strong(bestBetLabel(best.row, scopeBrand)),
          ' — free for ',
          strong(durStr(remainingMin)),
          ', until ',
          strong(fmt12LongIso(best.st.endDT, tz)),
          '.',
        ),
      );
    }
    // Nobody open now — find the soonest upcoming start (gap start, or
    // post-class gap if currently in-class).
    const soon = live
      .map(({ row, st }) => {
        if (st.kind === 'upcoming') return { row, when: new Date(st.nextGap.startDT).getTime(), startDT: st.nextGap.startDT };
        if (st.kind === 'inClass' && st.nextGap) return { row, when: new Date(st.nextGap.startDT).getTime(), startDT: st.nextGap.startDT };
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.when - b.when)[0];
    if (soon) {
      const waitMin = Math.max(0, Math.round((soon.when - nowMs) / 60000));
      return hero(
        `Right now · ${nowLabel}`,
        heroHead('No ', nounSingular, ' open', br(), 'for ', accent(durStr(waitMin)), '.'),
        sub(
          'Next up: ',
          strong(bestBetLabel(soon.row, scopeBrand)),
          ' opens at ',
          strong(fmt12LongIso(soon.startDT, tz)),
          '.',
        ),
      );
    }
    return hero(
      `Right now · ${nowLabel}`,
      heroHead(possessive, ' ', accent('done'), br(), 'for tonight.'),
      sub('Check tomorrow — schedules refresh overnight.'),
    );
  }

  // Other-day branch.
  const withOpen = live.filter(({ st }) => st.kind === 'other' && st.windowCount > 0);
  const totalMin = live.reduce((s, { st }) => s + (st.kind === 'other' ? st.totalOpenMin : 0), 0);
  const p = dateParts(date);
  return hero(
    `${p.dowLong} · ${p.month} ${p.dom}`,
    heroHead(
      accent(String(withOpen.length)),
      ' of ',
      String(live.length),
      ' ',
      live.length === 1 ? nounSingular : nounPlural,
      br(),
      'have open time.',
    ),
    sub(strong(durStr(totalMin)), ' of practice time — tap a floor for its windows.'),
  );
}

// Best-bet / next-up label: drop the leading brand once the hero is already
// brand-scoped (saying "Gold's Gym Highland" inside a Gold's-scoped hero
// would be redundant); otherwise keep the brand prefix.
function bestBetLabel(row, scopeBrand) {
  const short = (row.short || row.name || '').trim();
  if (scopeBrand && row.brand === scopeBrand) return short;
  return `${row.brand || ''} ${short}`.trim();
}

// Hero-shortened brand label. "Gold's Gym" collapses to "Gold's" so the
// 74px hero headline can carry "1 Gold's floor / open right now." in two
// lines on narrow phones. Everywhere else (group header, footer, picker)
// the registry's full brand name is used.
function heroBrandLabel(brand) {
  if (!brand) return null;
  return brand.replace(/ Gym$/, '');
}

function buildBrandGroupHeader(brand, groupRows, isToday) {
  const isMine = myBrands.has(brand);
  const isCollapsed = brandCollapsed.has(brand);
  const liveRows = groupRows.filter(({ row }) => row.status === 'live' && row.day);
  const openish = liveRows.filter(({ st }) => st.kind === 'open' || (st.kind === 'other' && st.windowCount > 0)).length;
  const metaText = isToday
    ? `${openish} of ${liveRows.length} open`
    : `${openish} of ${liveRows.length} with time`;

  const head = h('button', {
    class: `brand-head${isCollapsed ? ' is-collapsed' : ''}`,
    attrs: {
      type: 'button',
      'aria-expanded': String(!isCollapsed),
      'aria-label': `${brand} — ${metaText}. Tap to ${isCollapsed ? 'expand' : 'collapse'}.`,
    },
  });

  head.appendChild(h('span', { class: 'brand-head__swatch', attrs: { 'aria-hidden': 'true' }, text: brandMark(brand) }));

  const name = h('span', { class: 'brand-head__name' },
    document.createTextNode(brand),
  );
  if (isMine) name.appendChild(h('span', { class: 'brand-head__yours', text: 'Yours' }));
  head.appendChild(name);

  head.appendChild(h('span', { class: 'brand-head__meta', text: metaText }));

  // Star toggles this brand in/out of the pinned set — `stopPropagation`
  // so the same tap doesn't collapse the group. Any 0..N brands can be
  // pinned: tap ☆ to add, tap ★ to remove. When the set hits empty,
  // every group expands and the hero re-scopes to all floors.
  const star = h('span', {
    class: `brand-head__star${isMine ? ' is-yours' : ''}`,
    attrs: {
      role: 'button',
      tabindex: '0',
      'aria-pressed': String(isMine),
      'aria-label': isMine ? `Unpin ${brand}` : `Pin ${brand}`,
      title: isMine ? 'Tap to unpin' : 'Make this one of yours',
    },
    text: isMine ? '★' : '☆',
  });
  const onStar = () => { toggleMyBrand(brand); };
  star.addEventListener('click', (e) => { e.stopPropagation(); onStar(); });
  star.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onStar();
  });
  head.appendChild(star);

  head.appendChild(h('span', { class: 'brand-head__chev', attrs: { 'aria-hidden': 'true' }, text: '▸' }));

  head.addEventListener('click', () => toggleBrand(brand));
  return head;
}

function buildGymRow(row, st, tz) {
  const isOpen = st.kind === 'open';
  const isSoon = st.kind === 'soon';
  const dim = st.kind === 'done' || st.kind === 'error' || st.kind === 'soon'
    || (st.kind === 'other' && (!st.windowCount || st.windowCount === 0));

  const node = h('button', {
    class: `gym-row${isOpen ? ' is-open' : ''}${dim ? ' is-dim' : ''}${isSoon ? ' is-soon' : ''}`,
    attrs: {
      type: 'button', role: 'listitem',
      'aria-label': `${row.brand || ''} ${row.short || row.name || ''}`.trim(),
    },
  });

  node.appendChild(h('span', {
    class: 'gym-row__swatch',
    attrs: { 'aria-hidden': 'true' },
    text: brandMark(row.brand),
  }));

  const status = rowStatusLine(st, tz);
  const statusEl = h('span', { class: `gym-row__status${status.live ? ' is-live' : ''}` });
  if (status.live) statusEl.appendChild(h('span', { class: 'gym-row__live-dot', attrs: { 'aria-hidden': 'true' } }));
  statusEl.appendChild(document.createTextNode(status.text));

  node.appendChild(h('span', { class: 'gym-row__name' },
    h('span', { class: 'gym-row__short', text: row.short || row.name || '' }),
    statusEl,
  ));

  const m = rowMetric(st, tz);
  node.appendChild(h('span', { class: 'gym-row__metric' },
    h('span', { class: `gym-row__metric-num${m.muted ? ' is-muted' : ''}`, text: m.num }),
    h('span', { class: 'gym-row__metric-label', text: m.label }),
  ));

  if (isSoon) {
    node.disabled = true;
  } else {
    node.addEventListener('click', () => {
      const d = dayOffset === 0 ? null : addDays(today, dayOffset);
      navigate({ gymId: row.id, date: d });
    });
  }
  return node;
}

// Status-line and metric phrasing per the design spec. Live=true puts the
// row's status line in accent green with a 6px accent dot — only for "open
// now". The metric label is always mono 9px uppercase.
function rowStatusLine(st, tz) {
  if (st.kind === 'open')
    return { text: `Open now · until ${fmt12LongIso(st.endDT, tz)}`, live: true };
  if (st.kind === 'upcoming')
    return { text: `Opens ${fmt12LongIso(st.nextGap.startDT, tz)} · ${durStr(st.nextGap.minutes)} free`, live: false };
  if (st.kind === 'inClass')
    return { text: `${st.cls.name} on the floor`, live: false };
  if (st.kind === 'other')
    return st.windowCount > 0
      ? { text: `First window ${fmt12LongIso(st.first.startDT, tz)}`, live: false }
      : { text: 'Studio fully booked', live: false };
  if (st.kind === 'soon') return { text: 'Coming soon', live: false };
  if (st.kind === 'error') return { text: "Couldn't read schedule", live: false };
  return { text: 'Done for today', live: false };
}

function rowMetric(st, tz) {
  if (st.kind === 'open') {
    const min = Math.max(0, Math.round(st.remainingMs / 60000));
    return { num: durStr(min), label: 'open now', muted: false };
  }
  if (st.kind === 'upcoming')
    return { num: fmt12Iso(st.nextGap.startDT, tz), label: 'opens', muted: true };
  if (st.kind === 'inClass')
    return st.nextGap
      ? { num: fmt12Iso(st.nextGap.startDT, tz), label: 'free at', muted: true }
      : { num: '—', label: 'in class', muted: true };
  if (st.kind === 'other') {
    if (st.windowCount > 0) {
      const noun = st.windowCount === 1 ? 'window' : 'windows';
      return { num: durStr(st.totalOpenMin), label: `${st.windowCount} ${noun}`, muted: false };
    }
    return { num: '—', label: 'no time', muted: true };
  }
  if (st.kind === 'soon') return { num: '—', label: 'soon', muted: true };
  if (st.kind === 'error') return { num: '—', label: 'unknown', muted: true };
  return { num: '—', label: 'done', muted: true };
}

function renderBoardFooter() {
  els.boardFooter.innerHTML = '';
  const list = pinnedBrandList();
  if (list.length === 0) {
    els.boardFooter.appendChild(h('span', { class: 'board-footer__pinned', text: 'No brand pinned' }));
    els.boardFooter.appendChild(h('span', { class: 'board-footer__hint', text: 'Tap ☆ to pin one' }));
    return;
  }
  // Compact "★ Gold's Gym, Crunch · saved on this device" — relies on the
  // footer's ellipsis fallback when the brand list outruns the row.
  els.boardFooter.appendChild(h('span', {
    class: 'board-footer__pinned',
    text: `★ ${list.join(', ')} · saved on this device`,
  }));
  els.boardFooter.appendChild(h('span', {
    class: 'board-footer__hint',
    text: list.length === 1 ? 'Tap ★ to unpin' : 'Tap ★ to unpin one',
  }));
}

function boardMessageHero(headText, eyebrowText) {
  return hero(eyebrowText, heroHead(accent(headText)));
}

// ---- brand-directory state helpers ----

// Load the persisted pinned set. Three possibilities, in order:
//   1. New plural key `openFloor.myBrands` holds a JSON array → use it
//      (dropping any brands that aren't currently in the registry).
//   2. Legacy `openFloor.myBrand` holds a single brand string → migrate it
//      into the array key (one entry; empty string means "un-pinned").
//   3. Neither key → first-ever load; return the README-default fallback
//      (one entry: Gold's Gym).
function loadMyBrands(allBrands, fallback) {
  try {
    const raw = localStorage.getItem(MY_BRANDS_KEY);
    if (raw != null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((b) => typeof b === 'string' && allBrands.includes(b));
      }
    }
    // Migrate from the singular key if it's the only thing we have.
    const legacy = localStorage.getItem(LEGACY_BRAND_KEY);
    if (legacy != null) {
      const migrated = legacy === '' ? []
        : (allBrands.includes(legacy) ? [legacy] : []);
      try {
        localStorage.setItem(MY_BRANDS_KEY, JSON.stringify(migrated));
        localStorage.removeItem(LEGACY_BRAND_KEY);
      } catch (_e) { /* ignore */ }
      return migrated;
    }
  } catch (_e) { /* private mode, bad JSON, etc. */ }
  return (fallback || []).filter((b) => allBrands.includes(b));
}

function saveMyBrands() {
  try { localStorage.setItem(MY_BRANDS_KEY, JSON.stringify(pinnedBrandList())); } catch (_e) { /* ignore */ }
}

// Toggle one brand in/out of the pinned set. After every toggle we re-sync
// the collapse state to match the prototype's spec: with 1+ pinned, ONLY
// pinned groups are expanded (every other group collapses to its one-line
// summary); with 0 pinned, every group expands so the directory matches
// the all-brands hero. This overrides any manual chevron-taps the user
// made between pin operations — the invariant is "pinned ⇔ expanded".
function toggleMyBrand(brand) {
  if (myBrands.has(brand)) myBrands.delete(brand);
  else myBrands.add(brand);
  saveMyBrands();
  brandOrder = orderBrandsPinnedFirst(apiBrandOrder, myBrands);
  brandCollapsed.clear();
  if (myBrands.size > 0) {
    for (const b of apiBrandOrder) if (!myBrands.has(b)) brandCollapsed.add(b);
  }
  renderBoard();
}

// Brand name the hero should weave into its copy ("5 Gold's floors open…").
// Only meaningful when exactly one brand is pinned — with 0 or 2+ pinned,
// the hero stays generic ("5 floors open…") and the scope is implicit.
function scopeBrandName() {
  return myBrands.size === 1 ? [...myBrands][0] : null;
}

// Pinned brands rendered in registry order (stable across sessions).
function pinnedBrandList() {
  return apiBrandOrder.filter((b) => myBrands.has(b));
}

function toggleBrand(brand) {
  if (brandCollapsed.has(brand)) brandCollapsed.delete(brand);
  else brandCollapsed.add(brand);
  renderBoard();
}

// Registry-order pinned brands first, then registry-order unpinned brands.
// `pinned` is a Set so we keep the order from `brands` (the API order)
// rather than insertion order into the set.
function orderBrandsPinnedFirst(brands, pinned) {
  if (!pinned || pinned.size === 0) return brands.slice();
  const head = brands.filter((b) => pinned.has(b));
  const tail = brands.filter((b) => !pinned.has(b));
  return [...head, ...tail];
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
        renderBoard();
        prefetchBoardWeek();
      } else {
        renderDetailSlides();
        prefetchDetailWeek();
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

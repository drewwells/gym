const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeBoardDay, sortBoardRows, BRAND_PRIORITY } = require('../lib/board');

const GYM = {
  id: 'test',
  tz: 'America/Chicago',
  danceRooms: ['Studio'],
  usableWindow: { start: '06:00', end: '22:00' },
  minGapMinutes: 30,
};
const DATE = '2026-05-25'; // Monday, CDT (UTC-5)
const LOCAL_MIDNIGHT_UTC = Date.UTC(2026, 4, 25, 5, 0, 0);
function ev(room, startLocalH, endLocalH, { danceSuitable = true, date = DATE, name } = {}) {
  const z = (h) => new Date(LOCAL_MIDNIGHT_UTC + h * 3600000).toISOString();
  return {
    name: name || `${room} ${startLocalH}-${endLocalH}`,
    room,
    danceSuitable,
    occurrenceDate: date,
    startDT: z(startLocalH),
    endDT: z(endLocalH),
  };
}
test('summarizeBoardDay: empty events → one full-day window, 960 min open', () => {
  const s = summarizeBoardDay([], GYM, DATE);
  assert.equal(s.date, DATE);
  assert.equal(s.windowCount, 1);
  assert.equal(s.totalOpenMin, 16 * 60);
  assert.equal(s.gaps.length, 1);
  assert.equal(s.events.length, 0);
});

test('summarizeBoardDay: one mid-day class produces two gaps, no events lost', () => {
  const s = summarizeBoardDay([ev('Studio', 12, 13, { name: 'Yoga' })], GYM, DATE);
  assert.equal(s.windowCount, 2);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].name, 'Yoga');
  assert.equal(s.totalOpenMin, 15 * 60); // 6h + 9h
  // gaps sorted ascending by start.
  assert.ok(new Date(s.gaps[0].startDT) < new Date(s.gaps[1].startDT));
});

test('summarizeBoardDay: classes in non-dance rooms do not block the floor', () => {
  const s = summarizeBoardDay(
    [ev('Climbing', 12, 13, { danceSuitable: false })],
    GYM, DATE,
  );
  assert.equal(s.windowCount, 1);
  assert.equal(s.events.length, 0);
});

test('summarizeBoardDay: multi-room gym merges gaps + events across dance rooms', () => {
  const multi = { ...GYM, danceRooms: ['StudioA', 'StudioB'] };
  const evs = [
    ev('StudioA', 10, 11, { name: 'Yoga A' }),
    ev('StudioB', 14, 15, { name: 'Pilates B' }),
  ];
  const s = summarizeBoardDay(evs, multi, DATE);
  // Two rooms each produce their own gap list (12h + 16h split etc.); the
  // summarizer concatenates and sorts. We only assert merging happened and
  // class names from both rooms are preserved + ordered.
  assert.equal(s.events.length, 2);
  assert.equal(s.events[0].name, 'Yoga A');
  assert.equal(s.events[1].name, 'Pilates B');
  assert.ok(s.gaps.length >= 2);
});

// ---- sort ordering ----
// The home-board groups rows by brand in a fixed priority (Crunch → Gold's
// Gym → LA Fitness, then any other brand alphabetically), and within each
// brand sorts alphabetically by `short` (the location label). Openness is
// surfaced via badges/hero but no longer affects ordering — so the same gym
// sits in the same slot all day long.

function brandRow(brand, short, id) {
  return { gymId: id, id, brand, short, status: 'live', day: { gaps: [], events: [], totalOpenMin: 0, windowCount: 0 } };
}

test('BRAND_PRIORITY pins Crunch → Gold\'s Gym → LA Fitness', () => {
  assert.deepEqual(BRAND_PRIORITY, ["Crunch", "Gold's Gym", 'LA Fitness']);
});

test('sortBoardRows groups by brand priority across brands', () => {
  const rows = [
    brandRow('LA Fitness', 'Round Rock', 'laf-rr'),
    brandRow("Gold's Gym", 'Highland', 'g-h'),
    brandRow('Crunch', 'South Austin', 'c-sa'),
  ];
  const sorted = sortBoardRows(rows.slice(), 0);
  assert.deepEqual(sorted.map((r) => r.brand), ['Crunch', "Gold's Gym", 'LA Fitness']);
});

test('sortBoardRows: within a brand, rows sort alphabetically by short', () => {
  const rows = [
    brandRow("Gold's Gym", 'South Central', 'g-sc'),
    brandRow("Gold's Gym", 'Anderson Arbor', 'g-aa'),
    brandRow("Gold's Gym", 'Highland', 'g-h'),
  ];
  const sorted = sortBoardRows(rows.slice(), 0);
  assert.deepEqual(sorted.map((r) => r.short), ['Anderson Arbor', 'Highland', 'South Central']);
});

test('sortBoardRows: brands outside BRAND_PRIORITY sort after the named ones', () => {
  const rows = [
    brandRow('Crux', 'Central', 'crux-c'),
    brandRow('Crunch', 'Round Rock', 'c-rr'),
    brandRow('LA Fitness', 'Anderson Lane', 'laf-al'),
    brandRow("Gold's Gym", 'Anderson Arbor', 'g-aa'),
  ];
  const sorted = sortBoardRows(rows.slice(), 0);
  assert.deepEqual(sorted.map((r) => r.brand), ['Crunch', "Gold's Gym", 'LA Fitness', 'Crux']);
});

test('sortBoardRows: case-insensitive short sort, deterministic id tiebreak', () => {
  const rows = [
    brandRow('Crunch', 'south austin', 'c-2'),
    brandRow('Crunch', 'South Austin', 'c-1'),
    brandRow('Crunch', 'North ATX', 'c-n'),
  ];
  const sorted = sortBoardRows(rows.slice(), 0);
  // North < South (case-insensitive); the two "south austin" rows fall back
  // to id order (c-1 before c-2).
  assert.deepEqual(sorted.map((r) => r.id), ['c-n', 'c-1', 'c-2']);
});

test('sortBoardRows: ordering ignores day/openness — coming-soon stays in brand slot', () => {
  const rows = [
    { ...brandRow("Gold's Gym", 'Highland', 'g-h'), day: { gaps: [], events: [], totalOpenMin: 0, windowCount: 0 } },
    { ...brandRow('Crunch', 'North ATX', 'c-n'), status: 'coming-soon', day: null },
    { ...brandRow('Crunch', 'Round Rock', 'c-rr'), day: { gaps: [], events: [], totalOpenMin: 0, windowCount: 0 } },
  ];
  const sorted = sortBoardRows(rows.slice(), 0);
  // Crunch's coming-soon row stays grouped with Crunch's live row by brand,
  // then alphabetical within: "North ATX" < "Round Rock". Gold's follows.
  assert.deepEqual(sorted.map((r) => r.id), ['c-n', 'c-rr', 'g-h']);
});

test('sortBoardRows: full registry-shape sort produces the expected board order', () => {
  // Mirrors the actual prod gym set (post South Central add) — verifies the
  // final ordering users see on the home board.
  const rows = [
    brandRow('Crux', 'Central', 'crux-central'),
    brandRow('Crunch', 'Round Rock', 'crunch-round-rock'),
    brandRow('Crunch', 'South Austin', 'crunch-south-austin'),
    brandRow('Crunch', 'North ATX', 'crunch-north-atx'),
    brandRow('LA Fitness', 'Round Rock', 'lafitness-round-rock'),
    brandRow('LA Fitness', 'Anderson Lane', 'lafitness-anderson-lane'),
    brandRow("Gold's Gym", 'Anderson Arbor', 'golds-anderson-arbor'),
    brandRow("Gold's Gym", 'Highland', 'golds-highland'),
    brandRow("Gold's Gym", 'South Central', 'golds-south-central'),
  ];
  const sorted = sortBoardRows(rows.slice(), 0);
  assert.deepEqual(sorted.map((r) => r.id), [
    // Crunch — alpha by short
    'crunch-north-atx',
    'crunch-round-rock',
    'crunch-south-austin',
    // Gold's — alpha by short
    'golds-anderson-arbor',
    'golds-highland',
    'golds-south-central',
    // LA Fitness — alpha by short
    'lafitness-anderson-lane',
    'lafitness-round-rock',
    // Other brands last
    'crux-central',
  ]);
});

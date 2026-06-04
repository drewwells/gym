const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeBoardDay, boardSortKey, sortBoardRows } = require('../lib/board');

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
// UTC ms for a Chicago local hour on DATE.
const local = (h) => LOCAL_MIDNIGHT_UTC + h * 3600000;

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

// ---- sort ranking ----

function row(opts = {}) {
  return {
    gymId: opts.gymId || 'g',
    short: opts.short || 'g',
    status: opts.status || 'live',
    day: opts.day !== undefined ? opts.day : { gaps: [], events: [], totalOpenMin: 0, windowCount: 0 },
  };
}
function gap(startH, endH) {
  return {
    startDT: new Date(local(startH)).toISOString(),
    endDT: new Date(local(endH)).toISOString(),
    minutes: (endH - startH) * 60,
  };
}

test('boardSortKey: open-now sorts before opening-later sorts before done', () => {
  const now = local(12); // noon CT
  const openNow = row({ gymId: 'a', day: { gaps: [gap(11, 13)], events: [], totalOpenMin: 120, windowCount: 1 } });
  const later   = row({ gymId: 'b', day: { gaps: [gap(15, 16)], events: [], totalOpenMin: 60, windowCount: 1 } });
  const done    = row({ gymId: 'c', day: { gaps: [gap(8, 9)],   events: [], totalOpenMin: 60, windowCount: 1 } });

  const [oa] = boardSortKey(openNow, now);
  const [lb] = boardSortKey(later, now);
  const [dc] = boardSortKey(done, now);
  assert.equal(oa, 0);
  assert.equal(lb, 1);
  assert.equal(dc, 2);
});

test('boardSortKey: among open-now rows, more time-left ranks first', () => {
  const now = local(12);
  const longest = row({ gymId: 'l', day: { gaps: [gap(11, 18)], events: [], totalOpenMin: 7 * 60, windowCount: 1 } });
  const shortest = row({ gymId: 's', day: { gaps: [gap(11, 13)], events: [], totalOpenMin: 2 * 60, windowCount: 1 } });

  const sorted = sortBoardRows([shortest, longest], now);
  assert.equal(sorted[0].gymId, 'l', 'longer remaining should come first');
  assert.equal(sorted[1].gymId, 's');
});

test('boardSortKey: among opening-later rows, soonest start ranks first', () => {
  const now = local(12);
  const sooner = row({ gymId: 'soon', day: { gaps: [gap(13, 14)], events: [], totalOpenMin: 60, windowCount: 1 } });
  const later  = row({ gymId: 'late', day: { gaps: [gap(17, 20)], events: [], totalOpenMin: 180, windowCount: 1 } });

  const sorted = sortBoardRows([later, sooner], now);
  assert.equal(sorted[0].gymId, 'soon');
  assert.equal(sorted[1].gymId, 'late');
});

test('boardSortKey: coming-soon + null day always sort into the done bucket', () => {
  const now = local(12);
  const soon = row({ gymId: 'cs', status: 'coming-soon', day: null });
  const empty = row({ gymId: 'noop', day: { gaps: [], events: [], totalOpenMin: 0, windowCount: 0 } });
  assert.equal(boardSortKey(soon, now)[0], 2);
  assert.equal(boardSortKey(empty, now)[0], 2);
});

test('sortBoardRows: full mixed bucket sort with stable ordering', () => {
  const now = local(12);
  const rows = [
    row({ gymId: 'z-done', day: { gaps: [], events: [], totalOpenMin: 0, windowCount: 0 } }),
    row({ gymId: 'open-3h', short: 'B', day: { gaps: [gap(11, 14)], events: [], totalOpenMin: 180, windowCount: 1 } }),
    row({ gymId: 'open-5h', short: 'A', day: { gaps: [gap(11, 16)], events: [], totalOpenMin: 300, windowCount: 1 } }),
    row({ gymId: 'later-5pm', day: { gaps: [gap(17, 20)], events: [], totalOpenMin: 180, windowCount: 1 } }),
    row({ gymId: 'later-3pm', day: { gaps: [gap(15, 16)], events: [], totalOpenMin: 60, windowCount: 1 } }),
    row({ gymId: 'a-coming', status: 'coming-soon', day: null }),
  ];

  const sorted = sortBoardRows(rows.slice(), now);
  assert.deepEqual(sorted.map((r) => r.gymId), [
    'open-5h',    // open-now, most time-left
    'open-3h',    // open-now, less time-left
    'later-3pm',  // opens 3pm (sooner)
    'later-5pm',  // opens 5pm
    'a-coming',   // done bucket, alpha by short/id
    'z-done',
  ]);
});

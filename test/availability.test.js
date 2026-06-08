const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeOpenFloor,
  mergeIntervals,
  complement,
  resolveDayWindow,
  dayOfWeekKey,
} = require('../lib/availability');

const GYM = {
  id: 'test',
  tz: 'America/Chicago',
  danceRooms: ['Studio'],
  usableWindow: { start: '06:00', end: '22:00' },
  minGapMinutes: 30,
};
const DATE = '2026-05-25'; // CDT (UTC-5): 06:00 local = 11:00Z, 22:00 local = 03:00Z next day

// Build a normalized event from local Chicago wall-clock times on DATE.
// CDT is UTC-5, so local 00:00 on 2026-05-25 is 05:00Z; add the local hour
// (fractional hours allowed) and let Date handle UTC day rollover.
const LOCAL_MIDNIGHT_UTC = Date.UTC(2026, 4, 25, 5, 0, 0);
function ev(room, startLocalH, endLocalH, { danceSuitable = true, date = DATE } = {}) {
  const z = (h) => new Date(LOCAL_MIDNIGHT_UTC + h * 3600000).toISOString();
  return {
    name: `${room} ${startLocalH}-${endLocalH}`,
    room,
    danceSuitable,
    occurrenceDate: date,
    startDT: z(startLocalH),
    endDT: z(endLocalH),
  };
}

test('mergeIntervals merges overlapping and adjacent', () => {
  const m = mergeIntervals([
    { start: 0, end: 10 }, { start: 10, end: 20 }, { start: 25, end: 30 }, { start: 5, end: 8 },
  ]);
  assert.deepEqual(m, [{ start: 0, end: 20 }, { start: 25, end: 30 }]);
});

test('complement returns full window when nothing is busy', () => {
  assert.deepEqual(complement(0, 100, []), [{ start: 0, end: 100 }]);
});

test('no classes -> one gap spanning the whole usable window (960 min)', () => {
  const out = computeOpenFloor([], GYM, DATE);
  assert.equal(out.rooms.length, 1);
  const r = out.rooms[0];
  assert.equal(r.room, 'Studio');
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].minutes, 16 * 60); // 06:00 -> 22:00
});

test('one mid-day class splits the window into two gaps', () => {
  const out = computeOpenFloor([ev('Studio', 12, 13)], GYM, DATE);
  const r = out.rooms[0];
  assert.equal(r.classes.length, 1);
  assert.equal(r.gaps.length, 2);
  assert.equal(r.gaps[0].minutes, 6 * 60); // 06:00 -> 12:00
  assert.equal(r.gaps[1].minutes, 9 * 60); // 13:00 -> 22:00
});

test('gaps shorter than minGapMinutes are dropped', () => {
  // classes at 06:00-06:20 then 06:40-22:00 leave only a 20-min gap -> dropped
  const out = computeOpenFloor([ev('Studio', 6, 6.333333), ev('Studio', 6.666667, 22)], GYM, DATE);
  const r = out.rooms[0];
  assert.equal(r.gaps.length, 0);
});

test('a class covering the whole window leaves no gaps', () => {
  const out = computeOpenFloor([ev('Studio', 6, 22)], GYM, DATE);
  assert.equal(out.rooms[0].gaps.length, 0);
});

test('non-dance-suitable classes (e.g. Climbing) do not occupy the Studio', () => {
  const out = computeOpenFloor([ev('Climbing', 12, 13, { danceSuitable: false })], GYM, DATE);
  assert.equal(out.rooms[0].gaps.length, 1, 'Studio should remain fully free');
});

test('classes outside the usable window are ignored', () => {
  // 23:00-23:30 local is past the 22:00 window end
  const out = computeOpenFloor([ev('Studio', 23, 23.5)], GYM, DATE);
  assert.equal(out.rooms[0].gaps.length, 1);
  assert.equal(out.rooms[0].gaps[0].minutes, 16 * 60);
});

test('classes on a different day are ignored', () => {
  const out = computeOpenFloor([ev('Studio', 12, 13, { date: '2026-05-26' })], GYM, DATE);
  assert.equal(out.rooms[0].gaps.length, 1);
});

// ---- hoursByDay (per-day club hours) ----
//
// The model now has two stacked layers:
//   - usableWindow  : soft "wake-hours" cap (default 06:00-22:00)
//   - hoursByDay    : real-world club open/close per Sun..Sat
// Effective window = their intersection (later open, earlier close).

// 2026-05-24 is a Sunday, 2026-05-25 is a Monday, both CDT (UTC-5).
const SUNDAY = '2026-05-24';
const MONDAY = '2026-05-25';
const FRIDAY = '2026-05-29';
const HOURS_GOLDS_FIXTURE = {
  sun: { open: '07:00', close: '21:00' },
  mon: { open: '05:00', close: '23:00' },
  tue: { open: '05:00', close: '23:00' },
  wed: { open: '05:00', close: '23:00' },
  thu: { open: '05:00', close: '23:00' },
  fri: { open: '05:00', close: '23:00' },
  sat: { open: '07:00', close: '21:00' },
};
const HOURS_LAF_FIXTURE = {
  sun: { open: '08:00', close: '20:00' },
  mon: { open: '05:00', close: '23:00' },
  tue: { open: '05:00', close: '23:00' },
  wed: { open: '05:00', close: '23:00' },
  thu: { open: '05:00', close: '23:00' },
  fri: { open: '05:00', close: '22:00' },
  sat: { open: '08:00', close: '20:00' },
};
const HOURS_24_7_FIXTURE = {
  sun: { open: '00:00', close: '24:00' },
  mon: { open: '00:00', close: '24:00' },
  tue: { open: '00:00', close: '24:00' },
  wed: { open: '00:00', close: '24:00' },
  thu: { open: '00:00', close: '24:00' },
  fri: { open: '00:00', close: '24:00' },
  sat: { open: '00:00', close: '24:00' },
};

test('dayOfWeekKey maps YYYY-MM-DD to sun..sat (tz-independent)', () => {
  assert.equal(dayOfWeekKey('2026-05-24'), 'sun');
  assert.equal(dayOfWeekKey('2026-05-25'), 'mon');
  assert.equal(dayOfWeekKey('2026-05-26'), 'tue');
  assert.equal(dayOfWeekKey('2026-05-29'), 'fri');
  assert.equal(dayOfWeekKey('2026-05-30'), 'sat');
});

test('resolveDayWindow: hoursByDay alone (no usableWindow) returns club hours', () => {
  const gym = { hoursByDay: HOURS_GOLDS_FIXTURE };
  assert.deepEqual(resolveDayWindow(gym, SUNDAY), { start: '07:00', end: '21:00' });
  assert.deepEqual(resolveDayWindow(gym, MONDAY), { start: '05:00', end: '23:00' });
});

test('resolveDayWindow: usableWindow alone (no hoursByDay) is the wake cap', () => {
  const gym = { usableWindow: { start: '06:00', end: '22:00' } };
  assert.deepEqual(resolveDayWindow(gym, SUNDAY), { start: '06:00', end: '22:00' });
  assert.deepEqual(resolveDayWindow(gym, MONDAY), { start: '06:00', end: '22:00' });
});

test('resolveDayWindow: intersects usableWindow ∩ hoursByDay (Gold\'s Sunday)', () => {
  // Sunday Gold's 07:00-21:00 ∩ wake-cap 06:00-22:00 → 07:00-21:00 (the
  // closing time Drew flagged — must come out as 21:00, not 22:00).
  const gym = {
    usableWindow: { start: '06:00', end: '22:00' },
    hoursByDay: HOURS_GOLDS_FIXTURE,
  };
  assert.deepEqual(resolveDayWindow(gym, SUNDAY), { start: '07:00', end: '21:00' });
});

test('resolveDayWindow: 24/7 club ∩ wake-cap collapses to the wake-cap', () => {
  const gym = {
    usableWindow: { start: '06:00', end: '22:00' },
    hoursByDay: HOURS_24_7_FIXTURE,
  };
  assert.deepEqual(resolveDayWindow(gym, SUNDAY), { start: '06:00', end: '22:00' });
  assert.deepEqual(resolveDayWindow(gym, FRIDAY), { start: '06:00', end: '22:00' });
});

test('resolveDayWindow: LA Fitness weekday vs Sunday close times', () => {
  // Sunday LA Fitness 08:00-20:00 ∩ 06:00-22:00 → 08:00-20:00 (closes 20:00).
  // Friday LA Fitness 05:00-22:00 ∩ 06:00-22:00 → 06:00-22:00 (closes 22:00).
  const gym = {
    usableWindow: { start: '06:00', end: '22:00' },
    hoursByDay: HOURS_LAF_FIXTURE,
  };
  assert.deepEqual(resolveDayWindow(gym, SUNDAY), { start: '08:00', end: '20:00' });
  assert.deepEqual(resolveDayWindow(gym, FRIDAY), { start: '06:00', end: '22:00' });
});

test('resolveDayWindow: no overlap collapses to zero-length (no false-positive free time)', () => {
  const gym = {
    usableWindow: { start: '06:00', end: '22:00' },
    hoursByDay: { sun: { open: '23:00', close: '24:00' } }, // graveyard-only
  };
  const win = resolveDayWindow(gym, SUNDAY);
  assert.equal(win.start, win.end, 'window should collapse, not invert');
});

test('computeOpenFloor: Gold\'s Sunday window is 07:00-21:00 (14h, not 16h)', () => {
  const gym = { ...GYM, hoursByDay: HOURS_GOLDS_FIXTURE };
  const out = computeOpenFloor([], gym, SUNDAY);
  // 07:00 → 21:00 == 14 hours == 840 minutes (was 960 under the old
  // usableWindow-only model).
  assert.equal(out.window.start, '07:00');
  assert.equal(out.window.end, '21:00');
  assert.equal(out.rooms[0].gaps.length, 1);
  assert.equal(out.rooms[0].gaps[0].minutes, 14 * 60);
});

test('computeOpenFloor: Gold\'s Monday window is the full wake-cap (06:00-22:00)', () => {
  const gym = { ...GYM, hoursByDay: HOURS_GOLDS_FIXTURE };
  // Monday Gold's 05:00-23:00 ∩ wake-cap 06:00-22:00 → 06:00-22:00 (16h).
  const out = computeOpenFloor([], gym, MONDAY);
  assert.equal(out.window.start, '06:00');
  assert.equal(out.window.end, '22:00');
  assert.equal(out.rooms[0].gaps[0].minutes, 16 * 60);
});

// Sunday-anchored event builder so timestamps line up with occurrenceDate.
const SUNDAY_LOCAL_MIDNIGHT_UTC = Date.UTC(2026, 4, 24, 5, 0, 0);
function sundayEv(room, startLocalH, endLocalH, { danceSuitable = true } = {}) {
  const z = (h) => new Date(SUNDAY_LOCAL_MIDNIGHT_UTC + h * 3600000).toISOString();
  return {
    name: `${room} ${startLocalH}-${endLocalH}`,
    room,
    danceSuitable,
    occurrenceDate: SUNDAY,
    startDT: z(startLocalH),
    endDT: z(endLocalH),
  };
}

test('computeOpenFloor: a class at 20:30-21:00 on Gold\'s Sunday eats the tail', () => {
  // Sunday window is 07:00-21:00. A 20:30-21:00 class blocks the last 30
  // minutes — the tail gap disappears, leaving just the morning chunk.
  const gym = { ...GYM, hoursByDay: HOURS_GOLDS_FIXTURE };
  const out = computeOpenFloor([sundayEv('Studio', 20.5, 21)], gym, SUNDAY);
  const r = out.rooms[0];
  assert.equal(r.gaps.length, 1, 'only the pre-class gap survives');
  // 07:00 -> 20:30 = 13.5h = 810 min.
  assert.equal(r.gaps[0].minutes, 810);
});

test('computeOpenFloor: a 21:00-22:00 class on Sunday is fully outside the window (ignored)', () => {
  // The class sits between Gold's 21:00 close and the wake-cap 22:00, so it
  // shouldn't block anything: 07:00-21:00 stays one big gap.
  const gym = { ...GYM, hoursByDay: HOURS_GOLDS_FIXTURE };
  const out = computeOpenFloor([sundayEv('Studio', 21, 22)], gym, SUNDAY);
  assert.equal(out.rooms[0].gaps.length, 1);
  assert.equal(out.rooms[0].gaps[0].minutes, 14 * 60);
});

test('computeOpenFloor: no hoursByDay → unchanged behavior (usableWindow only)', () => {
  // Backstop: the original GYM fixture has no hoursByDay, and all existing
  // tests pass — this just locks the fallback semantics explicitly.
  const out = computeOpenFloor([], GYM, MONDAY);
  assert.equal(out.window.start, '06:00');
  assert.equal(out.window.end, '22:00');
});

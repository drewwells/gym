const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeOpenFloor, mergeIntervals, complement } = require('../lib/availability');

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

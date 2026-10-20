const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeBoardDay } = require('../lib/board');
const {
  floorInBand, freeFloorsInBand, SLOT_MIN, BAND_MIN, BAND_MAX, clampBand, shiftBand, growBand,
} = require('../public/free-at');

// Same fixture shape as board.test.js: a Central-time gym open 6 AM–10 PM.
const GYM = {
  id: 'test',
  tz: 'America/Chicago',
  danceRooms: ['Studio'],
  usableWindow: { start: '06:00', end: '22:00' },
  minGapMinutes: 30,
};
const DATE = '2026-05-26'; // Tuesday, CDT (UTC-5)
const LOCAL_MIDNIGHT_UTC = Date.UTC(2026, 4, 26, 5, 0, 0);
const SEVEN_PM = 19 * 60;

function cls(startH, endH, name = `class ${startH}-${endH}`, room = 'Studio') {
  const z = (h) => new Date(LOCAL_MIDNIGHT_UTC + h * 3600000).toISOString();
  return { name, room, danceSuitable: true, occurrenceDate: DATE, startDT: z(startH), endDT: z(endH) };
}

// The board's ISO day → minutes in the gym's tz, as the browser does it.
function toMin(iso, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso));
  return (Number(p.find((x) => x.type === 'hour').value) % 24) * 60 + Number(p.find((x) => x.type === 'minute').value);
}
function dayAt(events, gym = GYM) {
  const day = summarizeBoardDay(events, gym, DATE);
  return {
    gaps: day.gaps.map((g) => ({ start: toMin(g.startDT, gym.tz), end: toMin(g.endDT, gym.tz) })),
    events: day.events.map((e) => ({ name: e.name, start: toMin(e.startDT, gym.tz), end: toMin(e.endDT, gym.tz) })),
  };
}
// Drew's examples are "Tuesday at 7": the one-hour band 7–8 PM.
function at(events, t = SEVEN_PM, to = t + 60) {
  const d = dayAt(events);
  return floorInBand(d.gaps, d.events, t, to);
}

test('slot length is one hour', () => {
  assert.equal(SLOT_MIN, 60);
});

// Drew's three cases (2026-10-20), picking Tuesday 7 PM.
test('a class ending at 7 leaves the floor free at 7', () => {
  const r = at([cls(18, 19, 'Zumba')]);
  assert.equal(r.free, true);
  assert.deepEqual(r.windows, [{ start: SEVEN_PM, end: 20 * 60 }]);
});

test('a class starting at 7:15 makes 7 busy', () => {
  const r = at([cls(19.25, 20.25, 'BODYJAM')]);
  assert.equal(r.free, false);
  assert.equal(r.longest, 15);
  assert.deepEqual(r.blockers.map((b) => b.name), ['BODYJAM']);
});

test('a class starting at 7:30 makes 7 busy', () => {
  const r = at([cls(19.5, 20.5, 'Hot Yoga')]);
  assert.equal(r.free, false);
  assert.equal(r.longest, 30);
});

test('a class starting at 8 (right when the hour ends) leaves 7 free', () => {
  assert.equal(at([cls(20, 21)]).free, true);
});

// Bands (Drew, 2026-10-20: "set something like 10am - 4pm").
test('band: an exactly-one-hour gap qualifies', () => {
  const r = at([cls(9, 11), cls(12, 16)], 10 * 60, 16 * 60);
  assert.equal(r.free, true);
  assert.deepEqual(r.windows, [{ start: 11 * 60, end: 12 * 60 }]);
});

test('band: two 45-minute gaps do not add up to an hour', () => {
  const r = at([cls(10.75, 12), cls(12.75, 16)], 10 * 60, 16 * 60);
  assert.equal(r.free, false);
  assert.equal(r.longest, 45);
  assert.equal(r.blockers.length, 2);
});

test('band: windows are clipped to the band and listed in order', () => {
  const r = at([cls(11, 12), cls(14, 14.5)], 10.5 * 60, 16 * 60);
  assert.deepEqual(r.windows, [{ start: 12 * 60, end: 14 * 60 }, { start: 14.5 * 60, end: 16 * 60 }]);
  // 10:30–11 is only 30 minutes inside the band: counted for longest, not shown.
  assert.equal(r.longest, 120);
});

test('band past closing: no full hour left, nothing in the way', () => {
  const r = at([], 21.5 * 60, 23 * 60);
  assert.equal(r.free, false);
  assert.equal(r.longest, 30);
  assert.deepEqual(r.blockers, []);
});

test('a two-room gym is free if either room is clear for the hour', () => {
  const two = { ...GYM, danceRooms: ['A', 'B'] };
  const d = dayAt([cls(19.25, 20.25, 'A class', 'A')], two);
  assert.equal(floorInBand(d.gaps, d.events, SEVEN_PM, SEVEN_PM + 60).free, true);
});

test('Eastern gym: 7 PM means 7 PM local', () => {
  const east = { ...GYM, tz: 'America/New_York' };
  // 6–7 PM Eastern is 5–6 PM Central on the Central-midnight clock above.
  const d = dayAt([cls(17, 18, 'Eastern 6pm')], east);
  assert.equal(floorInBand(d.gaps, d.events, SEVEN_PM, SEVEN_PM + 60).free, true);
  assert.equal(floorInBand(d.gaps, d.events, 18 * 60, 19 * 60).free, false);
});

test('freeFloorsInBand: splits free/busy, busy longest-stretch first, skips classes-only', () => {
  const rows = [
    { row: { id: 'short' }, ...dayAt([cls(19.25, 20.5)]) },
    { row: { id: 'free' }, ...dayAt([cls(18, 19)]) },
    { row: { id: 'half' }, ...dayAt([cls(18.5, 19.5)]) },
    { row: { id: 'yoga' }, classesOnly: true, ...dayAt([]) },
  ];
  const { free, busy } = freeFloorsInBand(rows, SEVEN_PM, SEVEN_PM + 60);
  assert.deepEqual(free.map((f) => f.row.id), ['free']);
  assert.deepEqual(busy.map((b) => b.row.id), ['half', 'short']);
});

// The picker runs 8 AM–10 PM (Drew, 2026-10-20: "extend to 10pm").
const H = (h) => h * 60;

test('band bounds are 8 AM to 10 PM', () => {
  assert.equal(BAND_MIN, H(8));
  assert.equal(BAND_MAX, H(22));
});

test('clampBand: 8–10 PM is allowed as-is; past 10 PM is cut back', () => {
  assert.deepEqual(clampBand(H(20), H(22)), [H(20), H(22)]);
  assert.deepEqual(clampBand(H(21), H(23)), [H(21), H(22)]);
  assert.deepEqual(clampBand(H(22), H(23)), [H(21), H(22)]);
  assert.deepEqual(clampBand(H(6), H(7)), [H(8), H(9)]);
});

test('clampBand: keeps an hour; the end that moved wins', () => {
  assert.deepEqual(clampBand(H(20), H(20.5), 'from'), [H(20), H(21)]);
  assert.deepEqual(clampBand(H(21.5), H(22), 'to'), [H(21), H(22)]);
});

test('shiftBand: later stops at 10 PM, earlier at 8 AM, length kept', () => {
  assert.deepEqual(shiftBand([H(20), H(21.5)], 30), [H(20.5), H(22)]);
  assert.deepEqual(shiftBand([H(20.5), H(22)], 30), [H(20.5), H(22)]);
  assert.deepEqual(shiftBand([H(8), H(9)], -30), [H(8), H(9)]);
});

test('growBand: grows the end up to 10 PM, then the start', () => {
  assert.deepEqual(growBand([H(19), H(20)], 30), [H(19), H(20.5)]);
  assert.deepEqual(growBand([H(21), H(22)], 30), [H(20.5), H(22)]);
  assert.deepEqual(growBand([H(8), H(22)], 30), [H(8), H(22)]);
});

test('8–10 PM band: a gym closing at 9 PM is trimmed by its hours', () => {
  const early = { ...GYM, usableWindow: { start: '06:00', end: '21:00' } };
  const d = dayAt([], early);
  const r = floorInBand(d.gaps, d.events, H(20), H(22));
  assert.equal(r.free, true);
  assert.deepEqual(r.windows, [{ start: H(20), end: H(21) }]);
  const late = dayAt([], { ...GYM, usableWindow: { start: '06:00', end: '20:30' } });
  assert.equal(floorInBand(late.gaps, late.events, H(20), H(22)).free, false);
});

test('8–10 PM band: a 9 PM class leaves the 8–9 hour', () => {
  const r = at([cls(21, 22, 'Late Zumba')], H(20), H(22));
  assert.deepEqual(r.windows, [{ start: H(20), end: H(21) }]);
});

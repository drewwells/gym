const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeBoardDay } = require('../lib/board');
const { floorAt, freeFloorsAt, SLOT_MIN } = require('../public/free-at');

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
function at(events, t = SEVEN_PM) {
  const d = dayAt(events);
  return floorAt(d.gaps, d.events, t);
}

test('slot length is one hour', () => {
  assert.equal(SLOT_MIN, 60);
});

// Drew's three cases (2026-10-20), picking Tuesday 7 PM.
test('a class ending at 7 leaves the floor free at 7', () => {
  const r = at([cls(18, 19, 'Zumba')]);
  assert.equal(r.free, true);
  assert.equal(r.from, SEVEN_PM);
  assert.equal(r.until, 22 * 60);
});

test('a class starting at 7:15 makes 7 busy', () => {
  const r = at([cls(19.25, 20.25, 'BODYJAM')]);
  assert.equal(r.free, false);
  assert.equal(r.blocker.name, 'BODYJAM');
  assert.equal(r.freeFrom, 20.25 * 60);
});

test('a class starting at 7:30 makes 7 busy', () => {
  const r = at([cls(19.5, 20.5, 'Hot Yoga')]);
  assert.equal(r.free, false);
  assert.equal(r.blocker.name, 'Hot Yoga');
});

test('a class starting at 8 (right when the hour ends) leaves 7 free', () => {
  const r = at([cls(20, 21)]);
  assert.equal(r.free, true);
  assert.equal(r.until, 20 * 60);
});

test('a class running past 7 makes 7 busy; free from when it ends', () => {
  const r = at([cls(18.5, 19 + 10 / 60, 'TONE')]);
  assert.equal(r.free, false);
  assert.equal(r.blocker.name, 'TONE');
  assert.equal(r.freeFrom, 19 * 60 + 10);
});

test('near closing: no full hour left, nothing in the way', () => {
  const r = at([], 21.5 * 60);
  assert.equal(r.free, false);
  assert.equal(r.blocker, null);
  assert.equal(r.freeFrom, null);
});

test('a two-room gym is free if either room is clear for the hour', () => {
  const two = { ...GYM, danceRooms: ['A', 'B'] };
  const d = dayAt([cls(19.25, 20.25, 'A class', 'A')], two);
  assert.equal(floorAt(d.gaps, d.events, SEVEN_PM).free, true);
});

test('Eastern gym: 7 PM means 7 PM local', () => {
  const east = { ...GYM, tz: 'America/New_York' };
  // 6–7 PM Eastern is 5–6 PM Central on the Central-midnight clock above.
  const d = dayAt([cls(17, 18, 'Eastern 6pm')], east);
  assert.equal(floorAt(d.gaps, d.events, SEVEN_PM).free, true);
  assert.equal(floorAt(d.gaps, d.events, 18 * 60).free, false);
});

test('freeFloorsAt: splits free/busy, busy soonest-free first, skips classes-only', () => {
  const rows = [
    { row: { id: 'late' }, ...dayAt([cls(19.25, 20.5)]) },
    { row: { id: 'free' }, ...dayAt([cls(18, 19)]) },
    { row: { id: 'soon' }, ...dayAt([cls(18.5, 19.25)]) },
    { row: { id: 'yoga' }, classesOnly: true, ...dayAt([]) },
  ];
  const { free, busy } = freeFloorsAt(rows, SEVEN_PM);
  assert.deepEqual(free.map((f) => f.row.id), ['free']);
  assert.deepEqual(busy.map((b) => b.row.id), ['soon', 'late']);
});

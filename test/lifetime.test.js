const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDuration, parseClockTime, classifyRoom, normalize,
} = require('../providers/lifetime');

// Captured, real API response (2 days) for Life Time Austin Arboretum, saved
// offline so this suite makes no network calls. Shape: { filters, dates[] },
// each dates[] entry { date (local day, +00:00), count, classes[] }.
const fixture = require('./fixtures/lifetime-arboretum.json');

const GYM = {
  id: 'lifetime-austin-arboretum',
  tz: 'America/Chicago',
  danceRooms: ['Group Fitness Studio'],
  sourceUrl: 'https://www.lifetime.life/locations/tx/austin-arboretum.html',
};

// The local date of a day bucket: the date portion of dates[].date (a local
// day despite its +00:00 suffix — do NOT run it through dateInTz).
const dayDate = (i) => fixture.dates[i].date.slice(0, 10);
// Find a class by exact name on a given day.
const findClass = (i, name) =>
  fixture.dates[i].classes.find((c) => c.name === name);

test('parseDuration reads MIN and H+MIN, defaults to 60 when unparseable', () => {
  assert.equal(parseDuration('60 MIN'), 60);
  assert.equal(parseDuration('45 MIN'), 45);
  assert.equal(parseDuration('30 MIN'), 30);
  assert.equal(parseDuration('1 H 15 MIN'), 75);
  assert.equal(parseDuration('90 MIN'), 90);
  assert.equal(parseDuration('garbage'), 60);
  assert.equal(parseDuration(''), 60);
  assert.equal(parseDuration(null), 60);
  assert.equal(parseDuration(undefined), 60);
});

test('parseClockTime converts 12-hour wall clock to 24h', () => {
  assert.deepEqual(parseClockTime('5:30 AM'), { hh: 5, mm: 30 });
  assert.deepEqual(parseClockTime('12:00 PM'), { hh: 12, mm: 0 });
  assert.deepEqual(parseClockTime('7:00 PM'), { hh: 19, mm: 0 });
  assert.deepEqual(parseClockTime('11:30 AM'), { hh: 11, mm: 30 });
  assert.equal(parseClockTime('nonsense'), null);
  assert.equal(parseClockTime(''), null);
});

test('classifyRoom: dance categories map to the shared Group Fitness Studio', () => {
  // Signature Group Training (ALPHA/GTX/MAXOUT), Cardio, Strength all run on
  // the danceable wood floor.
  assert.equal(classifyRoom({ name: 'ALPHA STRENGTH: SQUAT + PULL', tags: ['Signature Group Training', 'Adults (18+)'] }), 'Group Fitness Studio');
  assert.equal(classifyRoom({ name: 'Cardio+Resistance', tags: ['Cardio', 'Strength'] }), 'Group Fitness Studio');
  assert.equal(classifyRoom({ name: 'MAXOUT CORE', tags: ['Strength'] }), 'Group Fitness Studio');
});

test('classifyRoom: non-dance categories map to their own rooms', () => {
  assert.equal(classifyRoom({ name: 'SOL GUIDED VINYASA', tags: ['Yoga'] }), 'Yoga Studio');
  assert.equal(classifyRoom({ name: 'LIFE BARRE', tags: ['Barre'] }), 'Barre Studio');
  assert.equal(classifyRoom({ name: 'MAT PILATES', tags: ['Pilates'] }), 'Pilates Studio');
  assert.equal(classifyRoom({ name: 'ARORA Total Body', tags: ['ARORA + Aqua'] }), 'ARORA + Aqua');
});

test('classifyRoom: a specific non-dance tag beats a generic dance tag', () => {
  // EDG is tagged [Cardio, Cycle] but is a cycling class — the Cycle tag must
  // win so it lands in the cycle room, not the dance floor.
  const edg = findClass(1, 'EDG - Ride Into Zen: A Resiliency Ride: + Meditation');
  assert.ok(edg, 'EDG class present in fixture');
  assert.deepEqual(edg.tags.slice(0, 2), ['Cardio', 'Cycle']);
  assert.equal(classifyRoom(edg), 'Cycle Studio');
  // ARORA Strength is tagged [ARORA + Aqua, Strength] — the pool wins.
  const arora = findClass(1, 'ARORA Strength');
  assert.ok(arora, 'ARORA Strength present in fixture');
  assert.equal(classifyRoom(arora), 'ARORA + Aqua');
});

test('classifyRoom: outdoor classes route away from the studio regardless of category', () => {
  // ": Outdoors" suffix — these do not occupy an indoor studio floor.
  const sunrise = findClass(0, 'Sunrise FLOW VINYASA : Outdoors');
  assert.ok(sunrise, 'Sunrise FLOW present in fixture');
  assert.equal(classifyRoom(sunrise), 'Outdoors'); // tagged [Yoga, ...] but outdoors
  const matPilates = findClass(1, 'MAT PILATES : Outdoors');
  assert.ok(matPilates, 'MAT PILATES : Outdoors present in fixture');
  assert.equal(classifyRoom(matPilates), 'Outdoors'); // tagged [Barre, Pilates] but outdoors
});

test('classifyRoom: an unrecognized class defaults to the dance studio (conservative)', () => {
  // No recognized category tag, no name match -> blocks the floor, not frees it.
  assert.equal(classifyRoom({ name: 'Some New Format', tags: ['Adults (18+)', 'All'] }), 'Group Fitness Studio');
  assert.equal(classifyRoom({ name: 'Brand New Thing', tags: [] }), 'Group Fitness Studio');
  // ...but a name match still routes a category-less class to the right room.
  assert.equal(classifyRoom({ name: 'Cycle', tags: ['Adults (18+)'] }), 'Cycle Studio');
  assert.equal(classifyRoom({ name: 'Vinyasa Flow', tags: [] }), 'Yoga Studio');
  assert.equal(classifyRoom({ name: 'Aqua Fit', tags: [] }), 'ARORA + Aqua');
});

test('normalize: builds the common event model with DST-safe CDT times', () => {
  const cls = findClass(0, 'ALPHA STRENGTH: SQUAT + PULL'); // 5:30 AM, 60 MIN
  const ev = normalize(cls, dayDate(0), GYM);
  assert.equal(ev.gymId, 'lifetime-austin-arboretum');
  assert.equal(ev.name, 'ALPHA STRENGTH: SQUAT + PULL');
  assert.equal(ev.occurrenceDate, '2026-08-18');
  // 2026-08-18 is CDT (UTC-5): 5:30 AM local == 10:30 UTC.
  assert.equal(ev.startDT, '2026-08-18T10:30:00.000Z');
  assert.equal(ev.endDT, '2026-08-18T11:30:00.000Z'); // +60 MIN
  assert.equal(ev.room, 'Group Fitness Studio');
  assert.equal(ev.danceSuitable, true);
  assert.deepEqual(ev.instructors, ['Diego B.']);
  assert.equal(ev.seatsRemaining, null);
  assert.equal(ev.seatsTotal, null);
  assert.equal(ev.source, 'lifetime');
  assert.equal(ev.deepLink, GYM.sourceUrl);
});

test('normalize: a cycle class is not dance-suitable', () => {
  const cls = findClass(1, 'EDG - Ride Into Zen: A Resiliency Ride: + Meditation'); // 6:00 AM, 60 MIN
  const ev = normalize(cls, dayDate(1), GYM);
  assert.equal(ev.room, 'Cycle Studio');
  assert.equal(ev.danceSuitable, false);
  assert.equal(ev.startDT, '2026-08-19T11:00:00.000Z'); // 6:00 AM CDT
});

test('normalize: an outdoor class is not dance-suitable', () => {
  const cls = findClass(0, 'Sunrise FLOW VINYASA : Outdoors'); // 6:00 AM, 60 MIN
  const ev = normalize(cls, dayDate(0), GYM);
  assert.equal(ev.room, 'Outdoors');
  assert.equal(ev.danceSuitable, false);
  assert.equal(ev.startDT, '2026-08-18T11:00:00.000Z'); // 6:00 AM CDT
});

test('normalize: a 7:00 PM class crosses midnight UTC but keeps its local date', () => {
  const cls = findClass(1, 'LIFE BARRE'); // 7:00 PM, 45 MIN
  const ev = normalize(cls, dayDate(1), GYM);
  // 7:00 PM CDT == 00:00 UTC the NEXT day, but the local occurrence date is 19th.
  assert.equal(ev.startDT, '2026-08-20T00:00:00.000Z');
  assert.equal(ev.endDT, '2026-08-20T00:45:00.000Z'); // +45 MIN
  assert.equal(ev.occurrenceDate, '2026-08-19');
  assert.equal(ev.room, 'Barre Studio');
  assert.equal(ev.danceSuitable, false);
});

test('normalize: a class with no parseable start time is dropped', () => {
  assert.equal(normalize({ name: 'X', startTime: '??', duration: '60 MIN', tags: [] }, '2026-08-18', GYM), null);
});

// The synthesized id is what fetchWeek dedupes on. Distinct occurrences must
// yield distinct ids; the same occurrence normalized twice must collide.
test('normalize id is stable per occurrence and distinct across occurrences', () => {
  const a = findClass(0, 'ALPHA STRENGTH: SQUAT + PULL');
  const b = findClass(0, 'Sunrise FLOW VINYASA : Outdoors');
  const a1 = normalize(a, dayDate(0), GYM);
  const a2 = normalize(JSON.parse(JSON.stringify(a)), dayDate(0), GYM);
  const b1 = normalize(b, dayDate(0), GYM);
  assert.equal(a1.id, a2.id);
  assert.notEqual(a1.id, b1.id);
});

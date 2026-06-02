const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseEvents, classifyRoom, normalize, shortDateToISO,
} = require('../providers/golds');

// Minimal fixture mirroring the real location-page markup: a few hidden inputs
// carrying HTML-entity-escaped event JSON. Two group-exercise classes and one
// cycle class (cycle uses a "Group Cycle ..." StudioName + IsCycle:true).
const FIXTURE = `
<div class="schedule__items">
  <input type="hidden" name="event_data" value="{&quot;EventName&quot;:&quot;BODYPUMP&quot;,&quot;StudioName&quot;:&quot;Group Exercise Anderson Arbor&quot;,&quot;IsCycle&quot;:false,&quot;StudioCycleID&quot;:0,&quot;InstructorName&quot;:&quot;Jane Doe&quot;,&quot;EventID&quot;:111,&quot;EventDescription&quot;:&quot;Barbell class&quot;,&quot;ScheduleDateLocalShort&quot;:&quot;6/2/2026&quot;,&quot;LocalTime&quot;:&quot;8:00 AM&quot;,&quot;LocalEndTime&quot;:&quot;9:00 AM&quot;,&quot;DurationMinutes&quot;:60,&quot;MaximumSignUp&quot;:27,&quot;ReservedSpotsCount&quot;:0,&quot;ScheduleRegisterCount&quot;:12}">
  <input type="hidden" name="event_data" value="{&quot;EventName&quot;:&quot;VINYASA FLOW YOGA&quot;,&quot;StudioName&quot;:&quot;Group Exercise Anderson Arbor&quot;,&quot;IsCycle&quot;:false,&quot;StudioCycleID&quot;:0,&quot;InstructorName&quot;:&quot;A. Smith&quot;,&quot;EventID&quot;:112,&quot;ScheduleDateLocalShort&quot;:&quot;6/3/2026&quot;,&quot;LocalTime&quot;:&quot;5:30 PM&quot;,&quot;LocalEndTime&quot;:&quot;6:30 PM&quot;,&quot;DurationMinutes&quot;:60,&quot;MaximumSignUp&quot;:20,&quot;ReservedSpotsCount&quot;:0,&quot;ScheduleRegisterCount&quot;:5}">
  <input type="hidden" name="event_data" value="{&quot;EventName&quot;:&quot;RPM&quot;,&quot;StudioName&quot;:&quot;Group Cycle Anderson Arbor&quot;,&quot;IsCycle&quot;:true,&quot;StudioCycleID&quot;:7,&quot;EventID&quot;:113,&quot;ScheduleDateLocalShort&quot;:&quot;6/2/2026&quot;,&quot;LocalTime&quot;:&quot;6:00 AM&quot;,&quot;LocalEndTime&quot;:&quot;6:45 AM&quot;,&quot;DurationMinutes&quot;:45,&quot;MaximumSignUp&quot;:30,&quot;ReservedSpotsCount&quot;:0,&quot;ScheduleRegisterCount&quot;:1}">
</div>`;

const GYM = {
  id: 'golds-anderson-arbor',
  tz: 'America/Chicago',
  danceRooms: ['GGX Studio'],
  sourceUrl: 'https://www.goldsgym.com/locations/tx/austin-anderson-arbor/',
};

test('parseEvents extracts and decodes every escaped event_data blob', () => {
  const evs = parseEvents(FIXTURE);
  assert.equal(evs.length, 3);
  assert.equal(evs[0].EventName, 'BODYPUMP');
  assert.equal(evs[0].StudioName, 'Group Exercise Anderson Arbor');
});

test('classifyRoom: group-exercise -> GGX Studio, cycle -> Cycle Studio', () => {
  const evs = parseEvents(FIXTURE);
  assert.equal(classifyRoom(evs[0]), 'GGX Studio'); // BODYPUMP
  assert.equal(classifyRoom(evs[1]), 'GGX Studio'); // Yoga
  assert.equal(classifyRoom(evs[2]), 'Cycle Studio'); // RPM (IsCycle)
});

test('classifyRoom: pool classes route to Other; unknown defaults to GGX', () => {
  assert.equal(classifyRoom({ EventName: 'Aqua Fit', StudioName: 'Group Exercise Anderson Arbor' }), 'Other');
  // An unrecognized, non-cycle/non-pool class blocks the floor (conservative).
  assert.equal(classifyRoom({ EventName: 'Some New Format', StudioName: 'Group Exercise Anderson Arbor' }), 'GGX Studio');
});

test('classifyRoom keys off StudioName across locations (not a hardcoded one)', () => {
  // "Group Exercise <any location>" is the danceable GGX floor.
  assert.equal(classifyRoom({ EventName: 'BODYPUMP', StudioName: 'Group Exercise Highland' }), 'GGX Studio');
  assert.equal(classifyRoom({ EventName: 'RPM', StudioName: 'Group Cycle Highland', IsCycle: true }), 'Cycle Studio');
  // Highland's GOLD'S FIT (HYROX/functional) is its own room, not the dance floor.
  assert.equal(classifyRoom({ EventName: 'HYROX POWER', StudioName: "GOLD'S FIT Highland" }), "Gold's Fit");
  assert.equal(classifyRoom({ EventName: 'GOLD’S FIT', StudioName: "GOLD’S FIT Highland" }), "Gold's Fit");
});

test('shortDateToISO normalizes M/D/YYYY to YYYY-MM-DD', () => {
  assert.equal(shortDateToISO('6/2/2026'), '2026-06-02');
  assert.equal(shortDateToISO('12/25/2026'), '2026-12-25');
  assert.equal(shortDateToISO('bad'), null);
});

test('normalize builds the common event model with DST-safe CDT times', () => {
  const evs = parseEvents(FIXTURE);
  const ev = normalize(evs[0], GYM, 60); // BODYPUMP, 8:00-9:00 AM CDT (June)
  assert.equal(ev.gymId, 'golds-anderson-arbor');
  assert.equal(ev.name, 'BODYPUMP');
  assert.equal(ev.occurrenceDate, '2026-06-02');
  // June -> CDT (UTC-5): 8:00 AM local == 13:00 UTC.
  assert.equal(ev.startDT, '2026-06-02T13:00:00.000Z');
  assert.equal(ev.endDT, '2026-06-02T14:00:00.000Z');
  assert.equal(ev.room, 'GGX Studio');
  assert.equal(ev.danceSuitable, true);
  assert.deepEqual(ev.instructors, ['Jane Doe']);
  assert.equal(ev.seatsTotal, 27);
  assert.equal(ev.seatsRemaining, 15); // 27 - 12 registered
  assert.equal(ev.source, 'golds');
});

test('normalize: cycle class is not dance-suitable', () => {
  const evs = parseEvents(FIXTURE);
  const ev = normalize(evs[2], GYM, 60); // RPM
  assert.equal(ev.room, 'Cycle Studio');
  assert.equal(ev.danceSuitable, false);
});

// The synthesized id is what fetchWeek dedupes on (the page renders each
// occurrence twice). Distinct occurrences must yield distinct ids; the same
// occurrence rendered twice must collide.
test('normalize id is stable per occurrence and distinct across occurrences', () => {
  const evs = parseEvents(FIXTURE);
  const a = normalize(evs[0], GYM, 60);
  const aDup = normalize(JSON.parse(JSON.stringify(evs[0])), GYM, 60);
  const b = normalize(evs[1], GYM, 60);
  assert.equal(a.id, aDup.id);
  assert.notEqual(a.id, b.id);
});

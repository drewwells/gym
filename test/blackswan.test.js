const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractClasses, normalize, flightText } = require('../providers/blackswan');
const { GYMS } = require('../gyms');

const GYM = {
  id: 'blackswan-anderson',
  tz: 'America/Chicago',
  sourceUrl: 'https://www.blackswanyoga.com/studios/anderson',
  providerConfig: { widgetId: '1a68132bd21' },
};

// Shape of a real class from the Mindbody widget page (trimmed, 2026-10-20).
const CLASS = {
  id: 'cinst_112FAt8LFVppWDJW7q',
  name: 'Flow',
  capacity: 70,
  numberRegistered: 7,
  startDateTime: '2026-10-20T17:00:00.0000000Z',
  duration: 45,
  endDateTime: '2026-10-20T17:45:00.0000000Z',
  staff: [{ id: 'sspec_1', displayLabel: 'Brooke' }],
  location: { id: 'loc_1', name: 'Anderson - Black Swan Yoga' },
  cancelled: false,
  roomName: null,
};

// Wrap a flight-payload string as the widget page does: split across
// several `self.__next_f.push([1,"…"])` script tags, mid-token.
function widgetPage(payload, parts = 3) {
  const size = Math.ceil(payload.length / parts);
  let html = '<html><body><script>self.__next_f.push([0])</script>';
  for (let i = 0; i < payload.length; i += size) {
    html += `<script>self.__next_f.push([1,${JSON.stringify(payload.slice(i, i + size))}])</script>`;
  }
  return `${html}</body></html>`;
}

test('flightText joins the push chunks back into one stream', () => {
  const payload = '0:["$","div",null,{"a":"x\\"y"}]\n';
  assert.equal(flightText(widgetPage(payload, 4)), payload);
});

test('extractClasses reads initialClasses across chunk boundaries', () => {
  const later = { ...CLASS, id: 'cinst_2', name: 'Savagely Sweaty Sculpt 👹', location: '$33' };
  const payload = `1a:["$","$L22",null,{"availabilityData":{},"initialClasses":${JSON.stringify({
    classes: [CLASS, later], fromDate: '2026-10-19T05:00:00.000Z', toDate: '2026-10-27T04:59:59.999Z',
  })},"other":"} ] {"}]\n`;
  const classes = extractClasses(widgetPage(payload, 5));
  assert.equal(classes.length, 2);
  assert.equal(classes[1].name, 'Savagely Sweaty Sculpt 👹');
});

test('extractClasses throws when the page has no initialClasses', () => {
  assert.throws(() => extractClasses(widgetPage('0:{"widgetName":"x"}')), /initialClasses not found/);
});

test('normalize: 7-digit fractional UTC → ISO, local date, never dance-suitable', () => {
  const e = normalize(CLASS, GYM);
  assert.equal(e.startDT, '2026-10-20T17:00:00.000Z');
  assert.equal(e.endDT, '2026-10-20T17:45:00.000Z');
  assert.equal(e.occurrenceDate, '2026-10-20');
  assert.equal(e.danceSuitable, false);
  assert.equal(e.room, 'Studio');
  assert.deepEqual(e.instructors, ['Brooke']);
  assert.equal(e.seatsRemaining, 63);
  assert.equal(e.seatsTotal, 70);
  assert.equal(e.deepLink, 'https://go.mindbodyonline.com/book/widgets/schedules/view/1a68132bd21/schedule');
});

test('normalize: a 7:30 PM CDT class crosses midnight UTC but keeps its local date', () => {
  const e = normalize({ ...CLASS, startDateTime: '2026-10-21T00:30:00.0000000Z', endDateTime: '2026-10-21T01:30:00.0000000Z' }, GYM);
  assert.equal(e.occurrenceDate, '2026-10-20');
});

test('normalize: flight escapes — "$$" is a literal "$", "$ref" names and staff are dropped', () => {
  const e = normalize({ ...CLASS, name: '$$5 Flow', roomName: 'Studio  2', staff: ['$40'] }, GYM);
  assert.equal(e.name, '$5 Flow');
  assert.equal(e.room, 'Studio 2');
  assert.deepEqual(e.instructors, []);
  assert.equal(normalize({ ...CLASS, name: '$12' }, GYM).name, '');
});

test('normalize: missing end time falls back to start + duration', () => {
  const e = normalize({ ...CLASS, endDateTime: null }, GYM);
  assert.equal(e.endDT, '2026-10-20T17:45:00.000Z');
});

test('normalize: unparseable start is dropped', () => {
  assert.equal(normalize({ ...CLASS, startDateTime: 'TBD' }, GYM), null);
});

test('registry: six Austin-area Black Swan studios, all classes-only with a widget id', () => {
  const bs = GYMS.filter((g) => g.provider === 'blackswan');
  assert.equal(bs.length, 6);
  for (const g of bs) {
    assert.equal(g.classesOnly, true, g.id);
    assert.deepEqual(g.danceRooms, [], g.id);
    assert.match(g.providerConfig.widgetId, /^[0-9a-f]{11,12}$/, g.id);
  }
});

// LA Fitness provider.
//
// LA Fitness exposes no JSON API. The one clean, scrapeable source is the
// printable weekly grid:
//   GET /Pages/ClassSchedulePrintVersion.aspx?clubid=<id>
// It returns server-rendered HTML: a table of day columns (Sun..Sat) x
// time-slot rows, each cell holding `<ClassName> (<Instructor>)`. Two things
// it does NOT give, which shape this provider:
//
//   1. No room/studio field. Like Crux, we infer the room from the class name.
//      LA Fitness clubs have ONE group-fitness studio (the danceable wood
//      floor) plus a separate cycle studio and a pool. We synthesize a single
//      "Group Fitness Studio" room and blocklist the classes that clearly run
//      elsewhere (Cycle*, Aqua*) so they neither invent phantom rooms nor get
//      mistaken for the floor. Unknown class names default to the studio, so an
//      unrecognized class blocks the floor rather than falsely freeing it
//      (conservative — see .knowledge/entries/multi-gym-data-sources.md).
//
//   2. No durations or end times — only start times. We assume a fixed class
//      length (gym.providerConfig.classMinutes, default 60). Over-blocking a
//      short class under-advertises floor, which is the safe direction.
//
// The grid is a weekly template (no per-date occurrences), so we map its
// weekdays onto whichever 7 dates the requested week covers.

const https = require('https');
const _ax = require('axios');
const axios = _ax.default || _ax;
const { tzWallClockUTC, dateInTz } = require('../lib/time');

const ORIGIN = 'https://www.lafitness.com';
const PRINT_URL = `${ORIGIN}/Pages/ClassSchedulePrintVersion.aspx`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';
const DEFAULT_CLASS_MINUTES = 60;
const STUDIO = 'Group Fitness Studio';

// LA Fitness sends oversized response headers (a multi-KB Set-Cookie) that
// blow past Node's default 16KB header limit and crash the HTTP parser with
// HPE_HEADER_OVERFLOW. curl tolerates it; the Node parser doesn't. A custom
// transport raises maxHeaderSize for just this provider's requests. (The print
// endpoint returns 200 directly, so not following redirects here is fine.)
const MAX_HEADER_SIZE = 64 * 1024;
const lenientTransport = {
  ...https,
  request(options, cb) {
    return https.request({ ...options, maxHeaderSize: MAX_HEADER_SIZE }, cb);
  },
};

// Class-name patterns that mean "this happens in the cycle studio or the pool",
// not the shared group-fitness studio. Anything not matching is treated as
// STUDIO (dance-suitable).
const NON_STUDIO_PATTERNS = [
  /\bcycle\b/i, /\bspin\b/i, /\bride\b/i,        // cycle studio
  /\baqua\b/i, /\bpool\b/i, /\bswim\b/i, /\bh2o\b/i, // pool
];

function classifyRoom(name) {
  return NON_STUDIO_PATTERNS.some((re) => re.test(name)) ? 'Other' : STUDIO;
}

const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function headers() {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${ORIGIN}/`,
  };
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  reg: '®', trade: '™', copy: '©', deg: '°', eacute: 'é',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .trim();
}

// "08:30 AM" / "05:45 PM" -> { hh, mm } in 24h, or null.
function parseClockTime(s) {
  const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(s);
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') hh += 12;
  return { hh, mm: Number(m[2]) };
}

// Parse the print grid into a weekly template of entries:
//   { dayIdx (0=Sun..6=Sat), hh, mm, classId, name, instructor }
function parseGrid(html) {
  const thead = /<thead[\s\S]*?<\/thead>/i.exec(html);
  if (!thead) throw new Error('LA Fitness schedule grid: no <thead> found');
  // Day columns in order, mapped to weekday indices. The leading spacer cell is
  // a <td>, so only <th> day headers are captured here.
  const dayCols = [];
  for (const m of thead[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)) {
    const idx = DAY_INDEX[decodeEntities(m[1].replace(/<[^>]+>/g, '')).toLowerCase()];
    if (idx != null) dayCols.push(idx);
  }
  if (dayCols.length === 0) throw new Error('LA Fitness schedule grid: no day columns');

  const tbody = /<tbody[\s\S]*?<\/tbody>/i.exec(html);
  if (!tbody) throw new Error('LA Fitness schedule grid: no <tbody> found');

  const entries = [];
  for (const row of tbody[0].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const tr = row[1];
    const timeM = /<h5>([\s\S]*?)<\/h5>/i.exec(tr);
    if (!timeM) continue;
    const time = parseClockTime(decodeEntities(timeM[1]));
    if (!time) continue;

    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    cells.forEach((cell, col) => {
      const dayIdx = dayCols[col];
      if (dayIdx == null) return;
      // A cell may hold several <br/>-separated classes (concurrent in
      // different rooms); capture each name + optional trailing instructor.
      const re = /<a[^>]*ClassDescription\.aspx\?id=(\d+)[^>]*>([\s\S]*?)<\/a>\s*<\/strong>(?:\s*\(([^)]*)\))?/gi;
      for (const m of cell.matchAll(re)) {
        const name = decodeEntities(m[2].replace(/<[^>]+>/g, ''));
        if (!name) continue;
        entries.push({
          dayIdx, hh: time.hh, mm: time.mm,
          classId: m[1],
          name,
          instructor: m[3] ? decodeEntities(m[3]) : null,
        });
      }
    });
  }
  return entries;
}

// The YYYY-MM-DD that is `n` calendar days after `dateStr` (pure date math).
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function normalize(entry, dateStr, gym, classMinutes) {
  const startUTC = tzWallClockUTC(dateStr, entry.hh, entry.mm, gym.tz);
  const endUTC = new Date(startUTC.getTime() + classMinutes * 60000);
  const room = classifyRoom(entry.name);
  return {
    gymId: gym.id,
    id: `${gym.id}:${dateStr}:${String(entry.hh).padStart(2, '0')}${String(entry.mm).padStart(2, '0')}:${entry.classId}`,
    name: entry.name,
    description: '',
    startDT: startUTC.toISOString(),
    endDT: endUTC.toISOString(),
    occurrenceDate: dateStr,
    room,
    danceSuitable: gym.danceRooms.includes(room),
    category: null,
    instructors: entry.instructor ? [entry.instructor] : [],
    seatsRemaining: null,
    seatsTotal: null,
    deepLink: `${ORIGIN}/Pages/ClassDescription.aspx?id=${entry.classId}`,
    source: 'lafitness',
  };
}

async function fetchWeek(gym, startUTC, endUTC) {
  const { clubId } = gym.providerConfig;
  if (clubId == null) throw new Error(`gym ${gym.id} has no clubId configured`);
  const classMinutes = gym.providerConfig.classMinutes || DEFAULT_CLASS_MINUTES;

  const res = await axios.get(PRINT_URL, {
    params: { clubid: clubId },
    headers: headers(),
    timeout: 15000,
    transport: lenientTransport,
  });
  if (typeof res.data !== 'string') {
    throw new Error(`LA Fitness ${gym.id}: unexpected non-HTML response`);
  }
  const template = parseGrid(res.data);

  // Map the weekly template onto the 7 dates the request covers. startUTC is
  // midnight of the first day in gym.tz; derive that local date and walk
  // forward by calendar day, emitting the template's classes for each weekday.
  const firstDate = dateInTz(startUTC.toISOString(), gym.tz);
  const events = [];
  for (let i = 0; i < 7; i += 1) {
    const dateStr = addDays(firstDate, i);
    const [y, mo, d] = dateStr.split('-').map(Number);
    const dayIdx = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    for (const entry of template) {
      if (entry.dayIdx !== dayIdx) continue;
      const ev = normalize(entry, dateStr, gym, classMinutes);
      if (new Date(ev.startDT) <= endUTC) events.push(ev);
    }
  }
  return events;
}

module.exports = { fetchWeek, parseGrid, classifyRoom };

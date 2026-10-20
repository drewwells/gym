// Life Time provider (Austin Arboretum and other lifetime.life locations).
//
// Life Time is a NEW platform here. Unlike Gold's (scraped server-rendered
// HTML) or LA Fitness (scraped print grid), Life Time exposes a clean JSON
// schedule API:
//   GET https://api.lifetimefitness.com/ux/web-schedules/v2/prospect/schedules
//       ?club=<clubId>&start=YYYY-MM-DD&end=YYYY-MM-DD
//   Header: Ocp-Apim-Subscription-Key: <public APIM key>
//
// Provenance (verified 2026-08-18): the Austin Arboretum location page
// (https://www.lifetime.life/locations/tx/austin-arboretum.html) embeds both
// values in its page JS — `window.lt.club.mmsClubId` (287 for Arboretum) and
// `window.lt.api.prospectSchedules.key` (the public APIM subscription key).
// No login/auth is required; the key is a public constant shipped to every
// browser that loads the page. We hardcode it here — it is a stable public
// key, not a rotating per-request token like Crux's scraped widgets key.
//
// Response shape (verified):
//   {
//     "filters": { "interests": { "classes": [ ...categories... ], ... }, ... },
//     "dates": [
//       {
//         "date": "2026-08-18T00:00:00+00:00",  // LOCAL day, midnight, +00:00
//         "count": 19,
//         "classes": [
//           {
//             "id": "ZXhlcnA6...",              // opaque base64-ish, stable
//             "name": "ALPHA STRENGTH: SQUAT + PULL",
//             "leader": "Diego B.",
//             "duration": "60 MIN",             // STRING: "30/45/60 MIN", "1 H 15 MIN"
//             "startTime": "5:30 AM",           // STRING: 12-hour LOCAL wall clock
//             "description": "...",
//             "parentId": "Alpha",              // sometimes a name, sometimes a UUID
//             "membershipAccess": "...",
//             "tags": ["Signature Group Training","Seniors (55+)","Adults (18+)","All"]
//           }
//         ]
//       }
//     ]
//   }
//
// Quirks that shape this provider:
//   1. NO room/studio field. Like crux.js and lafitness.js, we infer the room —
//      but from the `tags` array, a much better signal than the class name.
//   2. `tags`[0] is the interest category, drawn from filters.interests.classes:
//      Signature Group Training, Yoga, Cardio, Strength, ARORA + Aqua, Cycle,
//      Barre, Pilates. We classify on the tag SET: a class tagged with a
//      specific non-dance category (Yoga/Cycle/Pilates/Barre/ARORA) belongs in
//      that room even if it also carries a generic dance category like "Cardio"
//      (e.g. EDG is tagged [Cardio, Cycle] but is a cycling class). Only classes
//      whose recognized tags are all dance categories (Signature Group Training
//      / Cardio / Strength) land on the shared danceable wood floor.
//   3. NO end time. We parse the `duration` string ("60 MIN" -> 60,
//      "1 H 15 MIN" -> 75) and add it to the start; default 60 if unparseable.
//   4. `startTime` is a 12-hour LOCAL wall-clock string, and `dates[].date` is
//      the LOCAL day (despite the +00:00 suffix — do NOT treat it as a UTC
//      instant). We combine the two and synthesize the UTC instant via
//      tzWallClockUTC (DST-safe). Never hand-roll tz math.
//   5. Some classes are outdoors (name ends in ": Outdoors", e.g. "Sunrise FLOW
//      VINYASA : Outdoors"). Those do NOT occupy an indoor studio floor, so we
//      route them to their own "Outdoors" room (non-dance) regardless of
//      category.
//   6. Conservative default (repo-wide convention): an UNRECOGNIZED class (no
//      recognized category tag, no name match) defaults to the dance studio, so
//      an unknown class blocks the floor rather than falsely freeing it. Every
//      other provider does this — match it.

const _ax = require('axios');
const axios = _ax.default || _ax;
const { tzWallClockUTC, dateInTz } = require('../lib/time');

const API_URL = 'https://api.lifetimefitness.com/ux/web-schedules/v2/prospect/schedules';
// Public APIM subscription key, embedded in every lifetime.life page as
// window.lt.api.prospectSchedules.key. Stable public constant (verified
// 2026-08-18), not a rotating token. See the provenance note above.
const API_KEY = '924c03ce573d473793e184219a6a19bd';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';
const DEFAULT_CLASS_MINUTES = 60;

// Room labels. The shared group-fitness wood floor is the danceable studio;
// everything else is a distinct non-dance room (so it neither invents a
// phantom floor nor gets mistaken for the danceable one).
const STUDIO = 'Group Fitness Studio';
const CYCLE = 'Cycle Studio';
const YOGA = 'Yoga Studio';
const PILATES = 'Pilates Studio';
const BARRE = 'Barre Studio';
const ARORA = 'ARORA + Aqua';
const OUTDOORS = 'Outdoors';

// Interest-category tag -> room. The dance categories (Signature Group
// Training, Cardio, Strength) all map to the shared wood floor; the rest map to
// their own non-dance rooms. A tag NOT in this table is not a category — it's
// an age / experience / access tag like "Adults (18+)" or "All" — and is
// ignored by classifyRoom.
const TAG_ROOMS = {
  'Signature Group Training': STUDIO,
  'Cardio': STUDIO,
  'Strength': STUDIO,
  'Yoga': YOGA,
  'Cycle': CYCLE,
  'Pilates': PILATES,
  'Barre': BARRE,
  'ARORA + Aqua': ARORA,
};

// Name patterns for the fallback, used only when the tag set carries no
// recognized category. Mirrors the blocklists in crux.js / lafitness.js.
const NAME_ROOMS = [
  { room: CYCLE, re: /\b(cycle|spin|ride)\b/i },
  { room: YOGA, re: /\b(yoga|vinyasa|flow|hatha)\b/i },
  { room: PILATES, re: /\bpilates\b/i },
  { room: BARRE, re: /\bbarre\b/i },
  { room: ARORA, re: /\b(aqua|pool|swim)\b/i },
];

// Outdoor classes never occupy an indoor studio floor, so they route to their
// own Outdoors room regardless of category. The marker is the word "Outdoors"
// anywhere in the name, NOT a ": Outdoors" suffix: real names include
// "EDG : Outdoors, Outdoors" and "SOL GUIDED VINYASA : Outdoors, + SURRENDER",
// which a suffix anchor silently misses (verified against a live week
// 2026-08-18). \b keeps the singular "Outdoor ..." from matching.
const OUTDOOR_RE = /\boutdoors\b/i;

// "60 MIN" -> 60, "45 MIN" -> 45, "1 H 15 MIN" -> 75; unparseable -> 60.
function parseDuration(s) {
  if (typeof s !== 'string') return DEFAULT_CLASS_MINUTES;
  let total = 0;
  let matched = false;
  const h = /(\d+)\s*H(?:OUR)?S?\b/i.exec(s);
  const m = /(\d+)\s*MIN(?:UTE)?S?\b/i.exec(s);
  if (h) { total += Number(h[1]) * 60; matched = true; }
  if (m) { total += Number(m[1]); matched = true; }
  return matched ? total : DEFAULT_CLASS_MINUTES;
}

// "5:30 AM" / "12:00 PM" -> { hh, mm } in 24h, or null.
function parseClockTime(s) {
  const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(s || '');
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') hh += 12;
  return { hh, mm: Number(m[2]) };
}

// Decide the room for a class. Order:
//   1. Outdoor (name) -> Outdoors (never blocks an indoor studio floor).
//   2. Tag set: the first NON-DANCE category wins (a class tagged [Cardio,
//      Cycle] is a cycling class, not a wood-floor class). If every recognized
//      tag is a dance category, it's the shared studio.
//   3. Name fallback (only when the tags carry no recognized category).
//   4. Conservative default: the dance studio (an unknown class blocks the
//      floor rather than falsely freeing it — matches every other provider).
function classifyRoom(cls) {
  const name = cls.name || '';
  const tags = Array.isArray(cls.tags) ? cls.tags : [];
  if (OUTDOOR_RE.test(name)) return OUTDOORS;
  let dance = false;
  for (const tag of tags) {
    const room = TAG_ROOMS[tag];
    if (!room) continue;
    if (room === STUDIO) { dance = true; continue; }
    return room; // first non-dance category wins
  }
  if (dance) return STUDIO;
  for (const { room, re } of NAME_ROOMS) {
    if (re.test(name)) return room;
  }
  return STUDIO;
}

// Normalize one class (a `dates[].classes[]` entry) against the local date of
// its day bucket into the common event model. Returns null if the start time
// is unparseable.
function normalize(cls, dateStr, gym) {
  const start = parseClockTime(cls.startTime);
  if (!start) return null;

  const startUTC = tzWallClockUTC(dateStr, start.hh, start.mm, gym.tz);
  const endUTC = new Date(startUTC.getTime() + parseDuration(cls.duration) * 60000);

  const room = classifyRoom(cls);
  // The API's `id` is opaque but stable and unique per occurrence (it encodes
  // club + booking + date), so it is a safe id on its own; fall back to a
  // date+time composite if it's ever missing.
  const eventId = cls.id
    || `${dateStr}:${String(start.hh).padStart(2, '0')}${String(start.mm).padStart(2, '0')}`;
  return {
    gymId: gym.id,
    id: `${gym.id}:${eventId}`,
    name: cls.name || '',
    description: cls.description || '',
    startDT: startUTC.toISOString(),
    endDT: endUTC.toISOString(),
    occurrenceDate: dateStr,
    room,
    danceSuitable: gym.danceRooms.includes(room),
    category: null,
    instructors: cls.leader ? [cls.leader] : [],
    seatsRemaining: null,
    seatsTotal: null,
    deepLink: gym.sourceUrl,
    source: 'lifetime',
  };
}

// Fetch one week of events for `gym`, from the UTC instant `startUTC`
// (midnight of the requested day in the gym tz) through `endUTC`.
async function fetchWeek(gym, startUTC, endUTC) {
  const { clubId } = gym.providerConfig;
  if (clubId == null) throw new Error(`gym ${gym.id} has no clubId configured`);

  // The API takes LOCAL calendar dates (YYYY-MM-DD), not instants. startUTC /
  // endUTC are real UTC instants, so dateInTz yields their local dates.
  const startDate = dateInTz(startUTC.toISOString(), gym.tz);
  const endDate = dateInTz(endUTC.toISOString(), gym.tz);

  const res = await axios.get(API_URL, {
    params: { club: clubId, start: startDate, end: endDate },
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.lifetime.life/',
      'Ocp-Apim-Subscription-Key': API_KEY,
    },
    timeout: 15000,
  });

  const events = [];
  const seen = new Set();
  for (const day of res.data?.dates ?? []) {
    // day.date is the LOCAL day (midnight with a +00:00 suffix). Take the date
    // portion directly — do NOT run it through dateInTz (that would treat it as
    // a UTC instant and shift the day west by the tz offset).
    const dateStr = (day.date || '').slice(0, 10);
    if (!dateStr) continue;
    for (const cls of day.classes ?? []) {
      const norm = normalize(cls, dateStr, gym);
      if (!norm || seen.has(norm.id)) continue;
      const s = new Date(norm.startDT);
      // The API returns exactly the requested date range; keep only what the
      // request covers as a safety net.
      if (s >= startUTC && s <= endUTC) {
        seen.add(norm.id);
        events.push(norm);
      }
    }
  }
  return events;
}

module.exports = { fetchWeek, parseDuration, classifyRoom, normalize, parseClockTime };

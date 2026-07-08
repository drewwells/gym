// Gold's Gym provider (Anderson Arbor and other goldsgym.com locations).
//
// Austin Gold's run on a MotionVibe-backed schedule, but the page does NOT
// expose a clean JSON API to scrape. Instead, each location's WordPress page
// server-renders a full week of classes as HTML-entity-escaped JSON inside
// hidden inputs:
//   GET /locations/tx/<slug>/  ->  ...<input type="hidden" name="event_data"
//        value="{&quot;EventName&quot;:&quot;BODYPUMP&quot;,...}">...
// One GET returns ~7 days for that one location; the client-side calendar
// nav just filters this embedded data (no XHR), so no auth/nonce is needed
// for reading. See .knowledge/entries/multi-gym-data-sources.md.
//
// Unlike LA Fitness, Gold's gives us real room, end times, durations and seat
// counts, so we don't have to guess much:
//
//   - Room: each event carries an explicit `StudioName` ("Group Exercise
//     Anderson Arbor" vs "Group Cycle Anderson Arbor") and an `IsCycle` flag.
//     The gym has ONE group-exercise wood floor (the "GGX studio", danceable)
//     plus a separate cycle studio and a pool. We synthesize a single
//     "GGX Studio" and route cycle classes to "Cycle Studio" and aqua/pool to
//     "Other". Anything unrecognized defaults to the GGX studio, so an
//     unknown class blocks the floor rather than falsely freeing it
//     (conservative — same rule as the other providers).
//
//   - Times: `ScheduleDateLocalShort` (M/D/YYYY local) + `LocalTime` /
//     `LocalEndTime` (local wall-clock) are unambiguous; we synthesize the UTC
//     instant from them via tzWallClockUTC (DST-safe). `DurationMinutes` backs
//     up a missing end time.

const _ax = require('axios');
const axios = _ax.default || _ax;
const { tzWallClockUTC, dateInTz } = require('../lib/time');

const ORIGIN = 'https://www.goldsgym.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';
const DEFAULT_CLASS_MINUTES = 60;
const STUDIO = 'GGX Studio';
const CYCLE = 'Cycle Studio';
const GOLDS_FIT = "Gold's Fit";

function headers() {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${ORIGIN}/`,
  };
}

// Class-name patterns that mean "this happens in the pool", not the GGX floor
// or any other studio. (Cycle/Gold's Fit are identified structurally below.)
const POOL_PATTERNS = [/\baqua\b/i, /\bpool\b/i, /\bswim\b/i, /\bh2o\b/i];

// Decide the room for an event. Gold's gives an explicit, location-stamped
// StudioName ("Group Exercise <Loc>", "Group Cycle <Loc>", "GOLD'S FIT <Loc>"),
// so we key off that (not a hardcoded location) and collapse it to a stable,
// location-agnostic room label:
//   - "Group Cycle ..." / IsCycle / StudioCycleID  -> Cycle Studio (cycle room)
//   - "GOLD'S FIT ..."                              -> Gold's Fit (HYROX/turf)
//   - pool classes (by name)                        -> Other
//   - everything else (incl. "Group Exercise ...")  -> GGX Studio (the danceable
//     wood floor; unknown StudioNames default here so an unrecognized class
//     blocks the floor rather than falsely freeing it — conservative).
function classifyRoom(ev) {
  const studio = ev.StudioName || '';
  if (ev.IsCycle === true || /cycle/i.test(studio) || ev.StudioCycleID > 0) {
    return CYCLE;
  }
  if (/gold['’]?s\s*fit/i.test(studio)) return GOLDS_FIT;
  if (POOL_PATTERNS.some((re) => re.test(ev.EventName || ''))) return 'Other';
  return STUDIO;
}

// Minimal HTML-entity decode for the escaped JSON in the value="" attribute.
function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Pull every <input name="event_data" value="{...}"> blob out of the page and
// JSON.parse it. Malformed blobs are skipped rather than failing the fetch.
function parseEvents(html) {
  const re = /name="event_data"\s+value="([^"]*)"/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(decodeEntities(m[1])));
    } catch (_e) {
      // skip a single malformed blob
    }
  }
  return out;
}

// "6/2/2026" -> "2026-06-02"
function shortDateToISO(short) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((short || '').trim());
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// "8:00 AM" / "12:30 PM" -> { hh, mm } in 24h, or null.
function parseClockTime(s) {
  const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(s || '');
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') hh += 12;
  return { hh, mm: Number(m[2]) };
}

function normalize(ev, gym, classMinutes) {
  const dateStr = shortDateToISO(ev.ScheduleDateLocalShort);
  const start = parseClockTime(ev.LocalTime);
  if (!dateStr || !start) return null;

  const startUTC = tzWallClockUTC(dateStr, start.hh, start.mm, gym.tz);
  const end = parseClockTime(ev.LocalEndTime);
  let endUTC;
  if (end) {
    endUTC = tzWallClockUTC(dateStr, end.hh, end.mm, gym.tz);
    // Guard against an end-before-start (data quirk): fall back to duration.
    if (endUTC <= startUTC) endUTC = null;
  }
  if (!endUTC) {
    const mins = Number(ev.DurationMinutes) || classMinutes;
    endUTC = new Date(startUTC.getTime() + mins * 60000);
  }

  const room = classifyRoom(ev);
  // Seats remaining = capacity minus those already reserved/registered.
  const total = Number(ev.MaximumSignUp) || null;
  let remaining = null;
  if (total != null) {
    const taken =
      (Number(ev.ReservedSpotsCount) || 0) + (Number(ev.ScheduleRegisterCount) || 0);
    remaining = Math.max(0, total - taken);
  }

  const eventId = ev.EventID ?? ev.EventGroupID ?? '';
  return {
    gymId: gym.id,
    id: `${gym.id}:${dateStr}:${String(start.hh).padStart(2, '0')}${String(start.mm).padStart(2, '0')}:${eventId}`,
    name: ev.EventName || '',
    description: ev.EventDescription || '',
    startDT: startUTC.toISOString(),
    endDT: endUTC.toISOString(),
    occurrenceDate: dateStr,
    room,
    danceSuitable: gym.danceRooms.includes(room),
    category: null,
    instructors: ev.InstructorName ? [ev.InstructorName] : [],
    seatsRemaining: remaining,
    seatsTotal: total,
    deepLink: gym.sourceUrl,
    source: 'golds',
  };
}

async function fetchWeek(gym, startUTC, endUTC) {
  const { slug } = gym.providerConfig;
  if (!slug) throw new Error(`gym ${gym.id} has no slug configured`);
  const classMinutes = gym.providerConfig.classMinutes || DEFAULT_CLASS_MINUTES;
  // goldsgym.com namespaces location pages by state, e.g.
  // /locations/tx/<slug>/ or /locations/tn/<slug>/. Default 'tx' keeps the
  // existing Austin clubs working with no config change; TN (Knoxville) clubs
  // set state: 'tn'.
  const state = gym.providerConfig.state || 'tx';

  const url = `${ORIGIN}/locations/${state}/${slug}/`;
  const res = await axios.get(url, { headers: headers(), timeout: 15000 });
  if (typeof res.data !== 'string') {
    throw new Error(`Gold's ${gym.id}: unexpected non-HTML response`);
  }

  const raw = parseEvents(res.data);
  // The page renders each occurrence twice (desktop grid + mobile/modal view),
  // so dedupe by the synthesized id (date+time+EventID is unique per class).
  const seen = new Set();
  const events = [];
  for (const ev of raw) {
    const norm = normalize(ev, gym, classMinutes);
    if (!norm || seen.has(norm.id)) continue;
    const s = new Date(norm.startDT);
    // The page renders a fixed ~7-day window; keep only what the request covers.
    if (s >= startUTC && s <= endUTC) {
      seen.add(norm.id);
      events.push(norm);
    }
  }
  return events;
}

module.exports = { fetchWeek, parseEvents, classifyRoom, normalize, shortDateToISO };

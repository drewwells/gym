// Crux Climbing provider.
//
// Source: the public tilefive widget that cruxclimbingcenter.com embeds. The
// call needs an X-Api-Key that is a public per-region constant baked into the
// Approach portal SPA bundle; we scrape it at startup rather than committing
// it, and re-scrape on a 403 (the bundle/key rotate on every Crux deploy).
// See .knowledge/entries/crux-pivot.md.
//
// Crux exposes NO room/resource field, so we synthesize a room from the class
// name: climbing-team / bouldering classes use the wall; everything else
// (yoga, strength, mobility) uses the shared "Studio". Only "Studio" is
// dance-suitable. See .knowledge/entries/multi-gym-data-sources.md.

const _ax = require('axios');
const axios = _ax.default || _ax;
const { dateInTz } = require('../lib/time');

const CRUX_URL = 'https://widgets.api.prod.tilefive.com/cal';
const PORTAL_ORIGIN = 'https://crux.portal.approach.app';
const EMBED_URL = `${PORTAL_ORIGIN}/schedule/embed?categoryIds=4&locationIds=2`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';
const CALENDAR_URL = 'https://www.cruxclimbingcenter.com/central-austin/calendar/';

// Class-name patterns that mean "this happens on the climbing wall / training
// area", not in the shared studio. Anything not matching is treated as Studio.
const CLIMBING_PATTERNS = [
  /\bbouldering\b/i, /\bclimb/i, /\bbelay\b/i, /\brec team\b/i,
  /\bbeta\b/i, /\bproject(ing)?\b/i, /\blead\b/i, /\bcomp(etition)?\s*team\b/i,
];

function classifyRoom(name) {
  return CLIMBING_PATTERNS.some((re) => re.test(name)) ? 'Climbing' : 'Studio';
}

function cruxHeaders(apiKey) {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${PORTAL_ORIGIN}/`,
    'X-Api-Key': apiKey,
    Origin: PORTAL_ORIGIN,
    Authorization: 'crux',
  };
}

let cachedApiKey = null;
let inflightApiKey = null;

async function fetchApiKey() {
  const embedRes = await axios.get(EMBED_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.cruxclimbingcenter.com/',
    },
    validateStatus: () => true,
    timeout: 15000,
  });
  const bundleMatch = typeof embedRes.data === 'string'
    && embedRes.data.match(/src="(\/assets\/app-[^"]+\.js)"/);
  if (!bundleMatch) {
    throw new Error(`could not find SPA bundle path in ${EMBED_URL} (status ${embedRes.status})`);
  }
  const bundleUrl = PORTAL_ORIGIN + bundleMatch[1];
  const bundleRes = await axios.get(bundleUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*', Referer: EMBED_URL },
    timeout: 30000,
  });
  const keyMatch = bundleRes.data.match(/widgetsApiKey:\s*\{\s*"us-east-1"\s*:\s*"([^"]+)"/);
  if (!keyMatch) {
    throw new Error(`could not find widgetsApiKey["us-east-1"] in ${bundleUrl}`);
  }
  return keyMatch[1];
}

async function getApiKey({ refresh = false } = {}) {
  if (refresh) cachedApiKey = null;
  if (cachedApiKey) return cachedApiKey;
  if (!inflightApiKey) {
    inflightApiKey = fetchApiKey()
      .then((key) => {
        cachedApiKey = key;
        console.log(`Crux X-Api-Key acquired (...${key.slice(-6)})`);
        return key;
      })
      .finally(() => { inflightApiKey = null; });
  }
  return inflightApiKey;
}

async function cruxGet(params) {
  let apiKey = await getApiKey();
  try {
    return await axios.get(CRUX_URL, { params, headers: cruxHeaders(apiKey), timeout: 15000 });
  } catch (err) {
    // 403 usually means the bundle (and possibly its key) rotated. Refresh once.
    if (err.response?.status === 403) {
      apiKey = await getApiKey({ refresh: true });
      return axios.get(CRUX_URL, { params, headers: cruxHeaders(apiKey), timeout: 15000 });
    }
    throw err;
  }
}

function deepLink(entry) {
  const eventId = entry.eventId ?? entry.event?.id ?? null;
  const bookingId = entry.id ?? null;
  if (eventId != null && bookingId != null) {
    return `${PORTAL_ORIGIN}/event/${eventId}/booking/${bookingId}/embed`;
  }
  return CALENDAR_URL;
}

function normalize(entry, gym) {
  const name = entry.name ?? '';
  const room = classifyRoom(name);
  return {
    gymId: gym.id,
    id: entry.id ?? entry.UUID ?? null,
    name,
    description: entry.description ?? '',
    startDT: entry.startDT,
    endDT: entry.endDT,
    occurrenceDate: entry.startDT ? dateInTz(entry.startDT, gym.tz) : (entry.occurrenceDate ?? null),
    room,
    danceSuitable: gym.danceRooms.includes(room),
    category: null,
    instructors: [],
    seatsRemaining: entry.ticketsRemaining ?? null,
    seatsTotal: entry.maxNumOfGuests ?? null,
    deepLink: deepLink(entry),
    source: 'crux',
  };
}

// Fetch one week of events for `gym`, starting at the UTC instant `startUTC`
// (midnight of the requested day in the gym tz) through `endUTC`.
async function fetchWeek(gym, startUTC, endUTC) {
  const params = {
    startDT: startUTC.toISOString(),
    endDT: endUTC.toISOString(),
    locationId: gym.providerConfig.locationId,
    page: 1,
    pageSize: 200,
  };
  const res = await cruxGet(params);
  const bookings = (res.data?.bookings ?? []).map((b) => normalize(b, gym));
  const calEvents = (res.data?.calEvents ?? []).map((e) => normalize(e, gym));
  return [...bookings, ...calEvents];
}

module.exports = { fetchWeek };

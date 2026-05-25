const express = require('express');
const axios = require('axios');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const CRUX_URL = 'https://widgets.api.prod.tilefive.com/cal';
const CRUX_LOCATION_ID = 2; // Crux Climbing Center - Central Austin
const CRUX_TZ = 'America/Chicago';
const WEEK_DAYS = 7;
const CACHE_TTL_MS = 10 * 60 * 1000;

const CRUX_PORTAL_ORIGIN = 'https://crux.portal.approach.app';
const CRUX_EMBED_URL = `${CRUX_PORTAL_ORIGIN}/schedule/embed?categoryIds=4&locationIds=2`;
const CRUX_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';

function cruxHeaders(apiKey) {
  return {
    'User-Agent': CRUX_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${CRUX_PORTAL_ORIGIN}/`,
    'X-Api-Key': apiKey,
    Origin: CRUX_PORTAL_ORIGIN,
    Authorization: 'crux',
  };
}

// The X-Api-Key for widgets.api.prod.tilefive.com is a public per-region
// constant baked into the Approach portal's SPA bundle. We scrape it at
// startup rather than committing it to the repo. The bundle filename is
// content-hashed and rotates on every Crux deploy, so we resolve it
// indirectly: /schedule/embed serves the SPA shell (with a 403 body, but
// the <script src="/assets/app-*.js"> tag is still there), then we fetch
// that JS and extract widgetsApiKey["us-east-1"].
let cachedApiKey = null;
let inflightApiKey = null;

async function fetchCruxApiKey() {
  const embedRes = await axios.get(CRUX_EMBED_URL, {
    headers: {
      'User-Agent': CRUX_USER_AGENT,
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
    throw new Error(`could not find SPA bundle path in ${CRUX_EMBED_URL} (status ${embedRes.status})`);
  }
  const bundleUrl = CRUX_PORTAL_ORIGIN + bundleMatch[1];
  const bundleRes = await axios.get(bundleUrl, {
    headers: {
      'User-Agent': CRUX_USER_AGENT,
      Accept: '*/*',
      Referer: CRUX_EMBED_URL,
    },
    timeout: 30000,
  });
  const keyMatch = bundleRes.data.match(/widgetsApiKey:\s*\{\s*"us-east-1"\s*:\s*"([^"]+)"/);
  if (!keyMatch) {
    throw new Error(`could not find widgetsApiKey["us-east-1"] in ${bundleUrl}`);
  }
  return keyMatch[1];
}

async function getCruxApiKey({ refresh = false } = {}) {
  if (refresh) cachedApiKey = null;
  if (cachedApiKey) return cachedApiKey;
  if (!inflightApiKey) {
    inflightApiKey = fetchCruxApiKey()
      .then((key) => {
        cachedApiKey = key;
        console.log(`Crux X-Api-Key acquired (...${key.slice(-6)})`);
        return key;
      })
      .finally(() => { inflightApiKey = null; });
  }
  return inflightApiKey;
}

app.use(express.static('public'));

// Map<weekStartISO, { fetchedAt: number, payload: object }>
const weekCache = new Map();

function todayInChicago() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CRUX_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Returns the UTC Date that corresponds to 00:00:00 on `dateStr` (YYYY-MM-DD)
// in America/Chicago. Handles CDT/CST automatically.
function chicagoMidnightUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Initial guess: treat the wall-clock date as UTC, then correct by the
  // offset that Chicago has at that instant.
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const offsetMin = chicagoOffsetMinutes(guess);
  // Chicago is UTC-5 (CDT) or UTC-6 (CST), offsetMin is negative.
  // To get the UTC instant of Chicago-midnight, ADD the absolute offset.
  return new Date(guess.getTime() - offsetMin * 60 * 1000);
}

// Returns Chicago's UTC offset in minutes for the given instant
// (negative for west of UTC, e.g. -300 for CDT, -360 for CST).
function chicagoOffsetMinutes(instant) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: CRUX_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUTC = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );
  return Math.round((asUTC - instant.getTime()) / 60000);
}

function normalize(entry, source) {
  return {
    id: entry.id ?? entry.UUID ?? null,
    eventId: entry.eventId ?? entry.event?.id ?? null,
    name: entry.name ?? '',
    description: entry.description ?? '',
    startDT: entry.startDT,
    endDT: entry.endDT,
    occurrenceDate: entry.occurrenceDate ?? null,
    seatsRemaining: entry.ticketsRemaining ?? null,
    seatsTotal: entry.maxNumOfGuests ?? null,
    source,
  };
}

async function cruxGet(params) {
  let apiKey = await getCruxApiKey();
  try {
    return await axios.get(CRUX_URL, {
      params,
      headers: cruxHeaders(apiKey),
      timeout: 15000,
    });
  } catch (err) {
    // 403 typically means the bundle (and possibly its key) rotated since
    // we last scraped. Refresh once and retry.
    if (err.response?.status === 403) {
      apiKey = await getCruxApiKey({ refresh: true });
      return axios.get(CRUX_URL, {
        params,
        headers: cruxHeaders(apiKey),
        timeout: 15000,
      });
    }
    throw err;
  }
}

async function fetchWeek(weekStart) {
  const startUTC = chicagoMidnightUTC(weekStart);
  const endUTC = new Date(startUTC.getTime() + WEEK_DAYS * 24 * 60 * 60 * 1000 - 1);
  const params = {
    startDT: startUTC.toISOString(),
    endDT: endUTC.toISOString(),
    locationId: CRUX_LOCATION_ID,
    page: 1,
    pageSize: 200,
  };
  const res = await cruxGet(params);
  const bookings = (res.data?.bookings ?? []).map((b) => normalize(b, 'booking'));
  const calEvents = (res.data?.calEvents ?? []).map((e) => normalize(e, 'event'));
  const events = [...bookings, ...calEvents].sort(
    (a, b) => new Date(a.startDT) - new Date(b.startDT),
  );
  return {
    weekStart,
    weekEnd: endUTC.toISOString(),
    events,
  };
}

app.get('/api/events', async (req, res) => {
  const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : todayInChicago();
  const refresh = req.query.refresh === '1';
  if (refresh) weekCache.delete(date);
  const cached = weekCache.get(date);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return res.json({ ...cached.payload, cached: true });
  }
  try {
    const payload = await fetchWeek(date);
    weekCache.set(date, { fetchedAt: Date.now(), payload });
    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('Crux fetch failed:', err.message);
    res.status(502).json({ error: 'Failed to fetch Crux calendar', detail: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, today: todayInChicago(), cacheSize: weekCache.size });
});

app.listen(PORT, () => {
  console.log(`Crux calendar listening on :${PORT}`);
});

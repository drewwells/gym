const path = require('path');
const express = require('express');

const { GYMS, getGym, publicGym } = require('./gyms');
const { todayInTz, tzMidnightUTC } = require('./lib/time');
const { computeOpenFloor } = require('./lib/availability');
const { summarizeBoardDay } = require('./lib/board');

const crux = require('./providers/crux');
const crunch = require('./providers/crunch');
const lafitness = require('./providers/lafitness');
const golds = require('./providers/golds');

const PROVIDERS = { crux, crunch, lafitness, golds };

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const WEEK_DAYS = 7;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Daily prefetch keeps every live gym's current 7-day cache warm so
// /api/board and /api/availability reads always hit cached data. Runs once at
// startup and then every POLL_INTERVAL_MS thereafter.
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Stagger upstream calls so the daily warm-up doesn't fan out concurrent hits
// against the same provider's edge.
const POLL_STAGGER_MS = 750;

app.use(express.static('public'));

// Cache key: `${gymId}:${weekStartDate}` -> { fetchedAt, payload }
const weekCache = new Map();
// Same-key dedupe for in-flight upstream fetches (cold loads and background
// refreshes alike) so concurrent callers share one provider call.
const inflight = new Map();

// Fetch from the provider and store in the cache. Concurrent callers for the
// same key share the same promise. Errors propagate to the caller; background
// refreshers should catch and log so a transient upstream failure doesn't take
// down the process or evict the stale entry we just served.
function fetchAndCache(gym, date, cacheKey) {
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const p = (async () => {
    const startUTC = tzMidnightUTC(date, gym.tz);
    const endUTC = new Date(startUTC.getTime() + WEEK_DAYS * 24 * 60 * 60 * 1000 - 1);

    let events = [];
    if (gym.status === 'live') {
      const provider = PROVIDERS[gym.provider];
      if (!provider) throw new Error(`unknown provider: ${gym.provider}`);
      events = await provider.fetchWeek(gym, startUTC, endUTC);
      events.sort((a, b) => new Date(a.startDT) - new Date(b.startDT));
    }

    const payload = {
      gymId: gym.id,
      weekStart: date,
      weekEnd: endUTC.toISOString(),
      events,
    };
    weekCache.set(cacheKey, { fetchedAt: Date.now(), payload });
    return payload;
  })().finally(() => inflight.delete(cacheKey));

  inflight.set(cacheKey, p);
  return p;
}

// Calendar-day delta between two YYYY-MM-DD strings (positive if `b > a`).
// Used to test whether a requested date falls inside the current 7-day strip.
function dayDelta(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Fetch (or serve cached) one week of normalized events for a gym. The cache
// key is normally anchored on the gym's *local today* so every date in the
// current 7-day strip shares a single weekly upstream fetch (the one the
// daily poller warms). Dates outside the strip fall back to a date-anchored
// entry so explicit deep links to past/future dates still work.
//
// Stale-while-revalidate: fresh entries (younger than CACHE_TTL_MS) are
// returned as-is. Stale entries are returned immediately and a background
// refresh is kicked off. Only a cold cache blocks the caller on the upstream
// call. `?refresh=1` bypasses both paths and forces a foreground fetch.
async function getWeek(gym, date, { refresh = false } = {}) {
  const gymToday = todayInTz(gym.tz);
  const delta = dayDelta(gymToday, date);
  const anchor = (delta >= 0 && delta < WEEK_DAYS) ? gymToday : date;
  const cacheKey = `${gym.id}:${anchor}`;
  if (refresh) {
    weekCache.delete(cacheKey);
    const payload = await fetchAndCache(gym, anchor, cacheKey);
    return { ...payload, cached: false };
  }

  const cached = weekCache.get(cacheKey);
  if (cached) {
    const stale = Date.now() - cached.fetchedAt >= CACHE_TTL_MS;
    if (stale) {
      fetchAndCache(gym, anchor, cacheKey).catch((err) => {
        console.error(`[${gym.id}] background refresh failed:`, err.message);
      });
    }
    return { ...cached.payload, cached: true, stale };
  }

  const payload = await fetchAndCache(gym, anchor, cacheKey);
  return { ...payload, cached: false };
}

// Resolve the ?gym= param to a registry entry, defaulting to the first live
// gym. Returns null if an explicit, unknown id was given.
function resolveGym(req) {
  if (req.query.gym) return getGym(req.query.gym);
  return GYMS.find((g) => g.status === 'live') || GYMS[0];
}

function resolveDate(req, gym) {
  const d = req.query.date;
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayInTz(gym.tz);
}

app.get('/api/gyms', (_req, res) => {
  res.json({ gyms: GYMS.map(publicGym) });
});

app.get('/api/events', async (req, res) => {
  const gym = resolveGym(req);
  if (!gym) return res.status(404).json({ error: `unknown gym: ${req.query.gym}` });
  const date = resolveDate(req, gym);
  try {
    const payload = await getWeek(gym, date, { refresh: req.query.refresh === '1' });
    res.json(payload);
  } catch (err) {
    console.error(`[${gym.id}] fetch failed:`, err.message);
    res.status(502).json({ error: 'Failed to fetch schedule', detail: err.message });
  }
});

app.get('/api/availability', async (req, res) => {
  const gym = resolveGym(req);
  if (!gym) return res.status(404).json({ error: `unknown gym: ${req.query.gym}` });
  const date = resolveDate(req, gym);
  try {
    const week = await getWeek(gym, date, { refresh: req.query.refresh === '1' });
    const openFloor = computeOpenFloor(week.events, gym, date);
    res.json({ gymId: gym.id, cached: week.cached, stale: week.stale, ...openFloor });
  } catch (err) {
    console.error(`[${gym.id}] availability failed:`, err.message);
    res.status(502).json({ error: 'Failed to compute availability', detail: err.message });
  }
});

// Aggregate view used by the home board: for the requested calendar date (in
// each gym's own timezone), return the day's open-floor summary for every gym
// — dance-suitable room's gaps + classes, plus rollups. Coming-soon gyms are
// included so the UI can render them dim. Reads are served from the warmed
// cache; one slow/failing upstream never blocks the rest.
app.get('/api/board', async (req, res) => {
  const refresh = req.query.refresh === '1';
  // The board's date is interpreted in each gym's own tz; without a query
  // param, anchor on the first live gym's today (all current gyms share
  // America/Chicago, so this is unambiguous in practice).
  const anchorTz = (GYMS.find((g) => g.status === 'live') || GYMS[0]).tz;
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : todayInTz(anchorTz);

  const gyms = await Promise.all(GYMS.map(async (gym) => {
    const base = publicGym(gym);
    if (gym.status !== 'live') {
      return { ...base, day: null };
    }
    try {
      // getWeek anchors its cache on the gym's local today for any in-strip
      // date, so this shares the cache entry the daily poller warms — no
      // matter which strip-day the user is asking about.
      const week = await getWeek(gym, date, { refresh });
      const summary = summarizeBoardDay(week.events, gym, date);
      return { ...base, day: summary, cached: week.cached, stale: week.stale };
    } catch (err) {
      console.error(`[${gym.id}] board entry failed:`, err.message);
      return { ...base, day: null, error: err.message };
    }
  }));

  res.json({ date, gyms });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, today: todayInTz(), gyms: GYMS.length, cacheSize: weekCache.size });
});

// Walk every live, poll-enabled gym in sequence (small delay between to avoid
// concurrent fans against the same upstream) and force-refresh the current
// 7-day window. One failure logs and moves on — the rest still get warmed.
// Gyms with `poll: false` are skipped (still reachable on demand).
async function pollAllGyms() {
  const live = GYMS.filter((g) => g.status === 'live' && g.poll !== false);
  console.log(`Daily poll: refreshing ${live.length} gyms…`);
  let ok = 0;
  let fail = 0;
  for (const gym of live) {
    try {
      const today = todayInTz(gym.tz);
      await getWeek(gym, today, { refresh: true });
      ok++;
    } catch (err) {
      fail++;
      console.error(`[${gym.id}] daily poll failed:`, err.message);
    }
    if (POLL_STAGGER_MS > 0) {
      await new Promise((r) => setTimeout(r, POLL_STAGGER_MS));
    }
  }
  console.log(`Daily poll done: ${ok} ok, ${fail} failed`);
}

function startDailyPoll() {
  // Fire-and-forget initial warm-up. Don't block the listen() callback on it
  // — readiness probes shouldn't wait for upstreams.
  pollAllGyms().catch((err) => console.error('initial poll failed:', err.message));
  setInterval(() => {
    pollAllGyms().catch((err) => console.error('daily poll failed:', err.message));
  }, POLL_INTERVAL_MS).unref();
}

// SPA fallback: deep links like /crunch-round-rock have no file on disk
// (express.static above already served real assets and /api/* is handled by
// the routes above), so serve index.html and let the client route to the gym.
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Gym calendar listening on :${PORT} (${GYMS.length} gyms)`);
  startDailyPoll();
});

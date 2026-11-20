const path = require('path');
const express = require('express');

const { GYMS, getGym, publicGym } = require('./gyms');
const { todayInTz, tzMidnightUTC } = require('./lib/time');
const { createWeekCache, addDays, msUntilNextLocal, WEEK_DAYS } = require('./lib/week-cache');
const { computeOpenFloor } = require('./lib/availability');
const { summarizeBoardDay, dayClasses } = require('./lib/board');

const crux = require('./providers/crux');
const crunch = require('./providers/crunch');
const lafitness = require('./providers/lafitness');
const golds = require('./providers/golds');
const lifetime = require('./providers/lifetime');
const blackswan = require('./providers/blackswan');

const PROVIDERS = { crux, crunch, lafitness, golds, lifetime, blackswan };

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// A cached week is served as fresh for 24h; after that it is still served,
// with a background refresh (stale-while-revalidate, lib/week-cache.js).
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Daily refresh job: at this local time each night, fetch the window that
// starts tomorrow, so the cache key that takes over at local midnight already
// exists and nobody's first load of the day waits on a scrape.
const DAILY_REFRESH_AT = { hh: 23, mm: 30 };
// Stagger upstream calls so the refresh job doesn't fan out concurrent hits
// against the same provider's edge.
const POLL_STAGGER_MS = 750;

app.use(express.static('public'));

// One upstream fetch: the gym's events for the 7 local days from `anchor`.
async function fetchWeek(gym, anchor) {
  const startUTC = tzMidnightUTC(anchor, gym.tz);
  const endUTC = new Date(startUTC.getTime() + WEEK_DAYS * 24 * 60 * 60 * 1000 - 1);
  let events = [];
  if (gym.status === 'live') {
    const provider = PROVIDERS[gym.provider];
    if (!provider) throw new Error(`unknown provider: ${gym.provider}`);
    const t0 = Date.now();
    events = await provider.fetchWeek(gym, startUTC, endUTC);
    events.sort((a, b) => new Date(a.startDT) - new Date(b.startDT));
    console.log(`${new Date().toISOString()} [${gym.id}] upstream fetch ${anchor}: ${events.length} events in ${Date.now() - t0}ms`);
  }
  return {
    gymId: gym.id,
    // Start date of the cached 7-day window (named weekStart for API compat).
    weekStart: anchor,
    weekEnd: endUTC.toISOString(),
    events,
  };
}

const weekCache = createWeekCache({ fetchWeek, ttlMs: CACHE_TTL_MS });
const getWeek = (gym, date, opts) => weekCache.get(gym, date, opts);

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
    res.json({
      gymId: gym.id, cached: week.cached, stale: week.stale, ...openFloor,
      allClasses: dayClasses(week.events, date),
    });
  } catch (err) {
    console.error(`[${gym.id}] availability failed:`, err.message);
    res.status(502).json({ error: 'Failed to compute availability', detail: err.message });
  }
});

// One gym's board row for one date: the day's open-floor summary for the
// dance-suitable room (gaps + classes) plus rollups. Coming-soon gyms come
// back with day: null so the UI can render them dim. Never throws — a failing
// upstream becomes { error } on that row only.
async function boardRow(gym, date, { refresh = false } = {}) {
  const base = publicGym(gym);
  if (gym.status !== 'live') return { ...base, day: null };
  try {
    const week = await getWeek(gym, date, { refresh });
    return { ...base, day: summarizeBoardDay(week.events, gym, date), cached: week.cached, stale: week.stale };
  } catch (err) {
    console.error(`[${gym.id}] board entry failed:`, err.message);
    return { ...base, day: null, error: err.message };
  }
}

// The board's date is interpreted in each gym's own tz; without a query
// param, anchor on the first live gym's today (all current gyms share
// America/Chicago, so this is unambiguous in practice).
function boardDate(q) {
  const anchorTz = (GYMS.find((g) => g.status === 'live') || GYMS[0]).tz;
  return (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) ? q : todayInTz(anchorTz);
}

// Aggregate view for one date: every gym's row, all at once.
app.get('/api/board', async (req, res) => {
  const date = boardDate(req.query.date);
  const refresh = req.query.refresh === '1';
  const gyms = await Promise.all(GYMS.map((gym) => boardRow(gym, date, { refresh })));
  res.json({ date, gyms });
});

// The whole 7-day strip for the home board, streamed as NDJSON so the client
// can paint each gym the moment its data is ready instead of waiting for the
// slowest provider. Lines, in order:
//   {"type":"start","start","dates":[7 dates],"pending":[live gym ids]}
//   {"type":"gym","id","days":{date: row}}   one per gym, in completion order
//   {"type":"done"}
// Warm-cache gyms all arrive within a few ms; only a cold gym is slow.
app.get('/api/board/week', async (req, res) => {
  const start = boardDate(req.query.start);
  const dates = Array.from({ length: WEEK_DAYS }, (_, i) => addDays(start, i));
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    // nginx (proxy-dfw) buffers proxied responses unless told not to.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (obj) => { if (!closed) res.write(`${JSON.stringify(obj)}\n`); };

  send({ type: 'start', start, dates, pending: GYMS.filter((g) => g.status === 'live').map((g) => g.id) });
  await Promise.all(GYMS.map(async (gym) => {
    const rows = await Promise.all(dates.map((d) => boardRow(gym, d)));
    send({ type: 'gym', id: gym.id, days: Object.fromEntries(dates.map((d, i) => [d, rows[i]])) });
  }));
  send({ type: 'done' });
  res.end();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, today: todayInTz(), gyms: GYMS.length, cacheSize: weekCache.size() });
});

// Walk every live, poll-enabled gym in sequence (small delay between so we
// don't fan out against one upstream) and fetch the window starting at
// `anchorFor(gym)`, overwriting the cached copy. One failure logs and moves
// on; windows already fresh are skipped. Gyms with `poll: false` are skipped
// (still fetched on demand).
async function refreshAllGyms(label, anchorFor) {
  const live = GYMS.filter((g) => g.status === 'live' && g.poll !== false);
  console.log(`${new Date().toISOString()} ${label}: refreshing ${live.length} gyms…`);
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  for (const gym of live) {
    const anchor = anchorFor(gym);
    weekCache.evictExpired(gym);
    // A reader may already have filled it (e.g. a page load during startup).
    if (weekCache.isFresh(gym, anchor)) { skipped++; continue; }
    try {
      await weekCache.warm(gym, anchor);
      ok++;
    } catch (err) {
      fail++;
      console.error(`[${gym.id}] ${label} failed:`, err.message);
    }
    if (POLL_STAGGER_MS > 0) await new Promise((r) => setTimeout(r, POLL_STAGGER_MS));
  }
  console.log(`${new Date().toISOString()} ${label} done: ${ok} ok, ${fail} failed, ${skipped} already fresh`);
}

// At startup, fill today's window (the cache is in memory, so a restart
// starts empty). Then every night at DAILY_REFRESH_AT local, fetch the window
// that starts tomorrow, ready for the midnight key rollover. Between runs,
// reads come from the cache; a stale entry refreshes in the background.
function startDailyRefresh() {
  refreshAllGyms('startup refresh', (g) => todayInTz(g.tz))
    .catch((err) => console.error('startup refresh failed:', err.message));
  const tz = (GYMS.find((g) => g.status === 'live') || GYMS[0]).tz;
  const schedule = () => {
    const ms = msUntilNextLocal(tz, DAILY_REFRESH_AT.hh, DAILY_REFRESH_AT.mm);
    console.log(`Daily refresh scheduled in ${Math.round(ms / 60000)} min`);
    setTimeout(async () => {
      await refreshAllGyms('daily refresh', (g) => addDays(todayInTz(g.tz), 1))
        .catch((err) => console.error('daily refresh failed:', err.message));
      schedule();
    }, ms).unref();
  };
  schedule();
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
  startDailyRefresh();
});

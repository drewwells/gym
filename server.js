const express = require('express');

const { GYMS, getGym, publicGym } = require('./gyms');
const { todayInTz, tzMidnightUTC } = require('./lib/time');
const { computeOpenFloor } = require('./lib/availability');

const crux = require('./providers/crux');
const crunch = require('./providers/crunch');

const PROVIDERS = { crux, crunch };

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const WEEK_DAYS = 7;
const CACHE_TTL_MS = 10 * 60 * 1000;

app.use(express.static('public'));

// Cache key: `${gymId}:${weekStartDate}` -> { fetchedAt, payload }
const weekCache = new Map();

// Fetch (or serve cached) one week of normalized events for a gym, where the
// week starts at midnight `date` in the gym's timezone.
async function getWeek(gym, date, { refresh = false } = {}) {
  const cacheKey = `${gym.id}:${date}`;
  if (refresh) weekCache.delete(cacheKey);
  const cached = weekCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached.payload, cached: true };
  }

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
    res.json({ gymId: gym.id, cached: week.cached, ...openFloor });
  } catch (err) {
    console.error(`[${gym.id}] availability failed:`, err.message);
    res.status(502).json({ error: 'Failed to compute availability', detail: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, today: todayInTz(), gyms: GYMS.length, cacheSize: weekCache.size });
});

app.listen(PORT, () => {
  console.log(`Gym calendar listening on :${PORT} (${GYMS.length} gyms)`);
});

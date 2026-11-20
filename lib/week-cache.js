// In-memory week cache with stale-while-revalidate, plus the date math the
// daily refresh job needs. Pure apart from the injected `fetchWeek`, so the
// rollover / SWR / dedupe rules are unit-testable without a provider.
//
// Key: `${gym.id}:${anchor}`. For any date inside the gym's current 7-day
// strip the anchor is the gym-local today, so all strip days share one
// upstream fetch. Dates outside the strip anchor on themselves.
//
// Read order (get):
//   1. entry for the anchor exists      -> return it; if older than ttlMs,
//                                          refresh in the background.
//   2. no entry, but an older anchor's  -> return it (marked stale) and
//      entry covers the requested date     refresh in the background. This is
//                                          what keeps the first load after
//                                          local midnight from blocking.
//   3. nothing usable                    -> await the upstream (cold).
// `refresh: true` awaits a foreground fetch but overwrites the entry instead
// of deleting it first, so readers during the fetch still get the old copy.

const { todayInTz, tzWallClockUTC } = require('./time');

const WEEK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Calendar-day delta between two YYYY-MM-DD strings (positive if `b > a`).
function dayDelta(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

// Milliseconds from `nowMs` until the next hh:mm wall-clock time in `tz`.
function msUntilNextLocal(tz, hh, mm, nowMs = Date.now()) {
  const today = todayInTz(tz, nowMs);
  let at = tzWallClockUTC(today, hh, mm, tz).getTime();
  if (at <= nowMs) at = tzWallClockUTC(addDays(today, 1), hh, mm, tz).getTime();
  return at - nowMs;
}

function createWeekCache({ fetchWeek, ttlMs = DAY_MS, now = () => Date.now(), log = console } = {}) {
  const entries = new Map(); // key -> { fetchedAt, anchor, payload }
  const inflight = new Map(); // key -> Promise<payload>

  const keyOf = (gym, anchor) => `${gym.id}:${anchor}`;

  function fetchInto(gym, anchor) {
    const key = keyOf(gym, anchor);
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const payload = await fetchWeek(gym, anchor);
      entries.set(key, { fetchedAt: now(), anchor, payload });
      return payload;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function background(gym, anchor) {
    fetchInto(gym, anchor).catch((err) => {
      log.error(`[${gym.id}] background refresh failed:`, err.message);
    });
  }

  // Newest entry for this gym whose 7-day window still covers `date`.
  function coveringEntry(gym, date) {
    let best = null;
    for (const e of entries.values()) {
      if (e.payload.gymId !== gym.id) continue;
      const d = dayDelta(e.anchor, date);
      if (d < 0 || d >= WEEK_DAYS) continue;
      if (!best || e.anchor > best.anchor) best = e;
    }
    return best;
  }

  async function get(gym, date, { refresh = false } = {}) {
    const gymToday = todayInTz(gym.tz, now());
    const delta = dayDelta(gymToday, date);
    const anchor = (delta >= 0 && delta < WEEK_DAYS) ? gymToday : date;
    const key = keyOf(gym, anchor);

    if (refresh) {
      const payload = await fetchInto(gym, anchor);
      return { ...payload, cached: false, stale: false };
    }

    const hit = entries.get(key);
    if (hit) {
      const stale = now() - hit.fetchedAt >= ttlMs;
      if (stale) background(gym, anchor);
      return { ...hit.payload, cached: true, stale };
    }

    const older = coveringEntry(gym, date);
    if (older) {
      background(gym, anchor);
      return { ...older.payload, cached: true, stale: true };
    }

    const payload = await fetchInto(gym, anchor);
    return { ...payload, cached: false, stale: false };
  }

  // Fetch the window anchored on `anchor` and store it, overwriting any entry.
  function warm(gym, anchor) {
    return fetchInto(gym, anchor);
  }

  // Drop entries whose whole window ended before `gym`'s local today.
  function evictExpired(gym) {
    const gymToday = todayInTz(gym.tz, now());
    for (const [key, e] of entries) {
      if (e.payload.gymId === gym.id && dayDelta(e.anchor, gymToday) >= WEEK_DAYS) entries.delete(key);
    }
  }

  // True if the window anchored on `anchor` is cached and younger than ttlMs.
  function isFresh(gym, anchor) {
    const e = entries.get(keyOf(gym, anchor));
    return Boolean(e) && now() - e.fetchedAt < ttlMs;
  }

  return {
    get, warm, evictExpired, isFresh,
    size: () => entries.size,
    has: (gym, anchor) => entries.has(keyOf(gym, anchor)),
  };
}

module.exports = { createWeekCache, addDays, dayDelta, msUntilNextLocal, WEEK_DAYS };

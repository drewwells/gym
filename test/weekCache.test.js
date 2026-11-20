const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWeekCache, msUntilNextLocal, addDays } = require('../lib/week-cache');

const GYM = { id: 'g', tz: 'America/Chicago' };
// 2026-11-20 12:00 CST (UTC-6).
const NOON = Date.UTC(2026, 10, 20, 18, 0, 0);
const HOUR = 3600 * 1000;

function harness(startMs = NOON, ttlMs) {
  let nowMs = startMs;
  const calls = [];
  const resolvers = [];
  const cache = createWeekCache({
    now: () => nowMs,
    ...(ttlMs ? { ttlMs } : {}),
    log: { error() {} },
    fetchWeek: (gym, anchor) => {
      calls.push(anchor);
      return new Promise((resolve) => resolvers.push(() => resolve({ gymId: gym.id, weekStart: anchor, events: [anchor] })));
    },
  });
  const flush = async () => { while (resolvers.length) resolvers.shift()(); await new Promise((r) => setImmediate(r)); };
  return { cache, calls, flush, set: (ms) => { nowMs = ms; } };
}

test('cold miss fetches once; concurrent strip-day reads share it', async () => {
  const { cache, calls, flush } = harness();
  const reads = ['2026-11-20', '2026-11-22', '2026-11-26'].map((d) => cache.get(GYM, d));
  await flush();
  const out = await Promise.all(reads);
  assert.deepEqual(calls, ['2026-11-20']);
  assert.ok(out.every((w) => w.weekStart === '2026-11-20' && w.cached === false));
});

test('fresh hit makes no upstream call', async () => {
  const { cache, calls, flush } = harness();
  const p = cache.get(GYM, '2026-11-20'); await flush(); await p;
  const w = await cache.get(GYM, '2026-11-21');
  assert.equal(calls.length, 1);
  assert.equal(w.cached, true);
  assert.equal(w.stale, false);
});

test('stale hit returns at once and refreshes in the background', async () => {
  const h = harness(NOON, HOUR);
  const p = h.cache.get(GYM, '2026-11-20'); await h.flush(); await p;
  h.set(NOON + 2 * HOUR);
  const w = await h.cache.get(GYM, '2026-11-20'); // resolves without flush
  assert.equal(w.cached, true);
  assert.equal(w.stale, true);
  assert.equal(h.calls.length, 2, 'background refresh fired');
});

test('after local midnight, yesterday\'s window serves today without blocking', async () => {
  const h = harness(Date.UTC(2026, 10, 21, 5, 0, 0)); // 11-20 23:00 CST
  const p = h.cache.get(GYM, '2026-11-20'); await h.flush(); await p;
  h.set(Date.UTC(2026, 10, 21, 6, 30, 0)); // 11-21 00:30 CST — new key 11-21 is cold
  const w = await h.cache.get(GYM, '2026-11-21'); // resolves without flush
  assert.equal(w.weekStart, '2026-11-20');
  assert.equal(w.stale, true);
  assert.deepEqual(h.calls, ['2026-11-20', '2026-11-21'], 'background fetch for the new window');
  // Day 7 of the new strip isn't in yesterday's window: that one must wait.
  let settled = false;
  const last = h.cache.get(GYM, '2026-11-27').then((x) => { settled = true; return x; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  await h.flush();
  assert.equal((await last).weekStart, '2026-11-21');
});

test('warm(tomorrow) means the midnight rollover is a fresh hit', async () => {
  const h = harness(Date.UTC(2026, 10, 21, 5, 30, 0)); // 11-20 23:30 CST
  const p = h.cache.warm(GYM, '2026-11-21'); await h.flush(); await p;
  h.set(Date.UTC(2026, 10, 21, 6, 1, 0)); // 11-21 00:01 CST
  const w = await h.cache.get(GYM, '2026-11-26');
  assert.equal(w.weekStart, '2026-11-21');
  assert.equal(w.stale, false);
  assert.equal(h.calls.length, 1);
});

test('refresh overwrites instead of deleting: readers keep the old copy meanwhile', async () => {
  const h = harness();
  const p = h.cache.get(GYM, '2026-11-20'); await h.flush(); await p;
  const forced = h.cache.get(GYM, '2026-11-20', { refresh: true });
  const during = await h.cache.get(GYM, '2026-11-20');
  assert.equal(during.cached, true);
  await h.flush();
  assert.equal((await forced).cached, false);
  assert.equal(h.calls.length, 2);
});

test('evictExpired drops windows that ended before today', async () => {
  const h = harness();
  const a = h.cache.warm(GYM, '2026-11-10'); const b = h.cache.warm(GYM, '2026-11-20');
  await h.flush(); await a; await b;
  h.cache.evictExpired(GYM);
  assert.equal(h.cache.size(), 1);
  assert.ok(h.cache.has(GYM, '2026-11-20'));
});

test('msUntilNextLocal: later today, else tomorrow; DST-safe', () => {
  // Noon CST -> 23:30 same day = 11.5h.
  assert.equal(msUntilNextLocal('America/Chicago', 23, 30, NOON), 11.5 * HOUR);
  // 23:45 CST -> next day's 23:30 = 23.75h.
  assert.equal(msUntilNextLocal('America/Chicago', 23, 30, Date.UTC(2026, 10, 21, 5, 45)), 23.75 * HOUR);
  // Across the 2026-11-01 fall-back: 10-31 23:45 CDT -> 11-01 23:30 CST is 24.75h.
  assert.equal(msUntilNextLocal('America/Chicago', 23, 30, Date.UTC(2026, 10, 1, 4, 45)), 24.75 * HOUR);
});

test('addDays crosses month and year', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('isFresh: true only for a cached window younger than the TTL', async () => {
  const h = harness(NOON, HOUR);
  assert.equal(h.cache.isFresh(GYM, '2026-11-20'), false);
  const p = h.cache.warm(GYM, '2026-11-20'); await h.flush(); await p;
  assert.equal(h.cache.isFresh(GYM, '2026-11-20'), true);
  h.set(NOON + 2 * HOUR);
  assert.equal(h.cache.isFresh(GYM, '2026-11-20'), false);
});

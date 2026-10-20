// "Which floors are free at Tuesday 7 PM?" — the board's time picker.
// Shared by the browser (window.FreeAt) and the unit tests (require).
//
// Times are minutes since local midnight in the gym's own timezone, so a
// Knoxville 7 PM is 7 PM Eastern. A floor is free at `t` when one open
// window (a gap: inside opening hours, no class in the dance room) covers
// all of [t, t + dur). A class ending exactly at t is fine; one starting at
// t + 15 or t + 30 blocks the slot.
(function (root) {
  'use strict';

  const SLOT_MIN = 60; // default length of the slot asked about

  // gaps / events: [{ start, end }] in minutes (events also carry `name`).
  // Returns { free: true, from, until } for the covering window, else
  // { free: false, blocker, freeFrom }: the first class overlapping the slot
  // (null when the gym is simply closed then) and the soonest start at or
  // after t where a full slot fits (null when none does that day).
  function floorAt(gaps, events, t, dur = SLOT_MIN) {
    const gap = gaps.find((g) => g.start <= t && g.end >= t + dur);
    if (gap) return { free: true, from: gap.start, until: gap.end };
    const blocker = events.find((e) => e.start < t + dur && e.end > t) || null;
    let freeFrom = null;
    for (const g of gaps) {
      const s = Math.max(g.start, t);
      if (g.end - s >= dur && (freeFrom === null || s < freeFrom)) freeFrom = s;
    }
    return { free: false, blocker, freeFrom };
  }

  // Board rows (already in minutes) → { free, busy }. Free floors keep the
  // board's own order; busy ones sort soonest-free first, never-free last.
  // Classes-only studios have no floor and are skipped.
  function freeFloorsAt(rows, t, dur = SLOT_MIN) {
    const free = [];
    const busy = [];
    for (const r of rows) {
      if (r.classesOnly || !r.gaps) continue;
      const res = floorAt(r.gaps, r.events || [], t, dur);
      (res.free ? free : busy).push({ row: r.row || r, ...res });
    }
    const key = (b) => (b.freeFrom === null ? Infinity : b.freeFrom);
    busy.sort((a, b) => key(a) - key(b));
    return { free, busy };
  }

  const api = { SLOT_MIN, floorAt, freeFloorsAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FreeAt = api;
})(this);

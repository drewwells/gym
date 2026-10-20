// "Which floors have an hour free between 10 AM and 4 PM?" — the board's
// time band. Shared by the browser (window.FreeAt) and the unit tests.
//
// Times are minutes since local midnight in the gym's own timezone, so a
// Knoxville 7 PM is 7 PM Eastern. A floor qualifies for the band [from, to]
// when one open window (a gap: inside opening hours, no class in the dance
// room) overlaps the band by at least SLOT_MIN contiguous minutes. A class
// ending exactly at `from` is fine; one starting 15 or 30 minutes into a
// one-hour band blocks it.
(function (root) {
  'use strict';

  const SLOT_MIN = 60; // shortest stretch worth showing up for

  // gaps / events: [{ start, end }] in minutes (events also carry `name`).
  // Returns { free, windows, longest, blockers }:
  //   windows  – each gap clipped to the band, only those >= dur long
  //   longest  – the longest clipped stretch (any length), in minutes
  //   blockers – classes overlapping the band, for "what's in the way"
  function floorInBand(gaps, events, from, to, dur = SLOT_MIN) {
    const clipped = gaps
      .map((g) => ({ start: Math.max(g.start, from), end: Math.min(g.end, to) }))
      .filter((w) => w.end > w.start);
    const windows = clipped.filter((w) => w.end - w.start >= dur);
    const longest = clipped.reduce((m, w) => Math.max(m, w.end - w.start), 0);
    const blockers = events.filter((e) => e.start < to && e.end > from);
    return { free: windows.length > 0, windows, longest, blockers };
  }

  // Board rows (already in minutes) → { free, busy }. Free floors keep the
  // given order; busy ones sort by longest free stretch, biggest first.
  // Classes-only studios have no floor and are skipped.
  function freeFloorsInBand(rows, from, to, dur = SLOT_MIN) {
    const free = [];
    const busy = [];
    for (const r of rows) {
      if (r.classesOnly || !r.gaps) continue;
      const res = floorInBand(r.gaps, r.events || [], from, to, dur);
      (res.free ? free : busy).push({ row: r.row || r, ...res });
    }
    busy.sort((a, b) => b.longest - a.longest);
    return { free, busy };
  }

  // The band the board lets you pick: 8 AM to 10 PM (Drew, 2026-10-20:
  // "go beyond 8pm… extend to 10pm"). Gyms' own closing hours still trim
  // the free windows; this only bounds the picker.
  const BAND_MIN = 8 * 60;
  const BAND_MAX = 22 * 60;

  // Keep [from, to] inside the bounds and at least SLOT_MIN long; the end
  // that moved (`moved`) wins and pushes the other one along.
  function clampBand(from, to, moved = 'from') {
    from = Math.max(BAND_MIN, Math.min(BAND_MAX - SLOT_MIN, from));
    to = Math.max(BAND_MIN + SLOT_MIN, Math.min(BAND_MAX, to));
    if (to - from < SLOT_MIN) {
      if (moved === 'from') to = from + SLOT_MIN;
      else from = to - SLOT_MIN;
    }
    return [from, to];
  }

  // Earlier / later: slide the whole band, keeping its length.
  function shiftBand([from, to], delta) {
    const len = to - from;
    const start = Math.max(BAND_MIN, Math.min(BAND_MAX - len, from + delta));
    return [start, start + len];
  }

  // Longer: grow the end; once it hits BAND_MAX, grow the start instead.
  function growBand([from, to], step) {
    return to < BAND_MAX ? clampBand(from, to + step, 'to') : clampBand(from - step, to, 'from');
  }

  const api = { SLOT_MIN, BAND_MIN, BAND_MAX, floorInBand, freeFloorsInBand, clampBand, shiftBand, growBand };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FreeAt = api;
})(this);

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

  const api = { SLOT_MIN, floorInBand, freeFloorsInBand };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FreeAt = api;
})(this);

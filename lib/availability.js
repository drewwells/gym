// Open Floor computation: invert class occupancy to find when a dance-suitable
// room is free. Pure functions over the normalized event model so they can be
// unit-tested without any network.

const { tzMidnightUTC } = require('./time');

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

// Day-of-week keys for hoursByDay lookups (Sun=0..Sat=6, matching getUTCDay).
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Day of week for a YYYY-MM-DD string interpreted as the gym's *local* date.
// The weekday of a calendar date is tz-independent (it's a property of the
// date label itself, not a wall-clock instant), so a UTC construction is the
// correct, ambiguity-free way to derive it.
function dayOfWeekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// Pick the gym's *effective* open window for the given date. The model has
// two stacked sources:
//
//   1. `hoursByDay` — real-world club hours per weekday (Sun..Sat). Source of
//      truth for opening/closing; this is what gets fact-checked against the
//      official site.
//   2. `usableWindow` — soft "wake-hours" cap (defaults 06:00-22:00) so a
//      24/7 club doesn't report 3 AM as free floor.
//
// The effective window is their intersection (later open, earlier close).
// If a layer is missing, the other one stands alone. If they don't overlap
// (e.g. usableWindow 06:00-22:00 vs a club open 22:00-02:00 only), the
// returned window collapses to zero length — no false-positive free time.
function resolveDayWindow(gym, dateStr) {
  const usable = gym.usableWindow || null;
  const byDay = gym.hoursByDay ? gym.hoursByDay[dayOfWeekKey(dateStr)] : null;
  if (!byDay && !usable) return null;
  if (!byDay) return { start: usable.start, end: usable.end };
  if (!usable) return { start: byDay.open, end: byDay.close };
  const startMin = Math.max(hhmmToMinutes(usable.start), hhmmToMinutes(byDay.open));
  const endMin = Math.min(hhmmToMinutes(usable.end), hhmmToMinutes(byDay.close));
  // Collapse to zero length if no overlap (caller treats that as no free time).
  const safeEnd = Math.max(startMin, endMin);
  const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return { start: fmt(startMin), end: fmt(safeEnd) };
}

// Merge overlapping/adjacent [start,end] ms intervals into a sorted, disjoint
// list.
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

// The complement of `busy` within [winStart, winEnd], as free intervals.
function complement(winStart, winEnd, busy) {
  const gaps = [];
  let cursor = winStart;
  for (const iv of busy) {
    if (iv.end <= winStart || iv.start >= winEnd) continue; // outside window
    const s = Math.max(iv.start, winStart);
    const e = Math.min(iv.end, winEnd);
    if (s > cursor) gaps.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (cursor < winEnd) gaps.push({ start: cursor, end: winEnd });
  return gaps;
}

// Compute free-floor gaps for a single day at one gym.
//
//   events  normalized events (a whole week is fine; filtered here by date)
//   gym     registry entry (tz, danceRooms, hoursByDay, usableWindow, minGapMinutes)
//   date    YYYY-MM-DD in the gym's timezone
//
// Returns one block per dance-suitable room, each with the day's classes in
// that room and the free gaps between them (within the resolved per-day
// window, at least minGapMinutes long). The window is resolved by
// `resolveDayWindow`: real club hours intersected with the wake-hours cap.
function computeOpenFloor(events, gym, date) {
  const dayMidnightUTC = tzMidnightUTC(date, gym.tz).getTime();
  const toUTCms = (hhmm) => dayMidnightUTC + hhmmToMinutes(hhmm) * 60000;
  const win = resolveDayWindow(gym, date) || { start: '00:00', end: '00:00' };
  const winStart = toUTCms(win.start);
  const winEnd = toUTCms(win.end);
  const minGapMs = (gym.minGapMinutes || 0) * 60000;

  const dayEvents = events.filter(
    (e) => e.occurrenceDate === date && e.danceSuitable,
  );

  const rooms = gym.danceRooms.map((room) => {
    const classes = dayEvents
      .filter((e) => e.room === room)
      .sort((a, b) => new Date(a.startDT) - new Date(b.startDT));
    const busy = mergeIntervals(
      classes.map((e) => ({
        start: new Date(e.startDT).getTime(),
        end: new Date(e.endDT).getTime(),
      })),
    );
    const gaps = complement(winStart, winEnd, busy)
      .filter((g) => g.end - g.start >= minGapMs)
      .map((g) => ({
        startDT: new Date(g.start).toISOString(),
        endDT: new Date(g.end).toISOString(),
        minutes: Math.round((g.end - g.start) / 60000),
      }));
    return {
      room,
      classes: classes.map((e) => ({
        name: e.name, startDT: e.startDT, endDT: e.endDT,
      })),
      gaps,
    };
  });

  return {
    date,
    // The effective window for this date (after intersecting club hours with
    // the wake-hours cap), not the raw usableWindow — so callers see the same
    // bounds the gap calc used.
    window: { start: win.start, end: win.end },
    minGapMinutes: gym.minGapMinutes || 0,
    rooms,
  };
}

module.exports = { computeOpenFloor, mergeIntervals, complement, resolveDayWindow, dayOfWeekKey };

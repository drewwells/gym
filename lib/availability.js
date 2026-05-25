// Open Floor computation: invert class occupancy to find when a dance-suitable
// room is free. Pure functions over the normalized event model so they can be
// unit-tested without any network.

const { tzMidnightUTC } = require('./time');

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
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
//   gym     registry entry (tz, danceRooms, usableWindow, minGapMinutes)
//   date    YYYY-MM-DD in the gym's timezone
//
// Returns one block per dance-suitable room, each with the day's classes in
// that room and the free gaps between them (within the usable window, at
// least minGapMinutes long).
function computeOpenFloor(events, gym, date) {
  const dayMidnightUTC = tzMidnightUTC(date, gym.tz).getTime();
  const toUTCms = (hhmm) => dayMidnightUTC + hhmmToMinutes(hhmm) * 60000;
  const winStart = toUTCms(gym.usableWindow.start);
  const winEnd = toUTCms(gym.usableWindow.end);
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
    window: { start: gym.usableWindow.start, end: gym.usableWindow.end },
    minGapMinutes: gym.minGapMinutes || 0,
    rooms,
  };
}

module.exports = { computeOpenFloor, mergeIntervals, complement };

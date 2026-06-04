// Home-board aggregation. Takes one gym's already-fetched weekly events and
// folds them down to the single-day view the board renders: gaps + classes
// for the dance-suitable room(s), plus rollups (total open minutes, count of
// open windows). Pure — unit-testable without any provider I/O.
//
// Most gyms have a single dance-suitable room; for the rare gym with more
// than one, gaps and classes are merged across rooms (a class in *any*
// dance-suitable room blocks the floor for that gym).

const { computeOpenFloor } = require('./availability');

// Reduce computeOpenFloor()'s per-room output down to a single per-gym day
// summary for the board. Keeps the same shape as /api/availability's room
// entries (gaps with startDT/endDT/minutes, classes with name/startDT/endDT)
// so the frontend can share parsing code.
function summarizeBoardDay(events, gym, date) {
  const openFloor = computeOpenFloor(events, gym, date);
  const gaps = [];
  const classes = [];
  for (const room of openFloor.rooms) {
    for (const g of room.gaps) gaps.push(g);
    for (const c of room.classes) classes.push(c);
  }
  // Sort so consumers don't have to: gaps ascending by start, classes by start.
  gaps.sort((a, b) => new Date(a.startDT) - new Date(b.startDT));
  classes.sort((a, b) => new Date(a.startDT) - new Date(b.startDT));
  const totalOpenMin = gaps.reduce((s, g) => s + g.minutes, 0);
  return {
    date,
    window: openFloor.window,
    minGapMinutes: openFloor.minGapMinutes,
    gaps,
    events: classes,
    totalOpenMin,
    windowCount: gaps.length,
  };
}

// Sort key for the board's row ordering. The board UI wants:
//   1. Open now — most time-left first
//   2. Opening later today — soonest first
//   3. Done / closed / coming-soon — at the bottom, stable by name
//
// `entry` is a board row: { gymId, day, status, ... }.  `nowMs` is the wall
// clock as a UTC epoch (so comparisons against ISO gap times are direct).
//
// Returns a tuple [bucket, secondary] where lower sorts earlier. Buckets:
//   0 — open right now
//   1 — opening later today
//   2 — done for today / no live data
function boardSortKey(entry, nowMs) {
  if (!entry.day || entry.status !== 'live' || !entry.day.gaps.length) {
    return [2, 0];
  }
  const openGap = entry.day.gaps.find(
    (g) => nowMs >= new Date(g.startDT).getTime() && nowMs < new Date(g.endDT).getTime(),
  );
  if (openGap) {
    const remaining = new Date(openGap.endDT).getTime() - nowMs;
    // Most time-left first → negate so larger remaining = smaller key.
    return [0, -remaining];
  }
  const upcoming = entry.day.gaps.find((g) => new Date(g.startDT).getTime() > nowMs);
  if (upcoming) {
    // Soonest first → start time as the secondary.
    return [1, new Date(upcoming.startDT).getTime()];
  }
  return [2, 0];
}

// Sort a list of board entries in place by [boardSortKey, then short, then id]
// so the order is fully deterministic. Returns the same array.
function sortBoardRows(entries, nowMs) {
  return entries.sort((a, b) => {
    const [ab, as] = boardSortKey(a, nowMs);
    const [bb, bs] = boardSortKey(b, nowMs);
    if (ab !== bb) return ab - bb;
    if (as !== bs) return as - bs;
    // Stable tiebreak: short name, then id.
    const an = a.short || a.name || a.gymId || '';
    const bn = b.short || b.name || b.gymId || '';
    if (an !== bn) return an < bn ? -1 : 1;
    return (a.id || a.gymId || '') < (b.id || b.gymId || '') ? -1 : 1;
  });
}

module.exports = { summarizeBoardDay, boardSortKey, sortBoardRows };

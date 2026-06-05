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

// Board row ordering. Group by brand in a fixed priority (Crunch → Gold's →
// LA Fitness), then alphabetically by short name within each brand. Brands
// not in the priority list (e.g. Crux) sort after the named ones,
// alphabetically by brand. Openness (open-now / closes-soon) no longer
// affects ordering — that's still surfaced per row via the badges/hero, but
// the row order itself is deterministic across the day so users can find a
// given gym in the same place no matter when they look.
const BRAND_PRIORITY = ["Crunch", "Gold's Gym", 'LA Fitness'];

function brandRank(brand) {
  const i = BRAND_PRIORITY.indexOf(brand || '');
  // Unknown brands sort after the named ones, then alphabetically among
  // themselves — encode that as a second component so the comparator can
  // fall through cleanly.
  return i === -1 ? [BRAND_PRIORITY.length, (brand || '').toLowerCase()] : [i, ''];
}

// Sort a list of board entries in place by [brand, short, id] so the order
// is fully deterministic and stable across reloads. Returns the same array.
// `nowMs` is accepted for API compatibility but unused.
function sortBoardRows(entries, _nowMs) {
  return entries.sort((a, b) => {
    const [ar, at] = brandRank(a.brand);
    const [br, bt] = brandRank(b.brand);
    if (ar !== br) return ar - br;
    if (at !== bt) return at < bt ? -1 : 1;
    const an = (a.short || a.name || a.gymId || '').toLowerCase();
    const bn = (b.short || b.name || b.gymId || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return (a.id || a.gymId || '') < (b.id || b.gymId || '') ? -1 : 1;
  });
}

module.exports = { summarizeBoardDay, sortBoardRows, BRAND_PRIORITY };

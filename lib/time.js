// Timezone helpers shared by all providers. All current gyms are in
// America/Chicago, but every function takes an explicit `tz` so a future
// out-of-region gym just works.

const DEFAULT_TZ = 'America/Chicago';

// Today's date (YYYY-MM-DD) in the given timezone.
function todayInTz(tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// The current hour (0-23) in the given timezone.
function hourInTz(tz = DEFAULT_TZ) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit',
  }).format(new Date())) % 24;
}

// The UTC Date corresponding to 00:00:00 on `dateStr` (YYYY-MM-DD) in `tz`.
// Handles DST transitions automatically via Intl.
function tzMidnightUTC(dateStr, tz = DEFAULT_TZ) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const offsetMin = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offsetMin * 60 * 1000);
}

// The local calendar date (YYYY-MM-DD) of an instant in the given timezone.
function dateInTz(iso, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

// A timezone's UTC offset in minutes at a given instant (negative west of
// UTC, e.g. -300 for CDT, -360 for CST).
function tzOffsetMinutes(instant, tz = DEFAULT_TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUTC = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );
  return Math.round((asUTC - instant.getTime()) / 60000);
}

module.exports = {
  DEFAULT_TZ, todayInTz, hourInTz, dateInTz, tzMidnightUTC, tzOffsetMinutes,
};

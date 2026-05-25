// Crunch Fitness provider.
//
// Crunch's site is backed by a clean JSON API (no PDF parsing needed):
//   - club info by slug: GET /crunch_core/clubs/<slug> -> { id, hours, ... }
//   - schedule:          GET /crunch_core/occurrences?club_id=&range_start=
//                            &range_end=&local=true
// Each occurrence carries an explicit `room` ("Group Fitness", "Ride",
// "HIITZone", ...). Only rooms in gym.danceRooms are dance-suitable.
// See .knowledge/entries/multi-gym-data-sources.md.

const _ax = require('axios');
const axios = _ax.default || _ax;
const { dateInTz } = require('../lib/time');

const OCCURRENCES_URL = 'https://www.crunch.com/crunch_core/occurrences';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';

function headers() {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.crunch.com/',
  };
}

function addMinutesISO(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

function normalize(occ, gym) {
  const room = occ.room ?? '';
  const startDT = occ.start_time;
  const endDT = occ.end_time
    ?? (occ.duration ? addMinutesISO(startDT, occ.duration) : startDT);
  return {
    gymId: gym.id,
    id: occ.id ?? null,
    name: occ.name ?? occ.activity_name ?? '',
    description: occ.description ?? '',
    startDT,
    endDT,
    occurrenceDate: startDT ? dateInTz(startDT, gym.tz) : null,
    room,
    danceSuitable: gym.danceRooms.includes(room),
    category: occ.category ?? null,
    instructors: Array.isArray(occ.instructors)
      ? occ.instructors.map((i) => i.full_name).filter(Boolean)
      : [],
    seatsRemaining: occ.spots_available ?? null,
    seatsTotal: occ.total_spots ?? null,
    deepLink: occ.app_deeplink || gym.sourceUrl,
    source: 'crunch',
  };
}

async function fetchWeek(gym, startUTC, endUTC) {
  const { clubId } = gym.providerConfig;
  if (clubId == null) {
    throw new Error(`gym ${gym.id} has no clubId configured`);
  }
  const res = await axios.get(OCCURRENCES_URL, {
    params: {
      club_id: clubId,
      range_start: startUTC.toISOString(),
      range_end: endUTC.toISOString(),
      local: true,
    },
    headers: headers(),
    timeout: 15000,
  });
  const data = res.data;
  const list = Array.isArray(data)
    ? data
    : (data?.occurrences || data?.results || data?.data || []);
  return list
    .filter((occ) => !occ.cancelled) // a cancelled class doesn't occupy the room
    .map((occ) => normalize(occ, gym));
}

module.exports = { fetchWeek };

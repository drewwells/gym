// The gym registry. Adding a gym = adding an entry here (plus a provider
// module if it's a new platform). Each entry is consumed by server.js to
// pick a provider, and shipped to the frontend (minus internals) via
// /api/gyms so the client can render the picker and compute open-floor gaps.
//
// Fields:
//   id            stable slug used in URLs and as the cache namespace
//   name          display label for the gym picker
//   provider      which providers/<provider>.js module fetches the schedule
//   status        'live' | 'coming-soon' (coming-soon never fetches)
//   tz            IANA timezone (all current gyms are America/Chicago)
//   providerConfig provider-specific knobs (locationId / slug / clubId)
//   danceRooms    room names treated as dance-suitable wood-floor studios.
//                 Open Floor shows free gaps for each of these separately.
//   usableWindow  {start,end} local HH:MM bounds for the Open Floor view, so
//                 24/7 clubs don't report the middle of the night as "free".
//   minGapMinutes shortest free block worth showing in Open Floor
//   sourceUrl     public schedule page (footer / "view on" links)

const DEFAULT_USABLE_WINDOW = { start: '06:00', end: '22:00' };
const DEFAULT_MIN_GAP = 30;

const GYMS = [
  {
    id: 'crux-central',
    name: 'Crux Climbing — Central',
    provider: 'crux',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { locationId: 2 },
    // Crux exposes no room field; the crux provider synthesizes "Studio" vs
    // "Climbing" from the class name. Only the Studio is dance-suitable.
    danceRooms: ['Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.cruxclimbingcenter.com/central-austin/calendar/',
  },
  {
    id: 'crunch-round-rock',
    name: 'Crunch — Round Rock',
    provider: 'crunch',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'round-rock', clubId: 236 },
    danceRooms: ['Group Fitness'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.crunch.com/locations/round-rock',
  },
  {
    id: 'crunch-south-austin',
    name: 'Crunch — South Austin',
    provider: 'crunch',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'south-austin', clubId: 550 },
    danceRooms: ['Group Fitness'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.crunch.com/locations/south-austin',
  },
  {
    id: 'crunch-north-atx',
    name: 'Crunch — North ATX',
    provider: 'crunch',
    status: 'coming-soon',
    tz: 'America/Chicago',
    providerConfig: { slug: 'northatx' },
    danceRooms: ['Group Fitness'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.crunch.com/locations/northatx',
  },
];

const byId = new Map(GYMS.map((g) => [g.id, g]));

function getGym(id) {
  return byId.get(id) || null;
}

// The default gym shown on first load: first live gym in the list.
function defaultGymId() {
  const live = GYMS.find((g) => g.status === 'live');
  return (live || GYMS[0]).id;
}

// Public, client-safe view of a gym (no internal-only fields to hide today,
// but keeps the API surface explicit so future secrets don't leak).
function publicGym(g) {
  return {
    id: g.id,
    name: g.name,
    status: g.status,
    tz: g.tz,
    danceRooms: g.danceRooms,
    usableWindow: g.usableWindow,
    minGapMinutes: g.minGapMinutes,
    sourceUrl: g.sourceUrl,
  };
}

module.exports = { GYMS, getGym, defaultGymId, publicGym };

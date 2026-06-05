// The gym registry. Adding a gym = adding an entry here (plus a provider
// module if it's a new platform). Each entry is consumed by server.js to
// pick a provider, and shipped to the frontend (minus internals) via
// /api/gyms so the client can render the bottom-sheet picker (grouped by
// brand) and the hero/source-link copy.
//
// Fields:
//   id            stable slug used in URLs and as the cache namespace
//   name          long-form label (kept for logs / fallback)
//   brand         picker grouping label, e.g. 'Crunch' / 'LA Fitness' / 'Crux'
//   short         picker row title + top-left identity, e.g. 'Round Rock'
//   neighborhood  picker row subtitle, e.g. 'Round Rock, TX'
//   room          singular human label for the dance studio used in the
//                 hero subhead ("{short}'s {room.toLowerCase()} is class-free
//                 until …"). Defaults to danceRooms[0].
//   sourceHost    short host shown in the footer source link, e.g.
//                 'lafitness.com'. Defaults to the host of sourceUrl.
//   provider      which providers/<provider>.js module fetches the schedule
//   status        'live' | 'coming-soon' (coming-soon never fetches)
//   poll          optional; defaults true. Set false to exclude this gym from
//                 the daily cache warm-up (still reachable via /api/* on
//                 demand — the cold call just blocks the first caller). Use
//                 for gyms we keep registered but don't actively care about.
//   tz            IANA timezone (all current gyms are America/Chicago)
//   providerConfig provider-specific knobs (locationId / slug / clubId)
//   danceRooms    room names treated as dance-suitable wood-floor studios.
//                 Open Floor shows free gaps for each of these separately.
//   usableWindow  {start,end} local HH:MM bounds for the Open Floor view, so
//                 24/7 clubs don't report the middle of the night as "free".
//   minGapMinutes shortest free block worth showing in Open Floor
//   sourceUrl     public schedule page (footer source link href)

const DEFAULT_USABLE_WINDOW = { start: '06:00', end: '22:00' };
const DEFAULT_MIN_GAP = 30;

const GYMS = [
  {
    id: 'crux-central',
    name: 'Crux Climbing — Central',
    brand: 'Crux',
    short: 'Central',
    neighborhood: 'Central Austin',
    room: 'Studio',
    sourceHost: 'cruxclimbingcenter.com',
    provider: 'crux',
    status: 'live',
    // Crux remains in the registry (deep links keep working) but we don't
    // proactively warm its cache — it's not a destination we're optimizing
    // for. First on-demand request pays the cold fetch.
    poll: false,
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
    brand: 'Crunch',
    short: 'Round Rock',
    neighborhood: 'Round Rock, TX',
    room: 'Group Fitness',
    sourceHost: 'crunch.com',
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
    brand: 'Crunch',
    short: 'South Austin',
    neighborhood: 'South Austin',
    room: 'Group Fitness',
    sourceHost: 'crunch.com',
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
    brand: 'Crunch',
    short: 'North ATX',
    neighborhood: 'North Austin',
    room: 'Group Fitness',
    sourceHost: 'crunch.com',
    provider: 'crunch',
    status: 'coming-soon',
    tz: 'America/Chicago',
    providerConfig: { slug: 'northatx' },
    danceRooms: ['Group Fitness'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.crunch.com/locations/northatx',
  },
  {
    id: 'lafitness-round-rock',
    name: 'LA Fitness — Round Rock',
    brand: 'LA Fitness',
    short: 'Round Rock',
    neighborhood: 'Round Rock, TX',
    room: 'Group Fitness Studio',
    sourceHost: 'lafitness.com',
    provider: 'lafitness',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { clubId: 1075 },
    // LA Fitness exposes no room field; the lafitness provider synthesizes a
    // single "Group Fitness Studio" from the class name (cycle/aqua excluded).
    danceRooms: ['Group Fitness Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.lafitness.com/Pages/clubhome.aspx?clubid=1075',
  },
  {
    id: 'lafitness-anderson-lane',
    name: 'LA Fitness — Anderson Lane',
    brand: 'LA Fitness',
    short: 'Anderson Lane',
    neighborhood: 'North Austin',
    room: 'Group Fitness Studio',
    sourceHost: 'lafitness.com',
    provider: 'lafitness',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { clubId: 1035 },
    danceRooms: ['Group Fitness Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.lafitness.com/Pages/clubhome.aspx?clubid=1035',
  },
  {
    id: 'golds-anderson-arbor',
    name: "Gold's Gym — Anderson Arbor",
    brand: "Gold's Gym",
    short: 'Anderson Arbor',
    neighborhood: 'North Austin',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/Chicago',
    // Gold's serves a full week as escaped JSON embedded in the location page;
    // `slug` is the goldsgym.com /locations/tx/<slug>/ path segment.
    providerConfig: { slug: 'austin-anderson-arbor' },
    // The golds provider classifies on the explicit StudioName/IsCycle: the
    // group-exercise wood floor becomes "GGX Studio" (danceable), cycle and
    // pool route elsewhere; unknown classes default to GGX (conservative).
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/austin-anderson-arbor/',
  },
  {
    id: 'golds-highland',
    name: "Gold's Gym — Highland",
    brand: "Gold's Gym",
    short: 'Highland',
    neighborhood: 'North-Central Austin',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'austin-highland' },
    // Highland adds a "GOLD'S FIT" (HYROX/functional) studio alongside the
    // group-exercise wood floor and cycle room; the golds provider classifies
    // each off the explicit StudioName, so only "Group Exercise" maps to the
    // danceable GGX Studio (consistent with Anderson Arbor).
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/austin-highland/',
  },
  {
    id: 'golds-south-central',
    name: "Gold's Gym — Austin South Central",
    brand: "Gold's Gym",
    short: 'South Central',
    neighborhood: 'South Austin',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/Chicago',
    // Gold's location-page slug is the goldsgym.com /locations/tx/<slug>/
    // segment; South Central's URL has no dashes ("austinsouthcentral"),
    // unlike the older Anderson Arbor / Highland slugs.
    providerConfig: { slug: 'austinsouthcentral' },
    // StudioName values on the page are "Group Exercise South Central",
    // "Group Cycle South Central", and "GOLD'S FIT South Central" — the
    // golds provider's classifyRoom already routes these to GGX Studio /
    // Cycle Studio / Gold's Fit respectively (the wood-floor practice room
    // the user calls "Group Exercise" is GGX Studio internally).
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/austinsouthcentral/',
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

// Public, client-safe view of a gym. Includes the picker/UI fields
// (brand/short/neighborhood/room/sourceHost) so the frontend can render
// the bottom-sheet picker and hero subhead from /api/gyms alone.
function publicGym(g) {
  return {
    id: g.id,
    name: g.name,
    brand: g.brand,
    short: g.short,
    neighborhood: g.neighborhood,
    room: g.room || (g.danceRooms && g.danceRooms[0]) || 'Studio',
    sourceHost: g.sourceHost,
    status: g.status,
    tz: g.tz,
    danceRooms: g.danceRooms,
    usableWindow: g.usableWindow,
    minGapMinutes: g.minGapMinutes,
    sourceUrl: g.sourceUrl,
  };
}

module.exports = { GYMS, getGym, defaultGymId, publicGym };

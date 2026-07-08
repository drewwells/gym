// The gym registry. Adding a gym = adding an entry here (plus a provider
// module if it's a new platform). Each entry is consumed by server.js to
// pick a provider, and shipped to the frontend (minus internals) via
// /api/gyms so the client can render the bottom-sheet picker (grouped by
// brand) and the hero/source-link copy.
//
// Fields:
//   id            stable slug used in URLs and as the cache namespace
//   name          long-form label (kept for logs / fallback)
//   brand         picker grouping label, e.g. 'Crunch' / 'LA Fitness' / 'Crux'.
//                 Also the key the brand-directory home view (public/app.js)
//                 groups by; the user's pinned brand is persisted to
//                 localStorage["openFloor.myBrand"] and validated against
//                 the set of brands currently in this registry.
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
//   usableWindow  {start,end} local HH:MM "wake-hours" cap so 24/7 clubs
//                 don't report 3 AM as free. Soft user preference, not real
//                 club hours.
//   hoursByDay    actual club open/close per weekday (sun..sat keys), each
//                 {open,close} HH:MM in gym tz. The effective Open-Floor
//                 window for a date is the intersection of usableWindow and
//                 hoursByDay[weekday] (see lib/availability.js
//                 resolveDayWindow). Use {open:'00:00', close:'24:00'} on
//                 days a 24/7 club has no constraint. Omitting hoursByDay
//                 falls back to usableWindow alone.
//   minGapMinutes shortest free block worth showing in Open Floor
//   sourceUrl     public schedule page (footer source link href)

const DEFAULT_USABLE_WINDOW = { start: '06:00', end: '22:00' };
const DEFAULT_MIN_GAP = 30;

// Shared weekly templates so the per-gym entries stay short and any future
// hour correction lands in one place per brand. Cross-referenced against
// each location's official site on 2026-06-07; spot-checked vs the
// known-good Sunday closes (Gold's 21:00, LA Fitness 20:00).
const ALL_DAY = { open: '00:00', close: '24:00' };
const HOURS_24_7 = {
  sun: ALL_DAY, mon: ALL_DAY, tue: ALL_DAY, wed: ALL_DAY,
  thu: ALL_DAY, fri: ALL_DAY, sat: ALL_DAY,
};
const HOURS_LAFITNESS = {
  // Mon-Thu 5a-11p, Fri 5a-10p, Sat-Sun 8a-8p.
  sun: { open: '08:00', close: '20:00' },
  mon: { open: '05:00', close: '23:00' },
  tue: { open: '05:00', close: '23:00' },
  wed: { open: '05:00', close: '23:00' },
  thu: { open: '05:00', close: '23:00' },
  fri: { open: '05:00', close: '22:00' },
  sat: { open: '08:00', close: '20:00' },
};
const HOURS_GOLDS = {
  // Mon-Fri 5a-11p, Sat-Sun 7a-9p.
  sun: { open: '07:00', close: '21:00' },
  mon: { open: '05:00', close: '23:00' },
  tue: { open: '05:00', close: '23:00' },
  wed: { open: '05:00', close: '23:00' },
  thu: { open: '05:00', close: '23:00' },
  fri: { open: '05:00', close: '23:00' },
  sat: { open: '07:00', close: '21:00' },
};
const HOURS_GOLDS_KTX = {
  // Knoxville, TN Gold's (Eastern tz). West Knoxville/Farragut open 4a, Chapman
  // 5a — both clipped to the 06:00 usableWindow cap, so one template covers all
  // three. Key difference vs the Austin template: Sat AND Sun close 19:00 (7p),
  // not 21:00. Verified on each location page 2026-07-08.
  sun: { open: '07:00', close: '19:00' },
  mon: { open: '05:00', close: '22:00' },
  tue: { open: '05:00', close: '22:00' },
  wed: { open: '05:00', close: '22:00' },
  thu: { open: '05:00', close: '22:00' },
  fri: { open: '05:00', close: '22:00' },
  sat: { open: '07:00', close: '19:00' },
};
const HOURS_CRUX = {
  // Mon-Fri 6a-11p, Sat-Sun 10a-10p.
  sun: { open: '10:00', close: '22:00' },
  mon: { open: '06:00', close: '23:00' },
  tue: { open: '06:00', close: '23:00' },
  wed: { open: '06:00', close: '23:00' },
  thu: { open: '06:00', close: '23:00' },
  fri: { open: '06:00', close: '23:00' },
  sat: { open: '10:00', close: '22:00' },
};

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
    hoursByDay: HOURS_CRUX,
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
    hoursByDay: HOURS_24_7,
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
    hoursByDay: HOURS_24_7,
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
    hoursByDay: HOURS_24_7,
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
    hoursByDay: HOURS_LAFITNESS,
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
    hoursByDay: HOURS_LAFITNESS,
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
    hoursByDay: HOURS_GOLDS,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/austin-anderson-arbor/',
  },
  {
    id: 'golds-hesters-crossing',
    name: "Gold's Gym — Hester's Crossing",
    brand: "Gold's Gym",
    short: "Hester's Crossing",
    // Marketed by Gold's as "Austin Hester's Crossing" but the address (zip
    // 78681) is Round Rock — match the convention of the other Round Rock
    // entries (crunch-round-rock, lafitness-round-rock).
    neighborhood: 'Round Rock, TX',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/Chicago',
    // URL slug runs the city + name together with no dashes, same as
    // austinsouthcentral (and unlike the older austin-anderson-arbor /
    // austin-highland slugs). Verified live on the goldsgym.com TX index.
    providerConfig: { slug: 'austinhesterscrossing' },
    // StudioName values on the page are "Group Exercise Hester's Crossing",
    // "Group Cycle Hester's Crossing", and "GOLD'S FIT Hester's Crossing" —
    // the golds provider's classifyRoom already routes these to GGX Studio /
    // Cycle Studio / Gold's Fit, so no provider changes are needed.
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_GOLDS,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/austinhesterscrossing/',
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
    hoursByDay: HOURS_GOLDS,
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
    hoursByDay: HOURS_GOLDS,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/austinsouthcentral/',
  },

  // --- Knoxville, TN Gold's (TEMPORARY) ---------------------------------
  // Drew is in Knoxville for a couple of weeks and has a Gold's membership.
  // These three share the corporate goldsgym.com embedded-schedule template
  // (same golds provider) but live under /locations/tn/ instead of /tx/, so
  // each carries providerConfig.state = 'tn'. They use a distinct brand
  // ("GG - KTX") so the home board groups them separately from the Austin
  // Gold's, and Eastern time. Remove when the trip ends.
  {
    id: 'golds-ktx-west-knoxville',
    name: "GG - KTX — West Knoxville (Walker Springs)",
    brand: 'GG - KTX',
    short: 'Walker Springs',
    neighborhood: 'West Knoxville, TN',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/New_York',
    providerConfig: { slug: 'west-knoxville', state: 'tn' },
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_GOLDS_KTX,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tn/west-knoxville/',
  },
  {
    id: 'golds-ktx-farragut',
    name: "GG - KTX — Farragut",
    brand: 'GG - KTX',
    short: 'Farragut',
    neighborhood: 'Farragut, TN',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/New_York',
    providerConfig: { slug: 'farragut', state: 'tn' },
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_GOLDS_KTX,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tn/farragut/',
  },
  {
    id: 'golds-ktx-chapman',
    name: "GG - KTX — Chapman",
    brand: 'GG - KTX',
    short: 'Chapman',
    neighborhood: 'South Knoxville, TN',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/New_York',
    providerConfig: { slug: 'chapman', state: 'tn' },
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_GOLDS_KTX,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tn/chapman/',
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
    hoursByDay: g.hoursByDay || null,
    minGapMinutes: g.minGapMinutes,
    sourceUrl: g.sourceUrl,
  };
}

module.exports = { GYMS, getGym, defaultGymId, publicGym };

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
//   address       full street address ("street, city, ST zip") for the
//                 share / open-in-maps buttons. Taken from each brand's own
//                 site or API (verified 2026-10-20).
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
//   classesOnly   optional; true for a studio with no dance-suitable floor
//                 (danceRooms: []). Its classes feed the board's class list
//                 and name filter, but it never counts toward the Open Floor
//                 hero or "N of M open" rollups.

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
const HOURS_LIFETIME = {
  // Life Time Austin Arboretum, per the location page's JSON-LD
  // openingHoursSpecification (verified 2026-08-18): Mon-Fri 5a-10p,
  // Sat-Sun 6a-7p.
  sun: { open: '06:00', close: '19:00' },
  mon: { open: '05:00', close: '22:00' },
  tue: { open: '05:00', close: '22:00' },
  wed: { open: '05:00', close: '22:00' },
  thu: { open: '05:00', close: '22:00' },
  fri: { open: '05:00', close: '22:00' },
  sat: { open: '06:00', close: '19:00' },
};

const GYMS = [
  {
    id: 'crux-central',
    name: 'Crux Climbing — Central',
    brand: 'Crux',
    short: 'Central',
    neighborhood: 'Central Austin',
    address: '6015 Dillard Cir, Unit B, Austin, TX 78752',
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
    address: '2800 S Interstate 35, Suite 220, Round Rock, TX 78681',
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
    address: '4625 W William Cannon Dr, Austin, TX 78749',
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
    // Drew refers to this club as "Palmer". Crunch has no club by that name
    // anywhere in its 616-club directory — the official name is "Austin
    // Northwest" (Spicewood Springs Rd). Do NOT go looking for a Parmer Lane
    // club on his behalf; W Parmer Ln (club 758) is a different, real club
    // that is deliberately not registered here.
    // See .knowledge/entries/multi-gym-data-sources.md.
    id: 'crunch-austin-northwest',
    name: 'Crunch — Austin Northwest',
    brand: 'Crunch',
    short: 'Northwest',
    neighborhood: 'Northwest Austin',
    address: '8666 Spicewood Springs Rd, Austin, TX 78759',
    room: 'Group Fitness',
    sourceHost: 'crunch.com',
    provider: 'crunch',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'atxnorthwest', clubId: 769 },
    danceRooms: ['Group Fitness'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_24_7,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.crunch.com/locations/atxnorthwest',
  },
  {
    id: 'crunch-north-atx',
    name: 'Crunch — North ATX',
    brand: 'Crunch',
    short: 'North ATX',
    neighborhood: 'North Austin',
    address: '8716 Research Blvd, Suite 100, Austin, TX 78758',
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
    address: '16600 N RM 620 Rd, Round Rock, TX 78681',
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
    address: '2020 W Anderson Ln, Austin, TX 78757',
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
    address: '13435 US 183, Suite 102, Austin, TX 78750',
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
    address: '2400 S IH-35, Round Rock, TX 78681',
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
    address: '6001 Middle Fiskville Rd, Austin, TX 78752',
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
    address: '1701 W Ben White Blvd, Suite 165, Austin, TX 78704',
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

  // --- North-Austin corridor Gold's (added 2026-07-27) ------------------
  // Onboarded while surveying north-Austin daytime dance classes. All three
  // publish M-F 05:00-23:00 / Sat-Sun 07:00-21:00 in their page JSON-LD,
  // i.e. exactly HOURS_GOLDS, so they reuse the shared template.
  // NOTE: Gold's Austin-Burnet (7301 Burnet Rd) is deliberately NOT here —
  // its page embeds zero event_data because the club has no group-exercise
  // studio at all (amenities list weights/cardio/turf only). Nothing to
  // schedule, so registering it would just add a permanently empty floor.
  {
    id: 'golds-north-round-rock',
    name: "Gold's Gym — North Round Rock",
    brand: "Gold's Gym",
    short: 'North Round Rock',
    neighborhood: 'Round Rock, TX',
    address: '4201 Sunrise Rd, Round Rock, TX 78665',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'austin-north-round-rock' },
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_GOLDS,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/austin-north-round-rock/',
  },
  {
    id: 'golds-pflugerville',
    name: "Gold's Gym — Pflugerville",
    brand: "Gold's Gym",
    short: 'Pflugerville',
    neighborhood: 'Pflugerville, TX',
    address: '21315 N SH 130 NB, Pflugerville, TX 78660',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'pflugerville' },
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_GOLDS,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/pflugerville/',
  },
  {
    // Slug is 'cypress-creek' (Cypress Creek Rd) but the club is in CEDAR
    // PARK, not Houston's Cypress Creek — 1314 Cypress Creek Rd, Cedar Park.
    // Don't "fix" this slug to something Cedar-Park-shaped; it's correct.
    id: 'golds-cedar-park',
    name: "Gold's Gym — Cedar Park",
    brand: "Gold's Gym",
    short: 'Cedar Park',
    neighborhood: 'Cedar Park, TX',
    address: '1314 Cypress Creek Rd, Cedar Park, TX 78613',
    room: 'GGX Studio',
    sourceHost: 'goldsgym.com',
    provider: 'golds',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'cypress-creek' },
    danceRooms: ['GGX Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_GOLDS,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.goldsgym.com/locations/tx/cypress-creek/',
  },

  // --- North-Austin corridor Crunch (added 2026-07-27) ------------------
  // All three "Open 24/7" per /crunch_core/clubs/<slug>, so HOURS_24_7.
  {
    // The W PARMER Lane club (opened 2026-07-21). Distinct from Austin
    // Northwest, which is the one Drew calls "Palmer" — see that entry above.
    id: 'crunch-west-parmer',
    name: 'Crunch — West Parmer Lane',
    brand: 'Crunch',
    short: 'West Parmer',
    neighborhood: 'North Austin (Parmer/Wells Branch)',
    address: '1700 W Parmer Ln, Suite 100, Austin, TX 78727',
    room: 'Group Fitness',
    sourceHost: 'crunch.com',
    provider: 'crunch',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'atxwparmerln', clubId: 758 },
    danceRooms: ['Group Fitness'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_24_7,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.crunch.com/locations/atxwparmerln',
  },
  {
    id: 'crunch-cedar-park',
    name: 'Crunch — Cedar Park',
    brand: 'Crunch',
    short: 'Cedar Park',
    neighborhood: 'Cedar Park, TX',
    address: '1335 E Whitestone Blvd, Suite AB, Cedar Park, TX 78613',
    room: 'Group Fitness',
    sourceHost: 'crunch.com',
    provider: 'crunch',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'cedar-park', clubId: 569 },
    danceRooms: ['Group Fitness'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_24_7,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.crunch.com/locations/cedar-park',
  },
  {
    id: 'crunch-north-round-rock',
    name: 'Crunch — North Round Rock',
    brand: 'Crunch',
    short: 'North Round Rock',
    neighborhood: 'Round Rock, TX',
    address: '201 University Oak Blvd, Round Rock, TX 78665',
    room: 'Group Fitness',
    sourceHost: 'crunch.com',
    provider: 'crunch',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { slug: 'north-round-rock', clubId: 597 },
    danceRooms: ['Group Fitness'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_24_7,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.crunch.com/locations/north-round-rock',
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
    address: '8445 Kingston Pike, Knoxville, TN 37919',
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
    address: '10708 Kingston Pike, Knoxville, TN 37934',
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
    address: '6510 Chapman Hwy, Knoxville, TN 37920',
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

  // --- Life Time (new platform, added 2026-08-18) -----------------------
  // Life Time is a new brand: a clean JSON schedule API (see providers/lifetime.js
  // for the endpoint, key/club-id provenance, and quirks). Unlike Gold's/Crunch
  // it exposes NO room field, so the provider infers the room from the class
  // `tags` (first tag = interest category). The shared group-fitness wood floor
  // is the danceable "Group Fitness Studio"; Cycle/Pilates/Barre/Yoga/ARORA +
  // Aqua route to their own non-dance rooms, outdoor classes to "Outdoors", and
  // an unrecognized class defaults to the studio (conservative — it blocks the
  // floor rather than falsely freeing it).
  {
    id: 'lifetime-austin-arboretum',
    name: 'Life Time — Austin Arboretum',
    brand: 'Life Time',
    short: 'Arboretum',
    neighborhood: 'Northwest Austin',
    address: '4210 W Braker Ln, Austin, TX 78759',
    room: 'Group Fitness Studio',
    sourceHost: 'lifetime.life',
    provider: 'lifetime',
    status: 'live',
    tz: 'America/Chicago',
    // `clubId` is the location page's window.lt.club.mmsClubId (287 for
    // Arboretum). The provider holds the public APIM key.
    providerConfig: { clubId: 287 },
    // Only the shared group-fitness wood floor is dance-suitable; the provider
    // routes every other room (Cycle/Pilates/Barre/Yoga/ARORA + Aqua/Outdoors)
    // away from it.
    danceRooms: ['Group Fitness Studio'],
    usableWindow: DEFAULT_USABLE_WINDOW,
    hoursByDay: HOURS_LIFETIME,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.lifetime.life/locations/tx/austin-arboretum.html',
  },
  // --- Black Swan Yoga (new platform, added 2026-10-20) -----------------
  // Donation-based hot-yoga studios on Mindbody (see providers/blackswan.js
  // for the widget endpoint). No dance floor and no published hours, so
  // every studio is `classesOnly`: listed for its classes and the name
  // filter, kept out of the Open Floor hero. `widgetId` is the
  // data-widget-id on blackswanyoga.com/studios/<slug> (verified
  // 2026-10-20); these are the six Austin-area studios.
  {
    id: 'blackswan-anderson',
    name: 'Black Swan Yoga — Anderson',
    brand: 'Black Swan Yoga',
    short: 'Anderson',
    neighborhood: 'North Austin',
    address: '1417 W Anderson Ln, Austin, TX 78757',
    room: 'Studio',
    sourceHost: 'blackswanyoga.com',
    provider: 'blackswan',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { widgetId: '1a68132bd21' },
    classesOnly: true,
    danceRooms: [],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.blackswanyoga.com/studios/anderson',
  },
  {
    id: 'blackswan-cedar-park',
    name: 'Black Swan Yoga — Cedar Park',
    brand: 'Black Swan Yoga',
    short: 'Cedar Park',
    neighborhood: 'Cedar Park, TX',
    address: '1050 Lakeline Blvd, Suite 105, Cedar Park, TX 78613',
    room: 'Studio',
    sourceHost: 'blackswanyoga.com',
    provider: 'blackswan',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { widgetId: '1a31874bd21' },
    classesOnly: true,
    danceRooms: [],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.blackswanyoga.com/studios/cedar-park',
  },
  {
    id: 'blackswan-cesar-chavez',
    name: 'Black Swan Yoga — Cesar Chavez',
    brand: 'Black Swan Yoga',
    short: 'Cesar Chavez',
    neighborhood: 'East Austin',
    address: '913 E Cesar Chavez St, Austin, TX 78702',
    room: 'Studio',
    sourceHost: 'blackswanyoga.com',
    provider: 'blackswan',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { widgetId: '1a68134bd21' },
    classesOnly: true,
    danceRooms: [],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.blackswanyoga.com/studios/cesar-chavez',
  },
  {
    id: 'blackswan-orchard',
    name: 'Black Swan Yoga — Orchard',
    brand: 'Black Swan Yoga',
    short: 'Orchard',
    neighborhood: 'Clarksville (W 5th St)',
    address: '1213 W 5th St, Austin, TX 78703',
    room: 'Studio',
    sourceHost: 'blackswanyoga.com',
    provider: 'blackswan',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { widgetId: '1a68144bd21' },
    classesOnly: true,
    danceRooms: [],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.blackswanyoga.com/studios/orchard',
  },
  {
    id: 'blackswan-round-rock',
    name: 'Black Swan Yoga — Round Rock',
    brand: 'Black Swan Yoga',
    short: 'Round Rock',
    neighborhood: 'Round Rock, TX',
    address: '2800 S I-35 Frontage Rd, #310, Round Rock, TX 78681',
    room: 'Studio',
    sourceHost: 'blackswanyoga.com',
    provider: 'blackswan',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { widgetId: '1a68145bd21' },
    classesOnly: true,
    danceRooms: [],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.blackswanyoga.com/studios/round-rock',
  },
  {
    id: 'blackswan-westgate',
    name: 'Black Swan Yoga — Westgate',
    brand: 'Black Swan Yoga',
    short: 'Westgate',
    neighborhood: 'South Austin',
    address: '4534 West Gate Blvd, Austin, TX 78745',
    room: 'Studio',
    sourceHost: 'blackswanyoga.com',
    provider: 'blackswan',
    status: 'live',
    tz: 'America/Chicago',
    providerConfig: { widgetId: '1a68146bd21' },
    classesOnly: true,
    danceRooms: [],
    usableWindow: DEFAULT_USABLE_WINDOW,
    minGapMinutes: DEFAULT_MIN_GAP,
    sourceUrl: 'https://www.blackswanyoga.com/studios/westgate',
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
    address: g.address || null,
    room: g.room || (g.danceRooms && g.danceRooms[0]) || 'Studio',
    sourceHost: g.sourceHost,
    status: g.status,
    tz: g.tz,
    danceRooms: g.danceRooms,
    usableWindow: g.usableWindow,
    hoursByDay: g.hoursByDay || null,
    minGapMinutes: g.minGapMinutes,
    sourceUrl: g.sourceUrl,
    classesOnly: Boolean(g.classesOnly),
    // Crunch classes must be booked ahead in its app; the class search shows
    // a "Register" badge on them.
    requiresRegistration: g.provider === 'crunch',
  };
}

module.exports = { GYMS, getGym, defaultGymId, publicGym };

# Gym Class Calendar

A small read-only viewer for several gyms' public class calendars, served
at `gym.jayloves.us`. Beyond listing classes, it has an **Open Floor**
view that inverts the schedule to show when a dance-suitable studio room
is *free* — handy for finding practice time.

No login. No accounts. No state on disk.

## Gyms

| Gym | Provider | Notes |
|-----|----------|-------|
| Crux Climbing — Central (Austin) | tilefive widget (JSON) | no room field; studio classes inferred by name |
| Crunch — Round Rock | `crunch_core` JSON API | `club_id 236`, 24/7 |
| Crunch — South Austin | `crunch_core` JSON API | `club_id 550`, 24/7 |
| Crunch — North ATX | — | coming soon (shown disabled) |

Adding a gym is usually just a new entry in [`gyms.js`](gyms.js); a new
*platform* also needs a module under [`providers/`](providers/).

## Features

- **All-Floors board (home)** — `/` shows one row per gym for the
  selected date, sorted *open-now → opening-later → done*. An
  answer-first hero summarizes "is anyone open right now?" across every
  live gym (best-bet pick when at least one is open, next-up time when
  none is, "wrap on today" otherwise). Coming-soon gyms appear dimmed
  at the bottom.
- **Per-gym detail drill-in** — tap a row to open `/?gym=<id>&date=<d>`
  with the existing swipeable per-day view; a back button returns to
  the board, preserving the date. URLs are shareable and back/forward
  navigation works.
- **Open Floor view** — for each dance-suitable studio room, the free
  time blocks between classes within a usable window (default
  06:00–22:00 local), at least `minGapMinutes` long (default 30).
- **Bottom-sheet gym picker** — available from the detail view's gym
  identity; coming-soon locations shown disabled.
- Shared 7-day date strip drives both views; rolls over to tomorrow
  after 9 PM local.
- **Daily polling** — at startup and once every 24h the server warms
  the per-gym weekly cache for every live gym, so the board and
  availability endpoints always serve cached data. Per-gym failures are
  logged but don't abort the rest of the batch. `&refresh=1` still
  forces a foreground re-fetch.
- 7-day in-memory cache with stale-while-revalidate (24h freshness)
  keyed by gym; concurrent callers share the inflight upstream call.
- Responsive: phone-first column that centers as a phone-width frame on
  desktop.

## Local development

```bash
npm install
make dev      # runs `node server.js` on PORT=8001
npm test      # runs the availability unit tests (node:test, no deps)
```

Then open <http://localhost:8001/>.

API:

- `GET /api/gyms` — the gym registry (client-safe fields).
- `GET /api/events?gym=<id>&date=YYYY-MM-DD` — normalized events for the
  7-day window starting at midnight (gym timezone) of `date` (defaults to
  today / first live gym). Append `&refresh=1` to bypass the cache.
- `GET /api/availability?gym=<id>&date=YYYY-MM-DD` — Open Floor gaps per
  dance-suitable room for that day (single gym, single day).
- `GET /api/board?date=YYYY-MM-DD` — aggregate view that powers the home
  board: every gym in the registry with its open-floor summary for that
  date (in each gym's own tz). Each entry carries identity fields
  (`id`, `name`, `short`, `brand`, `neighborhood`, `status`,
  `sourceUrl`) plus a `day` object with the day's `gaps`
  (`startDT`/`endDT`/`minutes`), `events` (`name`/`startDT`/`endDT`),
  `totalOpenMin`, and `windowCount`. Coming-soon gyms appear with
  `day: null` so the UI can render them dim. `date` defaults to today
  in the first live gym's tz; `&refresh=1` forces a re-fetch.
- `GET /api/health` — health probe.

## Architecture

```
server.js              Express wiring, endpoints, gym+week cache, daily poller
gyms.js                the gym registry (one entry per location)
lib/time.js            timezone helpers (per-gym tz)
lib/availability.js    Open Floor gap math (pure; unit-tested)
lib/board.js           home-board aggregation + sort ranking (pure; unit-tested)
providers/crux.js      Crux tilefive widget + X-Api-Key scrape + room classifier
providers/crunch.js    Crunch crunch_core/occurrences JSON
providers/lafitness.js LA Fitness print-grid scrape (no JSON API; weekly template)
providers/golds.js     Gold's Gym embedded event_data JSON on the location page
public/                static frontend (home board + per-gym detail drill-in)
test/                  availability + board + provider unit tests
```

Each provider exposes `fetchWeek(gym, startUTC, endUTC)` and returns a
common normalized event model (`{ gymId, name, startDT, endDT,
occurrenceDate, room, danceSuitable, instructors, ... }`). The server is
provider-agnostic; the frontend renders either the class list or the
computed open-floor gaps.

### Crux `X-Api-Key`

The tilefive widget call requires an `X-Api-Key` — a public per-region
constant baked into the Approach portal's SPA bundle, **scraped at
startup** rather than committed: fetch `/schedule/embed` on
`crux.portal.approach.app`, parse the content-hashed `/assets/app-*.js`
URL from the shell, download it, and extract `widgetsApiKey["us-east-1"]`.
Cached in memory; on a 403 the provider re-scrapes and retries once (the
bundle/key rotate on every Crux deploy).

### Crunch data

Crunch's site is backed by JSON (no PDF parsing): club info by slug at
`/crunch_core/clubs/<slug>` and the schedule at
`/crunch_core/occurrences?club_id=&range_start=&range_end=&local=true`.
Each occurrence carries an explicit `room` (`Group Fitness`, `Ride`,
`HIITZone`, …); only the wood-floor `Group Fitness` studio is treated as
dance-suitable.

## Deploy (rootless Podman + user systemd)

Runs as **rootless Podman** managed by a **user systemd unit**. Container
storage is pinned to `/mnt/pcixdisk/podman/drew/` (the boot disk stays
clean). See `PODMAN_HANDOFF.md` for the full host setup and rationale.

```bash
make install-service   # one-time: installs ~/.config/systemd/user/gym.service
make deploy            # rebuild image and restart the user unit
make logs              # tail container logs
make status            # systemd status
```

The compose file maps host `:8001` → container `:3000`. DNS/TLS for
`gym.jayloves.us` is handled separately (reverse proxy / tunnel).

## License

MIT.

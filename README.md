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

- **Gym picker** — switch between gyms; coming-soon locations are shown
  disabled.
- **Classes view** — the day's classes for the selected gym, with room,
  instructor, and remaining-spots info, linking back to the source.
- **Open Floor view** — for each dance-suitable studio room, the free
  time blocks between classes within a usable window (default
  06:00–22:00 local), at least `minGapMinutes` long (default 30).
- Prev / Today / Next navigation; the initial view rolls over to tomorrow
  after 9 PM local.
- 7-day in-memory cache (10 min TTL) keyed by gym, so date-nav is instant.
- Responsive (desktop + mobile).

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
  dance-suitable room for that day.
- `GET /api/health` — health probe.

## Architecture

```
server.js              Express wiring, endpoints, gym+week cache
gyms.js                the gym registry (one entry per location)
lib/time.js            timezone helpers (per-gym tz)
lib/availability.js    Open Floor gap math (pure; unit-tested)
providers/crux.js      Crux tilefive widget + X-Api-Key scrape + room classifier
providers/crunch.js    Crunch crunch_core/occurrences JSON
public/                static frontend (picker + Classes/Open Floor toggle)
test/                  availability unit tests
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

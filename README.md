# Crux Climbing Calendar

A small read-only viewer for the public Crux Climbing Center (Central
Austin) class calendar, served at `gym.jayloves.us`.

It proxies the public widget endpoint that
[cruxclimbingcenter.com](https://www.cruxclimbingcenter.com/central-austin/calendar/)
uses to render its own calendar, and shows one day at a time with
prev/today/next navigation. Each event links back to Crux's calendar page
for details and booking.

No login. No accounts. No state on disk.

## Features

- Day list of Crux Central classes &amp; events for the selected date
- Prev / Today / Next navigation, with current date defaulting to today
  (America/Chicago)
- 7-day in-memory cache (10 min TTL) so date-nav is instant
- Direct links to the Crux calendar page from the header and from each
  event row
- Responsive (desktop + mobile)

## Local development

```bash
npm install
make dev      # runs `node server.js` on PORT=8001
```

Then open <http://localhost:8001/>.

API:

- `GET /api/events?date=YYYY-MM-DD` — events for the 7-day window starting
  at midnight America/Chicago of `date` (defaults to today). Append
  `&refresh=1` to bypass the cache.
- `GET /api/health` — health probe.

## Deploy (rootless Podman + user systemd)

This project runs as **rootless Podman** managed by a **user systemd
unit**. Container storage is pinned to `/mnt/pcixdisk/podman/drew/` (the
boot disk stays clean). See `PODMAN_HANDOFF.md` for the full host setup
and rationale.

Install / update:

```bash
make install-service   # one-time: installs ~/.config/systemd/user/gym.service
make deploy            # rebuild image and restart the user unit
make logs              # tail container logs
make status            # systemd status
```

The compose file maps host `:8001` → container `:3000`. DNS/TLS for
`gym.jayloves.us` is handled separately (reverse proxy / tunnel).

## How it works

Single Express server. One route: `GET /api/events`. Server fetches the
public Crux widget endpoint:

```
https://widgets.api.prod.tilefive.com/cal
  ?startDT=...&endDT=...&locationId=2&page=1&pageSize=200
```

The widget endpoint requires an `X-Api-Key` header. That key is a public
per-region constant baked into the Approach portal's SPA bundle, so the
server **scrapes it at startup** instead of carrying it in the repo: it
fetches `/schedule/embed` on `crux.portal.approach.app`, parses the
content-hashed `/assets/app-*.js` URL out of the shell HTML, downloads
that bundle, and extracts `widgetsApiKey["us-east-1"]`. The value is
cached in memory; if Crux ever rotates the bundle and the upstream
returns a 403, the wrapper re-scrapes and retries once. Other headers
(`Authorization: crux`, Referer/Origin, etc.) are constants replayed
from the browser widget. The response merges `bookings` and `calEvents`,
normalizes each entry, and returns the week sorted by `startDT`.
Frontend filters to the selected day in the user's view.

## License

MIT.

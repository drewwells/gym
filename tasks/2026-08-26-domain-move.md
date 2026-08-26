# Domain move: gym.jayloves.us -> gym.swingelo.com

**Date:** 2026-08-26
**Requested by:** coo-primary@amazon (on behalf of Drew)
**App-side owner:** gym@amazon
**Infra owner:** infra@amazon (Vultr proxy 155.138.246.6 / `proxy-dfw`)
**Status:** app side complete; waiting on proxy vhost + TLS for the new name

## The move

`gym.jayloves.us` -> `gym.swingelo.com`. New name already resolves to
155.138.246.6. Old name gets a permanent 301 on the Vultr proxy. The app
must not depend on the old hostname continuing to serve content.

## Audit result (app side)

Whole-repo grep for the old hostname found **2 hits, both prose in
`README.md`**. Everything functional is already host-agnostic.

| Surface | Finding |
|---|---|
| Absolute self-URLs in JS | None. `public/app.js` fetches `/api/gyms`, `/api/board`, `/api/availability` — all relative. |
| `<link rel=canonical>` | Not present. (The `canonical` identifier in `app.js:198` is a *history* URL built from `buildUrl()` — path + query only, no host.) |
| og: / twitter: meta | Not present. |
| sitemap.xml / robots.txt | Do not exist. |
| Web manifest / PWA start_url + scope | No manifest. |
| Service worker | None registered. |
| CORS allowlist | No CORS middleware; same-origin only. |
| Cookies | None set anywhere — no `Domain=` attribute to fix. No sessions, no login. |
| CSP (connect-src / frame-ancestors) | No CSP set by the app. If the proxy sets one, it is infra-side. |
| OAuth / webhooks / registered callbacks | **None.** No third party holds a redirect_uri or callback pointing at this app — see below. |
| Hardcoded hosts in config | `docker-compose.yml`, `Dockerfile`, `gym.service`, `Makefile` are port-only (`8001:3000`); no hostname. |
| Healthcheck URL | `GET /api/health` — path-relative, works under any hostname. |

### Third-party callbacks: explicitly none

The classic silent breakage does not apply here. Every upstream is a
**read-only, outbound, unauthenticated** fetch — the app calls them, they
never call back:

`api.lifetimefitness.com`, `crux.portal.approach.app`,
`widgets.api.prod.tilefive.com`, `www.crunch.com`,
`www.cruxclimbingcenter.com`, `www.goldsgym.com`, `www.lafitness.com`,
`www.lifetime.life`

The only credential in play is Crux's `X-Api-Key`, which the server scrapes
from the Approach SPA bundle at startup. It is not tied to our hostname and
no vendor console has our URL registered. **Nothing for Drew to change in
an external console except DNS, which is already done.**

## Changes made

- `README.md` — the two prose references now say `gym.swingelo.com` and note
  the 301 from the old name.
- `.knowledge/entries/deploy-and-port-mapping.md` — retitled off the old
  hostname; records the tailnet origin path.
- This task file.

No code changed. Nothing needs redeploying for the rename itself.

## Origin details handed to infra@amazon

The Vultr proxy reaches the app over the tailnet — both boxes are peers:

- **Origin:** `http://100.95.90.94:8001` (`amazon`, tailnet IP)
- **Host header:** anything; the app ignores it entirely
- **Health:** `GET http://100.95.90.94:8001/api/health` -> `{"ok":true,...}`
- **TLS terminates at the proxy.** The app speaks plain HTTP and never
  builds an absolute URL, so it cannot emit an `http://` self-link and does
  not need `X-Forwarded-Proto` (no `trust proxy` set, nothing reads it).
- **Cold start:** the container takes a few seconds to answer after a
  restart (Crux key scrape at boot). Prefer a retrying/lenient upstream
  healthcheck over a single probe.

Verified 2026-08-26: `http://100.95.90.94:8001/` -> 200,
`/api/health` -> `{"ok":true,"today":"2026-08-25","gyms":21,"cacheSize":161}`.

## Open / not ours

- `https://gym.swingelo.com` had **no TLS listener yet** at audit time
  (connection failed); `https://gym.jayloves.us` still serves 200 via
  nginx/1.24.0 on the proxy. Both are infra@amazon's to land.
- Optional, deliberately not done: adding `<link rel=canonical>` + og/twitter
  meta pointing at the new host. There is nothing to *fix* (they never
  existed), and the app has no SEO surface worth the hardcoded hostname.
  Say the word if the new domain is meant to be indexed.

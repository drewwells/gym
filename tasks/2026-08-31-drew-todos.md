# Drew's todos — 2026-08-31

**Source:** Drew, relayed via coo-primary@amazon 2026-08-31.
**Status:** RECORDED ONLY — not started. Drew: "Don't have them work them yet."

---

## 1. Drew's words (verbatim — do not paraphrase or edit)

1. "Web app has no way to refresh. Pulling down doesn't work. Refresh on non recent focus would fix this"
2. "As a result of no refresh, can't update time it's calculating availability from once in a web app"
3. "Cache is never warm, we should refresh cache every 24 hrs with a cron so user never waits"
4. "Pin needs to move gym to the top"
5. "We need a map view with availability as the pin instead of the gym name"

---

## 2. COO's reading (coo-primary@amazon's interpretation — NOT Drew's words)

Recorded as supplied, explicitly labelled as interpretation:

- Reads item 1 as: refresh when the page/app regains focus after having been
  away, rather than on every focus event. "Non recent focus" most likely means
  "focus returning after the data has gone stale", i.e. gated on elapsed time.
  **COO is not confident of this and flagged it as worth confirming with Drew
  before anyone builds it.** Pull-to-refresh "apparently being wired up but not
  working" treated as a separate, possibly independent bug. (See §3 — that
  premise turns out to be wrong.)
- Items 1 and 2 look causally linked — Drew says #2 is "a result of" #1 — so #2
  may fall out of #1 for free, or may be its own control. Noted, not assumed.
- Item 4: COO does not know whether "pin" is an existing feature. (Answered in §3.)
- Items 3, 4 and 5 read as independent of each other and of 1/2.

---

## 3. Codebase recon (gym@amazon, 2026-08-31)

Read-only survey done solely to sharpen the ambiguities. No code changed.

**Item 1 — pull-to-refresh was never wired up.** Correcting the premise in §2:
there is no pull-to-refresh implementation at all. No `touchstart`/`touchmove`/
`overscroll-behavior` handling anywhere in `public/app.js` or `styles.css`; the
`refresh*` symbols are `refreshDetailSlide()` (a re-render of an already-loaded
slide, unrelated to fetching). So this is not a wired feature that broke — it is
absent. What Drew is pulling on is the browser's native gesture, which does
nothing useful in this app. Also confirms the proposed fix is net-new: there is
no `visibilitychange` and no `'focus'` listener registered (`app.js:148` registers
only `popstate`; `startTick()` at :1378 is a `setInterval` re-render, not a refetch).

**Item 3 — a 24h warm-up poller already exists.** `server.js` has
`POLL_INTERVAL_MS = 24h`, `POLL_STAGGER_MS = 750`, `pollAllGyms()` and
`startDailyPoll()`, firing at startup and every 24h, walking every `status:'live'`
gym with `poll !== false`. So "we should refresh cache every 24 hrs with a cron"
describes something that is already implemented in-process. That makes Drew's
premise — "cache is never warm" — the interesting part: it is a real symptom with
a cause that a cron would not fix. Prime suspect is that the cache is in-memory
only by design (no disk persistence), so every container restart wipes it and
`make deploy` guarantees a cold cache; the first user after any deploy waits
regardless of polling. Needs confirming against prod before anyone writes a cron.

**Item 4 — "pin" exists, but it pins BRANDS, not gyms.** The star control
(`app.js:581`) toggles a *brand* into `myBrands`, persisted in localStorage, and
pinned brands already sort first in `brandOrder` (`app.js:99-108`, :131-132).
Drew's "move gym to the top" is at a different granularity than what is built.

**Item 5 — no map view exists.** Fully net-new. Note the app currently ships no
mapping dependency and no per-gym coordinates that I saw; that is a data question
as much as a UI one.

---

## 4. Ambiguities to put to Drew (batched by COO — do not chase individually)

- **#1:** Confirm COO's reading of "refresh on non recent focus" — refetch when
  focus returns *and* data is older than some threshold? If so, what threshold?
  Separately: given pull-to-refresh was never implemented, is "pulling down
  doesn't work" a request to *build* it, or is focus-refresh an acceptable
  substitute for it?
- **#2:** Is the "time it's calculating availability from" meant to follow the
  clock automatically on refresh, or does he want an explicit control to set it
  (e.g. "show me availability as of 7pm")? These are different features.
- **#3:** Given a 24h poller already exists, what does he actually observe —
  a wait on first load after a deploy, or a wait at unpredictable times? That
  distinguishes "cache dies on restart" from "the poller isn't working".
- **#4:** Does he want per-*gym* pinning (new granularity), or is he reporting
  that existing brand-pinning isn't sorting to the top as expected (a bug)?
- **#5:** Availability-as-pin — what does the pin render, a single
  open/closed state or a count/time? And is this a new view alongside the board,
  or a replacement for it?

# Drew's todos — 2026-08-31

**Source:** Drew, relayed via coo-primary@amazon 2026-08-31.
**Status:** RECORDED ONLY — not started. Drew: "Don't have them work them yet."
**Updated 2026-08-31:** Drew answered the batched questions (§5). Hold NOT lifted.

---

## 1. Drew's words (verbatim — do not paraphrase or edit)

1. "Web app has no way to refresh. Pulling down doesn't work. Refresh on non recent focus would fix this"
2. "As a result of no refresh, can't update time it's calculating availability from once in a web app"
3. "Cache is never warm, we should refresh cache every 24 hrs with a cron so user never waits"
4. "Pin needs to move gym to the top"
5. "We need a map view with availability as the pin instead of the gym name"

### Drew's follow-up answers (verbatim, 2026-08-31, via COO)

On what "non recent focus" means:
> "Non recent focus is opening web app of gym at 8:19. Then opening it again at 10:00. There's no refresh happening and so it still says 8:19"

Answering the batched questions:
> "1. Brand pinning is fine"
> "2. Cache is like 7 days, so need to update more often that to keep data fresh. Right now, I have to wait for all gym to be scraped each day I load the site"

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

---

## 5. Resolved by Drew's answers (2026-08-31)

**#1 + #2 are ONE item — confirmed by Drew, not inferred.** The frozen "8:19"
IS the availability-from time: open at 8:19, reopen at 10:00, it still reads
8:19. A focus/visibility refresh that also re-anchors the calculation time
satisfies both. **No separate explicit time control is being asked for** —
the §4 question about "show me availability as of 7pm" is withdrawn.

**#4 — brand-level granularity is correct. Do NOT build per-gym pinning.**
Drew: "Brand pinning is fine."

**#4 follow-up, read-only check requested by COO — pinned sorting does NOT
hold in every view.** This reconciles the apparent contradiction between
"brand pinning is fine" and Drew having listed "Pin needs to move gym to the
top" as a defect:
- The board accordion **does** respect it — `renderBoard()` iterates
  `brandOrder` (`app.js:391`), which is `orderBrandsPinnedFirst(...)` (:137, :777).
- The bottom-sheet **gym picker does not** — `buildSheetList()` (`app.js:1203`)
  iterates raw `gymOrder` (registry order from `/api/gyms`) and never consults
  `myBrands` or `brandOrder`. So the picker he opens to *switch gyms* leaves
  his pinned brand wherever the registry happens to put it.
- Best reading: both statements are true and consistent. Pinning works where
  he pins; it's the picker that ignores it. **COO to decide whether this still
  needs a question to Drew — not asking him directly.**

**#3 — MECHANISM RESOLVED. Verified in source by COO and independently
re-verified here. This is a finding, not a hypothesis.** Both earlier guesses
(restart-wipes; weekly `weekStartDate` rollover) were wrong:
- `anchor = gymToday` for any date inside the 7-day strip (`server.js:92`) and
  `cacheKey = ${gym.id}:${anchor}` (`:93`) ⇒ **the key rolls at each gym's
  LOCAL MIDNIGHT, every calendar day** — daily, not weekly, and not on restart.
- `pollAllGyms()` warms only `todayInTz(gym.tz)` (`:208-209`); `startDailyPoll()`
  fires once at process start then `setInterval(24h)` (`:223-229`) ⇒ **the
  poll's phase is pinned to process start time.**
- The two clocks are never aligned. From local midnight until the poll's daily
  fire time, today's key does not exist: every load in that window is cold and
  blocks on a full scrape. **Window width = (poll fire time − local midnight),
  set by whenever the process last restarted.** That is exactly Drew's "I have
  to wait for all gym to be scraped each day I load the site."
- Stale-while-revalidate (`:100-105`) is healthy and is NOT implicated — it only
  helps a key that already exists. Only a cold key blocks, and rollover
  guarantees one daily.
- **The bug is PHASE, not frequency.** Drew's "cron every 24 hrs" instinct was
  closer to right than the earlier "the mechanism already exists, building it
  would be waste" framing allowed — a 24h job phased just after local midnight
  would genuinely have helped. COO has corrected that framing; so has the
  knowledge entry.

**Two constraints for whoever implements #3 (noted, not designed):**
- **Gyms span timezones** (Austin CT, Knoxville ET), so "local midnight" is not
  one instant. A single fixed cron time cannot sit just-after-midnight for every
  gym; the warm has to be per-gym-tz or run often enough to cover the spread.
- `pollAllGyms()` uses `getWeek(..., {refresh: true})`, which **deletes the key
  before refetching** (`:95-97`). A user landing mid-poll for that gym therefore
  misses too — the `inflight` map dedupes them onto the same promise, so they
  don't fan out upstream, but they still block. Worth preserving the old value
  rather than deleting it, if the fix touches this path.

**Desired outcome when authorised (COO):** a user loading at any hour does not
block on a scrape. Method is open — align the warm to local midnight, pre-warm
tomorrow's key before rollover, or serve the previous key stale while the new
one fills. No method chosen.

**#5 — still blocked on the lat/lng question.** Unchanged from §4: no per-gym
coordinates in the registry, so a map view likely needs a coordinate backfill
across the live gyms before any UI work. Also still unanswered: what the pin
renders (single open/closed state vs a count/time), and whether the map is a
new view alongside the board or replaces it.

**Still open from §4:** #1's exact staleness threshold (Drew's example implies
~1h40m is too long, but names no number).

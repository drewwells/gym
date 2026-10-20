// Black Swan Yoga provider (Mindbody Branded Web "Schedules" widget).
//
// Each blackswanyoga.com/studios/<slug> page embeds a Mindbody widget
// (`data-widget-id`, e.g. "1a68132bd21" for Anderson). The widget loader
// (brandedweb.mindbodyonline.com/embed/widget.js) iframes:
//   GET https://go.mindbodyonline.com/book/widgets/schedules/view/<widgetId>/schedule
// That page is a Next.js app whose server-rendered React flight payload
// (`self.__next_f.push([1,"..."])` script chunks) already carries the next
// ~7 days of classes for that one studio under `"initialClasses":
// {classes, fromDate, toDate}` (verified 2026-10-20, all 6 Austin-area
// widgets). No key, no login. The older healcode `load_markup` endpoint
// returns "Widget not found" for these ids, so don't use it.
//
// Class shape (verified):
//   { id: "cinst_…", name: "Flow", startDateTime: "2026-10-20T14:00:00.0000000Z",
//     endDateTime: "…Z", duration: 60, capacity: 70, numberRegistered: 22,
//     cancelled: false, roomName: null | "Studio  2",
//     staff: [{ displayLabel: "Chauntelle", … }], location: {…} | "$33" }
// Repeated objects come back as flight references ("$33"); strings that
// really start with "$" are escaped as "$$".
//
// Black Swan studios have no dance floor and publish no hours, so every
// class is danceSuitable=false — the gyms are registered `classesOnly` and
// only feed the class list / name filter, never the Open Floor hero.

const _ax = require('axios');
const axios = _ax.default || _ax;
const { dateInTz } = require('../lib/time');

const WIDGET_URL = 'https://go.mindbodyonline.com/book/widgets/schedules/view';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';

const PUSH_RE = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;

// Join the flight payload's string chunks back into one stream.
function flightText(html) {
  let out = '';
  for (const m of html.matchAll(PUSH_RE)) out += JSON.parse(m[1]);
  return out;
}

// Read the JSON value that starts at `start` (an object or array) by
// bracket-matching, skipping over string contents.
function readJsonAt(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON in flight payload');
}

// Pull the `initialClasses.classes` array out of the widget page HTML.
function extractClasses(html) {
  const text = flightText(html);
  const key = '"initialClasses":';
  const at = text.indexOf(key);
  if (at === -1) throw new Error('initialClasses not found in widget page');
  const obj = readJsonAt(text, at + key.length);
  return Array.isArray(obj?.classes) ? obj.classes : [];
}

function unflight(s) {
  if (typeof s !== 'string') return '';
  if (s.startsWith('$$')) return s.slice(1);
  return s.startsWith('$') ? '' : s;
}

// Mindbody sends 7 fractional digits ("…:00.0000000Z"); trim to a plain ISO
// instant so every consumer parses it the same way.
function isoInstant(s) {
  if (typeof s !== 'string') return null;
  const ms = Date.parse(s.replace(/\.\d+Z$/, 'Z'));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function widgetUrl(gym) {
  const id = gym.providerConfig?.widgetId;
  return id ? `${WIDGET_URL}/${encodeURIComponent(id)}/schedule` : gym.sourceUrl;
}

function normalize(c, gym) {
  const startDT = isoInstant(c.startDateTime);
  if (!startDT) return null;
  const endDT = isoInstant(c.endDateTime)
    ?? new Date(new Date(startDT).getTime() + (c.duration || 60) * 60000).toISOString();
  const capacity = Number.isFinite(c.capacity) ? c.capacity : null;
  const registered = Number.isFinite(c.numberRegistered) ? c.numberRegistered : null;
  return {
    gymId: gym.id,
    id: c.id ?? null,
    name: unflight(c.name).trim(),
    description: '',
    startDT,
    endDT,
    occurrenceDate: dateInTz(startDT, gym.tz),
    room: unflight(c.roomName).replace(/\s+/g, ' ').trim() || 'Studio',
    danceSuitable: false,
    category: 'Yoga',
    instructors: Array.isArray(c.staff)
      ? c.staff.map((s) => (s && typeof s === 'object' ? unflight(s.displayLabel) : '')).filter(Boolean)
      : [],
    seatsRemaining: capacity != null && registered != null ? Math.max(0, capacity - registered) : null,
    seatsTotal: capacity,
    // No per-class URL exists; the widget page itself is the studio's
    // bookable week, the deepest link Mindbody gives us.
    deepLink: widgetUrl(gym),
    source: 'blackswan',
  };
}

async function fetchWeek(gym, startUTC, endUTC) {
  const { widgetId } = gym.providerConfig;
  if (!widgetId) throw new Error(`gym ${gym.id} has no widgetId configured`);
  const res = await axios.get(widgetUrl(gym), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    responseType: 'text',
    timeout: 20000,
  });
  const lo = startUTC.getTime();
  const hi = endUTC.getTime();
  return extractClasses(String(res.data))
    .filter((c) => !c.cancelled)
    .map((c) => normalize(c, gym))
    .filter((e) => e && e.name)
    .filter((e) => {
      const t = new Date(e.startDT).getTime();
      return t >= lo && t <= hi;
    });
}

module.exports = { fetchWeek, extractClasses, normalize, flightText };

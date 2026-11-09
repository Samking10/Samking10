// Time helpers. All timestamps in the database are UTC milliseconds.
// Sending windows are evaluated in the contractor's own time zone, so DST is handled by Intl.

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatters = new Map();
function partsFormatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  return formatters.get(tz);
}

export function localParts(ts, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ts))) out[p.type] = p.value;
  return {
    weekday: WEEKDAYS[out.weekday],
    hour: Number(out.hour),
    minute: Number(out.minute),
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
  };
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseSendDays(str) {
  return String(str || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

export function isInSendWindow(ts, account) {
  const days = parseSendDays(account.send_days);
  const p = localParts(ts, account.timezone);
  return days.includes(p.weekday) && p.hour >= account.send_window_start && p.hour < account.send_window_end;
}

// Returns ts if it is inside the window, otherwise the first quarter hour that is.
export function nextSendTime(ts, account) {
  if (isInSendWindow(ts, account)) return ts;
  const step = 15 * MINUTE;
  let t = Math.ceil(ts / step) * step;
  const limit = ts + 15 * DAY;
  while (t < limit) {
    if (isInSendWindow(t, account)) return t;
    t += step;
  }
  // Only reachable with an impossible window (no days selected); settings validation prevents it.
  throw new Error(`Account ${account.id} has no valid sending window`);
}

export function formatDate(ts, tz, withTime = false) {
  if (!ts) return '';
  const opts = { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(ts));
}

// "2026-03-04" interpreted as noon local time in tz (noon avoids any DST edge on the day).
export function dateInputToTs(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let guess = Date.UTC(y, mo - 1, d, 12, 0);
  // Correct for the zone offset (two passes handles DST transitions).
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(y, mo - 1, d, 12, 0) - asUtc;
  }
  return guess;
}

export function tsToDateInput(ts, tz) {
  const p = localParts(ts, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function startOfLocalMonth(ts, tz) {
  const p = localParts(ts, tz);
  return dateInputToTs(`${p.year}-${String(p.month).padStart(2, '0')}-01`, tz) - 12 * HOUR;
}

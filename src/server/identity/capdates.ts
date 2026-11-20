/**
 * Pure employer-cap calendar math (issue 004). All dates are ISO local dates (YYYY-MM-DD) in
 * America/Los_Angeles; day arithmetic is calendar arithmetic, so DST never shifts a date.
 *
 * Window on local day T: (T minus N calendar months, T]. Month subtraction clamps to the last
 * valid day (May 31 minus 3 months is Feb 28/29). The lower boundary is open: on Nov 8 an Aug 8
 * submission has aged out and an Aug 9 submission still counts.
 */
export const CAP_TIME_ZONE = 'America/Los_Angeles';
export interface CapSettings {
  limit: number;
  windowMonths: number;
}
export const defaultCapSettings: CapSettings = { limit: 3, windowMonths: 3 };

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseIsoDate(value: string): {
  year: number;
  month: number;
  day: number;
} | null {
  const match = isoDate.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    return null;
  return { year, month, day };
}
export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function format(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function must(value: string) {
  const parsed = parseIsoDate(value);
  if (!parsed) throw new Error(`Invalid ISO date: ${value}`);
  return parsed;
}

/** Local calendar date in Los Angeles for an instant. */
export function laLocalDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function subtractMonthsClamped(date: string, months: number): string {
  const { year, month, day } = must(date);
  const index = year * 12 + (month - 1) - months;
  const y = Math.floor(index / 12),
    m = (index % 12) + 1;
  return format(y, m, Math.min(day, daysInMonth(y, m)));
}
export function addDays(date: string, days: number): string {
  const { year, month, day } = must(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return format(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}
/** Exclusive lower boundary of the window ending on `today`. */
export function windowStart(today: string, windowMonths: number): string {
  return subtractMonthsClamped(today, windowMonths);
}
export function inWindow(
  date: string,
  today: string,
  windowMonths: number,
): boolean {
  must(date);
  return date > windowStart(today, windowMonths) && date <= today;
}
export function countInWindow(
  dates: string[],
  today: string,
  windowMonths: number,
): number {
  return dates.filter((date) => inWindow(date, today, windowMonths)).length;
}

export interface CapEvaluation {
  today: string;
  windowStart: string;
  count: number;
  limit: number;
  capped: boolean;
  /** First local date a new submission fits under the cap (today when not capped). */
  nextAvailableDate: string;
}
/** Evaluates the cap for one canonical employer from its confirmed local submission dates. */
export function evaluateCap(
  confirmedDates: string[],
  today: string,
  settings: CapSettings = defaultCapSettings,
): CapEvaluation {
  const count = countInWindow(confirmedDates, today, settings.windowMonths);
  let next = today;
  // Only already-recorded dates exist; each day forward can only age entries out.
  for (let i = 0; i < 1200; i++) {
    const candidate = addDays(today, i);
    const live = confirmedDates.filter(
      (date) =>
        date <= candidate &&
        date > windowStart(candidate, settings.windowMonths),
    ).length;
    if (live < settings.limit) {
      next = candidate;
      break;
    }
  }
  return {
    today,
    windowStart: windowStart(today, settings.windowMonths),
    count,
    limit: settings.limit,
    capped: count >= settings.limit,
    nextAvailableDate: next,
  };
}

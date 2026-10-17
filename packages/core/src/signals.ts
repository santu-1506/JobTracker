/**
 * Parsers for the small bits of text job boards show next to a posting:
 * "Reposted 2 weeks ago", "Posted 30+ Days Ago", "Over 100 applicants",
 * "No longer accepting applications".
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

const UNIT_ALIASES: Record<string, keyof typeof UNIT_MS> = {
  s: 'second',
  sec: 'second',
  secs: 'second',
  second: 'second',
  m: 'minute',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  d: 'day',
  day: 'day',
  w: 'week',
  wk: 'week',
  wks: 'week',
  week: 'week',
  mo: 'month',
  mos: 'month',
  month: 'month',
  y: 'year',
  yr: 'year',
  yrs: 'year',
  year: 'year',
};

export interface PostedDate {
  /** Best estimate of when the board says the posting went live. */
  postedAt: Date;
  /** True for "30+ days ago": the real date is this old or older. */
  isLowerBound: boolean;
  /** True when the board itself labels the posting as reposted. */
  reposted: boolean;
}

/**
 * Parses posted-date text from LinkedIn, Indeed, Workday and similar boards.
 * Returns null when the text has no usable date, such as "Employer active 2
 * days ago", which describes the employer rather than the posting.
 */
export function parsePostedText(text: string | null | undefined, now: Date = new Date()): PostedDate | null {
  if (!text) return null;
  const lower = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!lower || /employer active|responded|last (?:active|login)/.test(lower)) return null;

  const reposted = /\bre-?posted\b/.test(lower);

  const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})(?:t[\d:.]+z?)?\b/);
  if (iso) {
    const date = new Date(iso[0].length > 10 ? iso[0].toUpperCase() : `${iso[1]}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) return { postedAt: date, isLowerBound: false, reposted };
  }

  const relative = lower.match(/\b(an?|\d+)(\+)?\s*([a-z]+?)s?\s+ago\b/);
  if (relative) {
    const [, amountText, plus, rawUnit] = relative;
    const unit = UNIT_ALIASES[rawUnit!];
    if (unit) {
      const amount = amountText === 'a' || amountText === 'an' ? 1 : Number(amountText);
      const postedAt = new Date(now.getTime() - amount * UNIT_MS[unit]!);
      return { postedAt, isLowerBound: plus === '+', reposted };
    }
  }

  if (/\b(?:just (?:now|posted)|today|moments? ago)\b/.test(lower)) {
    return { postedAt: new Date(now), isLowerBound: false, reposted };
  }
  if (/\byesterday\b/.test(lower)) {
    return { postedAt: new Date(now.getTime() - DAY_MS), isLowerBound: false, reposted };
  }

  return null;
}

/** "Over 100 applicants", "1,203 applicants", "Be among the first 25 applicants". */
export function parseApplicantCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const match = lower.match(/(\d[\d,]*)\+?\s*(?:applicants|applications|people clicked apply)/);
  if (!match) return null;
  if (/among the first/.test(lower)) return 0;
  const count = Number(match[1]!.replace(/,/g, ''));
  return Number.isFinite(count) ? count : null;
}

const CLOSED_PATTERNS = [
  /no longer accepting applications/i,
  /this job (?:has )?expired/i,
  /this (?:job|position|posting) is no longer (?:available|open)/i,
  /the job you are looking for is no longer open/i,
  /position (?:has been )?filled/i,
];

export function looksClosed(text: string | null | undefined): boolean {
  if (!text) return false;
  return CLOSED_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Phrases that suggest a pipeline or "evergreen" posting: the company is
 * collecting resumes rather than hiring for an open seat.
 */
const EVERGREEN_PATTERNS: Array<[RegExp, string]> = [
  [/talent (?:community|pool|network|pipeline)/i, 'talent pool'],
  [/future (?:opportunities|openings|roles|vacancies)/i, 'future opportunities'],
  [/(?:always|continuously) (?:looking|hiring|accepting)/i, 'always hiring'],
  [/evergreen (?:role|position|requisition|posting)/i, 'evergreen posting'],
  [/general (?:application|interest)/i, 'general application'],
  [/expression of interest/i, 'expression of interest'],
  [/not (?:a|an) (?:current|active|immediate) (?:opening|vacancy|position)/i, 'not a current opening'],
  [/may not (?:be|represent) an? (?:active|current) (?:opening|role|vacancy)/i, 'not a current opening'],
  [/(?:build|building) (?:a|our) pipeline/i, 'building a pipeline'],
];

export function detectEvergreenLanguage(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const [pattern, label] of EVERGREEN_PATTERNS) if (pattern.test(text)) found.add(label);
  return [...found];
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

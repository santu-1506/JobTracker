import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  detectEvergreenLanguage,
  looksClosed,
  parseApplicantCount,
  parsePostedText,
} from '../src/signals.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const daysAgo = (text: string) => {
  const parsed = parsePostedText(text, NOW);
  return parsed ? daysBetween(parsed.postedAt, NOW) : null;
};

describe('parsePostedText', () => {
  it.each([
    ['Posted 3 days ago', 3],
    ['2 weeks ago', 14],
    ['Reposted 1 month ago', 30],
    ['a day ago', 1],
    ['an hour ago', 0],
    ['5h ago', 0],
    ['3d ago', 3],
    ['Posted Today', 0],
    ['Just posted', 0],
    ['Posted Yesterday', 1],
    ['Posted 30+ Days Ago', 30],
    ['Active 6 days ago', 6],
    ['2 years ago', 730],
    ['New York, NY · Reposted 2 weeks ago · Over 100 applicants', 14],
  ])('%s is %i days old', (text, expected) => {
    expect(daysAgo(text)).toBe(expected);
  });

  it('flags reposts and lower bounds', () => {
    expect(parsePostedText('Reposted 2 weeks ago', NOW)?.reposted).toBe(true);
    expect(parsePostedText('Posted 2 weeks ago', NOW)?.reposted).toBe(false);
    expect(parsePostedText('Posted 30+ Days Ago', NOW)?.isLowerBound).toBe(true);
  });

  it('reads ISO dates from structured data', () => {
    expect(parsePostedText('2026-09-01', NOW)?.postedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parsePostedText('2026-09-01T08:30:00Z', NOW)?.postedAt.toISOString()).toBe(
      '2026-09-01T08:30:00.000Z',
    );
  });

  it('ignores employer activity and junk', () => {
    expect(parsePostedText('Employer active 2 days ago', NOW)).toBeNull();
    expect(parsePostedText('Full-time · Mid-Senior level', NOW)).toBeNull();
    expect(parsePostedText('', NOW)).toBeNull();
    expect(parsePostedText(undefined, NOW)).toBeNull();
  });
});

describe('parseApplicantCount', () => {
  it.each([
    ['Over 100 applicants', 100],
    ['1,203 applicants', 1203],
    ['37 applicants', 37],
    ['Be among the first 25 applicants', 0],
    ['200+ people clicked apply', 200],
    ['Promoted', null],
  ])('%s -> %s', (text, expected) => {
    expect(parseApplicantCount(text)).toBe(expected);
  });
});

describe('looksClosed', () => {
  it('recognises closed postings', () => {
    expect(looksClosed('No longer accepting applications')).toBe(true);
    expect(looksClosed('This job has expired on Indeed')).toBe(true);
    expect(looksClosed('Apply now')).toBe(false);
  });
});

describe('detectEvergreenLanguage', () => {
  it('finds pipeline phrasing', () => {
    const text =
      'Join our Talent Community! This is not a current opening, but we are always looking for great engineers for future opportunities.';
    expect(detectEvergreenLanguage(text).sort()).toEqual(
      ['always hiring', 'future opportunities', 'not a current opening', 'talent pool'].sort(),
    );
  });

  it('returns nothing for a normal posting', () => {
    expect(detectEvergreenLanguage('We are hiring a backend engineer to start in January.')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { assessPosting, formatDaysAgo, type GhostSignals } from '../src/score.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const signals = (overrides: Partial<GhostSignals> = {}): GhostSignals => ({
  firstSeenAt: daysAgo(0),
  repostCount: 0,
  viewerCount: 1,
  sightingCount: 1,
  ...overrides,
});

describe('assessPosting', () => {
  it('has no verdict on a first sighting with no board date', () => {
    const result = assessPosting(signals(), NOW);
    expect(result.level).toBe('unknown');
    expect(result.confidence).toBe('low');
    expect(result.score).toBe(0);
  });

  it('calls a recently posted job fresh', () => {
    const result = assessPosting(signals({ earliestPostedAt: daysAgo(2), latestPostedAt: daysAgo(2) }), NOW);
    expect(result.level).toBe('fresh');
    expect(result.label).toBe('Fresh: posted 2 days ago');
  });

  it('flags a job first seen 94 days ago as a likely ghost', () => {
    const result = assessPosting(signals({ firstSeenAt: daysAgo(94), viewerCount: 12, sightingCount: 30 }), NOW);
    expect(result.level).toBe('likely_ghost');
    expect(result.label).toBe('Likely ghost: first seen 94 days ago');
    expect(result.confidence).toBe('high');
  });

  it('uses the board date when it is older than our first sighting', () => {
    const result = assessPosting(signals({ firstSeenAt: daysAgo(3), earliestPostedAt: daysAgo(100) }), NOW);
    expect(result.ageDays).toBe(100);
    expect(result.label).toBe('Likely ghost: posted 100 days ago');
  });

  it('labels reposted jobs with the repost count', () => {
    const result = assessPosting(signals({ firstSeenAt: daysAgo(30), repostCount: 3, viewerCount: 4 }), NOW);
    expect(result.level).toBe('reposted');
    expect(result.label).toBe('Reposted 3×');
    expect(result.reasons.map((r) => r.code)).toEqual(['age', 'reposts']);
  });

  it('trusts the board repost label when we have no history', () => {
    const result = assessPosting(signals({ boardSaysReposted: true, earliestPostedAt: daysAgo(5) }), NOW);
    expect(result.level).toBe('reposted');
    expect(result.repostCount).toBe(1);
  });

  it('escalates old, repeatedly reposted jobs to likely ghost', () => {
    const result = assessPosting(signals({ firstSeenAt: daysAgo(60), repostCount: 3 }), NOW);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.level).toBe('likely_ghost');
  });

  it('penalises a posted date that was bumped long after we first saw the job', () => {
    const result = assessPosting(
      signals({ firstSeenAt: daysAgo(40), latestPostedAt: daysAgo(2), earliestPostedAt: daysAgo(2) }),
      NOW,
    );
    const refreshed = result.reasons.find((r) => r.code === 'refreshed');
    expect(refreshed?.text).toBe('Board says posted 2 days ago, but it was first seen 40 days ago');
  });

  it('adds points for evergreen language and huge applicant counts', () => {
    const result = assessPosting(
      signals({ firstSeenAt: daysAgo(45), evergreenPhrases: ['talent pool'], applicantCount: 200 }),
      NOW,
    );
    expect(result.reasons.map((r) => r.code)).toEqual(['age', 'evergreen', 'applicants']);
    expect(result.level).toBe('aging');
  });

  it('reports closed postings regardless of score', () => {
    const result = assessPosting(signals({ firstSeenAt: daysAgo(5), closed: true }), NOW);
    expect(result.level).toBe('closed');
  });

  it('never exceeds 100', () => {
    const result = assessPosting(
      signals({
        firstSeenAt: daysAgo(400),
        repostCount: 10,
        latestPostedAt: daysAgo(1),
        evergreenPhrases: ['talent pool'],
        applicantCount: 500,
      }),
      NOW,
    );
    expect(result.score).toBe(100);
  });
});

describe('formatDaysAgo', () => {
  it('reads naturally', () => {
    expect(formatDaysAgo(0)).toBe('today');
    expect(formatDaysAgo(1)).toBe('yesterday');
    expect(formatDaysAgo(9)).toBe('9 days ago');
  });
});

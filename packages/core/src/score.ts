import { daysBetween } from './signals.js';

/**
 * Explainable ghost-job score.
 *
 * Every point comes with a human-readable reason so the badge can say *why*
 * a posting looks stale instead of showing an opaque number. The weights are
 * deliberately simple; see docs/ghost-score.md for the reasoning.
 */

export type GhostLevel = 'unknown' | 'fresh' | 'aging' | 'reposted' | 'likely_ghost' | 'closed';
export type Confidence = 'low' | 'medium' | 'high';

export interface GhostSignals {
  /** Earliest time any JobTracker user saw this job on any board. */
  firstSeenAt: Date;
  /** Oldest posted date any board claimed for this job. */
  earliestPostedAt?: Date | null;
  /** Newest posted date any board claimed (moves forward when a job is bumped). */
  latestPostedAt?: Date | null;
  /** Re-listings under a new id on the same board, plus posted-date refreshes. */
  repostCount: number;
  viewerCount: number;
  sightingCount: number;
  boardSaysReposted?: boolean;
  closed?: boolean;
  applicantCount?: number | null;
  evergreenPhrases?: string[];
}

export type ReasonCode = 'age' | 'reposts' | 'refreshed' | 'evergreen' | 'applicants';

export interface ScoreReason {
  code: ReasonCode;
  points: number;
  text: string;
}

export interface GhostAssessment {
  score: number;
  level: GhostLevel;
  label: string;
  ageDays: number;
  firstSeenDays: number;
  repostCount: number;
  confidence: Confidence;
  reasons: ScoreReason[];
}

export const SCORE_THRESHOLDS = { aging: 25, ghost: 60 } as const;

const AGE_GRACE_DAYS = 21;
const AGE_FULL_DAYS = 90;
const AGE_MAX_POINTS = 70;
const POINTS_PER_REPOST = 12;
const REPOST_MAX_POINTS = 36;
const REFRESH_GAP_DAYS = 14;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function formatDaysAgo(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function assessPosting(signals: GhostSignals, now: Date = new Date()): GhostAssessment {
  const firstSeenDays = daysBetween(signals.firstSeenAt, now);
  const claimedOrigin =
    signals.earliestPostedAt && signals.earliestPostedAt < signals.firstSeenAt ? signals.earliestPostedAt : null;
  const ageDays = daysBetween(claimedOrigin ?? signals.firstSeenAt, now);
  const originText = claimedOrigin ? `posted ${formatDaysAgo(ageDays)}` : `first seen ${formatDaysAgo(firstSeenDays)}`;
  const reposts = Math.max(signals.repostCount, signals.boardSaysReposted ? 1 : 0);
  const reasons: ScoreReason[] = [];

  const agePoints = clamp(
    Math.round(((ageDays - AGE_GRACE_DAYS) * 60) / (AGE_FULL_DAYS - AGE_GRACE_DAYS)),
    0,
    AGE_MAX_POINTS,
  );
  if (agePoints > 0) {
    reasons.push({ code: 'age', points: agePoints, text: `Open for ${ageDays} days` });
  }

  if (reposts > 0) {
    reasons.push({
      code: 'reposts',
      points: Math.min(reposts * POINTS_PER_REPOST, REPOST_MAX_POINTS),
      text:
        signals.repostCount > 0
          ? `Reposted ${reposts}× since it was first seen`
          : 'The job board labels this posting as reposted',
    });
  }

  if (signals.latestPostedAt) {
    const gap = daysBetween(signals.firstSeenAt, signals.latestPostedAt);
    if (gap >= REFRESH_GAP_DAYS) {
      const claimed = daysBetween(signals.latestPostedAt, now);
      reasons.push({
        code: 'refreshed',
        points: 15,
        text: `Board says posted ${formatDaysAgo(claimed)}, but it was first seen ${formatDaysAgo(firstSeenDays)}`,
      });
    }
  }

  const phrases = signals.evergreenPhrases ?? [];
  if (phrases.length > 0) {
    reasons.push({
      code: 'evergreen',
      points: 15,
      text: `Description reads like a pipeline posting (${phrases.join(', ')})`,
    });
  }

  if ((signals.applicantCount ?? 0) >= 100 && ageDays > 30) {
    reasons.push({
      code: 'applicants',
      points: 5,
      text: `${signals.applicantCount}+ applicants and still open after ${ageDays} days`,
    });
  }

  const score = clamp(
    reasons.reduce((sum, reason) => sum + reason.points, 0),
    0,
    100,
  );

  const confidence: Confidence =
    signals.viewerCount >= 5 || (firstSeenDays >= 30 && signals.sightingCount >= 3)
      ? 'high'
      : signals.viewerCount >= 2 || signals.sightingCount >= 2 || claimedOrigin !== null || signals.latestPostedAt
        ? 'medium'
        : 'low';

  const base = { score, ageDays, firstSeenDays, repostCount: reposts, confidence, reasons };

  if (signals.closed) {
    return { ...base, level: 'closed', label: 'Closed: no longer accepting applications' };
  }
  if (score >= SCORE_THRESHOLDS.ghost) {
    return { ...base, level: 'likely_ghost', label: `Likely ghost: ${originText}` };
  }
  if (reposts > 0) {
    return { ...base, level: 'reposted', label: `Reposted ${reposts}×` };
  }
  if (score >= SCORE_THRESHOLDS.aging) {
    return { ...base, level: 'aging', label: `Open ${ageDays} days` };
  }
  if (confidence === 'low' && firstSeenDays === 0 && !signals.latestPostedAt) {
    return { ...base, level: 'unknown', label: 'First sighting: no history yet' };
  }
  return { ...base, level: 'fresh', label: `Fresh: ${originText}` };
}

import type { GhostAssessment, GhostLevel } from './score.js';

/**
 * Wire types shared by the API and the extension. Dates travel as ISO
 * strings; SimHash fingerprints travel as 16-character hex strings.
 */

export const JOB_SOURCES = ['linkedin', 'indeed', 'greenhouse', 'lever', 'workday', 'other'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/** Sent by the extension each time the user opens a job page. */
export interface SightingInput {
  source: JobSource;
  /** The board's own id for the posting (LinkedIn job id, Indeed jk, Workday requisition id...). */
  sourceJobId: string;
  url: string;
  title: string;
  company: string;
  location?: string | null;
  /** simhash64 of the description, computed in the browser. */
  descriptionHash?: string | null;
  evergreenPhrases?: string[];
  postedAt?: string | null;
  postedAtIsLowerBound?: boolean;
  boardSaysReposted?: boolean;
  closed?: boolean;
  applicantCount?: number | null;
}

export const APPLICATION_STAGES = [
  'saved',
  'applied',
  'oa',
  'interview',
  'offer',
  'rejected',
  'ghosted',
  'withdrawn',
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export const STAGE_LABELS: Record<ApplicationStage, string> = {
  saved: 'Saved',
  applied: 'Applied',
  oa: 'Online assessment',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  ghosted: 'Ghosted',
  withdrawn: 'Withdrawn',
};

/** Stages where the user is still waiting on the company or still deciding. */
export const ACTIVE_STAGES: readonly ApplicationStage[] = ['saved', 'applied', 'oa', 'interview'];
/** Any of these means the company replied to an application. */
export const RESPONSE_STAGES: readonly ApplicationStage[] = ['oa', 'interview', 'offer', 'rejected'];

export interface GhostSummary {
  level: GhostLevel;
  label: string;
  score: number;
}

export interface Application {
  id: string;
  clusterId: string | null;
  postingId: string | null;
  company: string;
  title: string;
  location: string | null;
  url: string | null;
  stage: ApplicationStage;
  notes: string;
  appliedAt: string | null;
  nextActionAt: string | null;
  nextActionNote: string | null;
  createdAt: string;
  updatedAt: string;
  ghost: GhostSummary | null;
}

export interface CreateApplicationInput {
  postingId?: string;
  company?: string;
  title?: string;
  location?: string | null;
  url?: string | null;
  stage?: ApplicationStage;
  notes?: string;
}

export interface UpdateApplicationInput {
  stage?: ApplicationStage;
  notes?: string;
  nextActionAt?: string | null;
  nextActionNote?: string | null;
}

export interface BadgeResponse {
  postingId: string;
  clusterId: string;
  assessment: GhostAssessment;
  firstSeenAt: string;
  sources: JobSource[];
  viewerCount: number;
  application: Application | null;
}

export interface ClusterHistory {
  clusterId: string;
  company: string;
  title: string;
  assessment: GhostAssessment;
  postings: Array<{
    id: string;
    source: JobSource;
    url: string;
    firstSeenAt: string;
    lastSeenAt: string;
    postedAt: string | null;
  }>;
  /** Distinct viewers per day, oldest first. */
  timeline: Array<{ day: string; viewers: number }>;
}

export type Plan = 'free' | 'pro';

export interface PlanLimits {
  /** null means unlimited. */
  maxApplications: number | null;
  reminders: boolean;
  analytics: boolean;
}

/** The badge is always free. Pro unlocks the full tracker, reminders and analytics. */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxApplications: 25, reminders: false, analytics: false },
  pro: { maxApplications: null, reminders: true, analytics: true },
};

export interface InstallResponse {
  userId: string;
  token: string;
  plan: Plan;
}

export interface MeResponse {
  userId: string;
  plan: Plan;
  limits: PlanLimits;
  usage: { applications: number };
}

export interface Reminder {
  applicationId: string;
  company: string;
  title: string;
  url: string | null;
  stage: ApplicationStage;
  dueAt: string;
  note: string;
}

export interface AnalyticsResponse {
  totals: { tracked: number; applied: number; responded: number; interviews: number; offers: number; ghosted: number };
  byStage: Record<ApplicationStage, number>;
  responseRate: number | null;
  interviewRate: number | null;
  medianDaysToResponse: number | null;
  appliedToLikelyGhosts: number;
  weekly: Array<{ week: string; applied: number }>;
}

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'plan_required'
  | 'plan_limit'
  | 'rate_limited'
  | 'internal';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

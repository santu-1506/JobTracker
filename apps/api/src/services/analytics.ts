import { APPLICATION_STAGES, type AnalyticsResponse, type ApplicationStage } from '@jobtracker/core';
import type { Queryable } from '../db/pool.js';

const WEEKS = 12;

const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);

/**
 * Funnel metrics for one user, computed from the stage history rather than
 * the current stage, so an application that reached an interview and was
 * then rejected still counts as an interview.
 */
export async function getAnalytics(db: Queryable, userId: string): Promise<AnalyticsResponse> {
  const byStageResult = await db.query<{ stage: ApplicationStage; n: number }>(
    'SELECT stage, count(*)::int AS n FROM applications WHERE user_id = $1 GROUP BY stage',
    [userId],
  );
  const byStage = Object.fromEntries(APPLICATION_STAGES.map((stage) => [stage, 0])) as Record<ApplicationStage, number>;
  for (const row of byStageResult.rows) byStage[row.stage] = row.n;

  const { rows } = await db.query<{
    tracked: number;
    applied: number;
    responded: number;
    interviews: number;
    offers: number;
    ghosted: number;
    applied_to_ghosts: number;
    median_days: number | null;
  }>(
    `WITH apps AS (
       SELECT id, applied_at, stage, cluster_id FROM applications WHERE user_id = $1
     ),
     history AS (
       SELECT e.application_id,
              min(e.created_at) FILTER (WHERE e.to_stage IN ('oa', 'interview', 'offer', 'rejected')) AS responded_at,
              bool_or(e.to_stage IN ('interview', 'offer')) AS interviewed,
              bool_or(e.to_stage = 'offer') AS offered
         FROM application_events e
         JOIN apps a ON a.id = e.application_id
        GROUP BY e.application_id
     )
     SELECT count(*)::int AS tracked,
            count(*) FILTER (WHERE a.applied_at IS NOT NULL)::int AS applied,
            count(*) FILTER (WHERE a.applied_at IS NOT NULL AND h.responded_at IS NOT NULL)::int AS responded,
            count(*) FILTER (WHERE h.interviewed)::int AS interviews,
            count(*) FILTER (WHERE h.offered)::int AS offers,
            count(*) FILTER (WHERE a.stage = 'ghosted')::int AS ghosted,
            count(*) FILTER (WHERE a.applied_at IS NOT NULL AND c.ghost_level = 'likely_ghost')::int AS applied_to_ghosts,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM h.responded_at - a.applied_at) / 86400
            ) FILTER (WHERE h.responded_at >= a.applied_at) AS median_days
       FROM apps a
       LEFT JOIN history h ON h.application_id = a.id
       LEFT JOIN job_clusters c ON c.id = a.cluster_id`,
    [userId],
  );
  const t = rows[0]!;

  const weekly = await db.query<{ week: string; applied: number }>(
    `SELECT to_char(week, 'YYYY-MM-DD') AS week, count(a.id)::int AS applied
       FROM generate_series(
              date_trunc('week', now()) - make_interval(weeks => $2 - 1),
              date_trunc('week', now()),
              interval '1 week'
            ) AS week
       LEFT JOIN applications a
         ON a.user_id = $1 AND a.applied_at >= week AND a.applied_at < week + interval '1 week'
      GROUP BY week
      ORDER BY week`,
    [userId, WEEKS],
  );

  return {
    totals: {
      tracked: t.tracked,
      applied: t.applied,
      responded: t.responded,
      interviews: t.interviews,
      offers: t.offers,
      ghosted: t.ghosted,
    },
    byStage,
    responseRate: ratio(t.responded, t.applied),
    interviewRate: ratio(t.interviews, t.applied),
    medianDaysToResponse: t.median_days === null ? null : Math.round(t.median_days * 10) / 10,
    appliedToLikelyGhosts: t.applied_to_ghosts,
    weekly: weekly.rows,
  };
}

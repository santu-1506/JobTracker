import { CLUSTER_COLUMNS, assessCluster, type ClusterRow } from '../services/clusters.js';
import { enqueue } from './queue.js';
import type { JobHandler, Schedule } from './worker.js';

export const RESCORE_BATCH_SIZE = 500;
/** Clusters nobody has opened for this long keep their last score. */
const RESCORE_WINDOW_DAYS = 180;
export const NO_RESPONSE_DAYS = 30;

export const NO_RESPONSE_NOTE = `No response in ${NO_RESPONSE_DAYS} days: follow up or mark as ghosted`;
export const GHOST_WARNING_NOTE = 'Heads up: this saved job now looks like a ghost posting';

type ScoredClusterRow = ClusterRow & { ghost_score: number; ghost_level: string; ghost_label: string };

/**
 * Ghost scores depend on age, so they drift even when nobody views a job.
 * This walks recently active clusters in id order (keyset pagination), writes
 * back only the rows whose verdict changed, and chains the next batch as a
 * new job so each run stays short.
 */
export const rescoreClusters: JobHandler = async (job, { pool, now, log }) => {
  const afterId = typeof job.payload.afterId === 'string' ? job.payload.afterId : null;
  const { rows } = await pool.query<ScoredClusterRow>(
    `SELECT ${CLUSTER_COLUMNS}, ghost_score, ghost_level, ghost_label
       FROM job_clusters
      WHERE last_seen_at > now() - make_interval(days => $1)
        AND ($2::uuid IS NULL OR id > $2::uuid)
      ORDER BY id
      LIMIT $3`,
    [RESCORE_WINDOW_DAYS, afterId, RESCORE_BATCH_SIZE],
  );

  const changed = rows
    .map((row) => ({ row, assessment: assessCluster(row, now) }))
    .filter(
      ({ row, assessment }) =>
        assessment.score !== row.ghost_score ||
        assessment.level !== row.ghost_level ||
        assessment.label !== row.ghost_label,
    );

  if (changed.length > 0) {
    await pool.query(
      `UPDATE job_clusters c
          SET ghost_score = u.score, ghost_level = u.level, ghost_label = u.label, scored_at = now()
         FROM unnest($1::uuid[], $2::smallint[], $3::text[], $4::text[]) AS u(id, score, level, label)
        WHERE c.id = u.id`,
      [
        changed.map(({ row }) => row.id),
        changed.map(({ assessment }) => assessment.score),
        changed.map(({ assessment }) => assessment.level),
        changed.map(({ assessment }) => assessment.label),
      ],
    );
  }

  if (rows.length === RESCORE_BATCH_SIZE) {
    await enqueue(pool, 'clusters.rescore', { afterId: rows[rows.length - 1]!.id });
  }
  log.info({ scanned: rows.length, changed: changed.length }, 'rescored clusters');
};

/**
 * Nudges users about applications that went quiet, and about saved jobs
 * whose posting has since turned into a likely ghost. Each nudge is set once:
 * the note acts as the "already reminded" marker.
 */
export const scheduleFollowUps: JobHandler = async (_job, { pool, log }) => {
  const quiet = await pool.query(
    `UPDATE applications
        SET next_action_at = now(), next_action_note = $1
      WHERE stage = 'applied'
        AND applied_at < now() - make_interval(days => $2)
        AND updated_at < now() - make_interval(days => $2)
        AND next_action_note IS DISTINCT FROM $1`,
    [NO_RESPONSE_NOTE, NO_RESPONSE_DAYS],
  );

  const ghosts = await pool.query(
    `UPDATE applications a
        SET next_action_at = now(), next_action_note = $1
       FROM job_clusters c
      WHERE a.cluster_id = c.id
        AND a.stage = 'saved'
        AND c.ghost_level = 'likely_ghost'
        AND a.next_action_note IS DISTINCT FROM $1`,
    [GHOST_WARNING_NOTE],
  );

  log.info({ noResponse: quiet.rowCount, ghostWarnings: ghosts.rowCount }, 'follow-ups scheduled');
};

export const defaultHandlers: Record<string, JobHandler> = {
  'clusters.rescore': rescoreClusters,
  'applications.followups': scheduleFollowUps,
};

export const defaultSchedules: Schedule[] = [
  { name: 'rescore-clusters-hourly', queue: 'clusters.rescore', everyMinutes: 60 },
  { name: 'follow-ups-hourly', queue: 'applications.followups', everyMinutes: 60 },
];

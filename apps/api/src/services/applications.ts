import {
  PLAN_LIMITS,
  type Application,
  type ApplicationDetail,
  type ApplicationStage,
  type CreateApplicationInput,
  type GhostLevel,
  type UpdateApplicationInput,
} from '@jobtracker/core';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool.js';
import { badRequest, notFound, planLimit } from '../errors.js';
import type { AuthUser } from '../plugins/auth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ApplicationRow {
  id: string;
  cluster_id: string | null;
  posting_id: string | null;
  company: string;
  title: string;
  location: string | null;
  url: string | null;
  stage: ApplicationStage;
  notes: string;
  applied_at: Date | null;
  next_action_at: Date | null;
  next_action_note: string | null;
  created_at: Date;
  updated_at: Date;
  ghost_level: GhostLevel | null;
  ghost_label: string | null;
  ghost_score: number | null;
}

const SELECT_APPLICATION = `
  SELECT a.id, a.cluster_id, a.posting_id, a.company, a.title, a.location, a.url, a.stage, a.notes,
         a.applied_at, a.next_action_at, a.next_action_note, a.created_at, a.updated_at,
         c.ghost_level, c.ghost_label, c.ghost_score
    FROM applications a
    LEFT JOIN job_clusters c ON c.id = a.cluster_id`;

/** Stages that mean the user has actually applied. */
const APPLIED_OR_LATER: readonly ApplicationStage[] = ['applied', 'oa', 'interview', 'offer'];
const TERMINAL: readonly ApplicationStage[] = ['offer', 'rejected', 'ghosted', 'withdrawn'];

/** The follow-up nudge each stage starts with. Terminal stages clear it. */
const DEFAULT_NEXT_ACTION: Partial<Record<ApplicationStage, { days: number; note: string }>> = {
  applied: { days: 7, note: 'Follow up if you have not heard back' },
  oa: { days: 3, note: 'Complete the online assessment' },
  interview: { days: 5, note: 'Check in on interview feedback' },
};

function toApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    postingId: row.posting_id,
    company: row.company,
    title: row.title,
    location: row.location,
    url: row.url,
    stage: row.stage,
    notes: row.notes,
    appliedAt: row.applied_at?.toISOString() ?? null,
    nextActionAt: row.next_action_at?.toISOString() ?? null,
    nextActionNote: row.next_action_note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ghost: row.ghost_level
      ? { level: row.ghost_level, label: row.ghost_label ?? '', score: row.ghost_score ?? 0 }
      : null,
  };
}

function stageSideEffects(stage: ApplicationStage, now: Date) {
  const next = DEFAULT_NEXT_ACTION[stage];
  return {
    appliedAt: APPLIED_OR_LATER.includes(stage) ? now : null,
    nextActionAt: next ? new Date(now.getTime() + next.days * DAY_MS) : null,
    nextActionNote: next?.note ?? null,
    clearsNextAction: TERMINAL.includes(stage),
  };
}

export async function countApplications(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM applications WHERE user_id = $1', [
    userId,
  ]);
  return rows[0]!.n;
}

export async function listApplications(
  db: Queryable,
  userId: string,
  filter: { stage?: ApplicationStage } = {},
): Promise<Application[]> {
  const { rows } = await db.query<ApplicationRow>(
    `${SELECT_APPLICATION}
      WHERE a.user_id = $1 AND ($2::application_stage IS NULL OR a.stage = $2)
      ORDER BY a.updated_at DESC`,
    [userId, filter.stage ?? null],
  );
  return rows.map(toApplication);
}

export async function getApplication(db: Queryable, userId: string, id: string): Promise<Application | null> {
  const { rows } = await db.query<ApplicationRow>(`${SELECT_APPLICATION} WHERE a.user_id = $1 AND a.id = $2`, [
    userId,
    id,
  ]);
  return rows[0] ? toApplication(rows[0]) : null;
}

export async function getApplicationDetail(db: Queryable, userId: string, id: string): Promise<ApplicationDetail | null> {
  const application = await getApplication(db, userId, id);
  if (!application) return null;
  const { rows } = await db.query<{ from_stage: ApplicationStage | null; to_stage: ApplicationStage; created_at: Date }>(
    'SELECT from_stage, to_stage, created_at FROM application_events WHERE application_id = $1 ORDER BY id',
    [id],
  );
  return {
    ...application,
    events: rows.map((e) => ({ fromStage: e.from_stage, toStage: e.to_stage, at: e.created_at.toISOString() })),
  };
}

export async function getApplicationForCluster(
  db: Queryable,
  userId: string,
  clusterId: string,
): Promise<Application | null> {
  const { rows } = await db.query<ApplicationRow>(
    `${SELECT_APPLICATION} WHERE a.user_id = $1 AND a.cluster_id = $2`,
    [userId, clusterId],
  );
  return rows[0] ? toApplication(rows[0]) : null;
}

async function enforcePlanLimit(client: PoolClient, user: AuthUser): Promise<void> {
  const max = PLAN_LIMITS[user.plan].maxApplications;
  if (max === null) return;
  // Lock the user row so two concurrent saves cannot both slip under the cap.
  await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [user.id]);
  if ((await countApplications(client, user.id)) >= max) {
    throw planLimit(`The free plan tracks up to ${max} jobs. Upgrade to Pro for unlimited tracking.`);
  }
}

/**
 * Saves a job to the tracker. Saving a job that is already tracked (from any
 * board) returns the existing entry, so the one-click button is idempotent.
 */
export async function createApplication(
  pool: Pool,
  user: AuthUser,
  input: CreateApplicationInput,
  now: Date = new Date(),
): Promise<{ application: Application; created: boolean }> {
  return withTransaction(pool, async (client) => {
    let fields: { clusterId: string | null; postingId: string | null; company: string; title: string; location: string | null; url: string | null };

    if (input.postingId) {
      const { rows } = await client.query<{ id: string; cluster_id: string; company: string; title: string; location: string | null; url: string }>(
        'SELECT id, cluster_id, company, title, location, url FROM postings WHERE id = $1',
        [input.postingId],
      );
      const posting = rows[0];
      if (!posting) throw notFound('Posting');
      const existing = await getApplicationForCluster(client, user.id, posting.cluster_id);
      if (existing) return { application: existing, created: false };
      fields = {
        clusterId: posting.cluster_id,
        postingId: posting.id,
        company: posting.company,
        title: posting.title,
        location: posting.location,
        url: posting.url,
      };
    } else {
      if (!input.company?.trim() || !input.title?.trim()) {
        throw badRequest('company and title are required when no postingId is given');
      }
      fields = {
        clusterId: null,
        postingId: null,
        company: input.company.trim(),
        title: input.title.trim(),
        location: input.location?.trim() || null,
        url: input.url ?? null,
      };
    }

    await enforcePlanLimit(client, user);

    const stage = input.stage ?? 'saved';
    const effects = stageSideEffects(stage, now);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO applications
         (user_id, cluster_id, posting_id, company, title, location, url, stage, notes, applied_at, next_action_at, next_action_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, cluster_id) WHERE cluster_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        user.id,
        fields.clusterId,
        fields.postingId,
        fields.company,
        fields.title,
        fields.location,
        fields.url,
        stage,
        input.notes ?? '',
        effects.appliedAt,
        effects.nextActionAt,
        effects.nextActionNote,
      ],
    );

    const insertedId = rows[0]?.id;
    if (!insertedId) {
      // Lost a race with a concurrent save of the same job.
      const existing = await getApplicationForCluster(client, user.id, fields.clusterId!);
      return { application: existing!, created: false };
    }
    await client.query('INSERT INTO application_events (application_id, from_stage, to_stage) VALUES ($1, NULL, $2)', [
      insertedId,
      stage,
    ]);
    return { application: (await getApplication(client, user.id, insertedId))!, created: true };
  });
}

export async function updateApplication(
  pool: Pool,
  userId: string,
  id: string,
  patch: UpdateApplicationInput,
  now: Date = new Date(),
): Promise<Application> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ stage: ApplicationStage; applied_at: Date | null }>(
      'SELECT stage, applied_at FROM applications WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, userId],
    );
    const current = rows[0];
    if (!current) throw notFound('Application');

    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.stage && patch.stage !== current.stage) {
      const effects = stageSideEffects(patch.stage, now);
      set('stage', patch.stage);
      if (effects.appliedAt && !current.applied_at) set('applied_at', effects.appliedAt);
      if (effects.nextActionAt || effects.clearsNextAction) {
        set('next_action_at', effects.nextActionAt);
        set('next_action_note', effects.nextActionNote);
      }
      await client.query(
        'INSERT INTO application_events (application_id, from_stage, to_stage) VALUES ($1, $2, $3)',
        [id, current.stage, patch.stage],
      );
    }
    if (patch.notes !== undefined) set('notes', patch.notes);
    // Explicit values from the client win over the stage defaults above.
    if (patch.nextActionAt !== undefined) set('next_action_at', patch.nextActionAt);
    if (patch.nextActionNote !== undefined) set('next_action_note', patch.nextActionNote);

    await client.query(`UPDATE applications SET ${sets.join(', ')} WHERE id = $1`, values);
    return (await getApplication(client, userId, id))!;
  });
}

export async function deleteApplication(db: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM applications WHERE id = $1 AND user_id = $2', [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

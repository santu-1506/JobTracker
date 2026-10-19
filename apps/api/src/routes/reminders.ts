import { ACTIVE_STAGES, PLAN_LIMITS, type ApplicationStage, type Reminder } from '@jobtracker/core';
import type { FastifyInstance } from 'fastify';
import { planRequired } from '../errors.js';
import { requireUser } from '../plugins/auth.js';

export async function reminderRoutes(app: FastifyInstance): Promise<void> {
  /** Polled by the extension's hourly alarm to raise desktop notifications. */
  app.get('/v1/reminders/due', { preHandler: requireUser }, async (request): Promise<{ reminders: Reminder[] }> => {
    const user = request.user!;
    if (!PLAN_LIMITS[user.plan].reminders) throw planRequired('Reminders');

    const { rows } = await app.db.query<{
      id: string;
      company: string;
      title: string;
      url: string | null;
      stage: ApplicationStage;
      next_action_at: Date;
      next_action_note: string | null;
    }>(
      `SELECT id, company, title, url, stage, next_action_at, next_action_note
         FROM applications
        WHERE user_id = $1 AND next_action_at <= now() AND stage = ANY($2::application_stage[])
        ORDER BY next_action_at
        LIMIT 50`,
      [user.id, ACTIVE_STAGES],
    );

    return {
      reminders: rows.map((row) => ({
        applicationId: row.id,
        company: row.company,
        title: row.title,
        url: row.url,
        stage: row.stage,
        dueAt: row.next_action_at.toISOString(),
        note: row.next_action_note ?? 'Follow up',
      })),
    };
  });
}

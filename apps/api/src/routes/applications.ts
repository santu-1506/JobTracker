import { APPLICATION_STAGES, type Application, type ApplicationDetail } from '@jobtracker/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, parseInput } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import {
  createApplication,
  deleteApplication,
  getApplicationDetail,
  listApplications,
  updateApplication,
} from '../services/applications.js';

const stage = z.enum(APPLICATION_STAGES);
const idParams = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  postingId: z.string().uuid().optional(),
  company: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  location: z.string().trim().max(200).nullish(),
  url: z.string().url().max(2048).nullish(),
  stage: stage.optional(),
  notes: z.string().max(5000).optional(),
});

const updateSchema = z
  .object({
    stage: stage.optional(),
    notes: z.string().max(5000).optional(),
    nextActionAt: z.string().datetime({ offset: true }).nullable().optional(),
    nextActionNote: z.string().max(200).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'nothing to update');

const listQuery = z.object({ stage: stage.optional() });

export async function applicationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/v1/applications', async (request): Promise<{ applications: Application[] }> => {
    const filter = parseInput(listQuery, request.query);
    return { applications: await listApplications(app.db, request.user!.id, filter) };
  });

  app.post('/v1/applications', async (request, reply) => {
    const input = parseInput(createSchema, request.body);
    const { application, created } = await createApplication(app.db, request.user!, input);
    return reply.code(created ? 201 : 200).send(application);
  });

  app.get('/v1/applications/:id', async (request): Promise<ApplicationDetail> => {
    const { id } = parseInput(idParams, request.params);
    const detail = await getApplicationDetail(app.db, request.user!.id, id);
    if (!detail) throw notFound('Application');
    return detail;
  });

  app.patch('/v1/applications/:id', async (request): Promise<Application> => {
    const { id } = parseInput(idParams, request.params);
    const patch = parseInput(updateSchema, request.body);
    return updateApplication(app.db, request.user!.id, id, patch);
  });

  app.delete('/v1/applications/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    if (!(await deleteApplication(app.db, request.user!.id, id))) throw notFound('Application');
    return reply.code(204).send();
  });
}

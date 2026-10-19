import { EVERGREEN_LABELS, JOB_SOURCES, type BadgeResponse, type ClusterHistory } from '@jobtracker/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, parseInput } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { getClusterHistory } from '../services/clusters.js';
import { ingestSighting } from '../services/ingest.js';

const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL');

export const sightingSchema = z.object({
  source: z.enum(JOB_SOURCES),
  sourceJobId: z.string().trim().min(1).max(200),
  url: httpUrl,
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(200),
  location: z.string().trim().max(200).nullish(),
  descriptionHash: z
    .string()
    .regex(/^[0-9a-f]{16}$/i, 'must be 16 hex characters')
    .nullish(),
  evergreenPhrases: z
    .array(z.string().refine((label) => EVERGREEN_LABELS.includes(label), 'unknown evergreen label'))
    .max(10)
    .optional(),
  postedAt: z.string().datetime({ offset: true }).nullish(),
  postedAtIsLowerBound: z.boolean().optional(),
  boardSaysReposted: z.boolean().optional(),
  closed: z.boolean().optional(),
  applicantCount: z.number().int().min(0).max(1_000_000).nullish(),
});

const uuidParams = z.object({ id: z.string().uuid() });

export async function sightingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/sightings', { preHandler: requireUser }, async (request): Promise<BadgeResponse> => {
    const input = parseInput(sightingSchema, request.body);
    const { badge } = await ingestSighting(app.db, request.user!.id, input);
    return badge;
  });

  app.get('/v1/clusters/:id', { preHandler: requireUser }, async (request): Promise<ClusterHistory> => {
    const { id } = parseInput(uuidParams, request.params);
    const history = await getClusterHistory(app.db, id);
    if (!history) throw notFound('Job');
    return history;
  });
}

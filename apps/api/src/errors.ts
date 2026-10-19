import type { ApiErrorCode } from '@jobtracker/core';
import type { ZodType, ZodTypeDef } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Missing or invalid API token') => new HttpError(401, 'unauthorized', message);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const planRequired = (feature: string) =>
  new HttpError(402, 'plan_required', `${feature} is part of JobTracker Pro`);
export const planLimit = (message: string) => new HttpError(402, 'plan_limit', message);

/** Validates untrusted input with zod and turns failures into a 400 with field-level details. */
export function parseInput<Output, Input>(schema: ZodType<Output, ZodTypeDef, Input>, data: unknown): Output {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw badRequest(
    'Request validation failed',
    result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

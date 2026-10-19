import { createHash, randomBytes } from 'node:crypto';
import type { Plan } from '@jobtracker/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export interface AuthUser {
  id: string;
  plan: Plan;
}

const TOKEN_PATTERN = /^jt_[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, prefixed so leaked tokens are easy to grep for. */
export function generateToken(): string {
  return `jt_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** preHandler for routes that need a signed-in install. */
export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!TOKEN_PATTERN.test(token)) throw unauthorized();

  const { rows } = await request.server.db.query<{ id: string; plan: Plan }>(
    `UPDATE users
        SET last_seen_at = now()
      WHERE token_hash = $1
      RETURNING id, plan`,
    [hashToken(token)],
  );
  const user = rows[0];
  if (!user) throw unauthorized();
  request.user = user;
}

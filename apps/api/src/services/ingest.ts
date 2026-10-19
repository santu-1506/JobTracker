import {
  findBestMatch,
  fingerprintPosting,
  simhashFromHex,
  simhashToSigned,
  type BadgeResponse,
  type PostingFingerprint,
  type SightingInput,
} from '@jobtracker/core';
import { withTransaction, type Pool, type PoolClient } from '../db/pool.js';
import { badRequest } from '../errors.js';
import {
  CLUSTER_COLUMNS,
  assessCluster,
  clusterFingerprint,
  clusterSources,
  saveAssessment,
  type ClusterRow,
} from './clusters.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Claimed posted dates older than this are treated as junk. */
const MAX_CLAIM_AGE_DAYS = 730;
/** A posted date that jumps forward this far... */
const REFRESH_MIN_JUMP_DAYS = 14;
/** ...and now looks this recent means the board bumped (reposted) the job. */
const REFRESH_MAX_AGE_DAYS = 7;
/** How far back to look for an existing cluster for a new posting. */
const CANDIDATE_WINDOW_DAYS = 365;
const CANDIDATE_LIMIT = 200;

export interface IngestOutcome {
  badge: BadgeResponse;
  clusterRow: ClusterRow;
  postingCreated: boolean;
  clusterCreated: boolean;
}

interface PostingRow {
  id: string;
  cluster_id: string;
  posted_at: Date | null;
}

export function sanitizeClaim(postedAt: string | null | undefined, now: Date): Date | null {
  if (!postedAt) return null;
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() > now.getTime() + DAY_MS) return null;
  if (now.getTime() - date.getTime() > MAX_CLAIM_AGE_DAYS * DAY_MS) return null;
  return date;
}

/**
 * Boards like LinkedIn "bump" old jobs to the top by resetting the posted
 * date. We count it as a repost when the claim jumps forward by two weeks
 * and now looks less than a week old. The two-week margin absorbs the
 * rounding in relative dates ("3 weeks ago" becoming "1 month ago").
 */
export function isRefresh(previous: Date | null, claimed: Date | null, now: Date): boolean {
  if (!previous || !claimed) return false;
  const jump = claimed.getTime() - previous.getTime();
  const age = now.getTime() - claimed.getTime();
  return jump >= REFRESH_MIN_JUMP_DAYS * DAY_MS && age <= REFRESH_MAX_AGE_DAYS * DAY_MS;
}

async function findPosting(client: PoolClient, source: string, sourceJobId: string): Promise<PostingRow | null> {
  const { rows } = await client.query<PostingRow>(
    `SELECT id, cluster_id, posted_at FROM postings
      WHERE source = $1 AND source_job_id = $2
      FOR UPDATE`,
    [source, sourceJobId],
  );
  return rows[0] ?? null;
}

async function findMatchingCluster(client: PoolClient, fingerprint: PostingFingerprint): Promise<string | null> {
  const { rows } = await client.query<
    Pick<ClusterRow, 'id' | 'company_key' | 'title_key' | 'location_key' | 'description_hash'>
  >(
    `SELECT id, company_key, title_key, location_key, description_hash
       FROM job_clusters
      WHERE company_key = $1
        AND last_seen_at > now() - make_interval(days => $2)
      ORDER BY last_seen_at DESC
      LIMIT $3`,
    [fingerprint.companyKey, CANDIDATE_WINDOW_DAYS, CANDIDATE_LIMIT],
  );
  return findBestMatch(fingerprint, rows.map(clusterFingerprint))?.candidate.id ?? null;
}

/**
 * Records that a user looked at a job page and returns the badge for it.
 *
 * Runs in one transaction:
 *  1. upsert the posting by (board, board job id);
 *  2. for a new posting, attach it to a matching cluster or start a new one
 *     (serialised per company with an advisory lock so two viewers of the
 *     same new job cannot create two clusters);
 *  3. record one sighting per user per day and one viewer per cluster;
 *  4. roll the observation up into the cluster and rescore it.
 */
export async function ingestSighting(
  pool: Pool,
  userId: string,
  input: SightingInput,
  now: Date = new Date(),
): Promise<IngestOutcome> {
  const descriptionHash = input.descriptionHash ? simhashFromHex(input.descriptionHash) : null;
  const fingerprint = fingerprintPosting({
    company: input.company,
    title: input.title,
    location: input.location,
    descriptionHash,
  });
  if (!fingerprint.companyKey || !fingerprint.titleKey) {
    throw badRequest('company and title must contain letters or digits');
  }
  const claimedPostedAt = sanitizeClaim(input.postedAt, now);
  const storedHash = descriptionHash === null ? null : simhashToSigned(descriptionHash).toString();
  const location = input.location?.trim() || null;

  return withTransaction(pool, async (client) => {
    let postingCreated = false;
    let clusterCreated = false;

    let posting = await findPosting(client, input.source, input.sourceJobId);
    if (!posting) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `cluster:${fingerprint.companyKey}`,
      ]);
      posting = await findPosting(client, input.source, input.sourceJobId);
    }

    if (posting) {
      const refreshed = isRefresh(posting.posted_at, claimedPostedAt, now);
      await client.query(
        `UPDATE postings
            SET last_seen_at = now(),
                url = $2, title = $3, location = $4,
                description_hash = COALESCE($5, description_hash),
                posted_at = GREATEST(posted_at, $6::timestamptz),
                refresh_count = refresh_count + $7
          WHERE id = $1`,
        [posting.id, input.url, input.title, location, storedHash, claimedPostedAt, refreshed ? 1 : 0],
      );
    } else {
      let clusterId = await findMatchingCluster(client, fingerprint);
      if (!clusterId) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO job_clusters (company, title, company_key, title_key, location_key, description_hash)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [input.company, input.title, fingerprint.companyKey, fingerprint.titleKey, fingerprint.locationKey, storedHash],
        );
        clusterId = created.rows[0]!.id;
        clusterCreated = true;
      }
      const inserted = await client.query<PostingRow>(
        `INSERT INTO postings (cluster_id, source, source_job_id, url, title, company, location, description_hash, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, cluster_id, posted_at`,
        [clusterId, input.source, input.sourceJobId, input.url, input.title, input.company, location, storedHash, claimedPostedAt],
      );
      posting = inserted.rows[0]!;
      postingCreated = true;
    }

    const sighting = await client.query(
      `INSERT INTO sightings (posting_id, user_id, claimed_posted_at, board_says_reposted, applicant_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [posting.id, userId, claimedPostedAt, input.boardSaysReposted ?? false, input.applicantCount ?? null],
    );
    const viewer = await client.query(
      'INSERT INTO cluster_viewers (cluster_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [posting.cluster_id, userId],
    );

    const { rows } = await client.query<ClusterRow>(
      `UPDATE job_clusters c
          SET last_seen_at        = now(),
              description_hash    = COALESCE($2, c.description_hash),
              earliest_posted_at  = LEAST(c.earliest_posted_at, $3::timestamptz),
              latest_posted_at    = GREATEST(c.latest_posted_at, $3::timestamptz),
              board_says_reposted = c.board_says_reposted OR $4,
              closed              = $5,
              applicant_count     = COALESCE($6, c.applicant_count),
              evergreen_phrases   = CASE WHEN cardinality($7::text[]) > 0 THEN $7::text[] ELSE c.evergreen_phrases END,
              sighting_count      = c.sighting_count + $8,
              viewer_count        = c.viewer_count + $9,
              repost_count        = (
                SELECT (count(*) - count(DISTINCT p.source))::int + COALESCE(sum(p.refresh_count), 0)::int
                  FROM postings p WHERE p.cluster_id = c.id
              )
        WHERE c.id = $1
        RETURNING ${CLUSTER_COLUMNS}`,
      [
        posting.cluster_id,
        storedHash,
        claimedPostedAt,
        input.boardSaysReposted ?? false,
        input.closed ?? false,
        input.applicantCount ?? null,
        input.evergreenPhrases ?? [],
        sighting.rowCount ?? 0,
        viewer.rowCount ?? 0,
      ],
    );
    const clusterRow = rows[0]!;
    const assessment = assessCluster(clusterRow, now);
    await saveAssessment(client, clusterRow.id, assessment);

    const badge: BadgeResponse = {
      postingId: posting.id,
      clusterId: clusterRow.id,
      assessment,
      firstSeenAt: clusterRow.first_seen_at.toISOString(),
      sources: await clusterSources(client, clusterRow.id),
      viewerCount: clusterRow.viewer_count,
      application: null,
    };
    return { badge, clusterRow, postingCreated, clusterCreated };
  });
}

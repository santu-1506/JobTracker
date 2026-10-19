import {
  assessPosting,
  simhashFromSigned,
  type ClusterHistory,
  type GhostAssessment,
  type JobSource,
  type PostingFingerprint,
} from '@jobtracker/core';
import type { Queryable } from '../db/pool.js';

export interface ClusterRow {
  id: string;
  company: string;
  title: string;
  company_key: string;
  title_key: string;
  location_key: string;
  description_hash: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  earliest_posted_at: Date | null;
  latest_posted_at: Date | null;
  repost_count: number;
  viewer_count: number;
  sighting_count: number;
  board_says_reposted: boolean;
  closed: boolean;
  applicant_count: number | null;
  evergreen_phrases: string[];
}

export const CLUSTER_COLUMNS = `
  id, company, title, company_key, title_key, location_key, description_hash,
  first_seen_at, last_seen_at, earliest_posted_at, latest_posted_at,
  repost_count, viewer_count, sighting_count, board_says_reposted, closed,
  applicant_count, evergreen_phrases`;

export function assessCluster(row: ClusterRow, now: Date = new Date()): GhostAssessment {
  return assessPosting(
    {
      firstSeenAt: row.first_seen_at,
      earliestPostedAt: row.earliest_posted_at,
      latestPostedAt: row.latest_posted_at,
      repostCount: row.repost_count,
      viewerCount: row.viewer_count,
      sightingCount: row.sighting_count,
      boardSaysReposted: row.board_says_reposted,
      closed: row.closed,
      applicantCount: row.applicant_count,
      evergreenPhrases: row.evergreen_phrases,
    },
    now,
  );
}

export function clusterFingerprint(row: Pick<ClusterRow, 'id' | 'company_key' | 'title_key' | 'location_key' | 'description_hash'>): PostingFingerprint & { id: string } {
  return {
    id: row.id,
    companyKey: row.company_key,
    titleKey: row.title_key,
    locationKey: row.location_key,
    descriptionHash: row.description_hash === null ? null : simhashFromSigned(row.description_hash),
  };
}

export async function saveAssessment(db: Queryable, clusterId: string, assessment: GhostAssessment): Promise<void> {
  await db.query(
    'UPDATE job_clusters SET ghost_score = $2, ghost_level = $3, ghost_label = $4, scored_at = now() WHERE id = $1',
    [clusterId, assessment.score, assessment.level, assessment.label],
  );
}

export async function clusterSources(db: Queryable, clusterId: string): Promise<JobSource[]> {
  const { rows } = await db.query<{ sources: JobSource[] }>(
    'SELECT array_agg(DISTINCT source ORDER BY source) AS sources FROM postings WHERE cluster_id = $1',
    [clusterId],
  );
  return rows[0]?.sources ?? [];
}

export async function getClusterHistory(db: Queryable, clusterId: string): Promise<ClusterHistory | null> {
  const { rows } = await db.query<ClusterRow>(`SELECT ${CLUSTER_COLUMNS} FROM job_clusters WHERE id = $1`, [clusterId]);
  const cluster = rows[0];
  if (!cluster) return null;

  const postings = await db.query<{
    id: string;
    source: JobSource;
    url: string;
    first_seen_at: Date;
    last_seen_at: Date;
    posted_at: Date | null;
  }>(
    `SELECT id, source, url, first_seen_at, last_seen_at, posted_at
       FROM postings WHERE cluster_id = $1 ORDER BY first_seen_at`,
    [clusterId],
  );

  const timeline = await db.query<{ day: string; viewers: number }>(
    `SELECT to_char(s.seen_on, 'YYYY-MM-DD') AS day, count(DISTINCT s.user_id)::int AS viewers
       FROM sightings s JOIN postings p ON p.id = s.posting_id
      WHERE p.cluster_id = $1
      GROUP BY s.seen_on ORDER BY s.seen_on`,
    [clusterId],
  );

  return {
    clusterId: cluster.id,
    company: cluster.company,
    title: cluster.title,
    assessment: assessCluster(cluster),
    postings: postings.rows.map((p) => ({
      id: p.id,
      source: p.source,
      url: p.url,
      firstSeenAt: p.first_seen_at.toISOString(),
      lastSeenAt: p.last_seen_at.toISOString(),
      postedAt: p.posted_at?.toISOString() ?? null,
    })),
    timeline: timeline.rows,
  };
}

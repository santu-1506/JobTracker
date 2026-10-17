import { isBroadLocation, normalizeCompany, normalizeLocation, normalizeTitle, tokenJaccard } from './normalize.js';
import { DIFFERENT_DESCRIPTION_BITS, NEAR_DUPLICATE_BITS, hammingDistance } from './simhash.js';

/**
 * Decides whether two postings describe the same job.
 *
 * Company is a hard block (the API only compares postings that share a
 * company key). Inside a company, title, location and description
 * fingerprints must agree. A vague location such as "Remote" or "India" is
 * only accepted when the descriptions are near-identical, because large
 * companies post many identically titled roles.
 */

export interface PostingFingerprint {
  companyKey: string;
  titleKey: string;
  locationKey: string;
  descriptionHash: bigint | null;
}

export interface FingerprintInput {
  company: string;
  title: string;
  location?: string | null;
  descriptionHash?: bigint | null;
}

export function fingerprintPosting(input: FingerprintInput): PostingFingerprint {
  return {
    companyKey: normalizeCompany(input.company),
    titleKey: normalizeTitle(input.title, input.location),
    locationKey: normalizeLocation(input.location),
    descriptionHash: input.descriptionHash ?? null,
  };
}

export type LocationMatch = 'same' | 'compatible' | 'different';

export function compareLocations(a: string, b: string): LocationMatch {
  if (a !== '' && a === b) return 'same';
  if (isBroadLocation(a) || isBroadLocation(b)) return 'compatible';
  return 'different';
}

export interface MatchResult {
  isMatch: boolean;
  /** 0..1, used to pick the best of several candidate clusters. */
  confidence: number;
  reason: string;
}

const noMatch = (reason: string): MatchResult => ({ isMatch: false, confidence: 0, reason });
const match = (confidence: number, reason: string): MatchResult => ({ isMatch: true, confidence, reason });

export function matchPostings(a: PostingFingerprint, b: PostingFingerprint): MatchResult {
  if (!a.companyKey || a.companyKey !== b.companyKey) return noMatch('different company');

  const location = compareLocations(a.locationKey, b.locationKey);
  if (location === 'different') return noMatch('different location');

  const distance =
    a.descriptionHash !== null && b.descriptionHash !== null
      ? hammingDistance(a.descriptionHash, b.descriptionHash)
      : null;
  if (distance !== null && distance > DIFFERENT_DESCRIPTION_BITS) return noMatch('descriptions differ');
  const nearDuplicate = distance !== null && distance <= NEAR_DUPLICATE_BITS;

  const titleSimilarity = tokenJaccard(a.titleKey, b.titleKey);
  if (titleSimilarity === 1) {
    if (location === 'same') {
      const confidence = distance === null ? 0.8 : nearDuplicate ? 0.98 : 0.85;
      return match(confidence, 'same title and location');
    }
    if (nearDuplicate) return match(0.9, 'same title and near-identical description');
    return noMatch('location too vague to confirm without a matching description');
  }

  if (titleSimilarity >= 0.75 && nearDuplicate) {
    return match(0.85, 'reworded title with near-identical description');
  }
  return noMatch('different title');
}

/** Picks the most confident match among candidates, or null if none match. */
export function findBestMatch<T extends PostingFingerprint>(
  target: PostingFingerprint,
  candidates: readonly T[],
): { candidate: T; result: MatchResult } | null {
  let best: { candidate: T; result: MatchResult } | null = null;
  for (const candidate of candidates) {
    const result = matchPostings(target, candidate);
    if (result.isMatch && (!best || result.confidence > best.result.confidence)) {
      best = { candidate, result };
    }
  }
  return best;
}

import { foldText } from './normalize.js';

/**
 * 64-bit SimHash over word 2-shingles (bigrams).
 *
 * Two descriptions that differ by a few edited sentences land within a small
 * Hamming distance of each other, while unrelated descriptions sit around 32
 * bits apart. The extension computes this locally, so the API stores a
 * fingerprint instead of the full job description.
 */

export const SIMHASH_VERSION = 1;

/** Below this many words a fingerprint is too noisy to be useful. */
const MIN_WORDS = 15;
const SHINGLE_SIZE = 2;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'this',
  'to',
  'we',
  'will',
  'with',
  'you',
  'your',
]);

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** MurmurHash3 finaliser: spreads FNV output so every bit is equally likely. */
function fmix32(value: number): number {
  let h = value;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function descriptionTokens(text: string): string[] {
  return foldText(text)
    .split(' ')
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

export function simhash64(text: string | null | undefined): bigint | null {
  if (!text) return null;
  const words = descriptionTokens(text);
  if (words.length < MIN_WORDS) return null;

  const weights = new Int32Array(64);
  const shingleCount = words.length - SHINGLE_SIZE + 1;
  for (let i = 0; i < shingleCount; i += 1) {
    const shingle = words.slice(i, i + SHINGLE_SIZE).join(' ');
    const low = fmix32(fnv1a32(shingle, 0x811c9dc5));
    const high = fmix32(fnv1a32(shingle, 0x9e3779b9));
    for (let bit = 0; bit < 32; bit += 1) {
      weights[bit]! += (low >>> bit) & 1 ? 1 : -1;
      weights[bit + 32]! += (high >>> bit) & 1 ? 1 : -1;
    }
  }

  let low = 0;
  let high = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (weights[bit]! > 0) low |= 1 << bit;
    if (weights[bit + 32]! > 0) high |= 1 << bit;
  }
  return (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

/** 16 lowercase hex characters, the wire format used by the API. */
export function simhashToHex(hash: bigint): string {
  return BigInt.asUintN(64, hash).toString(16).padStart(16, '0');
}

export function simhashFromHex(hex: string): bigint {
  if (!/^[0-9a-f]{16}$/i.test(hex)) throw new Error(`Invalid simhash: ${hex}`);
  return BigInt(`0x${hex}`);
}

/** Postgres `bigint` is signed; store the same 64 bits as a signed value. */
export function simhashToSigned(hash: bigint): bigint {
  return BigInt.asIntN(64, hash);
}

export function simhashFromSigned(value: bigint | string): bigint {
  return BigInt.asUintN(64, BigInt(value));
}

/**
 * Distance thresholds, tuned on synthetic edits: a 5% word edit of a
 * 300-word description lands at a median of 7 bits (p90 11) with bigram
 * shingles, while unrelated descriptions sit near 30 bits.
 */
export const NEAR_DUPLICATE_BITS = 8;
export const DIFFERENT_DESCRIPTION_BITS = 18;

import { describe, expect, it } from 'vitest';
import {
  DIFFERENT_DESCRIPTION_BITS,
  NEAR_DUPLICATE_BITS,
  hammingDistance,
  simhash64,
  simhashFromHex,
  simhashFromSigned,
  simhashToHex,
  simhashToSigned,
} from '../src/simhash.js';

const ORIGINAL = `We are looking for a Senior Backend Engineer to join the Payments team.
You will design and build reliable APIs in Go and PostgreSQL that move money for millions
of customers, own services end to end, mentor engineers, and work closely with product and
risk partners. Requirements: five years building distributed systems, strong SQL, experience
with event driven architectures, observability and on call. Nice to have: Kafka, Kubernetes,
experience in fintech or regulated environments. Benefits include equity, health cover and
a generous learning budget.

About the team: Payments processes card, bank transfer and wallet transactions in more than forty
countries. The team owns ledgers, reconciliation, payouts and the public payments API used by
thousands of merchants. We care about correctness first, then latency, then cost, and we write
design documents before we write code. Engineers rotate through on call once every six weeks and
every incident gets a blameless review with clear follow up actions.

How we work: small autonomous squads, weekly demos, quarterly planning with product and finance,
pairing on hard problems, and a strong code review culture. We hire for curiosity and ownership
and we support engineers who want to grow into staff or management roles over time.

Our interview process has a recruiter call, a technical screen focused on API design, a system
design conversation about money movement and a values interview with the hiring manager.`;

const LIGHTLY_EDITED = ORIGINAL.replace('five years', 'six years').replace(
  'a generous learning budget',
  'an annual learning budget and remote working stipend',
);

const UNRELATED = `Join our retail store team as a Sales Associate. You will greet customers, keep
shelves stocked, operate the till and help shoppers find the right products. We value a friendly
attitude, flexible weekend availability and a passion for fashion. Previous retail experience is
helpful but not required, full training provided, staff discount and paid holidays.`;

describe('simhash64', () => {
  it('is deterministic', () => {
    expect(simhash64(ORIGINAL)).toBe(simhash64(ORIGINAL));
  });

  it('returns null for text too short to fingerprint', () => {
    expect(simhash64('Apply now')).toBeNull();
    expect(simhash64('')).toBeNull();
    expect(simhash64(null)).toBeNull();
  });

  it('ignores case, punctuation and whitespace', () => {
    const shouty = ORIGINAL.toUpperCase().replace(/\s+/g, '   ').replace(/\./g, '!');
    expect(hammingDistance(simhash64(ORIGINAL)!, simhash64(shouty)!)).toBe(0);
  });

  it('keeps lightly edited descriptions close', () => {
    const distance = hammingDistance(simhash64(ORIGINAL)!, simhash64(LIGHTLY_EDITED)!);
    expect(distance).toBeLessThanOrEqual(NEAR_DUPLICATE_BITS);
  });

  it('pushes unrelated descriptions far apart', () => {
    const distance = hammingDistance(simhash64(ORIGINAL)!, simhash64(UNRELATED)!);
    expect(distance).toBeGreaterThan(DIFFERENT_DESCRIPTION_BITS);
  });
});

describe('encoding helpers', () => {
  const hash = simhash64(ORIGINAL)!;

  it('round-trips through hex', () => {
    const hex = simhashToHex(hash);
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
    expect(simhashFromHex(hex)).toBe(hash);
  });

  it('round-trips through a signed Postgres bigint', () => {
    const big = 0xffff_ffff_ffff_fff0n;
    const signed = simhashToSigned(big);
    expect(signed).toBeLessThan(0n);
    expect(simhashFromSigned(signed.toString())).toBe(big);
  });

  it('rejects malformed hex', () => {
    expect(() => simhashFromHex('xyz')).toThrow();
  });

  it('counts differing bits', () => {
    expect(hammingDistance(0b1011n, 0b0001n)).toBe(2);
    expect(hammingDistance(0n, (1n << 64n) - 1n)).toBe(64);
  });
});

import { describe, expect, it } from 'vitest';
import { compareLocations, findBestMatch, fingerprintPosting, matchPostings } from '../src/matcher.js';
import { simhash64 } from '../src/simhash.js';

const DESCRIPTION = `Acme is hiring a Senior Backend Engineer for the Payments platform. You will build
reliable services in Go and PostgreSQL, design public APIs used by thousands of merchants, improve
observability, review code, mentor engineers and take part in a humane on call rotation. You have
five or more years building distributed systems, strong SQL skills and experience with queues such
as Kafka or SQS. We offer equity, private health cover, a learning budget and flexible hours.`;

const REWORDED = DESCRIPTION.replace('a learning budget', 'an annual learning budget').replace(
  'flexible hours',
  'flexible working hours',
);

const OTHER_ROLE = `Acme is hiring a Product Designer to own the merchant dashboard experience. You will
run discovery interviews, prototype in Figma, partner with engineers on delivery, and grow our design
system. You have a portfolio showing end to end product work, strong interaction design craft and
comfort presenting to executives. We offer equity, private health cover and a learning budget.`;

const linkedin = fingerprintPosting({
  company: 'Acme, Inc.',
  title: 'Sr. Backend Engineer',
  location: 'Bengaluru, Karnataka, India',
  descriptionHash: simhash64(DESCRIPTION),
});

describe('matchPostings', () => {
  it('matches the same job across boards despite formatting differences', () => {
    const greenhouse = fingerprintPosting({
      company: 'Acme',
      title: 'Senior Backend Engineer (Hybrid)',
      location: 'Bangalore',
      descriptionHash: simhash64(REWORDED),
    });
    const result = matchPostings(linkedin, greenhouse);
    expect(result.isMatch).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('matches on title and location when one side has no description', () => {
    const workday = fingerprintPosting({ company: 'ACME LLC', title: 'Senior Backend Engineer', location: 'Bangalore' });
    expect(matchPostings(linkedin, workday)).toMatchObject({ isMatch: true, confidence: 0.8 });
  });

  it('never matches across companies', () => {
    const other = { ...linkedin, companyKey: 'globex' };
    expect(matchPostings(linkedin, other)).toMatchObject({ isMatch: false, reason: 'different company' });
  });

  it('keeps the same title in different cities apart', () => {
    const london = fingerprintPosting({ company: 'Acme', title: 'Senior Backend Engineer', location: 'London, UK' });
    expect(matchPostings(linkedin, london).reason).toBe('different location');
  });

  it('keeps identically titled roles with different descriptions apart', () => {
    const designerText = fingerprintPosting({
      company: 'Acme',
      title: 'Senior Backend Engineer',
      location: 'Bengaluru',
      descriptionHash: simhash64(OTHER_ROLE),
    });
    expect(matchPostings(linkedin, designerText).reason).toBe('descriptions differ');
  });

  it('requires a description match when the location is vague', () => {
    const remoteNoDescription = fingerprintPosting({ company: 'Acme', title: 'Senior Backend Engineer', location: 'India' });
    expect(matchPostings(linkedin, remoteNoDescription).isMatch).toBe(false);

    const remoteSameDescription = { ...remoteNoDescription, descriptionHash: simhash64(DESCRIPTION) };
    expect(matchPostings(linkedin, remoteSameDescription).isMatch).toBe(true);
  });

  it('accepts a reworded title when the description is near-identical', () => {
    const reworded = fingerprintPosting({
      company: 'Acme',
      title: 'Senior Backend Engineer, Payments Platform',
      location: 'Bengaluru',
      descriptionHash: simhash64(REWORDED),
    });
    expect(matchPostings(linkedin, reworded).isMatch).toBe(false);

    const lightlyReworded = fingerprintPosting({
      company: 'Acme',
      title: 'Senior Backend Engineer Payments',
      location: 'Bengaluru',
      descriptionHash: simhash64(REWORDED),
    });
    expect(matchPostings(linkedin, lightlyReworded)).toMatchObject({
      isMatch: true,
      reason: 'reworded title with near-identical description',
    });
  });
});

describe('compareLocations', () => {
  it('distinguishes same, compatible and different', () => {
    expect(compareLocations('london', 'london')).toBe('same');
    expect(compareLocations('', '')).toBe('compatible');
    expect(compareLocations('remote', 'london')).toBe('compatible');
    expect(compareLocations('paris', 'london')).toBe('different');
  });
});

describe('findBestMatch', () => {
  it('returns the highest-confidence candidate', () => {
    const weak = { id: 'a', ...fingerprintPosting({ company: 'Acme', title: 'Senior Backend Engineer', location: 'Bengaluru' }) };
    const strong = {
      id: 'b',
      ...fingerprintPosting({
        company: 'Acme',
        title: 'Senior Backend Engineer',
        location: 'Bengaluru',
        descriptionHash: simhash64(DESCRIPTION),
      }),
    };
    expect(findBestMatch(linkedin, [weak, strong])?.candidate.id).toBe('b');
    expect(findBestMatch(linkedin, [])).toBeNull();
  });
});

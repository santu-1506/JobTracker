import { describe, expect, it } from 'vitest';
import {
  foldText,
  isBroadLocation,
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
  tokenJaccard,
} from '../src/normalize.js';

describe('foldText', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(foldText('  Café — Zürich!  ')).toBe('cafe zurich');
  });

  it('keeps language names like C++ and C#', () => {
    expect(foldText('C++/C# Developer')).toBe('c++ c# developer');
  });
});

describe('normalizeCompany', () => {
  it.each([
    ['Stripe, Inc.', 'stripe'],
    ['The Coca-Cola Company', 'coca cola'],
    ['Tata Consultancy Services Pvt. Ltd.', 'tata consultancy services'],
    ['Hudson & Co.', 'hudson'],
    ['NVIDIA', 'nvidia'],
    ['Co', 'co'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['Sr. Software Eng (Remote)', 'senior software engineer'],
    ['Senior Software Engineer', 'senior software engineer'],
    ['Software Engineer II', 'software engineer 2'],
    ['Software Engineer I', 'software engineer 1'],
    ['Front-End Developer', 'frontend developer'],
    ['Full Stack Engineer [Hybrid]', 'fullstack engineer'],
    ['Backend Engineer (m/f/d)', 'backend engineer'],
    ['Data Engineer - R12345', 'data engineer'],
    ['Software Engineer (Payments)', 'software engineer payments'],
    ['SWE Intern', 'software engineer intern'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('drops a trailing location segment when it matches the location hint', () => {
    expect(normalizeTitle('Senior Software Engineer - Bangalore', 'Bengaluru, Karnataka, India')).toBe(
      'senior software engineer',
    );
    expect(normalizeTitle('Platform Engineer | New York', 'New York, NY')).toBe('platform engineer');
  });

  it('keeps a trailing team segment that is not a location', () => {
    expect(normalizeTitle('Software Engineer, Backend', 'London')).toBe('software engineer backend');
  });
});

describe('normalizeLocation', () => {
  it.each([
    ['San Francisco, CA, United States', 'san francisco'],
    ['Bangalore, Karnataka, India', 'bengaluru'],
    ['Remote - US', 'remote'],
    ['United States (Remote)', 'remote'],
    ['India', 'india'],
    ['Hybrid - New York, NY', 'new york'],
    ['New York City, NY (Hybrid)', 'new york'],
    ['3 Locations', ''],
    ['', ''],
    [null, ''],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeLocation(input)).toBe(expected);
  });

  it('treats countries, remote and unknown as broad', () => {
    expect(isBroadLocation('remote')).toBe(true);
    expect(isBroadLocation('india')).toBe(true);
    expect(isBroadLocation('')).toBe(true);
    expect(isBroadLocation('bengaluru')).toBe(false);
  });
});

describe('tokenJaccard', () => {
  it('ignores token order', () => {
    expect(tokenJaccard('senior backend software engineer', 'senior software engineer backend')).toBe(1);
  });

  it('scores partial overlap', () => {
    expect(tokenJaccard('software engineer', 'software engineer backend')).toBeCloseTo(2 / 3);
  });
});

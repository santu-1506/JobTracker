/**
 * Text normalisation used to recognise the same job across boards and reposts.
 *
 * The extension and the API both import this module, so a posting seen on
 * LinkedIn and the same posting seen on Greenhouse produce identical keys no
 * matter which side computed them.
 */

const COMPANY_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'lp',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'plc',
  'pvt',
  'private',
  'pte',
  'pty',
  'ag',
  'sa',
  'sas',
  'bv',
  'nv',
  'oy',
  'ab',
  'srl',
  'kk',
]);

const TITLE_ABBREVIATIONS: Record<string, string> = {
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  jnr: 'junior',
  swe: 'software engineer',
  sde: 'software development engineer',
  eng: 'engineer',
  engr: 'engineer',
  dev: 'developer',
  mgr: 'manager',
  mngr: 'manager',
  assoc: 'associate',
  ml: 'machine learning',
  ii: '2',
  iii: '3',
  iv: '4',
};

const TITLE_PHRASES: Array<[RegExp, string]> = [
  [/\bfront ?end\b/g, 'frontend'],
  [/\bback ?end\b/g, 'backend'],
  [/\bfull ?stack\b/g, 'fullstack'],
  [/\bdev ?ops\b/g, 'devops'],
  [/\b(?:m f d|f m d|m w d|w m d|h f|f h)\b/g, ' '],
  [/\ball genders\b/g, ' '],
];

/** Work-mode words that boards append to titles but that do not change the role. */
const TITLE_NOISE = new Set(['remote', 'hybrid', 'onsite']);

const NOISE_SEGMENT =
  /^\s*(?:remote|hybrid|on[\s-]?site|m\/?f\/?d|f\/?m\/?d|w\/?m\/?d|m\/?w\/?d|h\/?f|all genders|full[\s-]?time|part[\s-]?time|permanent)\b.*$/i;

const REQUISITION_ID = /\b(?:JR|R|REQ|REQ-ID|ID)[-_#: ]?\d{3,}\b/gi;

const LOCATION_ALIASES: Record<string, string> = {
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  gurgaon: 'gurugram',
  madras: 'chennai',
  calcutta: 'kolkata',
  'new delhi': 'delhi',
  nyc: 'new york',
  'new york city': 'new york',
  sf: 'san francisco',
  'sf bay area': 'san francisco',
  'san francisco bay area': 'san francisco',
  'greater london': 'london',
  'greater seattle area': 'seattle',
};

const COUNTRIES = new Set([
  'united states',
  'united states of america',
  'usa',
  'us',
  'india',
  'united kingdom',
  'uk',
  'canada',
  'germany',
  'france',
  'netherlands',
  'ireland',
  'spain',
  'poland',
  'singapore',
  'australia',
  'japan',
  'brazil',
  'mexico',
  'israel',
]);

const REMOTE_WORDS = /\b(?:remote|anywhere|work from home|wfh|distributed)\b/;

/** Lowercase, strip accents and punctuation, collapse whitespace. Keeps `+` and `#` for C++ and C#. */
export function foldText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** "The Coca-Cola Company" and "Coca Cola Co." both become "coca cola". */
export function normalizeCompany(name: string): string {
  const tokens = foldText(name).split(' ').filter(Boolean);
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift();
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (!COMPANY_SUFFIXES.has(last) && last !== 'and') break;
    tokens.pop();
  }
  return tokens.join(' ');
}

/**
 * Canonical location key: the primary city, "remote", a country, or "" when
 * the board only says something like "3 Locations".
 */
export function normalizeLocation(location: string | null | undefined): string {
  if (!location) return '';
  const folded = foldText(location);
  if (!folded) return '';
  if (/^\d+ locations?$|^multiple locations?$|^various/.test(folded)) return '';

  const cleaned = location.replace(/\b(?:hybrid|on[\s-]?site|in[\s-]office)\b/gi, ' ').replace(/[()]/g, ' ');
  const segments = cleaned
    .split(/[,;/|]|\s[-–]\s/)
    .map((segment) => foldText(segment))
    .filter(Boolean);
  const city = segments[0] ?? '';

  if (REMOTE_WORDS.test(city) || (!city && REMOTE_WORDS.test(folded))) return 'remote';
  if (!city) return '';
  return LOCATION_ALIASES[city] ?? city;
}

/** Countries and "remote" are broad: they can describe the same job as a specific city. */
export function isBroadLocation(locationKey: string): boolean {
  return locationKey === '' || locationKey === 'remote' || COUNTRIES.has(locationKey);
}

/**
 * Canonical title key. Expands common abbreviations, drops work-mode and
 * gender markers, requisition ids and a trailing location segment.
 *
 *   "Sr. Software Eng (Remote)"            -> "senior software engineer"
 *   "Senior Software Engineer - Bangalore" -> "senior software engineer" (with location hint)
 */
export function normalizeTitle(title: string, locationHint?: string | null): string {
  let text = title.replace(REQUISITION_ID, ' ');

  text = text.replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (whole, round?: string, square?: string) => {
    const inner = (round ?? square ?? '').trim();
    return NOISE_SEGMENT.test(inner) ? ' ' : ` ${inner} `;
  });

  const segments = text.split(/\s+[-|–—]\s+|,\s+/);
  if (segments.length > 1) {
    const locationTokens = new Set(foldText(locationHint ?? '').split(' ').filter(Boolean));
    for (const alias of Object.keys(LOCATION_ALIASES)) {
      if (locationTokens.has(LOCATION_ALIASES[alias]!)) alias.split(' ').forEach((t) => locationTokens.add(t));
    }
    while (segments.length > 1) {
      const last = segments[segments.length - 1]!;
      const tokens = foldText(last).split(' ').filter(Boolean);
      const isLocation = tokens.length > 0 && tokens.every((t) => locationTokens.has(t));
      if (!isLocation && !NOISE_SEGMENT.test(last)) break;
      segments.pop();
    }
  }

  let folded = foldText(segments.join(' '));
  for (const [pattern, replacement] of TITLE_PHRASES) folded = folded.replace(pattern, replacement);

  const tokens = folded.split(' ').filter(Boolean);
  const expanded: string[] = [];
  tokens.forEach((token, index) => {
    if (token === 'i' && index === tokens.length - 1 && index > 0) {
      expanded.push('1');
      return;
    }
    expanded.push(...(TITLE_ABBREVIATIONS[token] ?? token).split(' '));
  });

  const meaningful = expanded.filter((t) => !TITLE_NOISE.has(t));
  return (meaningful.length > 0 ? meaningful : expanded).join(' ');
}

/** Jaccard similarity of the token sets of two normalised strings. */
export function tokenJaccard(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Pure identity and dedupe normalization (issue 002). No database access.
 *
 * Identity keys:
 * - employer-owned application site: the normalized registrable domain, e.g. `acme.example`
 * - shared ATS host: `provider:slug`, e.g. `greenhouse:acme`, `lever:acme-corp`
 * Keys with a colon are ATS keys; keys without one are domain keys.
 */

export type AtsProvider = 'greenhouse' | 'lever' | 'ashby';
export interface IdentityKey {
  key: string;
  kind: 'domain' | 'ats';
}

/** Second-level public suffixes we see in practice; enough to avoid keying on `co.uk`. */
const multiPartSuffixes = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'co.in',
  'com.br',
  'com.mx',
  'co.za',
  'com.sg',
  'com.cn',
  'com.hk',
  'co.il',
  'co.kr',
]);

/**
 * Hosts that never identify an employer: discovery boards and aggregators, plus shared
 * application hosts outside the pilot's three ATS providers (no stable employer slug parsing).
 */
const nonEmployerDomains = new Set([
  'linkedin.com',
  'indeed.com',
  'ziprecruiter.com',
  'glassdoor.com',
  'google.com',
  'monster.com',
  'simplyhired.com',
  'wellfound.com',
  'angel.co',
  'builtin.com',
  'dice.com',
  'joinhandshake.com',
  'ycombinator.com',
  'workatastartup.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'workable.com',
  'smartrecruiters.com',
  'icims.com',
  'jobvite.com',
  'bamboohr.com',
  'recruitee.com',
  'breezy.hr',
  'applytojob.com',
  'taleo.net',
  'successfactors.com',
]);

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** Lowercase host without `www.`/trailing dot reduced to its registrable domain. */
export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;
  if (host.includes('://')) {
    const url = parseUrl(host);
    if (!url) return null;
    host = url.hostname;
  }
  host = host.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (multiPartSuffixes.has(lastTwo))
    return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  return lastTwo;
}

export function isEmployerDomain(domain: string): boolean {
  return !nonEmployerDomains.has(domain);
}

const slugPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
function cleanSlug(value: string | null | undefined): string | null {
  const slug = (value ?? '').trim().toLowerCase();
  return slugPattern.test(slug) ? slug : null;
}

export interface AtsPosting {
  provider: AtsProvider;
  slug: string;
  postingId: string | null;
  embed: boolean;
}
/** Recognizes Greenhouse, Lever and Ashby board/application URLs. */
export function parseAtsUrl(value: string): AtsPosting | null {
  const url = parseUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    host === 'boards.greenhouse.io' ||
    host === 'job-boards.greenhouse.io' ||
    host === 'job-boards.eu.greenhouse.io' ||
    host === 'boards.eu.greenhouse.io'
  ) {
    if (parts[0] === 'embed') {
      const slug = cleanSlug(url.searchParams.get('for'));
      if (!slug) return null;
      const token = url.searchParams.get('token');
      return {
        provider: 'greenhouse',
        slug,
        postingId: token && /^\d+$/.test(token) ? token : null,
        embed: true,
      };
    }
    const slug = cleanSlug(parts[0]);
    if (!slug) return null;
    const jobIndex = parts.indexOf('jobs');
    const postingId =
      jobIndex >= 0 && /^\d+$/.test(parts[jobIndex + 1] ?? '')
        ? parts[jobIndex + 1]
        : null;
    return { provider: 'greenhouse', slug, postingId, embed: false };
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const slug = cleanSlug(parts[0]);
    if (!slug) return null;
    const id = parts[1] ?? '';
    return {
      provider: 'lever',
      slug,
      postingId: /^[0-9a-f-]{8,}$/i.test(id) ? id.toLowerCase() : null,
      embed: false,
    };
  }
  if (host === 'jobs.ashbyhq.com') {
    const slug = cleanSlug(decodeURIComponent(parts[0] ?? ''));
    if (!slug) return null;
    const id = parts[1] ?? '';
    return {
      provider: 'ashby',
      slug,
      postingId: /^[0-9a-f-]{8,}$/i.test(id) ? id.toLowerCase() : null,
      embed: false,
    };
  }
  return null;
}

/** The identity key a single URL proves, or null for aggregators/unknown shared hosts. */
export function identityKeyFromUrl(value: string): IdentityKey | null {
  const ats = parseAtsUrl(value);
  if (ats) return { key: `${ats.provider}:${ats.slug}`, kind: 'ats' };
  const url = parseUrl(value);
  if (!url) return null;
  const domain = normalizeDomain(url.hostname);
  if (!domain || !isEmployerDomain(domain)) return null;
  return { key: domain, kind: 'domain' };
}

const atsKeyPattern = /^(greenhouse|lever|ashby):[a-z0-9][a-z0-9._-]{0,99}$/;
/** Validates an alias key typed into the dashboard; returns its canonical form. */
export function parseIdentityKey(input: string): IdentityKey | null {
  const value = input.trim().toLowerCase();
  if (value.includes(':'))
    return atsKeyPattern.test(value) ? { key: value, kind: 'ats' } : null;
  const domain = normalizeDomain(value);
  return domain && isEmployerDomain(domain)
    ? { key: domain, kind: 'domain' }
    : null;
}

const careersHint =
  /(^|[./_-])(careers?|jobs?|join|joinus|join-us|opportunit(y|ies)|openings|positions|work-with-us|workwithus)([./_-]|$)/i;
/**
 * An employer-owned careers page that redirects to or embeds an ATS board: discovery URL on an
 * employer domain with careers evidence (path/subdomain or an ATS job parameter), application on
 * a recognized ATS board.
 */
export interface CareersLink {
  domainKey: string;
  atsKey: string;
  relation: 'redirect' | 'embed';
  careersUrl: string;
  atsUrl: string;
}
export function detectCareersLink(
  discoveryUrl: string,
  applicationUrl: string,
): CareersLink | null {
  const ats = parseAtsUrl(applicationUrl);
  const careers = parseUrl(discoveryUrl);
  if (!ats || !careers) return null;
  const domain = normalizeDomain(careers.hostname);
  if (!domain || !isEmployerDomain(domain)) return null;
  const embedParam = ['gh_jid', 'ashby_jid', 'lever-origin'].some((name) =>
    careers.searchParams.has(name),
  );
  const pathEvidence =
    careersHint.test(careers.hostname) || careersHint.test(careers.pathname);
  if (!embedParam && !pathEvidence && !ats.embed) return null;
  return {
    domainKey: domain,
    atsKey: `${ats.provider}:${ats.slug}`,
    relation: embedParam || ats.embed ? 'embed' : 'redirect',
    careersUrl: discoveryUrl,
    atsUrl: applicationUrl,
  };
}

/**
 * Requisition IDs are namespaced so only comparable IDs can prove two positions distinct:
 * `greenhouse:123`, `lever:<uuid>`, `ashby:<uuid>`, or `text:R-123` from posting text.
 */
export function requisitionFromUrls(...urls: string[]): string | null {
  for (const value of urls) {
    const ats = parseAtsUrl(value);
    if (ats?.postingId) return `${ats.provider}:${ats.postingId}`;
  }
  for (const value of urls) {
    const url = parseUrl(value);
    const ghJid = url?.searchParams.get('gh_jid');
    if (ghJid && /^\d+$/.test(ghJid)) return `greenhouse:${ghJid}`;
    const ashbyJid = url?.searchParams.get('ashby_jid');
    if (ashbyJid && /^[0-9a-f-]{8,}$/i.test(ashbyJid))
      return `ashby:${ashbyJid.toLowerCase()}`;
  }
  return null;
}
const requisitionText =
  /\b(?:req(?:uisition)?|job)[ \t]*(?:id|#|number|no\.?)[ \t]*[:#]?[ \t]*([A-Za-z0-9][A-Za-z0-9_-]{1,30})\b/i;
export function requisitionFromText(text: string): string | null {
  const match = requisitionText.exec(text.slice(0, 200_000));
  const value = match?.[1];
  if (!value || !/\d/.test(value)) return null;
  return `text:${value.toUpperCase()}`;
}
export function requisitionNamespace(requisitionId: string): string {
  return requisitionId.slice(0, requisitionId.indexOf(':'));
}

/** Same posting URL regardless of tracking parameters or fragments. */
export function urlKey(value: string): string | null {
  const url = parseUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const keep = ['gh_jid', 'jk', 'jobid', 'job_id', 'id', 'token', 'for'];
  const params = [...url.searchParams.entries()]
    .filter(([name]) => keep.includes(name.toLowerCase()))
    .map(([name, v]) => `${name.toLowerCase()}=${v}`)
    .sort();
  return `${host}${path}${params.length ? '?' + params.join('&') : ''}`;
}

const titleWords: Record<string, string[]> = {
  sr: ['senior'],
  snr: ['senior'],
  jr: ['junior'],
  swe: ['software', 'engineer'],
  mgr: ['manager'],
  eng: ['engineer'],
  engr: ['engineer'],
  dev: ['developer'],
  ii: ['2'],
  iii: ['3'],
  iv: ['4'],
};
/** Lowercase title with equivalents unified: Sr./Senior, SWE/Software Engineer, II/2. */
export function normalizeTitle(title: string): string {
  const tokens = title
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  tokens.forEach((token, index) => {
    if (token === 'i' && index === tokens.length - 1 && index > 0)
      out.push('1');
    else out.push(...(titleWords[token] ?? [token]));
  });
  return out.join(' ');
}

const usStates: Record<string, string> = {
  alabama: 'al',
  alaska: 'ak',
  arizona: 'az',
  arkansas: 'ar',
  california: 'ca',
  colorado: 'co',
  connecticut: 'ct',
  delaware: 'de',
  'district of columbia': 'dc',
  florida: 'fl',
  georgia: 'ga',
  hawaii: 'hi',
  idaho: 'id',
  illinois: 'il',
  indiana: 'in',
  iowa: 'ia',
  kansas: 'ks',
  kentucky: 'ky',
  louisiana: 'la',
  maine: 'me',
  maryland: 'md',
  massachusetts: 'ma',
  michigan: 'mi',
  minnesota: 'mn',
  mississippi: 'ms',
  missouri: 'mo',
  montana: 'mt',
  nebraska: 'ne',
  nevada: 'nv',
  'new hampshire': 'nh',
  'new jersey': 'nj',
  'new mexico': 'nm',
  'new york': 'ny',
  'north carolina': 'nc',
  'north dakota': 'nd',
  ohio: 'oh',
  oklahoma: 'ok',
  oregon: 'or',
  pennsylvania: 'pa',
  'rhode island': 'ri',
  'south carolina': 'sc',
  'south dakota': 'sd',
  tennessee: 'tn',
  texas: 'tx',
  utah: 'ut',
  vermont: 'vt',
  virginia: 'va',
  washington: 'wa',
  'west virginia': 'wv',
  wisconsin: 'wi',
  wyoming: 'wy',
};
const stateCodes = new Set(Object.values(usStates));
const countries: Record<string, string> = {
  us: 'us',
  usa: 'us',
  'u s': 'us',
  'u s a': 'us',
  'united states': 'us',
  'united states of america': 'us',
  canada: 'canada',
  uk: 'uk',
  'united kingdom': 'uk',
  'great britain': 'uk',
  germany: 'germany',
  france: 'france',
  ireland: 'ireland',
  india: 'india',
  mexico: 'mexico',
  brazil: 'brazil',
  netherlands: 'netherlands',
  spain: 'spain',
  poland: 'poland',
  australia: 'australia',
  singapore: 'singapore',
  japan: 'japan',
  israel: 'israel',
};
const regions: Record<string, string> = {
  'north america': 'north-america',
  americas: 'americas',
  emea: 'emea',
  europe: 'europe',
  apac: 'apac',
  latam: 'latam',
  worldwide: 'worldwide',
  global: 'worldwide',
  anywhere: 'worldwide',
};

export interface NormalizedLocation {
  arrangement: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  city: string | null;
  state: string | null;
  /** Country code or region; a US state implies `us`. Null when unknown. */
  scope: string | null;
}
/**
 * Fallback location identity. "Remote" and "Remote - US" differ in scope; "Los Angeles,
 * California" equals "Los Angeles, CA"; components that are not stated stay unknown.
 */
export function normalizeLocation(
  raw: string | null | undefined,
): NormalizedLocation {
  const result: NormalizedLocation = {
    arrangement: 'unknown',
    city: null,
    state: null,
    scope: null,
  };
  if (!raw) return result;
  let text = raw
    .toLowerCase()
    .replace(/u\.s\.a\.?|u\.s\./g, 'us')
    .replace(/[–—]/g, '-');
  if (/\bhybrid\b/.test(text)) result.arrangement = 'hybrid';
  else if (/\bremote\b|\bwork from home\b|\bwfh\b|\bdistributed\b/.test(text))
    result.arrangement = 'remote';
  else if (/\bon-?\s?site\b|\bin[- ]office\b|\bin[- ]person\b/.test(text))
    result.arrangement = 'onsite';
  text = text
    .replace(
      /\b(fully |100% )?(remote|hybrid|on-?\s?site|in[- ]office|in[- ]person|work from home|wfh|distributed)\b/g,
      ',',
    )
    .replace(
      /\b(based|within|only|friendly|first|okay|ok|eligible|in the|the)\b/g,
      ',',
    );
  const tokens = text
    .split(/[,;|/()·:\n]|\s-\s|^-|-$|\s-|-\s/)
    .map((token) =>
      token
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  const stateOf = (token: string) =>
    usStates[token] ?? (stateCodes.has(token) ? token : null);
  for (const token of tokens) {
    if (!result.scope && (countries[token] || regions[token]))
      result.scope = countries[token] ?? regions[token];
  }
  // The last state-like token is the state ("New York, NY": city New York, state NY).
  let stateIndex = -1;
  tokens.forEach((token, index) => {
    if (stateOf(token)) stateIndex = index;
  });
  if (stateIndex >= 0) {
    result.state = stateOf(tokens[stateIndex]);
    const previous = tokens[stateIndex - 1];
    if (
      previous &&
      !countries[previous] &&
      !regions[previous] &&
      !stateCodes.has(previous) &&
      /^[a-z][a-z .']{1,40}$/.test(previous)
    )
      result.city = previous;
  }
  if (result.state && !result.scope) result.scope = 'us';
  return result;
}
export function locationKey(location: NormalizedLocation): string {
  return [
    location.arrangement,
    location.city ?? '?',
    location.state ?? '?',
    location.scope ?? '?',
  ].join('|');
}

/**
 * Finds the posting's location: an explicit `Location:` line, else a short heading-like line near
 * the top that parses as a location, else a parenthetical in the title. Unknown otherwise.
 */
export function extractLocation(
  postingText: string,
  title = '',
): string | null {
  const head = postingText.slice(0, 20_000);
  const labeled =
    /^[ \t]*(?:job[ \t]+)?(?:locations?|office|based in)[ \t]*[:\-–][ \t]*(.{2,120})$/im.exec(
      head,
    );
  if (labeled) return labeled[1].trim();
  const lines = head
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
  for (const line of lines) {
    if (line.length > 60 || /[.!?]$/.test(line) || line.split(/\s+/).length > 8)
      continue;
    const parsed = normalizeLocation(line);
    if (parsed.arrangement !== 'unknown' || parsed.state || parsed.scope)
      return line;
  }
  const parenthetical = /\(([^)]{2,60})\)/.exec(title);
  if (parenthetical) {
    const parsed = normalizeLocation(parenthetical[1]);
    if (parsed.arrangement !== 'unknown' || parsed.state || parsed.scope)
      return parenthetical[1];
  }
  return null;
}

const legalSuffixes = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'bv',
  'pbc',
]);
/** Display-name form used only to suggest merges, never to merge automatically. */
export function normalizeEmployerName(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift();
  while (tokens.length > 1 && legalSuffixes.has(tokens[tokens.length - 1]))
    tokens.pop();
  return tokens.join('');
}
/** Comparable name stem for a key: `acme.example` → `acme`, `lever:acme-corp` → `acme`. */
export function keyNameStem(key: string): string {
  if (key.includes(':'))
    return normalizeEmployerName(key.split(':')[1].replace(/[._-]/g, ' '));
  const labels = key.split('.');
  const base =
    labels.length >= 3 && multiPartSuffixes.has(labels.slice(-2).join('.'))
      ? labels[labels.length - 3]
      : (labels[labels.length - 2] ?? labels[0]);
  return normalizeEmployerName(base.replace(/-/g, ' '));
}

export interface JobKeys {
  applicationKey: IdentityKey | null;
  discoveryKey: IdentityKey | null;
  careersLink: CareersLink | null;
  requisitionId: string | null;
  titleKey: string;
  locationKey: string;
  urlKey: string | null;
}
export function deriveJobKeys(job: {
  title: string;
  discoveryUrl: string;
  applicationUrl: string;
  postingText: string;
}): JobKeys {
  const careersLink = detectCareersLink(job.discoveryUrl, job.applicationUrl);
  return {
    applicationKey: identityKeyFromUrl(job.applicationUrl),
    discoveryKey: identityKeyFromUrl(job.discoveryUrl),
    careersLink,
    requisitionId:
      requisitionFromUrls(job.applicationUrl, job.discoveryUrl) ??
      requisitionFromText(job.postingText),
    titleKey: normalizeTitle(job.title),
    locationKey: locationKey(
      normalizeLocation(extractLocation(job.postingText, job.title)),
    ),
    urlKey: urlKey(job.applicationUrl),
  };
}

export interface DedupeCandidate {
  jobId: string;
  requisitionId: string | null;
  titleKey: string;
  locationKey: string;
  urlKey: string | null;
}
/**
 * Pure duplicate rule within one canonical employer. Same posting URL or same requisition ID is
 * a duplicate; comparable but different requisition IDs are distinct positions; otherwise the
 * normalized title and location must both match. Candidates must be ordered oldest first.
 */
export function findDuplicate(
  job: Omit<DedupeCandidate, 'jobId'>,
  existing: DedupeCandidate[],
): DedupeCandidate | null {
  for (const other of existing) {
    if (job.urlKey && job.urlKey === other.urlKey) return other;
    if (job.requisitionId && other.requisitionId) {
      if (job.requisitionId === other.requisitionId) return other;
      if (
        requisitionNamespace(job.requisitionId) ===
        requisitionNamespace(other.requisitionId)
      )
        continue;
    }
    if (
      job.titleKey === other.titleKey &&
      job.locationKey === other.locationKey
    )
      return other;
  }
  return null;
}

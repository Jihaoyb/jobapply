/** Hosts that never identify the employer (job boards, ATS and link hosts). */
const NON_EMPLOYER = [
  'linkedin.com',
  'indeed.com',
  'ziprecruiter.com',
  'glassdoor.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'workable.com',
  'smartrecruiters.com',
  'icims.com',
  'google.com',
  'bit.ly',
  'lnkd.in',
];
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

/** Normalizes a host or URL to its registrable domain, e.g. careers.acme.co.uk → acme.co.uk. */
export function normalizeDomain(value: string): string | null {
  let host = value.trim().toLowerCase();
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  const labels = host.split('.');
  const tld = labels.at(-1)!;
  if (!/^[a-z]{2,63}$/.test(tld)) return null;
  const keep =
    labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(labels.at(-2)!)
      ? 3
      : 2;
  return labels.slice(-keep).join('.');
}
export function isEmployerDomain(domain: string) {
  return !NON_EMPLOYER.some(
    (host) => domain === host || domain.endsWith(`.${host}`),
  );
}
/**
 * The employer website link observed in the posting: an employer-owned
 * application URL, or the first non-board link in the posting text.
 */
export function domainFromPosting(job: {
  applicationUrl: string;
  discoveryUrl: string;
  postingText: string;
}): string | null {
  const links = [
    job.applicationUrl,
    job.discoveryUrl,
    ...(job.postingText.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []),
  ];
  for (const link of links) {
    const domain = normalizeDomain(link);
    if (domain && isEmployerDomain(domain)) return domain;
  }
  return null;
}
/** Titles that usually own hiring for a role, plus managers named after the role. */
export function relevantTitles(jobTitle: string): string[] {
  const role = jobTitle
    .replace(
      /\b(senior|sr\.?|junior|jr\.?|staff|lead|principal|i{1,3}|iv)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const titles = [
    'recruiter',
    'technical recruiter',
    'talent acquisition',
    'hiring manager',
    'engineering manager',
    'head of engineering',
    'director of engineering',
  ];
  if (role) titles.push(`${role} manager`);
  return [...new Set(titles.map((title) => title.toLowerCase()))];
}

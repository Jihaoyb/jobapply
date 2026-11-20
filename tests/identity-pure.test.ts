import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  countInWindow,
  evaluateCap,
  inWindow,
  laLocalDate,
  subtractMonthsClamped,
  windowStart,
} from '../src/server/identity/capdates.js';
import { parseImportCsv } from '../src/server/identity/csv.js';
import {
  detectCareersLink,
  extractLocation,
  findDuplicate,
  identityKeyFromUrl,
  keyNameStem,
  locationKey,
  normalizeDomain,
  normalizeEmployerName,
  normalizeLocation,
  normalizeTitle,
  parseIdentityKey,
  requisitionFromText,
  requisitionFromUrls,
} from '../src/server/identity/normalize.js';

const loc = (raw: string | null) => locationKey(normalizeLocation(raw));

test('identity keys: employer-owned domains normalize; shared ATS hosts key by provider:slug', () => {
  assert.equal(
    normalizeDomain('https://Careers.Acme.example/jobs/1'),
    'acme.example',
  );
  assert.equal(normalizeDomain('www.acme.example.'), 'acme.example');
  assert.equal(normalizeDomain('jobs.acme.co.uk'), 'acme.co.uk');
  assert.equal(normalizeDomain('localhost'), null);
  assert.deepEqual(identityKeyFromUrl('https://jobs.acme.example/apply/9'), {
    key: 'acme.example',
    kind: 'domain',
  });
  for (const [url, key] of [
    ['https://boards.greenhouse.io/acme/jobs/4567', 'greenhouse:acme'],
    [
      'https://job-boards.greenhouse.io/Acme/jobs/4567?gh_src=x',
      'greenhouse:acme',
    ],
    [
      'https://boards.greenhouse.io/embed/job_app?for=acme&token=4567',
      'greenhouse:acme',
    ],
    [
      'https://jobs.lever.co/acme-corp/0f1e2d3c-aaaa-bbbb-cccc-123456789abc',
      'lever:acme-corp',
    ],
    [
      'https://jobs.ashbyhq.com/acme/0f1e2d3c-aaaa-bbbb-cccc-123456789abc',
      'ashby:acme',
    ],
  ])
    assert.equal(identityKeyFromUrl(url)?.key, key, url);
  // Discovery boards and other shared hosts never identify an employer.
  for (const url of [
    'https://www.linkedin.com/jobs/view/123',
    'https://www.indeed.com/viewjob?jk=abc',
    'https://www.ziprecruiter.com/c/x',
    'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1',
  ])
    assert.equal(identityKeyFromUrl(url), null, url);
  // A lookalike host is not the Lever board; it is just another domain.
  assert.deepEqual(
    identityKeyFromUrl('https://jobs.lever.co.evil.example/acme/1'),
    {
      key: 'evil.example',
      kind: 'domain',
    },
  );
  assert.deepEqual(parseIdentityKey('Greenhouse:Acme'), {
    key: 'greenhouse:acme',
    kind: 'ats',
  });
  assert.equal(parseIdentityKey('workday:acme'), null);
  assert.equal(parseIdentityKey('linkedin.com'), null);
  assert.equal(parseIdentityKey('careers.acme.example')?.key, 'acme.example');
});

test('careers redirect/embed links the employer domain and ATS slug, recording both URLs', () => {
  const embed = detectCareersLink(
    'https://www.acme.example/careers/open-roles?gh_jid=4567',
    'https://boards.greenhouse.io/acme/jobs/4567',
  );
  assert.deepEqual(embed, {
    domainKey: 'acme.example',
    atsKey: 'greenhouse:acme',
    relation: 'embed',
    careersUrl: 'https://www.acme.example/careers/open-roles?gh_jid=4567',
    atsUrl: 'https://boards.greenhouse.io/acme/jobs/4567',
  });
  assert.equal(
    detectCareersLink(
      'https://careers.acme.example/role/1',
      'https://jobs.lever.co/acme/0f1e2d3c-aaaa-bbbb-cccc-123456789abc',
    )?.relation,
    'redirect',
  );
  // A blog post or a discovery board linking to an ATS is not careers-page evidence.
  assert.equal(
    detectCareersLink(
      'https://blog.example/posts/hiring-roundup',
      'https://boards.greenhouse.io/acme/jobs/4567',
    ),
    null,
  );
  assert.equal(
    detectCareersLink(
      'https://www.linkedin.com/jobs/view/1',
      'https://boards.greenhouse.io/acme/jobs/4567',
    ),
    null,
  );
});

test('titles normalize Sr./Senior, SWE/Software Engineer and II/2', () => {
  const same = [
    ['Sr. Software Engineer II', 'Senior SWE 2'],
    ['Senior Software Engineer, II', 'sr swe ii'],
    ['Software Engineer I', 'Software Engineer 1'],
    ['SWE III (Remote)', 'Software Engineer 3'],
  ];
  for (const [a, b] of same)
    assert.equal(normalizeTitle(a), normalizeTitle(b), `${a} ~ ${b}`);
  assert.notEqual(
    normalizeTitle('Software Engineer II'),
    normalizeTitle('Software Engineer III'),
  );
  assert.notEqual(
    normalizeTitle('Senior Software Engineer'),
    normalizeTitle('Software Engineer'),
  );
});

test('locations normalize arrangement, city/state and scope; Remote differs from Remote - US', () => {
  assert.equal(loc('Los Angeles, California'), loc('Los Angeles, CA'));
  assert.equal(loc('Los Angeles, CA'), 'unknown|los angeles|ca|us');
  assert.equal(loc('Remote'), 'remote|?|?|?');
  assert.equal(loc('Remote - US'), 'remote|?|?|us');
  assert.notEqual(loc('Remote'), loc('Remote - US'));
  assert.equal(loc('Remote (United States)'), loc('US - Remote'));
  assert.equal(loc('Remote — USA'), loc('Remote, U.S.'));
  assert.equal(loc('Remote - Canada'), 'remote|?|?|canada');
  assert.notEqual(loc('Remote - Canada'), loc('Remote - US'));
  assert.equal(loc('Hybrid - New York, NY'), 'hybrid|new york|ny|us');
  assert.notEqual(loc('Hybrid - New York, NY'), loc('New York, NY'));
  assert.equal(loc('On-site, Austin, Texas'), loc('Onsite - Austin, TX'));
  assert.equal(loc(null), 'unknown|?|?|?');
  assert.equal(loc('Seattle, WA'), loc('Seattle, Washington, United States'));
  assert.equal(
    extractLocation('About us\nLocation: Remote - US\nWe build things.'),
    'Remote - US',
  );
  assert.equal(
    extractLocation(
      'Senior Engineer\nLos Angeles, CA\n\nYou will build things.',
    ),
    'Los Angeles, CA',
  );
  assert.equal(
    extractLocation(
      'Build reliable software. Remote within the United States.',
    ),
    null,
  );
  assert.equal(
    extractLocation('No location here', 'SWE (Remote - US)'),
    'Remote - US',
  );
});

test('requisition IDs are namespaced from ATS URLs, careers parameters and posting text', () => {
  assert.equal(
    requisitionFromUrls('https://boards.greenhouse.io/acme/jobs/4567'),
    'greenhouse:4567',
  );
  assert.equal(
    requisitionFromUrls(
      'https://www.linkedin.com/jobs/view/1',
      'https://acme.example/careers?gh_jid=4567',
    ),
    'greenhouse:4567',
  );
  assert.equal(
    requisitionFromText('Req ID: R-10293\nGreat role'),
    'text:R-10293',
  );
  assert.equal(requisitionFromText('Job number 4471'), 'text:4471');
  assert.equal(requisitionFromText('A job id is not mentioned here'), null);
});

test('dedupe: same requisition or URL links; distinct known requisitions survive; fallback needs title and location', () => {
  const base = {
    jobId: 'a',
    requisitionId: 'greenhouse:1',
    titleKey: normalizeTitle('Senior Software Engineer'),
    locationKey: loc('Remote - US'),
    urlKey: 'boards.greenhouse.io/acme/jobs/1',
  };
  const job = { ...base, urlKey: null };
  assert.equal(findDuplicate(job, [base])?.jobId, 'a');
  // Same title and location, different known requisition: distinct positions.
  assert.equal(
    findDuplicate({ ...job, requisitionId: 'greenhouse:2' }, [base]),
    null,
  );
  // Different namespaces are not comparable: fall back to title + location.
  assert.equal(
    findDuplicate(
      {
        ...job,
        requisitionId: 'text:R-9',
        titleKey: normalizeTitle('Sr. SWE'),
      },
      [base],
    )?.jobId,
    'a',
  );
  assert.equal(
    findDuplicate({ ...job, requisitionId: null, locationKey: loc('Remote') }, [
      base,
    ]),
    null,
  );
  assert.equal(
    findDuplicate(
      { ...job, requisitionId: null, urlKey: base.urlKey, titleKey: 'other' },
      [base],
    )?.jobId,
    'a',
  );
});

test('employer display names suggest merges only through normalized stems', () => {
  assert.equal(
    normalizeEmployerName('Acme Inc.'),
    normalizeEmployerName('ACME'),
  );
  assert.equal(normalizeEmployerName('The Acme Corporation'), 'acme');
  assert.equal(keyNameStem('lever:acme-corp'), 'acme');
  assert.equal(keyNameStem('acme.example'), 'acme');
  assert.equal(keyNameStem('greenhouse:acmerobotics'), 'acmerobotics');
});

test('cap window: (today minus three calendar months, today] with month-end clamping', () => {
  // PRD example: on Nov 8, Aug 8 has aged out and Aug 9 still counts (open lower boundary).
  assert.equal(windowStart('2026-11-08', 3), '2026-08-08');
  assert.equal(inWindow('2026-08-08', '2026-11-08', 3), false);
  assert.equal(inWindow('2026-08-09', '2026-11-08', 3), true);
  assert.equal(inWindow('2026-11-08', '2026-11-08', 3), true);
  assert.equal(inWindow('2026-11-09', '2026-11-08', 3), false);
  // Month-end clamping to the last valid day.
  assert.equal(subtractMonthsClamped('2026-05-31', 3), '2026-02-28');
  assert.equal(subtractMonthsClamped('2028-05-31', 3), '2028-02-29');
  assert.equal(subtractMonthsClamped('2026-11-30', 3), '2026-08-30');
  assert.equal(subtractMonthsClamped('2026-12-31', 3), '2026-09-30');
  assert.equal(subtractMonthsClamped('2027-01-31', 3), '2026-10-31');
  assert.equal(subtractMonthsClamped('2026-03-31', 1), '2026-02-28');
  // On May 31 the window is (Feb 28, May 31]: Feb 28 is out, Mar 1 counts.
  assert.equal(inWindow('2026-02-28', '2026-05-31', 3), false);
  assert.equal(inWindow('2026-03-01', '2026-05-31', 3), true);
  // May 29/30/31 share the clamped Feb 28 start.
  for (const day of ['2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31'])
    assert.equal(windowStart(day, 3), '2026-02-28', day);
  assert.equal(
    countInWindow(['2026-08-08', '2026-08-09', '2026-10-01'], '2026-11-08', 3),
    2,
  );
});

test('next available date follows the earliest entry aging out, including clamped month ends', () => {
  const capped = evaluateCap(
    ['2026-08-09', '2026-09-15', '2026-11-01'],
    '2026-11-08',
  );
  assert.equal(capped.capped, true);
  assert.equal(capped.count, 3);
  // Aug 9 ages out on the first day whose start is >= Aug 9: Nov 9.
  assert.equal(capped.nextAvailableDate, '2026-11-09');
  assert.equal(
    evaluateCap(['2026-08-08', '2026-09-15', '2026-11-01'], '2026-11-08')
      .capped,
    false,
  );
  assert.equal(
    evaluateCap(['2026-08-08', '2026-09-15', '2026-11-01'], '2026-11-08')
      .nextAvailableDate,
    '2026-11-08',
  );
  // Nov 29/30 entries: Feb 28 start (2027) is Nov 28, so they age out on Mar 1.
  const clamped = evaluateCap(
    ['2026-11-29', '2026-11-30', '2026-12-15'],
    '2027-02-28',
  );
  assert.equal(clamped.capped, true);
  assert.equal(clamped.nextAvailableDate, '2027-03-01');
  // Configurable limit and window.
  assert.equal(
    evaluateCap(['2026-11-01'], '2026-11-08', { limit: 1, windowMonths: 1 })
      .nextAvailableDate,
    '2026-12-01',
  );
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('Los Angeles local dates around DST transitions and midnight', () => {
  // DST starts 2026-03-08 02:00 PST -> 03:00 PDT.
  assert.equal(laLocalDate(new Date('2026-03-08T09:59:00Z')), '2026-03-08');
  assert.equal(laLocalDate(new Date('2026-03-08T10:00:00Z')), '2026-03-08');
  assert.equal(laLocalDate(new Date('2026-03-08T07:59:00Z')), '2026-03-07');
  assert.equal(laLocalDate(new Date('2026-03-09T06:59:00Z')), '2026-03-08');
  assert.equal(laLocalDate(new Date('2026-03-09T07:00:00Z')), '2026-03-09');
  // DST ends 2026-11-01 02:00 PDT -> 01:00 PST.
  assert.equal(laLocalDate(new Date('2026-11-01T06:59:00Z')), '2026-10-31');
  assert.equal(laLocalDate(new Date('2026-11-01T07:00:00Z')), '2026-11-01');
  assert.equal(laLocalDate(new Date('2026-11-02T07:59:00Z')), '2026-11-01');
  assert.equal(laLocalDate(new Date('2026-11-02T08:00:00Z')), '2026-11-02');
  // A late-evening LA submission belongs to that LA date, not the UTC date.
  assert.equal(laLocalDate(new Date('2026-08-09T06:30:00Z')), '2026-08-08');
  // Windows spanning DST changes count calendar days only.
  assert.equal(windowStart('2026-03-08', 3), '2025-12-08');
  assert.equal(windowStart('2026-11-01', 3), '2026-08-01');
  assert.equal(inWindow('2026-08-01', '2026-11-01', 3), false);
  assert.equal(inWindow('2026-08-02', '2026-11-01', 3), true);
});

test('CSV import validation reports actionable per-row errors and in-file repeats', () => {
  const csv = [
    'employer,title,date,source URL',
    'Acme Inc.,Software Engineer,2026-09-01,https://boards.greenhouse.io/acme/jobs/1',
    '"Globex, LLC","Engineer, Platform",2026-09-02,https://globex.example/jobs/2',
    ',Engineer,2026-09-03,https://example.com/a',
    'Initech,Engineer,09/03/2026,https://example.com/b',
    'Initech,Engineer,2026-02-30,https://example.com/c',
    'Initech,Engineer,2026-12-01,https://example.com/d',
    'Initech,Engineer,2026-09-03,ftp://example.com/e',
    'Initech,Engineer,2026-09-03',
    'acme inc,software engineer,2026-09-01,https://boards.greenhouse.io/acme/jobs/1',
  ].join('\r\n');
  const parsed = parseImportCsv(csv, '2026-11-20');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[1].employer, 'Globex, LLC');
  assert.equal(parsed.rows[1].title, 'Engineer, Platform');
  assert.deepEqual(
    parsed.errors.map((e) => [e.line, e.column]),
    [
      [4, 'employer'],
      [5, 'date'],
      [6, 'date'],
      [7, 'date'],
      [8, 'source URL'],
      [9, null],
    ],
  );
  assert.match(parsed.errors[1].message, /ISO local date/);
  assert.match(parsed.errors[2].message, /does not exist/);
  assert.match(parsed.errors[3].message, /after today/);
  assert.match(parsed.errors[5].message, /Expected 4 columns/);
  assert.deepEqual(parsed.repeated, [{ line: 10, sameAsLine: 2 }]);
  assert.match(
    parseImportCsv('company,role,date\nA,B,2026-01-01', '2026-11-20').errors[0]
      .message,
    /header/,
  );
  assert.equal(
    parseImportCsv('employer,title,date,source URL\n', '2026-11-20').errors[0]
      .message,
    'No rows to import',
  );
});

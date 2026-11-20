import { createHash } from 'node:crypto';

/**
 * Deterministic eligibility routing (PRD "Eligibility routing").
 *
 * Two separate lists:
 * 1. EXCLUSION_RULES: narrow patterns for a complete, unambiguous requirement
 *    (citizen/green-card only, ITAR / U.S. person, required clearance, an explicit
 *    sponsorship bar, or an explicit OPT/CPT bar). Negation, preference, hedging
 *    or a conflicting clause blocks automatic exclusion.
 * 2. TRIGGERS: a broad vocabulary. Any trigger without a conclusive exclusion is
 *    routed to Sol. No trigger at all passes without a model call.
 *
 * Applicant profile assumed throughout: F-1 OPT, authorized now, needs future
 * H-1B sponsorship, not a citizen / permanent resident / U.S. person, no clearance.
 */

export interface Span {
  start: number;
  end: number;
  text: string;
}

export type RuleCategory =
  'citizenship' | 'itar' | 'clearance' | 'sponsorship' | 'opt';

export interface ExclusionRule {
  id: string;
  category: RuleCategory;
  pattern: RegExp;
  /** Extra condition the sentence must also satisfy (e.g. mention the future). */
  sentenceMustMatch?: RegExp;
}

const US = String.raw`(?:U\.S\.A?\.?|U\.S|USA|US|United States)`;
const CLEARANCE_KIND = String.raw`(?:(?:${US}|government|federal|DoD|DOE|security|secret|top secret|TS\/SCI|TS|SCI|public trust|Q|L)\s+)+`;
const SPONSOR_KIND = String.raw`(?:(?:visa|employment|work|immigration|H-?1-?B|employer|company)\s+)*`;
const FUTURE_QUALIFIER = String.raw`(?:(?:current|currently|future|present|now|or|and|either|in|the|at|any|time|point)\s+)*`;

function rule(
  id: string,
  category: RuleCategory,
  source: string,
  flags = 'i',
  sentenceMustMatch?: RegExp,
): ExclusionRule {
  return {
    id,
    category,
    pattern: new RegExp(source, flags),
    sentenceMustMatch,
  };
}

export const EXCLUSION_RULES: ExclusionRule[] = [
  // Citizenship / permanent residency only.
  rule(
    'citizenship.must_be_citizen',
    'citizenship',
    String.raw`\bmust be (?:an? )?(?:${US} )?citizens?\b`,
  ),
  rule(
    'citizenship.citizenship_required',
    'citizenship',
    String.raw`\b(?:${US} )?citizenship (?:is )?(?:required|mandatory)\b|\brequires? (?:${US} )?citizenship\b`,
  ),
  rule(
    'citizenship.citizens_only',
    'citizenship',
    String.raw`\b(?:open|available) only to (?:${US} )?citizens\b|\bonly open to (?:${US} )?citizens\b|\bonly (?:${US} )?citizens\b(?: (?:and|or) (?:lawful )?(?:permanent residents|green card holders))? (?:will be considered|are eligible|may apply|need apply)\b|\b(?:${US} )?citizens (?:and|or) (?:lawful )?(?:permanent residents|green card holders) only\b`,
  ),
  rule(
    'citizenship.green_card_required',
    'citizenship',
    String.raw`\bmust (?:hold|have|possess) (?:an? )?(?:${US} )?(?:green card|permanent residency)\b`,
  ),
  // ITAR / U.S. person.
  rule(
    'itar.us_person',
    'itar',
    String.raw`\bmust (?:be|qualify as) (?:an? )?${US} persons?\b|\brequire[sd]? (?:that )?(?:all )?(?:applicants|candidates|employees) (?:to )?be ${US} persons?\b`,
  ),
  rule(
    'itar.eligibility_required',
    'itar',
    String.raw`\brequires? ITAR (?:eligibility|status|compliance)\b|\bITAR (?:eligibility|status) (?:is )?required\b`,
  ),
  // Required security clearance (obtaining one also requires citizenship).
  rule(
    'clearance.required',
    'clearance',
    String.raw`\b(?:active |current )?${CLEARANCE_KIND}clearance (?:is )?required\b`,
  ),
  rule(
    'clearance.must_hold',
    'clearance',
    String.raw`\bmust (?:currently )?(?:hold|have|possess|maintain|obtain|be able to obtain|be eligible to obtain|be eligible for)(?: and maintain)? (?:an? )?(?:active |current )?${CLEARANCE_KIND}clearance\b`,
  ),
  rule(
    'clearance.requires',
    'clearance',
    String.raw`\brequires? (?:an? )?(?:active |current )?${CLEARANCE_KIND}clearance\b|\bability to obtain (?:and maintain )?(?:an? )?${CLEARANCE_KIND}clearance (?:is )?required\b`,
  ),
  // Explicit sponsorship bar.
  rule(
    'sponsorship.will_not_sponsor',
    'sponsorship',
    String.raw`\b(?:(?:will|do|does|can|are|is)\s+not|cannot|can[’']t|won[’']t|don[’']t|doesn[’']t|unable to)\s+(?:be\s+)?(?:able\s+to\s+|in a position to\s+)?(?:provide\s+|offer\s+|support\s+)?${SPONSOR_KIND}sponsor(?:ship|s|ing)?\b`,
  ),
  rule(
    'sponsorship.not_available',
    'sponsorship',
    String.raw`\bno ${SPONSOR_KIND}sponsorship (?:is |will be )?(?:available|offered|provided)\b|\b${SPONSOR_KIND}sponsorship (?:is |will )?not (?:be )?(?:available|offered|provided)\b|\bnot eligible for ${SPONSOR_KIND}sponsorship\b`,
  ),
  rule(
    'sponsorship.requiring_not_considered',
    'sponsorship',
    String.raw`\b(?:require|requires|requiring|need|needs|needing)\s+${FUTURE_QUALIFIER}${SPONSOR_KIND}sponsorship\b[^.]{0,60}?\b(?:will not|won[’']t|cannot|can[’']t|are not|is not|ineligible)\b`,
  ),
  rule(
    'sponsorship.without_future_sponsorship',
    'sponsorship',
    String.raw`\bwithout (?:the need for |requiring |needing )?${FUTURE_QUALIFIER}${SPONSOR_KIND}sponsorship\b`,
    'i',
    /\bfuture\b/i,
  ),
  rule(
    'sponsorship.must_not_require',
    'sponsorship',
    String.raw`\b(?:must not|cannot|can[’']t|will not|won[’']t)\s+${FUTURE_QUALIFIER}(?:require|need)\s+${SPONSOR_KIND}sponsorship\b`,
    'i',
    /\bfuture\b/i,
  ),
  // Explicit OPT/CPT bar (case-sensitive acronyms so "opt in" never matches).
  rule(
    'opt.not_accepted',
    'opt',
    String.raw`\b(?:[Nn]o|[Nn]ot accepting|[Cc]annot accept|[Cc]an[’']t accept|[Dd]o not accept|[Dd]oes not accept|[Ww]ill not accept|[Uu]nable to accept|[Nn]ot open to)\s+(?:(?:candidates|applicants|students)\s+(?:on|with|in)\s+)?(?:F-1\s+)?(?:STEM\s+)?(?:OPT|CPT)(?:\s*(?:\/|or|and|,)\s*(?:STEM\s+)?(?:OPT|CPT))*\b`,
    '',
  ),
  rule(
    'opt.not_considered',
    'opt',
    String.raw`\b(?:OPT|CPT)(?:\s*(?:\/|or|and)\s*(?:OPT|CPT))? (?:candidates |students |applicants |holders )?(?:are |is |will )?not (?:be )?(?:accepted|eligible|considered)\b`,
    '',
  ),
];

/** Broad Sol trigger vocabulary, including spelling and inflection variants. */
export const TRIGGERS: { id: string; pattern: RegExp }[] = [
  { id: 'visa', pattern: /\bvisas?\b/i },
  { id: 'sponsor', pattern: /\bsponsor(?:s|ed|ing|ship|ships)?\b/i },
  {
    id: 'authorization',
    pattern: /\b(?:un)?authori[sz](?:e|ed|es|ing|ation|ations)\b/i,
  },
  {
    id: 'work_eligibility',
    pattern:
      /\b(?:eligib(?:le|ility) to work|work eligibility|employment eligibility|right to work)\b/i,
  },
  { id: 'work_permit', pattern: /\bwork[\s-]+permits?\b/i },
  { id: 'h1b', pattern: /\bH[\s-]?1[\s-]?B\b/i },
  { id: 'opt', pattern: /\b(?:OPT|CPT|EAD)\b/ },
  { id: 'f1', pattern: /\bF-?1\s+(?:visa|student|status|OPT)\b|\bF-1\b/i },
  { id: 'immigration', pattern: /\bimmigra(?:tion|nt|nts)\b/i },
  { id: 'itar', pattern: /\bITAR\b|\bexport[\s-]+control(?:s|led)?\b/i },
  { id: 'us_person', pattern: /\bU\.?S\.?\s+persons?\b/i },
  { id: 'clearance', pattern: /\bclearances?\b/i },
  { id: 'citizen', pattern: /\bcitizen(?:s|ship)?\b/i },
  { id: 'resident', pattern: /\bresiden(?:t|ts|cy)\b/i },
  { id: 'green_card', pattern: /\bgreen[\s-]?cards?\b/i },
];

/** Words before the match (same clause) that negate a requirement. */
const NEGATION_BEFORE =
  /\b(?:not|no|never|without|neither|nor)\b|n[’']t\b|\bnon-?/i;
/** Preference wording anywhere in the sentence prevents automatic exclusion. */
const PREFERENCE =
  /\b(?:prefer(?:red|ably|ence)?|ideal(?:ly)?|nice[\s-]to[\s-]have|a plus|bonus|desired|desirable|advantageous|strongly encouraged|helpful|beneficial)\b/i;
/** Hedged or conditional wording anywhere in the sentence. */
const HEDGE =
  /\b(?:may|might|could|some|certain|possibly|potentially|depending|if|at this time|at the moment|for now|occasionally|in some cases)\b/i;
/** Statements elsewhere in the text that conflict with a category's bar. */
const CONFLICTS: Record<RuleCategory, RegExp> = {
  sponsorship:
    /\bsponsorship (?:is |will be )?(?:available|offered|provided|possible|considered)\b|\bwe (?:will |can |do |are happy to |are able to )?sponsor\b|\b(?:will|can) consider sponsorship\b|\b(?:OPT|CPT|F-1)\b[^.]{0,40}\b(?:welcome|encouraged|accepted|eligible|considered)\b/i,
  opt: /\b(?:OPT|CPT|F-1)\b[^.]{0,40}\b(?:welcome|encouraged|accepted|eligible|considered)\b|\bsponsorship (?:is |will be )?(?:available|offered|provided)\b/i,
  citizenship:
    /\bcitizenship (?:is )?not (?:required|necessary|needed)\b|\bregardless of (?:citizenship|immigration status|national origin)\b/i,
  itar: /\b(?:ITAR|export control)[^.]{0,40}\bnot (?:required|applicable)\b|\bU\.?S\.? person status (?:is )?not required\b/i,
  clearance:
    /\bclearance (?:is )?not (?:required|necessary|needed)\b|\bno clearance (?:is )?(?:required|needed)\b/i,
};

export type BlockReason = 'negated' | 'preference' | 'hedged' | 'conflict';

export interface RuleMatch {
  ruleId: string;
  category: RuleCategory;
  sentence: Span;
  match: Span;
  blocked: BlockReason | null;
}

export type RuleOutcome =
  | { route: 'exclusion_rule'; match: RuleMatch; considered: RuleMatch[] }
  | {
      route: 'sol';
      passages: Span[];
      triggers: string[];
      considered: RuleMatch[];
    }
  | { route: 'no_trigger' };

const ABBREVIATION =
  /(?:\b(?:[A-Za-z]\.){1,3}|\b(?:e\.g|i\.e|etc|Inc|Corp|Co|Ltd|Sr|Jr|Mr|Ms|Mrs|Dr|St|No|vs|approx|Dept)\.)$/;

/** Splits text into sentence spans whose offsets refer to the original string. */
export function sentences(text: string): Span[] {
  const spans: Span[] = [];
  const push = (start: number, end: number) => {
    while (start < end && /[\s•*·\-–—>]/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (end > start) spans.push({ start, end, text: text.slice(start, end) });
  };
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    const lineStart = line.index!;
    const value = line[0];
    let start = 0;
    for (const boundary of value.matchAll(/[.!?]+["')\]]*(?=\s+)/g)) {
      const end = boundary.index! + boundary[0].length;
      if (ABBREVIATION.test(value.slice(0, end))) continue;
      push(lineStart + start, lineStart + end);
      start = end;
    }
    push(lineStart + start, lineStart + value.length);
  }
  return spans;
}

function clauseBefore(sentence: string, offset: number) {
  const before = sentence.slice(0, offset);
  const cut = Math.max(
    before.lastIndexOf(','),
    before.lastIndexOf(';'),
    before.lastIndexOf(':'),
    before.lastIndexOf('('),
  );
  return before.slice(cut + 1);
}

function hasConflict(
  text: string,
  category: RuleCategory,
  exclude: Span,
): boolean {
  const pattern = new RegExp(CONFLICTS[category].source, 'gi');
  for (const hit of text.matchAll(pattern)) {
    const start = hit.index!;
    // The bar itself, or a negated positive statement, is not a conflict.
    if (start >= exclude.start && start < exclude.end) continue;
    if (/\bnot\b|n[’']t\b/i.test(hit[0])) continue;
    const sentence = sentences(text).find(
      (s) => start >= s.start && start < s.end,
    );
    const before = sentence
      ? clauseBefore(sentence.text, start - sentence.start)
      : '';
    if (!NEGATION_BEFORE.test(before)) return true;
  }
  return false;
}

function triggersIn(value: string): string[] {
  return TRIGGERS.filter((t) => t.pattern.test(value)).map((t) => t.id);
}

/** Routes text through the narrow exclusion list, then the broad trigger list. */
export function evaluateRules(text: string): RuleOutcome {
  const all = sentences(text);
  const considered: RuleMatch[] = [];
  for (const sentence of all) {
    for (const candidate of EXCLUSION_RULES) {
      const hit = candidate.pattern.exec(sentence.text);
      if (!hit) continue;
      if (
        candidate.sentenceMustMatch &&
        !candidate.sentenceMustMatch.test(sentence.text)
      )
        continue;
      const match: Span = {
        start: sentence.start + hit.index,
        end: sentence.start + hit.index + hit[0].length,
        text: hit[0],
      };
      let blocked: BlockReason | null = null;
      if (NEGATION_BEFORE.test(clauseBefore(sentence.text, hit.index)))
        blocked = 'negated';
      else if (PREFERENCE.test(sentence.text)) blocked = 'preference';
      else if (HEDGE.test(sentence.text)) blocked = 'hedged';
      else if (hasConflict(text, candidate.category, match))
        blocked = 'conflict';
      const result: RuleMatch = {
        ruleId: candidate.id,
        category: candidate.category,
        sentence,
        match,
        blocked,
      };
      considered.push(result);
      if (!blocked)
        return { route: 'exclusion_rule', match: result, considered };
    }
  }
  const triggered = all
    .map((sentence, index) => ({ index, ids: triggersIn(sentence.text) }))
    .filter((entry) => entry.ids.length);
  if (!triggered.length) return { route: 'no_trigger' };
  // Send each triggered sentence with one sentence of context on each side.
  const keep = new Set<number>();
  for (const { index } of triggered)
    for (const i of [index - 1, index, index + 1])
      if (i >= 0 && i < all.length) keep.add(i);
  const passages: Span[] = [];
  for (const i of [...keep].sort((a, b) => a - b)) {
    const last = passages.at(-1);
    const sentence = all[i]!;
    if (last && i - 1 >= 0 && keep.has(i - 1) && last.end === all[i - 1]!.end) {
      last.end = sentence.end;
      last.text = text.slice(last.start, last.end);
    } else passages.push({ ...sentence });
  }
  return {
    route: 'sol',
    passages,
    triggers: [...new Set(triggered.flatMap((entry) => entry.ids))],
    considered,
  };
}

/**
 * Verifies that a model-provided quote exists literally in the source text.
 * Only runs of whitespace may differ (line wrapping); the returned span is the
 * original source substring, which is what gets stored as evidence.
 */
export function verifyQuote(source: string, quote: string | null): Span | null {
  if (!quote) return null;
  const wanted = quote.trim();
  if (wanted.length < 8) return null;
  const exact = source.indexOf(wanted);
  if (exact >= 0)
    return { start: exact, end: exact + wanted.length, text: wanted };
  const flexible = new RegExp(
    wanted
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+'),
  );
  const hit = flexible.exec(source);
  if (!hit) return null;
  return { start: hit.index, end: hit.index + hit[0].length, text: hit[0] };
}

/** True when a quote mentions at least one restriction trigger. */
export function quoteHasTrigger(quote: string) {
  return triggersIn(quote).length > 0;
}

/** Changes whenever any routing pattern changes; recorded in the replay baseline. */
export function rulesFingerprint() {
  const material = JSON.stringify({
    exclusions: EXCLUSION_RULES.map((r) => [
      r.id,
      r.category,
      r.pattern.source,
      r.pattern.flags,
      r.sentenceMustMatch?.source ?? null,
    ]),
    triggers: TRIGGERS.map((t) => [t.id, t.pattern.source, t.pattern.flags]),
    guards: [
      NEGATION_BEFORE.source,
      PREFERENCE.source,
      HEDGE.source,
      ...Object.entries(CONFLICTS).map(([k, v]) => k + v.source),
      ABBREVIATION.source,
    ],
  });
  return createHash('sha256').update(material).digest('hex');
}

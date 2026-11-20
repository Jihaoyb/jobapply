/**
 * Deterministic text handling for the answer bank. These guards run after Luna and veto
 * reuse whenever polarity, time horizon, location, numbers or other material qualifiers
 * differ, regardless of the equivalence score.
 */
const numberWords: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

/** Lowercase, drop punctuation, "(required)" markers and repeated whitespace. */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(required\)|\(optional\)/g, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9$'\s]/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
export const normalizeChoice = normalizeQuestion;

function words(text: string): string[] {
  return normalizeQuestion(text)
    .split(' ')
    .filter(Boolean)
    .map((word) => numberWords[word] ?? word);
}

const negations = new Set([
  'not',
  'no',
  'without',
  'never',
  'dont',
  'doesnt',
  'wont',
  'cant',
  'cannot',
  'isnt',
  'arent',
  'unable',
  'nor',
  'neither',
]);
const nowPhrases = [
  'currently',
  'current',
  'now',
  'presently',
  'at present',
  'at this time',
  'today',
  'right now',
];
const futurePhrases = [
  'future',
  'going forward',
  'at any point',
  'eventually',
  'later',
  'at a later date',
  'upcoming',
];
/** Gazetteer of locations seen in pilot forms; values are canonical keys. */
const locations: [RegExp, string][] = [
  // Bare "us" is usually a pronoun ("tell us"), so only explicit country forms count.
  [/\b(united states|usa|u s a|u s|america|(in|the|within) us)\b/, 'us'],
  [/\bcanad(a|ian)\b/, 'canada'],
  [/\b(united kingdom|uk|britain|england)\b/, 'uk'],
  [/\b(european union|eu|europe)\b/, 'eu'],
  [/\b(india)\b/, 'india'],
  [/\b(mexico)\b/, 'mexico'],
  [/\bcalifornia\b/, 'california'],
  [/\b(new york city|nyc|new york)\b/, 'new york'],
  [/\b(san francisco|sf|bay area)\b/, 'sf bay area'],
  [/\bseattle\b/, 'seattle'],
  [/\baustin\b/, 'austin'],
  [/\bboston\b/, 'boston'],
  [/\blos angeles\b/, 'los angeles'],
  [/\bchicago\b/, 'chicago'],
  [/\blondon\b/, 'london'],
  [/\btoronto\b/, 'toronto'],
  [/\btexas\b/, 'texas'],
  [/\bwashington\b/, 'washington'],
  [/\bremote(ly)?\b/, 'remote'],
  [/\b(on site|onsite|in office|in person|in the office)\b/, 'onsite'],
  [/\bhybrid\b/, 'hybrid'],
];
/** Qualifiers that change what the answer means even when wording is close. */
const qualifiers: [RegExp, string][] = [
  [/\bhourly\b|\bper hour\b/, 'hourly'],
  [/\bannual(ly)?\b|\byearly\b|\bper year\b/, 'annual'],
  [/\bmonthly\b|\bper month\b/, 'monthly'],
  [/\bbase\b/, 'base'],
  [/\btotal\b/, 'total'],
  [/\bactive\b/, 'active'],
  [/\bobtain\b|\bacquire\b/, 'obtain'],
  [/\bpart time\b/, 'part-time'],
  [/\bfull time\b/, 'full-time'],
  [/\bcontract(or)?\b/, 'contract'],
  [/\bh 1b\b|\bh1b\b/, 'h-1b'],
  [/\bopt\b|\bstem opt\b/, 'opt'],
  [/\bgreen card\b|\bpermanent resident\b/, 'permanent-residency'],
  [/\bcitizen(ship)?\b/, 'citizenship'],
  [/\bsecret\b|\btop secret\b|\bts sci\b/, 'clearance-level'],
  [/\brelocat(e|ion|ing)\b/, 'relocation'],
  [/\btravel\b/, 'travel'],
  [/\bstart\b|\bnotice\b/, 'start'],
  [/\bsponsor(ship|ed|ing)?\b/, 'sponsorship'],
  [/\bauthori[sz](ed|ation)\b|\beligible\b|\blegally\b/, 'authorization'],
  [/\bclearance\b/, 'clearance'],
];

export interface QuestionProfile {
  negations: number;
  horizon: string[];
  locations: string[];
  numbers: string[];
  qualifiers: string[];
}
export function profileQuestion(text: string): QuestionProfile {
  const tokens = words(text);
  // "Yes or no" is answer formatting, not a negation.
  const joined = ` ${tokens.join(' ')} `.replace(/ yes or no | yes no /g, ' ');
  const has = (phrase: string) => joined.includes(` ${phrase} `);
  const horizon = new Set<string>();
  if (nowPhrases.some(has)) horizon.add('now');
  if (futurePhrases.some(has)) horizon.add('future');
  return {
    negations: joined.split(' ').filter((word) => negations.has(word)).length,
    horizon: [...horizon].sort(),
    locations: [
      ...new Set(locations.filter(([re]) => re.test(joined)).map(([, k]) => k)),
    ].sort(),
    numbers: [...new Set(tokens.filter((t) => /^\$?\d+[k%]?$/.test(t)))].sort(),
    qualifiers: [
      ...new Set(
        qualifiers.filter(([re]) => re.test(joined)).map(([, k]) => k),
      ),
    ].sort(),
  };
}

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
/** Returns the material differences between a stored question and a form question. */
export function guardMismatches(stored: string, asked: string): string[] {
  const a = profileQuestion(stored),
    b = profileQuestion(asked);
  const mismatches: string[] = [];
  if (a.negations % 2 !== b.negations % 2) mismatches.push('polarity');
  if (!same(a.horizon, b.horizon)) mismatches.push('time_horizon');
  if (!same(a.locations, b.locations)) mismatches.push('location');
  if (!same(a.numbers, b.numbers)) mismatches.push('numbers');
  if (!same(a.qualifiers, b.qualifiers)) mismatches.push('qualifier');
  return mismatches;
}

/**
 * Maps a saved answer to one of the form's choices. Free-text fields accept any answer.
 * A bare Yes/No may map to the single choice that begins with that word.
 */
export function matchChoice(answer: string, choices: string[]): string | null {
  if (!choices.length) return answer;
  const wanted = normalizeChoice(answer);
  const exact = choices.filter((choice) => normalizeChoice(choice) === wanted);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  if (wanted === 'yes' || wanted === 'no') {
    const prefixed = choices.filter(
      (choice) => normalizeChoice(choice).split(' ')[0] === wanted,
    );
    if (prefixed.length === 1) return prefixed[0]!;
  }
  return null;
}

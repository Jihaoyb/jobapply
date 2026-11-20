/**
 * Deterministic stand-in for Luna behind the real model wrapper's injectable transport.
 * It is deliberately naive: a lexical similarity score that always claims polarity, time
 * horizon and location agree. Tests rely on that to prove the deterministic guards, not
 * the model, stop high-scoring polarity/time/location flips.
 */
type Override = (
  question: string,
  candidate: string,
) => Partial<{
  equivalent: boolean;
  score: number;
  samePolarity: boolean;
  sameTimeHorizon: boolean;
  sameLocation: boolean;
  ambiguous: boolean;
}> | null;

const synonyms: Record<string, string> = {
  authorized: 'authorized',
  authorization: 'authorized',
  eligible: 'authorized',
  legally: 'authorized',
  legal: 'authorized',
  lawfully: 'authorized',
  sponsorship: 'sponsor',
  sponsor: 'sponsor',
  require: 'require',
  requiring: 'require',
  need: 'require',
  relocate: 'relocate',
  relocating: 'relocate',
  relocation: 'relocate',
  expected: 'expect',
  expectations: 'expect',
  desired: 'expect',
  targeting: 'expect',
  start: 'start',
  available: 'start',
  earliest: 'start',
  url: 'url',
  link: 'url',
  website: 'url',
  currently: 'now',
  presently: 'now',
  now: 'now',
  united: 'us',
  states: 'us',
  usa: 'us',
  u: 'us',
  s: 'us',
  have: 'have',
  hold: 'have',
  open: 'willing',
  willing: 'willing',
  comfortable: 'willing',
  remotely: 'remote',
  older: 'age',
  old: 'age',
  age: 'age',
};
const stop = new Set(
  'a an the you your are is do does did to of in for be will would can could has with or and on at as this that what please our how per any by from e g ever been'.split(
    ' ',
  ),
);
function tokens(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !stop.has(w))
      .map((w) => synonyms[w] ?? w),
  );
}
export function lexicalScore(a: string, b: string) {
  const x = tokens(a),
    y = tokens(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  const union = new Set([...x, ...y]).size;
  return union ? Math.round((shared / union) * 1000) / 1000 : 0;
}

export function fakeLunaTransport(override?: Override) {
  const calls: { question: string; candidates: string[] }[] = [];
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const input = JSON.parse(body.input) as {
      question: string;
      candidates: { candidateId: string; question: string }[];
    };
    calls.push({
      question: input.question,
      candidates: input.candidates.map((c) => c.question),
    });
    const judgments = input.candidates.map((candidate) => {
      const score = lexicalScore(input.question, candidate.question);
      return {
        candidateId: candidate.candidateId,
        equivalent: score >= 0.5,
        score,
        samePolarity: true,
        sameTimeHorizon: true,
        sameLocation: true,
        ambiguous: false,
        ...(override?.(input.question, candidate.question) ?? {}),
      };
    });
    return Response.json({
      status: 'completed',
      model: 'fake-luna',
      usage: { input_tokens: 50, output_tokens: 20 },
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: JSON.stringify({ judgments }) },
          ],
        },
      ],
    });
  }) as typeof fetch;
  return { transport, calls };
}

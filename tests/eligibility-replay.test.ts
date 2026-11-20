import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { eligibilityBaseline } from '../src/server/eligibility/baseline.js';
import { replayGate } from '../src/server/eligibility/decide.js';
import { fixturesSha256, runReplay } from '../src/server/eligibility/replay.js';
import type { ReplayFixture } from '../src/server/eligibility/replay-types.js';
import { rulesFingerprint } from '../src/server/eligibility/rules.js';
import {
  configuredSolModel,
  PROMPT_VERSION,
  promptFingerprint,
} from '../src/server/eligibility/sol.js';

const fixturesPath = new URL(
  './fixtures/eligibility/postings.json',
  import.meta.url,
);
async function loadFixtures() {
  const raw = await readFile(fixturesPath, 'utf8');
  return {
    raw,
    fixtures: (JSON.parse(raw) as { fixtures: ReplayFixture[] }).fixtures,
  };
}

test('labeled replay set covers all three routes and every exact quote exists in its source', async () => {
  const { fixtures } = await loadFixtures();
  assert.ok(
    fixtures.length >= 40 && fixtures.length <= 70,
    `${fixtures.length}`,
  );
  assert.equal(new Set(fixtures.map((f) => f.id)).size, fixtures.length);
  for (const f of fixtures) {
    if (f.expected.quote !== null)
      assert.ok(
        f.text.includes(f.expected.quote),
        `${f.id}: quote not verbatim`,
      );
    if (f.expected.decision === 'excluded')
      assert.ok(f.expected.quote, `${f.id}: an exclusion needs an exact quote`);
    assert.doesNotMatch(
      f.text,
      /@(?!example\.)/,
      `${f.id}: synthetic data only`,
    );
  }
  const count = (pred: (f: ReplayFixture) => boolean) =>
    fixtures.filter(pred).length;
  for (const route of ['exclusion_rule', 'sol', 'no_trigger'] as const)
    assert.ok(count((f) => f.expected.route === route) >= 8, route);
  for (const decision of ['passed', 'excluded', 'review'] as const)
    assert.ok(count((f) => f.expected.decision === decision) >= 8, decision);
  for (const tag of [
    'negation',
    'preference',
    'clearance',
    'citizenship',
    'currently_authorized',
    'opt',
    'itar',
    'sponsorship',
    'conflict',
    'hedge',
    'verification',
    'benign',
    'form',
  ])
    assert.ok(count((f) => f.tags.includes(tag)) >= 1, tag);
  assert.ok(
    count((f) => f.source === 'form' && f.expected.route === 'sol') >= 1,
  );
  assert.ok(
    count(
      (f) => f.source === 'form' && f.expected.route === 'exclusion_rule',
    ) >= 1,
  );
});

test('fake-Sol replay: zero false inclusions and exclusions, separate counts, all-Sol budget', async () => {
  const f = await fixture();
  try {
    const { raw, fixtures } = await loadFixtures();
    const report = await runReplay({
      db: f.db,
      applicantId: f.alice,
      fixtures,
      mode: 'fake',
      solModel: configuredSolModel(),
      rates: { inputUsdPerMTok: 2, outputUsdPerMTok: 8 },
      projectedPostings: 300,
    });
    const m = report.metrics;
    assert.deepEqual(m.falseInclusions, []);
    assert.deepEqual(m.falseExclusions, []);
    assert.deepEqual(m.unexpectedReviews, []);
    assert.deepEqual(m.quoteMismatches, []);
    assert.deepEqual(m.routeMismatches, []);
    const solFixtures = fixtures.filter(
      (x) => x.expected.route === 'sol',
    ).length;
    assert.equal(m.solCalls, solFixtures);
    assert.equal(
      m.solCallShare,
      Number((solFixtures / fixtures.length).toFixed(4)),
    );
    assert.equal(m.failedSolCalls, 1); // the scripted invalid-output fixture
    assert.ok(report.cost);
    const perCall =
      ((m.inputTokens / m.solCalls) * 2 + (m.outputTokens / m.solCalls) * 8) /
      1e6;
    assert.ok(Math.abs(report.cost.allSolPerPostingUsd - perCall) < 1e-6);
    assert.ok(Math.abs(report.cost.allSolProjectedUsd - perCall * 300) < 1e-4);
    // Every model call carries prompt version and measured tokens.
    const calls = (
      await f.db.query('SELECT prompt_version,input_tokens FROM model_calls')
    ).rows;
    assert.ok(calls.every((c) => c.prompt_version === PROMPT_VERSION));
    assert.ok(calls.every((c) => c.input_tokens > 0));
    // Every automatic exclusion's evidence is a literal span of its source.
    const rows = (
      await f.db.query(
        "SELECT source_text,evidence,evidence_start,evidence_end FROM eligibility_decisions WHERE decision='excluded'",
      )
    ).rows;
    assert.equal(rows.length, m.actualByDecision.excluded);
    for (const row of rows)
      assert.equal(
        row.source_text.slice(row.evidence_start, row.evidence_end),
        row.evidence,
      );
    // Replay gate: the recorded baseline must match this exact replay.
    assert.ok(
      eligibilityBaseline.fake,
      'Record a baseline with --fake --write-baseline',
    );
    assert.deepEqual(
      m,
      eligibilityBaseline.fake.metrics,
      'Replay metrics changed: re-run `npm run eligibility:replay -- --fake --write-baseline`',
    );
    assert.equal(eligibilityBaseline.fake.fixturesSha256, fixturesSha256(raw));
  } finally {
    await f.close();
  }
});

test('gate: prompt, rules or model changes require a re-recorded replay baseline', () => {
  const fingerprint = {
    promptVersion: PROMPT_VERSION,
    promptFingerprint: promptFingerprint(),
    rulesFingerprint: rulesFingerprint(),
  };
  const message =
    'Prompt or rules changed. Bump PROMPT_VERSION if the prompt changed, re-run `npm run eligibility:replay -- --fake --write-baseline`, and have a human re-run the live replay.';
  for (const section of [eligibilityBaseline.fake, eligibilityBaseline.live]) {
    if (!section) continue;
    assert.equal(section.promptVersion, fingerprint.promptVersion, message);
    assert.equal(
      section.promptFingerprint,
      fingerprint.promptFingerprint,
      message,
    );
    assert.equal(
      section.rulesFingerprint,
      fingerprint.rulesFingerprint,
      message,
    );
  }
  assert.equal(replayGate(configuredSolModel()).ok, true);
  assert.equal(replayGate('another-sol-model').ok, false);
  const stale = structuredClone(eligibilityBaseline);
  stale.fake!.promptFingerprint = 'changed';
  assert.equal(replayGate(configuredSolModel(), stale).ok, false);
  const live = structuredClone(eligibilityBaseline);
  live.live = { ...live.fake!, solModel: 'gpt-live-snapshot' };
  assert.equal(replayGate('gpt-live-snapshot', live).ok, true);
  assert.equal(replayGate(configuredSolModel(), live).ok, false);
});

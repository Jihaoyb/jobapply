import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, capture, origin } from './helpers.js';
import { modelCaller } from '../src/server/model.js';
import {
  chooseThreshold,
  evaluateAt,
  runCalibration,
  type LabeledPair,
} from '../src/server/answers/calibration.js';
import { guardMismatches } from '../src/server/answers/normalize.js';
import { fakeLunaTransport } from './fixtures/answers/fake-luna.js';

const load = (name: string): LabeledPair[] =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/answers/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const calibration = load('calibration'),
  heldout = load('heldout');

test('handwritten pair sets: 30–50 calibration pairs, a disjoint held-out set, both labels and the PRD categories', () => {
  assert.ok(calibration.length >= 30 && calibration.length <= 50);
  assert.ok(heldout.length >= 15);
  const key = (p: LabeledPair) => `${p.stored}|${p.asked}`.toLowerCase();
  const calibrationKeys = new Set(calibration.map(key));
  assert.ok(heldout.every((p) => !calibrationKeys.has(key(p))));
  assert.equal(
    new Set([...calibration, ...heldout].map((p) => p.id)).size,
    calibration.length + heldout.length,
  );
  for (const set of [calibration, heldout]) {
    assert.ok(set.some((p) => p.label === 'equivalent'));
    assert.ok(set.some((p) => p.label === 'not_equivalent'));
  }
  const categories = new Set(calibration.map((p) => p.category));
  for (const category of [
    'authorization',
    'sponsorship',
    'relocation',
    'salary',
    'start_date',
    'clearance',
  ])
    assert.ok(categories.has(category), category);
  // Tricky negatives exist for each guard dimension.
  const blocked = calibration
    .filter((p) => p.label === 'not_equivalent')
    .flatMap((p) => guardMismatches(p.stored, p.asked));
  for (const reason of ['polarity', 'time_horizon', 'location', 'numbers'])
    assert.ok(blocked.includes(reason), reason);
});

test('threshold selection maximizes recall at the precision target and keeps the higher threshold on ties', () => {
  const pairs: LabeledPair[] = [
    {
      id: 'a',
      category: 'x',
      stored: 'Desired salary',
      asked: 'Expected salary',
      label: 'equivalent',
    },
    {
      id: 'b',
      category: 'x',
      stored: 'Portfolio URL',
      asked: 'Portfolio link',
      label: 'equivalent',
    },
    {
      id: 'c',
      category: 'x',
      stored: 'Convicted of a felony?',
      asked: 'Convicted of a misdemeanor?',
      label: 'not_equivalent',
    },
  ];
  const j = (score: number) => ({
    candidateId: 'c1',
    equivalent: true,
    score,
    samePolarity: true,
    sameTimeHorizon: true,
    sameLocation: true,
    ambiguous: false,
  });
  const chosen = chooseThreshold(pairs, [j(0.9), j(0.8), j(0.7)]);
  assert.equal(chosen.threshold, 0.8);
  assert.equal(chosen.recall, 1);
  assert.equal(chosen.precision, 1);
  assert.deepEqual(
    evaluateAt(pairs, [j(0.9), j(0.8), j(0.7)], 0.7).falsePositives,
    ['c'],
  );
  // A negative scoring above every positive forces the conservative 1.0 fallback.
  assert.equal(chooseThreshold(pairs, [j(0.8), j(0.8), j(0.95)]).recall, 0);
});

test('calibration harness picks the threshold on calibration pairs and reports held-out precision/recall through the model wrapper', async () => {
  const f = await fixture();
  try {
    const job = (
      await f.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { origin, cookie: f.cookie },
        payload: capture(),
      })
    ).json();
    const fake = fakeLunaTransport();
    const callModel = modelCaller(
      f.db,
      { apiKey: 'test', solModel: 'sol', lunaModel: 'luna' },
      fake.transport,
    );
    const report = await runCalibration(
      callModel,
      { applicantId: f.alice, jobId: job.id },
      calibration,
      heldout,
    );
    assert.equal(fake.calls.length, calibration.length + heldout.length);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM model_calls WHERE prompt_version='answer-equivalence-v1'",
        )
      ).rows[0].n,
      calibration.length + heldout.length,
    );
    assert.equal(report.calibration.precision, 1);
    assert.ok(report.calibration.recall > 0.5);
    assert.ok(
      report.calibration.threshold > 0 && report.calibration.threshold <= 1,
    );
    assert.equal(report.heldout.threshold, report.calibration.threshold);
    assert.equal(report.heldout.precision, 1);
    assert.ok(report.heldout.recall > 0);
    assert.equal(report.passed, true);
    // The naive fake scores polarity/time/location flips highly; guards still pause them.
    for (const id of ['n02', 'n04', 'n08', 'n20'])
      assert.ok(report.calibration.pausedDespiteHighScore.includes(id), id);
    // A guard-clean negative (felony vs misdemeanor) is excluded by the chosen threshold.
    assert.ok(!report.calibration.falsePositives.includes('n22'));
  } finally {
    await f.close();
  }
});

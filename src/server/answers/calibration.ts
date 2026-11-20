import {
  decidePair,
  judgeCandidates,
  type CallModel,
  type Judgment,
} from './equivalence.js';

export interface LabeledPair {
  id: string;
  category: string;
  /** Previously approved question in the bank. */
  stored: string;
  /** Question seen on the new form. */
  asked: string;
  label: 'equivalent' | 'not_equivalent';
  note?: string;
}
export interface Metrics {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  falsePositives: string[];
  falseNegatives: string[];
  /** Pairs Luna scored above threshold that a guard or ambiguity flag still paused. */
  pausedDespiteHighScore: string[];
}

/** One Luna call per pair through the shared wrapper, so live runs record provenance. */
export async function scorePairs(
  callModel: CallModel,
  owner: { applicantId: string; jobId: string },
  pairs: LabeledPair[],
): Promise<(Judgment | null)[]> {
  const judgments: (Judgment | null)[] = [];
  for (const pair of pairs) {
    try {
      judgments.push(
        (
          await judgeCandidates(
            callModel,
            owner,
            pair.asked,
            [],
            [{ question: pair.stored }],
          )
        )[0] ?? null,
      );
    } catch {
      judgments.push(null);
    }
  }
  return judgments;
}

export function evaluateAt(
  pairs: LabeledPair[],
  judgments: (Judgment | null)[],
  threshold: number,
): Metrics {
  const m: Metrics = {
    threshold,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    precision: 1,
    recall: 0,
    falsePositives: [],
    falseNegatives: [],
    pausedDespiteHighScore: [],
  };
  pairs.forEach((pair, index) => {
    const decision = decidePair(
      { question: pair.stored },
      { question: pair.asked },
      judgments[index] ?? null,
      threshold,
    );
    if (decision.highScore && !decision.accepted)
      m.pausedDespiteHighScore.push(pair.id);
    const positive = pair.label === 'equivalent';
    if (decision.accepted && positive) m.tp++;
    else if (decision.accepted) {
      m.fp++;
      m.falsePositives.push(pair.id);
    } else if (positive) {
      m.fn++;
      m.falseNegatives.push(pair.id);
    } else m.tn++;
  });
  m.precision = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 1;
  m.recall = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
  return m;
}

/**
 * Picks the threshold with the highest calibration recall whose precision meets the
 * target (default 1.0: a wrong reuse is worse than a pause). Ties keep the higher,
 * more conservative threshold.
 */
export function chooseThreshold(
  pairs: LabeledPair[],
  judgments: (Judgment | null)[],
  minPrecision = 1,
): Metrics {
  const candidates = [
    ...new Set([
      1,
      ...judgments.filter((j) => j?.equivalent).map((j) => j!.score),
    ]),
  ].sort((a, b) => b - a);
  let best: Metrics | null = null;
  for (const threshold of candidates) {
    const metrics = evaluateAt(pairs, judgments, threshold);
    if (metrics.precision < minPrecision) continue;
    if (!best || metrics.recall > best.recall) best = metrics;
  }
  return best ?? evaluateAt(pairs, judgments, 1);
}

export interface CalibrationReport {
  calibration: Metrics & { pairs: number };
  heldout: Metrics & { pairs: number };
  minPrecision: number;
  passed: boolean;
}
export async function runCalibration(
  callModel: CallModel,
  owner: { applicantId: string; jobId: string },
  calibration: LabeledPair[],
  heldout: LabeledPair[],
  minPrecision = 1,
): Promise<CalibrationReport> {
  const calibrationScores = await scorePairs(callModel, owner, calibration);
  const chosen = chooseThreshold(calibration, calibrationScores, minPrecision);
  const heldoutScores = await scorePairs(callModel, owner, heldout);
  const evaluated = evaluateAt(heldout, heldoutScores, chosen.threshold);
  return {
    calibration: { ...chosen, pairs: calibration.length },
    heldout: { ...evaluated, pairs: heldout.length },
    minPrecision,
    passed: evaluated.precision >= minPrecision,
  };
}

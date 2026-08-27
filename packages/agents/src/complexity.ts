import { z } from 'zod';
import type { ComplexityOutput, Requirement, RiskFinding, DataVolumeLevel } from '@repo/shared';
import { ComplexityOutputSchema } from '@repo/shared';

/**
 * Risk flags that mean "this integrates with someone else's API", which is what
 * the API-integration signal is counting.
 *
 * This used to be `rf.includes('api') || rf.includes('rate')`, a substring test
 * over an open vocabulary. It scored on coincidence: any invented flag with
 * "api" anywhere in it counted, `rate-limits` counted through 'rate', and a
 * rename nobody thought was risky would silently move every complexity score.
 * Membership in the shared list is the honest test. AEH-263.
 */
const API_INTEGRATION_RISK_FLAGS = new Set<string>(['rate-limits', 'api-quota']);

// ─── ComplexityRules shape (stored as JSON in EstimationConfig) ───────────────

export const ApiThresholdSchema = z.object({
  minCount: z.number(),
  maxCount: z.number(),
  score: z.number().min(1).max(5),
});

export const ComplexityRulesSchema = z.object({
  apiIntegrationThresholds: z.array(ApiThresholdSchema),
  legacyKeywords: z.array(z.string()),
  legacyScoreBonus: z.number(),
  dataVolumeMultipliers: z.object({ NONE: z.number(), LOW: z.number(), HIGH: z.number() }),
  aiKeywords: z.array(z.string()),
  aiScoreBonus: z.number(),
  perItemMultiplierDefault: z.number().default(1.0),
});

export type ComplexityRules = z.infer<typeof ComplexityRulesSchema>;

export type DetectedFeatures = {
  apiIntegrationCount: number;
  hasLegacy: boolean;
  dataVolume: 'NONE' | 'LOW' | 'HIGH';
  hasAI: boolean;
  taxonomyKeys: string[];
};

// ─── WS12-02: Detector ────────────────────────────────────────────────────────

// Text-based fallback/reinforcement — the Librarian's structured per-requirement
// integrationCount/dataVolume are now the primary signal (see detectFeatures
// below); these keywords still catch cases the Librarian under-called.
const API_INTEGRATION_PATTERNS = [
  /\bapi\b/i, /\bintegrat/i, /\bwebhook/i, /\bsdk\b/i,
  /\bthird.party/i, /\bexternal service/i, /\bpayment gateway/i,
];

const DATA_VOLUME_KEYWORDS: Record<string, 'HIGH' | 'LOW'> = {
  'large dataset': 'HIGH',
  'millions of records': 'HIGH',
  'big data': 'HIGH',
  'bulk import': 'HIGH',
  'data migration': 'HIGH',
  'small dataset': 'LOW',
  'few records': 'LOW',
};

function dataVolumeOrder(v: DataVolumeLevel): number {
  return v === 'High' ? 2 : v === 'Low' ? 1 : 0;
}
function dataVolumeToRuleKey(v: DataVolumeLevel): 'NONE' | 'LOW' | 'HIGH' {
  return v === 'High' ? 'HIGH' : v === 'Low' ? 'LOW' : 'NONE';
}
function ruleKeyOrder(v: 'NONE' | 'LOW' | 'HIGH'): number {
  return v === 'HIGH' ? 2 : v === 'LOW' ? 1 : 0;
}

/**
 * Detect complexity features from requirements + Detective risk findings.
 *
 * Primary signal is now the Librarian's own per-requirement judgment
 * (integrationCount, dataVolume) instead of regex-sniffing the requirement's
 * short text blurb — that regex is what kept scoring every SOW as
 * complexity=1 regardless of actual scope. Text-based keyword matching is
 * kept as a reinforcing fallback (max of the two signals wins), so a
 * requirement the Librarian under-called can still be caught.
 */
export function detectFeatures(
  requirements: Requirement[],
  riskFindings: RiskFinding[],
): DetectedFeatures {
  const allText = [
    ...requirements.map((r) => r.text),
    ...riskFindings.map((f) => f.claim),
  ].join(' ').toLowerCase();

  // Structured signal: sum of the Librarian's per-requirement integration_count.
  const structuredIntegrationCount = requirements.reduce((sum, r) => sum + r.integrationCount, 0);

  // Text-based fallback (legacy regex behaviour, kept as reinforcement).
  const apiMatches = new Set<string>();
  for (const pattern of API_INTEGRATION_PATTERNS) {
    const matches = allText.match(new RegExp(pattern.source, 'gi'));
    if (matches) matches.forEach((m) => apiMatches.add(m.toLowerCase()));
  }
  const flaggedCount = riskFindings.filter((f) =>
    f.riskFlags.some((rf: string) => API_INTEGRATION_RISK_FLAGS.has(rf)),
  ).length;
  const textBasedCount = Math.max(apiMatches.size, flaggedCount);

  const apiIntegrationCount = Math.max(structuredIntegrationCount, textBasedCount);

  // Structured signal: the highest data_volume any requirement was tagged with.
  const structuredVolume = requirements.reduce<DataVolumeLevel>(
    (max, r) => (dataVolumeOrder(r.dataVolume) > dataVolumeOrder(max) ? r.dataVolume : max),
    'None',
  );
  const structuredVolumeKey = dataVolumeToRuleKey(structuredVolume);

  // Text-based fallback.
  let textVolumeKey: 'NONE' | 'LOW' | 'HIGH' = 'NONE';
  for (const [kw, vol] of Object.entries(DATA_VOLUME_KEYWORDS)) {
    if (allText.includes(kw)) {
      textVolumeKey = vol;
      if (vol === 'HIGH') break;
    }
  }

  const dataVolume = ruleKeyOrder(textVolumeKey) > ruleKeyOrder(structuredVolumeKey)
    ? textVolumeKey
    : structuredVolumeKey;

  const taxonomyKeys = [
    ...new Set(requirements.map((r) => r.taxonomyKey).filter((k): k is string => k !== null)),
  ];

  return {
    apiIntegrationCount,
    hasLegacy: false, // legacy keywords checked in scorecard
    dataVolume,
    hasAI: false, // AI keywords checked in scorecard
    taxonomyKeys,
  };
}

// ─── WS12-01: Pure scorecard function ─────────────────────────────────────────

/**
 * Compute complexity score 1-5 and per-item multipliers from detected features + rules.
 * Pure function — no IO.
 */
export function computeComplexityScore(
  features: DetectedFeatures,
  rawRules: unknown,
  allText: string,
): ComplexityOutput {
  const rules = ComplexityRulesSchema.parse(rawRules);

  // Base score from API/integration count
  let baseScore = 1;
  for (const threshold of rules.apiIntegrationThresholds) {
    if (
      features.apiIntegrationCount >= threshold.minCount &&
      features.apiIntegrationCount <= threshold.maxCount
    ) {
      baseScore = threshold.score;
      break;
    }
  }

  // Apply legacy keyword bonus (multiplicative + minimum floor)
  const textLower = allText.toLowerCase();
  const hasLegacy = rules.legacyKeywords.some((kw) => textLower.includes(kw.toLowerCase()));
  if (hasLegacy) {
    baseScore = Math.max(3, Math.min(5, baseScore * rules.legacyScoreBonus));
  }

  // Apply AI keyword bonus (multiplicative + minimum floor of 3)
  const hasAI = rules.aiKeywords.some((kw) => textLower.includes(kw.toLowerCase()));
  if (hasAI) {
    baseScore = Math.max(3, Math.min(5, baseScore * rules.aiScoreBonus));
  }

  // Apply data volume multiplier
  const dvMultiplier = rules.dataVolumeMultipliers[features.dataVolume];
  baseScore = Math.min(5, baseScore * dvMultiplier);

  const score = Math.round(Math.max(1, Math.min(5, baseScore)));

  // Per-item multipliers: one per taxonomy key, scaled by score
  const multiplierValue = 1.0 + (score - 1) * 0.1; // 1.0 at score=1, 1.4 at score=5
  const perItemMultipliers: Record<string, number> = {};
  for (const key of features.taxonomyKeys) {
    perItemMultipliers[key] = Math.round(multiplierValue * 100) / 100;
  }

  return ComplexityOutputSchema.parse({ score, perItemMultipliers });
}

/**
 * Full scorecard pipeline: detect features then score.
 */
export function runComplexityScorecard(
  requirements: Requirement[],
  riskFindings: RiskFinding[],
  complexityRules: unknown,
): ComplexityOutput {
  const features = detectFeatures(requirements, riskFindings);
  const allText = [
    ...requirements.map((r) => r.text),
    ...riskFindings.map((f) => f.claim),
  ].join(' ');
  return computeComplexityScore(features, complexityRules, allText);
}

// ─── Default rules (used as seed value for EstimationConfig) ─────────────────

export const DEFAULT_COMPLEXITY_RULES: ComplexityRules = {
  apiIntegrationThresholds: [
    { minCount: 0, maxCount: 1, score: 1 },
    { minCount: 2, maxCount: 3, score: 3 },
    { minCount: 4, maxCount: 6, score: 4 },
    { minCount: 7, maxCount: 999, score: 5 },
  ],
  legacyKeywords: ['legacy', 'mainframe', 'cobol', 'migration', 'rewrite', 'monolith', 'end-of-life'],
  legacyScoreBonus: 1.5,
  dataVolumeMultipliers: { NONE: 1.0, LOW: 1.1, HIGH: 1.5 },
  aiKeywords: ['machine learning', 'ai assist', 'neural', 'prediction model', 'llm', 'nlp'],
  aiScoreBonus: 1.3,
  perItemMultiplierDefault: 1.0,
};

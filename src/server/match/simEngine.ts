/**
 * simEngine.ts - Dual Monotonic XGBoost Over-by-Over T20 Match Simulation Engine
 * Replaces MatchOverNet with:
 *   1. Model A (Over Runs Predictor): XGBRegressor (objective="count:poisson")
 *   2. Model B (Over Wicket Hazard Predictor): XGBClassifier (objective="binary:logistic")
 *   3. Marsaglia-Tsang Gamma + Poisson Compound Stochastic Sampler
 *   4. Post-Over Scorecard Splitter & Over-by-Over Delivery Commentary
 *
 * 22 Tabular Features strictly matching train_dual_xgboost_sim.py:
 *   [0] innings (1.0 for Innings 1, 2.0 for Innings 2)
 *   [1] over_num (0..19)
 *   [2] wickets_lost (0..10)
 *   [3] par_score_residual
 *   [4] resources_remaining
 *   [5] req_rr_delta
 *   [6] striker_bat
 *   [7] striker_power
 *   [8] striker_creaseDominance
 *   [9] striker_strikeRotation
 *   [10] non_striker_bat
 *   [11] non_striker_strikeRotation
 *   [12] bowler_bowl
 *   [13] bowler_stamina_current
 *   [14] bowler_varietyBias
 *   [15] bowler_phase_synergy
 *   [16] fielding_team_avg_fielding
 *   [17] bat_vs_bowl_diff
 *   [18] surface_matchup
 *   [19] power_pitch_synergy
 *   [20] dew_effect
 *   [21] batter_settled_factor
 */

import * as path from 'path';
import * as fs from 'fs';

import {
  calculatePartnershipSynergy,
  calculateBowlingUnitSynergy,
  type IPLPlayer,
  type GroundSynergyVector
} from '../../types/player.types';

export type BattingTactic = 'DEFENSIVE' | 'BALANCED' | 'AGGRESSIVE';
export type BowlingTactic = 'ATTACK' | 'CONTAIN' | 'STANDARD';

export interface SimEngineConfig {
  determinismRatio: number;      // 0.0 to 1.0 (Default: 0.45 -> 45% deterministic skill anchor, 55% cricket variance)
  skillConsistencyScale: number; // 0.0 to 1.0 (Default: 0.35 -> elite player rating dampens variance)
  matchupSubtlety: number;       // 0.0 to 1.0 (Default: 0.25 -> gentle realistic tactical nudge)
  simAlpha?: number;             // 0.5 to 1.5 (Default: 0.8 -> scales batting SR by alpha, bowling Econ by 2 - alpha)
}

export interface OverInputState {
  overNumber: number;          // 0..19 (Over 1 is index 0)
  innings: 1 | 2;
  currentScore: number;
  wicketsDown: number;
  targetScore?: number;        // Required in 2nd innings chase
  striker: IPLPlayer;
  nonStriker: IPLPlayer;
  bowler: IPLPlayer;
  pitch: GroundSynergyVector;
  battingTactic: BattingTactic;
  bowlingTactic: BowlingTactic;
  strikerBallsFaced: number;
  bowlerOversBowled: number;

  // TEAM BUILD: The other players in the playing XI
  battingTeamLineup?: IPLPlayer[];   // Full 11 batters in batting order
  fieldingTeamLineup?: IPLPlayer[];  // Full 11 players on the field

  // HOME GROUND CONTEXT
  isBattingTeamHome?: boolean;       // Is the batting side playing on their home turf?
  isBowlingTeamHome?: boolean;       // Is the bowling side playing on their home turf?
}

export interface BatterOverScorecard {
  id: string;
  name: string;
  teamId?: string;
  teamName?: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  isOut: boolean;
  dismissalType?: 'bowled' | 'caught' | 'lbw' | 'run out' | 'stumped';
  bowlerDismissedBy?: string;
  strikeRate?: number;
  dismissalText?: string;
}

export interface BowlerOverFigures {
  id: string;
  name: string;
  teamId?: string;
  teamName?: string;
  overs: number;
  maidens: number;
  runsConceded: number;
  wickets: number;
  dots: number;
  economy?: number;
}

export interface BallDetail {
  ballNumber: number;         // 1..6
  ballLabel: string;          // e.g., "14.1"
  strikerName: string;
  nonStrikerName: string;
  bowlerName: string;
  runsOffBat: number;
  extras: number;
  isWicket: boolean;
  wicketType?: string;
  playerOut?: string;
  commentary: string;
}

export interface OverExecutionResult {
  overNumber: number;
  overLabel: string;          // e.g., "Over 15"
  innings: 1 | 2;
  runsScored: number;
  wicketsLost: number;
  muPredicted: number;
  sigmaPredicted: number;
  wicketProbability: number;
  partnershipSynergy: number;
  teamBowlingSynergy: number;
  teamFieldingRating: number;
  battingDepthInShed: number;
  balls: BallDetail[];
  commentary: string[];
  strikerAfterOver: BatterOverScorecard;
  nonStrikerAfterOver: BatterOverScorecard;
  bowlerAfterOver: BowlerOverFigures;
  dismissedBatters: BatterOverScorecard[];
  inningsCumulativeScore: number;
  inningsCumulativeWickets: number;
  isAllOut: boolean;
  isTargetReached: boolean;
}

// =============================================================================
// FAST ZERO-DEPENDENCY MONOTONIC XGBOOST TREE TRAVERSAL
// =============================================================================

interface XGBTree {
  left_children: number[];
  right_children: number[];
  split_indices: number[];
  split_conditions: number[];
  default_left?: number[];
  base_weights?: number[];
}

interface XGBModelJSON {
  learner: {
    learner_model_param: {
      base_score: string | number;
    };
    gradient_booster: {
      model: {
        trees: XGBTree[];
      };
    };
  };
}

function parseBaseScore(raw: string | number): number {
  if (typeof raw === 'number') return raw;
  const cleaned = raw.replace(/[\[\]]/g, '').trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0.5 : val;
}

function traverseTree(tree: XGBTree, features: Float32Array | number[]): number {
  let node = 0;
  while (tree.left_children[node] !== -1 && tree.left_children[node] !== undefined) {
    const featIdx = tree.split_indices[node];
    const splitVal = tree.split_conditions[node];
    const val = features[featIdx];

    if (isNaN(val)) {
      node = (tree.default_left && tree.default_left[node] === 0) ? tree.right_children[node] : tree.left_children[node];
    } else if (val < splitVal) {
      node = tree.left_children[node];
    } else {
      node = tree.right_children[node];
    }
  }
  return tree.split_conditions[node];
}

function predictPoissonRuns(model: XGBModelJSON, features: Float32Array | number[]): number {
  const baseScore = parseBaseScore(model.learner.learner_model_param.base_score);
  let sumLeaves = 0.0;
  const trees = model.learner.gradient_booster.model.trees;
  for (let i = 0; i < trees.length; i++) {
    sumLeaves += traverseTree(trees[i], features);
  }
  // count:poisson margin -> exp(ln(base_score) + sumLeaves)
  return Math.max(0.5, Math.min(36.0, Math.exp(Math.log(baseScore) + sumLeaves)));
}

function predictLogisticWickets(model: XGBModelJSON, features: Float32Array | number[]): number {
  const baseScore = parseBaseScore(model.learner.learner_model_param.base_score);
  // Base margin for binary:logistic is logit(base_score) = ln(base_score / (1 - base_score))
  const baseMargin = Math.log(Math.max(1e-6, baseScore) / Math.max(1e-6, 1.0 - baseScore));
  let sumLeaves = 0.0;
  const trees = model.learner.gradient_booster.model.trees;
  for (let i = 0; i < trees.length; i++) {
    sumLeaves += traverseTree(trees[i], features);
  }
  const z = baseMargin + sumLeaves;
  const p = 1.0 / (1.0 + Math.exp(-z));
  return Math.max(0.02, Math.min(0.75, p));
}

// =============================================================================
// MARSAGLIA-TSANG GAMMA + POISSON STOCHASTIC COMPOUND SAMPLER
// =============================================================================

function sampleStandardNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function sampleGamma(shape: number, scale: number): number {
  if (shape < 1.0) {
    const u = Math.max(1e-12, Math.random());
    return sampleGamma(shape + 1.0, scale) * Math.pow(u, 1.0 / shape);
  }

  const d = shape - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);

  while (true) {
    const z = sampleStandardNormal();
    const v = (1.0 + c * z) ** 3;
    if (v <= 0) continue;
    const u = Math.random();

    if (u < 1.0 - 0.0331 * (z ** 4)) {
      return d * v * scale;
    }
    if (Math.log(u) < 0.5 * z * z + d * (1.0 - v + Math.log(v))) {
      return d * v * scale;
    }
  }
}

function samplePoisson(lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1.0;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }
  const z = sampleStandardNormal();
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}

function stochasticSampleOver(
  muRuns: number,
  pWicket: number,
  strikerPower: number,
  wicketsRemaining: number,
  determinismRatio: number = 0.45
): { runs: number; wickets: number } {
  // 1. Sample Wickets (0, 1, or 2):
  const u = Math.random();
  let wicketsInOver = 0;
  if (u < Math.pow(pWicket, 2.3)) {
    wicketsInOver = 2;
  } else if (u < pWicket) {
    wicketsInOver = 1;
  } else {
    wicketsInOver = 0;
  }
  wicketsInOver = Math.min(wicketsInOver, Math.max(0, wicketsRemaining));

  // 2. Sample Runs (Gamma-Poisson / Overdispersed Compound Sampling):
  const adjMu = Math.max(1.5, muRuns * Math.pow(0.68, wicketsInOver));
  const dispersion = 1.15 + 0.65 * ((strikerPower - 50.0) / 50.0);
  const shape = adjMu / dispersion;
  const scale = dispersion;
  const tildeLambda = sampleGamma(shape, scale);
  const stochasticRuns = Math.min(36, Math.max(0, samplePoisson(tildeLambda)));

  // Blend with determinism anchor
  const runsInOver = Math.round(determinismRatio * adjMu + (1.0 - determinismRatio) * stochasticRuns);

  return {
    runs: Math.min(36, Math.max(0, runsInOver)),
    wickets: wicketsInOver
  };
}

// =============================================================================
// MAIN MATCH SIMULATION ENGINE CLASS
// =============================================================================

export class MatchSimEngine {
  private runsModel: XGBModelJSON | null = null;
  private wicketsModel: XGBModelJSON | null = null;
  private runsModelPath: string;
  private wicketsModelPath: string;
  public config: SimEngineConfig;

  constructor(customModelPath?: string, customConfig?: Partial<SimEngineConfig>) {
    this.runsModelPath = customModelPath || path.resolve(process.cwd(), 'public/models/xgb_runs.json');
    this.wicketsModelPath = path.resolve(process.cwd(), 'public/models/xgb_wickets.json');
    this.config = {
      determinismRatio: 0.45,       // Default: 45% deterministic skill, 55% cricket variance
      skillConsistencyScale: 0.35,  // Elite skill dampens volatility
      matchupSubtlety: 0.25,        // Subtle, gentle matchup advantage
      simAlpha: 0.80,               // Default: 0.8 (user-tunable 0.5 to 1.5)
      ...customConfig
    };
  }

  public setHostRandomnessScale(determinismRatio: number): void {
    this.config.determinismRatio = Math.max(0.0, Math.min(1.0, determinismRatio));
  }

  public setSimAlpha(alpha: number): void {
    this.config.simAlpha = Math.max(0.5, Math.min(1.5, alpha));
  }

  public async init(): Promise<void> {
    if (this.runsModel && this.wicketsModel) return;

    const runsCandidates = [
      this.runsModelPath,
      path.resolve(process.cwd(), 'public/models/xgb_runs.json'),
      path.resolve(process.cwd(), 'dist/models/xgb_runs.json'),
      path.resolve(__dirname, '../../../public/models/xgb_runs.json'),
      path.resolve(__dirname, '../../../../public/models/xgb_runs.json')
    ];

    const wicketsCandidates = [
      this.wicketsModelPath,
      path.resolve(process.cwd(), 'public/models/xgb_wickets.json'),
      path.resolve(process.cwd(), 'dist/models/xgb_wickets.json'),
      path.resolve(__dirname, '../../../public/models/xgb_wickets.json'),
      path.resolve(__dirname, '../../../../public/models/xgb_wickets.json')
    ];

    for (const p of runsCandidates) {
      if (fs.existsSync(p)) {
        try {
          this.runsModel = JSON.parse(fs.readFileSync(p, 'utf-8'));
          this.runsModelPath = p;
          break;
        } catch (e) {
          this.runsModel = null;
        }
      }
    }

    for (const p of wicketsCandidates) {
      if (fs.existsSync(p)) {
        try {
          this.wicketsModel = JSON.parse(fs.readFileSync(p, 'utf-8'));
          this.wicketsModelPath = p;
          break;
        } catch (e) {
          this.wicketsModel = null;
        }
      }
    }

    if (this.runsModel && this.wicketsModel) {
      console.log(`[MatchSimEngine] Successfully loaded Monotonic Dual-XGBoost Models:`);
      console.log(`  -> Over Runs Regressor (Poisson 250 trees) from: ${this.runsModelPath}`);
      console.log(`  -> Over Wickets Classifier (Logistic 250 trees) from: ${this.wicketsModelPath}`);
    } else {
      console.warn('[MatchSimEngine] XGBoost JSON models not found at specified paths; running in calibrated analytical mode.');
    }
  }

  /**
   * Builds the comprehensive 22-tabular feature vector strictly matching train_dual_xgboost_sim.py.
   */
  public buildFeatureVector(state: OverInputState): Float32Array {
    const f = new Float32Array(22);

    const inn = state.innings;
    const o_num = state.overNumber; // 0..19
    const cum_wickets = state.wicketsDown;
    const cum_runs = state.currentScore;
    const target_score = state.targetScore || (cum_runs + 50);

    // [0] innings (1.0 or 2.0)
    f[0] = inn === 1 ? 1.0 : 2.0;

    // [1] over_num (0..19)
    f[1] = o_num;

    // [2] wickets_lost (0..10)
    f[2] = cum_wickets;

    // [3] par_score_residual
    f[3] = cum_runs - (8.6 * o_num * (1.0 - 0.045 * cum_wickets));

    // [4] resources_remaining
    f[4] = Math.pow((20.0 - o_num) / 20.0, 0.85) * (1.0 - 0.085 * cum_wickets);

    // [5] req_rr_delta
    if (inn === 1 || !state.targetScore) {
      f[5] = 0.0;
    } else {
      const current_rr = o_num > 0 ? cum_runs / Math.max(0.5, o_num) : 0.0;
      const balls_left = Math.max(1, 120 - o_num * 6);
      const runs_needed = Math.max(0, target_score - cum_runs);
      const required_rr = (runs_needed / balls_left) * 6.0;
      f[5] = Math.min(15.0, Math.max(-10.0, required_rr - current_rr));
    }

    // [6] striker_bat
    f[6] = state.striker.stats?.bat ?? 68.0;

    // [7] striker_power
    f[7] = state.striker.stats?.power ?? 65.0;

    // [8] striker_creaseDominance
    f[8] = state.striker.tacticalSynergy?.creaseDominance ?? 0.0;

    // [9] striker_strikeRotation
    f[9] = state.striker.tacticalSynergy?.strikeRotation ?? 0.50;

    // [10] non_striker_bat
    f[10] = state.nonStriker.stats?.bat ?? 68.0;

    // [11] non_striker_strikeRotation
    f[11] = state.nonStriker.tacticalSynergy?.strikeRotation ?? 0.50;

    // [12] bowler_bowl
    f[12] = state.bowler.stats?.bowl ?? 68.0;

    // [13] bowler_stamina_current & fatigue scaling
    const bwl_stam_base = state.bowler.stats?.staminaRecov ?? 90.0;
    const bwl_current_stamina = state.bowler.stamina ?? bwl_stam_base;
    f[13] = Math.max(20.0, Math.min(100.0, bwl_current_stamina));

    // Clean striker and bowler fatigue: 1.0 - (currentStamina / player.stats.staminaRecov) [stays gently between 0.0 and 0.25]
    const str_stam_base = state.striker.stats?.staminaRecov ?? 80.0;
    const str_current_stamina = state.striker.stamina ?? str_stam_base;
    const striker_fatigue = Math.max(0.0, Math.min(0.25, 1.0 - (str_current_stamina / str_stam_base)));
    const bowler_fatigue = Math.max(0.0, Math.min(0.25, 1.0 - (bwl_current_stamina / bwl_stam_base)));

    // [14] bowler_varietyBias
    f[14] = state.bowler.tacticalSynergy?.varietyBias ?? 0.0;

    // [15] bowler_phase_synergy
    if (o_num < 6) {
      f[15] = state.bowler.tacticalSynergy?.powerplay ?? 0.33;
    } else if (o_num < 15) {
      f[15] = state.bowler.tacticalSynergy?.middle ?? 0.34;
    } else {
      f[15] = state.bowler.tacticalSynergy?.death ?? 0.33;
    }

    // [16] fielding_team_avg_fielding
    if (state.fieldingTeamLineup && state.fieldingTeamLineup.length > 0) {
      f[16] = state.fieldingTeamLineup.reduce((acc, p) => acc + (p.stats?.fielding ?? 72.0), 0) / state.fieldingTeamLineup.length;
    } else {
      f[16] = 74.0;
    }

    // [17] bat_vs_bowl_diff
    f[17] = 0.5 * (f[6] + f[7]) - f[12];

    // [18] surface_matchup
    const str_gv = state.striker.groundVector ?? {};
    const bwl_gv = state.bowler.groundVector ?? {};
    const bwl_type = state.bowler.bowlType ?? 'PACE';
    if (bwl_type === 'SPIN') {
      f[18] = (str_gv.spin ?? 0.0) - (bwl_gv.spin ?? 0.0);
    } else {
      f[18] = (str_gv.pace ?? 0.0) - (bwl_gv.pace ?? 0.0);
    }

    // [19] power_pitch_synergy
    const pitch_flatness = 1.0 + (state.pitch.power ?? 0.0) * 0.25;
    f[19] = (str_gv.power ?? 0.0) * pitch_flatness;

    // [20] dew_effect
    f[20] = inn === 2 ? ((str_gv.dew ?? 0.0) - (bwl_gv.dew ?? 0.0)) : 0.0;

    // [21] batter_settled_factor
    f[21] = Math.min(1.0, 0.75 + 0.04 * state.strikerBallsFaced);

    return f;
  }

  /**
   * Executes inference across the Monotonic Dual XGBoost models.
   */
  public async predictOverDistribution(features: Float32Array): Promise<{
    mu: number;
    sigma: number;
    wicketLogit: number;
    wicketProb: number;
  }> {
    if (this.runsModel && this.wicketsModel) {
      const mu = predictPoissonRuns(this.runsModel, features);
      const wicketProb = predictLogisticWickets(this.wicketsModel, features);
      const wicketLogit = Math.log(Math.max(1e-6, wicketProb) / Math.max(1e-6, 1.0 - wicketProb));
      const sigma = Math.sqrt(mu);
      return { mu, sigma, wicketLogit, wicketProb };
    }

    // Analytical fallback calibrated to 22-feature dual distribution
    const overIdx = features[1];
    const isDeath = overIdx >= 15;
    const strPwr = features[7];
    const bwlSkill = features[12];
    const batVsBowl = features[17];

    let baseMu = 7.6 + (overIdx / 19.0) * 2.8;
    if (isDeath) baseMu += 2.8;
    baseMu += (batVsBowl * 0.12);
    baseMu += (strPwr - 70.0) * 0.08;
    baseMu -= (bwlSkill - 70.0) * 0.08;

    const mu = Math.max(2.0, Math.min(26.0, baseMu));
    const sigma = Math.sqrt(mu);
    let wProb = 0.26 + (overIdx >= 15 ? 0.08 : 0.0) + (bwlSkill > 85 ? 0.06 : 0.0) - (strPwr > 85 ? 0.04 : 0.0);
    wProb = Math.max(0.08, Math.min(0.65, wProb));
    const wicketLogit = Math.log(wProb / (1.0 - wProb));

    return { mu, sigma, wicketLogit, wicketProb: wProb };
  }

  public sampleOverOutcome(
    dist: { mu: number; sigma: number; wicketProb: number },
    state: OverInputState
  ): { runs: number; wickets: number } {
    let { mu, wicketProb } = dist;

    // Simulation Alpha scale: scales batting run rate (SR) by alpha, bowling control by (2 - alpha)
    const simAlpha = this.config.simAlpha ?? 0.8;
    mu *= simAlpha;

    // Home Ground Advantage
    if (state.isBattingTeamHome) {
      mu *= 1.04;
    }
    if (state.isBowlingTeamHome) {
      mu *= 0.96;
      wicketProb = Math.min(0.65, wicketProb * 1.08);
    }

    // Tailender Clamp (Wickets >= 8 chokes scoring and raises wicket odds)
    if (state.wicketsDown >= 8) {
      mu = Math.max(1.0, mu * 0.65);
      wicketProb = Math.min(0.70, wicketProb * 1.35);
    }

    // Tactical Adjustments
    if (state.battingTactic === 'AGGRESSIVE') {
      mu *= 1.15;
      wicketProb = Math.min(0.70, wicketProb * 1.25);
    } else if (state.battingTactic === 'DEFENSIVE') {
      mu *= 0.80;
      wicketProb = Math.max(0.05, wicketProb * 0.70);
    }

    if (state.bowlingTactic === 'ATTACK') {
      wicketProb = Math.min(0.70, wicketProb * 1.18);
      mu *= 1.05;
    } else if (state.bowlingTactic === 'CONTAIN') {
      mu *= 0.92;
      wicketProb = Math.max(0.05, wicketProb * 0.88);
    }

    const strikerPower = state.striker.stats?.power ?? 70.0;
    const wicketsLeft = Math.max(0, 10 - state.wicketsDown);

    return stochasticSampleOver(mu, wicketProb, strikerPower, wicketsLeft, this.config.determinismRatio);
  }

  /**
   * Helper function generating vivid, broadcast-grade delivery commentary.
   */
  public static generateDeliveryCommentary(
    ballLabel: string,
    bowlerName: string,
    strikerName: string,
    runs: number,
    isWicket: boolean,
    wicketType?: string,
    overNumber: number = 0
  ): string {
    const isPowerplay = overNumber < 6;
    const isMiddle = overNumber >= 6 && overNumber < 15;
    const isDeath = overNumber >= 15;

    if (isWicket) {
      const wType = (wicketType || 'caught').toLowerCase();
      if (wType === 'bowled') {
        const phrases = [
          `OUT! BOWLED HIM! Timber! ${bowlerName} uproots the off-stump with an unplayable delivery!`,
          `OUT! BOWLED! Searing yorker sneaks under the blade and rattles the furniture!`,
          `OUT! CLEAN BOWLED! Beaten for pace and the stumps are shattered!`
        ];
        return `${ballLabel} ${bowlerName} to ${strikerName}, ${phrases[Math.floor(Math.random() * phrases.length)]}`;
      }
      if (wType === 'caught') {
        const phrases = isDeath
          ? [
              `OUT! CAUGHT! Slices it high towards deep mid-wicket, fielder judges it to perfection!`,
              `OUT! CAUGHT! Skied into the night sky, safe pair of hands under the high ball at long-on!`
            ]
          : isPowerplay
          ? [
              `OUT! CAUGHT! Aerial slash over backward point, spectacular diving catch inside the ring!`,
              `OUT! CAUGHT! Leading edge loops to cover, simple regulation catch taken!`
            ]
          : [
              `OUT! CAUGHT! Holes out to long-off! Mistimes the lofted drive, straight down the throat of the fielder!`,
              `OUT! CAUGHT! Sharp edge flies to the keeper who takes a stunning reaction catch!`
            ];
        return `${ballLabel} ${bowlerName} to ${strikerName}, ${phrases[Math.floor(Math.random() * phrases.length)]}`;
      }
      if (wType === 'lbw') {
        return `${ballLabel} ${bowlerName} to ${strikerName}, OUT! LBW! Huge appeal and the umpire raises the finger! Trapped plumb in front!`;
      }
      if (wType === 'stumped') {
        return `${ballLabel} ${bowlerName} to ${strikerName}, OUT! STUMPED! Deceived in flight and beaten by the turn, keeper whips the bails off in a flash!`;
      }
      return `${ballLabel} ${bowlerName} to ${strikerName}, OUT! ${wType.toUpperCase()}! Precision bowling breakthrough!`;
    }

    if (runs === 0) {
      const phrases = isDeath
        ? [
            `no run, brilliant pinpoint yorker right in the blockhole! Defended with difficulty.`,
            `no run, excellent change of pace with a well-disguised slower ball, batsman beaten outside off.`,
            `no run, fired in full and wide, batsman swings and misses!`
          ]
        : isMiddle
        ? [
            `no run, turning sharply off the deck, pushed back defensively to the bowler.`,
            `no run, tight line and length on off-stump, building up the pressure.`,
            `no run, tossed up nicely, driven straight to extra cover.`
          ]
        : [
            `no run, beautiful swinging delivery leaves the batter wondering outside off.`,
            `no run, good length delivery defended solidly from the crease.`,
            `no run, angled across the right-hander, left alone to the keeper.`
          ];
      return `${ballLabel} ${bowlerName} to ${strikerName}, ${phrases[Math.floor(Math.random() * phrases.length)]}`;
    }

    if (runs === 1) {
      const phrases = [
        `1 run, pushed into the gap at mid-wicket for a sharp single.`,
        `1 run, nudged down to third man to rotate the strike.`,
        `1 run, worked off the hips towards deep backward square leg.`
      ];
      return `${ballLabel} ${bowlerName} to ${strikerName}, ${phrases[Math.floor(Math.random() * phrases.length)]}`;
    }

    if (runs === 2) {
      const phrases = [
        `2 runs, clipped through mid-wicket, aggressive running turns one into two!`,
        `2 runs, steered fine past point, good hustle between the wickets for a brace.`
      ];
      return `${ballLabel} ${bowlerName} to ${strikerName}, ${phrases[Math.floor(Math.random() * phrases.length)]}`;
    }

    if (runs === 4) {
      const phrases = isDeath
        ? [
            `FOUR! Smashed down the ground past mid-off, bullet boundary in the death overs!`,
            `FOUR! Innovative ramp shot over short fine leg, runs away to the fence!`
          ]
        : isPowerplay
        ? [
            `FOUR! Over the infield! Aerial loft over extra cover, clears the ring easily!`,
            `FOUR! Cracking stroke through the covers, pure timing and elegance!`
          ]
        : [
            `FOUR! Pierces the gap between deep cover and long-off with surgical precision!`,
            `FOUR! Short delivery pulled fiercely through backward square leg!`
          ];
      return `${ballLabel} ${bowlerName} to ${strikerName}, ${phrases[Math.floor(Math.random() * phrases.length)]}`;
    }

    if (runs === 6) {
      const phrases = isDeath
        ? [
            `SIX! Sits back and launches a massive monster maximum over long-on!`,
            `SIX! Helicopter stroke into the top tier! Unreal power hitting!`
          ]
        : isPowerplay
        ? [
            `SIX! Picked up off the pads and dispatched deep into the mid-wicket stands!`,
            `SIX! Powerplay fireworks! Lofted cleanly straight down the ground!`
          ]
        : [
            `SIX! Dances down the track and lofts it inside-out over long-off! Majestic hit!`,
            `SIX! Huge strike! In the slot and dispatched onto the stadium roof!`
          ];
      return `${ballLabel} ${bowlerName} to ${strikerName}, ${phrases[Math.floor(Math.random() * phrases.length)]}`;
    }

    return `${ballLabel} ${bowlerName} to ${strikerName}, ${runs} runs.`;
  }

  /**
   * Post-Over Scorecard Splitter:
   * Splits simulated Over runs and wickets across 6 real deliveries,
   * tracking striker rotation on odd runs (1, 3), end-of-over handover,
   * commentary generation, and individual scorecard updates.
   */
  public executePostOverSplitter(
    state: OverInputState,
    totalRuns: number,
    totalWickets: number,
    strikerScorecard: BatterOverScorecard,
    nonStrikerScorecard: BatterOverScorecard,
    bowlerFigures: BowlerOverFigures,
    benchBatters: IPLPlayer[] = []
  ): OverExecutionResult {
    let activeStriker = { ...strikerScorecard };
    let activeNonStriker = { ...nonStrikerScorecard };
    let updatedBowler = { ...bowlerFigures };

    const balls: BallDetail[] = [];
    const commentary: string[] = [];
    const dismissedBatters: BatterOverScorecard[] = [];

    const wicketDeliveries = new Set<number>();
    if (totalWickets > 0) {
      const candidates = [1, 2, 3, 4, 5, 6].sort(() => Math.random() - 0.5);
      for (let w = 0; w < totalWickets; w++) {
        wicketDeliveries.add(candidates[w]);
      }
    }

    let runsToDistribute = totalRuns;
    let cumScore = state.currentScore;
    let cumWickets = state.wicketsDown;
    let benchIdx = 0;

    for (let ballIdx = 1; ballIdx <= 6; ballIdx++) {
      const isWicketBall = wicketDeliveries.has(ballIdx);
      const ballLabel = `${state.overNumber}.${ballIdx}`;

      let comm = '';
      let wType: 'bowled' | 'caught' | 'lbw' | 'run out' | 'stumped' | undefined = undefined;
      let playerOut: string | undefined = undefined;
      let r = 0;

      if (isWicketBall) {
        cumWickets += 1;
        playerOut = activeStriker.name;
        activeStriker.balls += 1;
        activeStriker.isOut = true;
        activeStriker.bowlerDismissedBy = updatedBowler.name;

        const methods: Array<'caught' | 'bowled' | 'lbw' | 'stumped'> = ['caught', 'bowled', 'lbw', 'caught'];
        wType = methods[Math.floor(Math.random() * methods.length)];
        activeStriker.dismissalType = wType;
        updatedBowler.wickets += 1;
        updatedBowler.dots += 1;

        dismissedBatters.push({ ...activeStriker });

        comm = MatchSimEngine.generateDeliveryCommentary(
          ballLabel,
          updatedBowler.name,
          activeStriker.name,
          0,
          true,
          wType,
          state.overNumber
        );

        if (cumWickets < 10 && benchIdx < benchBatters.length) {
          const newBatter = benchBatters[benchIdx++];
          activeStriker = {
            id: newBatter.id,
            name: newBatter.name,
            runs: 0,
            balls: 0,
            fours: 0,
            sixes: 0,
            isOut: false
          };
          comm += ` New batter in is ${activeStriker.name}.`;
        }
      } else {
        const strikerObj = state.battingTeamLineup?.find(p => p.name === activeStriker.name) ||
          (activeStriker.name === state.striker.name ? state.striker : state.nonStriker);
        const batSkill = strikerObj?.stats?.bat ?? 70;
        const pwrSkill = strikerObj?.stats?.power ?? 70;
        const isTailender = (batSkill < 65 && pwrSkill < 70 && strikerObj?.role !== 'BAT' && strikerObj?.role !== 'WK' && strikerObj?.role !== 'AR');

        const remainingNonWicketBalls = [ballIdx, ballIdx + 1, ballIdx + 2, ballIdx + 3, ballIdx + 4, ballIdx + 5, ballIdx + 6]
          .filter(b => b <= 6 && !wicketDeliveries.has(b)).length;

        if (runsToDistribute <= 0) {
          r = 0;
        } else if (isTailender) {
          if (runsToDistribute >= 4 && batSkill >= 55 && Math.random() < 0.10) {
            r = 4;
          } else if (runsToDistribute >= 2 && Math.random() < 0.25) {
            r = 2;
          } else if (runsToDistribute >= 1) {
            r = 1;
          } else {
            r = 0;
          }
        } else {
          const homeBoundBoost = state.isBattingTeamHome ? 0.06 : 0.0;
          if (runsToDistribute >= 6 && (pwrSkill >= 80 || runsToDistribute >= remainingNonWicketBalls * 2 + 4) && Math.random() < (0.55 + homeBoundBoost)) {
            r = 6;
          } else if (runsToDistribute >= 4 && (batSkill >= 75 || runsToDistribute >= remainingNonWicketBalls * 2) && Math.random() < (0.60 + homeBoundBoost)) {
            r = 4;
          } else if (runsToDistribute >= 2 && Math.random() < 0.30) {
            r = 2;
          } else if (runsToDistribute >= 1) {
            r = 1;
          } else {
            r = 0;
          }
        }

        if (remainingNonWicketBalls === 1) {
          r = Math.min(isTailender ? 4 : 6, runsToDistribute);
        }

        r = Math.min(runsToDistribute, r);
        runsToDistribute -= r;

        activeStriker.runs += r;
        activeStriker.balls += 1;
        if (r === 4) activeStriker.fours += 1;
        if (r === 6) activeStriker.sixes += 1;

        updatedBowler.runsConceded += r;
        if (r === 0) updatedBowler.dots += 1;
        cumScore += r;

        comm = MatchSimEngine.generateDeliveryCommentary(
          ballLabel,
          updatedBowler.name,
          activeStriker.name,
          r,
          false,
          undefined,
          state.overNumber
        );

        if (r % 2 === 1) {
          const temp = activeStriker;
          activeStriker = activeNonStriker;
          activeNonStriker = temp;
        }
      }

      balls.push({
        ballNumber: ballIdx,
        ballLabel,
        strikerName: activeStriker.name,
        nonStrikerName: activeNonStriker.name,
        bowlerName: updatedBowler.name,
        runsOffBat: r,
        extras: 0,
        isWicket: isWicketBall,
        wicketType: wType,
        playerOut,
        commentary: comm
      });
      commentary.push(comm);

      if (state.innings === 2 && state.targetScore && cumScore >= state.targetScore) break;
      if (cumWickets >= 10) break;
    }

    updatedBowler.overs += 1;
    if (totalRuns === 0) {
      updatedBowler.maidens += 1;
    }

    const endOfOverStriker = activeNonStriker;
    const endOfOverNonStriker = activeStriker;

    const partnershipSynergy = calculatePartnershipSynergy(state.striker, state.nonStriker);

    let bwlUnitSyn = 0.5;
    let teamFldRating = 75;
    if (state.fieldingTeamLineup && state.fieldingTeamLineup.length > 0) {
      const bwlObj = calculateBowlingUnitSynergy(state.fieldingTeamLineup.filter(p => p.isBowlingCapable));
      bwlUnitSyn = bwlObj.overallSynergy;
      teamFldRating = Math.round(state.fieldingTeamLineup.reduce((acc, p) => acc + (p.stats?.fielding || 72), 0) / state.fieldingTeamLineup.length);
    }

    let batDepth = 75;
    if (state.battingTeamLineup && state.battingTeamLineup.length > 0) {
      const unbatted = state.battingTeamLineup.slice(Math.min(state.battingTeamLineup.length, state.wicketsDown + 2));
      if (unbatted.length > 0) {
        batDepth = Math.round(unbatted.reduce((acc, p) => acc + (p.stats?.ovr || 70), 0) / unbatted.length);
      }
    }

    return {
      overNumber: state.overNumber + 1,
      overLabel: `Over ${state.overNumber + 1}`,
      innings: state.innings,
      runsScored: totalRuns,
      wicketsLost: totalWickets,
      muPredicted: 0,
      sigmaPredicted: 0,
      wicketProbability: 0,
      partnershipSynergy,
      teamBowlingSynergy: bwlUnitSyn,
      teamFieldingRating: teamFldRating,
      battingDepthInShed: batDepth,
      balls,
      commentary,
      strikerAfterOver: endOfOverStriker,
      nonStrikerAfterOver: endOfOverNonStriker,
      bowlerAfterOver: updatedBowler,
      dismissedBatters,
      inningsCumulativeScore: cumScore,
      inningsCumulativeWickets: cumWickets,
      isAllOut: cumWickets >= 10,
      isTargetReached: !!(state.innings === 2 && state.targetScore && cumScore >= state.targetScore)
    };
  }

  /**
   * Main Public API: Executes an entire Over simulation end-to-end.
   */
  public async simulateOver(
    state: OverInputState,
    strikerScorecard: BatterOverScorecard,
    nonStrikerScorecard: BatterOverScorecard,
    bowlerFigures: BowlerOverFigures,
    benchBatters: IPLPlayer[] = []
  ): Promise<OverExecutionResult> {
    await this.init();

    // 1. Build comprehensive 22-tabular feature vector
    const features = this.buildFeatureVector(state);

    // 2. Predict distribution from Dual Monotonic XGBoost models
    const dist = await this.predictOverDistribution(features);

    // 3. Compound Gamma-Poisson stochastic sampling
    const sampled = this.sampleOverOutcome(dist, state);

    // 4. Execute Post-Over Scorecard Splitter
    const result = this.executePostOverSplitter(
      state,
      sampled.runs,
      sampled.wickets,
      strikerScorecard,
      nonStrikerScorecard,
      bowlerFigures,
      benchBatters
    );

    result.muPredicted = Math.round(dist.mu * 100) / 100;
    result.sigmaPredicted = Math.round(dist.sigma * 100) / 100;
    result.wicketProbability = Math.round(dist.wicketProb * 1000) / 1000;

    return result;
  }
}

export const generateDeliveryCommentary = MatchSimEngine.generateDeliveryCommentary;

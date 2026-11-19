/**
 * simEngine.ts - Unified Over-by-Over T20 Match Simulation Engine & Post-Over Scorecard Splitter
 * Powered by MatchOverNet (Model 1 - Unified 36 Features) via onnxruntime-node.
 * 
 * Comprehensive 36-Feature Pipeline:
 * [ Match State (0..4) ]
 *   0: over_number_norm (k / 19.0)
 *   1: innings_norm (0.0 for inn 1, 1.0 for inn 2)
 *   2: current_score_norm (score / 200.0)
 *   3: wickets_down_norm (wickets / 9.0)
 *   4: req_run_rate_norm (RRR / 12.0)
 * 
 * [ Active Striker & Non-Striker Full Cards (5..11) ]
 *   5: striker_bat
 *   6: striker_power
 *   7: striker_avg_norm (batAvg / 45.0)
 *   8: striker_sr_norm (strikeRate / 160.0)
 *   9: non_striker_bat
 *  10: non_striker_power
 *  11: batting_pair_crease_synergy (LHB/RHB + Anchor/Aggressor dynamic)
 * 
 * [ Active Bowler Full Card & Matchup (12..16) ]
 *  12: bowler_bowl
 *  13: bowler_econ_diff ((econ - 8.5) / 5.0)
 *  14: bowler_strike_rate_norm (20.0 / bowlStrikeRate)
 *  15: bowler_phase_suitability (PP / Mid / Death)
 *  16: tactical_matchup_bonus (e.g. LHB vs Offbreak / RHB vs Left-arm pace)
 * 
 * [ Stadium & Player-Ground Interaction (17..20) ]
 *  17: striker_venue_synergy (striker's personal groundVector on this pitch)
 *  18: bowler_venue_synergy (bowler's personal groundVector on this pitch)
 *  19: venue_power_short_boundary (highway boundary bias)
 *  20: venue_dew_factor (2nd innings wet ball penalty)
 * 
 * [ Tactical Intent & Workload Fatigue (21..25) ]
 *  21: batting_tactic_defensive
 *  22: batting_tactic_aggressive
 *  23: bowling_tactic_attacking_field
 *  24: striker_fatigue (balls faced & staminaRecov)
 *  25: bowler_fatigue (overs bowled & staminaRecov)
 * 
 * [ TEAM BUILD: Dugout Pavilion & Fielding Unit (26..31) ]
 *  26: team_batting_depth_in_shed (avg OVR of remaining batters in pavilion)
 *  27: team_power_reserve_in_shed (top power score waiting in dugout - license to attack)
 *  28: team_tail_exposure_penalty (1.0 if wickets >= 6 and pure tailenders next)
 *  29: team_bowling_unit_synergy (collective 11-man unit variety and phase coverage)
 *  30: team_fielding_unit_rating (avg fielding rating of 11 fielders on the field)
 *  31: is_specialist_bowler (1.0 for primary specialist, 0.0 for emergency part-timer)
 * 
 * [ Physical Experience & Reserve (32..35) ]
 *  32: bowler_spell_overs_left (overs left / 4.0)
 *  33: striker_age_experience_norm (age / 40.0)
 *  34: striker_injury_risk_discount (stamina/injury scalar)
 *  35: bowler_injury_risk_discount (stamina/injury scalar)
 */

import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import {
  calculatePartnershipSynergy,
  calculateBowlingUnitSynergy,
  type IPLPlayer,
  type GroundSynergyVector
} from '../../src/types/player.types.ts';

const require = createRequire(import.meta.url);
let ort: any = null;
try {
  ort = require('onnxruntime-node');
} catch (e) {
  ort = null;
}

export type BattingTactic = 'DEFENSIVE' | 'BALANCED' | 'AGGRESSIVE';
export type BowlingTactic = 'ATTACK' | 'CONTAIN' | 'STANDARD';

export interface SimEngineConfig {
  determinismRatio: number;      // 0.0 to 1.0 (Default: 0.45 -> 45% deterministic skill anchor, 55% cricket variance)
  skillConsistencyScale: number; // 0.0 to 1.0 (Default: 0.35 -> elite player rating dampens variance)
  matchupSubtlety: number;       // 0.0 to 1.0 (Default: 0.25 -> gentle realistic tactical nudge)
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
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  isOut: boolean;
  dismissalType?: 'bowled' | 'caught' | 'lbw' | 'run out' | 'stumped';
  bowlerDismissedBy?: string;
}

export interface BowlerOverFigures {
  id: string;
  name: string;
  overs: number;
  maidens: number;
  runsConceded: number;
  wickets: number;
  dots: number;
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

export class MatchSimEngine {
  private session: any = null;
  private modelPath: string;
  public config: SimEngineConfig;

  constructor(customModelPath?: string, customConfig?: Partial<SimEngineConfig>) {
    this.modelPath = customModelPath || path.resolve(process.cwd(), 'public/models/match_over_net.onnx');
    this.config = {
      determinismRatio: 0.45,       // Default: 45% deterministic skill, 55% variance
      skillConsistencyScale: 0.35,  // Elite skill dampens volatility
      matchupSubtlety: 0.25,        // Subtle, gentle matchup advantage
      ...customConfig
    };
  }

  /**
   * Host configuration setting: adjust determinism ratio before auction/sim.
   * e.g. 0.45 = standard skill-anchored balance; 0.20 = wild chaos; 0.70 = tight chess.
   */
  public setHostRandomnessScale(determinismRatio: number): void {
    this.config.determinismRatio = Math.max(0.0, Math.min(1.0, determinismRatio));
  }

  public async init(): Promise<void> {
    if (this.session) return;

    if (!ort) {
      console.warn('[MatchSimEngine] onnxruntime-node not available; running in analytical high-fidelity mode.');
      return;
    }

    if (!fs.existsSync(this.modelPath)) {
      const altPath = path.resolve(process.cwd(), 'dist/models/match_over_net.onnx');
      if (fs.existsSync(altPath)) {
        this.modelPath = altPath;
      } else {
        console.warn(`[MatchSimEngine] ONNX model not found at ${this.modelPath}; using analytical calibrated mode.`);
        return;
      }
    }

    try {
      this.session = await ort.InferenceSession.create(this.modelPath);
      console.log(`[MatchSimEngine] Loaded MatchOverNet (Unified 36-Feature) ONNX model from: ${this.modelPath}`);
    } catch (err) {
      console.error('[MatchSimEngine] Failed to create ONNX session:', err);
    }
  }

  /**
   * Builds the comprehensive 36-float active feature vector.
   * Incorporates player cards, stadium ground vectors, and full team build dynamics.
   */
  public buildFeatureVector(state: OverInputState): Float32Array {
    const f = new Float32Array(36);

    // [ Match State (0..4) ]
    f[0] = state.overNumber / 19.0;
    f[1] = state.innings === 2 ? 1.0 : 0.0;
    f[2] = Math.min(1.5, state.currentScore / 200.0);
    f[3] = Math.min(1.0, state.wicketsDown / 9.0);

    if (state.innings === 2 && state.targetScore) {
      const ballsLeft = Math.max(6, (20 - state.overNumber) * 6);
      const runsNeeded = Math.max(0, state.targetScore - state.currentScore);
      const rrr = runsNeeded / (ballsLeft / 6.0);
      f[4] = Math.min(2.0, rrr / 12.0);
    } else {
      f[4] = 0.0;
    }

    // [ Active Striker & Non-Striker Full Cards (5..11) ]
    f[5] = (state.striker.stats.bat || 70) / 100.0;
    f[6] = (state.striker.stats.power || 70) / 100.0;
    f[7] = Math.min(1.5, (state.striker.historical?.batAvg || 28.0) / 45.0);
    f[8] = Math.min(1.5, (state.striker.historical?.strikeRate || 135.0) / 160.0);
    f[9] = (state.nonStriker.stats.bat || 70) / 100.0;
    f[10] = (state.nonStriker.stats.power || 70) / 100.0;
    f[11] = calculatePartnershipSynergy(state.striker, state.nonStriker);

    // [ Active Bowler Card & Matchup (12..16) ]
    f[12] = (state.bowler.stats.bowl || 70) / 100.0;
    const bwlEcon = state.bowler.historical?.bowlEcon || 8.8;
    f[13] = Math.max(-1.0, Math.min(1.0, (bwlEcon - 8.5) / 5.0));
    const bwlBsr = state.bowler.historical?.bowlStrikeRate || 24.0;
    f[14] = Math.min(1.5, 20.0 / Math.max(12.0, bwlBsr));

    const bwlSyn = state.bowler.tacticalSynergy;
    if (state.overNumber <= 5) {
      f[15] = bwlSyn?.powerplay ?? 0.35;
    } else if (state.overNumber <= 14) {
      f[15] = bwlSyn?.middle ?? 0.35;
    } else {
      f[15] = bwlSyn?.death ?? 0.30;
    }

    // Tactical Matchup (Gentle, realistic nudge: not overpowering)
    let matchup = 0.0;
    const sub = this.config.matchupSubtlety; // Default 0.25
    if (state.striker.batHand === 'LHB' && state.bowler.bowlType === 'SPIN' && state.bowler.bowlArm === 'R') {
      matchup = 0.12 * (sub / 0.25);  // Subtle LHB advantage vs right-arm off-spin
    } else if (state.striker.batHand === 'RHB' && state.bowler.bowlArm === 'L' && state.bowler.bowlType === 'PACE') {
      matchup = -0.10 * (sub / 0.25); // Subtle left-arm swing danger to RHB
    } else if (state.striker.batHand === 'LHB' && state.bowler.subType === 'WRIST_SPINNER') {
      matchup = -0.08 * (sub / 0.25); // Subtle wrist spinner turn-away
    }
    f[16] = Math.max(-1.0, Math.min(1.0, matchup));

    // [ Stadium & Player-Ground Interaction (17..20) ]
    // Personal groundVector interaction with pitch
    const strGv = state.striker.groundVector;
    const bwlGv = state.bowler.groundVector;
    const pSpin = state.pitch.spin || 0.0;
    const pPace = state.pitch.pace || 0.0;

    let strVenue = 0.0;
    let bwlVenue = 0.0;
    if (Math.abs(pSpin) > Math.abs(pPace)) {
      strVenue = (strGv?.spin ?? 0.0) * pSpin;
      bwlVenue = (bwlGv?.spin ?? 0.0) * pSpin;
    } else {
      strVenue = (strGv?.pace ?? 0.0) * pPace;
      bwlVenue = (bwlGv?.pace ?? 0.0) * pPace;
    }

    // Home Turf Familiarity & Pitch Mastery Amplification
    if (state.isBattingTeamHome) strVenue = Math.min(1.0, strVenue * 1.30 + 0.05);
    if (state.isBowlingTeamHome) bwlVenue = Math.min(1.0, bwlVenue * 1.30 + 0.05);

    f[17] = Math.max(-1.0, Math.min(1.0, strVenue));
    f[18] = Math.max(-1.0, Math.min(1.0, bwlVenue));
    f[19] = state.pitch.power || 0.0;
    f[20] = state.innings === 2 ? (state.pitch.dew || 0.0) : 0.0;

    // [ Tactical Intent & Workload Fatigue (21..25) ]
    f[21] = state.battingTactic === 'DEFENSIVE' ? 1.0 : 0.0;
    f[22] = state.battingTactic === 'AGGRESSIVE' ? 1.0 : 0.0;
    f[23] = state.bowlingTactic === 'ATTACK' ? 1.0 : 0.0;

    const strStamina = state.striker.stats.staminaRecov || 85;
    f[24] = Math.min(1.0, Math.max(0.0, (state.strikerBallsFaced - 25) / 50.0) * (95.0 / Math.max(60, strStamina)));
    const bwlStamina = state.bowler.stats.staminaRecov || 85;
    f[25] = Math.min(1.0, (state.bowlerOversBowled / 4.0) * (95.0 / Math.max(60, bwlStamina)));

    // [ TEAM BUILD: Batting Dugout in Shed & Bowling Unit (26..31) ]
    // Unbatted players in the dugout
    if (state.battingTeamLineup && state.battingTeamLineup.length > 0) {
      // Find batters who are yet to bat (indices >= wicketsDown + 2)
      const unbatted = state.battingTeamLineup.slice(Math.min(state.battingTeamLineup.length, state.wicketsDown + 2));
      if (unbatted.length > 0) {
        const avgOvr = unbatted.reduce((acc, p) => acc + (p.stats.ovr || 70), 0) / unbatted.length;
        const maxPwr = Math.max(...unbatted.map(p => p.stats.power || 65));
        f[26] = avgOvr / 100.0;
        f[27] = maxPwr / 100.0; // License to attack (e.g. Russell/Rinku in shed)
        f[28] = (state.wicketsDown >= 6 && avgOvr < 72) ? 1.0 : 0.0; // Tail exposed
      } else {
        f[26] = 0.60;
        f[27] = 0.50;
        f[28] = 1.0;
      }
    } else {
      f[26] = 0.76;
      f[27] = 0.80;
      f[28] = state.wicketsDown >= 7 ? 1.0 : 0.0;
    }

    // Fielding team bowling unit synergy and team fielding average
    if (state.fieldingTeamLineup && state.fieldingTeamLineup.length > 0) {
      const bowlingSynergyObj = calculateBowlingUnitSynergy(state.fieldingTeamLineup.filter(p => p.isBowlingCapable));
      f[29] = bowlingSynergyObj.overallSynergy;
      const teamFldAvg = state.fieldingTeamLineup.reduce((acc, p) => acc + (p.stats.fielding || 72), 0) / state.fieldingTeamLineup.length;
      f[30] = teamFldAvg / 100.0;
    } else {
      f[29] = 0.50;
      f[30] = 0.78;
    }

    f[31] = (state.bowler.role in { PACE: 1, SPIN: 1, AR: 1 } || state.bowler.isBowlingCapable) ? 1.0 : 0.30;

    // [ Physical Experience & Reserve (32..35) ]
    f[32] = Math.max(0.0, 4.0 - state.bowlerOversBowled) / 4.0;
    f[33] = Math.min(1.0, (state.striker.age || 27) / 40.0);
    f[34] = state.striker.stats.injuryRisk || 0.10;
    f[35] = state.bowler.stats.injuryRisk || 0.12;

    return f;
  }

  /**
   * Executes inference on the 36-float vector to obtain [mu, sigma, wicket_logit].
   */
  public async predictOverDistribution(features: Float32Array): Promise<{
    mu: number;
    sigma: number;
    wicketLogit: number;
    wicketProb: number;
  }> {
    if (this.session && ort) {
      try {
        const tensor = new ort.Tensor('float32', features, [1, 36]);
        const results = await this.session.run({ features: tensor });
        const output = results.over_distribution || Object.values(results)[0];
        const data = output.data as Float32Array;

        const mu = Math.max(0.0, Math.min(26.0, data[0]));
        const sigma = Math.max(1.5, Math.min(8.0, data[1]));
        const wicketLogit = data[2];
        const wicketProb = Math.min(0.65, Math.max(0.05, 1.0 / (1.0 + Math.exp(-wicketLogit))));

        return { mu, sigma, wicketLogit, wicketProb };
      } catch (err) {
        console.warn('[MatchSimEngine] ONNX inference error; falling back to calibrated model:', err);
      }
    }

    // High-fidelity analytical fallback matching 36-feature MatchOverNet distribution
    const overIdx = features[0] * 19.0;
    const isDeath = overIdx >= 15;
    const strPwr = features[6];
    const bwlSkill = features[12];
    const batDepth = features[26];
    const pwrReserve = features[27];
    const isAggressive = features[22] === 1.0;
    const isDefensive = features[21] === 1.0;

    let baseMu = 7.5 + (overIdx / 19.0) * 3.5;
    if (isDeath) baseMu += 3.0;
    baseMu += (strPwr - 0.70) * 5.0;
    baseMu -= (bwlSkill - 0.70) * 5.0;
    // Team build impact: Deep batting with power in shed gives freedom to attack!
    baseMu += (pwrReserve - 0.70) * 2.5 + (batDepth - 0.70) * 2.0;
    if (isAggressive) baseMu += 3.0;
    if (isDefensive) baseMu -= 2.6;

    const mu = Math.max(2.0, Math.min(24.0, baseMu));
    const sigma = isDeath ? 4.5 : 3.2;
    const wProb = Math.min(0.70, Math.max(0.08, 0.22 + (isAggressive ? 0.12 : 0.0) + (bwlSkill > 0.85 ? 0.08 : 0.0)));
    const wicketLogit = Math.log(wProb / (1.0 - wProb));

    return { mu, sigma, wicketLogit, wicketProb: wProb };
  }

  public sampleOverOutcome(
    dist: { mu: number; sigma: number; wicketProb: number },
    state: OverInputState
  ): { runs: number; wickets: number } {
    let { mu, sigma, wicketProb } = dist;

    // Tailender Clamp (Wickets >= 8 chokes scoring and raises wicket odds)
    if (state.wicketsDown >= 8) {
      mu = Math.max(1.0, mu * 0.65);
      sigma = Math.min(sigma, 2.5);
      wicketProb = Math.min(0.70, wicketProb * 1.35);
    }

    // Home Ground Advantage (Home Turf Familiarity, Pitch Mastery & Crowd Energy)
    if (state.isBattingTeamHome) {
      mu *= 1.04; // +4% scoring efficiency for home batters
    }
    if (state.isBowlingTeamHome) {
      mu *= 0.96; // -4% runs conceded for home bowlers hitting familiar lengths
      wicketProb = Math.min(0.65, wicketProb * 1.08); // +8% wicket taking edge on home turf
    }

    // 1. Skill Consistency Scaling (Elite players execute with tighter, reliable consistency)
    const bwlSkill = (state.bowler.stats.bowl || 70) / 100.0;
    const strSkill = (state.striker.stats.bat || 70) / 100.0;
    const bwlConsistency = Math.max(0.0, (bwlSkill - 0.75) * 0.50);
    const strConsistency = Math.max(0.0, (strSkill - 0.75) * 0.35);
    const combinedSkillDampener = Math.min(0.40, (bwlConsistency + strConsistency) * this.config.skillConsistencyScale);
    const sigmaEff = Math.max(1.2, sigma * (1.0 - combinedSkillDampener));

    // Maiden Over Roll
    const maidenChance = Math.max(0.0, (5.2 - mu) * 0.035) + (state.bowler.stats.bowl >= 92 ? 0.04 : 0.0);
    if (Math.random() < maidenChance && state.overNumber <= 10) {
      const wicketsInMaiden = Math.random() < wicketProb ? 1 : 0;
      return { runs: 0, wickets: wicketsInMaiden };
    }

    // 2. Deterministic Anchor vs Stochastic Blend (Default 45% deterministic skill anchor, 55% variance)
    const u1 = Math.max(1e-6, Math.random());
    const u2 = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    const stochasticRuns = mu + z * sigmaEff;

    const detRatio = this.config.determinismRatio; // e.g. 0.45
    let sampledRuns = Math.round(detRatio * mu + (1.0 - detRatio) * stochasticRuns);
    sampledRuns = Math.max(0, Math.min(36, sampledRuns));

    // Wicket roll anchored to skill-adjusted probability
    let sampledWickets = 0;
    if (Math.random() < wicketProb) {
      sampledWickets = 1;
      if (Math.random() < 0.18 && state.wicketsDown + sampledWickets < 10) {
        sampledWickets = 2;
        if (Math.random() < 0.06 && state.wicketsDown + sampledWickets < 10) {
          sampledWickets = 3;
        }
      }
    }

    const maxAvailableWickets = Math.max(0, 10 - state.wicketsDown);
    sampledWickets = Math.min(sampledWickets, maxAvailableWickets);

    return { runs: sampledRuns, wickets: sampledWickets };
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
      let wType: string | undefined = undefined;
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

        comm = `${ballLabel} ${updatedBowler.name} to ${activeStriker.name}, OUT! ${wType.toUpperCase()}! Exceptional bowling execution!`;
        
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
        // Tailender-aware scoring distribution
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
          // Tailenders rotate strike via singles (cannot hit 6s, rare 4 on edge)
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
          // Recognized batters & power finishers absorb boundaries (boosted on home turf by boundary pocket familiarity)
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

        // On last non-wicket ball of the over, absorb any remaining runs
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

        if (r === 0) {
          comm = `${ballLabel} ${updatedBowler.name} to ${activeStriker.name}, no run, good length delivery defended solidly.`;
        } else if (r === 1) {
          comm = `${ballLabel} ${updatedBowler.name} to ${activeStriker.name}, 1 run, pushed into the gap for a single.`;
        } else if (r === 2) {
          comm = `${ballLabel} ${updatedBowler.name} to ${activeStriker.name}, 2 runs, clipped through mid-wicket, good running between wickets.`;
        } else if (r === 4) {
          comm = `${ballLabel} ${updatedBowler.name} to ${activeStriker.name}, FOUR! Cracking stroke through the covers!`;
        } else if (r === 6) {
          comm = `${ballLabel} ${updatedBowler.name} to ${activeStriker.name}, SIX! Massive hit over deep mid-wicket into the stands!`;
        } else {
          comm = `${ballLabel} ${updatedBowler.name} to ${activeStriker.name}, ${r} runs.`;
        }

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
      teamFldRating = Math.round(state.fieldingTeamLineup.reduce((acc, p) => acc + (p.stats.fielding || 72), 0) / state.fieldingTeamLineup.length);
    }

    let batDepth = 75;
    if (state.battingTeamLineup && state.battingTeamLineup.length > 0) {
      const unbatted = state.battingTeamLineup.slice(Math.min(state.battingTeamLineup.length, state.wicketsDown + 2));
      if (unbatted.length > 0) {
        batDepth = Math.round(unbatted.reduce((acc, p) => acc + (p.stats.ovr || 70), 0) / unbatted.length);
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

    // 1. Build comprehensive 36-float active feature vector
    const features = this.buildFeatureVector(state);

    // 2. Predict distribution from unified ONNX MatchOverNet
    const dist = await this.predictOverDistribution(features);

    // 3. Sample physics-clamped runs and wickets
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

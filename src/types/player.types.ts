export type PrimaryRole = "BAT" | "WK" | "AR" | "PACE" | "SPIN";

// Granular player archetype/sub-type required by V1.7 M_DNA (role_dir_z2) & 3-5-2 phase suitability
export type PlayerSubType =
  | "OPENER_ATTACK"
  | "TOP_ORDER_ANCHOR"
  | "MIDDLE_ORDER_SPIN_HITTER"
  | "POWER_FINISHER"
  | "WK_TOP_ORDER"
  | "WK_FINISHER"
  | "BAT_AR"          // +0.05 * z2 in V1.7 M_DNA
  | "BOWL_AR"         // -0.05 * z2 in V1.7 M_DNA
  | "BALANCED_AR"     //  0.00 * z2 in V1.7 M_DNA
  | "POWERPLAY_SWING_PACER"
  | "EXPRESS_PACE"
  | "DEATH_OVERS_PACER"
  | "FINGER_SPINNER"
  | "WRIST_SPINNER"
  | "MYSTERY_SPINNER";

export type BattingHand = "RHB" | "LHB";
export type BowlingType = "PACE" | "SPIN" | "NONE";
export type BowlingArm = "R" | "L" | "NONE";
export type BasePriceCr = 2.00 | 1.50 | 1.00 | 0.75 | 0.50 | 0.30 | 0.20;

export interface PlayerStats {
  ovr: number;          // [60..98] Role-weighted overall rating
  bat: number;          // [20..97] Batting consistency & rotation
  power: number;        // [20..99] Six-hitting & boundary strike rate
  bowl: number;         // [15..96] Economy & wicket-taking ability
  fielding: number;     // [50..94] Catching & boundary saving
  staminaRecov: number; // [60..95] Post-match fatigue recovery rate (2.c)
  injuryRisk: number;   // [0.02..0.35] Probability scalar for injury roll (2.b)
}

export interface GroundSynergyVector {
  spin: number;  // [-1.0..1.0] Fit for spin tracks (Chepauk / Eden)
  pace: number;  // [-1.0..1.0] Fit for pace/bounce tracks (Wankhede / Perth-style)
  power: number; // [-1.0..1.0] Fit for short boundaries (Chinnaswamy)
  dew: number;   // [-1.0..1.0] Effectiveness in wet ball / 2nd innings chase
}

export interface TacticalSynergyVector {
  creaseDominance: number;  // [-1.0..1.0] (-1.0 = Anchor/Rotator, +1.0 = Power Aggressor)
  strikeRotation: number;   // [0.0..1.0] Strike turnover efficiency
  powerplay: number;        // [0.0..1.0] Overs 1-6 suitability
  middle: number;           // [0.0..1.0] Overs 7-15 suitability
  death: number;            // [0.0..1.0] Overs 16-20 suitability
  varietyBias: number;      // [-1.0..1.0] (-1.0 = Pure Left/Right Pace, +1.0 = Pure Wrist/Finger Spin)
}

export interface HistoricalPerfSummary {
  matches: number;
  batAvg: number;
  strikeRate: number;
  bowlEcon: number;
  bowlStrikeRate: number;
}

export interface IPLPlayer {
  id: string;                 // e.g., "p_001"
  name: string;               // e.g., "Jasprit Bumrah"
  country: string;            // e.g., "India", "Australia", "Afghanistan"
  isOverseas: boolean;        // true if country !== "India" (renders ✈️ badge)
  isUncapped: boolean;        // true for domestic uncapped players
  age: number;                // [18..42] (<=24 triggers youth DNA bonus in V1.7)
  role: PrimaryRole;          // "BAT" | "WK" | "AR" | "PACE" | "SPIN"
  subType: PlayerSubType;     // Specific tactical archetype
  batHand: BattingHand;       // "RHB" | "LHB"
  bowlType: BowlingType;      // "PACE" | "SPIN" | "NONE"
  bowlArm: BowlingArm;        // "R" | "L" | "NONE"
  bowlStyleLabel: string;     // e.g., "R-Arm Fast", "L-Arm Wrist Spin", "R-Arm Offbreak"
  basePrice: BasePriceCr;     // In Crores
  soldPrice?: number;         // Actual won auction price in Crores
  realAuctionPrice?: number;  // Real-world historical auction price in Crores
  marqueeSet: number;         // [1..9] Auction set order (Set 1 = Marquee)
  isBowlingCapable: boolean;  // true for PACE, SPIN, AR (eligible for 3-5-2 bowler pools)
  stats: PlayerStats;
  groundVector: GroundSynergyVector;
  tacticalSynergy?: TacticalSynergyVector;
  historical: HistoricalPerfSummary;
  workload?: number;          // [0..100] Cumulative workload index across tournament
  injuryStatus?: number;      // 0: Healthy, 1: 1 Match Pause, 3: 3 Match Pause, -1: Ruled Out
}

/**
 * Calculates real-time Batting Partnership Synergy between Striker and Non-Striker [-1.0 .. +1.0].
 * - Handedness synergy: +0.35 if LHB + RHB, -0.10 if identical
 * - Complementary role: +0.45 * |creaseDominance_1 - creaseDominance_2| (Anchor + Aggressor = +synergy)
 * - Strike rotation: +0.20 * average(strikeRotation)
 */
export function calculatePartnershipSynergy(striker: IPLPlayer, nonStriker: IPLPlayer): number {
  const handBonus = striker.batHand !== nonStriker.batHand ? 0.35 : -0.10;
  const domA = striker.tacticalSynergy?.creaseDominance ?? 0;
  const domB = nonStriker.tacticalSynergy?.creaseDominance ?? 0;
  const complementarity = Math.abs(domA - domB) * 0.45;
  const rotA = striker.tacticalSynergy?.strikeRotation ?? 0.5;
  const rotB = nonStriker.tacticalSynergy?.strikeRotation ?? 0.5;
  const rotationBonus = ((rotA + rotB) / 2) * 0.20;

  const raw = handBonus + complementarity + rotationBonus - 0.20;
  return Math.round(Math.max(-1.0, Math.min(1.0, raw)) * 100) / 100;
}

/**
 * Calculates Bowling Unit Synergy for 5-6 selected bowlers [-1.0 .. +1.0].
 * Evaluates phase coverage (Powerplay, Middle, Death) + variety across arm and style.
 */
export function calculateBowlingUnitSynergy(bowlers: IPLPlayer[]): {
  overallSynergy: number;
  ppCoverage: number;
  midCoverage: number;
  deathCoverage: number;
  varietyScore: number;
} {
  if (bowlers.length === 0) {
    return { overallSynergy: 0, ppCoverage: 0, midCoverage: 0, deathCoverage: 0, varietyScore: 0 };
  }

  const ppTotal = bowlers.reduce((acc, b) => acc + (b.tacticalSynergy?.powerplay ?? 0.33), 0);
  const midTotal = bowlers.reduce((acc, b) => acc + (b.tacticalSynergy?.middle ?? 0.33), 0);
  const deathTotal = bowlers.reduce((acc, b) => acc + (b.tacticalSynergy?.death ?? 0.33), 0);

  // Normalization (5 bowlers typically need >=1.2 weight per phase)
  const ppCoverage = Math.min(1.0, ppTotal / 1.5);
  const midCoverage = Math.min(1.0, midTotal / 1.5);
  const deathCoverage = Math.min(1.0, deathTotal / 1.2); // Death specialists are rarer and crucial

  // Variety across pace/spin and left/right
  const hasLeftArm = bowlers.some(b => b.bowlArm === 'L');
  const hasWristSpin = bowlers.some(b => b.subType === 'WRIST_SPINNER' || b.subType === 'MYSTERY_SPINNER');
  const hasDeathSpecialist = bowlers.some(b => b.subType === 'DEATH_OVERS_PACER' || (b.tacticalSynergy?.death ?? 0) >= 0.5);

  let varietyScore = 0.5;
  if (hasLeftArm) varietyScore += 0.2;
  if (hasWristSpin) varietyScore += 0.2;
  if (hasDeathSpecialist) varietyScore += 0.1;

  const balancePenalty = deathCoverage < 0.5 ? 0.4 : 0.0;
  const rawOverall = (ppCoverage * 0.30 + midCoverage * 0.30 + deathCoverage * 0.40) * varietyScore - balancePenalty;
  const overallSynergy = Math.round(Math.max(-1.0, Math.min(1.0, (rawOverall - 0.4) * 2.0)) * 100) / 100;

  return {
    overallSynergy,
    ppCoverage: Math.round(ppCoverage * 100) / 100,
    midCoverage: Math.round(midCoverage * 100) / 100,
    deathCoverage: Math.round(deathCoverage * 100) / 100,
    varietyScore: Math.round(varietyScore * 100) / 100,
  };
}

// Data Explorer Filtering and Sorting State Types
export interface PlayerFilterState {
  search: string;
  role: PrimaryRole | "ALL";
  subType: PlayerSubType | "ALL";
  country: string | "ALL";
  isOverseas: boolean | "ALL";
  isUncapped: boolean | "ALL";
  minOvr: number;
  maxBasePrice: number | "ALL";
  marqueeSet: number | "ALL";
  datasetPool: "ACTIVE" | "357" | "200" | "ALL";
}

export type SortField =
  | "name"
  | "ovr"
  | "bat"
  | "power"
  | "bowl"
  | "fielding"
  | "staminaRecov"
  | "injuryRisk"
  | "basePrice"
  | "age"
  | "marqueeSet"
  | "matches"
  | "strikeRate"
  | "batAvg"
  | "bowlEcon"
  | "bowlStrikeRate";

export type SortOrder = "asc" | "desc";

export interface SortConfig {
  field: SortField;
  order: SortOrder;
}

export interface KPIStats {
  totalPlayers: number;
  avgOvr: number;
  overseasCount: number;
  uncappedCount: number;
  roleBreakdown: Record<PrimaryRole, number>;
  avgBasePrice: number;
  totalPurseNeeded: number;
}

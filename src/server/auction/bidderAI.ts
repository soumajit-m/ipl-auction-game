/**
 * bidderAI.ts - Server-Authoritative V3.0 Tri-Head Multi-Nature Auction Bidder AI Engine
 *
 * Architecture Overview:
 *   - Layer A: Intrinsic Value (V_intrinsic) surplus against 160 baseline + Confidence Head (V_alpha = V_intrinsic * Confidence)
 *   - Layer B: 3 Dedicated Specialist Policy Networks (weights_sd.json, weights_mb.json, weights_dp.json) (18 -> 32 -> 32 -> 3)
 *   - Layer C: Capital Staging (mStage), Marginal Role Need Quotas (4 BAT, 1 WK, 2 AR, 3 PACE, 2 SPIN), Solvency Clamp (0.40 Cr reserve)
 *   - Feature: Post-18 Opportunistic Bidding with Rival Bankruptcy Protection (PROTECT_RIVAL_SOLVENCY)
 *
 * Full real-time SocketHub compatibility:
 *   - initializeTeams, sanitizeRoomDTO, resolveModeAVickrey, evaluateBidEligibility, commitLotSale
 *   - evaluateFranchiseBid, evaluateLiveBidModeB, getPlayerValuation, computeAllVIntrinsic
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  IPLPlayer,
  PrimaryRole
} from '../../types/player.types';
import {
  FranchiseAuctionProfile,
  PsychologicalTrait,
  AIArchetype,
  TeamAuctionState,
  AuctionPhase,
  SanitizeRoomDTO,
  PrivateAITicks
} from '../../types/auction.types';
import { mulberry32, hashString } from '../../lib/prng';

export type { AIArchetype };

// =============================================================================
// 1. DATA STRUCTURES & INTERFACES (V3.0)
// =============================================================================

export interface FranchisePsychologyState {
  trait: PsychologicalTrait;
  tiltLevel: number;               // [0.0 .. 1.0]
  consecutiveTargetLosses: number; // Count of lost priority lots
  bluffFrequency: number;          // [0.0 .. 1.0] Propensity to price-jack on non-core players
  humanRivalryAggression: number;  // [1.0 .. 1.30] Multiplier against human bidder
}

export interface FranchiseRosterState {
  franchiseId: string;
  purseRemainingCr: number;        // Initial ₹125.00 Cr
  squad: IPLPlayer[];
  pricesPaid: number[];            // History of acquisition prices paid (Cr)
  roleCounts: Record<PrimaryRole, number>;
  overseasCount: number;
  uncappedCount: number;
  totalSpentCr: number;
  tickList: {
    tier1: Set<string>;            // 4-6 must-have pillar targets
    tier2: Set<string>;            // 8-12 core targets
    tier3: Set<string>;            // 12-16 budget depth / uncapped picks
  };
  psychology: FranchisePsychologyState;
  archetype?: AIArchetype;
}

export interface ValuationOutput {
  mu: number;                      // Intrinsic fair valuation V_intrinsic (Cr)
  q15: number;                     // Conservative floor (Cr)
  q85: number;                     // War ceiling (Cr)
  vIntrinsic?: number;             // Layer A intrinsic valuation (Cr)
  vAlpha?: number;                 // Layer A alpha valuation with confidence head (Cr)
  confidence?: number;             // Historical matches confidence multiplier
}

export interface AuctionBidDecision {
  franchiseId: string;
  canBid: boolean;
  maxValuation: number;            // Final adjusted ceiling for this lot (Cr)
  nextBidAmount: number;           // Proposed next bid (Cr)
  reactionDelayMs: number;         // Mode B live auction reaction delay
  reason: string;                  // "ACTIVE_BID", "VALUATION_EXCEEDED", "SOLVENCY_RISK", "PROTECT_RIVAL_SOLVENCY", "OVERSEAS_FULL", "SQUAD_FULL", "ROLE_SATURATED", "NOT_NEEDED_PRESERVE_PURSE"
  components?: {
    vBase: number;
    vIntrinsic?: number;
    mPolicy?: number;
    mLiquidity?: number;
    mStage?: number;
    mDNA: number;
    mScarcity: number;
    mEMA: number;
    mTick: number;
    mWkEmergency: number;
    mTaxEff: number;
    pAvail: number;
    pBluff?: number;
    tauSniper?: number;
  };
}

export interface AuctionEngineConfig {
  determinismRatio: number;
  humanTaxEnabled: boolean;
  unfairAdvantage: boolean;
  humanBleedMultiplier: number;
  humanChokeEnabled: boolean;
  tacticalSynergyBonus: boolean;
  humanTiltPressure: boolean;
}

export interface BidDecision {
  state: 'ELIGIBLE' | 'NO_BID';
  reason?: string;
  mValue?: number;
  mTaxEff?: number;
  reactionDelayMs?: number;
}

// Target Starting XI Quotas for Marginal Need Analysis
export const TARGET_XI_QUOTAS: Record<PrimaryRole, number> = {
  BAT: 4,
  WK: 1,
  AR: 2,
  PACE: 3,
  SPIN: 2
};

export const MAX_ROLE_CAPS: Record<PrimaryRole, number> = {
  BAT: 8,
  WK: 2,
  AR: 7,
  PACE: 8,
  SPIN: 6
};

import { getNextBidIncrement, getHumanMinPurseReserve } from '../../types/auction.types';
export { getNextBidIncrement, getHumanMinPurseReserve };

// Accelerated Round Base Price Reduction
export function getAcceleratedBasePrice(basePrice: number): number {
  if (basePrice >= 2.00) return 1.00;
  if (basePrice >= 1.50) return 0.75;
  if (basePrice >= 1.00) return 0.50;
  if (basePrice >= 0.75) return 0.30;
  if (basePrice >= 0.50) return 0.30;
  return basePrice;
}

// Helper: Clip number within [min, max]
export function clip(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

// =============================================================================
// 2. DYNAMIC ARCHETYPE DISTRIBUTION & ASSIGNMENT HELPERS
// =============================================================================

export function getArchetypeDistribution(aiCount: number): {
  sdCount: number;
  mbCount: number;
  dpCount: number;
} {
  if (aiCount < 3) {
    return { sdCount: 0, mbCount: 0, dpCount: aiCount };
  }
  if (aiCount === 3) {
    return { sdCount: 1, mbCount: 1, dpCount: 1 };
  }
  if (aiCount <= 5) {
    const sdCount = Math.min(2, Math.max(1, Math.floor(aiCount * 0.35)));
    const mbCount = 1;
    const dpCount = aiCount - sdCount - mbCount;
    return { sdCount, mbCount, dpCount };
  }
  const maxSD = aiCount > 10 ? 3 : 2;
  const sdCount = Math.min(maxSD, Math.max(2, Math.floor(aiCount * 0.3)));
  const mbCount = aiCount >= 8 ? 2 : 1;
  const dpCount = aiCount - sdCount - mbCount;

  return { sdCount, mbCount, dpCount };
}

/**
 * Reordered AI nature pattern across franchises:
 * SD, MB, DP, DP, MB, SD, DP, DP, DP, DP ...
 * Spreads superstar duelists and moneyball specialists across the roster
 * instead of grouping them together at the front.
 */
export const DEFAULT_ARCHETYPE_SEQUENCE: AIArchetype[] = [
  'SUPERSTAR_DUELIST',      // 0: SD (e.g. CSK)
  'MONEYBALL_CORE',         // 1: MB (e.g. MI)
  'DISCIPLINED_PRAGMATIST', // 2: DP (e.g. KKR)
  'DISCIPLINED_PRAGMATIST', // 3: DP (e.g. RCB)
  'MONEYBALL_CORE',         // 4: MB (e.g. RR)
  'SUPERSTAR_DUELIST',      // 5: SD (e.g. SRH)
  'DISCIPLINED_PRAGMATIST', // 6: DP (e.g. DC)
  'DISCIPLINED_PRAGMATIST', // 7: DP (e.g. PBKS)
  'DISCIPLINED_PRAGMATIST', // 8: DP (e.g. GT)
  'DISCIPLINED_PRAGMATIST'  // 9: DP (e.g. LSG)
];

export const DEFAULT_FRANCHISE_ARCHETYPES: Record<string, AIArchetype> = {
  CSK: 'SUPERSTAR_DUELIST',
  MI: 'MONEYBALL_CORE',
  KKR: 'DISCIPLINED_PRAGMATIST',
  RCB: 'DISCIPLINED_PRAGMATIST',
  RR: 'MONEYBALL_CORE',
  SRH: 'SUPERSTAR_DUELIST',
  DC: 'DISCIPLINED_PRAGMATIST',
  PBKS: 'DISCIPLINED_PRAGMATIST',
  GT: 'DISCIPLINED_PRAGMATIST',
  LSG: 'DISCIPLINED_PRAGMATIST'
};

export function assignFranchiseArchetypes(aiFranchises: { id: string; archetype?: AIArchetype; targetSquadSize?: number }[]): void {
  aiFranchises.forEach((f, idx) => {
    // 1. If franchise ID is known in DEFAULT_FRANCHISE_ARCHETYPES, assign its signature archetype
    // 2. Otherwise follow the interleaved pattern: SD, MB, DP, DP, MB, SD, DP, DP, DP, DP ...
    const assignedArchetype: AIArchetype =
      (f.id && DEFAULT_FRANCHISE_ARCHETYPES[f.id]) ||
      DEFAULT_ARCHETYPE_SEQUENCE[idx % DEFAULT_ARCHETYPE_SEQUENCE.length];

    f.archetype = assignedArchetype;
    if (f.archetype === 'SUPERSTAR_DUELIST') f.targetSquadSize = 18;
    else if (f.archetype === 'MONEYBALL_CORE') f.targetSquadSize = 20;
    else f.targetSquadSize = 19;
  });
}

// Backward-compatible role need factor calculation
export function computeRoleNeedFactor(role: PrimaryRole, currentRoleCount: number, squadSize: number): number {
  const targetQuota = TARGET_XI_QUOTAS[role] || 3;
  if (currentRoleCount < targetQuota) {
    return 1.0 + 0.12 * (targetQuota - currentRoleCount);
  }
  return 0.85;
}

// =============================================================================
// 3. DEFAULT 10 IPL FRANCHISES WITH V3.0 TEAM DNA & VENUE VECTORS
// =============================================================================

export const DEFAULT_IPL_FRANCHISES: FranchiseAuctionProfile[] = [
  {
    id: 'CSK',
    name: 'Chennai Super Kings',
    homeVenueName: 'M. A. Chidambaram Stadium (Chepauk)',
    homePitch: { spin: 0.85, pace: -0.20, power: -0.35, dew: 0.65 },
    targetSquadSize: 18,
    archetype: 'SUPERSTAR_DUELIST',
    psychology: 'STAR_HOARDER',
    dna: {
      z1_youthExperience: -0.40,
      z2_roleBias: 0.20,
      z3_indianCoreBias: 0.50,
      z4_riskTolerance: -0.20,
      z5_venueSynergyPriority: 0.90,
      z6_superstarThriftBias: 0.30
    }
  },
  {
    id: 'MI',
    name: 'Mumbai Indians',
    homeVenueName: 'Wankhede Stadium',
    homePitch: { spin: -0.25, pace: 0.75, power: 0.70, dew: 0.80 },
    targetSquadSize: 20,
    archetype: 'MONEYBALL_CORE',
    psychology: 'STAR_HOARDER',
    dna: {
      z1_youthExperience: 0.30,
      z2_roleBias: -0.20,
      z3_indianCoreBias: 0.30,
      z4_riskTolerance: 0.50,
      z5_venueSynergyPriority: 0.85,
      z6_superstarThriftBias: -0.50
    }
  },
  {
    id: 'KKR',
    name: 'Kolkata Knight Riders',
    homeVenueName: 'Eden Gardens',
    homePitch: { spin: 0.65, pace: 0.20, power: 0.50, dew: 0.70 },
    targetSquadSize: 19,
    archetype: 'DISCIPLINED_PRAGMATIST',
    psychology: 'MONEYBALL_ANALYST',
    dna: {
      z1_youthExperience: 0.10,
      z2_roleBias: 0.40,
      z3_indianCoreBias: -0.30,
      z4_riskTolerance: 0.60,
      z5_venueSynergyPriority: 0.75,
      z6_superstarThriftBias: -0.40
    }
  },
  {
    id: 'RCB',
    name: 'Royal Challengers Bengaluru',
    homeVenueName: 'M. Chinnaswamy Stadium',
    homePitch: { spin: -0.30, pace: 0.40, power: 0.95, dew: 0.40 },
    targetSquadSize: 19,
    archetype: 'DISCIPLINED_PRAGMATIST',
    psychology: 'POWER_MAXIMALIST',
    dna: {
      z1_youthExperience: 0.00,
      z2_roleBias: 0.50,
      z3_indianCoreBias: -0.10,
      z4_riskTolerance: 0.45,
      z5_venueSynergyPriority: 0.95,
      z6_superstarThriftBias: -0.60
    }
  },
  {
    id: 'RR',
    name: 'Rajasthan Royals',
    homeVenueName: 'Sawai Mansingh Stadium',
    homePitch: { spin: 0.50, pace: 0.30, power: -0.20, dew: 0.30 },
    targetSquadSize: 20,
    archetype: 'MONEYBALL_CORE',
    psychology: 'MONEYBALL_ANALYST',
    dna: {
      z1_youthExperience: 0.60,
      z2_roleBias: -0.10,
      z3_indianCoreBias: 0.40,
      z4_riskTolerance: -0.10,
      z5_venueSynergyPriority: 0.60,
      z6_superstarThriftBias: 0.50
    }
  },
  {
    id: 'SRH',
    name: 'Sunrisers Hyderabad',
    homeVenueName: 'Rajiv Gandhi Intl Stadium',
    homePitch: { spin: 0.10, pace: 0.50, power: 0.80, dew: 0.45 },
    targetSquadSize: 18,
    archetype: 'SUPERSTAR_DUELIST',
    psychology: 'POWER_MAXIMALIST',
    dna: {
      z1_youthExperience: 0.20,
      z2_roleBias: 0.30,
      z3_indianCoreBias: -0.40,
      z4_riskTolerance: 0.70,
      z5_venueSynergyPriority: 0.70,
      z6_superstarThriftBias: -0.55
    }
  },
  {
    id: 'DC',
    name: 'Delhi Capitals',
    homeVenueName: 'Arun Jaitley Stadium',
    homePitch: { spin: 0.55, pace: 0.10, power: 0.60, dew: 0.50 },
    targetSquadSize: 19,
    archetype: 'DISCIPLINED_PRAGMATIST',
    psychology: 'CHAOTIC_DISRUPTOR',
    dna: {
      z1_youthExperience: 0.45,
      z2_roleBias: 0.10,
      z3_indianCoreBias: 0.35,
      z4_riskTolerance: 0.10,
      z5_venueSynergyPriority: 0.65,
      z6_superstarThriftBias: 0.20
    }
  },
  {
    id: 'PBKS',
    name: 'Punjab Kings',
    homeVenueName: 'Maharaja Yadavindra Singh Stadium, Mullanpur',
    homePitch: { spin: 0.20, pace: 0.65, power: 0.40, dew: 0.60 },
    targetSquadSize: 19,
    archetype: 'DISCIPLINED_PRAGMATIST',
    psychology: 'CHAOTIC_DISRUPTOR',
    dna: {
      z1_youthExperience: 0.35,
      z2_roleBias: 0.00,
      z3_indianCoreBias: 0.00,
      z4_riskTolerance: 0.55,
      z5_venueSynergyPriority: 0.50,
      z6_superstarThriftBias: -0.30
    }
  },
  {
    id: 'GT',
    name: 'Gujarat Titans',
    homeVenueName: 'Narendra Modi Stadium',
    homePitch: { spin: 0.40, pace: 0.60, power: -0.10, dew: 0.50 },
    targetSquadSize: 19,
    archetype: 'DISCIPLINED_PRAGMATIST',
    psychology: 'TACTICAL_PRAGMATIST',
    dna: {
      z1_youthExperience: 0.10,
      z2_roleBias: 0.25,
      z3_indianCoreBias: 0.50,
      z4_riskTolerance: 0.10,
      z5_venueSynergyPriority: 0.80,
      z6_superstarThriftBias: 0.20
    }
  },
  {
    id: 'LSG',
    name: 'Lucknow Super Giants',
    homeVenueName: 'BRSABV Ekana Cricket Stadium',
    homePitch: { spin: 0.70, pace: 0.30, power: -0.20, dew: 0.45 },
    targetSquadSize: 19,
    archetype: 'DISCIPLINED_PRAGMATIST',
    psychology: 'TACTICAL_PRAGMATIST',
    dna: {
      z1_youthExperience: 0.30,
      z2_roleBias: 0.30,
      z3_indianCoreBias: 0.20,
      z4_riskTolerance: 0.25,
      z5_venueSynergyPriority: 0.75,
      z6_superstarThriftBias: 0.10
    }
  }
];

// =============================================================================
// 4. ZERO-DEPENDENCY POLICY NETWORK MATRIX MATH (18 -> 32 -> 32 -> 3)
// =============================================================================

export interface PolicyWeights {
  'net.0.weight': number[];
  'net.0.bias': number[];
  'net.1.weight': number[][];
  'net.1.bias': number[];
  'net.2.weight': number[];
  'net.2.bias': number[];
  'net.4.weight': number[][];
  'net.4.bias': number[];
  'net.5.weight': number[];
  'net.5.bias': number[];
  'net.7.weight': number[][];
  'net.7.bias': number[];
}

function layerNorm(x: Float32Array, weight: number[], bias: number[], eps: number = 1e-5): Float32Array {
  const n = x.length;
  let mean = 0.0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let variance = 0.0;
  for (let i = 0; i < n; i++) {
    const diff = x[i] - mean;
    variance += diff * diff;
  }
  variance /= n;
  const invStd = 1.0 / Math.sqrt(variance + eps);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (x[i] - mean) * invStd * weight[i] + bias[i];
  }
  return out;
}

function silu(x: number): number {
  return x / (1.0 + Math.exp(-x));
}

function matmul(x: Float32Array, weight: number[][], bias: number[]): Float32Array {
  const outDim = weight.length;
  const inDim = x.length;
  const out = new Float32Array(outDim);
  for (let i = 0; i < outDim; i++) {
    let sum = bias[i];
    const row = weight[i];
    for (let j = 0; j < inDim; j++) {
      sum += row[j] * x[j];
    }
    out[i] = sum;
  }
  return out;
}

export function forwardPolicyNet(input18: Float32Array, weights: PolicyWeights): { mPolicy: number; pBluff: number; tauSniper: number } {
  // net.0: LayerNorm(18)
  let h = layerNorm(input18, weights['net.0.weight'], weights['net.0.bias']);
  // net.1: Linear(18, 32)
  h = matmul(h, weights['net.1.weight'], weights['net.1.bias']);
  // net.2: LayerNorm(32)
  h = layerNorm(h, weights['net.2.weight'], weights['net.2.bias']);
  // SiLU
  for (let i = 0; i < 32; i++) h[i] = silu(h[i]);
  // net.4: Linear(32, 32)
  h = matmul(h, weights['net.4.weight'], weights['net.4.bias']);
  // net.5: LayerNorm(32)
  h = layerNorm(h, weights['net.5.weight'], weights['net.5.bias']);
  // SiLU
  for (let i = 0; i < 32; i++) h[i] = silu(h[i]);
  // net.7: Linear(32, 3)
  const z = matmul(h, weights['net.7.weight'], weights['net.7.bias']);

  const sig0 = 1.0 / (1.0 + Math.exp(-z[0]));
  const sig1 = 1.0 / (1.0 + Math.exp(-z[1]));
  const sig2 = 1.0 / (1.0 + Math.exp(-z[2]));

  return {
    mPolicy: 0.70 + 0.80 * sig0, // Range [0.70 .. 1.50]
    pBluff: 0.55 * sig1,         // Range [0.00 .. 0.55]
    tauSniper: 0.60 * sig2       // Range [0.00 .. 0.60]
  };
}

// =============================================================================
// 5. AUCTION BIDDER AI ENGINE CLASS (V3.0 TRI-HEAD ARCHITECTURE)
// =============================================================================

export class AuctionBidderAI {
  private archetypeWeights: Map<AIArchetype, PolicyWeights> = new Map();
  public franchiseWeightOverrides: Map<string, PolicyWeights | null> = new Map();
  private precomputedValuations: Map<string, ValuationOutput> = new Map();
  private vIntrinsicMap: Map<string, number> = new Map();
  private vAlphaMap: Map<string, number> = new Map();

  // Unticked role heap for O(1) scarcity evaluation
  private untickedRoleCounts: Record<PrimaryRole, number> = {
    BAT: 0,
    WK: 0,
    AR: 0,
    PACE: 0,
    SPIN: 0
  };

  // 5 Role-Isolated EMAs tracking auction market inflation
  private roleEMAs: Record<PrimaryRole, number> = {
    BAT: 1.0,
    WK: 1.0,
    AR: 1.0,
    PACE: 1.0,
    SPIN: 1.0
  };

  public franchiseStates: Map<string, FranchiseRosterState> = new Map();
  public franchiseProfiles: Map<string, FranchiseAuctionProfile> = new Map();
  public affinities: Map<string, { name: string; franchise: string; isFranchiseIcon: boolean }> = new Map();

  public config: AuctionEngineConfig = {
    determinismRatio: 0.45,
    humanTaxEnabled: true,
    unfairAdvantage: true,
    humanBleedMultiplier: 1.22,
    humanChokeEnabled: true,
    tacticalSynergyBonus: true,
    humanTiltPressure: true
  };

  constructor(profiles: FranchiseAuctionProfile[] = DEFAULT_IPL_FRANCHISES) {
    profiles.forEach(p => {
      this.franchiseProfiles.set(p.id, p);
      this.franchiseStates.set(p.id, {
        franchiseId: p.id,
        purseRemainingCr: 125.00,
        squad: [],
        pricesPaid: [],
        roleCounts: { BAT: 0, WK: 0, AR: 0, PACE: 0, SPIN: 0 },
        overseasCount: 0,
        uncappedCount: 0,
        totalSpentCr: 0.0,
        tickList: { tier1: new Set(), tier2: new Set(), tier3: new Set() },
        psychology: {
          trait: p.psychology || 'TACTICAL_PRAGMATIST',
          tiltLevel: 0.0,
          consecutiveTargetLosses: 0,
          bluffFrequency: (p.psychology === 'CHAOTIC_DISRUPTOR') ? 0.35 : 0.10,
          humanRivalryAggression: (p.psychology === 'CHAOTIC_DISRUPTOR') ? 1.22 : 1.05
        }
      });
    });

    // Attempt sync loading of specialist weights if available in filesystem
    this.loadSpecialistWeightsSync();
  }

  /**
   * Helper to synchronously load the 3 specialist weights if possible.
   */
  private loadSpecialistWeightsSync(): void {
    const archetypeFileMap: { archetype: AIArchetype; filename: string }[] = [
      { archetype: 'SUPERSTAR_DUELIST', filename: 'weights_sd.json' },
      { archetype: 'MONEYBALL_CORE', filename: 'weights_mb.json' },
      { archetype: 'DISCIPLINED_PRAGMATIST', filename: 'weights_dp.json' }
    ];

    for (const { archetype, filename } of archetypeFileMap) {
      if (this.archetypeWeights.has(archetype)) continue;

      const candidatePaths = [
        path.resolve(process.cwd(), `public/models/${filename}`),
        path.resolve(process.cwd(), `dist/models/${filename}`),
        path.resolve(__dirname, `../../../public/models/${filename}`),
        path.resolve(__dirname, `../../../../public/models/${filename}`)
      ];

      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          try {
            const weights = JSON.parse(fs.readFileSync(p, 'utf-8'));
            this.archetypeWeights.set(archetype, weights);
            break;
          } catch (e) {
            // continue
          }
        }
      }
    }
  }

  /**
   * LAYER B INITIALIZATION:
   * Loads the 3 dedicated specialist policy networks from public/models/:
   * - weights_sd.json (SUPERSTAR_DUELIST)
   * - weights_mb.json (MONEYBALL_CORE)
   * - weights_dp.json (DISCIPLINED_PRAGMATIST)
   */
  public async initModel(): Promise<void> {
    const archetypeFileMap: { archetype: AIArchetype; filename: string }[] = [
      { archetype: 'SUPERSTAR_DUELIST', filename: 'weights_sd.json' },
      { archetype: 'MONEYBALL_CORE', filename: 'weights_mb.json' },
      { archetype: 'DISCIPLINED_PRAGMATIST', filename: 'weights_dp.json' }
    ];

    for (const { archetype, filename } of archetypeFileMap) {
      const candidatePaths = [
        path.resolve(process.cwd(), `public/models/${filename}`),
        path.resolve(process.cwd(), `dist/models/${filename}`),
        path.resolve(__dirname, `../../../public/models/${filename}`),
        path.resolve(__dirname, `../../../../public/models/${filename}`)
      ];

      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          try {
            const weights = JSON.parse(fs.readFileSync(p, 'utf-8'));
            this.archetypeWeights.set(archetype, weights);
            console.log(`[AuctionBidderAI] Loaded Dedicated Neural Weights for ${archetype} from: ${p}`);
            break;
          } catch (e) {
            // continue
          }
        }
      }
    }

    if (this.archetypeWeights.size === 0) {
      console.warn('[AuctionBidderAI] Dedicated policy weights not found in path; will use calibrated analytical policy.');
    }
  }

  /**
   * LAYER A: ALPHA VALUATION & CONFIDENCE HEAD
   * 1. Intrinsic Value (V_intrinsic):
   *    Computed from player stats surplus against the 160-player baseline,
   *    anchored with historical real-auction pricing for marquee stars (>= ₹8.00 Cr),
   *    clamped within [BasePrice, ₹26.50 Cr].
   * 2. Confidence Head:
   *    Confidence = 0.88 + 0.12 * Min(1.0, HistoricalMatches / 35.0)
   *    V_alpha = V_intrinsic * Confidence
   */
  public computeAllVIntrinsic(allPlayers: IPLPlayer[]): Map<string, number> {
    const surplusList: { player: IPLPlayer; surplus: number }[] = [];

    for (const p of allPlayers) {
      const st = p.stats || { bat: 70, power: 70, bowl: 70, fielding: 70, ovr: 72 };
      const bat = st.bat || 70;
      const power = st.power || 70;
      const bowl = st.bowl || 70;
      const fielding = st.fielding || 70;

      // 1. Role-Weighted Skill Score S_i
      let S_i = 0.0;
      if (p.role === 'BAT') {
        S_i = 0.55 * bat + 0.35 * power + 0.10 * fielding;
      } else if (p.role === 'WK') {
        S_i = 0.50 * bat + 0.32 * power + 0.18 * fielding;
      } else if (p.role === 'PACE' || p.role === 'SPIN') {
        S_i = 0.88 * bowl + 0.07 * fielding + 0.05 * bat;
      } else { // AR
        S_i = 0.45 * Math.max(bat, bowl) + 0.35 * Math.min(bat, bowl) + 0.12 * power + 0.08 * fielding;
      }

      // 2. Replacement Surplus Multipliers
      const wRole = p.role === 'AR' ? 1.16 : (p.role === 'WK' ? 1.10 : (p.role === 'PACE' ? 1.08 : (p.role === 'SPIN' ? 1.03 : 1.00)));
      const wDomestic = !p.isOverseas ? 1.28 : 1.00;
      const age = p.age || 27;
      const wAge = age <= 24 ? 1.08 : (age <= 33 ? 1.00 : 0.90);
      const matches = p.historical?.matches || 20;
      const wVolume = 0.85 + 0.25 * Math.min(1.0, matches / 45.0);

      const baseSurplus = Math.max(0.0, S_i - 65.0);
      const surplus = Math.pow(baseSurplus, 2.35) * wRole * wDomestic * wAge * wVolume;
      surplusList.push({ player: p, surplus });
    }

    // Top 160 starter pool
    surplusList.sort((a, b) => b.surplus - a.surplus);
    const top160 = surplusList.slice(0, 160);
    const totalStarterSurplus = top160.reduce((acc, x) => acc + x.surplus, 0) || 1.0;

    const resultMap = new Map<string, number>();
    for (const { player, surplus } of surplusList) {
      const bp = player.basePrice || 0.30;
      const vCalc = bp + 1050.0 * (surplus / totalStarterSurplus);

      let vFinal = vCalc;
      // Soft 12% Star-Aura Anchor only when realAuctionPrice >= 8.0 Cr
      const realP = player.realAuctionPrice;
      if (realP !== undefined && realP >= 8.0) {
        vFinal = 0.88 * vCalc + 0.12 * realP;
      }
      vFinal = Math.max(bp, Math.min(26.50, Math.round(vFinal * 100) / 100));
      resultMap.set(player.id, vFinal);

      // Layer A Confidence Head
      const histMatches = player.historical?.matches || 20;
      const confidence = 0.88 + 0.12 * Math.min(1.0, histMatches / 35.0);
      const vAlpha = Math.max(bp, Math.min(26.50, Math.round(vFinal * confidence * 100) / 100));
      this.vAlphaMap.set(player.id, vAlpha);
    }

    return resultMap;
  }

  /**
   * Pre-calculates Layer A valuations for all players and generates 30-player private Tick Lists.
   */
  public async initializeAuction(allPlayers: IPLPlayer[]): Promise<void> {
    // 1. Reset Unticked Role Heap
    this.untickedRoleCounts = { BAT: 0, WK: 0, AR: 0, PACE: 0, SPIN: 0 };
    for (const p of allPlayers) {
      this.untickedRoleCounts[p.role] = (this.untickedRoleCounts[p.role] || 0) + 1;
    }

    // 2. Compute Layer A Intrinsic & Alpha Valuations
    this.vIntrinsicMap = this.computeAllVIntrinsic(allPlayers);
    for (const p of allPlayers) {
      const vInt = this.vIntrinsicMap.get(p.id) || p.basePrice || 0.30;
      const histMatches = p.historical?.matches || 20;
      const confidence = 0.88 + 0.12 * Math.min(1.0, histMatches / 35.0);
      const vAlpha = this.vAlphaMap.get(p.id) || Math.round(vInt * confidence * 100) / 100;

      const volatility = 0.16 + ((p.stats?.ovr || 72) >= 88 ? 0.12 : 0.05);
      const q15 = Math.max(p.basePrice || 0.30, Math.round(vAlpha * (1.0 - volatility * 0.90) * 100) / 100);
      const q85 = Math.min(27.0, Math.round(vAlpha * (1.0 + volatility * 1.30) * 100) / 100);

      this.precomputedValuations.set(p.id, {
        mu: vInt,
        q15,
        q85,
        vIntrinsic: vInt,
        vAlpha,
        confidence
      });
    }

    // 3. Load Real-Life Franchise Affinities
    const candidateAffinityPaths = [
      path.resolve(process.cwd(), 'public/data/player_team_affinities.json'),
      path.resolve(process.cwd(), 'dist/data/player_team_affinities.json'),
      path.resolve(__dirname, '../../../public/data/player_team_affinities.json')
    ];
    for (const p of candidateAffinityPaths) {
      if (fs.existsSync(p)) {
        try {
          const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
          for (const [id, rec] of Object.entries(raw)) {
            this.affinities.set(id, rec as any);
          }
          break;
        } catch (e) {}
      }
    }

    // 4. Generate 30-Player Private Tick Lists for each franchise based on DNA and fit
    for (const [fId, profile] of this.franchiseProfiles.entries()) {
      const scoredPlayers = allPlayers.map(p => {
        const val = this.precomputedValuations.get(p.id)!;
        const homePitch = profile.homePitch || { spin: 0, pace: 0, power: 0, dew: 0 };
        const pitchDot = (
          homePitch.spin * (p.groundVector?.spin ?? 0) +
          homePitch.pace * (p.groundVector?.pace ?? 0) +
          homePitch.power * (p.groundVector?.power ?? 0) +
          homePitch.dew * (p.groundVector?.dew ?? 0)
        );
        const venuePriority = profile.dna.z5_venueSynergyPriority ?? 0.5;
        const dnaScore = (
          (p.age <= 24 ? 1 : -1) * profile.dna.z1_youthExperience * 0.15 +
          (!p.isOverseas ? 1 : -1) * profile.dna.z3_indianCoreBias * 0.20 +
          pitchDot * venuePriority * 0.32 +
          ((p.stats?.ovr || 72) / 100.0) * 0.33
        );

        const aff = this.affinities.get(p.id);
        let affinityBoost = 0.0;
        if (aff && aff.franchise === fId) {
          affinityBoost = aff.isFranchiseIcon ? 1.20 : 0.45;
        }

        return { id: p.id, score: dnaScore + affinityBoost, val: val.mu };
      });

      scoredPlayers.sort((a, b) => b.score - a.score);

      const state = this.franchiseStates.get(fId)!;
      state.tickList.tier1 = new Set(scoredPlayers.slice(0, 8).map(x => x.id));
      state.tickList.tier2 = new Set(scoredPlayers.slice(8, 20).map(x => x.id));
      state.tickList.tier3 = new Set(scoredPlayers.slice(20, 36).map(x => x.id));
    }
  }

  /**
   * Assigns AI archetypes to a subset of AI franchises in room lifecycle
   */
  public assignRoomAIArchetypes(aiFranchiseIds: string[]): void {
    const list = aiFranchiseIds.map(id => ({ id, archetype: undefined as AIArchetype | undefined, targetSquadSize: undefined as number | undefined }));
    assignFranchiseArchetypes(list);
    for (const item of list) {
      const prof = this.franchiseProfiles.get(item.id);
      if (prof) {
        prof.archetype = item.archetype;
        if (item.targetSquadSize) prof.targetSquadSize = item.targetSquadSize;
      }
      const state = this.franchiseStates.get(item.id);
      if (state) state.archetype = item.archetype;
    }
  }

  /**
   * Initializes 10 franchise states in RAM for SocketHub room lifecycle:
   * Sets up ₹125.00 Cr purse and 30-player private AI ticks.
   */
  public initializeTeams(roomCode: string, allPlayers: IPLPlayer[]): Record<string, TeamAuctionState> {
    this.initializeAuction(allPlayers);

    const teams: Record<string, TeamAuctionState> = {};
    const sortedProfiles = [...DEFAULT_IPL_FRANCHISES];

    // Assign initial AI archetypes across all 10 franchises
    const defaultAIList = sortedProfiles.map(p => ({ id: p.id, archetype: undefined as AIArchetype | undefined, targetSquadSize: undefined as number | undefined }));
    assignFranchiseArchetypes(defaultAIList);
    for (const item of defaultAIList) {
      const prof = this.franchiseProfiles.get(item.id);
      if (prof) {
        prof.archetype = item.archetype;
        if (item.targetSquadSize) prof.targetSquadSize = item.targetSquadSize;
      }
      const fState = this.franchiseStates.get(item.id);
      if (fState) fState.archetype = item.archetype;
    }

    for (const profile of sortedProfiles) {
      const rngBudget = mulberry32(hashString(`${roomCode}:${profile.id}:MAIN_BUDGET_SPLIT`));
      const a_t = 0.70 + (0.90 - 0.70) * rngBudget();
      const P_main_cap = Math.round(a_t * 125.00 * 100) / 100;
      const P_acc_vault = Math.round((125.00 - P_main_cap) * 100) / 100;

      const fState = this.franchiseStates.get(profile.id)!;
      fState.purseRemainingCr = 125.00;
      fState.squad = [];
      fState.pricesPaid = [];
      fState.roleCounts = { BAT: 0, WK: 0, AR: 0, PACE: 0, SPIN: 0 };
      fState.overseasCount = 0;
      fState.uncappedCount = 0;
      fState.totalSpentCr = 0.0;

      const privateTicks: PrivateAITicks = {
        tier1: Array.from(fState.tickList.tier1),
        tier2: Array.from(fState.tickList.tier2),
        tier3: Array.from(fState.tickList.tier3)
      };

      teams[profile.id] = {
        franchiseId: profile.id,
        name: profile.name,
        purse: 125.00,
        a_t,
        P_main_cap,
        P_acc_vault,
        squad: [],
        isHuman: false,
        ownerName: 'AI Manager',
        wishlistIds: [],
        privateTicks,
        mu_role: { BAT: 0.0, WK: 0.0, AR: 0.0, PACE: 0.0, SPIN: 0.0 },
        skipLotIds: []
      };
    }

    return teams;
  }

  /**
   * Extracts the 18 strictly bounded policy network input features.
   */
  public extractPolicyFeatures(
    player: IPLPlayer,
    franchiseId: string,
    currentBidCr: number,
    leadingFranchiseId?: string
  ): Float32Array {
    const profile = this.franchiseProfiles.get(franchiseId)!;
    const state = this.franchiseStates.get(franchiseId)!;
    const squadSize = state.squad.length;
    const targetSquad = profile.targetSquadSize || 19;
    const vInt = this.vIntrinsicMap.get(player.id) || player.basePrice || 0.30;

    // 1. player_ovr_norm
    const f1 = ((player.stats?.ovr || 72) - 75.0) / 15.0;
    // 2. player_is_overseas
    const f2 = player.isOverseas ? 1.0 : -1.0;
    // 3. bid_to_intrinsic_ratio
    const f3 = Math.max(-1.0, Math.min(2.0, (currentBidCr - vInt) / Math.max(1.0, vInt)));
    // 4. own_purse_norm
    const f4 = (state.purseRemainingCr - 62.5) / 62.5;

    // 5. purse_vs_league_avg
    let totalOtherPurse = 0.0;
    let otherCount = 0;
    for (const [id, s] of this.franchiseStates) {
      if (id !== franchiseId) {
        totalOtherPurse += s.purseRemainingCr;
        otherCount++;
      }
    }
    const avgRivalPurse = otherCount > 0 ? totalOtherPurse / otherCount : 62.5;
    const f5 = Math.max(-1.5, Math.min(1.5, (state.purseRemainingCr - avgRivalPurse) / 25.0));

    // 6. core_slots_left_norm
    const f6 = Math.max(0, 14 - squadSize) / 14.0;
    // 7. total_slots_left_norm
    const f7 = Math.max(0, targetSquad - squadSize) / 22.0;
    // 8. own_role_deficit
    const currentRoleCount = state.roleCounts[player.role] || 0;
    const targetRoleCount = TARGET_XI_QUOTAS[player.role] || 3;
    const f8 = Math.max(-1.0, Math.min(1.5, (targetRoleCount - currentRoleCount) / 4.0));

    // 9. marginal_xi_upgrade
    const sameRoleSquad = state.squad.filter(p => p.role === player.role);
    const weakestStarterOvr = sameRoleSquad.length > 0 ? Math.min(...sameRoleSquad.map(p => p.stats?.ovr || 70)) : 65.0;
    const f9 = Math.max(-1.0, Math.min(1.5, ((player.stats?.ovr || 72) - weakestStarterOvr) / 10.0));

    // 10. pool_role_scarcity
    const remainingInRole = Math.max(1, this.untickedRoleCounts[player.role] || 1);
    const unfilledLeague = Math.max(0, targetRoleCount * 10 - (currentRoleCount * 10));
    const f10 = Math.tanh((unfilledLeague / Math.max(1, remainingInRole)) - 1.0);

    // 11. venue_pitch_synergy
    const homePitch = profile.homePitch || { spin: 0, pace: 0, power: 0, dew: 0 };
    const pitchDot = (
      homePitch.spin * (player.groundVector?.spin ?? 0) +
      homePitch.pace * (player.groundVector?.pace ?? 0) +
      homePitch.power * (player.groundVector?.power ?? 0) +
      homePitch.dew * (player.groundVector?.dew ?? 0)
    );
    const f11 = Math.max(-1.0, Math.min(1.0, pitchDot));

    // 12. leader_desperation
    let f12 = -0.5;
    let leaderPurse = 62.5;
    if (leadingFranchiseId && leadingFranchiseId !== franchiseId) {
      const leaderState = this.franchiseStates.get(leadingFranchiseId);
      if (leaderState) {
        leaderPurse = leaderState.purseRemainingCr;
        const leaderRoleCount = leaderState.roleCounts[player.role] || 0;
        if (leaderRoleCount === 0) f12 = 1.0;
        else if (leaderRoleCount < targetRoleCount) f12 = 0.5;
      }
    }

    // 13. leader_purse_advantage
    const f13 = Math.max(-1.5, Math.min(1.5, (leaderPurse - state.purseRemainingCr) / 25.0));

    // 14-18. franchise DNA
    const f14 = Math.max(-1.0, Math.min(1.0, -profile.dna.z6_superstarThriftBias));
    const f15 = Math.max(-1.0, Math.min(1.0, profile.dna.z2_roleBias));
    const f16 = Math.max(-1.0, Math.min(1.0, profile.dna.z1_youthExperience));
    const f17 = Math.max(-1.0, Math.min(1.0, profile.dna.z4_riskTolerance));
    const f18 = Math.max(-1.0, Math.min(1.0, (profile.dna.z5_venueSynergyPriority || 0.5) * 2.0 - 1.0));

    return new Float32Array([f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18]);
  }

  public getPlayerValuation(player: IPLPlayer): ValuationOutput {
    const val = this.precomputedValuations.get(player.id);
    if (val) return val;
    const vInt = this.vIntrinsicMap.get(player.id) || player.basePrice || 0.30;
    const histMatches = player.historical?.matches || 20;
    const confidence = 0.88 + 0.12 * Math.min(1.0, histMatches / 35.0);
    const vAlpha = this.vAlphaMap.get(player.id) || Math.round(vInt * confidence * 100) / 100;
    return {
      mu: vInt,
      q15: Math.max(player.basePrice || 0.30, vAlpha * 0.85),
      q85: Math.min(27.0, vAlpha * 1.25),
      vIntrinsic: vInt,
      vAlpha,
      confidence
    };
  }

  /**
   * Evaluates a franchise's bid for the given player lot according to V3.0 master spec.
   * Execution latency: <0.02ms per bid.
   */
  public evaluateFranchiseBid(
    franchiseId: string,
    player: IPLPlayer,
    currentBidCr: number,
    isAcceleratedRound: boolean = false,
    leadingFranchiseId?: string,
    humanPurse?: number,
    humanSquadSize?: number
  ): AuctionBidDecision {
    const profile = this.franchiseProfiles.get(franchiseId);
    const state = this.franchiseStates.get(franchiseId);
    if (!profile || !state) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "INVALID_FRANCHISE" };
    }

    const squadSize = state.squad.length;
    const basePrice = player.basePrice || 0.30;
    const archetype: AIArchetype = profile.archetype || state.archetype || 'DISCIPLINED_PRAGMATIST';
    const targetSquad = archetype === 'SUPERSTAR_DUELIST' ? 18 : (archetype === 'MONEYBALL_CORE' ? 20 : 19);

    // =========================================================================
    // LAYER A: ALPHA VALUATION & CONFIDENCE HEAD
    // =========================================================================
    const vIntrinsic = this.vIntrinsicMap.get(player.id) || basePrice;
    const histMatches = player.historical?.matches || 20;
    const confidence = 0.88 + 0.12 * Math.min(1.0, histMatches / 35.0);
    const vAlpha = this.vAlphaMap.get(player.id) || Math.max(basePrice, Math.min(26.50, Math.round(vIntrinsic * confidence * 100) / 100));

    // =========================================================================
    // UNIFIED GUARD CLAUSES (Squad, Overseas, Role Caps)
    // =========================================================================

    // 1. Strict Squad Depth Limit: Maximum 22 players total
    if (squadSize >= 22) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "SQUAD_FULL" };
    }

    // 2. Strict Overseas Limit & Domestic Core Lock Gate
    if (player.isOverseas) {
      if (state.overseasCount >= 8) {
        return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "OVERSEAS_FULL" };
      }
      // If team already has 4+ overseas, lock out additional overseas players
      // until mandatory Indian core is secured: at least 1 Indian WK and at least 3 Indian bowlers/bowling ARs
      if (state.overseasCount >= 4) {
        const domWkCount = state.squad.filter(p => !p.isOverseas && p.role === 'WK').length;
        const domBowlerCount = state.squad.filter(p => !p.isOverseas && (p.role === 'PACE' || p.role === 'SPIN' || (p.role === 'AR' && (p.stats?.bowl || 0) >= 55))).length;
        if (domWkCount === 0 || domBowlerCount < 3) {
          return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "DOMESTIC_CORE_REQUIRED" };
        }
      }
      const slotsRemaining = targetSquad - squadSize;
      const domCount = state.squad.filter(p => !p.isOverseas).length;
      if (domCount < 7 && slotsRemaining <= (7 - domCount)) {
        return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "DOMESTIC_SLOTS_RESERVED" };
      }
    }

    // 3. Strict Role Saturated Gate
    const currentRoleCount = state.roleCounts[player.role] || 0;
    if (currentRoleCount >= (MAX_ROLE_CAPS[player.role] || 8)) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "ROLE_SATURATED" };
    }

    // 4. Mandatory Emergency Role Floors
    if (state.roleCounts.WK === 0 && squadSize >= 13 && player.role !== 'WK') {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "EMERGENCY_WK_REQUIRED" };
    }
    const currentBowlerCount = (state.roleCounts.PACE || 0) + (state.roleCounts.SPIN || 0) + (state.roleCounts.AR || 0);
    const isPlayerBowler = player.role === 'PACE' || player.role === 'SPIN' || player.role === 'AR' || (player.stats?.bowl || 0) >= 55;
    if (squadSize >= 12 && currentBowlerCount < 5 && !isPlayerBowler) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "EMERGENCY_BOWLER_REQUIRED" };
    }
    if (squadSize >= 14 && currentBowlerCount < 6 && !isPlayerBowler) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "EMERGENCY_BOWLER_REQUIRED" };
    }

    // =========================================================================
    // LAYER C: SOLVENCY CLAMP & ABSOLUTE LEGAL RESERVE
    // =========================================================================
    // Absolute legal reserve: RemainingSlotsTo18 * 0.40 Cr
    // For squadSize >= 18, remaining slots to 18 is 0, so legal reserve is 0 (can spend down to 0)
    const remainingSlotsTo18 = Math.max(0, 18 - squadSize - 1);
    const legalReserveCr = remainingSlotsTo18 * 0.40;
    const maxAffordableBid = Math.max(0.0, state.purseRemainingCr - legalReserveCr);

    // Calculate next required bid:
    // If another franchise is already leading at currentBidCr, next bid must increment above it
    let nextBid: number;
    if (currentBidCr <= 0) {
      nextBid = basePrice;
    } else if (leadingFranchiseId && leadingFranchiseId !== 'HUMAN_LEADER') {
      nextBid = Math.round((currentBidCr + getNextBidIncrement(currentBidCr)) * 100) / 100;
    } else {
      nextBid = Math.max(basePrice, currentBidCr);
    }

    if (nextBid > maxAffordableBid) {
      return {
        franchiseId,
        canBid: false,
        maxValuation: 0,
        nextBidAmount: 0,
        reactionDelayMs: 2000,
        reason: "SOLVENCY_RISK",
        components: {
          vBase: vAlpha,
          vIntrinsic,
          mPolicy: 1.0,
          mLiquidity: 0.0,
          mStage: 0.0,
          mDNA: 1.0,
          mScarcity: 1.0,
          mEMA: 1.0,
          mTick: 1.0,
          mWkEmergency: 1.0,
          mTaxEff: 1.0,
          pAvail: maxAffordableBid
        }
      };
    }

    // =========================================================================
    // LAYER B: SPECIALIST POLICY NETWORKS (3 Dedicated Weights)
    // =========================================================================
    const policyInput = this.extractPolicyFeatures(player, franchiseId, currentBidCr, leadingFranchiseId);
    let policyOut = { mPolicy: 1.0, pBluff: 0.10, tauSniper: 0.20 };

    let weightsToUse = this.archetypeWeights.get(archetype) || this.archetypeWeights.get('DISCIPLINED_PRAGMATIST');
    if (this.franchiseWeightOverrides.has(franchiseId)) {
      const override = this.franchiseWeightOverrides.get(franchiseId);
      weightsToUse = override === null ? undefined : override;
    }
    if (weightsToUse) {
      policyOut = forwardPolicyNet(policyInput, weightsToUse);
    }

    // =========================================================================
    // LAYER C: CAPITAL STAGING & MARGINAL ROLE NEED
    // =========================================================================

    // 1. Starting XI Capital Staging (mStage)
    let mStage = 1.0;
    if (squadSize < 11) {
      // Top 10-11 starters: deploy ₹105 - ₹112 Cr, reserve ₹16.50 Cr for bench depth
      const starterSlotsLeft = Math.max(1, 11 - squadSize);
      const starterAllocPerSlot = (state.purseRemainingCr - 16.50) / starterSlotsLeft;
      mStage = clip(1.05 + 0.12 * (starterAllocPerSlot - 9.0), 0.90, 1.35);
    } else if (squadSize < 18) {
      // Bench depth (slots 12 to 18): deploy remaining budget down to target buffer
      const remSlots = Math.max(1, 18 - squadSize);
      mStage = clip(0.75 + 0.15 * (state.purseRemainingCr / remSlots - 2.20), 0.55, 1.15);
    } else {
      mStage = 0.85;
    }

    // 2. Starting XI Marginal Role Need (TARGET_XI_QUOTAS: 4 BAT, 1 WK, 2 AR, 3 PACE, 2 SPIN)
    const targetQuota = TARGET_XI_QUOTAS[player.role] || 3;
    let needFactor = 1.0;
    if (currentRoleCount < targetQuota) {
      needFactor = 1.0 + 0.12 * (targetQuota - currentRoleCount);
    } else {
      needFactor = 0.85; // Bench discount
    }

    // 3. Emergency WK Floor: 1.40x–1.65x if Current WK == 0
    let mWkEmergency = 1.0;
    if (player.role === 'WK' && state.roleCounts.WK === 0) {
      const currentSet = player.marqueeSet || 1;
      if (currentSet <= 3 && squadSize < 8) {
        // Sets 1-3: Marquee sets; no panic overpay because Set 5 is the dedicated WK pool
        needFactor = Math.max(needFactor, 1.15);
        mWkEmergency = 1.15;
      } else {
        // Set 4+ or squad reaching 8+ with 0 WKs
        const wkMultiplier = squadSize >= 11 ? 1.65 : 1.40;
        needFactor = Math.max(needFactor, wkMultiplier);
        mWkEmergency = wkMultiplier;
      }
    }

    // Contextual Modifiers: DNA, Tick list, EMA, Scarcity
    const dna = profile.dna;
    const isYouth = player.age <= 24;
    const isVeteran = player.age >= 33;
    const ageBonus = isYouth ? 0.06 * dna.z1_youthExperience : (isVeteran ? -0.06 * dna.z1_youthExperience : 0.0);
    const natBonus = !player.isOverseas ? 0.06 * dna.z3_indianCoreBias : -0.04 * dna.z3_indianCoreBias;
    const homePitch = profile.homePitch || { spin: 0, pace: 0, power: 0, dew: 0 };
    const pitchDot = (
      homePitch.spin * (player.groundVector?.spin ?? 0) +
      homePitch.pace * (player.groundVector?.pace ?? 0) +
      homePitch.power * (player.groundVector?.power ?? 0) +
      homePitch.dew * (player.groundVector?.dew ?? 0)
    );
    const venueBonus = 0.10 * dna.z5_venueSynergyPriority * Math.max(-0.5, Math.min(1.0, pitchDot));
    const mDNA = Math.max(0.80, Math.min(1.30, 1.0 + ageBonus + natBonus + venueBonus));

    // Private Tick List Multiplier
    let mTick = 0.96;
    if (state.tickList.tier1.has(player.id)) mTick = 1.18;
    else if (state.tickList.tier2.has(player.id)) mTick = 1.08;
    else if (state.tickList.tier3.has(player.id)) mTick = 1.02;

    // Role EMA & League-Wide Scarcity
    const mEMA = Math.max(0.88, Math.min(1.25, this.roleEMAs[player.role] || 1.0));
    const remainingUnticked = Math.max(1, this.untickedRoleCounts[player.role] || 1);
    let mScarcity = 1.0;
    if (currentRoleCount < targetQuota) {
      const deficit = targetQuota - currentRoleCount;
      mScarcity = 1.0 + Math.min(0.30, (deficit / remainingUnticked) * 0.25);
    }

    // Synthesis Valuation (Tri-Head Layer A * Layer B * Layer C)
    let targetVal = vAlpha * policyOut.mPolicy * mStage * needFactor * mDNA * mTick * mEMA * mScarcity;

    // AI Aggression Profile Modifier (Host Slider: 0.20 Dynamic -> 0.45 Balanced -> 0.80 Conservative)
    const hostDeterminism = this.config?.determinismRatio ?? 0.45;
    const hostAggressionMult = 1.0 + (0.45 - hostDeterminism) * 0.40;
    targetVal *= hostAggressionMult;

    const ovr = player.stats?.ovr ?? 72;

    // Competitive Counter-Bidding (Host Checkbox: humanTaxEnabled)
    if (this.config?.humanTaxEnabled && leadingFranchiseId === 'HUMAN_LEADER' && ovr >= 80) {
      targetVal *= 1.06; // 6% competitive pressure against human bids
    }

    // =========================================================================
    // ARCHETYPE SPECIFIC MULTIPLIERS (SD, MB, DP)
    // =========================================================================
    const playerSet = player.marqueeSet || 1;

    // Bowler & Spinner Synergy Evaluation
    const isBowlerOrSpin = player.role === 'PACE' || player.role === 'SPIN' || (player.role === 'AR' && (player.stats?.bowl || 0) >= 55) || playerSet === 4 || playerSet === 8;
    const rolePitchSynergy = player.role === 'SPIN'
      ? homePitch.spin
      : (player.role === 'PACE' ? homePitch.pace : Math.max(homePitch.spin, homePitch.pace));
    const hasStrongBowlerSynergy = pitchDot > 0.05 || rolePitchSynergy > 0.10 || (player.tacticalSynergy?.death || 0) >= 0.35 || state.tickList.tier1.has(player.id) || ovr >= 84;

    if (archetype === 'SUPERSTAR_DUELIST') {
      // [SUPERSTAR DUELISTS (SD)]:
      // - If SuperstarsBought < 2 and OVR >= 90: TargetVal = Min(26.50, TargetVal * 1.30).
      // - Once SuperstarsBought >= 2: Immediately cap subsequent lots at max ₹16.50 Cr.
      // - Target squad: Exactly 18 players.
      const expensivePurchases = (state.pricesPaid || []).filter(price => price >= 15.0).length;
      const marqueePurchases = state.squad.filter(p => (p.stats?.ovr || 0) >= 90).length;
      const superstarCount = Math.max(expensivePurchases, marqueePurchases);

      if (superstarCount < 2 && ovr >= 90 && squadSize < 11) {
        targetVal = Math.min(26.50, targetVal * 1.30);
      } else if (superstarCount >= 2) {
        targetVal = Math.min(16.50, targetVal);
      }

      // Bowler & Spin synergy exception to avoid hoarding unspent purse:
      if (isBowlerOrSpin && hasStrongBowlerSynergy && (state.purseRemainingCr >= 16.0 || playerSet === 4 || playerSet === 8)) {
        targetVal = Math.min(17.50, Math.max(targetVal, targetVal * 1.20));
      }
    } else if (archetype === 'MONEYBALL_CORE') {
      // [MONEYBALL CORE (MB)]:
      // - OVR > 90: Cap at max ₹13.00 Cr (0.70x discount).
      // - 82 <= OVR <= 90: Aggressive +25% valuation boost up to ₹18.50 Cr.
      // - OVR < 82: Relegate to down-pool value (max ₹2.50 Cr or 0.60x).
      // - Target squad: Exactly 20 players.
      if (ovr > 90) {
        targetVal = Math.min(13.00, targetVal * 0.70);
      } else if (ovr >= 82 && ovr <= 90) {
        targetVal = Math.min(18.50, targetVal * 1.25);
      } else {
        const downPoolVal = Math.min(2.50, targetVal * 0.60);
        targetVal = Math.max(basePrice, downPoolVal);
        if (playerSet >= 6 && squadSize < 18 && maxAffordableBid >= basePrice) {
          targetVal = Math.max(targetVal, Math.min(maxAffordableBid, Math.max(basePrice, 0.80)));
        }
      }
    } else {
      // [DISCIPLINED PRAGMATIST (DP)]:
      // Follow intrinsic fair valuation. Cap single lots at max ₹16.50 Cr.
      // Target squad: Exactly 19 players.
      targetVal = Math.min(16.50, targetVal);
    }

    // Uncapped Surplus Deployer:
    // If any AI is left with more than ₹20.0 Cr after Set 6 for uncapped players, they receive a 1.10x multiplier
    if (playerSet > 6 && state.purseRemainingCr > 20.0 && player.isUncapped) {
      targetVal = targetVal * 1.10;
    }

    // Single-Bid Purse Ceiling: Once a team has 4+ players, prevent dumping >40% of remaining purse on one player
    if (squadSize >= 4 && squadSize < 11) {
      targetVal = Math.min(targetVal, state.purseRemainingCr * 0.40);
    }

    // Absolute superstar ceiling clamp
    targetVal = Math.min(26.50, targetVal);

    // Solvency guardrail: Never exceed maxAffordableBid
    targetVal = Math.max(basePrice, Math.min(targetVal, maxAffordableBid));

    // Emergency Squad Depth Floor: If squad has < 18 players and can afford basePrice, ensure at least base price
    if (squadSize < 18 && maxAffordableBid >= basePrice) {
      targetVal = Math.max(targetVal, basePrice);
    }

    // =========================================================================
    // FEATURE: POST-18 OPPORTUNISTIC BIDDING & RIVAL BANKRUPTCY PROTECTION
    // =========================================================================
    if (squadSize >= 18) {
      // 1. ANTI-GRIEF / RIVAL BANKRUPTCY SAFETY CHECK
      // Inspect current leading bidder (human or rival AI)
      if (leadingFranchiseId) {
        if (leadingFranchiseId === 'HUMAN_LEADER' && typeof humanPurse === 'number' && typeof humanSquadSize === 'number') {
          if (humanSquadSize < 18) {
            const slotsNeededByLeader = Math.max(0, 18 - humanSquadSize - 1);
            const leaderPurseAfterBid = humanPurse - nextBid;
            const minimumLegalReserveNeeded = slotsNeededByLeader * 0.40;

            if (leaderPurseAfterBid < minimumLegalReserveNeeded + 0.50) {
              return {
                franchiseId,
                canBid: false,
                maxValuation: 0,
                nextBidAmount: 0,
                reactionDelayMs: 2000,
                reason: "PROTECT_RIVAL_SOLVENCY"
              };
            }
          }
        } else {
          const leaderState = this.franchiseStates.get(leadingFranchiseId);
          if (leaderState && leaderState.squad.length < 18) {
            const slotsNeededByLeader = Math.max(0, 18 - leaderState.squad.length - 1);
            const leaderPurseAfterBid = leaderState.purseRemainingCr - nextBid;
            const minimumLegalReserveNeeded = slotsNeededByLeader * 0.40;

            if (leaderPurseAfterBid < minimumLegalReserveNeeded + 0.50) {
              return {
                franchiseId,
                canBid: false,
                maxValuation: 0,
                nextBidAmount: 0,
                reactionDelayMs: 2000,
                reason: "PROTECT_RIVAL_SOLVENCY"
              };
            }
          }
        }
      }

      // 2. Opportunistic Acquisition & Rich Human Competition
      // High-value bargain: OVR >= 80 and price < 65% intrinsic valuation
      const isHighValueBargain = (player.stats?.ovr || 70) >= 80 && currentBidCr < (vIntrinsic * 0.65);

      // Rich human competition: human leading with ample surplus and player OVR >= 86
      const isRichHumanLeading = leadingFranchiseId === 'HUMAN_LEADER' &&
        typeof humanPurse === 'number' && typeof humanSquadSize === 'number' &&
        ((humanPurse - nextBid) / Math.max(1, 18 - humanSquadSize)) >= 0.85 &&
        (player.stats?.ovr || 70) >= 86;

      // Moneyball Core target squad is 20, so MB with 18 or 19 can also pick up down-pool value
      const isMBFillingTarget = archetype === 'MONEYBALL_CORE' && squadSize < 20 && (ovr >= 82 || currentBidCr <= 2.50);

      if (isHighValueBargain || isRichHumanLeading || isMBFillingTarget) {
        // Opportunistically acquire depth at discounted valuation (ok if purse goes to 0 after 18 squad)
        targetVal = Math.min(targetVal, Math.min(vIntrinsic * 0.85, state.purseRemainingCr));
      } else {
        return {
          franchiseId,
          canBid: false,
          maxValuation: 0,
          nextBidAmount: 0,
          reactionDelayMs: 2000,
          reason: "NOT_NEEDED_PRESERVE_PURSE"
        };
      }
    } else {
      // Squad size < 18: Predatory Human-Awareness Solvency Trap vs Purse Squeeze
      if (leadingFranchiseId === 'HUMAN_LEADER' && typeof humanPurse === 'number' && typeof humanSquadSize === 'number') {
        const humanSlotsNeeded = Math.max(1, 18 - humanSquadSize);
        const humanSurplusPerSlot = (humanPurse - nextBid) / humanSlotsNeeded;

        // Solvency Trap: If human is in danger of illegal/insolvent squad (< 0.65 Cr/slot needed)
        // AI must NOT counter-bid! Step back and let human win
        if (humanSurplusPerSlot < 0.65) {
          return {
            franchiseId,
            canBid: false,
            maxValuation: 0,
            nextBidAmount: 0,
            reactionDelayMs: 2000,
            reason: "HUMAN_SOLVENCY_TRAP",
            components: {
              vBase: vAlpha,
              vIntrinsic,
              mDNA: 1,
              mScarcity: 1,
              mEMA: 1,
              mTick: 1,
              mWkEmergency: 1,
              mTaxEff: 1,
              pAvail: maxAffordableBid
            }
          };
        }

        // Purse Squeeze: If human has plenty of surplus (>= 0.85 Cr/slot needed) and AI has cushion
        const aiSurplus = state.purseRemainingCr - legalReserveCr;
        if (humanSurplusPerSlot >= 0.85 && aiSurplus >= 4.00 && squadSize >= 12) {
          const squeezeCeiling = Math.min(maxAffordableBid, Math.min(vIntrinsic * 1.15, nextBid + getNextBidIncrement(nextBid)));
          if (squeezeCeiling >= nextBid && targetVal < squeezeCeiling) {
            targetVal = squeezeCeiling; // Push price up 1 tick
          }
        }
      }
    }

    // Valuation Exceeded check
    if (nextBid > targetVal) {
      return {
        franchiseId,
        canBid: false,
        maxValuation: Math.round(targetVal * 100) / 100,
        nextBidAmount: 0,
        reactionDelayMs: 1800,
        reason: "VALUATION_EXCEEDED",
        components: {
          vBase: vAlpha,
          vIntrinsic,
          mPolicy: Math.round(policyOut.mPolicy * 100) / 100,
          mLiquidity: Math.round(mStage * 100) / 100,
          mStage: Math.round(mStage * 100) / 100,
          mDNA: Math.round(mDNA * 100) / 100,
          mScarcity: Math.round(mScarcity * 100) / 100,
          mEMA: Math.round(mEMA * 100) / 100,
          mTick: Math.round(mTick * 100) / 100,
          mWkEmergency: Math.round(mWkEmergency * 100) / 100,
          mTaxEff: 1.0,
          pAvail: Math.round(maxAffordableBid * 100) / 100,
          pBluff: Math.round(policyOut.pBluff * 100) / 100,
          tauSniper: Math.round(policyOut.tauSniper * 100) / 100
        }
      };
    }

    const reactionDelayMs = Math.round(400 + policyOut.tauSniper * 1400);

    return {
      franchiseId,
      canBid: true,
      maxValuation: Math.round(targetVal * 100) / 100,
      nextBidAmount: Math.round(nextBid * 100) / 100,
      reactionDelayMs,
      reason: "ACTIVE_BID",
      components: {
        vBase: vAlpha,
        vIntrinsic,
        mPolicy: Math.round(policyOut.mPolicy * 100) / 100,
        mLiquidity: Math.round(mStage * 100) / 100,
        mStage: Math.round(mStage * 100) / 100,
        mDNA: Math.round(mDNA * 100) / 100,
        mScarcity: Math.round(mScarcity * 100) / 100,
        mEMA: Math.round(mEMA * 100) / 100,
        mTick: Math.round(mTick * 100) / 100,
        mWkEmergency: Math.round(mWkEmergency * 100) / 100,
        mTaxEff: 1.0,
        pAvail: Math.round(maxAffordableBid * 100) / 100,
        pBluff: Math.round(policyOut.pBluff * 100) / 100,
        tauSniper: Math.round(policyOut.tauSniper * 100) / 100
      }
    };
  }

  /**
   * SocketHub Compatibility Layer: evaluateBidEligibility
   */
  public evaluateBidEligibility(
    roomCode: string,
    team: TeamAuctionState,
    profile: FranchiseAuctionProfile,
    player: IPLPlayer,
    currentLotPrice: number,
    remPlayersInPool: IPLPlayer[],
    lotIdx: number,
    phase: AuctionPhase,
    leadingBidderIsHuman: boolean = false,
    humanPurse: number = 0,
    humanSquadSize: number = 0
  ): BidDecision {
    const fState = this.franchiseStates.get(team.franchiseId);
    if (fState) {
      fState.purseRemainingCr = team.purse;
      fState.squad = [...team.squad];
      fState.roleCounts = { BAT: 0, WK: 0, AR: 0, PACE: 0, SPIN: 0 };
      fState.overseasCount = 0;
      fState.uncappedCount = 0;
      for (const p of team.squad) {
        fState.roleCounts[p.role] = (fState.roleCounts[p.role] || 0) + 1;
        if (p.isOverseas) fState.overseasCount++;
        if (p.isUncapped) fState.uncappedCount++;
      }
    }

    const decision = this.evaluateFranchiseBid(
      team.franchiseId,
      player,
      currentLotPrice,
      phase !== 'MAIN',
      leadingBidderIsHuman ? 'HUMAN_LEADER' : undefined,
      humanPurse,
      humanSquadSize
    );

    if (decision.canBid && decision.maxValuation >= currentLotPrice) {
      return {
        state: 'ELIGIBLE',
        mValue: decision.maxValuation,
        mTaxEff: decision.maxValuation,
        reactionDelayMs: decision.reactionDelayMs,
        reason: decision.reason
      };
    } else {
      return {
        state: 'NO_BID',
        reason: decision.reason,
        mValue: decision.maxValuation,
        reactionDelayMs: decision.reactionDelayMs
      };
    }
  }

  /**
   * Mode A: Silent Vickrey Second-Price Resolution (<0.02ms)
   */
  public resolveModeAVickrey(
    roomCode: string,
    teams: Record<string, TeamAuctionState>,
    player: IPLPlayer,
    remPlayers: IPLPlayer[],
    lotIdx: number,
    phase: AuctionPhase,
    minStartingPrice?: number
  ): {
    status: 'SOLD' | 'UNSOLD';
    winnerId: string | null;
    soldPrice: number;
    secondValuation: number;
  } {
    const basePrice = Math.max(player.basePrice || 0.30, minStartingPrice || 0.0);
    const eligibleAIs: Array<{ id: string; mValue: number }> = [];

    for (const team of Object.values(teams)) {
      if (team.isHuman) continue;
      const profile = this.franchiseProfiles.get(team.franchiseId);
      if (!profile) continue;

      const dec = this.evaluateBidEligibility(
        roomCode,
        team,
        profile,
        player,
        basePrice,
        remPlayers,
        lotIdx,
        phase
      );

      if (dec.state === 'ELIGIBLE' && dec.mValue && dec.mValue >= basePrice) {
        eligibleAIs.push({ id: team.franchiseId, mValue: dec.mValue });
      }
    }

    if (this.untickedRoleCounts[player.role] > 0) {
      this.untickedRoleCounts[player.role]--;
    }

    if (eligibleAIs.length === 0) {
      return { status: 'UNSOLD', winnerId: null, soldPrice: 0.0, secondValuation: 0.0 };
    }

    eligibleAIs.sort((a, b) => b.mValue - a.mValue);

    if (eligibleAIs.length === 1) {
      return {
        status: 'SOLD',
        winnerId: eligibleAIs[0].id,
        soldPrice: basePrice,
        secondValuation: basePrice
      };
    }

    const winner = eligibleAIs[0];
    const second = eligibleAIs[1];

    // Climb the exact IPL bid increment ladder starting from basePrice
    let soldPrice = basePrice;
    let safety = 0;
    while (safety++ < 500) {
      const inc = getNextBidIncrement(soldPrice);
      const nextStep = Math.round((soldPrice + inc) * 100) / 100;

      if (nextStep <= second.mValue && nextStep <= winner.mValue) {
        soldPrice = nextStep;
      } else if (soldPrice <= second.mValue && nextStep <= winner.mValue) {
        soldPrice = nextStep;
        break;
      } else {
        break;
      }
    }

    return {
      status: 'SOLD',
      winnerId: winner.id,
      soldPrice: Math.round(soldPrice * 100) / 100,
      secondValuation: second.mValue
    };
  }

  /**
   * Post-Lot State Updates: commits lot sale and updates role-isolated EMAs.
   */
  public commitLotSale(
    teams: Record<string, TeamAuctionState>,
    player: IPLPlayer,
    winnerId: string | null,
    soldPrice: number,
    humanSkipRatio: number = 0.0
  ): void {
    const role = player.role;
    const vInt = this.vIntrinsicMap.get(player.id) || player.basePrice || 0.30;

    if (winnerId && teams[winnerId]) {
      const winner = teams[winnerId];
      winner.purse = Math.round((winner.purse - soldPrice) * 100) / 100;
      winner.squad.push({ ...player, soldPrice });

      const fState = this.franchiseStates.get(winnerId);
      if (fState) {
        fState.purseRemainingCr = winner.purse;
        fState.totalSpentCr = Math.round((fState.totalSpentCr + soldPrice) * 100) / 100;
        if (fState.squad !== winner.squad) {
          fState.squad.push(player);
        }
        fState.pricesPaid.push(soldPrice);
        fState.roleCounts[player.role] = (fState.roleCounts[player.role] || 0) + 1;
        if (player.isOverseas) fState.overseasCount++;
        if (player.isUncapped) fState.uncappedCount++;
        fState.tickList.tier1.delete(player.id);
        fState.tickList.tier2.delete(player.id);
        fState.tickList.tier3.delete(player.id);
      }

      winner.privateTicks.tier1 = winner.privateTicks.tier1.filter(id => id !== player.id);
      winner.privateTicks.tier2 = winner.privateTicks.tier2.filter(id => id !== player.id);
      winner.privateTicks.tier3 = winner.privateTicks.tier3.filter(id => id !== player.id);

      if (vInt > 0) {
        const ratio = Math.max(0.70, Math.min(1.50, soldPrice / vInt));
        this.roleEMAs[role] = Math.round((0.85 * this.roleEMAs[role] + 0.15 * ratio) * 1000) / 1000;
        const normalizedMu = this.roleEMAs[role] - 1.0;
        for (const t of Object.values(teams)) {
          t.mu_role[role] = Math.max(-0.20, Math.min(0.25, normalizedMu));
        }
      }
    } else {
      if ((player.stats?.ovr || 72) >= 82) {
        this.roleEMAs[role] = Math.max(0.80, this.roleEMAs[role] - 0.05 * (1.0 - 0.5 * humanSkipRatio));
        const normalizedMu = this.roleEMAs[role] - 1.0;
        for (const t of Object.values(teams)) {
          t.mu_role[role] = Math.max(-0.20, Math.min(0.25, normalizedMu));
        }
      }
    }

    if (this.untickedRoleCounts[role] > 0) {
      this.untickedRoleCounts[role]--;
    }
  }

  /**
   * Mode B: Live Step-by-Step Interactive Bid Reaction
   */
  public evaluateLiveBidModeB(
    franchiseId: string,
    player: IPLPlayer,
    currentBidCr: number,
    leadingFranchiseId?: string,
    isAcceleratedRound: boolean = false
  ): AuctionBidDecision {
    if (leadingFranchiseId === franchiseId) {
      return {
        franchiseId,
        canBid: false,
        maxValuation: 0,
        nextBidAmount: 0,
        reactionDelayMs: 2000,
        reason: "ALREADY_LEADING"
      };
    }

    return this.evaluateFranchiseBid(franchiseId, player, currentBidCr, isAcceleratedRound, leadingFranchiseId);
  }

  /**
   * Summary KPI report across all 10 franchises.
   */
  public getAuctionSummary(): {
    franchises: {
      id: string;
      name: string;
      squadSize: number;
      purseRemainingCr: number;
      totalSpentCr: number;
      overseasCount: number;
      wkCount: number;
      roles: Record<PrimaryRole, number>;
    }[];
    roleInflationEMAs: Record<PrimaryRole, number>;
  } {
    const franchises = Array.from(this.franchiseStates.values()).map(st => {
      const profile = this.franchiseProfiles.get(st.franchiseId)!;
      return {
        id: st.franchiseId,
        name: profile.name,
        squadSize: st.squad.length,
        purseRemainingCr: st.purseRemainingCr,
        totalSpentCr: st.totalSpentCr,
        overseasCount: st.overseasCount,
        wkCount: st.roleCounts.WK || 0,
        roles: { ...st.roleCounts }
      };
    });

    return {
      franchises,
      roleInflationEMAs: { ...this.roleEMAs }
    };
  }

  /**
   * Outbound sanitizeRoomDTO:
   * Strips private AI DNA vectors, vaults, ticks, provisional Mode A winners, and ceilings.
   */
  public sanitizeRoomDTO(rawRoom: any): SanitizeRoomDTO {
    const sanitizedTeams: Record<string, any> = {};

    for (const [tId, t] of Object.entries(rawRoom.teams as Record<string, TeamAuctionState>)) {
      sanitizedTeams[tId] = {
        franchiseId: t.franchiseId,
        name: t.name,
        purse: t.purse,
        squad: t.squad,
        isHuman: t.isHuman,
        ownerName: t.ownerName,
        wishlistIds: t.isHuman ? t.wishlistIds : [],
        skipLotIds: t.isHuman ? (t.skipLotIds || []) : [],
        connected: t.connected
      };
    }

    let sanitizedLot: any = null;
    if (rawRoom.currentLot) {
      sanitizedLot = {
        lotId: rawRoom.currentLot.lotId,
        player: rawRoom.currentLot.player,
        lotNumber: rawRoom.currentLot.lotNumber,
        totalLots: rawRoom.currentLot.totalLots,
        phase: rawRoom.currentLot.phase,
        currentPrice: rawRoom.currentLot.currentPrice,
        currentBidder: rawRoom.currentLot.currentBidder,
        currentBidderName: rawRoom.currentLot.currentBidderName,
        biddingMode: rawRoom.currentLot.biddingMode,
        timerMs: rawRoom.currentLot.timerMs,
        timerTotalMs: rawRoom.currentLot.timerTotalMs,
        isTimerRunning: rawRoom.currentLot.isTimerRunning,
        bidHistory: rawRoom.currentLot.bidHistory,
        state: rawRoom.currentLot.state
      };
    }

    return {
      roomCode: rawRoom.roomCode,
      status: rawRoom.status,
      phase: rawRoom.phase || 'MAIN',
      determinismRatio: rawRoom.determinismRatio,
      humanTaxEnabled: rawRoom.humanTaxEnabled,
      isPaused: rawRoom.isPaused,
      lastSavedAt: rawRoom.lastSavedAt,
      teams: sanitizedTeams,
      currentLot: sanitizedLot,
      completedLotsCount: rawRoom.completedLots?.length || 0,
      completedLots: rawRoom.completedLots || [],
      lastResolvedLot: rawRoom.lastResolvedLot || null,
      recentSold: (rawRoom.completedLots || [])
        .filter((l: any) => l.soldTo !== null)
        .slice(-5)
        .map((l: any) => ({ player: l.player, soldPrice: l.soldPrice, soldTo: l.soldTo })),
      recentUnsold: (rawRoom.completedLots || [])
        .filter((l: any) => l.soldTo === null)
        .slice(-5)
        .map((l: any) => l.player),
      wishlistTimer: {
        msRemaining: rawRoom.wishlistTimer?.msRemaining || 0,
        totalMs: rawRoom.wishlistTimer?.totalMs || 180000,
        submittedCount: rawRoom.wishlistTimer?.submittedTeamIds?.length || 0,
        totalHumans: Object.values(rawRoom.teams || {}).filter((t: any) => t.isHuman).length,
        wishlistEndsAt: rawRoom.wishlistEndsAt
      },
      wishlistEndsAt: rawRoom.wishlistEndsAt,
      seats: (rawRoom.seats || []).map((s: any) => ({
        teamId: s.teamId,
        teamName: s.teamName,
        isHuman: s.isHuman,
        playerName: s.playerName,
        connected: Boolean(s.connected)
      })),
      commentaryTicker: rawRoom.commentaryTicker || [],
      season: rawRoom.season || null,
      skipVotes: rawRoom.skipVotes ? (Array.isArray(rawRoom.skipVotes) ? rawRoom.skipVotes : Array.from(rawRoom.skipVotes)) : [],
      setSkipVotes: rawRoom.setSkipVotes ? (Array.isArray(rawRoom.setSkipVotes) ? rawRoom.setSkipVotes : Array.from(rawRoom.setSkipVotes)) : [],
      setSkipVotesCount: rawRoom.setSkipVotes ? (Array.isArray(rawRoom.setSkipVotes) ? rawRoom.setSkipVotes.length : rawRoom.setSkipVotes.size) : 0,
      totalActiveHumans: (rawRoom.seats || []).filter((s: any) => s.isHuman && s.connected).length || Object.values(rawRoom.teams || {}).filter((t: any) => t.isHuman).length || 1,
      lastSetSummary: rawRoom.lastSetSummary || null,
      isAuctionPaused: Boolean(rawRoom.isPaused),
      auctionSpeedMultiplier: rawRoom.speedMultiplier || 1,
      hostId: rawRoom.hostId,
      hostDeviceUUID: rawRoom.hostDeviceUUID || rawRoom.hostId
    };
  }
}

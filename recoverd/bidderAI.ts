/**
 * bidderAI.ts - Server-Authoritative V1.7 Auction Bidder AI Engine
 * Strictly adhering to IPL_AUCTION_BIDDING_AI_MASTER_SPEC_V1.7
 * Powered by Model 2 (auction_bid_net.onnx) with fast analytical fallback (<0.2ms/lot).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  type IPLPlayer,
  type PrimaryRole,
  type GroundSynergyVector
} from '../../src/types/player.types.ts';

const require = createRequire(import.meta.url);
let ort: any = null;
try {
  ort = require('onnxruntime-node');
} catch (e) {
  ort = null;
}

// =============================================================================
// 1. DATA STRUCTURES & INTERFACES (V1.7)
// =============================================================================

export interface TeamDNA {
  z1_youthExperience: number;      // [-1.0 .. 1.0] Youth (+1) vs Veteran Experience (-1)
  z2_roleBias: number;             // [-1.0 .. 1.0] Bat-heavy/Bat-AR (+1) vs Bowl-heavy/Bowl-AR (-1)
  z3_indianCoreBias: number;       // [-1.0 .. 1.0] Indian Domestic Stars (+1) vs Overseas Marquee (-1)
  z4_riskTolerance: number;        // [-1.0 .. 1.0] Aggressive War Willingness (+1) vs Conservative Thrift (-1)
  z5_venueSynergyPriority: number; // [0.0 .. 1.0] Weight placed on franchise home pitch fit
  z6_superstarThriftBias: number;  // [-1.0 .. 1.0] Thrifty Bargains (+1) vs Superstar War Chest (-1)
}

export interface FranchiseAuctionProfile {
  id: string;                      // e.g. "CSK", "MI", "KKR", "RCB", etc.
  name: string;
  homeVenueName: string;
  homePitch: GroundSynergyVector;
  dna: TeamDNA;
  targetSquadSize: number;         // [21..24] Target squad depth (prevents stopping at bare 18 minimum)
}

export interface FranchiseRosterState {
  franchiseId: string;
  purseRemainingCr: number;        // Initial ₹120.00 Cr
  squad: IPLPlayer[];
  pricesPaid: number[];            // History of acquisition prices paid (Cr)
  roleCounts: Record<PrimaryRole, number>;
  overseasCount: number;
  uncappedCount: number;
  totalSpentCr: number;
  tickList: {
    tier1: Set<string>;            // 4-6 must-have pillar targets (1.20x)
    tier2: Set<string>;            // 8-12 core targets (1.08x)
    tier3: Set<string>;            // 12-16 budget depth / uncapped picks (1.03x)
  };
}

export interface ValuationOutput {
  mu: number;                      // Fair market value (Cr)
  q15: number;                     // Conservative floor (Cr)
  q85: number;                     // War ceiling (Cr)
}

export interface AuctionBidDecision {
  franchiseId: string;
  canBid: boolean;
  maxValuation: number;            // Final adjusted ceiling for this lot (Cr)
  nextBidAmount: number;           // Proposed next bid (Cr)
  reactionDelayMs: number;         // Mode B live auction reaction delay (400ms - 2100ms)
  reason: string;                  // "ACTIVE_BID", "VALUATION_EXCEEDED", "PURSE_CLAMP", "OVERSEAS_FULL", "SQUAD_FULL", "ROLE_SATURATED"
  components?: {
    vBase: number;
    mDNA: number;
    mScarcity: number;
    mEMA: number;
    mTick: number;
    mWkEmergency: number;
    mTaxEff: number;
    pAvail: number;
  };
}

export interface AuctionLotResolution {
  lotNumber: number;
  player: IPLPlayer;
  sold: boolean;
  winningFranchiseId?: string;
  winningPrice?: number;
  secondPrice?: number;
  numBidders: number;
  allBids: { franchiseId: string; maxValuation: number }[];
}

export interface AuctionEngineConfig {
  determinismRatio: number;        // 0.40 - 0.45 deterministic V1.7 valuation
  humanTaxEnabled: boolean;        // Deterministic Human Tax mode
  acceleratedVaultReserveCr: number; // e.g. 8.0 - 15.0 Cr vault for Accelerated Round
}

// Standard IPL Bid Increment Ladder
export function getNextBidIncrement(currentBid: number): number {
  if (currentBid < 1.00) return 0.05;      // +5 Lakhs (< ₹1.00 Cr)
  if (currentBid < 2.00) return 0.10;      // +10 Lakhs (₹1.00 Cr - ₹2.00 Cr)
  if (currentBid < 5.00) return 0.20;      // +20 Lakhs (₹2.00 Cr - ₹5.00 Cr)
  return 0.25;                             // +25 Lakhs (>= ₹5.00 Cr)
}

// =============================================================================
// 2. DEFAULT 10 IPL FRANCHISES WITH V1.7 6-D TEAM DNA
// =============================================================================

export const DEFAULT_IPL_FRANCHISES: FranchiseAuctionProfile[] = [
  {
    id: 'CSK',
    name: 'Chennai Super Kings',
    homeVenueName: 'M. A. Chidambaram Stadium (Chepauk)',
    homePitch: { spin: 0.85, pace: -0.20, power: -0.35, dew: 0.65 },
    targetSquadSize: 19,
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
    targetSquadSize: 19,
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
    targetSquadSize: 18,
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
    targetSquadSize: 19,
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
    targetSquadSize: 18,
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
    targetSquadSize: 18,
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

// Target roles for balanced 18-25 squad
const TARGET_ROLE_COUNTS: Record<PrimaryRole, number> = {
  BAT: 6,
  WK: 2,
  AR: 5,
  PACE: 6,
  SPIN: 4
};

// Strict upper role ceiling per franchise (prevents hoarding)
const MAX_ROLE_CAPS: Record<PrimaryRole, number> = {
  BAT: 8,
  WK: 2,
  AR: 7,
  PACE: 8,
  SPIN: 6
};

// =============================================================================
// 3. AUCTION BIDDER AI ENGINE CLASS
// =============================================================================

export class AuctionBidderAI {
  private onnxSession: any = null;
  private onnxModelPath: string | null = null;
  private precomputedValuations: Map<string, ValuationOutput> = new Map();

  // Unticked role heap for O(1) scarcity evaluation
  private untickedRoleCounts: Record<PrimaryRole, number> = {
    BAT: 0,
    WK: 0,
    AR: 0,
    PACE: 0,
    SPIN: 0
  };

  // 5 Role-Isolated EMAs tracking auction market inflation (V1.7)
  private roleEMAs: Record<PrimaryRole, number> = {
    BAT: 1.0,
    WK: 1.0,
    AR: 1.0,
    PACE: 1.0,
    SPIN: 1.0
  };

  // Franchise Roster States
  public franchiseStates: Map<string, FranchiseRosterState> = new Map();
  public franchiseProfiles: Map<string, FranchiseAuctionProfile> = new Map();
  public affinities: Map<string, { name: string; franchise: string; isFranchiseIcon: boolean }> = new Map();

  // Config
  public config: AuctionEngineConfig = {
    determinismRatio: 0.45,
    humanTaxEnabled: false,
    acceleratedVaultReserveCr: 10.0
  };

  constructor(profiles: FranchiseAuctionProfile[] = DEFAULT_IPL_FRANCHISES) {
    profiles.forEach(p => {
      this.franchiseProfiles.set(p.id, p);
      this.franchiseStates.set(p.id, {
        franchiseId: p.id,
        purseRemainingCr: 120.00,
        squad: [],
        pricesPaid: [],
        roleCounts: { BAT: 0, WK: 0, AR: 0, PACE: 0, SPIN: 0 },
        overseasCount: 0,
        uncappedCount: 0,
        totalSpentCr: 0.0,
        tickList: { tier1: new Set(), tier2: new Set(), tier3: new Set() }
      });
    });
  }

  /**
   * Initializes the ONNX model (Model 2: auction_bid_net.onnx)
   */
  public async initModel(): Promise<void> {
    if (!ort) return;

    const candidatePaths = [
      path.resolve(process.cwd(), 'public/models/auction_bid_net.onnx'),
      path.resolve(process.cwd(), 'dist/models/auction_bid_net.onnx'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/models/auction_bid_net.onnx')
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          this.onnxSession = await ort.InferenceSession.create(p, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all'
          });
          this.onnxModelPath = p;
          break;
        } catch (err) {
          // If loading fails, fallback gracefully to analytical curve
          this.onnxSession = null;
        }
      }
    }
  }

  /**
   * Pre-calculates base valuations for all players and generates 30-player private Tick Lists.
   */
  public async initializeAuction(allPlayers: IPLPlayer[]): Promise<void> {
    // 1. Reset Unticked Role Heap
    this.untickedRoleCounts = { BAT: 0, WK: 0, AR: 0, PACE: 0, SPIN: 0 };
    for (const p of allPlayers) {
      this.untickedRoleCounts[p.role] = (this.untickedRoleCounts[p.role] || 0) + 1;
    }

    // 2. Load Real-Life Franchise Affinities & Iconic Retentions
    const candidateAffinityPaths = [
      path.resolve(process.cwd(), 'public/data/player_team_affinities.json'),
      path.resolve(process.cwd(), 'dist/data/player_team_affinities.json'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/data/player_team_affinities.json')
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

    // 3. Precompute Base Valuations (O(N) upfront, enables <0.01ms lot resolution)
    for (const p of allPlayers) {
      const val = await this.computeBaseValuation(p);
      this.precomputedValuations.set(p.id, val);
    }

    // 4. Generate 30-Player Private Tick Lists for each franchise based on DNA, Home Pitch, & Franchise Affinities
    for (const [fId, profile] of this.franchiseProfiles.entries()) {
      const scoredPlayers = allPlayers.map(p => {
        const val = this.precomputedValuations.get(p.id) || this.computeAnalyticalValuation(p);
        const pitchDot = (
          profile.homePitch.spin * (p.groundVector?.spin ?? 0) +
          profile.homePitch.pace * (p.groundVector?.pace ?? 0) +
          profile.homePitch.power * (p.groundVector?.power ?? 0) +
          profile.homePitch.dew * (p.groundVector?.dew ?? 0)
        );
        const dnaScore = (
          (p.age <= 24 ? 1 : -1) * profile.dna.z1_youthExperience * 0.15 +
          (!p.isOverseas ? 1 : -1) * profile.dna.z3_indianCoreBias * 0.20 +
          pitchDot * profile.dna.z5_venueSynergyPriority * 0.32 +
          (p.stats.ovr / 100.0) * 0.33
        );

        // Real-Life Franchise Affinity Boost
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
   * Extracts the 32-feature normalized vector matching AuctionBidNet schema.
   */
  public extractFeatures(p: IPLPlayer): Float32Array {
    const st = p.stats;
    const hist = p.historical || { batAvg: 25, strikeRate: 135, bowlEcon: 8.8, bowlStrikeRate: 24, matches: 20 };
    const gv = p.groundVector || { spin: 0, pace: 0, power: 0, dew: 0 };
    const syn = p.tacticalSynergy || { creaseDominance: 0, strikeRotation: 0.5, powerplay: 0.33, middle: 0.33, death: 0.33, varietyBias: 0 };

    const ovr_n = (st?.ovr ?? 72) / 100.0;
    const bat_n = (st?.bat ?? 70) / 100.0;
    const pwr_n = (st?.power ?? 70) / 100.0;
    const bwl_n = (st?.bowl ?? 70) / 100.0;
    const fld_n = (st?.fielding ?? 72) / 100.0;

    const r_bat = p.role === 'BAT' ? 1.0 : 0.0;
    const r_wk = p.role === 'WK' ? 1.0 : 0.0;
    const r_ar = p.role === 'AR' ? 1.0 : 0.0;
    const r_pace = p.role === 'PACE' ? 1.0 : 0.0;
    const r_spin = p.role === 'SPIN' ? 1.0 : 0.0;

    const ar_bias = p.subType === 'BAT_AR' ? 0.05 : (p.subType === 'BOWL_AR' ? -0.05 : 0.0);
    const is_os = p.isOverseas ? 1.0 : 0.0;
    const is_uncapped = p.isUncapped ? 1.0 : 0.0;

    const age = p.age ?? 27;
    const age_n = age / 40.0;
    const is_youth = age <= 24 ? 1.0 : 0.0;
    const is_vet = age >= 34 ? 1.0 : 0.0;

    const base_p = (p.basePrice ?? 0.30) / 2.0;
    const set_n = (p.marqueeSet ?? 8) / 12.0;
    const is_marquee = (p.marqueeSet ?? 8) <= 2 ? 1.0 : 0.0;

    const stamina_n = (st?.staminaRecov ?? 85) / 100.0;
    const inj_risk = st?.injuryRisk ?? 0.10;

    const bat_avg_n = Math.min(1.5, (hist.batAvg || 25.0) / 45.0);
    const sr_n = Math.min(1.5, (hist.strikeRate || 135.0) / 160.0);
    const econ_diff = Math.max(-1.0, Math.min(1.0, ((hist.bowlEcon || 8.8) - 8.5) / 5.0));
    const bwl_sr_n = Math.min(1.5, 20.0 / Math.max(12.0, (hist.bowlStrikeRate || 24.0)));

    const g_spin = gv.spin ?? 0.0;
    const g_pace = gv.pace ?? 0.0;
    const g_pwr = gv.power ?? 0.0;
    const g_dew = gv.dew ?? 0.0;

    const crease_dom = syn.creaseDominance ?? 0.0;
    const rot = syn.strikeRotation ?? 0.50;
    const death_suit = syn.death ?? 0.30;

    return new Float32Array([
      ovr_n, bat_n, pwr_n, bwl_n, fld_n,
      r_bat, r_wk, r_ar, r_pace, r_spin, ar_bias,
      is_os, is_uncapped, age_n, is_youth, is_vet,
      base_p, set_n, is_marquee,
      stamina_n, inj_risk, bat_avg_n, sr_n, econ_diff, bwl_sr_n,
      g_spin, g_pace, g_pwr, g_dew,
      crease_dom, rot, death_suit
    ]);
  }

  /**
   * Computes the V1.7 ground-truth valuation distribution analytically.
   */
  public computeAnalyticalValuation(p: IPLPlayer): ValuationOutput {
    const ovr = p.stats.ovr;
    const role = p.role;
    const subType = p.subType;
    const isOverseas = p.isOverseas;
    const isUncapped = p.isUncapped;
    const basePrice = p.basePrice || 0.30;
    const age = p.age || 27;
    const setNum = p.marqueeSet || 8;

    // 1. Base Convex Value: V_base = 0.30 + ((OVR - 60) / 38)^2.45 * 18.5 Cr
    const ovrClamped = Math.max(60, Math.min(98, ovr));
    const normSkill = (ovrClamped - 60.0) / 38.0;
    const vBase = 0.30 + Math.pow(normSkill, 2.45) * 18.5;

    // 2. Role & Tactical Multipliers
    let mRole = 1.0;
    if (role === 'AR') mRole = 1.18;
    else if (role === 'WK') mRole = ovr >= 82 ? 1.12 : 1.05;
    else if (subType === 'DEATH_OVERS_PACER' || subType === 'EXPRESS_PACE') mRole = 1.15;

    // 3. Indian Core Scarcity Multiplier
    let mNat = 1.0;
    if (!isOverseas) {
      if (!isUncapped) {
        mNat = ovr >= 85 ? 1.25 : 1.12;
      } else {
        mNat = (age <= 24 && (p.stats.power >= 85 || p.stats.bowl >= 85)) ? 1.30 : 0.85;
      }
    } else {
      mNat = ovr >= 92 ? 1.15 : (ovr <= 82 ? 0.90 : 1.0);
    }

    // 4. Age Multiplier
    let mAge = 1.0;
    if (age <= 23) mAge = 1.12;
    else if (age <= 28) mAge = 1.04;
    else if (age >= 35) mAge = 0.82;

    // 5. Marquee Set Inflation
    const mSet = setNum <= 2 ? 1.18 : (setNum <= 6 ? 1.05 : 0.95);

    // 6. Fair Market Valuation
    let mu = vBase * mRole * mNat * mAge * mSet;
    mu = Math.max(basePrice, Math.min(26.0, mu));

    // 7. Volatility Interval [q15, q85]
    const volatility = 0.18 + (ovr >= 88 ? 0.12 : 0.05) + (!isOverseas && !isUncapped ? 0.10 : 0.0);
    const q15 = Math.max(basePrice, mu * (1.0 - volatility * 0.90));
    const q85 = Math.min(27.0, mu * (1.0 + volatility * 1.30));

    return {
      mu: Math.round(mu * 100) / 100,
      q15: Math.round(q15 * 100) / 100,
      q85: Math.round(q85 * 100) / 100
    };
  }

  /**
   * Computes base valuation via ONNX inference or fast analytical fallback.
   */
  public async computeBaseValuation(p: IPLPlayer): Promise<ValuationOutput> {
    if (this.onnxSession && ort) {
      try {
        const feats = this.extractFeatures(p);
        const tensor = new ort.Tensor('float32', feats, [1, 32]);
        const results = await this.onnxSession.run({ player_features: tensor });
        const outData = results.valuation_distribution.data;
        const mu = Math.max(p.basePrice || 0.30, Math.round(outData[0] * 100) / 100);
        const q15 = Math.max(p.basePrice || 0.30, Math.round(outData[1] * 100) / 100);
        const q85 = Math.max(mu, Math.round(outData[2] * 100) / 100);
        return { mu, q15, q85 };
      } catch (e) {
        // Fallback to analytical
      }
    }
    return this.computeAnalyticalValuation(p);
  }

  /**
   * Fast synchronous accessor for precomputed or analytically calculated base valuation.
   */
  public getPlayerValuation(player: IPLPlayer): ValuationOutput {
    return this.precomputedValuations.get(player.id) || this.computeAnalyticalValuation(player);
  }

  /**
   * Evaluates a franchise's bid for the given player lot according to V1.7 master spec.
   * Execution time is <0.01ms (10 microseconds).
   */
  public evaluateFranchiseBid(
    franchiseId: string,
    player: IPLPlayer,
    currentBidCr: number,
    isAcceleratedRound: boolean = false,
    leadingFranchiseId?: string
  ): AuctionBidDecision {
    const profile = this.franchiseProfiles.get(franchiseId);
    const state = this.franchiseStates.get(franchiseId);
    if (!profile || !state) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "INVALID_FRANCHISE" };
    }

    const squadSize = state.squad.length;
    const basePrice = player.basePrice || 0.30;
    const targetSquad = profile.targetSquadSize || 18;
    const minSlotsNeededToReachTarget = Math.max(0, targetSquad - squadSize);
    const minSlotsNeededToReach18 = Math.max(0, 18 - squadSize);

    // =========================================================================
    // LAYER B: HARD CLAMPS (Strict Invariants)
    // =========================================================================

    // 1. SQUAD CAPACITY CLAMP: Strict ceiling of 25 players
    if (squadSize >= 25) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "SQUAD_FULL" };
    }

    // 1b. TARGET SQUAD DEPTH REACHED: Target squad is 18-19 (max 21).
    // Franchises stop accumulating once target depth is achieved unless upgrading on genuine stars.
    const aff = this.affinities.get(player.id);
    if (squadSize >= 21) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "TARGET_SQUAD_REACHED" };
    }
    if (squadSize >= targetSquad) {
      const isPriorityUpgrade = (player.stats.ovr >= 84) ||
        state.tickList.tier1.has(player.id) ||
        (aff && aff.franchise === franchiseId && aff.isFranchiseIcon);
      const hasExcessPurse = state.purseRemainingCr >= 3.00;
      if (!isPriorityUpgrade || !hasExcessPurse) {
        return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "TARGET_SQUAD_REACHED" };
      }
    }

    // 2. OVERSEAS CLAMP: Strict ceiling of 8 overseas players
    if (player.isOverseas && state.overseasCount >= 8) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "OVERSEAS_FULL" };
    }

    // 2b. ROLE SATURATION CLAMP: Prevent hoarding of any single role (strictly max 2 WKs per franchise)
    const isHomeIcon = aff && aff.franchise === franchiseId && aff.isFranchiseIcon;
    if (!isHomeIcon && (state.roleCounts[player.role] || 0) >= (MAX_ROLE_CAPS[player.role] || 8)) {
      return { franchiseId, canBid: false, maxValuation: 0, nextBidAmount: 0, reactionDelayMs: 2000, reason: "ROLE_SATURATED" };
    }

    // 3. BUDGET PARTITION: Main Round vs. Accelerated Round Vault
    // Each unbought slot required to reach 18 requires at least 0.30 Cr
    const minPurseReserve = Math.max(0, minSlotsNeededToReach18 - 1) * 0.30;
    let accVaultReserve = 0.0;
    if (!isAcceleratedRound) {
      // In Main Round, reserve modest vault for depth pickups in accelerated round
      if (state.purseRemainingCr > minSlotsNeededToReach18 * 0.50 + 2.0) {
        accVaultReserve = Math.min(3.50, Math.max(1.50, minSlotsNeededToReachTarget * 0.30));
      }
    }

    // EMERGENCY WK PURSE PROTECTION:
    // If franchise has 0 WKs, it MUST reserve at least ₹1.20 Cr for a WK unless this active lot IS a WK
    const emergencyWkPurseReserve = (state.roleCounts.WK === 0 && player.role !== 'WK') ? 1.20 : 0.0;

    const availablePurse = Math.max(0, state.purseRemainingCr - minPurseReserve - accVaultReserve - emergencyWkPurseReserve);

    // 4. PURSE SOLVENCY: Can the team afford even the base price or next bid increment?
    const nextBid = currentBidCr === 0 ? basePrice : currentBidCr + getNextBidIncrement(currentBidCr);
    if (availablePurse < nextBid) {
      return {
        franchiseId,
        canBid: false,
        maxValuation: 0,
        nextBidAmount: 0,
        reactionDelayMs: 2000,
        reason: "PURSE_CLAMP",
        components: { vBase: 0, mDNA: 1, mScarcity: 1, mEMA: 1, mTick: 1, mWkEmergency: 1, mTaxEff: 1, pAvail: availablePurse }
      };
    }

    // =========================================================================
    // LAYER A: VALUATION SYNTHESIS (V1.7)
    // =========================================================================

    const baseVal = this.getPlayerValuation(player);

    // 1. 6-D Team DNA Multiplier (M_DNA) with Seeded Drift & Home Venue Synergy
    const dna = profile.dna;
    const isYouth = player.age <= 24;
    const isVeteran = player.age >= 33;
    const ageBonus = isYouth ? 0.08 * dna.z1_youthExperience : (isVeteran ? -0.08 * dna.z1_youthExperience : 0.0);

    let roleBonus = 0.0;
    if (player.subType === 'BAT_AR') roleBonus = 0.05 * dna.z2_roleBias;
    else if (player.subType === 'BOWL_AR') roleBonus = -0.05 * dna.z2_roleBias;
    else if (player.role === 'BAT') roleBonus = 0.03 * dna.z2_roleBias;
    else if (player.role === 'PACE' || player.role === 'SPIN') roleBonus = -0.03 * dna.z2_roleBias;

    const natBonus = !player.isOverseas ? 0.08 * dna.z3_indianCoreBias : -0.06 * dna.z3_indianCoreBias;

    // Home Ground Venue Synergy (50% of season matches played at home)
    const pitchDot = (
      profile.homePitch.spin * (player.groundVector?.spin ?? 0) +
      profile.homePitch.pace * (player.groundVector?.pace ?? 0) +
      profile.homePitch.power * (player.groundVector?.power ?? 0) +
      profile.homePitch.dew * (player.groundVector?.dew ?? 0)
    );
    // Home Ground Fit Multiplier (+14% to -8% based on pitch dot product and franchise venue synergy priority)
    const venueBonus = 0.14 * dna.z5_venueSynergyPriority * Math.max(-0.60, Math.min(1.0, pitchDot));

    // Superstar Thrift Bias
    const thriftBonus = player.stats.ovr >= 88 ? -0.10 * dna.z6_superstarThriftBias : (basePrice <= 0.50 ? 0.08 * dna.z6_superstarThriftBias : 0.0);

    // Dynamic In-Room Momentum & Lot Volatility (55% variance ratio, 45% deterministic DNA anchor)
    const seedDrift = (((player.name.charCodeAt(0) + (player.age || 25)) % 100) / 100.0 - 0.5) * 0.03;
    const roomJitter = (1.0 - this.config.determinismRatio) * (Math.random() - 0.5) * 0.10;
    const drift = seedDrift + roomJitter;

    const mDNA = Math.max(0.75, Math.min(1.40, 1.0 + ageBonus + roleBonus + natBonus + venueBonus + thriftBonus + drift));

    // Risk tolerance (z4) interpolates valuation towards q85 (war ceiling) or q15 (conservative floor)
    let vDnaBase = baseVal.mu;
    if (dna.z4_riskTolerance > 0) {
      vDnaBase += dna.z4_riskTolerance * 0.25 * (baseVal.q85 - baseVal.mu);
    } else {
      vDnaBase += dna.z4_riskTolerance * 0.25 * (baseVal.mu - baseVal.q15);
    }

    // 2. Strategic Role Scarcity Multiplier (M_scarcity)
    const currentRoleCount = state.roleCounts[player.role] || 0;
    const targetRoleCount = TARGET_ROLE_COUNTS[player.role] || 5;
    const remainingUnticked = Math.max(1, this.untickedRoleCounts[player.role] || 1);

    let mScarcity = 1.0;
    if (currentRoleCount < targetRoleCount) {
      const deficit = targetRoleCount - currentRoleCount;
      mScarcity = 1.0 + Math.min(0.40, (deficit / remainingUnticked) * 0.35);
    } else if (currentRoleCount >= targetRoleCount + 2) {
      mScarcity = 0.70; // Saturated role
    }

    // EMERGENCY WK LOCK: Every IPL team strictly requires at least 1 reliable Wicketkeeper
    let mWkEmergency = 1.0;
    if (player.role === 'WK' && state.roleCounts.WK === 0) {
      mWkEmergency = 1.50;
      if (squadSize >= 6) mWkEmergency = 1.80;
      if (squadSize >= 10 || remainingUnticked <= 6) mWkEmergency = 2.20;
    }

    // 3. 5 Role-Isolated EMAs (M_EMA) with S-Tier Floor (OVR >= 88)
    let mEMA = Math.max(0.85, Math.min(1.30, this.roleEMAs[player.role] || 1.0));
    if (player.stats.ovr >= 88 && mEMA < 1.0) {
      mEMA = 1.0; // S-tier intrinsic protection
    }

    // 4. Private Tick List Priority (M_tick)
    let mTick = 0.95; // Default off-list discount
    if (state.tickList.tier1.has(player.id)) mTick = 1.20;
    else if (state.tickList.tier2.has(player.id)) mTick = 1.08;
    else if (state.tickList.tier3.has(player.id)) mTick = 1.03;

    // 4b. Real-Life Franchise Pillar Affinity Multiplier (M_affinity)
    let mAffinity = 1.0;
    if (aff && aff.franchise === franchiseId) {
      mAffinity = aff.isFranchiseIcon ? 1.30 : 1.15;
    }

    // 5. Deterministic Human Tax Mode (M_tax_eff)
    let mTaxEff = 1.0;
    if (this.config.humanTaxEnabled && leadingFranchiseId === 'HUMAN') {
      mTaxEff = 1.05; // Human tax pressure
    }

    // 5b. War Chest Assertiveness: Scale assertiveness based on average purse remaining per slot
    const slotsToTarget = Math.max(1, targetSquad - squadSize);
    const avgPursePerSlot = state.purseRemainingCr / slotsToTarget;
    let mWarChest = 1.0;
    if (avgPursePerSlot >= 3.0 && player.stats.ovr >= 82) {
      mWarChest = 1.0 + Math.min(0.30, (avgPursePerSlot - 3.0) * 0.08);
    }

    // Aggregate Valuation
    let calculatedMaxVal = vDnaBase * mDNA * mAffinity * mScarcity * mWkEmergency * mEMA * mTick * mTaxEff * mWarChest;

    // S-Tier Intrinsic Floor (OVR >= 88 guarantees at least 90% of base fair valuation)
    if (player.stats.ovr >= 88) {
      calculatedMaxVal = Math.max(calculatedMaxVal, baseVal.mu * 0.90);
    }

    // Hard Single-Player Ceiling: In IPL history, no player exceeds ~₹27.00 Cr
    calculatedMaxVal = Math.min(27.00, calculatedMaxVal);

    // =========================================================================
    // DYNAMIC PURSE-PER-SLOT PACING (V1.8 Adaptive Portfolio Allocation)
    // =========================================================================
    // Instead of arbitrary static clamps, pacing is dynamically driven by:
    // 1. Minimum solvency reserve to legally reach 18 players
    // 2. Average purse remaining per unbought slot to reach target squad (18-19)
    // 3. Player quality tier (OVR)
    const otherSlotsTo18 = Math.max(0, minSlotsNeededToReach18 - 1);
    const hardSolvencyReserve = otherSlotsTo18 * 0.30;
    const maxSolventBid = Math.max(basePrice, state.purseRemainingCr - hardSolvencyReserve);

    // Dynamic tier-based valuation ceiling:
    // How much can this franchise afford to allocate to this specific player without starving remaining slots?
    let dynamicCeiling = maxSolventBid;
    const numSuperstars = state.pricesPaid.filter(p => p >= 15.0).length;

    if (avgPursePerSlot >= 4.50) {
      // Very Wealthy Franchise (e.g. ₹60 Cr with 12 slots, or ₹35 Cr with 6 slots):
      // Can bid heavily on stars & starters to spend war chest
      if (player.stats.ovr >= 90) {
        const superCap = numSuperstars >= 2 ? 16.00 : 27.00;
        dynamicCeiling = Math.min(maxSolventBid, superCap);
      } else if (player.stats.ovr >= 84) {
        dynamicCeiling = Math.min(maxSolventBid, Math.max(12.00, avgPursePerSlot * 2.2));
      } else if (player.stats.ovr >= 78) {
        dynamicCeiling = Math.min(maxSolventBid, Math.max(6.00, avgPursePerSlot * 1.3));
      } else {
        dynamicCeiling = Math.min(maxSolventBid, 3.50);
      }
    } else if (avgPursePerSlot >= 3.00) {
      // Healthy Franchise (₹3.00 - ₹4.50 Cr / slot):
      if (player.stats.ovr >= 90) {
        const superCap = numSuperstars >= 2 ? 14.00 : 22.00;
        dynamicCeiling = Math.min(maxSolventBid, superCap);
      } else if (player.stats.ovr >= 84) {
        dynamicCeiling = Math.min(maxSolventBid, 11.00);
      } else if (player.stats.ovr >= 78) {
        dynamicCeiling = Math.min(maxSolventBid, 5.50);
      } else {
        dynamicCeiling = Math.min(maxSolventBid, 2.50);
      }
    } else if (avgPursePerSlot >= 1.75) {
      // Balanced / Moderate Budget (₹1.75 - ₹3.00 Cr / slot):
      if (player.stats.ovr >= 90) {
        dynamicCeiling = Math.min(maxSolventBid, 11.00);
      } else if (player.stats.ovr >= 84) {
        dynamicCeiling = Math.min(maxSolventBid, 7.50);
      } else if (player.stats.ovr >= 78) {
        dynamicCeiling = Math.min(maxSolventBid, 4.00);
      } else {
        dynamicCeiling = Math.min(maxSolventBid, 1.80);
      }
    } else {
      // Tight Budget (< ₹1.75 Cr / slot):
      // Protect remaining slots to reach 18
      const maxBidFactor = minSlotsNeededToReach18 > 2 ? 1.6 : 1.2;
      dynamicCeiling = Math.min(maxSolventBid, Math.max(basePrice, avgPursePerSlot * maxBidFactor));
    }

    calculatedMaxVal = Math.min(calculatedMaxVal, dynamicCeiling);

    // Portfolio Depth Pacing: Ensure franchise preserves at least 0.30 Cr per slot to reach targetSquad
    const depthPurseReserve = Math.max(0, minSlotsNeededToReachTarget - 1) * 0.30;
    const portfolioCeiling = Math.max(basePrice, state.purseRemainingCr - depthPurseReserve);
    calculatedMaxVal = Math.min(calculatedMaxVal, portfolioCeiling);

    // Bench Depth Guarantee: If team needs slots to reach targetSquad (21-24), guarantee at least basePrice
    if (minSlotsNeededToReachTarget > 0 && availablePurse >= basePrice) {
      const minSlotsSafe = Math.max(0, minSlotsNeededToReachTarget - 1) * 0.25;
      if (state.purseRemainingCr - basePrice >= minSlotsSafe) {
        calculatedMaxVal = Math.max(calculatedMaxVal, basePrice);
      }
    }

    // Mandatory Floor: If team needs slots to reach 18, guarantee at least basePrice
    if (minSlotsNeededToReach18 > 0 && availablePurse >= basePrice) {
      calculatedMaxVal = Math.max(calculatedMaxVal, basePrice);
    }

    // Emergency WK Guarantee: If franchise has 0 WKs, guarantee at least basePrice
    if (player.role === 'WK' && state.roleCounts.WK === 0 && availablePurse >= basePrice) {
      calculatedMaxVal = Math.max(calculatedMaxVal, basePrice);
    }

    // Clamp calculated valuation to Available Purse
    const finalValuationCeiling = Math.min(calculatedMaxVal, availablePurse);

    // =========================================================================
    // BID DECISION & TACTICAL EARLY EXIT
    // =========================================================================

    // Stalemate / Valuation Exceeded Check
    if (nextBid > finalValuationCeiling) {
      return {
        franchiseId,
        canBid: false,
        maxValuation: Math.round(finalValuationCeiling * 100) / 100,
        nextBidAmount: 0,
        reactionDelayMs: 1800,
        reason: "VALUATION_EXCEEDED",
        components: {
          vBase: baseVal.mu,
          mDNA: Math.round(mDNA * 100) / 100,
          mScarcity: Math.round(mScarcity * 100) / 100,
          mEMA: Math.round(mEMA * 100) / 100,
          mTick: Math.round(mTick * 100) / 100,
          mWkEmergency: Math.round(mWkEmergency * 100) / 100,
          mTaxEff: Math.round(mTaxEff * 100) / 100,
          pAvail: Math.round(availablePurse * 100) / 100
        }
      };
    }

    // Tactical Early Exit (Rival Bleed): If rival has pushed bid beyond 1.15x fair value and player is not Tier 1
    if (currentBidCr > baseVal.mu * 1.15 && !state.tickList.tier1.has(player.id) && mWkEmergency === 1.0) {
      return {
        franchiseId,
        canBid: false,
        maxValuation: Math.round(finalValuationCeiling * 100) / 100,
        nextBidAmount: 0,
        reactionDelayMs: 1600,
        reason: "RIVAL_BLEED_EXIT"
      };
    }

    // Mode B Live Reaction Delay: [400ms .. 2100ms]
    // More urgent / higher risk tolerance franchises react faster
    const urgency = (finalValuationCeiling - nextBid) / Math.max(1.0, finalValuationCeiling);
    const baseDelay = 1200 - dna.z4_riskTolerance * 400 - urgency * 300;
    const reactionDelayMs = Math.max(400, Math.min(2100, Math.round(baseDelay + (Math.random() * 200 - 100))));

    return {
      franchiseId,
      canBid: true,
      maxValuation: Math.round(finalValuationCeiling * 100) / 100,
      nextBidAmount: Math.round(nextBid * 100) / 100,
      reactionDelayMs,
      reason: "ACTIVE_BID",
      components: {
        vBase: baseVal.mu,
        mDNA: Math.round(mDNA * 100) / 100,
        mScarcity: Math.round(mScarcity * 100) / 100,
        mEMA: Math.round(mEMA * 100) / 100,
        mTick: Math.round(mTick * 100) / 100,
        mWkEmergency: Math.round(mWkEmergency * 100) / 100,
        mTaxEff: Math.round(mTaxEff * 100) / 100,
        pAvail: Math.round(availablePurse * 100) / 100
      }
    };
  }

  /**
   * Mode A: Silent Vickrey Second-Price Lot Resolution (<0.05ms)
   * Resolves lot instantly across all AI franchises.
   */
  public resolveLotModeA(
    lotNumber: number,
    player: IPLPlayer,
    isAcceleratedRound: boolean = false,
    customBidders?: { franchiseId: string; evaluate: (player: IPLPlayer, state: FranchiseRosterState) => { canBid: boolean; maxValuation: number } }[]
  ): AuctionLotResolution {
    const basePrice = player.basePrice || 0.30;
    const bids: { franchiseId: string; maxValuation: number }[] = [];

    // 1. Collect maximum valuations from all franchises
    for (const [fId] of this.franchiseProfiles) {
      const custom = customBidders?.find(c => c.franchiseId === fId);
      if (custom) {
        const state = this.franchiseStates.get(fId)!;
        const res = custom.evaluate(player, state);
        if (res.canBid && res.maxValuation >= basePrice) {
          bids.push({ franchiseId: fId, maxValuation: Math.round(res.maxValuation * 100) / 100 });
        }
      } else {
        const decision = this.evaluateFranchiseBid(fId, player, 0, isAcceleratedRound);
        if (decision.canBid && decision.maxValuation >= basePrice) {
          bids.push({ franchiseId: fId, maxValuation: decision.maxValuation });
        }
      }
    }

    // Unticked Heap update
    if (this.untickedRoleCounts[player.role] > 0) {
      this.untickedRoleCounts[player.role]--;
    }

    // 2. Unsold Lot
    if (bids.length === 0) {
      return {
        lotNumber,
        player,
        sold: false,
        numBidders: 0,
        allBids: []
      };
    }

    // 3. Sort bids descending
    bids.sort((a, b) => b.maxValuation - a.maxValuation);

    const winner = bids[0];
    let winningPrice = basePrice;
    let secondPrice = basePrice;

    if (bids.length > 1) {
      secondPrice = bids[1].maxValuation;
      // Second price + 1 increment, bounded by winner's max valuation
      const inc = getNextBidIncrement(secondPrice);
      winningPrice = Math.min(winner.maxValuation, Math.max(basePrice, secondPrice + inc));
    } else {
      winningPrice = basePrice;
    }

    winningPrice = Math.round(winningPrice * 100) / 100;

    // 4. Update Winning Franchise Roster State
    const winningState = this.franchiseStates.get(winner.franchiseId)!;
    winningState.purseRemainingCr = Math.round((winningState.purseRemainingCr - winningPrice) * 100) / 100;
    winningState.totalSpentCr = Math.round((winningState.totalSpentCr + winningPrice) * 100) / 100;
    winningState.squad.push(player);
    winningState.pricesPaid.push(winningPrice);
    winningState.roleCounts[player.role] = (winningState.roleCounts[player.role] || 0) + 1;
    if (player.isOverseas) winningState.overseasCount++;
    if (player.isUncapped) winningState.uncappedCount++;

    // 5. Update Role-Isolated EMA Inflation Tracker
    const baseVal = this.getPlayerValuation(player);
    if (baseVal.mu > 0) {
      const ratio = Math.max(0.70, Math.min(1.50, winningPrice / baseVal.mu));
      this.roleEMAs[player.role] = Math.round((0.85 * this.roleEMAs[player.role] + 0.15 * ratio) * 1000) / 1000;
    }

    return {
      lotNumber,
      player,
      sold: true,
      winningFranchiseId: winner.franchiseId,
      winningPrice,
      secondPrice,
      numBidders: bids.length,
      allBids: bids
    };
  }

  /**
   * Mode B: Live Step-by-Step Interactive Bid Reaction (<0.02ms)
   * Designed for real-time multiplayer room with WebSocket or timer events.
   */
  public evaluateLiveBidModeB(
    franchiseId: string,
    player: IPLPlayer,
    currentBidCr: number,
    leadingFranchiseId?: string,
    isAcceleratedRound: boolean = false
  ): AuctionBidDecision {
    // If this franchise is already leading, no need to outbid itself
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
}

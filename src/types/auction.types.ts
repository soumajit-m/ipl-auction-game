import { IPLPlayer, PrimaryRole, GroundSynergyVector, PlayerSubType } from './player.types';
import { SeasonState } from './match.types';

export interface FranchiseDNA {
  z1_youthExperience: number;     // [-1.0..1.0] Youth vs Experience
  z2_roleBias: number;             // [-1.0..1.0] Bat/WK (+0.10) vs Pace/Spin (-0.10)
  z3_indianCoreBias: number;       // [-1.0..1.0] Domestic Indian vs Overseas
  z4_riskTolerance: number;        // [-1.0..1.0] High ceiling vs proven floor
  z5_venueSynergyPriority: number; // [0.0..1.0] Ground adaptation weight
  z6_superstarThriftBias: number;  // [-1.0..1.0] Marquee big spender vs thrift
}

export type PsychologicalTrait =
  | 'STAR_HOARDER'
  | 'POWER_MAXIMALIST'
  | 'MONEYBALL_ANALYST'
  | 'CHAOTIC_DISRUPTOR'
  | 'TACTICAL_PRAGMATIST';

export type AIArchetype = 'SUPERSTAR_DUELIST' | 'MONEYBALL_CORE' | 'DISCIPLINED_PRAGMATIST';

export interface FranchiseAuctionProfile {
  id: string;                      // CSK, MI, KKR, etc.
  name: string;                    // Chennai Super Kings
  homeVenueName: string;
  homePitch: GroundSynergyVector;
  targetSquadSize: number;
  dna: FranchiseDNA;
  psychology?: PsychologicalTrait;
  archetype?: AIArchetype;
}

export interface PrivateAITicks {
  tier1: string[]; // 10 players, 1.30x mult
  tier2: string[]; // 12 players, 1.12x mult
  tier3: string[]; // 8 players, +0.50 Cr additive
}

export interface TeamAuctionState {
  franchiseId: string;
  name: string;
  purse: number;                   // In Crores (starts at 125.00 Cr)
  a_t: number;                     // Main budget split multiplier ~ U(0.70, 0.90)
  P_main_cap: number;              // a_t * 125.00 Cr
  P_acc_vault: number;             // 125.00 - P_main_cap (locked for accelerated round)
  squad: IPLPlayer[];
  isHuman: boolean;
  ownerName: string;
  wishlistIds: string[];           // Human wishlist player IDs
  privateTicks: PrivateAITicks;    // AI private ticks
  mu_role: Record<PrimaryRole, number>; // Role-isolated market EMAs [-0.20..+0.25]
  skipLotIds: string[];            // Lots explicitly skipped by human
  connected?: boolean;
}

export type BiddingMode = 'MODE_A' | 'MODE_B';
export type LotState = 'PENDING' | 'OPEN' | 'SOLD' | 'UNSOLD';
export type AuctionPhase = 'MAIN' | 'ACCELERATED_1' | 'ACCELERATED_2';

export interface BidEntry {
  bidderId: string;
  bidderName: string;
  amount: number;
  timestamp: number;
}

export interface AuctionLot {
  lotId: string;
  player: IPLPlayer;
  lotNumber: number;
  totalLots: number;
  phase: AuctionPhase;
  currentPrice: number;
  currentBidder: string | null;
  currentBidderName: string | null;
  biddingMode: BiddingMode;
  timerMs: number;
  timerTotalMs: number;
  isTimerRunning: boolean;
  bidHistory: BidEntry[];
  state: LotState;
  // Private fields for Mode A Silent Vickrey (stripped during DTO sanitization)
  modeAProvisionalWinner?: string | null;
  modeAProvisionalPrice?: number | null;
  modeASecondHighestVal?: number | null;
}

export interface SanitizeRoomDTO {
  roomCode: string;
  status: string;
  phase: AuctionPhase;
  determinismRatio: number;
  humanTaxEnabled: boolean;
  isPaused: boolean;
  lastSavedAt: number;
  teams: Record<string, Omit<TeamAuctionState, 'dna' | 'P_acc_vault' | 'privateTicks'>>;
  currentLot: AuctionLot | null;
  completedLotsCount: number;
  completedLots?: Array<{ player: IPLPlayer; soldPrice: number | null; soldTo: string | null }>;
  lastResolvedLot?: { player: IPLPlayer; sold: boolean; winningPrice?: number; winningFranchiseId?: string } | null;
  recentSold: Array<{ player: IPLPlayer; soldPrice: number; soldTo: string }>;
  recentUnsold: IPLPlayer[];
  wishlistTimer: { msRemaining: number; totalMs: number; submittedCount: number; totalHumans: number; wishlistEndsAt?: number };
  wishlistEndsAt?: number;
  seats?: Array<{ teamId: string; teamName: string; isHuman: boolean; playerName: string; connected: boolean }>;
  commentaryTicker: string[];
  season?: SeasonState | null;
  skipVotes?: string[];
  setSkipVotes?: string[];
  lastSetSummary?: string | null;
  isAuctionPaused?: boolean;
  auctionSpeedMultiplier?: number;
  hostId?: string;
}

/**
 * Dynamic Bid Increment Formula:
 * min((2 ** floor(current_bid / 5)) * 0.25, 1.0) Cr
 */
export function getNextBidIncrement(currentBid: number): number {
  const steps = Math.floor(Math.max(0, currentBid) / 5.0);
  return Math.min(Math.pow(2, steps) * 0.25, 1.00);
}

/**
 * Exact Human Purse Reservation Rule:
 * 6 slots @ 0.50 Cr + 12 slots @ 0.30 Cr = 6.60 Cr max reserve to guarantee legal 18-man squad
 */
export function getHumanMinPurseReserve(currentSquadCount: number): number {
  if (currentSquadCount >= 18) return 0.00;
  if (currentSquadCount <= 12) {
    return Number((6.60 - currentSquadCount * 0.30).toFixed(2));
  }
  return Number(((18 - currentSquadCount) * 0.50).toFixed(2));
}

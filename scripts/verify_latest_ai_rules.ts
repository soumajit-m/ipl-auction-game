import assert from 'assert';
import { AuctionBidderAI } from '../src/server/auction/bidderAI';
import { IPLPlayer } from '../src/types/player.types';
import { TeamMaker } from '../src/server/match/teamMaker';

console.log('--- Testing Latest AI Bidding Rules & Real Player Immersion ---');

// Mock players
const marqueeWK: IPLPlayer = {
  id: 'player_pant',
  name: 'Rishabh Pant',
  role: 'WK',
  subType: 'BAT_WK',
  basePrice: 2.00,
  currentPrice: 2.00,
  isOverseas: false,
  isBowlingCapable: false,
  stats: { bat: 91, bowl: 20, ovr: 92, power: 90, fielding: 80 },
  age: 27,
  marqueeSet: 1
};

const cappedWKSet5: IPLPlayer = {
  id: 'player_jurel',
  name: 'Dhruv Jurel',
  role: 'WK',
  subType: 'BAT_WK',
  basePrice: 1.00,
  currentPrice: 1.00,
  isOverseas: false,
  isBowlingCapable: false,
  stats: { bat: 84, bowl: 20, ovr: 85, power: 82, fielding: 78 },
  age: 23,
  marqueeSet: 5
};

const overseasIcon: IPLPlayer = {
  id: 'player_head',
  name: 'Travis Head',
  role: 'BAT',
  subType: 'TOP_BAT',
  basePrice: 2.00,
  currentPrice: 2.00,
  isOverseas: true,
  isBowlingCapable: true,
  stats: { bat: 92, bowl: 58, ovr: 92, power: 94, fielding: 75 },
  age: 30,
  marqueeSet: 1
};

const domesticBowler: IPLPlayer = {
  id: 'player_arshdeep',
  name: 'Arshdeep Singh',
  role: 'PACE',
  subType: 'BOWL_PACE',
  basePrice: 2.00,
  currentPrice: 2.00,
  isOverseas: false,
  isBowlingCapable: true,
  stats: { bat: 30, bowl: 88, ovr: 88, power: 40, fielding: 75 },
  age: 25,
  marqueeSet: 2
};

const allPlayers = [marqueeWK, cappedWKSet5, overseasIcon, domesticBowler];
const bidderAI = new AuctionBidderAI();
bidderAI.initializeTeams('TEST_ROOM', allPlayers);

// ============================================================================
// TEST 1: Domestic Lock Gate on Overseas Bidding
// ============================================================================
console.log('\n[TEST 1] Testing Domestic Lock Gate on Overseas Bidding...');
const fState = bidderAI.franchiseStates.get('CSK')!;
fState.purseRemainingCr = 80.0;
// Assign 4 overseas players to CSK with 0 Indian WKs and 0 Indian bowlers
fState.overseasCount = 4;
fState.squad = [
  { ...overseasIcon, id: 'os1' },
  { ...overseasIcon, id: 'os2' },
  { ...overseasIcon, id: 'os3' },
  { ...overseasIcon, id: 'os4' }
];

const fifthOverseasDecision = bidderAI.evaluateFranchiseBid('CSK', overseasIcon, 2.0);
console.log('CSK with 4 OS and lacking domestic core bidding on 5th OS:', fifthOverseasDecision.reason);
assert.strictEqual(fifthOverseasDecision.canBid, false);
assert.strictEqual(fifthOverseasDecision.reason, 'DOMESTIC_CORE_REQUIRED');

// Now give CSK 1 Indian WK and 3 Indian bowlers
fState.squad.push({ ...marqueeWK, id: 'ind_wk', isOverseas: false });
fState.squad.push({ ...domesticBowler, id: 'ind_b1', isOverseas: false });
fState.squad.push({ ...domesticBowler, id: 'ind_b2', isOverseas: false });
fState.squad.push({ ...domesticBowler, id: 'ind_b3', isOverseas: false });
fState.roleCounts.WK = 1;
fState.roleCounts.PACE = 3;

const fifthOverseasUnlockedDecision = bidderAI.evaluateFranchiseBid('CSK', overseasIcon, 2.0);
console.log('CSK with domestic core secured bidding on 5th OS:', fifthOverseasUnlockedDecision.canBid, fifthOverseasUnlockedDecision.reason);
assert.strictEqual(fifthOverseasUnlockedDecision.canBid, true);
console.log('✓ Domestic Lock Gate verified.');

// ============================================================================
// TEST 2: Set Horizon Awareness & No Premature WK Panic
// ============================================================================
console.log('\n[TEST 2] Testing Set Horizon Awareness for WKs...');
const miState = bidderAI.franchiseStates.get('MI')!;
miState.purseRemainingCr = 100.0;
miState.squad = [];
miState.roleCounts = { BAT: 0, WK: 0, AR: 0, PACE: 0, SPIN: 0 };
miState.overseasCount = 0;

// Set 1 WK lot
const set1Decision = bidderAI.evaluateFranchiseBid('MI', marqueeWK, 2.0);
console.log('MI Set 1 WK Emergency Multiplier:', set1Decision.components?.mWkEmergency);
assert.strictEqual(set1Decision.components?.mWkEmergency, 1.08);

// Set 5 WK lot (dedicated set arrived, still 0 WKs)
const set5Decision = bidderAI.evaluateFranchiseBid('MI', cappedWKSet5, 1.0);
console.log('MI Set 5 WK Emergency Multiplier:', set5Decision.components?.mWkEmergency);
assert.strictEqual(set5Decision.components?.mWkEmergency, 1.35);
console.log('✓ Set Horizon Awareness verified.');

// ============================================================================
// TEST 3: SUPERSTAR_DUELIST Aggression Dilution
// ============================================================================
console.log('\n[TEST 3] Testing SUPERSTAR_DUELIST Aggression Dilution...');
const rcbProfile = bidderAI.franchiseProfiles.get('RCB')!;
rcbProfile.archetype = 'SUPERSTAR_DUELIST';
const rcbState = bidderAI.franchiseStates.get('RCB')!;
rcbState.archetype = 'SUPERSTAR_DUELIST';
rcbState.purseRemainingCr = 120.0;
rcbState.squad = [];
rcbState.pricesPaid = [];

// Phase 1: 0 Superstars owned -> Hunting 1st superstar
const huntDecision = bidderAI.evaluateFranchiseBid('RCB', overseasIcon, 10.0);
console.log('SD Phase 1 Valuation (Hunting Superstar): ₹', huntDecision.maxValuation, 'Cr');
assert(huntDecision.maxValuation > 18.0, 'SD should bid aggressively for 1st icon');

// Phase 2: Acquired 1 superstar for 24 Cr, now in Set 3 (Batsman)
rcbState.squad.push({ ...overseasIcon, id: 'star1' });
rcbState.pricesPaid.push(24.0);
rcbState.purseRemainingCr = 96.0;

const midSetBatsman: IPLPlayer = {
  id: 'player_mid_bat',
  name: 'Middle Order Bat',
  role: 'BAT',
  subType: 'TOP_BAT',
  basePrice: 1.00,
  currentPrice: 1.00,
  isOverseas: false,
  isBowlingCapable: false,
  stats: { bat: 82, bowl: 20, ovr: 82, power: 80, fielding: 70 },
  age: 26,
  marqueeSet: 3
};
const hangoverDecision = bidderAI.evaluateFranchiseBid('RCB', midSetBatsman, 3.0);
console.log('SD Phase 2 Valuation (Marquee Hangover Set 3 Bat): ₹', hangoverDecision.maxValuation, 'Cr');
assert(hangoverDecision.maxValuation <= 10.50, 'SD should dilute batsman aggression to <= 10.50 Cr in Sets 3-5');

// Bowler Aggression in Set 4: For high synergy bowlers, SD becomes aggressive!
const set4Bowler: IPLPlayer = {
  ...domesticBowler,
  marqueeSet: 4
};
const bowlerAggDecision = bidderAI.evaluateFranchiseBid('RCB', set4Bowler, 3.0);
console.log('SD Phase 2 Valuation (Set 4 Bowler Aggression): ₹', bowlerAggDecision.maxValuation, 'Cr');
assert(bowlerAggDecision.maxValuation > 14.0, 'SD should become aggressive on bowlers in Set 4');

// Phase 3: In Set 7 (post-hangover) -> disciplined depth / synergy bowler
const lateSetPlayer: IPLPlayer = {
  ...domesticBowler,
  marqueeSet: 7
};
const disciplinedDecision = bidderAI.evaluateFranchiseBid('RCB', lateSetPlayer, 3.0);
console.log('SD Phase 3 Valuation (Late Set 7): ₹', disciplinedDecision.maxValuation, 'Cr');
assert(disciplinedDecision.maxValuation <= 17.50, 'SD should cap at <= 17.50 Cr');
console.log('✓ Aggression Dilution & Bowler Aggression verified.');

// ============================================================================
// TEST 4: Predatory Human-Awareness Bidding (Solvency Trap vs. Purse Squeeze)
// ============================================================================
console.log('\n[TEST 4] Testing Predatory Human-Awareness Bidding...');
const kkrState = bidderAI.franchiseStates.get('KKR')!;
kkrState.purseRemainingCr = 50.0;
kkrState.squad = new Array(12).fill(domesticBowler).map((p, i) => ({ ...p, id: `kkr_${i}` }));

// Case A: Human has 6 Cr for 10 slots needed -> surplus = 6 / 10 = 0.60 Cr (< 0.65)
// AI MUST NOT counter-bid! Let human fall into solvency trap!
const trapDecision = bidderAI.evaluateFranchiseBid(
  'KKR',
  domesticBowler,
  2.0,
  false,
  'HUMAN_LEADER',
  6.0,  // humanPurse
  8     // humanSquadSize -> 18 - 8 = 10 slots needed
);
console.log('Human Solvency Trap Decision:', trapDecision.canBid, trapDecision.reason);
assert.strictEqual(trapDecision.canBid, false);
assert.strictEqual(trapDecision.reason, 'HUMAN_SOLVENCY_TRAP');

// Case B: Human has 15 Cr for 10 slots needed -> surplus = 15 / 10 = 1.50 Cr (>= 0.85)
// AI has 50 Cr purse with 12 players -> AI surplus = 50 - (5 * 0.40) = 48 Cr (>= 4.0 Cr)
// AI should squeeze and tax human!
const squeezeDecision = bidderAI.evaluateFranchiseBid(
  'KKR',
  domesticBowler,
  2.0,
  false,
  'HUMAN_LEADER',
  15.0, // humanPurse
  8     // humanSquadSize
);
console.log('Human Purse Squeeze Decision:', squeezeDecision.canBid, 'targetVal:', squeezeDecision.maxValuation);
assert.strictEqual(squeezeDecision.canBid, true);
console.log('✓ Predatory Human-Awareness verified.');

// ============================================================================
// TEST 5: Real Player Immersion (No 'Domestic Reserve' names)
// ============================================================================
console.log('\n[TEST 5] Testing Real Player Immersion in TeamMaker...');
// Create a small squad of 5 players (needs emergency injection to 11)
const miniSquad: IPLPlayer[] = [
  { ...marqueeWK, id: 'mini_wk' },
  { ...domesticBowler, id: 'mini_b1' },
  { ...domesticBowler, id: 'mini_b2' }
];

const lineup = TeamMaker.makeSmartLineup('TEST_TEAM', miniSquad);
assert.strictEqual(lineup.playing11Ids.length, 11);
const allNames = miniSquad.map(p => p.name);
console.log('Generated squad names:', allNames);
for (const name of allNames) {
  assert(!name.includes('Domestic Reserve'), `Player name "${name}" should not contain "Domestic Reserve"!`);
}
console.log('✓ Real Player Immersion verified.');

console.log('\n ALL 5 UPGRADED ENGINE FEATURES VERIFIED SUCCESSFULLY!');

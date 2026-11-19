import assert from 'assert';
import { AuctionBidderAI } from '../src/server/auction/bidderAI';
import { IPLPlayer } from '../src/types/player.types';

console.log('--- Testing SD Bowler Aggression & Uncapped Surplus Multiplier ---');

const marqueeIcon: IPLPlayer = {
  id: 'player_head',
  name: 'Travis Head',
  role: 'BAT',
  subType: 'TOP_BAT',
  basePrice: 2.00,
  currentPrice: 2.00,
  isOverseas: true,
  isBowlingCapable: false,
  stats: { bat: 92, bowl: 40, ovr: 92, power: 94, fielding: 75 },
  age: 30,
  marqueeSet: 1
};

const set3Batter: IPLPlayer = {
  id: 'player_shaw',
  name: 'Prithvi Shaw',
  role: 'BAT',
  subType: 'TOP_BAT',
  basePrice: 1.00,
  currentPrice: 1.00,
  isOverseas: false,
  isBowlingCapable: false,
  stats: { bat: 83, bowl: 20, ovr: 83, power: 85, fielding: 70 },
  age: 24,
  marqueeSet: 3
};

const set4SynergyPacer: IPLPlayer = {
  id: 'player_bumrah_style',
  name: 'Elite Pacer',
  role: 'PACE',
  subType: 'BOWL_PACE',
  basePrice: 2.00,
  currentPrice: 2.00,
  isOverseas: false,
  isBowlingCapable: true,
  groundVector: { pace: 0.80, spin: -0.20, power: 0.50, dew: 0.60 },
  tacticalSynergy: { powerplay: 0.85, death: 0.90, middle: 0.60 },
  stats: { bat: 30, bowl: 92, ovr: 90, power: 40, fielding: 75 },
  age: 28,
  marqueeSet: 4
};

const set7UncappedBatter: IPLPlayer = {
  id: 'player_uncapped_gem',
  name: 'Uncapped Talent',
  role: 'BAT',
  subType: 'TOP_BAT',
  basePrice: 0.30,
  currentPrice: 0.30,
  isOverseas: false,
  isUncapped: true,
  isBowlingCapable: false,
  stats: { bat: 78, bowl: 20, ovr: 78, power: 80, fielding: 70 },
  age: 21,
  marqueeSet: 7
};

const allPlayers = [marqueeIcon, set3Batter, set4SynergyPacer, set7UncappedBatter];
const bidderAI = new AuctionBidderAI();
bidderAI.initializeTeams('TEST_ROOM', allPlayers);

// ============================================================================
// TEST 1: SD Bowler Aggression based on Character & Pitch Synergy
// ============================================================================
console.log('\n[TEST 1] Testing SD Bowler Aggression in Set 4 vs Batters...');
const miProfile = bidderAI.franchiseProfiles.get('MI')!;
miProfile.archetype = 'SUPERSTAR_DUELIST';
// MI has Wankhede pace synergy = +0.75
const miState = bidderAI.franchiseStates.get('MI')!;
miState.archetype = 'SUPERSTAR_DUELIST';
miState.purseRemainingCr = 95.0; // Has 95 Cr left after 1 superstar purchase
miState.squad = [{ ...marqueeIcon, id: 'icon1' }];
miState.pricesPaid = [25.0];

// Case A: Set 3 Batsman -> SD should dilute down to <= 10.50 Cr
const batterDec = bidderAI.evaluateFranchiseBid('MI', set3Batter, 2.0);
console.log('SD Set 3 Batter valuation (diluted): ₹', batterDec.maxValuation, 'Cr');
assert(batterDec.maxValuation <= 10.50, 'SD should dilute batsman in Set 3');

// Case B: Set 4 Synergy Pacer -> SD becomes AGGRESSIVE for bowler synergy!
const pacerDec = bidderAI.evaluateFranchiseBid('MI', set4SynergyPacer, 5.0);
console.log('SD Set 4 Synergy Pacer valuation (aggressive): ₹', pacerDec.maxValuation, 'Cr');
assert(pacerDec.maxValuation > 14.0, 'SD should be aggressive on high-synergy pacer in Set 4');
console.log('✓ SD Bowler Synergy Aggression verified.');

// ============================================================================
// TEST 2: Uncapped Multiplier (1.1x) after Set 6 for AI with > 20 Cr
// ============================================================================
console.log('\n[TEST 2] Testing 1.1x Uncapped Multiplier after Set 6 for AIs with > 20 Cr...');
const cskState = bidderAI.franchiseStates.get('CSK')!;
cskState.squad = new Array(10).fill(marqueeIcon).map((p, i) => ({ ...p, id: `csk_${i}` }));

// Case A: CSK has 25 Cr (> 20 Cr) in Set 7 on Uncapped Player
cskState.purseRemainingCr = 25.0;
const richDec = bidderAI.evaluateFranchiseBid('CSK', set7UncappedBatter, 0.50);

// Case B: CSK has 18 Cr (<= 20 Cr) in Set 7 on Uncapped Player
cskState.purseRemainingCr = 18.0;
const normalDec = bidderAI.evaluateFranchiseBid('CSK', set7UncappedBatter, 0.50);

console.log('Valuation with > 20 Cr purse (1.1x boost): ₹', richDec.maxValuation, 'Cr');
console.log('Valuation with <= 20 Cr purse (standard):   ₹', normalDec.maxValuation, 'Cr');
assert(richDec.maxValuation > normalDec.maxValuation, 'AI with >20 Cr should get higher valuation due to 1.1x multiplier');
console.log('✓ 1.1x Uncapped Multiplier after Set 6 verified.');

console.log('\n ALL TESTS PASSED SUCCESSFULLY!');

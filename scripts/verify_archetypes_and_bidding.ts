import assert from 'assert';
import {
  AuctionBidderAI,
  getArchetypeDistribution,
  assignFranchiseArchetypes,
  AIArchetype
} from '../src/server/auction/bidderAI';
import { IPLPlayer } from '../src/types/player.types';

console.log('--- Testing AI Archetype Distribution & Bidding Engine ---');

// ============================================================================
// TEST 1: Archetype Distribution Rule
// ============================================================================
console.log('\n[TEST 1] Verifying getArchetypeDistribution across room sizes...');

// N < 3
const dist1 = getArchetypeDistribution(1);
assert.deepStrictEqual(dist1, { sdCount: 0, mbCount: 0, dpCount: 1 });
const dist2 = getArchetypeDistribution(2);
assert.deepStrictEqual(dist2, { sdCount: 0, mbCount: 0, dpCount: 2 });

// 3 <= N <= 5
const dist3 = getArchetypeDistribution(3);
assert.strictEqual(dist3.sdCount + dist3.mbCount + dist3.dpCount, 3);
assert.strictEqual(dist3.sdCount, 1);
assert.strictEqual(dist3.mbCount, 1);
assert.strictEqual(dist3.dpCount, 1);

const dist4 = getArchetypeDistribution(4);
assert.strictEqual(dist4.sdCount + dist4.mbCount + dist4.dpCount, 4);
assert.strictEqual(dist4.sdCount, 1);
assert.strictEqual(dist4.mbCount, 1);
assert.strictEqual(dist4.dpCount, 2);

const dist5 = getArchetypeDistribution(5);
assert.strictEqual(dist5.sdCount + dist5.mbCount + dist5.dpCount, 5);
assert.strictEqual(dist5.sdCount, 1);
assert.strictEqual(dist5.mbCount, 1);
assert.strictEqual(dist5.dpCount, 3);

// N > 5 (e.g. 8, 9, 10)
const dist8 = getArchetypeDistribution(8);
assert.strictEqual(dist8.sdCount + dist8.mbCount + dist8.dpCount, 8);
assert.strictEqual(dist8.sdCount, 2);
assert.strictEqual(dist8.mbCount, 2);
assert.strictEqual(dist8.dpCount, 4);

const dist9 = getArchetypeDistribution(9); // 1-Human Room (9 AIs)
assert.strictEqual(dist9.sdCount + dist9.mbCount + dist9.dpCount, 9);
assert.strictEqual(dist9.sdCount, 2, '9 AIs should have exactly 2 SUPERSTAR_DUELISTS');
assert.strictEqual(dist9.mbCount, 2, '9 AIs should have exactly 2 MONEYBALL_CORE');
assert.strictEqual(dist9.dpCount, 5, '9 AIs should have exactly 5 DISCIPLINED_PRAGMATISTS');

const dist10 = getArchetypeDistribution(10); // 0-Human Room (10 AIs)
assert.strictEqual(dist10.sdCount + dist10.mbCount + dist10.dpCount, 10);
assert.strictEqual(dist10.sdCount, 2);
assert.strictEqual(dist10.mbCount, 2);
assert.strictEqual(dist10.dpCount, 6);

console.log('✓ Archetype Distribution math verified for all N.');

// ============================================================================
// TEST 2: assignFranchiseArchetypes Helper
// ============================================================================
console.log('\n[TEST 2] Verifying assignFranchiseArchetypes...');
const testFranchises = [
  { id: 'CSK' }, { id: 'MI' }, { id: 'KKR' }, { id: 'RCB' }, { id: 'RR' },
  { id: 'SRH' }, { id: 'DC' }, { id: 'PBKS' }, { id: 'GT' }, { id: 'LSG' }
];
assignFranchiseArchetypes(testFranchises);
assert.strictEqual(testFranchises[0].archetype, 'SUPERSTAR_DUELIST');      // SD
assert.strictEqual(testFranchises[1].archetype, 'MONEYBALL_CORE');         // MB
assert.strictEqual(testFranchises[2].archetype, 'DISCIPLINED_PRAGMATIST'); // DP
assert.strictEqual(testFranchises[3].archetype, 'DISCIPLINED_PRAGMATIST'); // DP
assert.strictEqual(testFranchises[4].archetype, 'MONEYBALL_CORE');         // MB
assert.strictEqual(testFranchises[5].archetype, 'SUPERSTAR_DUELIST');      // SD
assert.strictEqual(testFranchises[6].archetype, 'DISCIPLINED_PRAGMATIST'); // DP
assert.strictEqual(testFranchises[7].archetype, 'DISCIPLINED_PRAGMATIST'); // DP
assert.strictEqual(testFranchises[8].archetype, 'DISCIPLINED_PRAGMATIST'); // DP
assert.strictEqual(testFranchises[9].archetype, 'DISCIPLINED_PRAGMATIST'); // DP
console.log('✓ assignFranchiseArchetypes assigned reordered pattern: SD, MB, DP, DP, MB, SD, DP, DP, DP, DP');

// ============================================================================
// TEST 3: Archetype Bidding Behavior in evaluateFranchiseBid
// ============================================================================
console.log('\n[TEST 3] Verifying archetype-specific target valuations...');

const bidderAI = new AuctionBidderAI();

// Sample players
const superstarTier1: IPLPlayer = {
  id: 'bumrah_94',
  name: 'Jasprit Bumrah',
  role: 'PACE',
  age: 30,
  isOverseas: false,
  basePrice: 2.00,
  stats: { bat: 30, power: 35, bowl: 98, fielding: 80, ovr: 94 }
};

const marqueeVanity: IPLPlayer = {
  id: 'kohli_95',
  name: 'Virat Kohli',
  role: 'BAT',
  age: 35,
  isOverseas: false,
  basePrice: 2.00,
  stats: { bat: 98, power: 90, bowl: 30, fielding: 88, ovr: 95 }
};

const coreSpecialist: IPLPlayer = {
  id: 'sharma_89',
  name: 'Sandeep Sharma',
  role: 'PACE',
  age: 31,
  isOverseas: false,
  basePrice: 1.00,
  stats: { bat: 30, power: 30, bowl: 91, fielding: 75, ovr: 89 }
};

const standardPlayer: IPLPlayer = {
  id: 'tiwari_82',
  name: 'Saurabh Tiwari',
  role: 'BAT',
  age: 32,
  isOverseas: false,
  basePrice: 0.50,
  stats: { bat: 80, power: 82, bowl: 25, fielding: 70, ovr: 82 }
};

bidderAI.initializeAuction([superstarTier1, marqueeVanity, coreSpecialist, standardPlayer]);

// Setup franchise states with 125 Cr purse
const fProfiles = bidderAI.franchiseProfiles;
const fStates = bidderAI.franchiseStates;

// Setup CSK as SUPERSTAR_DUELIST
fProfiles.get('CSK')!.archetype = 'SUPERSTAR_DUELIST';
fStates.get('CSK')!.archetype = 'SUPERSTAR_DUELIST';
fStates.get('CSK')!.purseRemainingCr = 125.00;
fStates.get('CSK')!.squad = [];
fStates.get('CSK')!.tickList.tier1.add('bumrah_94');

// Setup RR as MONEYBALL_CORE
fProfiles.get('RR')!.archetype = 'MONEYBALL_CORE';
fStates.get('RR')!.archetype = 'MONEYBALL_CORE';
fStates.get('RR')!.purseRemainingCr = 125.00;
fStates.get('RR')!.squad = [];

// Setup GT as DISCIPLINED_PRAGMATIST
fProfiles.get('GT')!.archetype = 'DISCIPLINED_PRAGMATIST';
fStates.get('GT')!.archetype = 'DISCIPLINED_PRAGMATIST';
fStates.get('GT')!.purseRemainingCr = 125.00;
fStates.get('GT')!.squad = [];

// Test 3A: SUPERSTAR_DUELIST on Bumrah (OVR 94 >= 90, tier 1 target)
const cskBid = bidderAI.evaluateFranchiseBid('CSK', superstarTier1, 15.00);
console.log(`CSK (SUPERSTAR_DUELIST) Bumrah (OVR 94) maxValuation: ₹${cskBid.maxValuation} Cr`);
assert.ok(
  cskBid.maxValuation > 17.50,
  `SUPERSTAR_DUELIST must bid well past ₹17 Cr for Tier-1 superstar! Got ₹${cskBid.maxValuation}`
);
assert.ok(
  cskBid.maxValuation <= 26.50,
  `SUPERSTAR_DUELIST must respect the ₹26.50 Cr war ceiling. Got ₹${cskBid.maxValuation}`
);

// Test 3B: MONEYBALL_CORE on Kohli (OVR 95 >= 93) -> Must cap at max ₹12 Cr
const rrBidMarquee = bidderAI.evaluateFranchiseBid('RR', marqueeVanity, 10.00);
console.log(`RR (MONEYBALL_CORE) Kohli (OVR 95) maxValuation: ₹${rrBidMarquee.maxValuation} Cr`);
assert.ok(
  rrBidMarquee.maxValuation <= 12.00,
  `MONEYBALL_CORE must fold/cap at <= ₹12.00 Cr for marquee vanity icons (OVR >= 93)! Got ₹${rrBidMarquee.maxValuation}`
);

// Test 3C: MONEYBALL_CORE on Sandeep Sharma (OVR 89, between 87 and 92) -> Boosted +30% up to ₹21 Cr
const rrBidCore = bidderAI.evaluateFranchiseBid('RR', coreSpecialist, 10.00);
console.log(`RR (MONEYBALL_CORE) Sandeep Sharma (OVR 89) maxValuation: ₹${rrBidCore.maxValuation} Cr`);
assert.ok(
  rrBidCore.maxValuation > 13.00,
  `MONEYBALL_CORE should aggressively bid on 87-92 OVR core talent! Got ₹${rrBidCore.maxValuation}`
);
assert.ok(
  rrBidCore.maxValuation <= 21.00,
  `MONEYBALL_CORE must cap at ₹21.00 Cr for core talent. Got ₹${rrBidCore.maxValuation}`
);

// Test 3D: DISCIPLINED_PRAGMATIST on Bumrah (OVR 94) -> Must cap at ₹16.50 Cr
const gtBidBumrah = bidderAI.evaluateFranchiseBid('GT', superstarTier1, 14.00);
console.log(`GT (DISCIPLINED_PRAGMATIST) Bumrah (OVR 94) maxValuation: ₹${gtBidBumrah.maxValuation} Cr`);
assert.ok(
  gtBidBumrah.maxValuation <= 16.50,
  `DISCIPLINED_PRAGMATIST must strictly cap at ₹16.50 Cr! Got ₹${gtBidBumrah.maxValuation}`
);

console.log('✓ All Archetype bidding behaviors verified successfully.');

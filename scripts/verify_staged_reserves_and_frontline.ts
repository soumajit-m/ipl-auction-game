import { AuctionBidderAI, getArchetypeDistribution, assignFranchiseArchetypes } from '../src/server/auction/bidderAI';
import { TeamMaker } from '../src/server/match/teamMaker';
import { FullMatchSimulator, Team2026 } from '../src/server/match/fullMatchSimulator';
import { IPLPlayer } from '../src/types/player.types';
import * as fs from 'fs';
import assert from 'assert';

console.log('================================================================');
console.log('TEST 1: DYNAMIC ARCHETYPE DISTRIBUTION');
console.log('================================================================');

const dist3 = getArchetypeDistribution(3);
console.log('N=3 distribution:', dist3);
assert.strictEqual(dist3.sdCount, 1);
assert.strictEqual(dist3.mbCount, 1);
assert.strictEqual(dist3.dpCount, 1);

const dist4 = getArchetypeDistribution(4);
console.log('N=4 distribution:', dist4);
assert.ok(dist4.sdCount <= 2 && dist4.sdCount >= 1);
assert.strictEqual(dist4.mbCount, 1);
assert.ok(dist4.dpCount >= 1);

const dist5 = getArchetypeDistribution(5);
console.log('N=5 distribution:', dist5);
assert.ok(dist5.sdCount <= 2 && dist5.sdCount >= 1);
assert.strictEqual(dist5.mbCount, 1);
assert.ok(dist5.dpCount >= 1);

const dist9 = getArchetypeDistribution(9);
console.log('N=9 distribution (1 Human + 9 AI):', dist9);
assert.ok(dist9.sdCount >= 2 && dist9.sdCount <= 3);
assert.ok(dist9.mbCount >= 1 && dist9.mbCount <= 2);
assert.strictEqual(dist9.sdCount + dist9.mbCount + dist9.dpCount, 9);
console.log('✓ Dynamic Archetype Distribution verified successfully!');

console.log('\n================================================================');
console.log('TEST 2: STAGED SOLVENCY RESERVES & SINGLE-BID PURSE CEILING');
console.log('================================================================');

const raw = fs.readFileSync('./public/data/players_active_fixed.json', 'utf-8');
const allPlayers: IPLPlayer[] = JSON.parse(raw);

const bidderAI = new AuctionBidderAI();
bidderAI.initializeAuction(allPlayers);

// Test staged reserve on a team with 7 players and 40 Cr purse remaining
// Target squad = 19. Next slots: 9 to 19.
// Slots 9, 10, 11 (3 slots): 3 * 3.00 = 9.00 Cr
// Slots 12, 13, 14 (3 slots): 3 * 1.20 = 3.60 Cr
// Slots 15, 16, 17, 18, 19 (5 slots): 5 * 0.30 = 1.50 Cr
// Total stagedReserve = 9.00 + 3.60 + 1.50 = 14.10 Cr
// maxAffordable = 40.0 - 14.10 = 25.90 Cr
// Single-bid ceiling (squadSize >= 4 && squadSize < 11): 40 * 0.40 = 16.00 Cr!
const mockPlayer: IPLPlayer = {
  id: 'SUPERSTAR_TEST',
  name: 'Superstar Test',
  role: 'BAT',
  subType: 'TOP_ORDER_BAT',
  basePrice: 2.0,
  isOverseas: false,
  isUncapped: false,
  stats: {
    bat: 94,
    bowl: 30,
    fielding: 85,
    power: 92,
    running: 88,
    staminaRecov: 90,
    staminaDecline: 10,
    ovr: 93
  }
};

const cskProfile = (bidderAI as any).franchiseProfiles.get('CSK')!;
cskProfile.archetype = 'SUPERSTAR_DUELIST';
const cskState = (bidderAI as any).franchiseStates.get('CSK');
cskState.purseRemainingCr = 40.0;
cskState.squad = allPlayers.slice(0, 7); // 7 players currently owned

const decision = bidderAI.evaluateFranchiseBid('CSK', mockPlayer, 2.0);
console.log('CSK Decision (Squad=7, Purse=40Cr):', {
  canBid: decision.canBid,
  maxValuation: decision.maxValuation,
  reason: decision.reason
});

// Since squadSize is 7 (between 4 and 11), single-bid ceiling MUST cap at 40 * 0.40 = 16.0 Cr
assert.ok(decision.maxValuation <= 16.0, `Max valuation (${decision.maxValuation}) should not exceed 40% purse ceiling (16.0 Cr)!`);
console.log('✓ Staged Solvency Reserves & 40% Single-Bid Ceiling correctly prevented purse exhaustion!');

console.log('\n================================================================');
console.log('TEST 3: FRONTLINE BOWLER PROTECTION (MATCH SIMULATION)');
console.log('================================================================');

// Create a lineup with Abhishek Sharma (BAT_AR) and frontline bowlers (PACE & SPIN)
const batAR: IPLPlayer = {
  id: 'abhishek_sharma',
  name: 'Abhishek Sharma',
  role: 'AR',
  subType: 'BAT_AR',
  basePrice: 1.5,
  isOverseas: false,
  isUncapped: false,
  stats: { bat: 86, bowl: 65, fielding: 75, power: 88, running: 82, staminaRecov: 85, staminaDecline: 15, ovr: 84 },
  tacticalSynergy: { powerplay: 0.4, middle: 0.5, death: 0.1 }
};

const frontlinePace1: IPLPlayer = {
  id: 'bumrah',
  name: 'Jasprit Bumrah',
  role: 'PACE',
  subType: 'EXPRESS_PACE',
  basePrice: 2.0,
  isOverseas: false,
  isUncapped: false,
  stats: { bat: 30, bowl: 96, fielding: 78, power: 40, running: 75, staminaRecov: 92, staminaDecline: 8, ovr: 94 },
  tacticalSynergy: { powerplay: 0.9, middle: 0.7, death: 0.98 }
};

const frontlinePace2: IPLPlayer = {
  id: 'arshdeep',
  name: 'Arshdeep Singh',
  role: 'PACE',
  subType: 'SWING_BOWLER',
  basePrice: 2.0,
  isOverseas: false,
  isUncapped: false,
  stats: { bat: 25, bowl: 88, fielding: 74, power: 35, running: 72, staminaRecov: 88, staminaDecline: 12, ovr: 86 },
  tacticalSynergy: { powerplay: 0.85, middle: 0.6, death: 0.92 }
};

const frontlineSpin1: IPLPlayer = {
  id: 'chahal',
  name: 'Yuzvendra Chahal',
  role: 'SPIN',
  subType: 'LEGGIE',
  basePrice: 2.0,
  isOverseas: false,
  isUncapped: false,
  stats: { bat: 20, bowl: 89, fielding: 68, power: 25, running: 70, staminaRecov: 86, staminaDecline: 14, ovr: 87 },
  tacticalSynergy: { powerplay: 0.3, middle: 0.95, death: 0.5 }
};

const frontlineBowlAR: IPLPlayer = {
  id: 'hardik',
  name: 'Hardik Pandya',
  role: 'AR',
  subType: 'BOWL_AR',
  basePrice: 2.0,
  isOverseas: false,
  isUncapped: false,
  stats: { bat: 85, bowl: 82, fielding: 86, power: 90, running: 85, staminaRecov: 88, staminaDecline: 12, ovr: 88 },
  tacticalSynergy: { powerplay: 0.7, middle: 0.75, death: 0.75 }
};

const frontlinePace3: IPLPlayer = {
  id: 'siraj',
  name: 'Mohammed Siraj',
  role: 'PACE',
  subType: 'SEAM_BOWLER',
  basePrice: 2.0,
  isOverseas: false,
  isUncapped: false,
  stats: { bat: 22, bowl: 86, fielding: 75, power: 30, running: 78, staminaRecov: 88, staminaDecline: 12, ovr: 85 },
  tacticalSynergy: { powerplay: 0.88, middle: 0.65, death: 0.78 }
};

// Check TeamMaker helper
assert.strictEqual(TeamMaker.isFrontlineBowler(batAR), false, 'BAT_AR must NOT be a frontline bowler!');
assert.strictEqual(TeamMaker.isFrontlineBowler(frontlinePace1), true, 'PACE must be a frontline bowler!');
assert.strictEqual(TeamMaker.isFrontlineBowler(frontlineSpin1), true, 'SPIN must be a frontline bowler!');
assert.strictEqual(TeamMaker.isFrontlineBowler(frontlineBowlAR), true, 'BOWL_AR with bowl>=78 must be a frontline bowler!');
console.log('✓ isFrontlineBowler classification checks passed!');

// Build a full 11 team with batAR in the squad
const bat1: IPLPlayer = { id: 'rohit', name: 'Rohit Sharma', role: 'BAT', basePrice: 2.0, isOverseas: false, stats: { bat: 90, bowl: 20, fielding: 80, power: 88, running: 80, ovr: 89 } as any };
const bat2: IPLPlayer = { id: 'kohli', name: 'Virat Kohli', role: 'BAT', basePrice: 2.0, isOverseas: false, stats: { bat: 95, bowl: 25, fielding: 88, power: 86, running: 92, ovr: 94 } as any };
const bat3: IPLPlayer = { id: 'surya', name: 'Suryakumar Yadav', role: 'BAT', basePrice: 2.0, isOverseas: false, stats: { bat: 93, bowl: 20, fielding: 82, power: 94, running: 84, ovr: 92 } as any };
const bat4: IPLPlayer = { id: 'rinku', name: 'Rinku Singh', role: 'BAT', basePrice: 1.0, isOverseas: false, stats: { bat: 86, bowl: 20, fielding: 85, power: 90, running: 86, ovr: 85 } as any };
const wk1: IPLPlayer = { id: 'pant', name: 'Rishabh Pant', role: 'WK', basePrice: 2.0, isOverseas: false, stats: { bat: 89, bowl: 15, fielding: 85, power: 91, running: 85, ovr: 89 } as any };

const testSquad: IPLPlayer[] = [
  bat1, bat2, bat3, bat4, wk1, batAR,
  frontlinePace1, frontlinePace2, frontlinePace3, frontlineSpin1, frontlineBowlAR
];

const lineup = TeamMaker.makeSmartLineup('TEST_TEAM', testSquad);
console.log('Lineup bowlerPool352:', lineup.bowlerPool352);

// Assert that BAT_AR is NOT in the death overs
assert.ok(!lineup.bowlerPool352.deathBowlerIds.includes(batAR.id), 'Abhishek Sharma (BAT_AR) must NEVER be assigned to Death Overs!');
console.log('✓ Abhishek Sharma (BAT_AR) excluded from Death Overs pool!');

// Simulate an innings and verify overs bowled
const team2026: Team2026 = {
  id: 'TEST_TEAM',
  name: 'Test Team',
  playingXI: testSquad,
  primaryBowlers: lineup.bowlerPool352.middleBowlerIds,
  powerplayBowlers: lineup.bowlerPool352.powerplayBowlerIds,
  deathBowlers: lineup.bowlerPool352.deathBowlerIds,
  firstBowlerId: lineup.bowlerPool352.firstBowlerId,
  backupBowlerId: lineup.bowlerPool352.backupBowlerId,
  bowlerPool352: lineup.bowlerPool352
};

const oppTeam: Team2026 = {
  id: 'OPP_TEAM',
  name: 'Opponent Team',
  playingXI: testSquad,
  primaryBowlers: lineup.bowlerPool352.middleBowlerIds,
  powerplayBowlers: lineup.bowlerPool352.powerplayBowlerIds,
  deathBowlers: lineup.bowlerPool352.deathBowlerIds,
  firstBowlerId: lineup.bowlerPool352.firstBowlerId,
  backupBowlerId: lineup.bowlerPool352.backupBowlerId,
  bowlerPool352: lineup.bowlerPool352
};

const sim = new FullMatchSimulator();
async function runSimTest() {
  const pitch = { pace: 0.5, spin: 0.5, power: 0.5, dew: 0.2 };
  const inningsResult = await sim.simulateInnings(1, oppTeam, team2026, pitch);

  console.log('\n--- Bowling Figures in Simulated Match ---');
  let totalOvers = 0;
  let totalWickets = 0;
  for (const [key, fig] of Object.entries(inningsResult.bowlingFigures)) {
    const bowler = testSquad.find(p => p.id === fig.id || p.name === key || p.id === key);
    assert.ok(bowler, `Bowler ${key} must exist in squad!`);
    console.log(`Bowler ${bowler.name} (${bowler.role}/${bowler.subType || 'NONE'}): ${fig.overs} overs, ${fig.runsConceded} runs, ${fig.wickets} wkts`);
    totalOvers += fig.overs;
    totalWickets += fig.wickets;

    if (bowler.id === batAR.id) {
      assert.ok(fig.overs <= 2, `BAT_AR ${bowler.name} bowled ${fig.overs} overs! Must NEVER bowl a 4-over spell (max 2 overs)!`);
    }
    if (fig.overs === 4) {
      assert.ok(TeamMaker.isFrontlineBowler(bowler), `Bowler ${bowler.name} bowled 4 overs but is NOT a frontline bowler!`);
    }
  }

  assert.ok(totalOvers === 20 || totalWickets === 10, `Innings must either reach 20 overs or all out 10 wickets (overs=${totalOvers}, wickets=${totalWickets})`);
  console.log('✓ Frontline Bowler Protection strictly verified in live 20-over match simulation!');
  console.log('\nALL TESTS PASSED SUCCESSFULLY! ✓');
}

runSimTest().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

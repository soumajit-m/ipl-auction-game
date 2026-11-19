import assert from 'assert';
import { AuctionBidderAI, DEFAULT_IPL_FRANCHISES } from '../src/server/auction/bidderAI';
import { SocketHub } from '../src/server/socketHub';
import { IPLPlayer } from '../src/types/player.types';

console.log('--- TEST 1: Initial Franchise Purse is 125.0 Cr Everywhere ---');
const bidderAI = new AuctionBidderAI();
const dummyPlayers: IPLPlayer[] = [
  { id: 'p1', name: 'Virat Kohli', role: 'BAT', basePrice: 2.0, stats: { bat: 95, power: 88, bowl: 40, fielding: 90, ovr: 92 }, marqueeSet: 1 },
  { id: 'p2', name: 'Jasprit Bumrah', role: 'PACE', basePrice: 2.0, stats: { bat: 45, power: 50, bowl: 98, fielding: 80, ovr: 95 }, marqueeSet: 1 },
  { id: 'p3', name: 'Hardik Pandya', role: 'AR', basePrice: 2.0, stats: { bat: 85, power: 90, bowl: 84, fielding: 85, ovr: 88 }, marqueeSet: 1 },
  { id: 'p4', name: 'Rashid Khan', role: 'SPIN', basePrice: 2.0, stats: { bat: 65, power: 75, bowl: 94, fielding: 85, ovr: 90 }, marqueeSet: 1 },
  { id: 'p5', name: 'Rishabh Pant', role: 'WK', basePrice: 2.0, stats: { bat: 89, power: 92, bowl: 30, fielding: 85, ovr: 89 }, marqueeSet: 1 }
];

const teams = bidderAI.initializeTeams('TEST_ROOM', dummyPlayers);
for (const [id, t] of Object.entries(teams)) {
  assert.strictEqual(t.purse, 125.0, `Team ${id} purse should be 125.0 Cr, got ${t.purse}`);
  assert.strictEqual(Math.round((t.P_main_cap + t.P_acc_vault) * 100) / 100, 125.0, `Team ${id} budget cap sum should equal 125.0 Cr`);
}
console.log('✓ TEST 1 PASSED: All 10 teams initialized with exactly ₹125.00 Cr purse.');

console.log('\n--- TEST 2: 70 League Matches & Exactly 14 Matches per Franchise ---');
const socketHub = new SocketHub();
(socketHub as any).flushRoomToMongoDB = () => {}; // Mock DB in test
const room = socketHub.createRoom('TEST_SEASON', 'host123', dummyPlayers);

// Create 18 dummy players for all 10 teams so lineups can be formed
for (const team of Object.values(room.teams)) {
  for (let i = 1; i <= 18; i++) {
    team.squad.push({
      id: `${team.franchiseId}_player_${i}`,
      name: `${team.franchiseId} Player ${i}`,
      role: i <= 5 ? 'BAT' : (i <= 7 ? 'WK' : (i <= 10 ? 'AR' : (i <= 14 ? 'PACE' : 'SPIN'))),
      basePrice: 0.50,
      stats: { bat: 75, power: 75, bowl: 75, fielding: 75, ovr: 75 },
      marqueeSet: 2
    });
  }
}

room.status = 'SEASON';
(socketHub as any).initSeason(room);
if (room.seasonClockInterval) {
  clearInterval(room.seasonClockInterval);
  room.seasonClockInterval = null;
}

assert(room.season !== null, 'Room season must be initialized');
assert.strictEqual(room.season.fixtures.length, 74, `Expected 74 total fixtures, got ${room.season.fixtures.length}`);

// Verify league match distribution (Matches 1-70)
const leagueMatchCounts: Record<string, { home: number; away: number; total: number }> = {};
Object.keys(room.teams).forEach(tId => {
  leagueMatchCounts[tId] = { home: 0, away: 0, total: 0 };
});

for (let i = 0; i < 70; i++) {
  const f = room.season.fixtures[i];
  leagueMatchCounts[f.homeTeamId].home++;
  leagueMatchCounts[f.homeTeamId].total++;
  leagueMatchCounts[f.awayTeamId].away++;
  leagueMatchCounts[f.awayTeamId].total++;
}

for (const [tId, c] of Object.entries(leagueMatchCounts)) {
  assert.strictEqual(c.total, 14, `Franchise ${tId} must play exactly 14 matches, got ${c.total}`);
  assert.strictEqual(c.home, 7, `Franchise ${tId} must play 7 home matches, got ${c.home}`);
  assert.strictEqual(c.away, 7, `Franchise ${tId} must play 7 away matches, got ${c.away}`);
}
console.log('✓ TEST 2 PASSED: All 10 franchises have exactly 14 matches (7 home, 7 away, 70 league matches total).');

console.log('\n--- TEST 3: Bulk Simulation Through League Phase (Matches 1-70) ---');
async function runSimulationTests() {
  // Simulate all 70 league matches
  while (room.season!.currentMatchIndex < 70) {
    await socketHub.advanceSeasonMatch(room);
  }

  assert.strictEqual(room.season!.currentMatchIndex, 70, `Current match index should be 70 after league phase, got ${room.season!.currentMatchIndex}`);

  // Verify that EVERY team has played EXACTLY 14 matches in the standings
  for (const [tId, standing] of Object.entries(room.season!.standings)) {
    assert.strictEqual(
      standing.played,
      14,
      `Team ${tId} should have played exactly 14 matches in standings, but got ${standing.played} (W:${standing.won}, L:${standing.lost}, T:${standing.tied})`
    );
    assert.strictEqual(
      standing.won + standing.lost + standing.tied,
      14,
      `Team ${tId} sum of W+L+T must equal 14, got ${standing.won + standing.lost + standing.tied}`
    );
  }
  console.log('✓ TEST 3 PASSED: All 10 franchises have played exactly 14 matches in Standings (no 13 or 15 match anomaly).');

  console.log('\n--- TEST 4: Playoff Seeding (Qualifier 1 & Eliminator) ---');
  socketHub.ensurePlayoffTeamsAssigned(room);
  const q1 = room.season!.fixtures[70];
  const elim = room.season!.fixtures[71];

  assert(!q1.homeTeamId.startsWith('TBD'), `Qualifier 1 Home team should not be TBD, got ${q1.homeTeamId}`);
  assert(!q1.awayTeamId.startsWith('TBD'), `Qualifier 1 Away team should not be TBD, got ${q1.awayTeamId}`);
  assert(!elim.homeTeamId.startsWith('TBD'), `Eliminator Home team should not be TBD, got ${elim.homeTeamId}`);
  assert(!elim.awayTeamId.startsWith('TBD'), `Eliminator Away team should not be TBD, got ${elim.awayTeamId}`);
  console.log(`✓ TEST 4 PASSED: Qualifier 1 is ${q1.homeTeam} vs ${q1.awayTeam}, Eliminator is ${elim.homeTeam} vs ${elim.awayTeam}`);

  console.log('\n--- TEST 5: Playoff Execution & Progression to Final ---');
  // Play Match 71 (Qualifier 1)
  await socketHub.advanceSeasonMatch(room);
  assert.strictEqual(room.season!.currentMatchIndex, 71);
  assert(room.season!.fixtures[70].completed, 'Qualifier 1 must be marked completed');

  // Play Match 72 (Eliminator)
  await socketHub.advanceSeasonMatch(room);
  assert.strictEqual(room.season!.currentMatchIndex, 72);
  assert(room.season!.fixtures[71].completed, 'Eliminator must be marked completed');

  // Verify Qualifier 2 (Match 73) is now fully assigned
  const q2 = room.season!.fixtures[72];
  assert(!q2.homeTeamId.startsWith('TBD'), `Qualifier 2 Home team should not be TBD, got ${q2.homeTeamId}`);
  assert(!q2.awayTeamId.startsWith('TBD'), `Qualifier 2 Away team should not be TBD, got ${q2.awayTeamId}`);
  console.log(`✓ Qualifier 2 is ready and populated: ${q2.homeTeam} vs ${q2.awayTeam}`);

  // Play Match 73 (Qualifier 2)
  await socketHub.advanceSeasonMatch(room);
  assert.strictEqual(room.season!.currentMatchIndex, 73);
  assert(room.season!.fixtures[72].completed, 'Qualifier 2 must be marked completed');

  // Verify Grand Final (Match 74) is now fully assigned
  const final = room.season!.fixtures[73];
  assert(!final.homeTeamId.startsWith('TBD'), `Grand Final Home team should not be TBD, got ${final.homeTeamId}`);
  assert(!final.awayTeamId.startsWith('TBD'), `Grand Final Away team should not be TBD, got ${final.awayTeamId}`);
  console.log(`✓ Grand Final is ready and populated: ${final.homeTeam} vs ${final.awayTeam}`);

  // Play Match 74 (Grand Final)
  await socketHub.advanceSeasonMatch(room);
  assert.strictEqual(room.season!.currentMatchIndex, 74);
  assert(room.season!.fixtures[73].completed, 'Grand Final must be marked completed');
  assert(room.season!.championTeamId !== undefined && room.season!.championTeamId !== null, 'Champion must be crowned');
  console.log(`✓ Grand Final Complete! Champion: ${room.teams[room.season!.championTeamId!]?.name || room.season!.championTeamId}`);
  console.log('✓ TEST 5 PASSED: Entire playoff bracket (Matches 71-74) simulated and completed with 0 errors.');

  console.log('\n--- TEST 6: Re-entrancy Mutex Protection ---');
  let rejectedConcurrent = false;
  room.isAdvancingMatch = true;
  const initialIndex = room.season!.currentMatchIndex;
  await socketHub.advanceSeasonMatch(room);
  assert.strictEqual(room.season!.currentMatchIndex, initialIndex, 'advanceSeasonMatch must immediately exit when isAdvancingMatch is true');
  room.isAdvancingMatch = false;
  console.log('✓ TEST 6 PASSED: Concurrency lock properly blocks duplicate sim executions.');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉');
  process.exit(0);
}

runSimulationTests().catch(e => {
  console.error('Test Failed:', e);
  process.exit(1);
});

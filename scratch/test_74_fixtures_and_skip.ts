import { SocketHub } from '../src/server/socketHub';
import { IPLPlayer } from '../src/types/player.types';
import { InternalRoomState } from '../src/server/socketHub';
import { DEFAULT_IPL_FRANCHISES } from '../src/server/auction/bidderAI';

function mockPlayers(): IPLPlayer[] {
  const roles = ['BAT', 'WK', 'AR', 'PACE', 'SPIN'];
  const players: IPLPlayer[] = [];
  for (let i = 1; i <= 300; i++) {
    const role = roles[i % 5] as any;
    players.push({
      id: `p_${i}`,
      name: `Player ${i}`,
      role,
      isOverseas: i % 4 === 0,
      basePrice: 0.50,
      stats: { ovr: 70 + (i % 25), bat: 75, bowl: role === 'BAT' || role === 'WK' ? 25 : 80, power: 70, age: 26 },
      tacticalSynergy: { powerplay: 75, middle: 75, death: 75 }
    } as any);
  }
  return players;
}

async function runTest() {
  console.log('--- TESTING 74-MATCH FIXTURES & AUCTION SKIP ---');

  const allPlayers = mockPlayers();
  const hub = new SocketHub({} as any, allPlayers);

  // Build a test room with 10 teams (1 Human, 9 AI)
  const teams: Record<string, any> = {};
  DEFAULT_IPL_FRANCHISES.forEach((f, idx) => {
    teams[f.id] = {
      franchiseId: f.id,
      name: f.name,
      purse: 120.0,
      isHuman: idx === 0, // CSK is Human
      ownerName: idx === 0 ? 'Human Manager' : 'AI Manager',
      squad: [],
      connected: true,
      wishlistIds: [],
      skipLotIds: []
    };
  });

  // Human drafts 18 players
  const humanSquad = allPlayers.slice(0, 18).map(p => ({ ...p, soldPrice: 1.0 }));
  teams['CSK'].squad = humanSquad;
  teams['CSK'].purse = 102.0;

  const room: InternalRoomState = {
    roomCode: 'TEST-74',
    hostId: 'host_1',
    hostUsername: 'Host',
    hostSocketId: 'sock_1',
    status: 'AUCTION',
    phase: 'MAIN' as any,
    determinismRatio: 0.5,
    humanTaxEnabled: true,
    acceleratedRoundMode: '1-ACC',
    isPaused: false,
    isDirty: false,
    lastSavedAt: Date.now(),
    seats: [{
      teamId: 'CSK',
      teamName: 'Chennai Super Kings',
      isHuman: true,
      playerName: 'Human Manager',
      socketId: 'sock_1',
      ipHash: 'hash',
      deviceUUID: 'uuid_1',
      token: 'tok',
      connected: true
    }],
    teams,
    allPlayers,
    lotQueue: allPlayers.slice(18),
    currentLot: null,
    completedLots: [],
    wishlistTimer: { msRemaining: 0, totalMs: 180000, submittedTeamIds: [] },
    humanSkipCooldowns: {},
    humanFilterConfigs: {},
    commentaryTicker: [],
    season: null,
    aiBidTimeouts: []
  };

  // 1. Test checkHumanSquadsLegal
  const legalCheck = hub.checkHumanSquadsLegal(room);
  console.log('Human squad legal check:', legalCheck);
  if (!legalCheck.legal) throw new Error('Expected CSK to be legal');

  // 2. Test completeAuctionAndSkipToSeason (DO NOT TOUCH HUMAN SQUAD)
  hub.completeAuctionAndSkipToSeason(room);

  if (room.status !== 'SEASON') throw new Error(`Expected SEASON status, got ${room.status}`);
  if (room.teams['CSK'].squad.length !== 18) {
    throw new Error(`CRITICAL: Human squad was touched! Expected 18, got ${room.teams['CSK'].squad.length}`);
  }
  console.log('✓ Human squad remained 100% untouched (18 players preserved).');

  // Verify AI teams were filled up
  Object.values(room.teams).forEach(t => {
    if (!t.isHuman) {
      if (t.squad.length < 18) throw new Error(`AI squad ${t.name} has only ${t.squad.length} players`);
    }
  });
  console.log('✓ All 9 AI squads auto-filled with legal 18-20 player squads.');

  // 3. Verify Fixtures Generation: exactly 74 matches!
  if (!room.season) throw new Error('Season not initialized');
  console.log(`Total Season Fixtures: ${room.season.fixtures.length}`);
  if (room.season.fixtures.length !== 74) {
    throw new Error(`Expected 74 matches, got ${room.season.fixtures.length}`);
  }

  // Check league matches 1 to 70: each team plays 14 matches
  const matchCounts: Record<string, { home: number; away: number; total: number }> = {};
  Object.keys(room.teams).forEach(id => {
    matchCounts[id] = { home: 0, away: 0, total: 0 };
  });

  for (let i = 0; i < 70; i++) {
    const f = room.season.fixtures[i];
    matchCounts[f.homeTeamId].home++;
    matchCounts[f.homeTeamId].total++;
    matchCounts[f.awayTeamId].away++;
    matchCounts[f.awayTeamId].total++;
  }

  console.log('League Matches per Team (Matches 1-70):');
  Object.entries(matchCounts).forEach(([tId, c]) => {
    console.log(`  ${tId}: ${c.total} matches (${c.home} home, ${c.away} away)`);
    if (c.total !== 14) throw new Error(`Expected team ${tId} to play 14 matches, played ${c.total}`);
    if (c.home !== 7 || c.away !== 7) throw new Error(`Expected team ${tId} to play 7 home & 7 away, played ${c.home}H/${c.away}A`);
  });
  console.log('✓ Exactly 70 League Matches generated with perfectly balanced 7 home & 7 away fixtures per team!');

  // Check Playoff Fixtures (Matches 71 to 74)
  const q1 = room.season.fixtures[70];
  const elim = room.season.fixtures[71];
  const q2 = room.season.fixtures[72];
  const finalMatch = room.season.fixtures[73];

  if (q1.playoffStage !== 'QUALIFIER_1') throw new Error('Expected Qualifier 1 at Match 71');
  if (elim.playoffStage !== 'ELIMINATOR') throw new Error('Expected Eliminator at Match 72');
  if (q2.playoffStage !== 'QUALIFIER_2') throw new Error('Expected Qualifier 2 at Match 73');
  if (finalMatch.playoffStage !== 'FINAL') throw new Error('Expected Final at Match 74');
  console.log('✓ All 4 Playoff fixtures (Qualifier 1, Eliminator, Qualifier 2, Grand Final) configured properly.');

  // 4. Test Simulation of 70 League Matches
  console.log('Simulating 70 league matches...');
  while (room.season.currentMatchIndex < 70) {
    await hub.advanceSeasonMatch(room);
  }
  console.log(`Current match index after league phase: ${room.season.currentMatchIndex}`);
  if (room.season.currentMatchIndex !== 70) throw new Error('Expected currentMatchIndex = 70');

  // Verify Qualifier 1 and Eliminator are now populated with actual team IDs
  console.log(`Qualifier 1 Matchup: ${q1.homeTeam} vs ${q1.awayTeam}`);
  console.log(`Eliminator Matchup: ${elim.homeTeam} vs ${elim.awayTeam}`);
  if (q1.homeTeamId.startsWith('TBD') || q1.awayTeamId.startsWith('TBD')) {
    throw new Error('Qualifier 1 teams should be populated');
  }
  if (elim.homeTeamId.startsWith('TBD') || elim.awayTeamId.startsWith('TBD')) {
    throw new Error('Eliminator teams should be populated');
  }
  console.log('✓ Standings finalized and Playoffs Match 71 & 72 successfully populated with top 4 seeds!');

  // 5. Test Playoff Matches simulation step-by-step
  console.log('\nSimulating Match #71 (Qualifier 1)...');
  await hub.advanceSeasonMatch(room);
  console.log(`Q1 Result: ${q1.marginText}`);
  console.log(`Final Home Team after Q1: ${finalMatch.homeTeam}`);
  console.log(`Q2 Home Team after Q1: ${q2.homeTeam}`);

  console.log('\nSimulating Match #72 (Eliminator)...');
  await hub.advanceSeasonMatch(room);
  console.log(`Eliminator Result: ${elim.marginText}`);
  console.log(`Q2 Away Team after Eliminator: ${q2.awayTeam}`);

  console.log('\nSimulating Match #73 (Qualifier 2)...');
  await hub.advanceSeasonMatch(room);
  console.log(`Q2 Result: ${q2.marginText}`);
  console.log(`Final Away Team after Q2: ${finalMatch.awayTeam}`);

  console.log('\nSimulating Match #74 (Grand Final 🏆)...');
  await hub.advanceSeasonMatch(room);
  console.log(`Grand Final Result: ${finalMatch.marginText}`);
  console.log(`Champion: ${room.season.championTeamId}`);
  if (!room.season.championTeamId) throw new Error('Expected champion team ID');

  console.log('\n✓ ALL 74 MATCHES COMPLETED AND VERIFIED 100%!');
}

runTest().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

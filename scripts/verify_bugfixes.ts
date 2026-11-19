import assert from 'assert';
import { SocketHub } from '../src/server/socketHub';
import { AuctionBidderAI } from '../src/server/auction/bidderAI';
import { FullMatchSimulator } from '../src/server/match/fullMatchSimulator';
import { TeamMaker } from '../src/server/match/teamMaker';
import * as fs from 'fs';
import * as path from 'path';

async function runBugFixesVerification() {
  console.log('====================================================');
  console.log('🧪 MULTIPLAYER PLAYTEST BUG FIXES VERIFICATION SUITE');
  console.log('====================================================\n');

  // Load active players
  const playersPath = path.resolve(__dirname, '../public/data/players_active_fixed.json');
  const allPlayers = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  console.log(`✓ Loaded ${allPlayers.length} active players from players_active_fixed.json`);

  const mockIo: any = {
    to: (roomCode: string) => ({
      emit: (event: string, data: any) => {}
    }),
    emit: (event: string, data: any) => {}
  };

  const hub = new SocketHub(mockIo, allPlayers);
  await (hub as any).initAI();

  // Create test room
  const room = hub.createRoom('TEST01', 'host_01', allPlayers, 0.45, true, 'HostAdmin');
  console.log('✓ Created room TEST01');

  // Populate squads with 18 players each so TeamMaker can generate 3-5-2 lineups
  let playerIdx = 0;
  for (const team of Object.values(room.teams)) {
    team.squad = allPlayers.slice(playerIdx, playerIdx + 18);
    playerIdx += 18;
  }
  console.log('✓ Populated 18 players per squad for season testing');

  function createMockSocket(id: string, teamId: string, isHost: boolean = false, onEmit?: (event: string, data: any) => void) {
    const handlers: Record<string, Function> = {};
    const sock: any = {
      id,
      handshake: { headers: {}, address: '127.0.0.1' },
      data: { roomCode: 'TEST01', teamId, isHost },
      join: () => {},
      emit: (event: string, data: any) => {
        if (onEmit) onEmit(event, data);
      },
      on: (ev: string, fn: Function) => {
        handlers[ev] = fn;
      }
    };
    hub.handleConnection(sock);
    return { sock, handlers };
  }

  // =========================================================================
  // TEST 4: STRICT 14-MATCH IPL SCHEDULE (70 LEAGUE MATCHES + 4 PLAYOFFS = 74)
  // =========================================================================
  console.log('\n--- 1. Testing Strict 70-Match IPL Schedule (Bug 4) ---');
  hub.initSeason(room);
  assert(room.season, 'room.season must be initialized');
  assert.strictEqual(room.season.totalMatches, 74, `Total matches must be exactly 74, got ${room.season.totalMatches}`);
  assert.strictEqual(room.season.fixtures.length, 74, `Fixtures count must be exactly 74, got ${room.season.fixtures.length}`);

  const leagueFixtures = room.season.fixtures.filter(f => !f.isPlayoff);
  assert.strictEqual(leagueFixtures.length, 70, `League fixtures must be exactly 70, got ${leagueFixtures.length}`);

  const playoffFixtures = room.season.fixtures.filter(f => f.isPlayoff);
  assert.strictEqual(playoffFixtures.length, 4, `Playoff fixtures must be exactly 4, got ${playoffFixtures.length}`);

  const counts: Record<string, { home: number; away: number; total: number }> = {};
  for (const tId of Object.keys(room.teams)) {
    counts[tId] = { home: 0, away: 0, total: 0 };
  }
  for (const f of leagueFixtures) {
    counts[f.homeTeamId].home++;
    counts[f.homeTeamId].total++;
    counts[f.awayTeamId].away++;
    counts[f.awayTeamId].total++;
  }

  for (const [tId, c] of Object.entries(counts)) {
    assert.strictEqual(c.total, 14, `Team ${tId} must play 14 league matches, got ${c.total}`);
    assert.strictEqual(c.home, 7, `Team ${tId} must play 7 home matches, got ${c.home}`);
    assert.strictEqual(c.away, 7, `Team ${tId} must play 7 away matches, got ${c.away}`);
  }
  console.log('✓ Strict schedule verified: 10 teams × 14 matches (7H/7A) = 70 League Matches + 4 Playoff Matches = 74 Total');

  // =========================================================================
  // TEST 1: TEAM MANAGER IDENTITY BINDING & LINEUP UPDATE AUTHORIZATION
  // =========================================================================
  console.log('\n--- 2. Testing Team Manager Identity Binding & Lineup Authorization (Bug 1) ---');
  // Setup Seat 1 as Human (MI) and Seat 2 as Human (CSK)
  const miSeat = room.seats.find(s => s.teamId === 'MI')!;
  miSeat.isHuman = true;
  miSeat.playerName = 'RohitManager';
  miSeat.socketId = 'sock_mi_user';
  room.teams['MI'].isHuman = true;
  room.teams['MI'].ownerName = 'RohitManager';

  const cskSeat = room.seats.find(s => s.teamId === 'CSK')!;
  cskSeat.isHuman = true;
  cskSeat.playerName = 'DhoniManager';
  cskSeat.socketId = 'sock_csk_user';
  room.teams['CSK'].isHuman = true;
  room.teams['CSK'].ownerName = 'DhoniManager';

  // Test unauthorized lineup update: CSK user trying to edit MI lineup
  let rejectedError = '';
  const { handlers: unauthorizedHandlers } = createMockSocket('sock_csk_user', 'CSK', false, (event, data) => {
    if (event === 'error_message') rejectedError = data.message;
  });

  const miLineup = room.season.lineups['MI'];
  unauthorizedHandlers['update_lineup']({ lineup: { ...miLineup, teamId: 'MI' } });
  assert(rejectedError.includes('Unauthorized'), `Unauthorized edit should be rejected. Got: ${rejectedError}`);
  console.log('✓ Unauthorized cross-team lineup edit strictly rejected by server');

  // Test authorized lineup update: MI user editing MI lineup
  const { handlers: authorizedHandlers } = createMockSocket('sock_mi_user', 'MI', false, (event, data) => {
    if (event === 'error_message') throw new Error(`Unexpected error: ${data.message}`);
  });

  authorizedHandlers['update_lineup']({ lineup: { ...miLineup, teamId: 'MI' } });
  console.log('✓ Authorized franchise owner successfully updated lineup');

  // =========================================================================
  // TEST 2: LATENCY-BUFFERED BID TIMER (4.0s vs 5.0s SERVER WINDOW)
  // =========================================================================
  console.log('\n--- 3. Testing Latency-Buffered Bid Timer (Bug 2) ---');
  room.status = 'AUCTION';
  const dummyLot: any = {
    lotId: 'lot_bumrah',
    player: allPlayers[0],
    lotNumber: 1,
    totalLots: 100,
    phase: 'MAIN',
    currentPrice: 2.00,
    currentBidder: null,
    currentBidderName: null,
    biddingMode: 'MODE_B',
    timerMs: 500, // 4.5 seconds elapsed on 5.0s clock (within 5.0s window)
    timerTotalMs: 5000,
    isTimerRunning: true,
    bidHistory: [],
    state: 'OPEN'
  };
  room.currentLot = dummyLot;

  let bidRejectedReason = '';
  const { handlers: bidderHandlers } = createMockSocket('sock_csk_user', 'CSK', false, (event, data) => {
    if (event === 'bid_rejected') bidRejectedReason = data.reason;
  });

  // Human places bid at timerMs = 500 (during "FINAL CALL..." visual window)
  bidderHandlers['place_bid']({ lotId: 'lot_bumrah', expectedPrice: 2.00, bidAmount: 2.00 });
  assert.strictEqual(bidRejectedReason, '', `Bid should not be rejected at timerMs = 500. Got: ${bidRejectedReason}`);
  assert.strictEqual(dummyLot.currentBidder, 'CSK');
  assert.strictEqual(dummyLot.timerMs, 5000, 'Server timer must reset to 5000ms upon accepted bid');
  console.log('✓ Bid during final second (500ms remaining) was 100% accepted and reset clock to 5000ms');

  // Human places bid at timerMs = -100 (within 200ms latency grace window)
  dummyLot.timerMs = -100;
  dummyLot.currentBidder = 'MI';
  dummyLot.currentPrice = 2.25;
  bidderHandlers['place_bid']({ lotId: 'lot_bumrah', expectedPrice: 2.25, bidAmount: 2.50 });
  assert.strictEqual(dummyLot.currentBidder, 'CSK', 'Bid within 200ms grace window must be accepted');
  assert.strictEqual(dummyLot.timerMs, 5000, 'Server timer must reset to 5000ms after grace bid');
  console.log('✓ Bid within 200ms latency grace window was 100% accepted and reset clock to 5000ms');

  // Bid arriving beyond 200ms grace window (timerMs = -300) must be rejected
  dummyLot.timerMs = -300;
  bidRejectedReason = '';
  bidderHandlers['place_bid']({ lotId: 'lot_bumrah', expectedPrice: 2.50, bidAmount: 2.75 });
  assert(bidRejectedReason.includes('concluded'), `Expired bid must be rejected. Got: ${bidRejectedReason}`);
  console.log('✓ Bid arriving after cutoff (>200ms grace) was correctly rejected');

  // =========================================================================
  // TEST 3: SOLD / UNSOLD GAVEL OVERLAY RESOLUTION
  // =========================================================================
  console.log('\n--- 4. Testing Sold / Unsold Gavel Overlay Data Emission (Bug 3) ---');
  // Commit lot sale
  dummyLot.currentBidder = 'CSK';
  dummyLot.currentPrice = 14.50;
  (hub as any).commitCurrentLot(room);

  assert(room.lastResolvedLot, 'room.lastResolvedLot must be populated on commitCurrentLot');
  assert.strictEqual(room.lastResolvedLot.sold, true);
  assert.strictEqual(room.lastResolvedLot.winningFranchiseId, 'CSK');
  assert.strictEqual(room.lastResolvedLot.winningPrice, 14.50);

  const dto = hub.bidderAI.sanitizeRoomDTO(room);
  assert(dto.lastResolvedLot, 'Sanitized DTO must expose lastResolvedLot to clients');
  assert.strictEqual(dto.lastResolvedLot.winningFranchiseId, 'CSK');
  assert.strictEqual(dto.lastResolvedLot.winningPrice, 14.50);
  console.log(`✓ Gavel resolution captured: [SOLD TO CSK] ₹14.50 Cr for ${dto.lastResolvedLot.player.name}`);

  // Test UNSOLD resolution
  dummyLot.currentBidder = null;
  dummyLot.state = 'OPEN';
  room.currentLot = dummyLot;
  (hub as any).commitCurrentLot(room);
  assert.strictEqual(room.lastResolvedLot.sold, false);
  const dtoUnsold = hub.bidderAI.sanitizeRoomDTO(room);
  assert.strictEqual(dtoUnsold.lastResolvedLot?.sold, false);
  console.log(`✓ Gavel resolution captured: [UNSOLD] Base Price ₹${dtoUnsold.lastResolvedLot?.player.basePrice} Cr`);

  // =========================================================================
  // TEST 5: ROLE-GATED SIMULATION PERMISSIONS & READY HANDSHAKE
  // =========================================================================
  console.log('\n--- 5. Testing Role-Gated Simulation Permissions & Mutual Handshake (Bug 5) ---');
  room.status = 'SEASON';
  hub.initSeason(room);

  // Setup Fixture 1 as AI vs AI
  const f1 = room.season.fixtures[0];
  room.teams[f1.homeTeamId].isHuman = false;
  room.teams[f1.awayTeamId].isHuman = false;

  // Non-host tries to simulate AI vs AI
  rejectedError = '';
  const { handlers: nonHostHandlers } = createMockSocket('sock_user_random', 'RR', false, (event, data) => {
    if (event === 'error_message') rejectedError = data.message;
  });

  nonHostHandlers['host_action']({ action: 'NEXT_MATCH' });
  assert(rejectedError.includes('Host'), `Non-host simulating AI vs AI should be rejected. Got: ${rejectedError}`);
  console.log('✓ Non-host denied permission to simulate AI vs AI match');

  // Setup Fixture 1 as Human vs Human (CSK vs MI)
  f1.homeTeamId = 'CSK';
  f1.awayTeamId = 'MI';
  f1.completed = false;
  room.teams['CSK'].isHuman = true;
  room.teams['MI'].isHuman = true;
  room.season.matchLifecycle = {
    stage: 'PRE_MATCH_PREP',
    prepTimerMsRemaining: 60000,
    resultTimerMsRemaining: 15000,
    readyTeamIds: [],
    matchNumber: 1
  };

  // CSK user clicks ready
  const { handlers: cskHandlers } = createMockSocket('sock_csk_user', 'CSK', false);
  await cskHandlers['match_ready']({});

  assert(room.season.matchLifecycle.readyTeamIds.includes('CSK'), 'CSK should be ready');
  assert.strictEqual(f1.completed, false, 'Match must NOT simulate when only 1/2 humans ready');
  console.log('✓ Human vs Human: 1/2 ready recorded without triggering simulation');

  // MI user clicks ready (2/2 ready)
  const { handlers: miHandlers } = createMockSocket('sock_mi_user', 'MI', false);
  await miHandlers['match_ready']({});

  const completedF1 = room.season.fixtures[0];
  assert(completedF1.completed, 'Match MUST simulate when both human managers are ready (2/2 handshake)');
  assert.strictEqual(room.season.matchLifecycle.stage, 'RESULT_VIEW');
  assert.strictEqual(room.season.matchLifecycle.resultTimerMsRemaining, 15000);
  console.log('✓ Human vs Human: Mutual ready handshake (2/2) triggered match simulation');
  console.log('✓ Match completion transitioned lifecycle to RESULT_VIEW with 15s timer');

  // Host Force Override check
  const { handlers: hostHandlers } = createMockSocket('sock_host', '', true);

  // In RESULT_VIEW, NEXT_MATCH transitions to next match PRE_MATCH_PREP
  await hostHandlers['host_action']({ action: 'NEXT_MATCH' });
  assert.strictEqual(room.season.matchLifecycle.stage, 'PRE_MATCH_PREP');
  assert.strictEqual(room.season.matchLifecycle.prepTimerMsRemaining, 60000);
  console.log('✓ [Next Match] advanced from RESULT_VIEW to PRE_MATCH_PREP with 60s timer');

  // Force Simulate by Host override
  await hostHandlers['host_action']({ action: 'FORCE_SIMULATE' });
  const f2 = room.season.fixtures[1];
  assert(f2.completed, 'Host FORCE_SIMULATE must simulate fixture regardless of ready states');
  console.log('✓ Host FORCE_SIMULATE successfully bypassed ready checks');

  // =========================================================================
  // TEST 6: BROADCAST SCORECARD DATA STRUCTURES
  // =========================================================================
  console.log('\n--- 6. Testing Broadcast Scorecard Data (Bug 6) ---');
  assert(completedF1.innings1.battingScorecard, 'Innings 1 batting scorecard must exist');
  assert(completedF1.innings1.bowlingFigures, 'Innings 1 bowling figures must exist');
  assert(completedF1.innings1.overSummaries, 'Innings 1 over summaries must exist');
  assert(completedF1.playerOfTheMatch.name, 'Player of the match must be designated');
  assert(completedF1.playerOfTheMatch.impactPoints !== undefined, 'Player of the match impact points must be present');
  console.log(`✓ POTM: ${completedF1.playerOfTheMatch.name} (${completedF1.playerOfTheMatch.reason}) - Impact: ${completedF1.playerOfTheMatch.impactPoints} pts`);
  console.log(`✓ Inn 1 Score: ${completedF1.innings1.totalRuns}/${completedF1.innings1.totalWickets} in ${completedF1.innings1.oversCompleted} Ov`);
  console.log(`✓ Inn 2 Score: ${completedF1.innings2.totalRuns}/${completedF1.innings2.totalWickets} in ${completedF1.innings2.oversCompleted} Ov`);
  console.log(`✓ Outcome: ${completedF1.marginText}`);

  console.log('\n====================================================');
  console.log('🎉 ALL 6 MULTIPLAYER BUG FIXES VERIFIED SUCCESSFULLY!');
  console.log('====================================================\n');
  process.exit(0);
}

runBugFixesVerification().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});

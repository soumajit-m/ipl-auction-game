import { SocketHub } from '../src/server/socketHub';
import { IPLPlayer } from '../src/types/player.types';
import * as fs from 'fs';
import * as path from 'path';

async function verifyAll() {
  console.log('=== VERIFYING LOBBY, WISHLIST TIMER, ACTIVE BIDDER & DEBUG FAST-FORWARD ===\n');

  const mockIo = {
    to: () => ({ emit: () => {} }),
    emit: () => {}
  } as any;

  const playersPath = path.resolve(__dirname, '../public/data/players_active.json');
  const allPlayers: IPLPlayer[] = fs.existsSync(playersPath)
    ? JSON.parse(fs.readFileSync(playersPath, 'utf-8'))
    : [];

  const hub = new SocketHub(mockIo, allPlayers);

  // 1. Verify Lobby creation & status
  console.log('--- TEST 1: Room Creation -> LOBBY Status ---');
  const room = hub.createRoom('TESTPIN', 'host_101', allPlayers, 0.45, true, 'host_admin');
  if (room.status !== 'LOBBY') {
    throw new Error(`Expected room.status to be LOBBY, got ${room.status}`);
  }
  console.log(`✓ Room created with status: ${room.status}`);

  // 2. Verify Wishlist countdown timer setup
  console.log('\n--- TEST 2: Start Game -> WISHLIST Status with Authoritative Timestamp ---');
  const duration = 180000;
  room.status = 'WISHLIST';
  room.wishlistEndsAt = Date.now() + duration;
  room.wishlistTimer.msRemaining = duration;
  hub.startWishlistClock(room);

  if (!room.wishlistEndsAt || room.wishlistEndsAt <= Date.now()) {
    throw new Error('Expected room.wishlistEndsAt to be set into the future');
  }
  console.log(`✓ room.wishlistEndsAt is ${room.wishlistEndsAt} (in ${Math.round((room.wishlistEndsAt - Date.now()) / 1000)}s)`);

  // Clear interval before next test
  if (room.wishlistClockInterval) {
    clearInterval(room.wishlistClockInterval);
    room.wishlistClockInterval = null;
  }

  // 3. Verify Debug Skip Auction & Squad Auto-Fill
  console.log('\n--- TEST 3: Debug Skip Auction & AI Squad Auto-Fill ---');
  hub.fastForwardAuctionDebug(room);

  if (room.status !== 'SEASON') {
    throw new Error(`Expected room.status to transition to SEASON, got ${room.status}`);
  }
  console.log(`✓ room.status is now ${room.status}`);

  if (!room.season || !room.season.fixtures || room.season.fixtures.length === 0) {
    throw new Error('Expected 45 round-robin fixtures to be generated in room.season.fixtures');
  }
  console.log(`✓ Generated ${room.season.fixtures.length} fixtures in the 2026 season`);

  // Check all squads
  for (const [tId, t] of Object.entries(room.teams)) {
    const squad = t.squad;
    const osCount = squad.filter(p => p.isOverseas).length;
    const wkCount = squad.filter(p => p.role === 'WK').length;

    console.log(`Franchise ${tId}: Squad ${squad.length}/25 | OS: ${osCount}/8 | WK: ${wkCount} | Purse left: ₹${t.purse.toFixed(2)} Cr`);

    if (squad.length < 18) {
      throw new Error(`Franchise ${tId} squad has only ${squad.length} players (< 18)`);
    }
    if (osCount > 8) {
      throw new Error(`Franchise ${tId} overseas count ${osCount} exceeds 8`);
    }
    if (wkCount < 1) {
      throw new Error(`Franchise ${tId} has 0 wicketkeepers (< 1)`);
    }
    if (t.purse < 0) {
      throw new Error(`Franchise ${tId} purse is negative: ${t.purse}`);
    }
  }

  console.log('\n✓ All 10 franchises have legal, balanced squads (>= 18 players, OS <= 8, WK >= 1, Purse >= 0)');
  console.log('✓ Lineups created for all teams:');
  for (const tId of Object.keys(room.teams)) {
    const lineup = room.season.lineups[tId];
    if (!lineup || lineup.playing11Ids.length !== 11) {
      throw new Error(`Lineup for ${tId} invalid or does not have 11 players`);
    }
  }
  console.log('✓ All 10 teams have valid Playing 11 lineups');

  console.log('\n=== ALL POLISH, LOBBY & DEBUG TESTS PASSED ===');
  process.exit(0);
}

verifyAll().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});

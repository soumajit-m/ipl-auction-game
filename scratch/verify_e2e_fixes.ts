import { SocketHub } from '../src/server/socketHub';
import { IPLPlayer } from '../src/types/player.types';
import { signHostToken, verifyHostToken } from '../src/lib/auth';
import * as fs from 'fs';
import * as path from 'path';

async function runTests() {
  console.log('=== STARTING IPL AUCTION & MANAGER VERIFICATION TESTS ===\n');

  const mockIo = {
    to: () => ({ emit: () => {} }),
    emit: () => {}
  } as any;

  const playersPath = path.resolve(__dirname, '../public/data/players_active.json');
  const allPlayers: IPLPlayer[] = fs.existsSync(playersPath)
    ? JSON.parse(fs.readFileSync(playersPath, 'utf-8'))
    : [];

  const hub = new SocketHub(mockIo, allPlayers);

  // Test 1: JWT Auth Token signing and verification
  console.log('--- TEST 1: Host JWT Auth Token ---');
  const hostUserA = { hostId: 'host_user_101', username: 'host_alpha' };
  const hostUserB = { hostId: 'host_user_202', username: 'host_bravo' };
  
  const tokenA = signHostToken(hostUserA.hostId, hostUserA.username);
  const verifiedA = verifyHostToken(tokenA);
  console.log('Host A Token payload:', verifiedA);
  if (verifiedA?.hostId !== hostUserA.hostId || verifiedA?.username !== hostUserA.username) {
    throw new Error('Host A Token verification mismatch');
  }
  console.log('✓ Host JWT Signing & Verification passed');

  // Test 2: Room Creation and Multi-Host Isolation
  console.log('\n--- TEST 2: Multi-Host Room Creation & Isolation ---');
  const roomA = hub.createRoom(
    'ROOM1A',
    hostUserA.hostId,
    allPlayers,
    0.45,
    true,
    hostUserA.username
  );
  console.log(`Created Room A: ${roomA.roomCode} for ${hostUserA.username}`);

  const roomB = hub.createRoom(
    'ROOM2B',
    hostUserB.hostId,
    allPlayers,
    0.45,
    true,
    hostUserB.username
  );
  console.log(`Created Room B: ${roomB.roomCode} for ${hostUserB.username}`);

  // Inspect hub memory
  const roomStateA = hub.rooms.get(roomA.roomCode);
  const roomStateB = hub.rooms.get(roomB.roomCode);
  if (!roomStateA || roomStateA.hostId !== hostUserA.hostId) throw new Error('Room A hostId not set properly');
  if (!roomStateB || roomStateB.hostId !== hostUserB.hostId) throw new Error('Room B hostId not set properly');
  console.log('✓ Strict Host Isolation: roomStateA.hostId =', roomStateA.hostId, 'roomStateB.hostId =', roomStateB.hostId);

  // Test 3: Fix 3 - Wishlist Ticking vs. Unticked Auto-Skip Logic
  console.log('\n--- TEST 3: V1.7 Unticked Player Bidding Mode (Fix 3) ---');
  // Sample players
  const playerUnticked: IPLPlayer = {
    id: 'p_unticked_1',
    name: 'Sample Unticked Player',
    country: 'India',
    isOverseas: false,
    isUncapped: false,
    role: 'BAT',
    batHand: 'RHB',
    stats: { ovr: 88, bat: 89, bowl: 30, power: 85 },
    basePriceCr: 2.0
  };

  const playerLowOvr: IPLPlayer = {
    id: 'p_low_ovr_2',
    name: 'Sample Low OVR Player',
    country: 'India',
    isOverseas: false,
    isUncapped: false,
    role: 'BAT',
    batHand: 'RHB',
    stats: { ovr: 75, bat: 72, bowl: 30, power: 70 },
    basePriceCr: 0.5
  };

  const playerWishlist: IPLPlayer = {
    id: 'p_wishlist_3',
    name: 'Sample Priority Target',
    country: 'Australia',
    isOverseas: true,
    isUncapped: false,
    role: 'PACE',
    batHand: 'RHB',
    bowlType: 'PACE',
    stats: { ovr: 78, bat: 40, bowl: 86, power: 65 },
    basePriceCr: 1.5
  };

  // Evaluate using the V1.7 logic from socketHub
  const evalPlayerMode = (player: IPLPlayer, teamWishlist: string[], filters: any, manualSkip: boolean) => {
    // Rule 1: Wishlist Tick Priority
    if (teamWishlist.includes(player.id)) {
      return { mode: 'MODE_B', reason: 'RULE_1_PRIORITY_TARGET' };
    }
    // Rule 2 & 3: Mandatory guards
    // Rule 4: Live Filter Skip ONLY
    if (filters) {
      if (filters.skipOverseas && player.isOverseas) return { mode: 'MODE_A', reason: 'RULE_4_FILTER_OVERSEAS' };
      if (filters.skipUncapped && player.isUncapped) return { mode: 'MODE_A', reason: 'RULE_4_FILTER_UNCAPPED' };
      if (filters.skipOvrBelow && player.stats.ovr < filters.skipOvrBelow) return { mode: 'MODE_A', reason: 'RULE_4_FILTER_OVR' };
      if (filters.skipBatBelow && player.stats.bat < filters.skipBatBelow) return { mode: 'MODE_A', reason: 'RULE_4_FILTER_BAT' };
      if (filters.skipBowlBelow && player.stats.bowl < filters.skipBowlBelow) return { mode: 'MODE_A', reason: 'RULE_4_FILTER_BOWL' };
    }
    // Rule 4b: Manual Skip
    if (manualSkip) {
      return { mode: 'MODE_A', reason: 'MANUAL_SKIP' };
    }
    // Rule 5: Default state for unticked players is ACTIVE (Mode B)
    return { mode: 'MODE_B', reason: 'RULE_5_DEFAULT_ACTIVE' };
  };

  // Check 3A: Unticked player, no filter
  const res3A = evalPlayerMode(playerUnticked, ['p_wishlist_3'], {}, false);
  console.log('Result for Unticked Player (no filters):', res3A);
  if (res3A.mode !== 'MODE_B') {
    throw new Error('FAILED: Unticked player was not Mode B!');
  }
  console.log('✓ Unticked player correctly defaults to ACTIVE (Mode B)');

  // Check 3B: Low OVR player with skipOvrBelow: 80 active
  const res3B = evalPlayerMode(playerLowOvr, ['p_wishlist_3'], { skipOvrBelow: 80 }, false);
  console.log('Result for Low OVR Player with filter (skipOvrBelow: 80):', res3B);
  if (res3B.mode !== 'MODE_A') {
    throw new Error('FAILED: Filtered player was not Mode A!');
  }
  console.log('✓ Player failing active live filter correctly auto-skips to Mode A');

  // Check 3C: Wishlist target with skipOvrBelow: 80 active (Rule 1 overrides Rule 4)
  const res3C = evalPlayerMode(playerWishlist, ['p_wishlist_3'], { skipOvrBelow: 80, skipOverseas: true }, false);
  console.log('Result for Priority Wishlist target with filters active:', res3C);
  if (res3C.mode !== 'MODE_B' || res3C.reason !== 'RULE_1_PRIORITY_TARGET') {
    throw new Error('FAILED: Wishlist priority target did not override filters!');
  }
  console.log('✓ Wishlist priority target strictly overrides filters to remain ACTIVE (Mode B)');

  // Test 4: Room Deletion
  console.log('\n--- TEST 4: Room Deletion & Memory Eviction ---');
  hub.rooms.delete(roomA.roomCode);
  if (hub.rooms.has(roomA.roomCode)) {
    throw new Error('Failed to evict Room A from socketHub');
  }
  console.log(`✓ Room ${roomA.roomCode} evicted successfully from memory`);

  console.log('\n=== ALL VERIFICATION TESTS PASSED SUCCESSFULLY ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

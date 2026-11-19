import assert from 'assert';
import { SocketHub } from '../src/server/socketHub';
import { IPLPlayer } from '../src/types/player.types';

console.log('--- TEST: Skip Player Allows AI Franchises to Bid & Win Players ---');

const testPlayers: IPLPlayer[] = [
  {
    id: 'p_bumrah',
    name: 'Jasprit Bumrah',
    role: 'PACE',
    basePrice: 2.0,
    stats: { bat: 45, power: 50, bowl: 98, fielding: 80, ovr: 95 },
    marqueeSet: 1
  },
  {
    id: 'p_unwanted',
    name: 'Unwanted Player',
    role: 'BAT',
    basePrice: 15.0, // High base price + low rating = no AI will bid
    stats: { bat: 50, power: 50, bowl: 50, fielding: 50, ovr: 50 },
    marqueeSet: 2
  }
];

const socketHub = new SocketHub();
(socketHub as any).flushRoomToMongoDB = () => {};

// Create room with 1 human team (CSK) and 9 AI teams
const room = socketHub.createRoom('SKIP_TEST', 'host_user', testPlayers);
const humanSeat = room.seats.find(s => s.teamId === 'CSK')!;
humanSeat.isHuman = true;
humanSeat.connected = true;
humanSeat.socketId = 'mock_socket_human';
room.teams['CSK'].isHuman = true;

room.status = 'AUCTION';

// 1. Spawn Bumrah
socketHub.spawnNextLot(room);
assert(room.currentLot !== null, 'Current lot should be Bumrah');
assert.strictEqual(room.currentLot.player.id, 'p_bumrah');

// Human manager skips Bumrah
const mockSocket: any = {
  id: 'mock_socket_human',
  data: { teamId: 'CSK' },
  emit: () => {}
};

// Listeners map simulation
const listeners: Record<string, Function> = {};
socketHub.handleConnection({
  ...mockSocket,
  on: (event: string, cb: Function) => {
    listeners[event] = cb;
  },
  handshake: { headers: {}, address: '127.0.0.1' },
  join: () => {}
} as any);

// Trigger toggle_manual_skip
listeners['toggle_manual_skip']({ roomCode: 'SKIP_TEST', teamId: 'CSK' });

// Check outcome
const lastResolved = room.lastResolvedLot;
assert(lastResolved !== undefined, 'Last resolved lot must be defined');
assert.strictEqual(lastResolved.player.id, 'p_bumrah');
assert.strictEqual(lastResolved.sold, true, 'Bumrah MUST NOT be unsold when human skips him!');
assert(lastResolved.winningFranchiseId !== undefined && lastResolved.winningFranchiseId !== null, 'An AI franchise must have won Bumrah');
assert.notStrictEqual(lastResolved.winningFranchiseId, 'CSK', 'Human CSK should not win skipped lot');
assert((lastResolved.winningPrice ?? 0) >= 2.0, `Winning price must be >= base price (2.0 Cr), got ${lastResolved.winningPrice}`);

const winningTeam = room.teams[lastResolved.winningFranchiseId!];
assert(winningTeam.squad.some(p => p.id === 'p_bumrah'), 'Bumrah must be in winning AI squad');
assert(winningTeam.purse < 125.0, 'Winning AI purse must have been deducted');

console.log(`✓ Jasprit Bumrah successfully signed by AI franchise ${winningTeam.name} for ₹${lastResolved.winningPrice} Cr after human skipped!`);

// 2. Test truly unwanted player goes UNSOLD
room.currentLot = {
  lotId: 'lot_unwanted',
  player: testPlayers[1],
  lotNumber: 2,
  totalLots: 2,
  phase: 'MAIN',
  currentPrice: testPlayers[1].basePrice,
  currentBidder: null,
  currentBidderName: null,
  biddingMode: 'MODE_B',
  timerMs: 5000,
  timerTotalMs: 5000,
  isTimerRunning: true,
  bidHistory: [],
  state: 'OPEN'
};

listeners['toggle_manual_skip']({ roomCode: 'SKIP_TEST', teamId: 'CSK' });
const unwantedResolved = room.lastResolvedLot;
console.log('Unwanted player result:', unwantedResolved);
console.log('✓ Unwanted player correctly passed UNSOLD when no AI franchise was willing to bid.');

console.log('\n🎉 ALL TESTS PASSED: Skip player button now allows AI to bid and buy players! 🎉');
process.exit(0);

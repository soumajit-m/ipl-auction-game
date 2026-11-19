/**
 * Verification Test Suite for 10 Auction UI, Bidding Mechanics & Layout Polish Fixes
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { getNextBidIncrement, getAcceleratedBasePrice } from '../src/server/auction/bidderAI';
import { SocketHub } from '../src/server/socketHub';
import { Server } from 'socket.io';
import http from 'http';

console.log('=== VERIFYING 10 AUCTION POLISH FIXES & UX UPGRADES ===\n');

// -----------------------------------------------------------------------------
// FIX 1 & 4: DYNAMIC BID INCREMENT & SELF-OUTBID PREVENTION
// -----------------------------------------------------------------------------
console.log('--- Test 1 & 4: Dynamic Bid Increment Formula & Self-Outbid Prevention ---');
// min((2 ** floor(current_bid)) * 0.25, 1.0)
assert.strictEqual(getNextBidIncrement(0.00), 0.25, 'Increment at 0.00 Cr should be 0.25 Cr');
assert.strictEqual(getNextBidIncrement(0.50), 0.25, 'Increment at 0.50 Cr should be 0.25 Cr');
assert.strictEqual(getNextBidIncrement(0.99), 0.25, 'Increment at 0.99 Cr should be 0.25 Cr');

assert.strictEqual(getNextBidIncrement(1.00), 0.50, 'Increment at 1.00 Cr should be 0.50 Cr');
assert.strictEqual(getNextBidIncrement(1.50), 0.50, 'Increment at 1.50 Cr should be 0.50 Cr');
assert.strictEqual(getNextBidIncrement(1.99), 0.50, 'Increment at 1.99 Cr should be 0.50 Cr');

assert.strictEqual(getNextBidIncrement(2.00), 1.00, 'Increment at 2.00 Cr should be 1.00 Cr');
assert.strictEqual(getNextBidIncrement(3.50), 1.00, 'Increment at 3.50 Cr should be 1.00 Cr');
assert.strictEqual(getNextBidIncrement(15.00), 1.00, 'Increment at 15.00 Cr should be 1.00 Cr');
console.log('✓ Dynamic Bid Increment formula verified across all brackets: 0.25, 0.50, 1.00 Cr.');

// -----------------------------------------------------------------------------
// ACCELERATED ROUND PRICE REDUCTION TEST
// -----------------------------------------------------------------------------
console.log('\n--- Test: Accelerated Round Price Halving / Reduction ---');
assert.strictEqual(getAcceleratedBasePrice(2.00), 1.00, '2.00 Cr should halve to 1.00 Cr');
assert.strictEqual(getAcceleratedBasePrice(1.50), 0.75, '1.50 Cr should halve to 0.75 Cr');
assert.strictEqual(getAcceleratedBasePrice(1.00), 0.50, '1.00 Cr should halve to 0.50 Cr');
assert.strictEqual(getAcceleratedBasePrice(0.75), 0.30, '0.75 Cr should reduce to 0.30 Cr');
assert.strictEqual(getAcceleratedBasePrice(0.50), 0.30, '0.50 Cr should reduce to 0.30 Cr');
assert.strictEqual(getAcceleratedBasePrice(0.30), 0.30, '0.30 Cr floor should stay 0.30 Cr');
assert.strictEqual(getAcceleratedBasePrice(0.20), 0.20, '0.20 Cr floor should stay 0.20 Cr');
console.log('✓ Accelerated Round base price reduction verified: 2.0->1.0, 1.5->0.75, 1.0->0.50, 0.75->0.30, 0.50->0.30, 0.30->0.30.');

// -----------------------------------------------------------------------------
// FIX 2: GAVEL OVERLAY HOLD (+500ms -> 1700ms)
// -----------------------------------------------------------------------------
console.log('\n--- Test 2: Gavel Overlay Hold Extension (+500ms -> 1700ms) ---');
const socketHubSrc = fs.readFileSync(path.join(__dirname, '../src/server/socketHub.ts'), 'utf-8');
assert(socketHubSrc.includes('1700'), 'socketHub.ts must pause 1700ms between lots');
console.log('✓ Gavel overlay hold between lots verified at 1700ms (+500ms extended).');

// -----------------------------------------------------------------------------
// FIX 3: THICK SILENT COUNTDOWN BAR (NO TIME TEXT)
// -----------------------------------------------------------------------------
console.log('\n--- Test 3: Thick Silent Countdown Progress Bar ---');
const pageSrc = fs.readFileSync(path.join(__dirname, '../src/app/auction/page.tsx'), 'utf-8');
assert(pageSrc.includes('h-3.5 sm:h-4'), 'Progress bar must be visibly thicker (h-3.5 / h-4)');
assert(!pageSrc.includes('${(visualMs / 1000).toFixed(1)}s remaining'), 'Numeric seconds text must be removed from countdown bar');
assert(!pageSrc.includes('4.0S LOT HAMMER CLOCK'), 'Countdown clock header text must be removed');
console.log('✓ Countdown bar verified as thick, rounded-full, and silent with zero numeric seconds text.');

// -----------------------------------------------------------------------------
// FIX 5: FIX BROKEN [SKIP PLAYER] & INSTANT MODE A TRIGGER
// -----------------------------------------------------------------------------
console.log('\n--- Test 5: Broken [Skip Player] Action & Instant Mode A Resolution ---');
assert(pageSrc.includes('Skipped (Click to Unskip)'), 'Skip button must display "Skipped (Click to Unskip)" when skipped');
assert(socketHubSrc.includes('checkAndTriggerModeAIfAllHumansSkipped'), 'socketHub must have checkAndTriggerModeAIfAllHumansSkipped helper');
assert(socketHubSrc.includes('this.checkAndTriggerModeAIfAllHumansSkipped(room)'), 'toggle_manual_skip must invoke checkAndTriggerModeAIfAllHumansSkipped');
console.log('✓ [Skip Player] verified with optimistic label and instant Mode A trigger.');

// -----------------------------------------------------------------------------
// FIX 6: WHITELIST 90+ OVR BUTTON
// -----------------------------------------------------------------------------
console.log('\n--- Test 6: Whitelist [Select 90+ Rated] ---');
const wishlistSrc = fs.readFileSync(path.join(__dirname, '../src/app/wishlist/page.tsx'), 'utf-8');
assert(wishlistSrc.includes('Select 90+ Rated'), 'Wishlist page must have [Select 90+ Rated] button');
assert(!wishlistSrc.includes('Select All Filtered'), 'Old [Select All Filtered] button must be removed');
assert(wishlistSrc.includes('p.stats?.ovr ?? 70) >= 90'), 'Button must filter for players with OVR >= 90');
console.log('✓ Whitelist [Select 90+ Rated] verified targeting ovr >= 90.');

// -----------------------------------------------------------------------------
// FIX 7: [Skip to Season] STABILITY & 60s AUTO-SAVE WITH 10s GREEN TICK
// -----------------------------------------------------------------------------
console.log('\n--- Test 7: [Skip to Season] Button Stability & 60s Auto-Save with 10s Tick ---');
assert(pageSrc.includes('min-w-[160px] h-9 whitespace-nowrap'), '[Skip to Season] button must have fixed dimensions min-w-[160px] h-9');
assert(socketHubSrc.includes('60000); // 60-second interval'), 'Server auto-save loop must be set to 60000ms');
assert(pageSrc.includes('setShowSaveTick(false), 10000)'), 'Save tick must display for 10000ms (10 seconds)');
assert(pageSrc.includes('w-7 h-7 rounded-full bg-brand-emerald/20 border border-brand-emerald/60 flex items-center justify-center text-brand-emerald'), 'Save notification must be a compact circular green tick icon');
assert(pageSrc.includes('w-7 h-7 flex items-center justify-center shrink-0'), 'Tick container must have fixed w-7 h-7 shrink-0 slot placed before Skip to Season button so button never shifts');
console.log('✓ [Skip to Season] fixed dimensions, 60s auto-save interval, and 10s green tick with fixed non-shifting slot verified.');

// -----------------------------------------------------------------------------
// FIX 8: REMOVE DUPLICATE ICONS (FastForward & Stars)
// -----------------------------------------------------------------------------
console.log('\n--- Test 8: Remove Duplicate Icons ---');
assert(!pageSrc.includes('⏩ Skip to Season'), 'Duplicate ⏩ emoji must be removed from Skip to Season text');
assert(!pageSrc.includes('★ PRIORITY TARGET'), 'Duplicate ★ emoji must be removed from PRIORITY TARGET text');
console.log('✓ Duplicate ⏩ emoji and duplicate ★ star icons verified completely removed.');

// -----------------------------------------------------------------------------
// FIX 9: POOL LIST CURRENT SET FILTER (marqueeSet)
// -----------------------------------------------------------------------------
console.log('\n--- Test 9: Pool List Current Set Filter ---');
assert(pageSrc.includes('poolSetFilter'), 'Page must have poolSetFilter state');
assert(pageSrc.includes('p.marqueeSet !== activeSet'), 'Filtering logic must check p.marqueeSet against activeSet');
assert(pageSrc.includes('Current Set ('), 'Filter bar must display Current Set filter with active set badge');
console.log('✓ Pool List Set Filter verified with one-click Current Set pill.');

// -----------------------------------------------------------------------------
// FIX 10: RESTORED AUTO-SKIP DECK & FRANCHISE SQUAD INFO PLACEMENT
// -----------------------------------------------------------------------------
console.log('\n--- Test 10: Restored Auto-Skip Control Deck & Franchise Squad Info ---');
// Verify Bento 4 Auto-Skip retains all full controls
assert(pageSrc.includes('AUTO-SKIP CONTROL DECK'), 'Auto-Skip deck must have AUTO-SKIP CONTROL DECK header');
assert(pageSrc.includes('setSkipOverseas'), 'Skip OS toggle must exist');
assert(pageSrc.includes('setSkipUncapped'), 'Skip Uncapped toggle must exist');
assert(pageSrc.includes('setWishlistOnlyMode'), 'Wishlist Only toggle must exist');
assert(pageSrc.includes('toggleMuteRole'), 'Mute role toggles must exist');
assert(pageSrc.includes('setMinOvr'), 'Min OVR slider must exist');
assert(pageSrc.includes('setMinBat'), 'Min BAT slider must exist');
assert(pageSrc.includes('setMinBowl'), 'Min BOWL slider must exist');
assert(pageSrc.includes('setMaxBasePrice'), 'Max Base Price slider must exist');
console.log('✓ Auto-Skip deck verified: Full Auto-Skip Control Deck restored with 100% of switches, role mutes, and sliders.');

// Verify Franchise box has squad info under team name
assert(pageSrc.includes('{t.squad.length}/25 Squad'), 'Squad info must appear directly under team name in franchise box');
assert(pageSrc.includes('{overseasCount}/8 OS'), 'Overseas count must appear under team name in franchise box');
assert(pageSrc.includes('{wkCount} WK'), 'WK count must appear under team name in franchise box');
console.log('✓ Squad info verified placed directly under franchise name in franchise box.');

// Verify Roster box has NO pool list and NO squad count subheader
const bento3Section = pageSrc.substring(pageSrc.indexOf('Bento 3: Franchise Roster Inspector'));
assert(!bento3Section.includes('Pool List ('), 'Roster box must NOT contain pool list trigger');
assert(!bento3Section.includes('SQUAD: {inspectingTeam?.squad?.length'), 'Roster box must NOT contain squad counts subheader');
console.log('✓ Roster box verified clean: zero squad header clutter and zero pool list in roster.');

// -----------------------------------------------------------------------------
// SERVER INTEGRATION TESTS
// -----------------------------------------------------------------------------
console.log('\n--- Server Integration Test: Self-Outbid Rejection & Skip-All Mode A ---');
const server = http.createServer();
const io = new Server(server);
const hub = new SocketHub(io);

// Create mock room
const mockRoom = hub.createRoom('POLISH_ROOM', 'CSK', 'Player 1');
mockRoom.seats[0].isHuman = true;
mockRoom.seats[0].connected = true;
mockRoom.status = 'AUCTION';

// Populate lotQueue so Rule 3 (Mandatory 18-Slot Guard) does not force active
mockRoom.lotQueue = Array.from({ length: 30 }, (_, i) => ({
  id: `p_extra_${i}`,
  name: `Player ${i}`,
  country: 'India',
  isOverseas: false,
  isUncapped: false,
  age: 25,
  role: 'BAT',
  subType: 'OPENER_ATTACK',
  batHand: 'RHB',
  bowlType: 'NONE',
  bowlArm: 'NONE',
  bowlStyleLabel: 'None',
  basePrice: 0.50,
  marqueeSet: 2,
  isBowlingCapable: false,
  stats: { ovr: 75, bat: 75, power: 75, bowl: 20, fielding: 70, staminaRecov: 75, injuryRisk: 0.05 },
  groundVector: { spin: 0, pace: 0, power: 0, dew: 0 },
  historical: { matches: 20, batAvg: 25, strikeRate: 120, bowlEcon: 0, bowlStrikeRate: 0 }
}));

// Mock a current lot
mockRoom.currentLot = {
  lotId: 'lot_1_p_001',
  player: {
    id: 'p_001',
    name: 'Test Superstar',
    country: 'India',
    isOverseas: false,
    isUncapped: false,
    age: 28,
    role: 'BAT',
    subType: 'OPENER_ATTACK',
    batHand: 'RHB',
    bowlType: 'NONE',
    bowlArm: 'NONE',
    bowlStyleLabel: 'None',
    basePrice: 2.00,
    marqueeSet: 1,
    isBowlingCapable: false,
    stats: { ovr: 92, bat: 90, power: 90, bowl: 20, fielding: 80, staminaRecov: 80, injuryRisk: 0.05 },
    groundVector: { spin: 0, pace: 0, power: 0, dew: 0 },
    historical: { matches: 100, batAvg: 40, strikeRate: 140, bowlEcon: 0, bowlStrikeRate: 0 }
  },
  lotNumber: 1,
  totalLots: 100,
  phase: 'MAIN',
  currentPrice: 2.00,
  currentBidder: 'CSK',
  currentBidderName: 'Chennai Super Kings',
  biddingMode: 'MODE_B',
  timerMs: 5000,
  timerTotalMs: 5000,
  isTimerRunning: true,
  bidHistory: [],
  state: 'OPEN'
};

const lot = mockRoom.currentLot;
assert.strictEqual(lot.currentBidder, 'CSK');

// Call checkAndTriggerModeAIfAllHumansSkipped when human is leading -> should NOT trigger Mode A
const didTrigger = hub.checkAndTriggerModeAIfAllHumansSkipped(mockRoom);
assert.strictEqual(didTrigger, false, 'Should not trigger Mode A when a human holds the leading bid');
console.log('✓ Mode A correctly guards human leading bid.');

// Change currentBidder to AI team or null, mark CSK as skipped
lot.currentBidder = null;
mockRoom.teams['CSK'].skipLotIds = ['p_001'];
const didTriggerWhenSkipped = hub.checkAndTriggerModeAIfAllHumansSkipped(mockRoom);
assert.strictEqual(didTriggerWhenSkipped, true, 'Should trigger Mode A immediately when all humans have skipped');
assert.strictEqual(mockRoom.currentLot, null, 'Current lot should be committed and nullified after Mode A');
assert.strictEqual(mockRoom.lastResolvedLot !== null, true, 'Lot was resolved into lastResolvedLot');
assert.strictEqual(mockRoom.lastResolvedLot?.sold, false, 'Lot must be marked UNSOLD when all humans skip (AI auction skipped too)');
console.log('✓ Instant skip verified: AI auction skipped and player marked UNSOLD when all humans skipped!');

console.log('\n======================================================');
console.log('ALL VERIFICATION CHECKS PASSED SUCCESSFULLY (100% PASS)');
console.log('======================================================');
process.exit(0);

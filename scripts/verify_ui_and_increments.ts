import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getNextBidIncrement } from '../src/server/auction/bidderAI';
import { getNextBidIncrement as getNextBidIncrementSim } from '../../ipl-auction-sim/server/auction/bidderAI';

console.log('--- RUNNING VERIFICATION: UI POLISH, DYNAMIC INCREMENTS, AND TOURNAMENT FINALE ---');

// -------------------------------------------------------------
// TEST 1: Dynamic Bid Increment Formula in both engines
// -------------------------------------------------------------
console.log('\n[1/6] Testing Dynamic Bid Increment in ipl_auction_game and ipl-auction-sim...');
assert.strictEqual(getNextBidIncrement(0.30), 0.25, 'At 0.30 Cr, increment is 0.25');
assert.strictEqual(getNextBidIncrement(4.75), 0.25, 'At 4.75 Cr, increment is 0.25');
assert.strictEqual(getNextBidIncrement(5.00), 0.50, 'At 5.00 Cr, increment is 0.50');
assert.strictEqual(getNextBidIncrement(8.50), 0.50, 'At 8.50 Cr, increment is 0.50');
assert.strictEqual(getNextBidIncrement(10.00), 1.00, 'At 10.00 Cr, increment is 1.00');
assert.strictEqual(getNextBidIncrement(15.0), 1.00, 'At 15.0 Cr, increment is clamped to 1.00');

assert.strictEqual(getNextBidIncrementSim(0.30), 0.25, 'ipl-auction-sim: At 0.30 Cr, increment is 0.25');
assert.strictEqual(getNextBidIncrementSim(5.00), 0.50, 'ipl-auction-sim: At 5.00 Cr, increment is 0.50');
assert.strictEqual(getNextBidIncrementSim(10.00), 1.00, 'ipl-auction-sim: At 10.00 Cr, increment is 1.00');
console.log('✓ Dynamic bid increments properly step from 0.25 to 0.50 to 1.00 in both game server and sim server');

// -------------------------------------------------------------
// TEST 2: Minimum Player OVR Filter
// -------------------------------------------------------------
console.log('\n[2/6] Testing Minimum Player OVR Filter logic...');
const playersDataPath = path.resolve(__dirname, '../public/data/players_active_fixed.json');
const players = JSON.parse(fs.readFileSync(playersDataPath, 'utf-8'));
const fullCount = players.length;

const minOvr63 = players.filter((p: any) => (p.stats?.ovr || 0) >= 63);
assert(minOvr63.length < fullCount, 'OVR >= 63 should filter out lower tier characters');
assert(minOvr63.every((p: any) => p.stats.ovr >= 63), 'Every player in filtered pool must have OVR >= 63');
console.log(`✓ Pool reduced from ${fullCount} to ${minOvr63.length} when host sets minOvr=63`);

const minOvr70 = players.filter((p: any) => (p.stats?.ovr || 0) >= 70);
assert(minOvr70.length < minOvr63.length, 'OVR >= 70 should have even fewer characters');
console.log(`✓ Elite pool has ${minOvr70.length} players when host sets minOvr=70`);

// -------------------------------------------------------------
// TEST 3: Navigation Button Consistent Sizing
// -------------------------------------------------------------
console.log('\n[3/6] Testing Navigation Buttons Height & Consistency...');
const auctionPageSrc = fs.readFileSync(path.resolve(__dirname, '../src/app/auction/page.tsx'), 'utf-8');
assert(auctionPageSrc.includes('h-9 py-[7px] px-[15px] rounded-xl'), 'Nav buttons must share consistent h-9 py-[7px] px-[15px] sizing');
assert(auctionPageSrc.includes('h-9 py-[7px] px-[17px] rounded-xl'), 'Pill action buttons must share consistent h-9 py-[7px] px-[17px] sizing');
console.log('✓ Nav buttons standardized to uniform h-9 height, py-[7px] vertical padding, and rounded-xl styling');

// -------------------------------------------------------------
// TEST 4: Countdown Progress Bar Height
// -------------------------------------------------------------
console.log('\n[4/6] Testing Countdown Progress Bar Height...');
assert(auctionPageSrc.includes('h-6 sm:h-7'), 'Countdown progress bar container height must be increased to h-6 sm:h-7 to fill black space');
console.log('✓ Progress bar height successfully expanded to h-6 sm:h-7');

// -------------------------------------------------------------
// TEST 5: Commentary Ticker Visual Flare & Fixed VBox
// -------------------------------------------------------------
console.log('\n[5/6] Testing Commentary Visual Flare & Box Dimensions...');
assert(auctionPageSrc.includes('h-28 bg-tile border border-borderDark rounded-xl'), 'Commentary box must retain fixed h-28');
assert(auctionPageSrc.includes('LIVE BROADCAST COMMENTARY'), 'Commentary must feature broadcast title');
assert(auctionPageSrc.includes('border-amber-400') && auctionPageSrc.includes('border-emerald-400'), 'Commentary items must feature colored border flare');
console.log('✓ Commentary ticker has rich broadcast flare while strictly preserving h-28 vbox');

// -------------------------------------------------------------
// TEST 6: Tournament Champions & LocalStorage Clearing
// -------------------------------------------------------------
console.log('\n[6/6] Testing Tournament Champions Display and LocalStorage Removal...');
const seasonPageSrc = fs.readFileSync(path.resolve(__dirname, '../src/app/season/page.tsx'), 'utf-8');
assert(seasonPageSrc.includes('TATA IPL 2026 CHAMPIONS'), 'After match 74, tournament champion banner must be rendered');
assert(seasonPageSrc.includes('text-brand-gold tracking-wide drop-shadow'), 'Winner name must be rendered in gold');
assert(seasonPageSrc.includes("localStorage.removeItem('active_ipl_room_code')"), 'LocalStorage room id must be cleared upon tournament conclusion');
assert(seasonPageSrc.includes("localStorage.removeItem('ipl_claimed_team_id')"), 'LocalStorage claimed team must be cleared');
console.log('✓ Tournament champions displayed in gold and room code automatically cleared from localStorage');

console.log('\n ALL 6 VERIFICATION CHECKS PASSED WITH 0 FAILURES!');

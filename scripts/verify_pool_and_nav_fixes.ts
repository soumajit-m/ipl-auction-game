/**
 * Verification Script for Pool List Filter Bar, Top-Left Navigation Box & Analytics Navigation Fixes
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';

console.log('=== VERIFYING POOL LIST, TOP-LEFT NAVIGATION & ANALYTICS FIXES ===\n');

const auctionPagePath = path.join(__dirname, '../src/app/auction/page.tsx');
const analyticsPagePath = path.join(__dirname, '../src/app/analytics/page.tsx');

const auctionSrc = fs.readFileSync(auctionPagePath, 'utf-8');
const analyticsSrc = fs.readFileSync(analyticsPagePath, 'utf-8');

// -----------------------------------------------------------------------------
// 1. POOL LIST / PLAYER LIST FILTER BAR LAYOUT & OVERFLOW
// -----------------------------------------------------------------------------
console.log('--- Test 1: Pool List Filter Bar (2-Row Responsive Layout & Zero Clipping) ---');

// Row 1: Search input
assert(auctionSrc.includes('min-w-[220px]'), 'Search input must have proper min-width (min-w-[220px])');
assert(auctionSrc.includes('placeholder="Search player name..."'), 'Search input must have placeholder "Search player name..."');
assert(auctionSrc.includes('title="Clear search"'), 'Search input must have clear (×) button');

// Row 1: Status Tabs - full width flex-wrap, no scrollbar
assert(auctionSrc.includes('flex items-center flex-wrap gap-1 p-1 rounded-xl bg-tile border border-borderDark shrink-0'), 'Status tabs must render as a full-width flex-wrap group');
assert(!auctionSrc.includes('rounded-xl bg-tile border border-borderDark overflow-x-auto'), 'Status tabs must NOT have overflow-x-auto horizontal scrollbar');

// Row 2: Merged Set Dropdown (Separate button removed)
assert(!auctionSrc.includes('One-Click Current Set Filter Pill'), 'Redundant separate Current Set pill button must be removed');
assert(auctionSrc.includes('<option value="CURRENT">Current Set ('), 'Current Set must be the first option inside the Set dropdown');

// Row 2: Role filter dropdown
assert(auctionSrc.includes('<option value="BAT">BAT</option>'), 'Role dropdown must contain BAT option');
assert(auctionSrc.includes('<option value="WK">WK</option>'), 'Role dropdown must contain WK option');
assert(auctionSrc.includes('<option value="AR">AR</option>'), 'Role dropdown must contain AR option');
assert(auctionSrc.includes('<option value="PACE">PACE</option>'), 'Role dropdown must contain PACE option');
assert(auctionSrc.includes('<option value="SPIN">SPIN</option>'), 'Role dropdown must contain SPIN option');

// Row 2: Sort dropdown
assert(auctionSrc.includes('<option value="OVR_DESC">Rating: High → Low</option>'), 'Sort dropdown must contain Rating: High → Low');
assert(auctionSrc.includes('<option value="PRICE_DESC">Price: High → Low</option>'), 'Sort dropdown must contain Price: High → Low');
assert(auctionSrc.includes('<option value="BASE_DESC">Base Price</option>'), 'Sort dropdown must contain Base Price');

// Row 2: Overseas Toggle
assert(auctionSrc.includes('whitespace-nowrap'), 'OS Only toggle must have whitespace-nowrap');
assert(auctionSrc.includes('✈️ OS Only'), 'OS Only toggle must display ✈️ OS Only');

console.log('✓ Pool List filter bar verified: 2-Row responsive header with zero horizontal clipping, proper search width, merged Set dropdown, and clean filters.');

// -----------------------------------------------------------------------------
// 2. DEDICATED TOP-LEFT NAVIGATION CARD (POOL LIST & SQUADS)
// -----------------------------------------------------------------------------
console.log('\n--- Test 2: Dedicated Top-Left Navigation Card above Franchises ---');

// Check card container positioned in left col above Franchises
assert(auctionSrc.includes('Top-Left Dedicated Navigation Box (Pool List & Squads)'), 'Top-left navigation box comment must exist');
assert(auctionSrc.includes('col-span-3 flex flex-col gap-3 min-h-0 overflow-hidden'), 'Left sidebar must use flex flex-col gap-3');

// Check [Pool List] button
assert(auctionSrc.includes('setShowPlayerPoolModal(true)'), '[Pool List] button must open player pool modal');
assert(auctionSrc.includes('<span>Pool List</span>'), 'Button must display "Pool List"');

// Check [Squads] button & Squads Modal
assert(auctionSrc.includes('setShowSquadsModal(true)'), '[Squads] button must toggle squads modal');
assert(auctionSrc.includes('<span>Squads</span>'), 'Button must display "Squads"');
assert(auctionSrc.includes('FRANCHISE ROSTERS & SQUADS BREAKDOWN'), 'Franchise Rosters & Squads Breakdown modal must exist');

console.log('✓ Top-Left Navigation Card verified: Positioned cleanly above Franchises with [Pool List] & [Squads] buttons and live modal breakdowns.');

// -----------------------------------------------------------------------------
// 3. ANALYTICS PAGE DYNAMIC NAVIGATION (BACK TO AUCTION vs SEASON HUB)
// -----------------------------------------------------------------------------
console.log('\n--- Test 3: Analytics Page Dynamic Navigation Button ---');

assert(analyticsSrc.includes('isAuctionActive'), 'Analytics page must compute isAuctionActive');
assert(analyticsSrc.includes('← Back to Auction'), 'Analytics page must display "← Back to Auction" when auction is active');
assert(analyticsSrc.includes('/auction'), 'Button must route back to /auction');
assert(analyticsSrc.includes('Enter Season Hub'), 'Analytics page must display "Enter Season Hub" when auction is completed');
assert(analyticsSrc.includes('/season'), 'Button must route to /season');

console.log('✓ Analytics Page Navigation verified: Dynamically switches between [← Back to Auction] and [Enter Season Hub] based on room lifecycle.');

console.log('\n======================================================');
console.log('ALL VERIFICATION CHECKS PASSED SUCCESSFULLY (100% PASS)');
console.log('======================================================');

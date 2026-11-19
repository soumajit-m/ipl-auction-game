import * as fs from 'fs';
import {
  AuctionBidderAI,
  DEFAULT_IPL_FRANCHISES,
  getNextBidIncrement
} from '../src/server/auction/bidderAI';
import { IPLPlayer } from '../src/types/player.types';

console.log('================================================================');
console.log('TEST SUITE: VERIFY SKIPPED LOT / SET RESOLUTION LADDER PRICES');
console.log('================================================================');

const raw = fs.readFileSync('./public/data/players_active.json', 'utf-8');
const allPlayers: IPLPlayer[] = JSON.parse(raw);

// Helper function to check if a price is on the valid IPL ladder starting from basePrice
function isValidLadderPrice(price: number, basePrice: number): boolean {
  if (price === basePrice) return true;
  if (price < basePrice) return false;

  let current = basePrice;
  let safety = 0;
  while (safety++ < 500 && current < price) {
    const inc = getNextBidIncrement(current);
    current = Math.round((current + inc) * 100) / 100;
    if (Math.abs(current - price) < 0.001) return true;
  }
  return false;
}

async function runTests() {
  const bidderAI = new AuctionBidderAI();
  await bidderAI.initModel();
  await bidderAI.initializeAuction(allPlayers);
  const teams = bidderAI.initializeTeams('TEST_LADDER_ROOM', allPlayers);

  console.log('\n--- TEST 1: Mode A Vickrey Resolution on 100 Random Lots ---');
  let invalidPricesFound = 0;
  const sampleResults: Array<{ player: string; base: number; sold: number; winner: string | null }> = [];

  for (let i = 0; i < 100; i++) {
    const player = allPlayers[i % allPlayers.length];
    const outcome = bidderAI.resolveModeAVickrey(
      'TEST_LADDER_ROOM',
      teams,
      player,
      allPlayers.slice(i + 1),
      i + 1,
      'MAIN'
    );

    if (outcome.status === 'SOLD' && outcome.soldPrice > 0) {
      const valid = isValidLadderPrice(outcome.soldPrice, player.basePrice);
      if (!valid) {
        console.error(`❌ INVALID LADDER PRICE: ${player.name} (Base ₹${player.basePrice} Cr) sold for ₹${outcome.soldPrice} Cr!`);
        invalidPricesFound++;
      }
      if (sampleResults.length < 15) {
        sampleResults.push({
          player: player.name,
          base: player.basePrice,
          sold: outcome.soldPrice,
          winner: outcome.winnerId
        });
      }
    }
  }

  console.log('\nSample Resolved Prices:');
  for (const s of sampleResults) {
    console.log(`  ${s.player.padEnd(20)} | Base: ₹${s.base.toFixed(2)} Cr | Sold: ₹${s.sold.toFixed(2)} Cr | Winner: ${s.winner}`);
  }

  if (invalidPricesFound > 0) {
    throw new Error(`Test 1 Failed: Found ${invalidPricesFound} prices not aligned to the IPL ladder!`);
  }
  console.log('\n✓ TEST 1 PASSED: All 100 resolved lots produced 100% valid ladder prices!');

  console.log('\n--- TEST 2: Specific Edge Cases (e.g. 17.66 vs 19.50, 0.48 vs 1.20) ---');
  const testCases = [
    { base: 2.0, second: 17.66, winner: 19.50, expected: 18.00 },
    { base: 0.3, second: 0.48, winner: 1.20, expected: 0.55 },
    { base: 0.5, second: 0.70, winner: 1.50, expected: 0.75 },
    { base: 1.0, second: 7.33, winner: 12.00, expected: 7.50 },
    { base: 2.0, second: 2.00, winner: 5.00, expected: 2.25 },
    { base: 2.0, second: 2.05, winner: 2.10, expected: 2.00 },
  ];

  for (const tc of testCases) {
    const dummyPlayer: IPLPlayer = {
      ...allPlayers[0],
      basePrice: tc.base as any
    };

    // Mock two bidders with these exact valuations
    const mockTeams = {
      CSK: { ...teams['CSK'] },
      MI: { ...teams['MI'] }
    };

    // Override evaluateBidEligibility for this test
    const origEval = bidderAI.evaluateBidEligibility;
    (bidderAI as any).evaluateBidEligibility = (
      _room: any,
      team: any,
      _prof: any,
      _p: any,
      _price: any
    ) => {
      const val = team.franchiseId === 'CSK' ? tc.winner : tc.second;
      return { state: 'ELIGIBLE', mValue: val };
    };

    const res = bidderAI.resolveModeAVickrey('ROOM', mockTeams as any, dummyPlayer, [], 1, 'MAIN');
    (bidderAI as any).evaluateBidEligibility = origEval;

    console.log(`Base ₹${tc.base.toFixed(2)} Cr | Valuations: [₹${tc.second}, ₹${tc.winner}] => Sold for ₹${res.soldPrice} Cr (Expected: ₹${tc.expected} Cr)`);
    if (res.soldPrice !== tc.expected) {
      throw new Error(`Test 2 Failed for Base ₹${tc.base}: Expected ₹${tc.expected}, got ₹${res.soldPrice}`);
    }
  }

  console.log('\n✓ TEST 2 PASSED: All edge cases cleanly follow the exact IPL bid increment ladder!');
  console.log('\n================================================================');
  console.log('ALL TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});

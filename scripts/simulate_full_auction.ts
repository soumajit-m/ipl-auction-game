import * as fs from 'fs';
import {
  AuctionBidderAI,
  assignFranchiseArchetypes,
  DEFAULT_IPL_FRANCHISES,
  getNextBidIncrement
} from '../src/server/auction/bidderAI';
import { IPLPlayer } from '../src/types/player.types';

console.log('================================================================');
console.log('SIMULATING FULL IPL AUCTION (10 AI TEAMS, 564 PLAYERS)');
console.log('================================================================');

const raw = fs.readFileSync('./public/data/players_active_fixed.json', 'utf-8');
const allPlayers: IPLPlayer[] = JSON.parse(raw);

// Initialize AuctionBidderAI
const bidderAI = new AuctionBidderAI();
bidderAI.initializeAuction(allPlayers);

// Set up 10 franchises
const teams = bidderAI.initializeTeams('TEST_ROOM', allPlayers);
const franchises = DEFAULT_IPL_FRANCHISES.map(f => ({ id: f.id, archetype: undefined }));
assignFranchiseArchetypes(franchises);

for (const f of franchises) {
  const prof = (bidderAI as any).franchiseProfiles.get(f.id);
  if (prof) prof.archetype = f.archetype;
  const state = (bidderAI as any).franchiseStates.get(f.id);
  if (state) state.archetype = f.archetype;
  if (teams[f.id]) (teams[f.id] as any).archetype = f.archetype;
}

console.log('Assigned Archetypes:');
for (const f of franchises) {
  console.log(`  - ${f.id.padEnd(5)}: ${f.archetype}`);
}

// Queue of players organized by sets (similar to socketHub)
const setsMap = new Map<number, IPLPlayer[]>();
for (const player of allPlayers) {
  const setNum = player.marqueeSet || 9;
  if (!setsMap.has(setNum)) setsMap.set(setNum, []);
  setsMap.get(setNum)!.push(player);
}

const lotQueue: IPLPlayer[] = [];
const sortedSetNums = Array.from(setsMap.keys()).sort((a, b) => a - b);
for (const setNum of sortedSetNums) {
  const setPlayers = [...setsMap.get(setNum)!];
  // Simple deterministic shuffle
  lotQueue.push(...setPlayers);
}

console.log(`Total players in auction queue: ${lotQueue.length}`);

let totalSold = 0;
let totalUnsold = 0;
const unsoldPool: IPLPlayer[] = [];

// Track spending on top 8 players for each team
const teamTop8Spending: Record<string, number> = {};
for (const f of franchises) teamTop8Spending[f.id] = 0;

// Main Round Simulation
for (let lotIdx = 0; lotIdx < lotQueue.length; lotIdx++) {
  const player = lotQueue[lotIdx];
  let currentBid = 0.0;
  let leadingFranchiseId: string | null = null;
  let bidsOnThisLot = 0;

  // Check which teams are full (18+ or 22 cap)
  const availableBidders = franchises.filter(f => {
    const st = (bidderAI as any).franchiseStates.get(f.id);
    return st && st.squad.length < 22;
  });

  if (availableBidders.length === 0) {
    break; // All teams full
  }

  // Bidding loop on current player
  let activeBidders = [...availableBidders];
  while (true) {
    let newBidPlaced = false;

    for (const f of activeBidders) {
      if (f.id === leadingFranchiseId) continue;

      const decision = bidderAI.evaluateFranchiseBid(
        f.id,
        player,
        currentBid,
        false,
        leadingFranchiseId || undefined
      );

      if (decision.canBid) {
        currentBid = decision.nextBidAmount;
        leadingFranchiseId = f.id;
        bidsOnThisLot++;
        newBidPlaced = true;
        break; // Advance to next round of bidding
      }
    }

    if (!newBidPlaced) {
      // Bidding finished
      break;
    }
  }

  if (leadingFranchiseId && currentBid > 0) {
    // Player sold!
    bidderAI.commitLotSale(teams, player, leadingFranchiseId, currentBid);
    totalSold++;

    const st = (bidderAI as any).franchiseStates.get(leadingFranchiseId);
    if (st.squad.length <= 8) {
      teamTop8Spending[leadingFranchiseId] += currentBid;
    }

    if (totalSold <= 15 || player.stats?.ovr >= 90) {
      console.log(`Lot #${(lotIdx + 1).toString().padStart(3)}: ${player.name.padEnd(20)} (${player.role.padEnd(4)}, OVR ${player.stats?.ovr ?? 70}) -> ${leadingFranchiseId.padEnd(5)} for ₹${currentBid.toFixed(2)} Cr`);
    }
  } else {
    totalUnsold++;
    unsoldPool.push(player);
  }
}

console.log('\n--- MAIN ROUND CONCLUDED ---');
console.log(`Sold: ${totalSold}, Unsold: ${totalUnsold}`);

// Accelerated Round Simulation for unsold players if any team < 18 players
const teamsNeedingPlayers = franchises.filter(f => {
  const st = (bidderAI as any).franchiseStates.get(f.id);
  return st && st.squad.length < 18;
});

if (teamsNeedingPlayers.length > 0 && unsoldPool.length > 0) {
  console.log(`\nStarting Accelerated Round: ${teamsNeedingPlayers.length} teams need players to reach 18...`);

  for (const player of unsoldPool) {
    const stillNeed = franchises.some(f => {
      const st = (bidderAI as any).franchiseStates.get(f.id);
      return st && st.squad.length < 18;
    });
    if (!stillNeed) break;

    // Halved base price in accelerated
    const accBase = player.basePrice >= 2.0 ? 1.0 : (player.basePrice >= 1.0 ? 0.5 : 0.3);
    const accPlayer = { ...player, basePrice: accBase };

    let currentBid = 0.0;
    let leadingFranchiseId: string | null = null;

    for (const f of franchises) {
      const st = (bidderAI as any).franchiseStates.get(f.id);
      if (!st || st.squad.length >= 18) continue;

      const decision = bidderAI.evaluateFranchiseBid(
        f.id,
        accPlayer,
        currentBid,
        true,
        leadingFranchiseId || undefined
      );

      if (decision.canBid) {
        currentBid = decision.nextBidAmount;
        leadingFranchiseId = f.id;
        break;
      }
    }

    if (leadingFranchiseId && currentBid > 0) {
      bidderAI.commitLotSale(teams, accPlayer, leadingFranchiseId, currentBid);
      totalSold++;
    }
  }
}

console.log('\n========================================================================================');
console.log('FINAL AUCTION RESULTS PER FRANCHISE (PURSE: ₹125 Cr)');
console.log('========================================================================================');

console.log('Franchise | Archetype           | Squad | Top 10 Spend | Top 11 Spend | Bench Spend | Purse Rem');
console.log('----------------------------------------------------------------------------------------');

let minSquad = 999;
let maxSquad = 0;

for (const f of franchises) {
  const st = (bidderAI as any).franchiseStates.get(f.id);
  const squadLen = st.squad.length;
  const purseRem = st.purseRemainingCr;
  
  const prices = st.pricesPaid || [];
  const top10 = prices.slice(0, 10).reduce((a: number, b: number) => a + b, 0);
  const top11 = prices.slice(0, 11).reduce((a: number, b: number) => a + b, 0);
  const bench = prices.slice(11).reduce((a: number, b: number) => a + b, 0);

  if (squadLen < minSquad) minSquad = squadLen;
  if (squadLen > maxSquad) maxSquad = squadLen;

  console.log(
    `${f.id.padEnd(9)} | ` +
    `${(f.archetype || '').padEnd(19)} | ` +
    `${squadLen.toString().padStart(5)} | ` +
    `₹${top10.toFixed(2).padStart(9)} Cr | ` +
    `₹${top11.toFixed(2).padStart(9)} Cr | ` +
    `₹${bench.toFixed(2).padStart(8)} Cr | ` +
    `₹${purseRem.toFixed(2).padStart(7)} Cr`
  );
}

console.log('----------------------------------------------------------------------------------------');
console.log(`Min Squad Size: ${minSquad}, Max Squad Size: ${maxSquad}`);

if (minSquad < 11) {
  console.error(`❌ CRITICAL FAILURE: A team ended with < 11 players (${minSquad})!`);
} else if (minSquad < 18) {
  console.warn(`⚠️ WARNING: A team ended with < 18 players (${minSquad})!`);
} else {
  console.log('✅ SUCCESS: All 10 teams completed legal 18+ player squads!');
}

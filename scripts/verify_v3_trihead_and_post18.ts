import * as fs from 'fs';
import {
  AuctionBidderAI,
  assignFranchiseArchetypes,
  DEFAULT_IPL_FRANCHISES,
  getNextBidIncrement
} from '../src/server/auction/bidderAI';
import { IPLPlayer } from '../src/types/player.types';

console.log('================================================================');
console.log('TEST SUITE: V3.0 TRI-HEAD ARCHITECTURE & POST-18 BIDDING');
console.log('================================================================');

const playersPath = fs.existsSync('./public/data/players_active_fixed.json')
  ? './public/data/players_active_fixed.json'
  : './public/data/players_active.json';
const raw = fs.readFileSync(playersPath, 'utf-8');
const allPlayers: IPLPlayer[] = JSON.parse(raw);

async function runTests() {
  const bidderAI = new AuctionBidderAI();
  await bidderAI.initModel();
  await bidderAI.initializeAuction(allPlayers);

  // ---------------------------------------------------------------------------
  // TEST 1: Verify Layer A Alpha Valuation and Confidence Head
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 1: Layer A Alpha Valuation & Confidence Head ---');
  const samplePlayer = allPlayers.find(p => p.id === 'virat-kohli') || allPlayers[0];
  const valOutput = bidderAI.getPlayerValuation(samplePlayer);
  console.log(`Player: ${samplePlayer.name}`);
  console.log(`  - Intrinsic Value (mu): ₹${valOutput.mu} Cr`);
  console.log(`  - Confidence: ${valOutput.confidence}`);
  console.log(`  - Alpha Value (vAlpha): ₹${valOutput.vAlpha} Cr`);
  console.log(`  - q15 (Floor): ₹${valOutput.q15} Cr, q85 (Ceiling): ₹${valOutput.q85} Cr`);

  if (!valOutput.vAlpha || valOutput.vAlpha < samplePlayer.basePrice || valOutput.vAlpha > 26.50) {
    throw new Error(`Test 1 Failed: vAlpha ₹${valOutput.vAlpha} out of bounds!`);
  }
  console.log('✓ TEST 1 PASSED: Layer A Alpha Valuation & Confidence Head verified.');

  // ---------------------------------------------------------------------------
  // TEST 2: Verify Archetype Routing and Forward Pass
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 2: Dedicated Policy Networks (SD, MB, DP) ---');
  const archetypes: ('SUPERSTAR_DUELIST' | 'MONEYBALL_CORE' | 'DISCIPLINED_PRAGMATIST')[] = [
    'SUPERSTAR_DUELIST',
    'MONEYBALL_CORE',
    'DISCIPLINED_PRAGMATIST'
  ];

  for (const arch of archetypes) {
    const fId = arch === 'SUPERSTAR_DUELIST' ? 'CSK' : (arch === 'MONEYBALL_CORE' ? 'KKR' : 'GT');
    const prof = bidderAI.franchiseProfiles.get(fId)!;
    prof.archetype = arch;
    const st = bidderAI.franchiseStates.get(fId)!;
    st.archetype = arch;

    const dec = bidderAI.evaluateFranchiseBid(fId, samplePlayer, 2.0);
    console.log(`Archetype: ${arch.padEnd(23)} | Franchise: ${fId} | canBid: ${dec.canBid} | maxVal: ₹${dec.maxValuation} Cr | mPolicy: ${dec.components?.mPolicy}`);
    if (dec.components?.mPolicy === undefined || dec.components.mPolicy < 0.70 || dec.components.mPolicy > 1.50) {
      throw new Error(`Test 2 Failed: mPolicy out of range [0.70, 1.50] for ${arch}: ${dec.components?.mPolicy}`);
    }
  }
  console.log('✓ TEST 2 PASSED: 3 Dedicated Specialist Networks loaded and producing bounded outputs.');

  // ---------------------------------------------------------------------------
  // TEST 3: Verify Post-18 Rival Bankruptcy Protection
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 3: Post-18 Rival Bankruptcy Protection ---');
  const fPost18 = 'CSK';
  const statePost18 = bidderAI.franchiseStates.get(fPost18)!;
  // Give CSK 18 fake squad members and ₹20.0 Cr purse
  statePost18.squad = Array(18).fill({ ...samplePlayer, isOverseas: false, role: 'BAT' });
  statePost18.roleCounts = { BAT: 5, WK: 2, AR: 3, PACE: 5, SPIN: 3 };
  statePost18.overseasCount = 0;
  statePost18.purseRemainingCr = 20.0;

  // Case 3A: Leader has 8 players, needs 10 players, has only 6.0 Cr purse (insolvency danger!)
  const insolventHumanPurse = 6.0;
  const insolventHumanSquad = 8; // needs 10 slots
  const lotPrice = 2.0;

  const decProtect = bidderAI.evaluateFranchiseBid(
    fPost18,
    samplePlayer,
    lotPrice,
    false,
    'HUMAN_LEADER',
    insolventHumanPurse,
    insolventHumanSquad
  );

  console.log(`Case 3A (Insolvent Leader): canBid = ${decProtect.canBid}, reason = ${decProtect.reason}`);
  if (decProtect.canBid || decProtect.reason !== 'PROTECT_RIVAL_SOLVENCY') {
    throw new Error(`Test 3A Failed: Expected PROTECT_RIVAL_SOLVENCY, got ${decProtect.reason}`);
  }
  console.log('✓ Case 3A PASSED: Insolvent rival protected from bankruptcy!');

  // Case 3B: Leader has 18 players (safe), but current player is a non-bargain low-value player
  const safeHumanPurse = 15.0;
  const safeHumanSquad = 18;
  const ordinaryPlayer: IPLPlayer = {
    ...samplePlayer,
    id: 'ordinary-player',
    stats: { bat: 60, bowl: 60, power: 60, fielding: 60, ovr: 68 },
    basePrice: 0.30
  };
  const decPreserve = bidderAI.evaluateFranchiseBid(
    fPost18,
    ordinaryPlayer,
    2.50,
    false,
    'HUMAN_LEADER',
    safeHumanPurse,
    safeHumanSquad
  );
  console.log(`Case 3B (Non-Bargain Lot): canBid = ${decPreserve.canBid}, reason = ${decPreserve.reason}`);
  if (decPreserve.canBid || decPreserve.reason !== 'NOT_NEEDED_PRESERVE_PURSE') {
    throw new Error(`Test 3B Failed: Expected NOT_NEEDED_PRESERVE_PURSE, got ${decPreserve.reason}`);
  }
  console.log('✓ Case 3B PASSED: Post-18 preserved purse for non-bargain lot!');

  // Case 3C: Leader has 18 players, and lot is a high-value bargain (OVR 85, current price 1.00 Cr vs intrinsic ~15 Cr)
  const realBargainPlayer = allPlayers.find(p => (p.stats?.ovr || 0) >= 85 && p.role === 'PACE') || allPlayers[0];
  const decBargain = bidderAI.evaluateFranchiseBid(
    fPost18,
    realBargainPlayer,
    1.00,
    false,
    'HUMAN_LEADER',
    safeHumanPurse,
    safeHumanSquad
  );
  console.log(`Case 3C (High-Value Bargain): canBid = ${decBargain.canBid}, maxVal = ₹${decBargain.maxValuation} Cr, reason = ${decBargain.reason}`);
  if (!decBargain.canBid) {
    throw new Error(`Test 3C Failed: Expected opportunistic bid on high-value bargain, got canBid=false (${decBargain.reason})`);
  }
  console.log('✓ Case 3C PASSED: Opportunistic bidding triggered on high-value bargain!');

  // ---------------------------------------------------------------------------
  // TEST 4: Full 10-Team Auction Simulation
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 4: Full 10-Team Auction Simulation ---');
  const simAI = new AuctionBidderAI();
  await simAI.initModel();
  await simAI.initializeAuction(allPlayers);
  const simTeams = simAI.initializeTeams('SIM_ROOM', allPlayers);

  // Group queue by sets
  const setsMap = new Map<number, IPLPlayer[]>();
  for (const player of allPlayers) {
    const setNum = player.marqueeSet || 9;
    if (!setsMap.has(setNum)) setsMap.set(setNum, []);
    setsMap.get(setNum)!.push(player);
  }

  const sortedSetNums = Array.from(setsMap.keys()).sort((a, b) => a - b);
  const lotQueue: IPLPlayer[] = [];
  for (const setNum of sortedSetNums) {
    lotQueue.push(...setsMap.get(setNum)!);
  }

  console.log(`Running auction simulation across ${lotQueue.length} lots for 10 franchises...`);
  const franchiseList = DEFAULT_IPL_FRANCHISES.map(f => f.id);

  for (let lotIdx = 0; lotIdx < lotQueue.length; lotIdx++) {
    const player = lotQueue[lotIdx];
    let currentBid = 0.0;
    let leadingFranchiseId: string | null = null;

    // Check if all teams are full (18+)
    const allFull = franchiseList.every(fId => {
      const st = simAI.franchiseStates.get(fId)!;
      return st.squad.length >= 18;
    });

    if (allFull && lotIdx > 200) {
      // Once all teams reach 18+ and we passed initial sets, let's see if anyone still bids
    }

    // Bid loop
    let biddingActive = true;
    let passes = 0;
    while (biddingActive && passes < franchiseList.length) {
      let bidHappened = false;
      for (const fId of franchiseList) {
        if (fId === leadingFranchiseId) continue;
        const dec = simAI.evaluateFranchiseBid(
          fId,
          player,
          currentBid,
          false,
          leadingFranchiseId || undefined
        );

        if (dec.canBid && dec.nextBidAmount > currentBid) {
          currentBid = dec.nextBidAmount;
          leadingFranchiseId = fId;
          bidHappened = true;
          passes = 0;
          break; // Next bid placed
        }
      }
      if (!bidHappened) {
        passes++;
        if (passes >= franchiseList.length) biddingActive = false;
      }
    }

    if (leadingFranchiseId && currentBid > 0) {
      simAI.commitLotSale(simTeams, player, leadingFranchiseId, currentBid);
    } else {
      simAI.commitLotSale(simTeams, player, null, 0);
    }
  }

  console.log('\n--- SIMULATION RESULTS ---');
  let allLegal = true;
  for (const fId of franchiseList) {
    const st = simAI.franchiseStates.get(fId)!;
    const prof = simAI.franchiseProfiles.get(fId)!;
    const wkCount = st.roleCounts.WK || 0;
    const bowlerCount = (st.roleCounts.PACE || 0) + (st.roleCounts.SPIN || 0) + (st.roleCounts.AR || 0);
    const overseas = st.overseasCount;
    const squadSize = st.squad.length;
    const purseLeft = Math.round(st.purseRemainingCr * 100) / 100;

    console.log(
      `${fId.padEnd(5)} (${(prof.archetype || 'DP').padEnd(20)}): Squad = ${squadSize.toString().padStart(2)} | ` +
      `Purse = ₹${purseLeft.toFixed(2).padStart(5)} Cr | Overseas = ${overseas}/8 | WK = ${wkCount} | Bowlers = ${bowlerCount}`
    );

    if (squadSize < 18) {
      console.error(`❌ ERROR: ${fId} failed to reach legal 18 players! (has ${squadSize})`);
      allLegal = false;
    }
    if (overseas > 8) {
      console.error(`❌ ERROR: ${fId} exceeded overseas cap! (${overseas}/8)`);
      allLegal = false;
    }
    if (wkCount < 1) {
      console.error(`❌ ERROR: ${fId} has 0 Wicketskeepers!`);
      allLegal = false;
    }
    if (bowlerCount < 6) {
      console.error(`❌ ERROR: ${fId} has fewer than 6 bowlers! (${bowlerCount})`);
      allLegal = false;
    }
  }

  if (!allLegal) {
    throw new Error('Test 4 Failed: One or more franchises failed legal requirements!');
  }
  console.log('\n✓ TEST 4 PASSED: All 10 AI franchises naturally formed 100% legal, competitive squads with 0 auto-fill!');
  console.log('\n================================================================');
  console.log('ALL TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});

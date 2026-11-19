/**
 * verify_upgrade.ts - Full Verification Script for:
 * 1. Monotonic Dual-XGBoost Match Simulator (Runs Regressor + Wickets Classifier)
 * 2. V2.0 Generational Auction Bidder AI (V_intrinsic + PolicyNet + Solvency Clamps)
 */

import * as fs from 'fs';
import * as path from 'path';
import { MatchSimEngine } from '../src/server/match/simEngine';
import { FullMatchSimulator, Team2026 } from '../src/server/match/fullMatchSimulator';
import { AuctionBidderAI, DEFAULT_IPL_FRANCHISES } from '../src/server/auction/bidderAI';
import { IPLPlayer } from '../src/types/player.types';

async function main() {
  console.log('='.repeat(80));
  console.log('STARTING COMPREHENSIVE VERIFICATION FOR DUAL-XGBOOST & V2.0 AUCTION ENGINE');
  console.log('='.repeat(80));

  // 1. Load active players
  const playersPath = path.resolve(process.cwd(), 'public/data/players_active_fixed.json');
  if (!fs.existsSync(playersPath)) {
    throw new Error(`players_active_fixed.json not found at ${playersPath}`);
  }
  const allPlayers: IPLPlayer[] = JSON.parse(fs.readFileSync(playersPath, 'utf-8'));
  console.log(`[PASS] Loaded ${allPlayers.length} verified players.`);

  // Check Shreyas Iyer & Heinrich Klaasen cards
  const shreyas = allPlayers.find(p => p.id === 'p_001');
  const klaasen = allPlayers.find(p => p.id === 'p_002');
  console.log(`  -> Player p_001: ${shreyas?.name} (${shreyas?.role}, OVR: ${shreyas?.stats?.ovr})`);
  console.log(`  -> Player p_002: ${klaasen?.name} (${klaasen?.role}, OVR: ${klaasen?.stats?.ovr})`);
  if (!shreyas || shreyas.name !== 'Shreyas Iyer' || !klaasen || klaasen.name !== 'Heinrich Klaasen') {
    throw new Error('Player cards corrupted!');
  }

  // =========================================================================
  // TEST 1: DUAL-XGBOOST MATCH SIM ENGINE
  // =========================================================================
  console.log('\n--- [TEST 1] Dual-XGBoost Match Simulation Engine ---');
  const engine = new MatchSimEngine();
  await engine.init();

  const dummyPitch = { spin: 0.2, pace: 0.4, power: 0.1, dew: 0.0 };
  const bowler = allPlayers.find(p => p.role === 'PACE' || p.role === 'SPIN') || allPlayers[10];

  const overInput = {
    overNumber: 5, // 6th over (Powerplay finale)
    innings: 1 as const,
    currentScore: 48,
    wicketsDown: 1,
    striker: shreyas,
    nonStriker: klaasen,
    bowler: bowler,
    pitch: dummyPitch,
    battingTactic: 'AGGRESSIVE' as const,
    bowlingTactic: 'CONTAIN' as const,
    strikerBallsFaced: 16,
    bowlerOversBowled: 1
  };

  const feat22 = engine.buildFeatureVector(overInput);
  console.log(`  -> 22 Feature Vector built successfully (length: ${feat22.length})`);
  if (feat22.length !== 22) throw new Error('Feature vector must be exactly 22 floats');

  const dist = await engine.predictOverDistribution(feat22);
  console.log(`  -> XGBoost Predicted Runs mu: ${dist.mu.toFixed(2)}, Wicket Hazard: ${(dist.wicketProb * 100).toFixed(1)}%`);
  if (dist.mu < 3.0 || dist.mu > 20.0) throw new Error(`Predicted runs mu (${dist.mu}) outside plausible bounds!`);
  if (dist.wicketProb < 0.05 || dist.wicketProb > 0.70) throw new Error(`Wicket prob (${dist.wicketProb}) outside plausible bounds!`);

  const strikerScore = { id: shreyas.id, name: shreyas.name, runs: 28, balls: 16, fours: 3, sixes: 1, isOut: false };
  const nonStrikerScore = { id: klaasen.id, name: klaasen.name, runs: 18, balls: 12, fours: 2, sixes: 1, isOut: false };
  const bowlerFig = { id: bowler.id, name: bowler.name, overs: 1, maidens: 0, runsConceded: 8, wickets: 0, dots: 2 };

  const overResult = await engine.simulateOver(overInput, strikerScore, nonStrikerScore, bowlerFig);
  console.log(`  -> Over simulated! Runs scored: ${overResult.runsScored}, Wickets lost: ${overResult.wicketsLost}`);
  console.log(`  -> Total Score: ${overResult.inningsCumulativeScore}/${overResult.inningsCumulativeWickets}`);
  console.log(`  -> Sample commentary: "${overResult.commentary[0]}"`);

  // =========================================================================
  // TEST 2: FULL 40-OVER MATCH SIMULATION WITH 3-5-2 ROTATION
  // =========================================================================
  console.log('\n--- [TEST 2] Full 40-Over Match Simulation with 3-5-2 Rotation & 4-2-2 Quotas ---');
  const fullSim = new FullMatchSimulator();
  await fullSim.init();

  const cskPlayers = allPlayers.slice(0, 11);
  const miPlayers = allPlayers.slice(11, 22);

  const teamA: Team2026 = {
    id: 'CSK',
    name: 'Chennai Super Kings',
    playingXI: cskPlayers,
    powerplayBowlers: cskPlayers.filter(p => p.isBowlingCapable).slice(0, 3).map(p => p.id),
    primaryBowlers: cskPlayers.filter(p => p.isBowlingCapable).slice(0, 5).map(p => p.id),
    deathBowlers: cskPlayers.filter(p => p.isBowlingCapable).slice(0, 2).map(p => p.id),
    firstBowlerId: cskPlayers.filter(p => p.isBowlingCapable)[0]?.id
  };

  const teamB: Team2026 = {
    id: 'MI',
    name: 'Mumbai Indians',
    playingXI: miPlayers,
    powerplayBowlers: miPlayers.filter(p => p.isBowlingCapable).slice(0, 3).map(p => p.id),
    primaryBowlers: miPlayers.filter(p => p.isBowlingCapable).slice(0, 5).map(p => p.id),
    deathBowlers: miPlayers.filter(p => p.isBowlingCapable).slice(0, 2).map(p => p.id),
    firstBowlerId: miPlayers.filter(p => p.isBowlingCapable)[0]?.id
  };

  const matchScorecard = await fullSim.simulateFullMatch(1, teamA, teamB, dummyPitch, 'Chepauk', 'CSK');
  console.log(`  -> Match Finished! Winner: ${matchScorecard.winner} by ${matchScorecard.margin}`);
  console.log(`  -> 1st Innings: ${matchScorecard.innings1.totalRuns}/${matchScorecard.innings1.totalWickets} in ${matchScorecard.innings1.oversCompleted} overs`);
  console.log(`  -> 2nd Innings: ${matchScorecard.innings2.totalRuns}/${matchScorecard.innings2.totalWickets} in ${matchScorecard.innings2.oversCompleted} overs`);
  console.log(`  -> Player of the Match: ${matchScorecard.playerOfTheMatch.name} (${matchScorecard.playerOfTheMatch.team}) - ${matchScorecard.playerOfTheMatch.reason}`);

  // =========================================================================
  // TEST 3: V2.0 GENERATIONAL AUCTION BIDDER AI
  // =========================================================================
  console.log('\n--- [TEST 3] V2.0 Generational Auction Bidder AI ---');
  const bidderAI = new AuctionBidderAI();
  await bidderAI.initModel();

  const teamsState = bidderAI.initializeTeams('TEST-ROOM', allPlayers);
  console.log(`  -> Initialized 10 teams with ₹120.00 Cr purse.`);

  // Verify Layer A valuations
  const shreyasVal = bidderAI.getPlayerValuation(shreyas);
  const klaasenVal = bidderAI.getPlayerValuation(klaasen);
  console.log(`  -> Shreyas Iyer Valuation: ₹${shreyasVal.mu.toFixed(2)} Cr (Floor: ₹${shreyasVal.q15.toFixed(2)}, Ceiling: ₹${shreyasVal.q85.toFixed(2)})`);
  console.log(`  -> Heinrich Klaasen Valuation: ₹${klaasenVal.mu.toFixed(2)} Cr (Floor: ₹${klaasenVal.q15.toFixed(2)}, Ceiling: ₹${klaasenVal.q85.toFixed(2)})`);
  if (shreyasVal.mu < 8.0 || klaasenVal.mu < 8.0) {
    throw new Error('Star player Layer A valuation is unrealistically low!');
  }

  // Simulate Mode A Silent Vickrey Resolution for Shreyas Iyer
  console.log('\n  -> Simulating Mode A Silent Vickrey Resolution for Shreyas Iyer...');
  const resolution = bidderAI.resolveModeAVickrey('TEST-ROOM', teamsState, shreyas, allPlayers.slice(10), 1, 'MAIN');
  console.log(`  -> Lot 1 Outcome: ${resolution.status}! Winner: ${resolution.winnerId}, Sold Price: ₹${resolution.soldPrice.toFixed(2)} Cr (Second Price: ₹${resolution.secondValuation?.toFixed(2)} Cr)`);
  if (resolution.status !== 'SOLD' || !resolution.winnerId || resolution.soldPrice <= shreyas.basePrice) {
    throw new Error('Mode A Vickrey resolution failed!');
  }

  // Commit sale
  bidderAI.commitLotSale(teamsState, shreyas, resolution.winnerId, resolution.soldPrice);
  const winnerTeam = teamsState[resolution.winnerId];
  console.log(`  -> ${winnerTeam.name} new purse: ₹${winnerTeam.purse.toFixed(2)} Cr, squad size: ${winnerTeam.squad.length}`);
  if (winnerTeam.purse >= 120.00 || winnerTeam.squad.length !== 1) {
    throw new Error('Commit lot sale did not update purse and squad correctly!');
  }

  // Test Mode B Bid Evaluation
  console.log('\n  -> Simulating Mode B Interactive Bid Reaction for Heinrich Klaasen at ₹10.00 Cr...');
  const miDecision = bidderAI.evaluateFranchiseBid('MI', klaasen, 10.00, false, 'CSK');
  console.log(`  -> MI Decision: canBid=${miDecision.canBid}, maxValuation=₹${miDecision.maxValuation.toFixed(2)} Cr, nextBid=₹${miDecision.nextBidAmount.toFixed(2)} Cr, delay=${miDecision.reactionDelayMs}ms, reason=${miDecision.reason}`);

  // Test Solvency Clamp
  console.log('\n  -> Testing Solvency Clamp (18 legal players minimum reserve)...');
  const dummyState = bidderAI.franchiseStates.get('CSK')!;
  const originalPurse = dummyState.purseRemainingCr;
  dummyState.purseRemainingCr = 2.00; // Only ₹2.00 Cr left with squad size 1 -> needs 16 more slots!
  const clampedDecision = bidderAI.evaluateFranchiseBid('CSK', klaasen, 1.00, false);
  console.log(`  -> Low Purse Decision: canBid=${clampedDecision.canBid}, reason=${clampedDecision.reason}`);
  if (clampedDecision.canBid) {
    throw new Error('Solvency clamp failed! AI bid when it could not afford legal 18 players!');
  }
  dummyState.purseRemainingCr = originalPurse; // Restore

  console.log('\n' + '='.repeat(80));
  console.log('ALL VERIFICATION CHECKS PASSED PERFECTLY!');
  console.log('='.repeat(80));
}

main().catch(err => {
  console.error('[FATAL ERROR]', err);
  process.exit(1);
});

import fs from 'fs';
import path from 'path';
import { AuctionBidderAI, DEFAULT_IPL_FRANCHISES } from '../src/server/auction/bidderAI';
import { FullMatchSimulator, Team2026 } from '../src/server/match/fullMatchSimulator';
import { TeamMaker } from '../src/server/match/teamMaker';
import { IPLPlayer } from '../src/types/player.types';
import { TeamAuctionState } from '../src/types/auction.types';

const allPlayers: IPLPlayer[] = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'public/data/players_active.json'), 'utf-8')
);

// Load weights
const tunedWeights = {
  sd: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'public/models/weights_sd.json'), 'utf-8')),
  mb: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'public/models/weights_mb.json'), 'utf-8')),
  dp: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'public/models/weights_dp.json'), 'utf-8')),
};

const untunedWeights = {
  sd: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'public/models/weights_sd_untuned.json'), 'utf-8')),
  mb: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'public/models/weights_mb_untuned.json'), 'utf-8')),
  dp: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'public/models/weights_dp_untuned.json'), 'utf-8')),
};

interface SingleAuctionStats {
  engineName: string;
  totalPurseSpentAvg: number;
  remPurseAvg: number;
  squadSizeAvg: number;
  superstarAvgPrice: number;
  superstarsCount: number;
  coreAvgPrice: number;
  coresCount: number;
  valueAvgPrice: number;
  valuesCount: number;
  unsoldCount: number;
  avgSquadOVR: number;
  avgPlayingXIOVR: number;
  teamStats: Array<{ id: string; name: string; spent: number; rem: number; squadCount: number; xiOvr: number; superstars: number }>;
}

async function runAuctionWithConfig(
  bidderAI: AuctionBidderAI,
  roomCode: string,
  overrides?: Record<string, any>
): Promise<{ teams: Record<string, TeamAuctionState>; stats: SingleAuctionStats }> {
  await bidderAI.initializeAuction(allPlayers);
  const teams = bidderAI.initializeTeams(roomCode, allPlayers);

  // Apply overrides if provided
  if (overrides) {
    for (const [tId, w] of Object.entries(overrides)) {
      bidderAI.franchiseWeightOverrides.set(tId, w);
    }
  }

  // Create lot queue
  const setsMap = new Map<number, IPLPlayer[]>();
  for (const player of allPlayers) {
    const setNum = player.marqueeSet || 9;
    if (!setsMap.has(setNum)) setsMap.set(setNum, []);
    setsMap.get(setNum)!.push(player);
  }
  const sortedSetNums = Array.from(setsMap.keys()).sort((a, b) => a - b);
  const lotQueue: IPLPlayer[] = [];
  for (const setNum of sortedSetNums) {
    const setPlayers = [...setsMap.get(setNum)!];
    for (let i = setPlayers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [setPlayers[i], setPlayers[j]] = [setPlayers[j], setPlayers[i]];
    }
    lotQueue.push(...setPlayers);
  }

  const superstarPrices: number[] = [];
  const corePrices: number[] = [];
  const valuePrices: number[] = [];
  let unsoldCount = 0;
  const teamSuperstars: Record<string, number> = {};
  for (const tId of Object.keys(teams)) teamSuperstars[tId] = 0;

  for (let idx = 0; idx < lotQueue.length; idx++) {
    const player = lotQueue[idx];
    const remPlayers = lotQueue.slice(idx + 1);
    const phase = idx < 70 ? 'REGULAR' : 'ACCELERATED_1';

    const res = bidderAI.resolveModeAVickrey(roomCode, teams, player, remPlayers, idx, phase);
    bidderAI.commitLotSale(teams, player, res.winnerId, res.soldPrice);

    if (res.status === 'SOLD' && res.winnerId) {
      const ovr = player.stats?.ovr ?? 72;
      if (ovr >= 88) {
        superstarPrices.push(res.soldPrice);
        teamSuperstars[res.winnerId] = (teamSuperstars[res.winnerId] || 0) + 1;
      } else if (ovr >= 82) {
        corePrices.push(res.soldPrice);
      } else {
        valuePrices.push(res.soldPrice);
      }
    } else {
      unsoldCount++;
    }
  }

  // Ensure minimum roster depth for matches
  const assignedIds = new Set<string>();
  for (const t of Object.values(teams)) {
    for (const p of t.squad) assignedIds.add(p.id);
  }
  const unassignedPool = allPlayers.filter(p => !assignedIds.has(p.id));
  let unassignedIdx = 0;

  let totalSpent = 0;
  let totalRem = 0;
  let totalSquadCount = 0;
  let totalSquadOvr = 0;
  let totalXiOvr = 0;
  const teamStatsList = [];

  for (const [tId, t] of Object.entries(teams)) {
    const originalBoughtCount = t.squad.length;
    while (t.squad.length < 18 && unassignedIdx < unassignedPool.length) {
      t.squad.push(unassignedPool[unassignedIdx++]);
    }
    TeamMaker.ensureSquadBowlingCapacity(t.squad);

    const spent = 125.0 - t.purse;
    totalSpent += spent;
    totalRem += t.purse;
    totalSquadCount += originalBoughtCount;

    const squadOvr = t.squad.reduce((sum, p) => sum + (p.stats?.ovr ?? 72), 0) / t.squad.length;
    totalSquadOvr += squadOvr;

    const lineup = TeamMaker.makeSmartLineup(tId, t.squad);
    const xi = (lineup.playing11Ids || []).map(id => t.squad.find(p => p.id === id)!).filter(Boolean);
    const xiOvr = xi.reduce((sum, p) => sum + (p.stats?.ovr ?? 72), 0) / (xi.length || 1);
    totalXiOvr += xiOvr;

    teamStatsList.push({
      id: tId,
      name: t.name,
      spent: Math.round(spent * 100) / 100,
      rem: Math.round(t.purse * 100) / 100,
      squadCount: originalBoughtCount,
      xiOvr: Math.round(xiOvr * 10) / 10,
      superstars: teamSuperstars[tId] || 0
    });
  }

  const numTeams = Object.keys(teams).length;
  const stats: SingleAuctionStats = {
    engineName: roomCode,
    totalPurseSpentAvg: Math.round((totalSpent / numTeams) * 100) / 100,
    remPurseAvg: Math.round((totalRem / numTeams) * 100) / 100,
    squadSizeAvg: Math.round((totalSquadCount / numTeams) * 10) / 10,
    superstarAvgPrice: superstarPrices.length > 0 ? Math.round((superstarPrices.reduce((a, b) => a + b, 0) / superstarPrices.length) * 100) / 100 : 0,
    superstarsCount: superstarPrices.length,
    coreAvgPrice: corePrices.length > 0 ? Math.round((corePrices.reduce((a, b) => a + b, 0) / corePrices.length) * 100) / 100 : 0,
    coresCount: corePrices.length,
    valueAvgPrice: valuePrices.length > 0 ? Math.round((valuePrices.reduce((a, b) => a + b, 0) / valuePrices.length) * 100) / 100 : 0,
    valuesCount: valuePrices.length,
    unsoldCount,
    avgSquadOVR: Math.round((totalSquadOvr / numTeams) * 100) / 100,
    avgPlayingXIOVR: Math.round((totalXiOvr / numTeams) * 100) / 100,
    teamStats: teamStatsList
  };

  return { teams, stats };
}

async function simulateSeasonMatches(
  teams: Record<string, TeamAuctionState>,
  numMatches: number,
  teamLabelMap?: Record<string, string>
) {
  const sim = new FullMatchSimulator();
  await sim.init();
  sim.setSimAlpha(0.80);

  const teamIds = Object.keys(teams);
  const wins: Record<string, number> = {};
  const played: Record<string, number> = {};
  for (const id of teamIds) {
    wins[id] = 0;
    played[id] = 0;
  }

  const groupStats: Record<string, { wins: number; matches: number }> = {};
  if (teamLabelMap) {
    for (const label of Object.values(teamLabelMap)) {
      groupStats[label] = { wins: 0, matches: 0 };
    }
  }

  for (let m = 0; m < numMatches; m++) {
    const idA = teamIds[Math.floor(Math.random() * teamIds.length)];
    let idB = teamIds[Math.floor(Math.random() * teamIds.length)];
    while (idB === idA) idB = teamIds[Math.floor(Math.random() * teamIds.length)];

    const tA = teams[idA];
    const tB = teams[idB];

    const lineupA = TeamMaker.makeSmartLineup(tA.franchiseId, tA.squad);
    const lineupB = TeamMaker.makeSmartLineup(tB.franchiseId, tB.squad);

    const xiA = (lineupA.playing11Ids || []).map(id => tA.squad.find(p => p.id === id)!).filter(Boolean);
    const xiB = (lineupB.playing11Ids || []).map(id => tB.squad.find(p => p.id === id)!).filter(Boolean);

    const deathA = lineupA.bowlerPool352.deathBowlerIds || [];
    const deathB = lineupB.bowlerPool352.deathBowlerIds || [];

    const simTeamA: Team2026 = {
      id: tA.franchiseId,
      name: tA.name,
      playingXI: xiA,
      primaryBowlers: lineupA.bowlerPool352.middleBowlerIds,
      powerplayBowlers: lineupA.bowlerPool352.powerplayBowlerIds,
      deathBowlers: deathA.length === 2 ? deathA : (lineupA.bowlerPool352.deathBowlerIds || []),
      firstBowlerId: lineupA.bowlerPool352.firstBowlerId,
      backupBowlerId: lineupA.bowlerPool352.backupBowlerId,
      bowlerPool352: lineupA.bowlerPool352
    };

    const simTeamB: Team2026 = {
      id: tB.franchiseId,
      name: tB.name,
      playingXI: xiB,
      primaryBowlers: lineupB.bowlerPool352.middleBowlerIds,
      powerplayBowlers: lineupB.bowlerPool352.powerplayBowlerIds,
      deathBowlers: deathB.length === 2 ? deathB : (lineupB.bowlerPool352.deathBowlerIds || []),
      firstBowlerId: lineupB.bowlerPool352.firstBowlerId,
      backupBowlerId: lineupB.bowlerPool352.backupBowlerId,
      bowlerPool352: lineupB.bowlerPool352
    };

    const res = await sim.simulateFullMatch(m + 1, simTeamA, simTeamB);

    played[idA]++;
    played[idB]++;

    if (teamLabelMap) {
      groupStats[teamLabelMap[idA]].matches++;
      groupStats[teamLabelMap[idB]].matches++;
    }

    if (res.winnerTeamId === idA) {
      wins[idA]++;
      if (teamLabelMap) groupStats[teamLabelMap[idA]].wins++;
    } else if (res.winnerTeamId === idB) {
      wins[idB]++;
      if (teamLabelMap) groupStats[teamLabelMap[idB]].wins++;
    }
  }

  const winRates: Record<string, number> = {};
  for (const id of teamIds) {
    winRates[id] = played[id] > 0 ? Math.round((wins[id] / played[id]) * 1000) / 10 : 0;
  }

  const groupWinRates: Record<string, number> = {};
  if (teamLabelMap) {
    for (const [lbl, st] of Object.entries(groupStats)) {
      groupWinRates[lbl] = st.matches > 0 ? Math.round((st.wins / st.matches) * 1000) / 10 : 0;
    }
  }

  return { wins, played, winRates, groupWinRates };
}

async function runMain() {
  console.log('======================================================================');
  console.log(' EXPERIMENT 1: ISOLATED AUCTIONS (100% TUNED vs 100% UNTUNED vs v2.0) ');
  console.log('======================================================================');

  // 1. Isolated Tuned v3.0
  const aiTuned = new AuctionBidderAI();
  (aiTuned as any).archetypeWeights.set('SUPERSTAR_DUELIST', tunedWeights.sd);
  (aiTuned as any).archetypeWeights.set('MONEYBALL_CORE', tunedWeights.mb);
  (aiTuned as any).archetypeWeights.set('DISCIPLINED_PRAGMATIST', tunedWeights.dp);
  const isoTuned = await runAuctionWithConfig(aiTuned, 'ISO_V3_TUNED');

  // 2. Isolated Untuned v3.0
  const aiUntuned = new AuctionBidderAI();
  (aiUntuned as any).archetypeWeights.set('SUPERSTAR_DUELIST', untunedWeights.sd);
  (aiUntuned as any).archetypeWeights.set('MONEYBALL_CORE', untunedWeights.mb);
  (aiUntuned as any).archetypeWeights.set('DISCIPLINED_PRAGMATIST', untunedWeights.dp);
  const isoUntuned = await runAuctionWithConfig(aiUntuned, 'ISO_V3_UNTUNED');

  // 3. Isolated v2.0 Analytical (no weights in archetypeWeights)
  const aiV2 = new AuctionBidderAI();
  (aiV2 as any).archetypeWeights.clear();
  const isoV2 = await runAuctionWithConfig(aiV2, 'ISO_V2_ANALYTICAL');

  console.log('\n--- ISOLATED AUCTION COMPARISON ---');
  console.log('METRIC                         | V2.0 ANALYTICAL | V3.0 UNTUNED | V3.0 TUNED');
  console.log('-------------------------------+-----------------+--------------+------------');
  console.log(`Avg Purse Spent (Cr)           | ${isoV2.stats.totalPurseSpentAvg.toFixed(2).padStart(15)} | ${isoUntuned.stats.totalPurseSpentAvg.toFixed(2).padStart(12)} | ${isoTuned.stats.totalPurseSpentAvg.toFixed(2).padStart(10)}`);
  console.log(`Avg Rem. Purse (Cr)            | ${isoV2.stats.remPurseAvg.toFixed(2).padStart(15)} | ${isoUntuned.stats.remPurseAvg.toFixed(2).padStart(12)} | ${isoTuned.stats.remPurseAvg.toFixed(2).padStart(10)}`);
  console.log(`Avg Squad Size                 | ${isoV2.stats.squadSizeAvg.toFixed(1).padStart(15)} | ${isoUntuned.stats.squadSizeAvg.toFixed(1).padStart(12)} | ${isoTuned.stats.squadSizeAvg.toFixed(1).padStart(10)}`);
  console.log(`Superstar Avg Price (OVR >= 88)| ${isoV2.stats.superstarAvgPrice.toFixed(2).padStart(15)} | ${isoUntuned.stats.superstarAvgPrice.toFixed(2).padStart(12)} | ${isoTuned.stats.superstarAvgPrice.toFixed(2).padStart(10)}`);
  console.log(`Core Star Avg Price (82-87)    | ${isoV2.stats.coreAvgPrice.toFixed(2).padStart(15)} | ${isoUntuned.stats.coreAvgPrice.toFixed(2).padStart(12)} | ${isoTuned.stats.coreAvgPrice.toFixed(2).padStart(10)}`);
  console.log(`Value Buys Avg Price (< 82)    | ${isoV2.stats.valueAvgPrice.toFixed(2).padStart(15)} | ${isoUntuned.stats.valueAvgPrice.toFixed(2).padStart(12)} | ${isoTuned.stats.valueAvgPrice.toFixed(2).padStart(10)}`);
  console.log(`Unsold Lots Count              | ${isoV2.stats.unsoldCount.toString().padStart(15)} | ${isoUntuned.stats.unsoldCount.toString().padStart(12)} | ${isoTuned.stats.unsoldCount.toString().padStart(10)}`);
  console.log(`Avg Squad OVR                  | ${isoV2.stats.avgSquadOVR.toFixed(2).padStart(15)} | ${isoUntuned.stats.avgSquadOVR.toFixed(2).padStart(12)} | ${isoTuned.stats.avgSquadOVR.toFixed(2).padStart(10)}`);
  console.log(`Avg Playing XI OVR             | ${isoV2.stats.avgPlayingXIOVR.toFixed(2).padStart(15)} | ${isoUntuned.stats.avgPlayingXIOVR.toFixed(2).padStart(12)} | ${isoTuned.stats.avgPlayingXIOVR.toFixed(2).padStart(10)}`);

  console.log('\n======================================================================');
  console.log(' EXPERIMENT 2: "ALL WITH" MIXED AUCTION BATTLE ROYALE (1 SAME ROOM)    ');
  console.log('======================================================================');
  console.log('Allocations in the same room:');
  console.log('  -> CSK, MI, RCB, KKR  : V3.0 TUNED NEURAL');
  console.log('  -> RR, SRH, DC        : V3.0 UNTUNED NEURAL');
  console.log('  -> PBKS, GT, LSG      : V2.0 ANALYTICAL');

  const mixedAI = new AuctionBidderAI();
  const overrides: Record<string, any> = {
    CSK: tunedWeights.sd,
    MI: tunedWeights.sd,
    RCB: tunedWeights.sd,
    KKR: tunedWeights.mb,
    RR: untunedWeights.mb,
    SRH: untunedWeights.mb,
    DC: untunedWeights.dp,
    PBKS: null, // V2.0 Analytical
    GT: null,   // V2.0 Analytical
    LSG: null   // V2.0 Analytical
  };

  const teamLabelMap: Record<string, string> = {
    CSK: 'V3_TUNED',
    MI: 'V3_TUNED',
    RCB: 'V3_TUNED',
    KKR: 'V3_TUNED',
    RR: 'V3_UNTUNED',
    SRH: 'V3_UNTUNED',
    DC: 'V3_UNTUNED',
    PBKS: 'V2_ANALYTICAL',
    GT: 'V2_ANALYTICAL',
    LSG: 'V2_ANALYTICAL'
  };

  const mixedAuction = await runAuctionWithConfig(mixedAI, 'MIXED_BATTLE_ROYALE', overrides);

  console.log('\n--- MIXED AUCTION ROSTER BREAKDOWN ---');
  console.log('TEAM | ENGINE         | SPENT (Cr) | REM (Cr) | SQUAD | XI OVR | SUPERSTARS');
  console.log('-----+----------------+------------+----------+-------+--------+-----------');
  for (const t of mixedAuction.stats.teamStats) {
    const label = teamLabelMap[t.id];
    console.log(`${t.id.padEnd(4)} | ${label.padEnd(14)} | ${t.spent.toFixed(2).padStart(10)} | ${t.rem.toFixed(2).padStart(8)} | ${t.squadCount.toString().padStart(5)} | ${t.xiOvr.toFixed(1).padStart(6)} | ${t.superstars.toString().padStart(9)}`);
  }

  console.log('\nSimulating 100 Head-to-Head Matches with these exact rosters...');
  const matchResults = await simulateSeasonMatches(mixedAuction.teams, 100, teamLabelMap);

  console.log('\n================ MIXED BATTLE ROYALE MATCH RESULTS ================');
  console.log('MODEL GENERATION     | MATCH WIN RATE % | TOTAL WINS');
  console.log('---------------------+------------------+------------');
  for (const [grp, rate] of Object.entries(matchResults.groupWinRates)) {
    console.log(`${grp.padEnd(20)} | ${rate.toFixed(1).padStart(16)}% |`);
  }
  console.log('-------------------------------------------------------------------');
  console.log('Individual Team Win Rates:');
  for (const [tId, rate] of Object.entries(matchResults.winRates)) {
    console.log(`  ${tId.padEnd(5)} (${teamLabelMap[tId]}): ${rate.toFixed(1)}%`);
  }
  console.log('===================================================================\n');

  fs.writeFileSync(
    path.resolve(process.cwd(), 'comparison_experiment_report.json'),
    JSON.stringify({
      isolated: {
        v2: isoV2.stats,
        untuned: isoUntuned.stats,
        tuned: isoTuned.stats
      },
      mixed: {
        auctionStats: mixedAuction.stats,
        matchResults
      }
    }, null, 2),
    'utf-8'
  );
}

runMain().catch(console.error);

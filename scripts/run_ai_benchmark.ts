import fs from 'fs';
import path from 'path';
import { AuctionBidderAI, DEFAULT_IPL_FRANCHISES, AIArchetype } from '../src/server/auction/bidderAI';
import { FullMatchSimulator, Team2026 } from '../src/server/match/fullMatchSimulator';
import { TeamMaker } from '../src/server/match/teamMaker';
import { IPLPlayer } from '../src/types/player.types';
import { TeamAuctionState } from '../src/types/auction.types';

const allPlayers: IPLPlayer[] = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'public/data/players_active.json'), 'utf-8')
);

function loadWeights(bidderAI: AuctionBidderAI, suffix: string = '') {
  const map: Array<{ arch: AIArchetype; file: string }> = [
    { arch: 'SUPERSTAR_DUELIST', file: `weights_sd${suffix}.json` },
    { arch: 'MONEYBALL_CORE', file: `weights_mb${suffix}.json` },
    { arch: 'DISCIPLINED_PRAGMATIST', file: `weights_dp${suffix}.json` },
  ];
  for (const item of map) {
    const p = path.resolve(process.cwd(), `public/models/${item.file}`);
    const w = JSON.parse(fs.readFileSync(p, 'utf-8'));
    (bidderAI as any).archetypeWeights.set(item.arch, w);
  }
}

interface AuctionMetrics {
  totalSpentAvg: number;
  remainingPurseAvg: number;
  squadSizeAvg: number;
  superstarAvgPrice: number;    // OVR >= 88
  superstarsBoughtTotal: number;
  coreAvgPrice: number;         // OVR 82 - 87
  coresBoughtTotal: number;
  valueAvgPrice: number;        // OVR < 82
  valuesBoughtTotal: number;
  unsoldTotal: number;
  avgSquadOVR: number;
  avgPlayingXIOVR: number;
  archetypeSuperstarShare: Record<string, number>;
}

interface MatchMetrics {
  totalMatches: number;
  avgInnings1Runs: number;
  avgInnings2Runs: number;
  avgInnings1Wickets: number;
  avgInnings2Wickets: number;
  highScoringGames: number; // > 180 runs in inn 1
  lowScoringGames: number;  // < 150 runs in inn 1
  archetypeWinRates: Record<string, { wins: number; matches: number; pct: number }>;
  teamWinRates: Record<string, number>;
  winRateStdDev: number; // Parity metric
}

async function runAuctionSimulation(suffix: string, numAuctions: number): Promise<{
  allAuctionsTeams: Array<Record<string, TeamAuctionState>>;
  auctionMetrics: AuctionMetrics;
}> {
  const bidderAI = new AuctionBidderAI();
  loadWeights(bidderAI, suffix);

  const allAuctionsTeams: Array<Record<string, TeamAuctionState>> = [];
  
  let totalSpentSum = 0;
  let remainingPurseSum = 0;
  let squadSizeSum = 0;
  let superstarPrices: number[] = [];
  let corePrices: number[] = [];
  let valuePrices: number[] = [];
  let unsoldSum = 0;
  let squadOVRSum = 0;
  let xiOVRSum = 0;
  let totalTeamsEvaluated = 0;
  const archSuperstars: Record<string, number> = {
    SUPERSTAR_DUELIST: 0,
    MONEYBALL_CORE: 0,
    DISCIPLINED_PRAGMATIST: 0
  };

  for (let sim = 0; sim < numAuctions; sim++) {
    const roomCode = `BENCH_${suffix}_${sim}`;
    await bidderAI.initializeAuction(allPlayers);
    const teams = bidderAI.initializeTeams(roomCode, allPlayers);

    // Group players into sets
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

    let unsoldInThisAuction = 0;
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
          const prof = bidderAI.franchiseProfiles.get(res.winnerId);
          if (prof && prof.archetype) {
            archSuperstars[prof.archetype] = (archSuperstars[prof.archetype] || 0) + 1;
          }
        } else if (ovr >= 82) {
          corePrices.push(res.soldPrice);
        } else {
          valuePrices.push(res.soldPrice);
        }
      } else {
        unsoldInThisAuction++;
      }
    }

    unsoldSum += unsoldInThisAuction;

    for (const [tId, t] of Object.entries(teams)) {
      totalSpentSum += (125.0 - t.purse);
      remainingPurseSum += t.purse;
      squadSizeSum += t.squad.length;

      // Auto-fill safety if < 18 players
      const assignedIds = new Set(t.squad.map(p => p.id));
      const pool = allPlayers.filter(p => !assignedIds.has(p.id));
      let pIdx = 0;
      while (t.squad.length < 18 && pIdx < pool.length) {
        t.squad.push(pool[pIdx++]);
      }
      TeamMaker.ensureSquadBowlingCapacity(t.squad);

      const teamOvr = t.squad.reduce((sum, p) => sum + (p.stats?.ovr ?? 72), 0) / t.squad.length;
      squadOVRSum += teamOvr;

      const lineup = TeamMaker.makeSmartLineup(tId, t.squad);
      const xi = (lineup.playing11Ids || []).map(id => t.squad.find(p => p.id === id)!).filter(Boolean);
      const xiOvr = xi.reduce((sum, p) => sum + (p.stats?.ovr ?? 72), 0) / (xi.length || 1);
      xiOVRSum += xiOvr;

      totalTeamsEvaluated++;
    }

    allAuctionsTeams.push(teams);
  }

  const auctionMetrics: AuctionMetrics = {
    totalSpentAvg: totalSpentSum / totalTeamsEvaluated,
    remainingPurseAvg: remainingPurseSum / totalTeamsEvaluated,
    squadSizeAvg: squadSizeSum / totalTeamsEvaluated,
    superstarAvgPrice: superstarPrices.reduce((a, b) => a + b, 0) / (superstarPrices.length || 1),
    superstarsBoughtTotal: superstarPrices.length,
    coreAvgPrice: corePrices.reduce((a, b) => a + b, 0) / (corePrices.length || 1),
    coresBoughtTotal: corePrices.length,
    valueAvgPrice: valuePrices.reduce((a, b) => a + b, 0) / (valuePrices.length || 1),
    valuesBoughtTotal: valuePrices.length,
    unsoldTotal: Math.round(unsoldSum / numAuctions),
    avgSquadOVR: squadOVRSum / totalTeamsEvaluated,
    avgPlayingXIOVR: xiOVRSum / totalTeamsEvaluated,
    archetypeSuperstarShare: archSuperstars
  };

  return { allAuctionsTeams, auctionMetrics };
}

async function runMatchSimulation(
  teamsList: Array<Record<string, TeamAuctionState>>,
  numMatches: number
): Promise<MatchMetrics> {
  const sim = new FullMatchSimulator();
  await sim.init();
  sim.setSimAlpha(0.80);

  const teamIds = DEFAULT_IPL_FRANCHISES.map(f => f.id);
  const teamWins: Record<string, number> = {};
  const teamMatches: Record<string, number> = {};
  for (const id of teamIds) {
    teamWins[id] = 0;
    teamMatches[id] = 0;
  }

  let inn1RunsSum = 0;
  let inn2RunsSum = 0;
  let inn1WicketsSum = 0;
  let inn2WicketsSum = 0;
  let highScoring = 0;
  let lowScoring = 0;

  // Track wins by archetype
  const archStats: Record<string, { wins: number; matches: number }> = {
    SUPERSTAR_DUELIST: { wins: 0, matches: 0 },
    MONEYBALL_CORE: { wins: 0, matches: 0 },
    DISCIPLINED_PRAGMATIST: { wins: 0, matches: 0 }
  };

  // Archetype lookup map for default franchises
  const franchiseArchMap: Record<string, AIArchetype> = {
    CSK: 'SUPERSTAR_DUELIST',
    MI: 'SUPERSTAR_DUELIST',
    RCB: 'SUPERSTAR_DUELIST',
    KKR: 'MONEYBALL_CORE',
    RR: 'MONEYBALL_CORE',
    SRH: 'MONEYBALL_CORE',
    DC: 'DISCIPLINED_PRAGMATIST',
    PBKS: 'DISCIPLINED_PRAGMATIST',
    GT: 'DISCIPLINED_PRAGMATIST',
    LSG: 'DISCIPLINED_PRAGMATIST'
  };

  let simulatedMatches = 0;
  let auctionIdx = 0;

  while (simulatedMatches < numMatches) {
    const currentTeams = teamsList[auctionIdx % teamsList.length];
    auctionIdx++;

    // Pick two random distinct teams
    const idA = teamIds[Math.floor(Math.random() * teamIds.length)];
    let idB = teamIds[Math.floor(Math.random() * teamIds.length)];
    while (idB === idA) {
      idB = teamIds[Math.floor(Math.random() * teamIds.length)];
    }

    const tA = currentTeams[idA];
    const tB = currentTeams[idB];

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

    const res = await sim.simulateFullMatch(simulatedMatches + 1, simTeamA, simTeamB);

    inn1RunsSum += res.innings1.totalRuns;
    inn2RunsSum += res.innings2.totalRuns;
    inn1WicketsSum += res.innings1.totalWickets;
    inn2WicketsSum += res.innings2.totalWickets;

    if (res.innings1.totalRuns >= 180) highScoring++;
    if (res.innings1.totalRuns < 150) lowScoring++;

    teamMatches[idA]++;
    teamMatches[idB]++;

    const archA = franchiseArchMap[idA] || 'MONEYBALL_CORE';
    const archB = franchiseArchMap[idB] || 'MONEYBALL_CORE';
    archStats[archA].matches++;
    archStats[archB].matches++;

    if (res.winnerTeamId === idA) {
      teamWins[idA]++;
      archStats[archA].wins++;
    } else if (res.winnerTeamId === idB) {
      teamWins[idB]++;
      archStats[archB].wins++;
    }

    simulatedMatches++;
  }

  const teamWinRates: Record<string, number> = {};
  const ratesList: number[] = [];
  for (const id of teamIds) {
    const rate = teamMatches[id] > 0 ? (teamWins[id] / teamMatches[id]) * 100 : 0;
    teamWinRates[id] = Math.round(rate * 10) / 10;
    ratesList.push(rate);
  }

  const meanRate = ratesList.reduce((a, b) => a + b, 0) / ratesList.length;
  const variance = ratesList.reduce((sum, r) => sum + Math.pow(r - meanRate, 2), 0) / ratesList.length;
  const winRateStdDev = Math.round(Math.sqrt(variance) * 100) / 100;

  const archetypeWinRates: Record<string, { wins: number; matches: number; pct: number }> = {};
  for (const [arch, stats] of Object.entries(archStats)) {
    archetypeWinRates[arch] = {
      wins: stats.wins,
      matches: stats.matches,
      pct: stats.matches > 0 ? Math.round((stats.wins / stats.matches) * 1000) / 10 : 0
    };
  }

  return {
    totalMatches: simulatedMatches,
    avgInnings1Runs: Math.round(inn1RunsSum / simulatedMatches),
    avgInnings2Runs: Math.round(inn2RunsSum / simulatedMatches),
    avgInnings1Wickets: Math.round((inn1WicketsSum / simulatedMatches) * 10) / 10,
    avgInnings2Wickets: Math.round((inn2WicketsSum / simulatedMatches) * 10) / 10,
    highScoringGames: highScoring,
    lowScoringGames: lowScoring,
    archetypeWinRates,
    teamWinRates,
    winRateStdDev
  };
}

async function main() {
  console.log('================================================================');
  console.log('       IPL AI BENCHMARK: CURRENT AI VS TUNED AI (v3.0)          ');
  console.log('================================================================');
  console.log('1. Running 10 Auctions + 100 Matches for CURRENT AI...');
  const currentResults = await runAuctionSimulation('', 10);
  const currentMatchResults = await runMatchSimulation(currentResults.allAuctionsTeams, 100);

  console.log('2. Running 10 Auctions + 100 Matches for TUNED AI...');
  const tunedResults = await runAuctionSimulation('_tuned', 10);
  const tunedMatchResults = await runMatchSimulation(tunedResults.allAuctionsTeams, 100);

  const report = {
    auctionsRun: 10,
    matchesSimulated: 100,
    currentAI: {
      auction: currentResults.auctionMetrics,
      match: currentMatchResults
    },
    tunedAI: {
      auction: tunedResults.auctionMetrics,
      match: tunedMatchResults
    }
  };

  fs.writeFileSync(
    path.resolve(process.cwd(), 'benchmark_report.json'),
    JSON.stringify(report, null, 2),
    'utf-8'
  );

  console.log('\n====================== BENCHMARK SUMMARY ======================');
  console.log('METRIC                              | CURRENT AI   | TUNED AI');
  console.log('------------------------------------+--------------+-------------');
  console.log(`Avg Purse Spent (Cr)                | ${report.currentAI.auction.totalSpentAvg.toFixed(2).padStart(12)} | ${report.tunedAI.auction.totalSpentAvg.toFixed(2).padStart(11)}`);
  console.log(`Avg Rem. Purse (Cr)                 | ${report.currentAI.auction.remainingPurseAvg.toFixed(2).padStart(12)} | ${report.tunedAI.auction.remainingPurseAvg.toFixed(2).padStart(11)}`);
  console.log(`Avg Squad Size                      | ${report.currentAI.auction.squadSizeAvg.toFixed(1).padStart(12)} | ${report.tunedAI.auction.squadSizeAvg.toFixed(1).padStart(11)}`);
  console.log(`Superstar Avg Price (OVR >= 88)     | ${report.currentAI.auction.superstarAvgPrice.toFixed(2).padStart(12)} | ${report.tunedAI.auction.superstarAvgPrice.toFixed(2).padStart(11)}`);
  console.log(`Core Star Avg Price (OVR 82-87)     | ${report.currentAI.auction.coreAvgPrice.toFixed(2).padStart(12)} | ${report.tunedAI.auction.coreAvgPrice.toFixed(2).padStart(11)}`);
  console.log(`Value / Steal Avg Price (OVR < 82)  | ${report.currentAI.auction.valueAvgPrice.toFixed(2).padStart(12)} | ${report.tunedAI.auction.valueAvgPrice.toFixed(2).padStart(11)}`);
  console.log(`Avg Squad OVR                       | ${report.currentAI.auction.avgSquadOVR.toFixed(2).padStart(12)} | ${report.tunedAI.auction.avgSquadOVR.toFixed(2).padStart(11)}`);
  console.log(`Avg Playing XI OVR                  | ${report.currentAI.auction.avgPlayingXIOVR.toFixed(2).padStart(12)} | ${report.tunedAI.auction.avgPlayingXIOVR.toFixed(2).padStart(11)}`);
  console.log(`League Parity (Win Rate Std Dev)    | ${report.currentAI.match.winRateStdDev.toFixed(2).padStart(12)} | ${report.tunedAI.match.winRateStdDev.toFixed(2).padStart(11)}`);
  console.log(`Superstar Duelist Win Rate %        | ${report.currentAI.match.archetypeWinRates['SUPERSTAR_DUELIST'].pct.toFixed(1).padStart(12)} | ${report.tunedAI.match.archetypeWinRates['SUPERSTAR_DUELIST'].pct.toFixed(1).padStart(11)}`);
  console.log(`Moneyball Core Win Rate %           | ${report.currentAI.match.archetypeWinRates['MONEYBALL_CORE'].pct.toFixed(1).padStart(12)} | ${report.tunedAI.match.archetypeWinRates['MONEYBALL_CORE'].pct.toFixed(1).padStart(11)}`);
  console.log(`Disciplined Pragmatist Win Rate %   | ${report.currentAI.match.archetypeWinRates['DISCIPLINED_PRAGMATIST'].pct.toFixed(1).padStart(12)} | ${report.tunedAI.match.archetypeWinRates['DISCIPLINED_PRAGMATIST'].pct.toFixed(1).padStart(11)}`);
  console.log('================================================================\n');
}

main().catch(console.error);

import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { AuctionBidderAI, DEFAULT_IPL_FRANCHISES, AIArchetype, forwardPolicyNet } from '../src/server/auction/bidderAI';
import { FullMatchSimulator, Team2026 } from '../src/server/match/fullMatchSimulator';
import { TeamMaker } from '../src/server/match/teamMaker';
import { IPLPlayer } from '../src/types/player.types';
import { TeamAuctionState } from '../src/types/auction.types';

const allPlayers: IPLPlayer[] = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'public/data/players_active.json'), 'utf-8')
);

// Load v3.0 weights
const v3WeightsMap: Map<AIArchetype, any> = new Map();
const archetypeFileMap: { arch: AIArchetype; filename: string }[] = [
  { arch: 'SUPERSTAR_DUELIST', filename: 'weights_sd.json' },
  { arch: 'MONEYBALL_CORE', filename: 'weights_mb.json' },
  { arch: 'DISCIPLINED_PRAGMATIST', filename: 'weights_dp.json' }
];
for (const { arch, filename } of archetypeFileMap) {
  const p = path.resolve(process.cwd(), `public/models/${filename}`);
  v3WeightsMap.set(arch, JSON.parse(fs.readFileSync(p, 'utf-8')));
}

class DualVersionAuctionAI extends AuctionBidderAI {
  public teamVersionMap: Record<string, 'v2.0' | 'v3.0'> = {};
  public v3Weights: Map<AIArchetype, any> = v3WeightsMap;

  public setTeamVersion(teamId: string, version: 'v2.0' | 'v3.0') {
    this.teamVersionMap[teamId] = version;
  }

  public override evaluateBidEligibility(
    roomCode: string,
    team: TeamAuctionState,
    profile: any,
    player: IPLPlayer,
    currentBidCr: number,
    remPlayers: IPLPlayer[],
    lotIdx: number,
    phase: any
  ): any {
    const ver = this.teamVersionMap[team.franchiseId] || 'v3.0';
    if (ver === 'v2.0') {
      (this as any).archetypeWeights = new Map();
      const res = super.evaluateBidEligibility(roomCode, team, profile, player, currentBidCr, remPlayers, lotIdx, phase);
      (this as any).archetypeWeights = this.v3Weights;
      return res;
    } else {
      (this as any).archetypeWeights = this.v3Weights;
      return super.evaluateBidEligibility(roomCode, team, profile, player, currentBidCr, remPlayers, lotIdx, phase);
    }
  }
}

interface AuctionResultSummary {
  modeName: string;
  totalPurseSpentAvg: number;
  remPurseAvg: number;
  avgSquadSize: number;
  superstarsBought: number;
  superstarAvgPrice: number;
  coreBought: number;
  coreAvgPrice: number;
  valueBought: number;
  valueAvgPrice: number;
  unsoldLots: number;
  avgSquadOVR: number;
  avgPlayingXIOVR: number;
  teams: Record<string, {
    version: 'v2.0' | 'v3.0';
    spent: number;
    remPurse: number;
    squadSize: number;
    superstars: number;
    cores: number;
    values: number;
    squadOVR: number;
    xiOVR: number;
  }>;
}

async function runAuctionWithVersions(
  modeName: string,
  teamVersionAssignment: Record<string, 'v2.0' | 'v3.0'>
): Promise<{
  summary: AuctionResultSummary;
  teams: Record<string, TeamAuctionState>;
}> {
  const bidderAI = new DualVersionAuctionAI();
  for (const [tId, ver] of Object.entries(teamVersionAssignment)) {
    bidderAI.setTeamVersion(tId, ver);
  }

  const roomCode = `SIM_${modeName}`;
  await bidderAI.initializeAuction(allPlayers);
  const teams = bidderAI.initializeTeams(roomCode, allPlayers);

  // Group players by marquee set and shuffle within each set
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

  let superstarPrices: number[] = [];
  let corePrices: number[] = [];
  let valuePrices: number[] = [];
  let unsoldLots = 0;

  const teamBreakdowns: Record<string, any> = {};
  for (const tId of Object.keys(teams)) {
    teamBreakdowns[tId] = {
      version: teamVersionAssignment[tId] || 'v3.0',
      spent: 0,
      remPurse: 125.0,
      squadSize: 0,
      superstars: 0,
      cores: 0,
      values: 0,
      squadOVR: 0,
      xiOVR: 0
    };
  }

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
        teamBreakdowns[res.winnerId].superstars++;
      } else if (ovr >= 82) {
        corePrices.push(res.soldPrice);
        teamBreakdowns[res.winnerId].cores++;
      } else {
        valuePrices.push(res.soldPrice);
        teamBreakdowns[res.winnerId].values++;
      }
    } else {
      unsoldLots++;
    }
  }

  let totalSpent = 0;
  let totalRem = 0;
  let totalSquad = 0;
  let totalSquadOVR = 0;
  let totalXIOVR = 0;

  for (const [tId, t] of Object.entries(teams)) {
    const spent = Math.round((125.0 - t.purse) * 100) / 100;
    const rem = Math.round(t.purse * 100) / 100;
    totalSpent += spent;
    totalRem += rem;
    totalSquad += t.squad.length;

    // Auto-fill safety if < 18 players
    const assignedIds = new Set(t.squad.map(p => p.id));
    const pool = allPlayers.filter(p => !assignedIds.has(p.id));
    let pIdx = 0;
    while (t.squad.length < 18 && pIdx < pool.length) {
      t.squad.push(pool[pIdx++]);
    }
    TeamMaker.ensureSquadBowlingCapacity(t.squad);

    const squadOvr = Math.round((t.squad.reduce((sum, p) => sum + (p.stats?.ovr ?? 72), 0) / t.squad.length) * 10) / 10;
    const lineup = TeamMaker.makeSmartLineup(tId, t.squad);
    const xi = (lineup.playing11Ids || []).map(id => t.squad.find(p => p.id === id)!).filter(Boolean);
    const xiOvr = Math.round((xi.reduce((sum, p) => sum + (p.stats?.ovr ?? 72), 0) / (xi.length || 1)) * 10) / 10;

    totalSquadOVR += squadOvr;
    totalXIOVR += xiOvr;

    teamBreakdowns[tId].spent = spent;
    teamBreakdowns[tId].remPurse = rem;
    teamBreakdowns[tId].squadSize = t.squad.length;
    teamBreakdowns[tId].squadOVR = squadOvr;
    teamBreakdowns[tId].xiOVR = xiOvr;
  }

  const numTeams = Object.keys(teams).length;
  const summary: AuctionResultSummary = {
    modeName,
    totalPurseSpentAvg: Math.round((totalSpent / numTeams) * 100) / 100,
    remPurseAvg: Math.round((totalRem / numTeams) * 100) / 100,
    avgSquadSize: Math.round((totalSquad / numTeams) * 10) / 10,
    superstarsBought: superstarPrices.length,
    superstarAvgPrice: superstarPrices.length > 0 ? Math.round((superstarPrices.reduce((a, b) => a + b, 0) / superstarPrices.length) * 100) / 100 : 0,
    coreBought: corePrices.length,
    coreAvgPrice: corePrices.length > 0 ? Math.round((corePrices.reduce((a, b) => a + b, 0) / corePrices.length) * 100) / 100 : 0,
    valueBought: valuePrices.length,
    valueAvgPrice: valuePrices.length > 0 ? Math.round((valuePrices.reduce((a, b) => a + b, 0) / valuePrices.length) * 100) / 100 : 0,
    unsoldLots,
    avgSquadOVR: Math.round((totalSquadOVR / numTeams) * 10) / 10,
    avgPlayingXIOVR: Math.round((totalXIOVR / numTeams) * 10) / 10,
    teams: teamBreakdowns
  };

  return { summary, teams };
}

// Function to simulate matches between v3.0 teams and v2.0 teams from the mixed auction
async function simulateV3vsV2Matches(
  teams: Record<string, TeamAuctionState>,
  v3TeamIds: string[],
  v2TeamIds: string[],
  numMatches: number = 50
) {
  const sim = new FullMatchSimulator();
  await sim.init();
  sim.setSimAlpha(0.80);

  let v3Wins = 0;
  let v2Wins = 0;
  let v3TotalRuns = 0;
  let v2TotalRuns = 0;
  let v3TotalWickets = 0;
  let v2TotalWickets = 0;

  for (let m = 0; m < numMatches; m++) {
    const id3 = v3TeamIds[m % v3TeamIds.length];
    const id2 = v2TeamIds[(m * 3 + 1) % v2TeamIds.length];

    const t3 = teams[id3];
    const t2 = teams[id2];

    const lineup3 = TeamMaker.makeSmartLineup(t3.franchiseId, t3.squad);
    const lineup2 = TeamMaker.makeSmartLineup(t2.franchiseId, t2.squad);

    const xi3 = (lineup3.playing11Ids || []).map(id => t3.squad.find(p => p.id === id)!).filter(Boolean);
    const xi2 = (lineup2.playing11Ids || []).map(id => t2.squad.find(p => p.id === id)!).filter(Boolean);

    const death3 = lineup3.bowlerPool352.deathBowlerIds || [];
    const death2 = lineup2.bowlerPool352.deathBowlerIds || [];

    const simTeam3: Team2026 = {
      id: t3.franchiseId,
      name: t3.name,
      playingXI: xi3,
      primaryBowlers: lineup3.bowlerPool352.middleBowlerIds,
      powerplayBowlers: lineup3.bowlerPool352.powerplayBowlerIds,
      deathBowlers: death3.length === 2 ? death3 : (lineup3.bowlerPool352.deathBowlerIds || []),
      firstBowlerId: lineup3.bowlerPool352.firstBowlerId,
      backupBowlerId: lineup3.bowlerPool352.backupBowlerId,
      bowlerPool352: lineup3.bowlerPool352
    };

    const simTeam2: Team2026 = {
      id: t2.franchiseId,
      name: t2.name,
      playingXI: xi2,
      primaryBowlers: lineup2.bowlerPool352.middleBowlerIds,
      powerplayBowlers: lineup2.bowlerPool352.powerplayBowlerIds,
      deathBowlers: death2.length === 2 ? death2 : (lineup2.bowlerPool352.deathBowlerIds || []),
      firstBowlerId: lineup2.bowlerPool352.firstBowlerId,
      backupBowlerId: lineup2.bowlerPool352.backupBowlerId,
      bowlerPool352: lineup2.bowlerPool352
    };

    const res = await sim.simulateFullMatch(m + 1, simTeam3, simTeam2);

    const inn3 = res.innings1.teamId === id3 ? res.innings1 : res.innings2;
    const inn2 = res.innings1.teamId === id2 ? res.innings1 : res.innings2;

    v3TotalRuns += inn3.totalRuns;
    v3TotalWickets += inn3.totalWickets;
    v2TotalRuns += inn2.totalRuns;
    v2TotalWickets += inn2.totalWickets;

    if (res.winnerTeamId === id3) {
      v3Wins++;
    } else if (res.winnerTeamId === id2) {
      v2Wins++;
    }
  }

  return {
    matchesPlayed: numMatches,
    v3Wins,
    v2Wins,
    v3WinPct: Math.round((v3Wins / numMatches) * 1000) / 10,
    v2WinPct: Math.round((v2Wins / numMatches) * 1000) / 10,
    v3AvgRuns: Math.round(v3TotalRuns / numMatches),
    v2AvgRuns: Math.round(v2TotalRuns / numMatches),
    v3AvgWickets: Math.round((v3TotalWickets / numMatches) * 10) / 10,
    v2AvgWickets: Math.round((v2TotalWickets / numMatches) * 10) / 10
  };
}

// Microbenchmark for forward pass speed on CPU
function benchmarkInferenceSpeed() {
  const dummyInput = new Float32Array(18);
  for (let i = 0; i < 18; i++) dummyInput[i] = (i - 9) / 10.0;
  const weights = v3WeightsMap.get('SUPERSTAR_DUELIST');

  // Warmup
  for (let i = 0; i < 1000; i++) forwardPolicyNet(dummyInput, weights);

  const N = 50000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    forwardPolicyNet(dummyInput, weights);
  }
  const t1 = performance.now();
  const totalMs = t1 - t0;
  const usPerInference = (totalMs / N) * 1000;
  const inferencesPerSec = Math.round((N / (totalMs / 1000)));

  return {
    totalInferences: N,
    totalTimeMs: totalMs.toFixed(2),
    microsecondsPerInference: usPerInference.toFixed(3),
    inferencesPerSec
  };
}

async function main() {
  console.log('================================================================');
  console.log('         IPL AUCTION EXPERIMENT: v3.0 NEURAL VS v2.0 ANALYTICAL  ');
  console.log('================================================================');

  // 1. Isolated Auction: Pure v3.0 (All 10 teams use v3.0)
  console.log('\n--- Running Experiment 1: Isolated Pure v3.0 Auction (All 10 Teams v3.0) ---');
  const allV3Config: Record<string, 'v2.0' | 'v3.0'> = {};
  for (const f of DEFAULT_IPL_FRANCHISES) allV3Config[f.id] = 'v3.0';
  const { summary: isolatedV3 } = await runAuctionWithVersions('ISOLATED_V3', allV3Config);

  // 2. Isolated Auction: Pure v2.0 (All 10 teams use v2.0)
  console.log('--- Running Experiment 2: Isolated Pure v2.0 Auction (All 10 Teams v2.0) ---');
  const allV2Config: Record<string, 'v2.0' | 'v3.0'> = {};
  for (const f of DEFAULT_IPL_FRANCHISES) allV2Config[f.id] = 'v2.0';
  const { summary: isolatedV2 } = await runAuctionWithVersions('ISOLATED_V2', allV2Config);

  // 3. Mixed "All With" Head-to-Head Auction: 5 Teams v3.0 vs 5 Teams v2.0
  console.log('--- Running Experiment 3: Mixed Auction (5 Teams v3.0 vs 5 Teams v2.0 in Same Room) ---');
  const mixedConfig: Record<string, 'v2.0' | 'v3.0'> = {
    CSK: 'v3.0',
    MI: 'v3.0',
    RCB: 'v3.0',
    KKR: 'v3.0',
    RR: 'v3.0',
    SRH: 'v2.0',
    DC: 'v2.0',
    PBKS: 'v2.0',
    GT: 'v2.0',
    LSG: 'v2.0'
  };
  const { summary: mixedSummary, teams: mixedTeams } = await runAuctionWithVersions('MIXED_HEAD_TO_HEAD', mixedConfig);

  // 4. Simulate 50 Matches between v3.0 Teams and v2.0 Teams from the Mixed Auction
  console.log('--- Simulating 50 Head-to-Head Matches (v3.0 Squads vs v2.0 Squads) ---');
  const v3TeamIds = ['CSK', 'MI', 'RCB', 'KKR', 'RR'];
  const v2TeamIds = ['SRH', 'DC', 'PBKS', 'GT', 'LSG'];
  const matchResults = await simulateV3vsV2Matches(mixedTeams, v3TeamIds, v2TeamIds, 50);

  // 5. Run CPU Inference Speed Benchmark
  console.log('--- Measuring Real-Time Forward Pass Inference Latency ---');
  const perfStats = benchmarkInferenceSpeed();

  const finalOutput = {
    isolatedV3,
    isolatedV2,
    mixedSummary,
    matchResults,
    perfStats
  };

  fs.writeFileSync(
    path.resolve(process.cwd(), 'v3_vs_v2_results.json'),
    JSON.stringify(finalOutput, null, 2),
    'utf-8'
  );

  console.log('\n====================== EXPERIMENT COMPLETE ======================');
}

main().catch(console.error);

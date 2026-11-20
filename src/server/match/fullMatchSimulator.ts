/**
 * fullMatchSimulator.ts - Complete 40-Over T20 Match Simulator
 * Simulates real full IPL matches utilizing MatchSimEngine (Model 1 ONNX pipeline).
 * Handles:
 *  - Toss and pitch adaptation
 *  - 20-over tactical bowler rotation (max 4 overs, phase alignment, death over saving)
 *  - Real-time batting tactics driven by Required Run Rate (RRR)
 *  - Complete Scorecards, Fall of Wickets, and Player of the Match selection
 */

import {
  MatchSimEngine,
  OverInputState,
  BatterOverScorecard,
  BowlerOverFigures,
  BattingTactic,
  BowlingTactic,
  SimEngineConfig
} from './simEngine';
import { IPLPlayer, GroundSynergyVector } from '../../types/player.types';
import { OverSummaryEntry } from '../../types/match.types';
import { computePhaseBowlerQuotas, BowlerPhaseQuota, TeamMaker } from './teamMaker';

export interface Team2026 {
  id: string;
  name: string;
  homeVenueName?: string;
  homePitch?: GroundSynergyVector;
  playingXI: IPLPlayer[];
  primaryBowlers: string[];        // 5 Middle bowler IDs
  powerplayBowlers: string[];      // 3 Powerplay bowler IDs
  deathBowlers: string[];          // 2 Death bowler IDs
  firstBowlerId?: string;          // Designated Over 1 bowler ID
  backupBowlerId?: string;         // Designated emergency bowler ID
  bowlerPool352?: {
    powerplayBowlerIds: string[];
    firstBowlerId: string;
    middleBowlerIds: string[];
    deathOver17_19BowlerId?: string;
    deathOver18_20BowlerId?: string;
    deathBowlerIds?: string[];
    backupBowlerId: string;
  };
}

export interface InningsScorecard {
  teamId: string;
  teamName: string;
  totalRuns: number;
  totalWickets: number;
  oversCompleted: number;
  runRate: number;
  battingScorecard: Record<string, BatterOverScorecard>;
  bowlingFigures: Record<string, BowlerOverFigures>;
  fallOfWickets: Array<{ wicketNum: number; score: number; overLabel: string; batterName: string }>;
  overSummaries: Array<{ overNum: number; runs: number; wickets: number; bowlerName: string; scoreSoFar: string }>;
}

export interface MatchResult {
  matchId: string;
  matchNumber: number;
  homeTeamId: string;
  awayTeamId: string;
  venueName: string;
  venuePitch: GroundSynergyVector;
  homeTeam: string;
  awayTeam: string;
  tossWinner: string;
  tossDecision: 'BAT' | 'BOWL';
  innings1: InningsScorecard;
  innings2: InningsScorecard;
  winner: string;
  winnerTeamId: string | null;
  margin: string;
  marginText: string;
  playerOfTheMatch: {
    name: string;
    team: string;
    reason: string;
    impactPoints: number;
  };
  matchHighlights: string[];
  completed: boolean;
  isPlayoff?: boolean;
  playoffStage?: 'QUALIFIER_1' | 'ELIMINATOR' | 'QUALIFIER_2' | 'FINAL';
}

interface BowlerPhaseTracking {
  total: number;
  pp: number;
  mid: number;
  death: number;
}

export class FullMatchSimulator {
  private engine: MatchSimEngine;

  constructor(customConfig?: Partial<SimEngineConfig>) {
    this.engine = new MatchSimEngine(undefined, customConfig);
  }

  public setHostRandomnessScale(determinismRatio: number): void {
    this.engine.setHostRandomnessScale(determinismRatio);
  }

  public setSimAlpha(alpha: number): void {
    this.engine.setSimAlpha(alpha);
  }

  public async init(): Promise<void> {
    await this.engine.init();
  }

  private findPlayer(team: Team2026, identifier: string | undefined): IPLPlayer | undefined {
    if (!identifier) return undefined;
    return team.playingXI.find(p => p.id === identifier || p.name === identifier);
  }

  /**
   * 3-5-2 Phase Bowler Selection with 4-2-2 Quota Engine:
   * - Over 1: designated firstBowlerId
   * - Overs 2-6: Rotate among 3 Powerplay bowlers (max 2 overs each, no consecutive overs)
   * - Overs 7-16: Rotate among 5 Middle bowlers (tactical matchup, remaining quota, no consecutive overs)
   * - Overs 17-20: Alternate between 2 Death bowlers (2 overs each: 17&19 vs 18&20)
   */
  private selectPhaseBowler(
    overIdx: number, // 0..19 (0 = Over 1, 19 = Over 20)
    lastBowlerId: string | null,
    team: Team2026,
    tracking: Record<string, BowlerPhaseTracking>,
    quotas: Record<string, BowlerPhaseQuota>,
    striker: IPLPlayer,
    nonStriker: IPLPlayer
  ): IPLPlayer {
    const ppPool = team.powerplayBowlers || [];
    const midPool = team.primaryBowlers || [];
    const deathPool = team.deathBowlers || [];
    const firstBowlerId = team.firstBowlerId || team.bowlerPool352?.firstBowlerId || ppPool[0];
    const backupBowlerId = team.backupBowlerId || team.bowlerPool352?.backupBowlerId;

    // Frontline Bowler Protection:
    // Only players with role === "PACE" || role === "SPIN" (or "BOWL")
    // or (role === "AR" && subType === "BOWL_AR" && bowl >= 78) are assigned to bowl full 4-over spells.
    // Part-time batting all-rounders (subType === "BAT_AR") are strictly capped at 2 overs.
    const maxBowlerOvers = (p: IPLPlayer) => (TeamMaker.isFrontlineBowler(p) ? 4 : 2);

    // --- PHASE 1: POWERPLAY (Overs 1 to 6) ---
    if (overIdx === 0) {
      // Over 1: designated Over 1 starter
      const designated = this.findPlayer(team, firstBowlerId);
      if (designated) return designated;
    }

    if (overIdx <= 5) {
      // Overs 2-6: rotate among 3 Powerplay bowlers (max 2 PP overs each, no consecutive)
      const eligiblePP = ppPool
        .map(id => this.findPlayer(team, id))
        .filter((p): p is IPLPlayer => {
          if (!p) return false;
          const trk = tracking[p.id];
          return p.id !== lastBowlerId && trk.pp < 2 && trk.total < maxBowlerOvers(p);
        });

      if (eligiblePP.length > 0) {
        // Balance overs among eligible PP bowlers
        eligiblePP.sort((a, b) => {
          const diff = tracking[a.id].pp - tracking[b.id].pp;
          if (diff !== 0) return diff;
          return (b.tacticalSynergy?.powerplay ?? b.stats.bowl) - (a.tacticalSynergy?.powerplay ?? a.stats.bowl);
        });
        return eligiblePP[0];
      }
    }

    // --- PHASE 3: DEATH OVERS (Overs 17 to 20) ---
    if (overIdx >= 16) {
      // Over 17 (overIdx 16) & Over 19 (overIdx 18): deathOver17_19BowlerId
      // Over 18 (overIdx 17) & Over 20 (overIdx 19): deathOver18_20BowlerId
      const targetDeathId = (overIdx === 16 || overIdx === 18)
        ? (team.bowlerPool352?.deathOver17_19BowlerId || deathPool[0])
        : (team.bowlerPool352?.deathOver18_20BowlerId || deathPool[1] || deathPool[0]);

      if (targetDeathId) {
        const targetPlayer = this.findPlayer(team, targetDeathId);
        if (targetPlayer && targetPlayer.id !== lastBowlerId) {
          const trk = tracking[targetPlayer.id];
          if (trk && trk.death < 2 && trk.total < maxBowlerOvers(targetPlayer)) {
            return targetPlayer;
          }
        }
      }

      // Alternate between the 2 death bowlers (Overs 17 & 19 vs 18 & 20, 2 overs each)
      const deathPlayers = deathPool
        .map(id => this.findPlayer(team, id))
        .filter((p): p is IPLPlayer => Boolean(p));

      const eligibleDeath = deathPlayers.filter(p => {
        const trk = tracking[p.id];
        return p.id !== lastBowlerId && trk.death < 2 && trk.total < maxBowlerOvers(p);
      });

      if (eligibleDeath.length > 0) {
        // Pick whichever death bowler didn't bowl the previous death over
        return eligibleDeath[0];
      }
    }

    // --- PHASE 2: MIDDLE OVERS (Overs 7 to 16) ---
    const eligibleMid = midPool
      .map(id => this.findPlayer(team, id))
      .filter((p): p is IPLPlayer => {
        if (!p) return false;
        const trk = tracking[p.id];
        const midMax = quotas[p.id]?.usableMiddleOvers ?? 2;
        return p.id !== lastBowlerId && trk.mid < midMax && trk.total < maxBowlerOvers(p);
      });

    if (eligibleMid.length > 0) {
      // Tactical Matchup Selection: Check crease pair weaknesses (spin vs pace)
      const strikerSpinWeak = (striker.groundVector?.spin ?? 0.5) < (striker.groundVector?.pace ?? 0.5);
      const nonStrikerSpinWeak = (nonStriker.groundVector?.spin ?? 0.5) < (nonStriker.groundVector?.pace ?? 0.5);
      const prioritizeSpin = strikerSpinWeak || nonStrikerSpinWeak;

      eligibleMid.sort((a, b) => {
        let scoreA = b.stats.bowl + (a.tacticalSynergy?.middle ?? 0.3) * 20;
        let scoreB = a.stats.bowl + (b.tacticalSynergy?.middle ?? 0.3) * 20;

        if (prioritizeSpin) {
          if (a.role === 'SPIN') scoreA += 15;
          if (b.role === 'SPIN') scoreB += 15;
        } else {
          if (a.role === 'PACE') scoreA += 10;
          if (b.role === 'PACE') scoreB += 10;
        }

        // Bias towards bowlers who have more remaining middle overs to distribute workload
        const aRemaining = (quotas[a.id]?.usableMiddleOvers ?? 2) - tracking[a.id].mid;
        const bRemaining = (quotas[b.id]?.usableMiddleOvers ?? 2) - tracking[b.id].mid;
        return (scoreA + aRemaining * 5) - (scoreB + bRemaining * 5);
      });

      return eligibleMid[0];
    }

    // --- EMERGENCY FALLBACK (Backup Bowler or any eligible XI player) ---
    const backup = this.findPlayer(team, backupBowlerId);
    if (backup && backup.id !== lastBowlerId && tracking[backup.id]?.total < maxBowlerOvers(backup)) {
      return backup;
    }

    const anyEligible = team.playingXI.filter(p => p.id !== lastBowlerId && (tracking[p.id]?.total ?? 0) < maxBowlerOvers(p));
    if (anyEligible.length > 0) {
      anyEligible.sort((a, b) => b.stats.bowl - a.stats.bowl);
      return anyEligible[0];
    }

    const fallback = team.playingXI.filter(p => p.id !== lastBowlerId && (tracking[p.id]?.total ?? 0) < 4);
    if (fallback.length > 0) {
      fallback.sort((a, b) => b.stats.bowl - a.stats.bowl);
      return fallback[0];
    }

    return team.playingXI[0];
  }

  public async simulateInnings(
    inningsNum: 1 | 2,
    battingTeam: Team2026,
    bowlingTeam: Team2026,
    pitch: GroundSynergyVector,
    targetScore?: number,
    homeTeamId?: string
  ): Promise<InningsScorecard> {
    const battingLineup = [...battingTeam.playingXI];
    const fieldingLineup = [...bowlingTeam.playingXI];

    const battingScorecard: Record<string, BatterOverScorecard> = {};
    const bowlingFigures: Record<string, BowlerOverFigures> = {};
    const fallOfWickets: Array<{ wicketNum: number; score: number; overLabel: string; batterName: string }> = [];
    const overSummaries: OverSummaryEntry[] = [];

    // Pre-calculate 4-2-2 Phase Quotas for the bowling unit
    const bowlingCandidates = fieldingLineup.map(p => p.id);
    const quotasResult = computePhaseBowlerQuotas(
      bowlingCandidates,
      bowlingTeam.powerplayBowlers || [],
      bowlingTeam.deathBowlers || []
    );

    const tracking: Record<string, BowlerPhaseTracking> = {};
    for (const p of fieldingLineup) {
      tracking[p.id] = { total: 0, pp: 0, mid: 0, death: 0 };
    }

    let currentScore = 0;
    let wicketsDown = 0;
    let nextBatterIndex = 2;

    let activeStriker: BatterOverScorecard = {
      id: battingLineup[0].id,
      name: battingLineup[0].name,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      isOut: false
    };

    let activeNonStriker: BatterOverScorecard = {
      id: battingLineup[1].id,
      name: battingLineup[1].name,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      isOut: false
    };

    battingScorecard[activeStriker.name] = activeStriker;
    battingScorecard[activeNonStriker.name] = activeNonStriker;

    let lastBowlerId: string | null = null;

    for (let overIdx = 0; overIdx < 20; overIdx++) {
      if (wicketsDown >= 10) break;
      if (inningsNum === 2 && targetScore && currentScore >= targetScore) break;

      const strikerPlayer = battingLineup.find(p => p.id === activeStriker.id || p.name === activeStriker.name) || battingLineup[0];
      const nonStrikerPlayer = battingLineup.find(p => p.id === activeNonStriker.id || p.name === activeNonStriker.name) || battingLineup[1];

      // Select bowler obeying 3-5-2 rotation & 4-2-2 quotas
      const bowlerPlayer = this.selectPhaseBowler(
        overIdx,
        lastBowlerId,
        bowlingTeam,
        tracking,
        quotasResult.quotas,
        strikerPlayer,
        nonStrikerPlayer
      );

      // Record phase tracking
      if (!tracking[bowlerPlayer.id]) {
        tracking[bowlerPlayer.id] = { total: 0, pp: 0, mid: 0, death: 0 };
      }
      tracking[bowlerPlayer.id].total++;
      if (overIdx <= 5) tracking[bowlerPlayer.id].pp++;
      else if (overIdx >= 16) tracking[bowlerPlayer.id].death++;
      else tracking[bowlerPlayer.id].mid++;

      lastBowlerId = bowlerPlayer.id;

      if (!bowlingFigures[bowlerPlayer.name]) {
        bowlingFigures[bowlerPlayer.name] = {
          id: bowlerPlayer.id,
          name: bowlerPlayer.name,
          teamId: bowlingTeam.id,
          teamName: bowlingTeam.name,
          overs: 0,
          maidens: 0,
          runsConceded: 0,
          wickets: 0,
          dots: 0
        };
      }
      const bowlerFig = bowlingFigures[bowlerPlayer.name];

      let battingTactic: BattingTactic = 'BALANCED';
      let bowlingTactic: BowlingTactic = 'STANDARD';

      if (overIdx <= 5) {
        battingTactic = 'AGGRESSIVE';
        bowlingTactic = 'ATTACK';
      } else if (overIdx >= 16) {
        battingTactic = 'AGGRESSIVE';
        bowlingTactic = 'CONTAIN';
      } else if (inningsNum === 2 && targetScore) {
        const ballsLeft = (20 - overIdx) * 6;
        const runsNeeded = targetScore - currentScore;
        const rrr = runsNeeded / (ballsLeft / 6.0);
        if (rrr >= 11.0) battingTactic = 'AGGRESSIVE';
        else if (rrr <= 6.5 && wicketsDown <= 4) battingTactic = 'BALANCED';
        else if (wicketsDown >= 7) battingTactic = 'DEFENSIVE';
      }

      const overInput: OverInputState = {
        overNumber: overIdx,
        innings: inningsNum,
        currentScore,
        wicketsDown,
        targetScore,
        striker: strikerPlayer,
        nonStriker: nonStrikerPlayer,
        bowler: bowlerPlayer,
        pitch,
        battingTactic,
        bowlingTactic,
        strikerBallsFaced: activeStriker.balls,
        bowlerOversBowled: bowlerFig.overs,
        battingTeamLineup: battingLineup,
        fieldingTeamLineup: fieldingLineup,
        isBattingTeamHome: battingTeam.id === homeTeamId,
        isBowlingTeamHome: bowlingTeam.id === homeTeamId
      };

      const bench = battingLineup.slice(nextBatterIndex);
      const overResult = await this.engine.simulateOver(
        overInput,
        activeStriker,
        activeNonStriker,
        bowlerFig,
        bench
      );

      if (overResult.dismissedBatters && overResult.dismissedBatters.length > 0) {
        for (const dismissed of overResult.dismissedBatters) {
          battingScorecard[dismissed.name] = dismissed;
        }
      }

      if (overResult.wicketsLost > 0) {
        for (const b of overResult.balls) {
          if (b.isWicket && b.playerOut) {
            fallOfWickets.push({
              wicketNum: fallOfWickets.length + 1,
              score: overResult.inningsCumulativeScore,
              overLabel: b.ballLabel,
              batterName: b.playerOut
            });
          }
        }
        nextBatterIndex += overResult.wicketsLost;
      }

      currentScore = overResult.inningsCumulativeScore;
      wicketsDown = overResult.inningsCumulativeWickets;

      activeStriker = overResult.strikerAfterOver;
      activeNonStriker = overResult.nonStrikerAfterOver;
      battingScorecard[activeStriker.name] = activeStriker;
      battingScorecard[activeNonStriker.name] = activeNonStriker;

      bowlingFigures[bowlerPlayer.name] = overResult.bowlerAfterOver;

      // Simplified Per-Over Stamina Drain:
      // - Active batters at the crease: -0.5 stamina
      // - Active bowler: -0.5 stamina
      // - All other players in Playing 11 (fielders / dugout): -0.1 stamina
      for (const p of battingLineup) {
        const isAtCrease = p.id === strikerPlayer.id || p.id === nonStrikerPlayer.id;
        const drain = isAtCrease ? 0.5 : 0.1;
        const cur = p.stamina ?? p.stats?.staminaRecov ?? 80.0;
        p.stamina = Math.round(Math.max(0, cur - drain) * 10) / 10;
      }
      for (const p of fieldingLineup) {
        const isBowling = p.id === bowlerPlayer.id;
        const drain = isBowling ? 0.5 : 0.1;
        const cur = p.stamina ?? p.stats?.staminaRecov ?? 80.0;
        p.stamina = Math.round(Math.max(0, cur - drain) * 10) / 10;
      }

      const overFours = overResult.balls ? overResult.balls.filter(b => b.runsOffBat === 4).length : 0;
      const overSixes = overResult.balls ? overResult.balls.filter(b => b.runsOffBat === 6).length : 0;
      const overDots = overResult.balls ? overResult.balls.filter(b => b.runsOffBat === 0 && !b.extras && !b.isWicket).length : 0;
      const phaseName: 'POWERPLAY' | 'MIDDLE' | 'DEATH' = overIdx <= 5 ? 'POWERPLAY' : overIdx >= 16 ? 'DEATH' : 'MIDDLE';

      overSummaries.push({
        overNum: overIdx + 1,
        runs: overResult.runsScored,
        wickets: overResult.wicketsLost,
        bowlerName: bowlerPlayer.name,
        strikerName: activeStriker.name,
        nonStrikerName: activeNonStriker.name,
        scoreSoFar: `${currentScore}/${wicketsDown}`,
        cumulativeRuns: currentScore,
        cumulativeWickets: wicketsDown,
        fours: overFours,
        sixes: overSixes,
        dots: overDots,
        phase: phaseName
      });
    }

    const oversCompleted = overSummaries.length;
    const runRate = oversCompleted > 0 ? Math.round((currentScore / oversCompleted) * 100) / 100 : 0;

    // Ensure strike rates & dismissal texts are clean on batting scorecard
    for (const b of Object.values(battingScorecard)) {
      b.teamId = battingTeam.id;
      b.teamName = battingTeam.name;
      if (!b.strikeRate && b.balls > 0) {
        b.strikeRate = Math.round((b.runs / b.balls) * 10000) / 100;
      }
      if (!b.dismissalText) {
        b.dismissalText = b.isOut ? 'out' : 'not out';
      }
    }
    // Ensure economies are clean on bowling figures
    for (const bw of Object.values(bowlingFigures)) {
      bw.teamId = bowlingTeam.id;
      bw.teamName = bowlingTeam.name;
      if (!bw.economy && bw.overs > 0) {
        bw.economy = Math.round((bw.runsConceded / bw.overs) * 100) / 100;
      }
    }

    return {
      teamId: battingTeam.id,
      teamName: battingTeam.name,
      totalRuns: currentScore,
      totalWickets: wicketsDown,
      oversCompleted,
      runRate,
      battingScorecard,
      bowlingFigures,
      fallOfWickets,
      overSummaries
    };
  }

  public async simulateFullMatch(
    matchNumber: number,
    teamA: Team2026,
    teamB: Team2026,
    venueName?: string,
    pitch?: GroundSynergyVector
  ): Promise<MatchResult> {
    await this.init();

    const selectedVenue = venueName || teamA.homeVenueName || 'Narendra Modi Stadium';
    const selectedPitch = pitch || teamA.homePitch || { spin: 0.2, pace: 0.5, power: 0.6, dew: 0.5 };

    const tossWinner = Math.random() < 0.5 ? teamA : teamB;
    const tossLoser = tossWinner.id === teamA.id ? teamB : teamA;
    const tossDecision: 'BAT' | 'BOWL' = (selectedPitch.dew || 0) >= 0.65 ? 'BOWL' : (Math.random() < 0.5 ? 'BAT' : 'BOWL');

    let batting1st: Team2026;
    let bowling1st: Team2026;
    if (tossDecision === 'BAT') {
      batting1st = tossWinner;
      bowling1st = tossLoser;
    } else {
      batting1st = tossLoser;
      bowling1st = tossWinner;
    }

    const inn1 = await this.simulateInnings(1, batting1st, bowling1st, selectedPitch, undefined, teamA.id);
    const target = inn1.totalRuns + 1;
    const inn2 = await this.simulateInnings(2, bowling1st, batting1st, selectedPitch, target, teamA.id);

    let winner = '';
    let winnerTeamId: string | null = null;
    let margin = '';

    if (inn2.totalRuns >= target) {
      winner = bowling1st.name;
      winnerTeamId = bowling1st.id;
      const wicketsRemaining = 10 - inn2.totalWickets;
      const ballsRemaining = Math.max(0, (20 - inn2.oversCompleted) * 6);
      margin = `${wicketsRemaining} wicket${wicketsRemaining > 1 ? 's' : ''} (with ${ballsRemaining} balls to spare)`;
    } else if (inn2.totalRuns < inn1.totalRuns) {
      winner = batting1st.name;
      winnerTeamId = batting1st.id;
      const runDiff = inn1.totalRuns - inn2.totalRuns;
      margin = `${runDiff} run${runDiff > 1 ? 's' : ''}`;
    } else {
      winner = 'Match Tied (Super Over)';
      winnerTeamId = null;
      margin = 'Scores Level!';
    }

    const impactScores: Array<{ name: string; team: string; points: number; desc: string }> = [];

    for (const b of Object.values(inn1.battingScorecard)) {
      const pts = b.runs * 1.0 + b.fours * 1.0 + b.sixes * 2.0;
      if (pts > 15) impactScores.push({ name: b.name, team: inn1.teamName, points: pts, desc: `${b.runs} runs (${b.balls} balls)` });
    }
    for (const bw of Object.values(inn1.bowlingFigures)) {
      const econBonus = bw.overs > 1 ? Math.max(0, (8.0 - (bw.runsConceded / bw.overs)) * 4.0) : 0;
      const pts = bw.wickets * 25.0 + bw.maidens * 15.0 + bw.dots * 1.5 + econBonus;
      if (pts > 20) impactScores.push({ name: bw.name, team: inn2.teamName, points: pts, desc: `${bw.wickets}/${bw.runsConceded} (${bw.overs} ov)` });
    }

    for (const b of Object.values(inn2.battingScorecard)) {
      const pts = b.runs * 1.0 + b.fours * 1.0 + b.sixes * 2.0;
      if (pts > 15) impactScores.push({ name: b.name, team: inn2.teamName, points: pts, desc: `${b.runs} runs (${b.balls} balls)` });
    }
    for (const bw of Object.values(inn2.bowlingFigures)) {
      const econBonus = bw.overs > 1 ? Math.max(0, (8.0 - (bw.runsConceded / bw.overs)) * 4.0) : 0;
      const pts = bw.wickets * 25.0 + bw.maidens * 15.0 + bw.dots * 1.5 + econBonus;
      if (pts > 20) impactScores.push({ name: bw.name, team: inn1.teamName, points: pts, desc: `${bw.wickets}/${bw.runsConceded} (${bw.overs} ov)` });
    }

    impactScores.sort((a, b) => b.points - a.points);
    const top = impactScores[0] || {
      name: batting1st.playingXI[0].name,
      team: batting1st.name,
      points: 20,
      desc: 'Top Contributor'
    };

    return {
      matchId: `match_${matchNumber}_${Date.now()}`,
      matchNumber,
      homeTeamId: teamA.id,
      awayTeamId: teamB.id,
      venueName: selectedVenue,
      venuePitch: selectedPitch,
      homeTeam: teamA.name,
      awayTeam: teamB.name,
      tossWinner: tossWinner.name,
      tossDecision,
      innings1: inn1,
      innings2: inn2,
      winner,
      winnerTeamId,
      margin,
      marginText: `${winner} won by ${margin}`,
      playerOfTheMatch: {
        name: top.name,
        team: top.team,
        reason: top.desc,
        impactPoints: Math.round(top.points * 10) / 10
      },
      matchHighlights: [
        `${tossWinner.name} won the toss and elected to ${tossDecision}.`,
        `${batting1st.name} scored ${inn1.totalRuns}/${inn1.totalWickets} in ${inn1.oversCompleted} overs.`,
        `${bowling1st.name} finished at ${inn2.totalRuns}/${inn2.totalWickets} in ${inn2.oversCompleted} overs.`,
        `Result: ${winner} won by ${margin}`
      ],
      completed: true
    };
  }
}

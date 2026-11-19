/**
 * fullMatchSimulator.ts - Complete 40-Over T20 Match Simulator
 * Simulates real full IPL matches utilizing MatchSimEngine (Model 1 ONNX pipeline).
 * Handles:
 *  - Toss and pitch adaptation
 *  - 20-over tactical bowler rotation (max 4 overs, phase alignment, death over saving)
 *  - Real-time batting tactics driven by Required Run Rate (RRR)
 *  - Complete Scorecards, Fall of Wickets, and Player of the Match selection
 */

import { MatchSimEngine, type OverInputState, type BatterOverScorecard, type BowlerOverFigures, type BattingTactic, type BowlingTactic, type SimEngineConfig } from './simEngine.ts';
import { type Team2026 } from './teams2026.ts';
import { type IPLPlayer, type GroundSynergyVector } from '../../src/types/player.types.ts';

export interface InningsScorecard {
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
  venueName: string;
  homeTeam: string;
  awayTeam: string;
  tossWinner: string;
  tossDecision: 'BAT' | 'BOWL';
  innings1: InningsScorecard;
  innings2: InningsScorecard;
  winner: string;
  margin: string;
  playerOfTheMatch: {
    name: string;
    team: string;
    reason: string;
    impactPoints: number;
  };
  matchHighlights: string[];
}

export class FullMatchSimulator {
  private engine: MatchSimEngine;

  constructor(customConfig?: Partial<SimEngineConfig>) {
    this.engine = new MatchSimEngine(undefined, customConfig);
  }

  /**
   * Host configuration setting: adjust determinism ratio before auction/sim.
   * e.g. 0.45 = standard 45% skill anchor; 0.20 = wild chaos; 0.70 = tight chess.
   */
  public setHostRandomnessScale(determinismRatio: number): void {
    this.engine.setHostRandomnessScale(determinismRatio);
  }

  public async init(): Promise<void> {
    await this.engine.init();
  }

  /**
   * Selects the most tactically optimal bowler for Over k (0..19).
   * Enforces:
   *  - Max 4 overs per bowler.
   *  - No back-to-back overs for the same bowler.
   *  - Powerplay (0..5): prioritizes powerplayBowlers.
   *  - Middle (6..14): rotates middle spinners & secondary seamers.
   *  - Death (15..19): saves deathBowlers for overs 17, 18, 19, 20.
   */
  private pickBowlerForOver(
    overNum: number,
    lastBowlerName: string,
    team: Team2026,
    bowlerFigures: Record<string, BowlerOverFigures>
  ): IPLPlayer {
    const eligible = team.primaryBowlers
      .filter(name => name !== lastBowlerName)
      .filter(name => (bowlerFigures[name]?.overs ?? 0) < 4);

    if (eligible.length === 0) {
      // Fallback: any player in XI who hasn't bowled 4 and wasn't last bowler
      const fallback = team.playingXI
        .filter(p => p.name !== lastBowlerName && (bowlerFigures[p.name]?.overs ?? 0) < 4);
      return fallback[0] || team.playingXI[team.playingXI.length - 1];
    }

    // Death Phase (Overs 16..20, indices 15..19)
    if (overNum >= 15) {
      const deathCandidate = eligible.find(name => team.deathBowlers.includes(name));
      if (deathCandidate) {
        return team.playingXI.find(p => p.name === deathCandidate)!;
      }
    }

    // Powerplay Phase (Overs 1..6, indices 0..5)
    if (overNum <= 5) {
      const ppCandidate = eligible.find(name => team.powerplayBowlers.includes(name));
      if (ppCandidate) {
        return team.playingXI.find(p => p.name === ppCandidate)!;
      }
    }

    // Middle Phase: pick bowler with highest skill or fewest overs
    eligible.sort((a, b) => {
      const pA = team.playingXI.find(p => p.name === a)!;
      const pB = team.playingXI.find(p => p.name === b)!;
      return (pB.stats.bowl || 70) - (pA.stats.bowl || 70);
    });

    const chosenName = eligible[0];
    return team.playingXI.find(p => p.name === chosenName)!;
  }

  /**
   * Simulates an entire 20-over innings.
   */
  private async simulateInnings(
    inningsNum: 1 | 2,
    battingTeam: Team2026,
    bowlingTeam: Team2026,
    pitch: GroundSynergyVector,
    targetScore?: number,
    homeTeamId?: string
  ): Promise<InningsScorecard> {
    const battingLineup = battingTeam.playingXI;
    const fieldingLineup = bowlingTeam.playingXI;

    // Initialize batting scorecards for the XI
    const battingScorecard: Record<string, BatterOverScorecard> = {};
    for (const p of battingLineup) {
      battingScorecard[p.name] = {
        id: p.id,
        name: p.name,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        isOut: false
      };
    }

    // Initialize bowling figures
    const bowlingFigures: Record<string, BowlerOverFigures> = {};
    for (const name of bowlingTeam.primaryBowlers) {
      const p = fieldingLineup.find(pl => pl.name === name);
      if (p) {
        bowlingFigures[name] = {
          id: p.id,
          name: p.name,
          overs: 0,
          maidens: 0,
          runsConceded: 0,
          wickets: 0,
          dots: 0
        };
      }
    }

    const fallOfWickets: InningsScorecard['fallOfWickets'] = [];
    const overSummaries: InningsScorecard['overSummaries'] = [];

    // Openers
    let strikerIndex = 0;
    let nonStrikerIndex = 1;
    let nextBatterIndex = 2;

    let activeStriker = battingScorecard[battingLineup[strikerIndex].name];
    let activeNonStriker = battingScorecard[battingLineup[nonStrikerIndex].name];

    let currentScore = 0;
    let wicketsDown = 0;
    let lastBowlerName = '';

    for (let overIdx = 0; overIdx < 20; overIdx++) {
      if (wicketsDown >= 10) break;
      if (inningsNum === 2 && targetScore && currentScore >= targetScore) break;

      // Pick bowler
      const bowlerPlayer = this.pickBowlerForOver(overIdx, lastBowlerName, bowlingTeam, bowlingFigures);
      if (!bowlingFigures[bowlerPlayer.name]) {
        bowlingFigures[bowlerPlayer.name] = {
          id: bowlerPlayer.id,
          name: bowlerPlayer.name,
          overs: 0,
          maidens: 0,
          runsConceded: 0,
          wickets: 0,
          dots: 0
        };
      }
      const bowlerFig = bowlingFigures[bowlerPlayer.name];

      // Dynamic Tactical Selection
      let battingTactic: BattingTactic = 'BALANCED';
      let bowlingTactic: BowlingTactic = 'STANDARD';

      if (overIdx <= 5) {
        // Powerplay
        battingTactic = 'AGGRESSIVE';
        bowlingTactic = 'ATTACK';
      } else if (overIdx >= 15) {
        // Death Overs
        battingTactic = 'AGGRESSIVE';
        bowlingTactic = 'CONTAIN';
      } else if (inningsNum === 2 && targetScore) {
        // Chase pressure
        const ballsLeft = (20 - overIdx) * 6;
        const runsNeeded = targetScore - currentScore;
        const rrr = runsNeeded / (ballsLeft / 6.0);
        if (rrr >= 11.0) battingTactic = 'AGGRESSIVE';
        else if (rrr <= 6.5 && wicketsDown <= 4) battingTactic = 'BALANCED';
        else if (wicketsDown >= 7) battingTactic = 'DEFENSIVE';
      }

      const strikerPlayer = battingLineup.find(p => p.name === activeStriker.name)!;
      const nonStrikerPlayer = battingLineup.find(p => p.name === activeNonStriker.name)!;

      const bench = battingLineup.slice(nextBatterIndex);

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

      const overResult = await this.engine.simulateOver(
        overInput,
        activeStriker,
        activeNonStriker,
        bowlerFig,
        bench
      );

      // Record all dismissed batters into innings scorecard
      if (overResult.dismissedBatters && overResult.dismissedBatters.length > 0) {
        for (const dismissed of overResult.dismissedBatters) {
          battingScorecard[dismissed.name] = dismissed;
        }
      }

      // Track fall of wickets from actual ball delivery events
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
      lastBowlerName = bowlerPlayer.name;

      overSummaries.push({
        overNum: overIdx + 1,
        runs: overResult.runsScored,
        wickets: overResult.wicketsLost,
        bowlerName: bowlerPlayer.name,
        scoreSoFar: `${currentScore}/${wicketsDown}`
      });
    }

    const oversCompleted = overSummaries.length;
    const runRate = oversCompleted > 0 ? Math.round((currentScore / oversCompleted) * 100) / 100 : 0;

    return {
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

  /**
   * Simulates a full T20 Match between two 2026 teams.
   */
  public async simulateMatch(
    teamA: Team2026,
    teamB: Team2026,
    venueName?: string,
    pitch?: GroundSynergyVector
  ): Promise<MatchResult> {
    await this.init();

    const selectedVenue = venueName || teamA.homeVenueName;
    const selectedPitch = pitch || teamA.homePitch;

    // 1. Toss Simulation
    const tossWinner = Math.random() < 0.5 ? teamA : teamB;
    const tossLoser = tossWinner.id === teamA.id ? teamB : teamA;
    // Heavy dew (>0.60) prompts captain to chase under lights
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

    // 2. Innings 1
    const inn1 = await this.simulateInnings(1, batting1st, bowling1st, selectedPitch, undefined, teamA.id);

    // 3. Innings 2 (The Chase)
    const target = inn1.totalRuns + 1;
    const inn2 = await this.simulateInnings(2, bowling1st, batting1st, selectedPitch, target, teamA.id);

    // 4. Determine Winner & Margin
    let winner = '';
    let margin = '';
    if (inn2.totalRuns >= target) {
      winner = bowling1st.name;
      const wicketsRemaining = 10 - inn2.totalWickets;
      const ballsRemaining = (20 - inn2.oversCompleted) * 6;
      margin = `${wicketsRemaining} wicket${wicketsRemaining > 1 ? 's' : ''} (with ${ballsRemaining} balls to spare)`;
    } else if (inn2.totalRuns < inn1.totalRuns) {
      winner = batting1st.name;
      const runDiff = inn1.totalRuns - inn2.totalRuns;
      margin = `${runDiff} run${runDiff > 1 ? 's' : ''}`;
    } else {
      winner = 'Match Tied (Super Over)';
      margin = 'Scores Level!';
    }

    // 5. Select Player of the Match using Impact Formula
    // Points = runs * 1.0 + fours * 1.0 + sixes * 2.0 + wickets * 25.0 + maidens * 15.0
    const impactScores: Array<{ name: string; team: string; points: number; desc: string }> = [];

    // Check Innings 1
    for (const b of Object.values(inn1.battingScorecard)) {
      if (b.runs > 0) {
        const pts = b.runs + b.fours * 1 + b.sixes * 2;
        impactScores.push({ name: b.name, team: batting1st.name, points: pts, desc: `${b.runs} runs off ${b.balls} balls (${b.fours}x4, ${b.sixes}x6)` });
      }
    }
    for (const b of Object.values(inn1.bowlingFigures)) {
      if (b.overs > 0) {
        const pts = b.wickets * 25 + b.maidens * 15 + Math.max(0, (b.overs * 8.0 - b.runsConceded) * 1.5);
        impactScores.push({ name: b.name, team: bowling1st.name, points: pts, desc: `${b.wickets}/${b.runsConceded} in ${b.overs} overs` });
      }
    }
    // Check Innings 2
    for (const b of Object.values(inn2.battingScorecard)) {
      if (b.runs > 0) {
        const pts = b.runs + b.fours * 1 + b.sixes * 2 + (winner === bowling1st.name ? 10 : 0);
        impactScores.push({ name: b.name, team: bowling1st.name, points: pts, desc: `${b.runs} runs off ${b.balls} balls (${b.fours}x4, ${b.sixes}x6)` });
      }
    }
    for (const b of Object.values(inn2.bowlingFigures)) {
      if (b.overs > 0) {
        const pts = b.wickets * 25 + b.maidens * 15 + Math.max(0, (b.overs * 8.0 - b.runsConceded) * 1.5) + (winner === batting1st.name ? 10 : 0);
        impactScores.push({ name: b.name, team: batting1st.name, points: pts, desc: `${b.wickets}/${b.runsConceded} in ${b.overs} overs` });
      }
    }

    impactScores.sort((a, b) => b.points - a.points);
    const potm = impactScores[0] || { name: 'Jasprit Bumrah', team: 'MI', points: 50, desc: 'Clutch bowling performance' };

    const highlights = [
      `Toss: ${tossWinner.name} won the toss and elected to ${tossDecision.toLowerCase()} first.`,
      `Innings 1: ${batting1st.name} posted ${inn1.totalRuns}/${inn1.totalWickets} in ${inn1.oversCompleted} overs (RR: ${inn1.runRate}).`,
      `Target: ${target} runs needed in 20 overs.`,
      `Innings 2: ${bowling1st.name} scored ${inn2.totalRuns}/${inn2.totalWickets} in ${inn2.oversCompleted} overs.`,
      `Final Outcome: ${winner} won by ${margin}.`,
      `Player of the Match: ${potm.name} (${potm.team}) - ${potm.desc}.`
    ];

    return {
      matchId: `m_${teamA.id}_vs_${teamB.id}_${Date.now()}`,
      venueName: selectedVenue,
      homeTeam: teamA.name,
      awayTeam: teamB.name,
      tossWinner: tossWinner.name,
      tossDecision,
      innings1: inn1,
      innings2: inn2,
      winner,
      margin,
      playerOfTheMatch: {
        name: potm.name,
        team: potm.team,
        reason: potm.desc,
        impactPoints: Math.round(potm.points)
      },
      matchHighlights: highlights
    };
  }
}

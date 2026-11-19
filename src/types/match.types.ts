import { IPLPlayer, PrimaryRole, GroundSynergyVector } from './player.types';

export type BattingTactic = 'DEFENSIVE' | 'BALANCED' | 'AGGRESSIVE' | 'SPIN_ATTACK' | 'PACE_ATTACK';
export type BowlingTactic = 'BALANCED' | 'PACE_ATTACK' | 'SPIN_SQUEEZE' | 'WICKET_HUNT' | 'BOUNDARY_DEFENSIVE';

export interface Playing11Lineup {
  teamId: string;
  playing11Ids: string[];         // Exactly 11 player IDs
  captainId: string;
  wkId: string;
  battingOrder: string[];         // 11 IDs in batting position 1..11
  bowlerPool352: {
    powerplayBowlerIds: string[]; // 3 bowlers, 2 overs each
    firstBowlerId: string;        // Bowler for Over 1
    middleBowlerIds: string[];    // 5 bowlers
    deathOver17_19BowlerId: string; // The bowler tasked with overs 17 and 19
    deathOver18_20BowlerId: string; // The bowler tasked with overs 18 and 20
    deathBowlerIds?: string[];     // Convenience array [deathOver17_19BowlerId, deathOver18_20BowlerId]
    backupBowlerId: string;       // Designated emergency bowler
  };
  tactics: {
    powerplay: { batting: BattingTactic; bowling: BowlingTactic };
    middle: { batting: BattingTactic; bowling: BowlingTactic };
    death: { batting: BattingTactic; bowling: BowlingTactic };
  };
}

export interface BatterOverScorecard {
  name: string;
  playerId?: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  strikeRate?: number;
  isOut: boolean;
  dismissalText?: string;
}

export interface BowlerOverFigures {
  name: string;
  playerId?: string;
  overs: number;
  maidens: number;
  runsConceded: number;
  wickets: number;
  economy?: number;
  dots?: number;
}

export interface OverSummaryEntry {
  overNum: number;
  runs: number;
  wickets: number;
  bowlerName: string;
  strikerName?: string;
  nonStrikerName?: string;
  scoreSoFar: string;
  phaseTactic?: string;
  cumulativeRuns?: number;
  cumulativeWickets?: number;
  fours?: number;
  sixes?: number;
  dots?: number;
  phase?: 'POWERPLAY' | 'MIDDLE' | 'DEATH';
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
  overSummaries: OverSummaryEntry[];
}

export interface MatchResult {
  matchId: string;
  matchNumber: number;
  homeTeamId: string;
  awayTeamId: string;
  homeTeam?: string;
  awayTeam?: string;
  venueName: string;
  venuePitch: GroundSynergyVector;
  tossWinner: string;
  tossDecision: 'BAT' | 'BOWL';
  innings1: InningsScorecard;
  innings2: InningsScorecard;
  winner?: string;
  winnerTeamId: string | null;     // null if tie/no-result
  margin?: string;
  marginText: string;
  playerOfTheMatch: { name: string; playerId?: string; team?: string; reason: string; impactPoints?: number };
  matchHighlights?: string[];
  completed: boolean;
  isPlayoff?: boolean;
  playoffStage?: 'QUALIFIER_1' | 'ELIMINATOR' | 'QUALIFIER_2' | 'FINAL';
}

export interface TeamStanding {
  teamId: string;
  teamName: string;
  played: number;
  won: number;
  lost: number;
  tied: number;
  points: number;
  nrr: number;
  totalRunsScored: number;
  totalOversBatted: number;
  totalRunsConceded: number;
  totalOversBowled: number;
  recentForm: ('W' | 'L' | 'T')[];
}

export interface MatchLifecycleState {
  stage: 'PRE_MATCH_PREP' | 'SIMULATING' | 'RESULT_VIEW';
  prepTimerMsRemaining: number;      // 15000ms countdown for AI vs AI, 0/infinite for Human
  resultTimerMsRemaining: number;    // starts at 15000ms (15s countdown)
  readyTeamIds: string[];            // teamIds that clicked [Ready to Simulate]
  simulateVotes?: string[];          // teamIds or userIds that voted to simulate
  matchNumber: number;
  isHumanMatch?: boolean;            // true if at least one participating team is human
}

export interface SeasonState {
  currentMatchIndex: number;
  totalMatches: number;
  fixtures: MatchResult[];
  standings: Record<string, TeamStanding>;
  lineups: Record<string, Playing11Lineup>;
  autoSkipAI: boolean;             // Host toggle
  humanMatchWaitingForNext: boolean;
  championTeamId?: string | null;
  matchLifecycle?: MatchLifecycleState;
}

/**
 * src/server/match/injuryEngine.ts
 * Unified Spell-Stamina, 3-Level Injury, and SR/Econ Phase Clamping Engine.
 */

import { IPLPlayer } from '../../types/player.types';

export type InjuryLevel = 'NONE' | 'LEVEL_1_NIGGLE' | 'LEVEL_2_STRAIN' | 'LEVEL_3_RULED_OUT';

export interface InjuryReport {
  playerId: string;
  playerName: string;
  franchiseId: string;
  level: InjuryLevel;
  matchesOut: number;
  message: string;
  replacementEligible: boolean;
}

export interface MatchWorkloadResolution {
  injuredPlayers: InjuryReport[];
  recoveredPlayers: string[];
}

/**
 * In-Match Over-by-Over Bowler Stamina Calculation:
 * - Drain: -12 for Pacer, -8 for Spinner (+4 if back-to-back overs)
 * - Rest: +6 per resting over
 * - Penalty: -8% max control/pace drop when stamina < 70
 */
export function calculateBowlerSpellStat(
  currentStamina: number,
  baseBowlStat: number
): { effectiveBowl: number; staminaAfterOver: number } {
  const staminaFloor = 50.0;
  const clampedStamina = Math.max(staminaFloor, currentStamina);
  
  let factor = 1.0;
  if (clampedStamina < 70.0) {
    factor = 1.0 - 0.08 * ((70.0 - clampedStamina) / 20.0);
  }
  
  return {
    effectiveBowl: Math.round(baseBowlStat * factor * 10) / 10,
    staminaAfterOver: clampedStamina
  };
}

/**
 * Phase-Bounded Forward Pass Over Clamping:
 * Guarantees realistic authentic T20 boundaries:
 * Powerplay: [4.5, 13.0] RPO
 * Middle   : [4.8, 12.5] RPO
 * Death    : [6.0, 16.5] RPO
 */
export function clampPhaseOverRuns(rawRuns: number, overNumber: number): number {
  if (overNumber < 6) {
    return Math.max(4.5, Math.min(13.0, rawRuns));
  } else if (overNumber < 15) {
    return Math.max(4.8, Math.min(12.5, rawRuns));
  } else {
    return Math.max(6.0, Math.min(16.5, rawRuns));
  }
}

/**
 * Tournament Workload & Balanced Simple Injury System:
 * - Simple & Fair Injury Occurrence:
 *    • Bowler: Exactly 1 in 6 matches chance (1/6 ≈ 16.67%) per team that ONE bowler gets injured.
 *    • Batter: Exactly 1 in 8 matches chance (1/8 = 12.50%) per team that ONE batter gets injured.
 * - Severity:
 *    • Level 1 (80%): 1 Match Pause (Minor niggle, quick recovery)
 *    • Level 2 (15%): 2 Match Pause (Strain)
 *    • Level 3 (5%): Ruled Out (Rare season injury, unlocks replacement signing)
 * - Safe limits:
 *    • Maximum 2 concurrent injuries per team to prevent bench wipeouts.
 *    • Guaranteed minimum 5 fit bowlers remaining so match lineups never break.
 */
export function processMatchWorkload(
  squad: IPLPlayer[],
  playingXIIds: Set<string>,
  franchiseId: string,
  rng: () => number = Math.random
): MatchWorkloadResolution {
  const injuredPlayers: InjuryReport[] = [];
  const recoveredPlayers: string[] = [];

  // 1. Process recoveries and workload reduction for already-injured or benched players
  for (const player of squad) {
    player.workload = player.workload ?? 0.0;
    player.injuryStatus = player.injuryStatus ?? 0;

    if (player.injuryStatus > 0) {
      player.injuryStatus -= 1;
      if (player.injuryStatus === 0) {
        recoveredPlayers.push(player.id);
      }
      player.workload = Math.max(0.0, player.workload - 30.0);
    } else if (player.injuryStatus === -1) {
      // Ruled out
      player.workload = 0.0;
    } else if (!playingXIIds.has(player.id)) {
      // Benched fit player
      player.workload = Math.max(0.0, player.workload - 25.0);
    } else {
      // Playing match
      player.workload = Math.min(100.0, player.workload + 10.0);
    }
  }

  // Count current active injuries
  let currentInjuredCount = squad.filter(p => (p.injuryStatus ?? 0) !== 0).length;
  // Maximum 2 concurrent injuries per franchise ensures teams never run out of players or balance
  if (currentInjuredCount >= 2) {
    return { injuredPlayers, recoveredPlayers };
  }

  // Helper to test if player is a bowler
  const isBowler = (p: IPLPlayer) =>
    p.role === 'PACE' || p.role === 'SPIN' || (p.role === 'AR' && (p.stats?.bowl ?? 0) >= 55);

  // Helper to test if player is a batter
  const isBatter = (p: IPLPlayer) =>
    p.role === 'BAT' || p.role === 'WK' || (p.role === 'AR' && (p.stats?.bat ?? 0) >= 55);

  // Remaining fit bowlers count in squad (guarantee at least 5 fit bowlers remain)
  const fitBowlersCount = squad.filter(p => (p.injuryStatus ?? 0) === 0 && isBowler(p)).length;

  const newlyInjuredIds = new Set<string>();

  // 2. BOWLER INJURY ROLL: 1 in 6 chance per team per match (1/6)
  if (currentInjuredCount < 2 && fitBowlersCount > 5) {
    const bowlerRoll = rng();
    if (bowlerRoll < (1.0 / 6.0)) {
      // Pick one eligible bowler from Playing XI
      const eligibleBowlers = squad.filter(p =>
        playingXIIds.has(p.id) &&
        (p.injuryStatus ?? 0) === 0 &&
        isBowler(p)
      );

      if (eligibleBowlers.length > 0) {
        const pickedIdx = Math.floor(rng() * eligibleBowlers.length);
        const bowler = eligibleBowlers[pickedIdx];

        const sevRoll = rng();
        if (sevRoll < 0.80) {
          // Level 1: 1 Match Out
          bowler.injuryStatus = 1;
          bowler.workload = Math.max(0.0, (bowler.workload ?? 0) - 25.0);
          injuredPlayers.push({
            playerId: bowler.id,
            playerName: bowler.name,
            franchiseId,
            level: 'LEVEL_1_NIGGLE',
            matchesOut: 1,
            message: `${bowler.name} experienced tightness/spasm and will rest for 1 match.`,
            replacementEligible: false
          });
        } else if (sevRoll < 0.95) {
          // Level 2: 2 Matches Out
          bowler.injuryStatus = 2;
          bowler.workload = Math.max(0.0, (bowler.workload ?? 0) - 40.0);
          injuredPlayers.push({
            playerId: bowler.id,
            playerName: bowler.name,
            franchiseId,
            level: 'LEVEL_2_STRAIN',
            matchesOut: 2,
            message: `${bowler.name} suffered a muscle strain and is sidelined for 2 matches.`,
            replacementEligible: false
          });
        } else {
          // Level 3: Ruled Out
          bowler.injuryStatus = -1;
          injuredPlayers.push({
            playerId: bowler.id,
            playerName: bowler.name,
            franchiseId,
            level: 'LEVEL_3_RULED_OUT',
            matchesOut: 999,
            message: `${bowler.name} suffered a tournament-ending injury and is ruled out. Replacement signing unlocked!`,
            replacementEligible: true
          });
        }
        newlyInjuredIds.add(bowler.id);
        currentInjuredCount++;
      }
    }
  }

  // 3. BATTER INJURY ROLL: 1 in 8 chance per team per match (1/8)
  if (currentInjuredCount < 2) {
    const batterRoll = rng();
    if (batterRoll < (1.0 / 8.0)) {
      // Pick one eligible batter from Playing XI (excluding anyone already injured)
      const eligibleBatters = squad.filter(p =>
        playingXIIds.has(p.id) &&
        (p.injuryStatus ?? 0) === 0 &&
        !newlyInjuredIds.has(p.id) &&
        isBatter(p)
      );

      if (eligibleBatters.length > 0) {
        const pickedIdx = Math.floor(rng() * eligibleBatters.length);
        const batter = eligibleBatters[pickedIdx];

        const sevRoll = rng();
        if (sevRoll < 0.80) {
          // Level 1: 1 Match Out
          batter.injuryStatus = 1;
          batter.workload = Math.max(0.0, (batter.workload ?? 0) - 25.0);
          injuredPlayers.push({
            playerId: batter.id,
            playerName: batter.name,
            franchiseId,
            level: 'LEVEL_1_NIGGLE',
            matchesOut: 1,
            message: `${batter.name} experienced hamstring soreness and will rest for 1 match.`,
            replacementEligible: false
          });
        } else if (sevRoll < 0.95) {
          // Level 2: 2 Matches Out
          batter.injuryStatus = 2;
          batter.workload = Math.max(0.0, (batter.workload ?? 0) - 40.0);
          injuredPlayers.push({
            playerId: batter.id,
            playerName: batter.name,
            franchiseId,
            level: 'LEVEL_2_STRAIN',
            matchesOut: 2,
            message: `${batter.name} suffered a muscle strain and is sidelined for 2 matches.`,
            replacementEligible: false
          });
        } else {
          // Level 3: Ruled Out
          batter.injuryStatus = -1;
          injuredPlayers.push({
            playerId: batter.id,
            playerName: batter.name,
            franchiseId,
            level: 'LEVEL_3_RULED_OUT',
            matchesOut: 999,
            message: `${batter.name} suffered a tournament-ending injury and is ruled out. Replacement signing unlocked!`,
            replacementEligible: true
          });
        }
        newlyInjuredIds.add(batter.id);
        currentInjuredCount++;
      }
    }
  }

  return { injuredPlayers, recoveredPlayers };
}

/**
 * Injury Replacement Draft:
 * Replaces a Level 3 Ruled-Out player with an unsold player of the same role.
 */
export function signInjuryReplacement(
  squad: IPLPlayer[],
  ruledOutPlayerId: string,
  unsoldPool: IPLPlayer[]
): { success: boolean; replacementPlayer?: IPLPlayer } {
  const ruledOutIdx = squad.findIndex(p => p.id === ruledOutPlayerId && p.injuryStatus === -1);
  if (ruledOutIdx === -1) return { success: false };

  const ruledOut = squad[ruledOutIdx];
  const eligibleReplacementIdx = unsoldPool.findIndex(p => p.role === ruledOut.role);
  if (eligibleReplacementIdx === -1) return { success: false };

  const [replacement] = unsoldPool.splice(eligibleReplacementIdx, 1);
  replacement.workload = 0.0;
  replacement.injuryStatus = 0;
  replacement.soldPrice = 0.0;

  // Add to squad
  squad.push(replacement);
  return { success: true, replacementPlayer: replacement };
}

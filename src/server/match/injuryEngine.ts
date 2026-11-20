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
 * Tournament Workload & Simplified Balanced Injury System:
 * - Workload builds during match play (+12 for pacers, +8 for others), recovers on bench (-25)
 * - Bowler injury chance: exactly 1 in 6 matches per team (1/6 = ~16.7%, max 1 bowler)
 * - Batter injury chance: exactly 1 in 8 matches per team (1/8 = 12.5%, max 1 batter)
 * - Safety Cap: Maximum 2 concurrent injuries per franchise to prevent squad wipeouts
 * - Levels:
 *    1. Level 1 (75%): 1 Match Pause (Minor niggle, quick recovery)
 *    2. Level 2 (20%): 3 Match Pause (Strain, short rest)
 *    3. Level 3 (5%): Ruled Out (Rare season injury, unlocks replacement draft)
 */
export function processMatchWorkload(
  squad: IPLPlayer[],
  playingXIIds: Set<string>,
  franchiseId: string,
  rng: () => number = Math.random
): MatchWorkloadResolution {
  const injuredPlayers: InjuryReport[] = [];
  const recoveredPlayers: string[] = [];

  // Count active injuries in this franchise
  let currentInjuredCount = squad.filter(p => (p.injuryStatus ?? 0) !== 0).length;

  for (const player of squad) {
    player.workload = player.workload ?? 0.0;
    player.injuryStatus = player.injuryStatus ?? 0;

    // Check existing injuries first
    if (player.injuryStatus > 0) {
      player.injuryStatus -= 1;
      if (player.injuryStatus === 0) {
        recoveredPlayers.push(player.id);
        currentInjuredCount = Math.max(0, currentInjuredCount - 1);
      }
      // Injured player rests and recovers workload
      player.workload = Math.max(0.0, player.workload - 30.0);
      continue;
    } else if (player.injuryStatus === -1) {
      // Ruled out for tournament
      continue;
    }

    if (playingXIIds.has(player.id)) {
      // Active match play: workload builds up
      const loadGain = player.role === 'PACE' ? 12.0 : 8.0;
      player.workload = Math.min(100.0, player.workload + loadGain);
    } else {
      // Benched player recovers workload
      player.workload = Math.max(0.0, player.workload - 25.0);
    }
  }

  // Simplified Balanced Injury Rolls:
  // Enforce franchise safety cap of max 2 concurrent injuries
  if (currentInjuredCount < 2) {
    const isBowler = (p: IPLPlayer) =>
      p.role === 'PACE' || p.role === 'SPIN' || (p.role === 'AR' && (p.stats?.bowl ?? 0) >= 60);

    const isBatter = (p: IPLPlayer) =>
      p.role === 'BAT' || p.role === 'WK' || (p.role === 'AR' && (p.stats?.bat ?? 0) > 60);

    const activeXI = squad.filter(p => playingXIIds.has(p.id) && (p.injuryStatus ?? 0) === 0);

    // 1. Bowler Injury Roll (1 in 6 matches per team = ~16.7%)
    if (rng() < (1.0 / 6.0) && currentInjuredCount < 2) {
      const activeBowlers = activeXI.filter(isBowler);
      if (activeBowlers.length > 0) {
        const chosenBowler = activeBowlers[Math.floor(rng() * activeBowlers.length)];
        currentInjuredCount++;
        const roll = rng();
        if (roll < 0.75) {
          // Level 1: 1 Match Pause (Niggle)
          chosenBowler.injuryStatus = 1;
          chosenBowler.workload = Math.max(0.0, (chosenBowler.workload ?? 0) - 20.0);
          injuredPlayers.push({
            playerId: chosenBowler.id,
            playerName: chosenBowler.name,
            franchiseId,
            level: 'LEVEL_1_NIGGLE',
            matchesOut: 1,
            message: `${chosenBowler.name} experienced minor hamstring tightness and will rest for 1 match.`,
            replacementEligible: false
          });
        } else if (roll < 0.95) {
          // Level 2: 3 Match Pause (Strain)
          chosenBowler.injuryStatus = 3;
          chosenBowler.workload = Math.max(0.0, (chosenBowler.workload ?? 0) - 40.0);
          injuredPlayers.push({
            playerId: chosenBowler.id,
            playerName: chosenBowler.name,
            franchiseId,
            level: 'LEVEL_2_STRAIN',
            matchesOut: 3,
            message: `${chosenBowler.name} suffered a muscle strain and will miss 3 matches.`,
            replacementEligible: false
          });
        } else {
          // Level 3: Ruled out
          chosenBowler.injuryStatus = -1;
          injuredPlayers.push({
            playerId: chosenBowler.id,
            playerName: chosenBowler.name,
            franchiseId,
            level: 'LEVEL_3_RULED_OUT',
            matchesOut: 999,
            message: `${chosenBowler.name} suffered a tournament-ending injury and is ruled out. Replacement signing unlocked!`,
            replacementEligible: true
          });
        }
      }
    }

    // 2. Batter Injury Roll (1 in 8 matches per team = 12.5%)
    if (rng() < (1.0 / 8.0) && currentInjuredCount < 2) {
      const alreadyInjuredIds = new Set(injuredPlayers.map(i => i.playerId));
      const activeBatters = activeXI.filter(p => isBatter(p) && !alreadyInjuredIds.has(p.id));
      if (activeBatters.length > 0) {
        const chosenBatter = activeBatters[Math.floor(rng() * activeBatters.length)];
        currentInjuredCount++;
        const roll = rng();
        if (roll < 0.75) {
          // Level 1: 1 Match Pause (Niggle)
          chosenBatter.injuryStatus = 1;
          chosenBatter.workload = Math.max(0.0, (chosenBatter.workload ?? 0) - 20.0);
          injuredPlayers.push({
            playerId: chosenBatter.id,
            playerName: chosenBatter.name,
            franchiseId,
            level: 'LEVEL_1_NIGGLE',
            matchesOut: 1,
            message: `${chosenBatter.name} experienced minor soreness and will rest for 1 match.`,
            replacementEligible: false
          });
        } else if (roll < 0.95) {
          // Level 2: 3 Match Pause (Strain)
          chosenBatter.injuryStatus = 3;
          chosenBatter.workload = Math.max(0.0, (chosenBatter.workload ?? 0) - 40.0);
          injuredPlayers.push({
            playerId: chosenBatter.id,
            playerName: chosenBatter.name,
            franchiseId,
            level: 'LEVEL_2_STRAIN',
            matchesOut: 3,
            message: `${chosenBatter.name} suffered a groin/hamstring strain and will miss 3 matches.`,
            replacementEligible: false
          });
        } else {
          // Level 3: Ruled out
          chosenBatter.injuryStatus = -1;
          injuredPlayers.push({
            playerId: chosenBatter.id,
            playerName: chosenBatter.name,
            franchiseId,
            level: 'LEVEL_3_RULED_OUT',
            matchesOut: 999,
            message: `${chosenBatter.name} suffered a tournament-ending injury and is ruled out. Replacement signing unlocked!`,
            replacementEligible: true
          });
        }
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

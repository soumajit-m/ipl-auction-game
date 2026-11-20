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
 * Tournament Workload & 3-Tier Injury System (Tuned for ~0.8 - 1.2 injuries per match):
 * - Playing match: +9.0 Workload (+12.0 for fast bowlers)
 * - Sitting on bench: -35.0 Workload (Restoration)
 * - Safe zone up to 72.0 Workload (enters danger zone after 5-7 consecutive games)
 * - Hard cap: Maximum 3 concurrent injuries per franchise (prevents bench wipeouts)
 * - Levels:
 *    1. Level 1 (80%): 1 Match Pause (Minor niggle, quick recovery)
 *    2. Level 2 (16%): 3 Match Pause (Strain, squad depth challenge)
 *    3. Level 3 (4%): Ruled Out (Rare season tear, unlocks replacement draft)
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
      // Active match play: workload builds up (+18 for pacers, +14 for others)
      const loadGain = player.role === 'PACE' ? 18.0 : 14.0;
      player.workload = Math.min(100.0, player.workload + loadGain);

      // Realistic Match Injury Roll (Franchise capped at max 3 concurrent injuries)
      if (currentInjuredCount < 3) {
        const baseRisk = (player.stats?.injuryRisk ?? 0.10) * 0.35; // ~2.5% to 4.5% base risk per match
        const fatigueRisk = player.workload > 30.0 ? ((player.workload - 30.0) / 70.0) * 0.10 : 0.0;
        const totalRisk = Math.min(0.25, baseRisk + fatigueRisk);

        if (rng() < totalRisk) {
          currentInjuredCount++;
          const roll = rng();
          if (roll < 0.75) {
            // Level 1: 1 Match Pause
            player.injuryStatus = 1;
            player.workload = Math.max(0.0, player.workload - 30.0);
            injuredPlayers.push({
              playerId: player.id,
              playerName: player.name,
              franchiseId,
              level: 'LEVEL_1_NIGGLE',
              matchesOut: 1,
              message: `${player.name} experienced minor tightness/spasm and will rest for 1 match.`,
              replacementEligible: false
            });
          } else if (roll < 0.95) {
            // Level 2: 3 Match Pause
            player.injuryStatus = 3;
            player.workload = Math.max(0.0, player.workload - 45.0);
            injuredPlayers.push({
              playerId: player.id,
              playerName: player.name,
              franchiseId,
              level: 'LEVEL_2_STRAIN',
              matchesOut: 3,
              message: `${player.name} suffered a muscle strain and is sidelined for 3 matches.`,
              replacementEligible: false
            });
          } else {
            // Level 3: Ruled Out
            player.injuryStatus = -1;
            injuredPlayers.push({
              playerId: player.id,
              playerName: player.name,
              franchiseId,
              level: 'LEVEL_3_RULED_OUT',
              matchesOut: 999,
              message: `${player.name} suffered a tournament-ending injury and is ruled out. Replacement signing unlocked!`,
              replacementEligible: true
            });
          }
        }
      }
    } else {
      // Benched player recovers workload
      player.workload = Math.max(0.0, player.workload - 35.0);
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

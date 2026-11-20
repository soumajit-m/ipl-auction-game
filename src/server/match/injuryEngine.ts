/**
 * src/server/match/injuryEngine.ts
 * Clean, Balanced Stamina, Fatigue, and Injury Mechanics.
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
 * Simple, gentle scaling.
 */
export function calculateBowlerSpellStat(
  currentStamina: number,
  baseBowlStat: number
): { effectiveBowl: number; staminaAfterOver: number } {
  const staminaFloor = 40.0;
  const clampedStamina = Math.max(staminaFloor, currentStamina);

  let factor = 1.0;
  if (clampedStamina < 65.0) {
    factor = 1.0 - 0.05 * ((65.0 - clampedStamina) / 25.0);
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
 * Post-Match Stamina Recovery and Capped Injury Check:
 *
 * 1. Stamina Recovery:
 *    - Benched players (not in Playing 11): restore +15.0 stamina (capped at stats.staminaRecov).
 *    - Playing 11 players: restore +2.5 stamina natural rest recovery (capped at stats.staminaRecov).
 *
 * 2. Injury Decrements & Recovery:
 *    - Decrement injuryMatchesRemaining by 1.
 *    - When it hits 0, player recovers: isInjured = false, restore stamina to 80% of stats.staminaRecov.
 *
 * 3. Hard Team Injury Cap (Max 2 Injured per Team):
 *    - If currentInjuredCount >= 2: Zero new injuries can occur (hard stop).
 *    - If currentInjuredCount === 1: 80% reduction (dampener = 0.20).
 *
 * 4. Match-Level Injury Probabilities (Only for Playing 11 fit players):
 *    - Bowlers (isBowlingCapable): 1 in 5.5 matches (~18%).
 *    - Pure Batters / WKs (!isBowlingCapable): 1 in 7.5 matches (~13%).
 *    - At most 1 newly injured player per team per match.
 *    - Injury duration: 1 or 2 matches (never season-ending).
 */
export function processMatchWorkload(
  squad: IPLPlayer[],
  playingXIIds: Set<string>,
  franchiseId: string,
  rng: () => number = Math.random
): MatchWorkloadResolution {
  const injuredPlayers: InjuryReport[] = [];
  const recoveredPlayers: string[] = [];

  // 1. Process recoveries and reset stamina for all squad players (stamina resets every match)
  for (const player of squad) {
    const maxStamina = player.stats?.staminaRecov ?? 80.0;
    // Stamina resets every match and does not pass to another match
    player.stamina = maxStamina;

    const wasInjured = Boolean(
      player.isInjured ||
      (player.injuryMatchesRemaining && player.injuryMatchesRemaining > 0) ||
      (player.injuryStatus !== undefined && player.injuryStatus > 0)
    );

    if (wasInjured) {
      const remaining = (player.injuryMatchesRemaining ?? player.injuryStatus ?? 1) - 1;
      if (remaining <= 0) {
        // Player fully recovered
        player.isInjured = false;
        player.injuryMatchesRemaining = 0;
        player.injuryStatus = 0;
        player.stamina = maxStamina;
        recoveredPlayers.push(player.id);
      } else {
        // Still sidelined
        player.isInjured = true;
        player.injuryMatchesRemaining = remaining;
        player.injuryStatus = remaining;
      }
      continue;
    }

    // Player is fit
    player.isInjured = false;
    player.injuryMatchesRemaining = 0;
    player.injuryStatus = 0;
  }

  // 2. Count currently injured players in this franchise
  const currentInjuredCount = squad.filter(p => Boolean(p.isInjured || (p.injuryMatchesRemaining && p.injuryMatchesRemaining > 0))).length;

  // Hard Stop: If already 2 injured, zero new injuries can occur
  if (currentInjuredCount >= 2) {
    return { injuredPlayers, recoveredPlayers };
  }

  // Dampener when 1 player is already injured: 80% reduction (multiplier 0.20)
  const dampener = currentInjuredCount === 1 ? 0.20 : 1.0;

  // 3. Filter active fit players who played in this match
  const activeFitXI = squad.filter(p => playingXIIds.has(p.id) && !p.isInjured);

  const isBowler = (p: IPLPlayer) =>
    p.isBowlingCapable || p.role === 'PACE' || p.role === 'SPIN' || p.role === 'AR';

  const activeBowlers = activeFitXI.filter(isBowler);
  const activeBatters = activeFitXI.filter(p => !isBowler(p));

  let newlyInjured = false;

  // Bowler Injury Roll: Base chance 1 in 5.5 matches (~18.18%)
  const bowlerChance = (1.0 / 5.5) * dampener;
  if (rng() < bowlerChance && activeBowlers.length > 0) {
    const chosenBowler = activeBowlers[Math.floor(rng() * activeBowlers.length)];
    // Short recovery duration: 1 or 2 matches (never season-ending)
    const matchesOut = rng() < 0.65 ? 1 : 2;
    chosenBowler.isInjured = true;
    chosenBowler.injuryMatchesRemaining = matchesOut;
    chosenBowler.injuryStatus = matchesOut;

    injuredPlayers.push({
      playerId: chosenBowler.id,
      playerName: chosenBowler.name,
      franchiseId,
      level: matchesOut === 1 ? 'LEVEL_1_NIGGLE' : 'LEVEL_2_STRAIN',
      matchesOut,
      message: matchesOut === 1
        ? `${chosenBowler.name} experienced minor muscle soreness and will rest 1 match.`
        : `${chosenBowler.name} suffered a muscle strain and will miss 2 matches.`,
      replacementEligible: false
    });
    newlyInjured = true;
  }

  // Pure Batter / WK Injury Roll: Base chance 1 in 7.5 matches (~13.33%)
  // (Only roll if no bowler was injured in this match - max 1 new injury per team per match)
  if (!newlyInjured && activeBatters.length > 0) {
    const batterChance = (1.0 / 7.5) * dampener;
    if (rng() < batterChance) {
      const chosenBatter = activeBatters[Math.floor(rng() * activeBatters.length)];
      const matchesOut = rng() < 0.65 ? 1 : 2;
      chosenBatter.isInjured = true;
      chosenBatter.injuryMatchesRemaining = matchesOut;
      chosenBatter.injuryStatus = matchesOut;

      injuredPlayers.push({
        playerId: chosenBatter.id,
        playerName: chosenBatter.name,
        franchiseId,
        level: matchesOut === 1 ? 'LEVEL_1_NIGGLE' : 'LEVEL_2_STRAIN',
        matchesOut,
        message: matchesOut === 1
          ? `${chosenBatter.name} experienced minor stiffness and will rest 1 match.`
          : `${chosenBatter.name} suffered a groin/hamstring strain and will miss 2 matches.`,
        replacementEligible: false
      });
    }
  }

  return { injuredPlayers, recoveredPlayers };
}

/**
 * Fallback helper for replacement if ever called
 */
export function signInjuryReplacement(
  squad: IPLPlayer[],
  ruledOutPlayerId: string,
  unsoldPool: IPLPlayer[]
): { success: boolean; replacementPlayer?: IPLPlayer } {
  return { success: false };
}

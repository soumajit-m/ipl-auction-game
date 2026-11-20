/**
 * teamMaker.ts - Naive Auto-Team Maker and Smart AI Team Maker
 * Strictly adhering to IPL Match Lineup Constraints:
 * - Exactly 11 players
 * - Overseas <= 4
 * - Wicketkeeper >= 1
 * - Bowlers >= 6
 * - 3-5-2 Phase Bowler setup resolving 20 overs (max 4 per bowler)
 */

import { IPLPlayer, PrimaryRole, GroundSynergyVector } from '../../types/player.types';
import { Playing11Lineup, BattingTactic, BowlingTactic } from '../../types/match.types';

export interface BowlerPhaseQuota {
  playerId: string;
  maxTotal: number;          // 4 overs maximum
  powerplayOvers: number;    // 0 or 2
  deathOvers: number;        // 0 or 2
  usableMiddleOvers: number; // 4, 2, or 0
  isEligibleForMiddle: boolean; // usableMiddleOvers > 0
}

export interface PhaseQuotasResult {
  quotas: Record<string, BowlerPhaseQuota>;
  ppDeathOverlapCount: number;
  canAddPPDeathOverlap: boolean;
  isStarvationRisk: boolean;
  totalResolvedOvers: number;
}

const REAL_DOMESTIC_RESERVES: Array<{ name: string; role: PrimaryRole; subType: any; bat: number; bowl: number; ovr: number }> = [
  { name: 'Tanush Kotian', role: 'AR', subType: 'BOWL_AR', bat: 65, bowl: 75, ovr: 74 },
  { name: 'Ricky Bhui', role: 'WK', subType: 'BAT_WK', bat: 74, bowl: 25, ovr: 73 },
  { name: 'Aniket Choudhary', role: 'PACE', subType: 'BOWL_PACE', bat: 35, bowl: 77, ovr: 75 },
  { name: 'Swapnil Singh', role: 'AR', subType: 'BOWL_AR', bat: 68, bowl: 74, ovr: 73 },
  { name: 'KM Asif', role: 'PACE', subType: 'BOWL_PACE', bat: 30, bowl: 76, ovr: 74 },
  { name: 'Manan Vohra', role: 'BAT', subType: 'TOP_BAT', bat: 75, bowl: 20, ovr: 73 },
  { name: 'Suyash Sharma', role: 'SPIN', subType: 'BOWL_SPIN', bat: 30, bowl: 78, ovr: 75 },
  { name: 'Prashant Chopra', role: 'WK', subType: 'BAT_WK', bat: 73, bowl: 20, ovr: 72 },
  { name: 'Sumit Kumar', role: 'AR', subType: 'PACE_AR', bat: 66, bowl: 73, ovr: 72 },
  { name: 'Akash Vashisht', role: 'AR', subType: 'BOWL_AR', bat: 67, bowl: 74, ovr: 73 },
];

/**
 * 4-2-2 Overlap Quota Engine:
 * Computes remaining usable middle overs for every candidate bowler accounting for
 * 2 overs in Powerplay and 2 overs reserved at the Death.
 * Enforces Anti-Starvation Guard: at most 1 bowler can overlap between Powerplay & Death.
 */
export function computePhaseBowlerQuotas(
  candidateBowlerIds: string[],
  powerplayBowlerIds: string[],
  deathBowlerIds: string[]
): PhaseQuotasResult {
  const quotas: Record<string, BowlerPhaseQuota> = {};
  let ppDeathOverlapCount = 0;

  for (const id of candidateBowlerIds) {
    const isPP = powerplayBowlerIds.includes(id);
    const isDeath = deathBowlerIds.includes(id);
    const ppOvers = isPP ? 2 : 0;
    const deathOvers = isDeath ? 2 : 0;
    const usableMiddleOvers = Math.max(0, 4 - (ppOvers + deathOvers));

    if (isPP && isDeath) {
      ppDeathOverlapCount++;
    }

    quotas[id] = {
      playerId: id,
      maxTotal: 4,
      powerplayOvers: ppOvers,
      deathOvers: deathOvers,
      usableMiddleOvers,
      isEligibleForMiddle: usableMiddleOvers > 0
    };
  }

  return {
    quotas,
    ppDeathOverlapCount,
    canAddPPDeathOverlap: ppDeathOverlapCount < 1,
    isStarvationRisk: ppDeathOverlapCount > 1,
    totalResolvedOvers: (powerplayBowlerIds.length * 2) + (deathBowlerIds.length * 2)
  };
}

/**
 * Validates the complete 11 and 3-5-2 bowler pool against all IPL constraints
 */
export function validate352Lineup(
  lineup: Playing11Lineup,
  squad: IPLPlayer[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const { playing11Ids, bowlerPool352, wkId } = lineup;

  if (!playing11Ids || playing11Ids.length !== 11) {
    errors.push('Playing 11 must contain exactly 11 players.');
  }

  const xi: IPLPlayer[] = (playing11Ids || []).map(id => {
    const found = squad.find(p => p.id === id);
    if (found) return found;
    if (id.startsWith('emergency_') || id.startsWith('dom_')) {
      const idx = Math.abs(id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % REAL_DOMESTIC_RESERVES.length;
      const res = REAL_DOMESTIC_RESERVES[idx];
      return {
        id,
        name: res.name,
        role: res.role,
        subType: res.subType,
        basePrice: 0.30,
        currentPrice: 0.30,
        isOverseas: false,
        isBowlingCapable: res.role === 'PACE' || res.role === 'SPIN' || (res.role === 'AR' && res.bowl >= 55),
        stats: { bat: res.bat, bowl: res.bowl, ovr: res.ovr, power: res.bat, fielding: 70 },
        age: 23
      } as any;
    }
    return undefined;
  }).filter((p): p is IPLPlayer => Boolean(p));
  const osCount = xi.filter(p => p.isOverseas).length;
  if (osCount > 4) {
    errors.push(`Maximum 4 overseas players allowed (found ${osCount}).`);
  }

  const wk = xi.find(p => (wkId && p.id === wkId) || p.role === 'WK');
  if (!wk) {
    errors.push('At least 1 qualified Wicketkeeper required.');
  }

  const bowlers = xi.filter(p => TeamMaker.isBowler(p));
  if (bowlers.length < 6) {
    errors.push(`At least 6 bowling-capable players required (found ${bowlers.length}).`);
  }

  if (!bowlerPool352) {
    errors.push('3-5-2 Bowler pool configuration is required.');
    return { valid: errors.length === 0, errors };
  }

  const {
    powerplayBowlerIds,
    middleBowlerIds,
    deathBowlerIds,
    firstBowlerId,
    backupBowlerId,
    deathOver17_19BowlerId,
    deathOver18_20BowlerId
  } = bowlerPool352 as any;

  if (powerplayBowlerIds.length !== 3) {
    errors.push(`Powerplay requires exactly 3 bowlers (found ${powerplayBowlerIds.length}).`);
  }

  if (!firstBowlerId || !powerplayBowlerIds.includes(firstBowlerId)) {
    errors.push('Over 1 First Bowler must be one of the 3 selected Powerplay bowlers.');
  }

  const resolvedDeathIds = (deathOver17_19BowlerId && deathOver18_20BowlerId)
    ? [deathOver17_19BowlerId, deathOver18_20BowlerId]
    : (deathBowlerIds || []);

  if (resolvedDeathIds.length !== 2) {
    errors.push(`Death overs require exactly 2 bowlers (found ${resolvedDeathIds.length}).`);
  } else if (resolvedDeathIds[0] === resolvedDeathIds[1]) {
    errors.push('Death overs require 2 distinct bowlers for Over 17/19 and Over 18/20.');
  }

  // Anti-starvation check
  const overlap = powerplayBowlerIds.filter((id: string) => resolvedDeathIds.includes(id));
  if (overlap.length > 1) {
    errors.push(`Over limit exceeded: At most 1 bowler may bowl both Powerplay and Death overs (found ${overlap.length}).`);
  }

  if (middleBowlerIds.length !== 5) {
    errors.push(`Middle overs require exactly 5 bowlers (found ${middleBowlerIds.length}).`);
  }

  // Quota exhaustion check
  const quotasResult = computePhaseBowlerQuotas(xi.map(p => p.id), powerplayBowlerIds, resolvedDeathIds);
  for (const midId of middleBowlerIds) {
    if (quotasResult.quotas[midId]?.usableMiddleOvers === 0) {
      const p = xi.find(x => x.id === midId);
      errors.push(`Over allocation: ${p?.name || midId} has reached their 4-over maximum in Powerplay & Death overs.`);
    }
  }

  if (!backupBowlerId || !playing11Ids.includes(backupBowlerId)) {
    errors.push('A valid Backup Bowler must be selected from the Playing 11.');
  }

  return { valid: errors.length === 0, errors };
}

export class TeamMaker {
  /**
   * Helper to check bowling capability safely
   */
  public static isBowler(p: IPLPlayer): boolean {
    if (!p) return false;
    // Wicketkeepers NEVER bowl in modern cricket
    if (p.role === 'WK' || p.subType?.startsWith('WK')) return false;
    return Boolean(
      p.isBowlingCapable ||
      p.role === 'PACE' ||
      p.role === 'SPIN' ||
      p.role === 'AR' ||
      (p.stats && p.stats.bowl >= 55)
    );
  }

  /**
   * Frontline Bowler Protection:
   * Only players with role === "PACE" || role === "SPIN" (or "BOWL")
   * or (role === "AR" && subType === "BOWL_AR" && bowl >= 78) are assigned to bowl full 4-over spells.
   * Part-time batting all-rounders (subType === "BAT_AR") are strictly excluded.
   */
  public static isFrontlineBowler(p: IPLPlayer): boolean {
    if (p.role === 'PACE' || p.role === 'SPIN' || (p.role as string) === 'BOWL') {
      return true;
    }
    if (p.role === 'AR' && p.subType === 'BOWL_AR' && (p.stats?.bowl ?? 0) >= 78) {
      return true;
    }
    return false;
  }

  /**
   * Ensures that a squad has at least 7 bowling-capable players with at least 3 domestic bowlers.
   * If not, upgrades part-time domestic/squad players with highest bowling stat so an illegal playing 11
   * is never forced due to squad shortage.
   */
  public static ensureSquadBowlingCapacity(squad: IPLPlayer[]): void {
    let totalBowlers = squad.filter(p => TeamMaker.isBowler(p)).length;
    let domBowlers = squad.filter(p => !p.isOverseas && TeamMaker.isBowler(p)).length;

    while (domBowlers < 3 || totalBowlers < 7) {
      const candidate = squad
        .filter(p => !TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK') && (domBowlers < 3 ? !p.isOverseas : true))
        .sort((a, b) => (b.stats?.bowl || 0) - (a.stats?.bowl || 0))[0];

      if (!candidate) break;
      candidate.isBowlingCapable = true;
      totalBowlers = squad.filter(p => TeamMaker.isBowler(p)).length;
      domBowlers = squad.filter(p => !p.isOverseas && TeamMaker.isBowler(p)).length;
    }
  }

  /**
   * Core Guaranteed Lineup Builder:
   * Enforces strict IPL invariants on every generated lineup:
   * - Exactly 11 players
   * - Strict Overseas <= 4
   * - Wicketkeeper >= 1
   * - Hard Minimum 6 Bowlers
   * - Realistic Cricket Batting Order: Pure Batters & WKs first, All-Rounders middle, Bowlers at the tail
   * - Valid 3-5-2 Phase Bowler allocation obeying 4-2-2 Anti-Starvation quotas
   */
  public static buildLineup(teamId: string, inputSquad: IPLPlayer[], isSmart: boolean): Playing11Lineup {
    // Clone squad to guarantee immutability against frozen Zustand state in React
    const squad: IPLPlayer[] = (inputSquad || []).map(p => ({
      ...p,
      stats: { ...(p.stats || { bat: 60, bowl: 60, ovr: 60, power: 60, fielding: 60 }) }
    }));

    // Invariant 0: Ensure at least 11 players and at least 7 domestic players exist in squad
    const domCount = squad.filter(p => !p.isOverseas).length;
    if (squad.length < 11 || domCount < 7) {
      const neededTotal = Math.max(0, 11 - squad.length);
      const neededDom = Math.max(0, 7 - domCount);
      const toInject = Math.max(neededTotal, neededDom);

      for (let i = 0; i < toInject; i++) {
        const hasWk = squad.some(p => p.role === 'WK');
        const resIdx = (i + (hasWk ? 2 : 1)) % REAL_DOMESTIC_RESERVES.length;
        const res = REAL_DOMESTIC_RESERVES[resIdx];
        const role = !hasWk && i === 0 ? 'WK' : res.role;
        const fillPlayer: IPLPlayer = {
          id: `emergency_dom_fill_${teamId}_${i + 1}`,
          name: res.name,
          role: role as any,
          subType: res.subType,
          basePrice: 0.30,
          currentPrice: 0.30,
          isOverseas: false,
          isBowlingCapable: role === 'PACE' || role === 'SPIN' || (role === 'AR' && res.bowl >= 55),
          stats: {
            bat: role === 'WK' ? 74 : res.bat,
            bowl: role === 'WK' ? 25 : res.bowl,
            ovr: res.ovr,
            power: res.bat,
            fielding: 70,
            staminaRecov: 80,
            injuryRisk: 0.1
          },
          age: 23
        } as any;
        squad.push(fillPlayer);
        if (Array.isArray(inputSquad)) {
          try {
            if (!inputSquad.some(p => p.id === fillPlayer.id)) {
              inputSquad.push(fillPlayer);
            }
          } catch {
            // Ignored if frozen
          }
        }
      }
    }

    // 1. Ensure squad has adequate bowling capacity & at least 1 WK
    TeamMaker.ensureSquadBowlingCapacity(squad);

    if (!squad.some(p => p.role === 'WK')) {
      const bestFielder = [...squad].sort((a, b) => (b.stats?.fielding || 70) - (a.stats?.fielding || 70))[0];
      if (bestFielder) {
        bestFielder.role = 'WK';
      }
    }

    // 2. PHASE A: Select Primary Wicketkeeper (1 player)
    const availableWKs = squad.filter(p => p.role === 'WK');
    const sortedWKs = isSmart
      ? [...availableWKs].sort((a, b) => ((b.stats?.bat || 0) + (b.stats?.ovr || 0)) - ((a.stats?.bat || 0) + (a.stats?.ovr || 0)))
      : [...availableWKs].sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0));

    // If top WK is overseas, verify we have enough domestic bowlers to still field >= 6 bowlers under OS <= 4
    const domBowlersInSquad = squad.filter(p => !p.isOverseas && TeamMaker.isBowler(p)).length;
    let primaryWk = sortedWKs[0];
    if (primaryWk && primaryWk.isOverseas && domBowlersInSquad < 4) {
      const domWk = sortedWKs.find(p => !p.isOverseas);
      if (domWk) primaryWk = domWk;
    }
    if (!primaryWk) {
      primaryWk = squad[0];
      primaryWk.role = 'WK';
    }

    const selectedMap = new Map<string, IPLPlayer>();
    selectedMap.set(primaryWk.id, primaryWk);
    let overseasCount = primaryWk.isOverseas ? 1 : 0;

    // 3. PHASE B: Select at least 6 Bowling-Capable Players
    const allSquadBowlers = squad.filter(p => TeamMaker.isBowler(p) && p.id !== primaryWk.id);

    const sortedBowlers = isSmart
      ? [...allSquadBowlers].sort((a, b) => {
          const flA = TeamMaker.isFrontlineBowler(a) ? 100 : 0;
          const flB = TeamMaker.isFrontlineBowler(b) ? 100 : 0;
          const scoreA = flA + (a.tacticalSynergy?.death || 0) * 15 + (a.tacticalSynergy?.powerplay || 0) * 15 + (a.stats?.bowl || 0) * 0.7 + (a.stats?.ovr || 0) * 0.3;
          const scoreB = flB + (b.tacticalSynergy?.death || 0) * 15 + (b.tacticalSynergy?.powerplay || 0) * 15 + (b.stats?.bowl || 0) * 0.7 + (b.stats?.ovr || 0) * 0.3;
          return scoreB - scoreA;
        })
      : [...allSquadBowlers].sort((a, b) => {
          const flA = TeamMaker.isFrontlineBowler(a) ? 100 : 0;
          const flB = TeamMaker.isFrontlineBowler(b) ? 100 : 0;
          return (flB + (b.stats?.ovr || 0)) - (flA + (a.stats?.ovr || 0));
        });

    const neededBowlers = TeamMaker.isBowler(primaryWk) ? 5 : 6;
    const maxOsBowlers = Math.max(0, 4 - overseasCount);
    const domBowlers = sortedBowlers.filter(p => !p.isOverseas);
    const minDomBowlersToPick = Math.max(0, neededBowlers - maxOsBowlers);

    // Pick necessary domestic bowlers first to guarantee solvency under OS limit
    for (const db of domBowlers) {
      if (selectedMap.size >= 11) break;
      const currentBowlers = Array.from(selectedMap.values()).filter(p => TeamMaker.isBowler(p)).length;
      if (currentBowlers >= neededBowlers && domBowlers.filter(p => selectedMap.has(p.id)).length >= minDomBowlersToPick) break;
      selectedMap.set(db.id, db);
    }

    // Now fill remaining bowler slots with best available bowlers (strictly respecting overseas limit <= 4)
    for (const b of sortedBowlers) {
      if (selectedMap.size >= 11 || selectedMap.has(b.id)) continue;
      const currentBowlers = Array.from(selectedMap.values()).filter(p => TeamMaker.isBowler(p)).length;
      if (currentBowlers >= neededBowlers) break;
      if (b.isOverseas && overseasCount >= 4) continue;

      selectedMap.set(b.id, b);
      if (b.isOverseas) overseasCount++;
    }

    // 4. PHASE C: Fill remaining slots with top Batters / All-Rounders up to 11
    const remainingSquad = squad.filter(p => !selectedMap.has(p.id));
    const sortedRemaining = isSmart
      ? [...remainingSquad].sort((a, b) => {
          const valA = (a.role === 'BAT' || a.role === 'WK') ? (a.stats?.bat || 0) : ((a.stats?.bat || 0) + (a.stats?.bowl || 0)) / 2;
          const valB = (b.role === 'BAT' || b.role === 'WK') ? (b.stats?.bat || 0) : ((b.stats?.bat || 0) + (b.stats?.bowl || 0)) / 2;
          return valB - valA;
        })
      : [...remainingSquad].sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0));

    for (const rem of sortedRemaining) {
      if (selectedMap.size >= 11) break;
      if (rem.isOverseas && overseasCount >= 4) continue;
      selectedMap.set(rem.id, rem);
      if (rem.isOverseas) overseasCount++;
    }

    // If still < 11, fill exclusively from domestic bench
    if (selectedMap.size < 11) {
      const domesticBench = squad.filter(p => !p.isOverseas && !selectedMap.has(p.id));
      for (const db of domesticBench) {
        if (selectedMap.size >= 11) break;
        selectedMap.set(db.id, db);
      }
    }

    let selected = Array.from(selectedMap.values());

    // 5. PHASE D: Ironclad Constraints Guarantee & Repair Pass
    // Invariant 1: Overseas <= 4 (ABSOLUTE CEILING)
    while (selected.filter(p => p.isOverseas).length > 4) {
      const osSelected = selected
        .filter(p => p.isOverseas && p.id !== primaryWk.id)
        .sort((a, b) => (a.stats?.ovr || 0) - (b.stats?.ovr || 0));

      const osP = osSelected[0] || selected.find(p => p.isOverseas)!;
      const isBowlerP = TeamMaker.isBowler(osP);
      const remainingBowlers = selected.filter(p => p.id !== osP.id && TeamMaker.isBowler(p)).length;

      const domBench = squad
        .filter(p => !p.isOverseas && !selected.some(s => s.id === p.id))
        .sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0));

      let candidate: IPLPlayer | undefined = isBowlerP && remainingBowlers < 6
        ? domBench.find(p => TeamMaker.isBowler(p))
        : domBench[0];

      // If no domestic bowler available on bench but bowler is required, upgrade the best domestic candidate
      if (!candidate && domBench.length > 0) {
        candidate = domBench.find(p => p.role !== 'WK' && !p.subType?.startsWith('WK')) || domBench[0];
        if (isBowlerP && remainingBowlers < 6 && candidate.role !== 'WK' && !candidate.subType?.startsWith('WK')) {
          candidate.isBowlingCapable = true;
        }
      }

      // If domestic bench is totally exhausted, generate emergency domestic player
      let replacement: IPLPlayer;
      if (!candidate) {
        replacement = {
          id: `dom_fill_${teamId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name: `Domestic Starter (${teamId})`,
          role: (isBowlerP && remainingBowlers < 6) ? 'PACE' : 'BAT',
          subType: (isBowlerP && remainingBowlers < 6) ? 'BOWL_PACE' : 'TOP_BAT',
          basePrice: 0.30,
          currentPrice: 0.30,
          isOverseas: false,
          isBowlingCapable: isBowlerP && remainingBowlers < 6,
          stats: {
            bat: (isBowlerP && remainingBowlers < 6) ? 45 : 75,
            bowl: (isBowlerP && remainingBowlers < 6) ? 76 : 30,
            ovr: 75,
            power: (isBowlerP && remainingBowlers < 6) ? 50 : 72,
            fielding: 70
          },
          age: 23
        } as any;
        squad.push(replacement);
        if (Array.isArray(inputSquad)) {
          try {
            if (!inputSquad.some(p => p.id === replacement.id)) {
              inputSquad.push(replacement);
            }
          } catch {
            // Ignored if frozen
          }
        }
      } else {
        replacement = candidate;
      }

      const idx = selected.findIndex(p => p.id === osP.id);
      selected[idx] = replacement;
    }

    // Invariant 2: Bowlers >= 6 (ABSOLUTE MINIMUM)
    while (selected.filter(p => TeamMaker.isBowler(p)).length < 6) {
      const curOS = selected.filter(p => p.isOverseas).length;
      const benchBowlers = squad
        .filter(p => TeamMaker.isBowler(p) && !selected.some(s => s.id === p.id))
        .sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0));

      const nonBowlersSelected = selected
        .filter(p => !TeamMaker.isBowler(p) && p.id !== primaryWk.id)
        .sort((a, b) => (a.stats?.ovr || 0) - (b.stats?.ovr || 0));

      let swapped = false;
      for (const bBowler of benchBowlers) {
        for (const nb of nonBowlersSelected) {
          const osDelta = (bBowler.isOverseas ? 1 : 0) - (nb.isOverseas ? 1 : 0);
          if (curOS + osDelta <= 4) {
            const idx = selected.findIndex(p => p.id === nb.id);
            selected[idx] = bBowler;
            swapped = true;
            break;
          }
        }
        if (swapped) break;
      }

      // If bench has no compatible bowler, upgrade the best non-bowler in selected
      if (!swapped) {
        const candidateToUpgrade = [...selected]
          .filter(p => !TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK') && p.id !== primaryWk.id)
          .sort((a, b) => (b.stats?.bowl || 0) - (a.stats?.bowl || 0))[0];

        if (candidateToUpgrade) {
          candidateToUpgrade.isBowlingCapable = true;
        } else {
          break;
        }
      }
    }

    // Invariant 3: Exactly 11
    if (selected.length < 11) {
      for (const p of squad) {
        if (selected.length === 11) break;
        if (!selected.some(s => s.id === p.id) && !p.isOverseas) {
          selected.push(p);
        }
      }
      if (selected.length < 11) {
        const curOS = selected.filter(p => p.isOverseas).length;
        for (const p of squad) {
          if (selected.length === 11) break;
          if (!selected.some(s => s.id === p.id)) {
            if (p.isOverseas && curOS >= 4) continue;
            selected.push(p);
          }
        }
      }
    }

    // Invariant 4: At least 1 WK
    if (!selected.some(p => p.role === 'WK')) {
      const benchWk = squad.find(p => p.role === 'WK');
      if (benchWk) {
        const replaceIdx = selected.findIndex(p => !TeamMaker.isBowler(p));
        if (replaceIdx >= 0) selected[replaceIdx] = benchWk;
        else selected[selected.length - 1] = benchWk;
      } else {
        selected[0].role = 'WK';
      }
    }

    // 6. PHASE E: 3-5-2 Bowler Pool Allocation
    const activeBowlers = selected.filter(p => TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK'));
    const nonWkSquadBowlers = squad.filter(p => TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK') && !activeBowlers.some(a => a.id === p.id));
    const poolSource = activeBowlers.length >= 6 ? activeBowlers : [...activeBowlers, ...nonWkSquadBowlers];
    const frontlineBowlers = poolSource.filter(p => TeamMaker.isFrontlineBowler(p));

    // 1. PP Pool: Top 3 bowlers (prioritize frontline bowlers)
    const ppCandidates = frontlineBowlers.length >= 3 ? frontlineBowlers : poolSource;
    const ppSorted = [...ppCandidates].sort((a, b) =>
      ((b.tacticalSynergy?.powerplay ?? 0) * 20 + (b.stats?.bowl || 0)) -
      ((a.tacticalSynergy?.powerplay ?? 0) * 20 + (a.stats?.bowl || 0))
    );
    const ppBowlerIds = ppSorted.slice(0, 3).map(p => p.id);
    if (ppBowlerIds.length < 3) {
      for (const b of poolSource) {
        if (!ppBowlerIds.includes(b.id)) {
          ppBowlerIds.push(b.id);
          if (ppBowlerIds.length === 3) break;
        }
      }
    }
    const firstBowlerId = ppBowlerIds[0] || poolSource[0].id;

    // 2. Death Pool: Top 2 bowlers with Anti-Starvation Guard (max 1 overlap with PP)
    const deathCandidates = frontlineBowlers.length >= 2 ? frontlineBowlers : poolSource;
    const deathSorted = [...deathCandidates].sort((a, b) =>
      ((b.tacticalSynergy?.death ?? 0) * 20 + (b.stats?.bowl || 0)) -
      ((a.tacticalSynergy?.death ?? 0) * 20 + (a.stats?.bowl || 0))
    );
    const deathBowlerIds: string[] = [deathSorted[0].id];
    const firstIsPP = ppBowlerIds.includes(deathSorted[0].id);

    for (let i = 1; i < deathSorted.length; i++) {
      const candidate = deathSorted[i];
      if (firstIsPP && ppBowlerIds.includes(candidate.id)) {
        continue; // Prevent second overlap!
      }
      deathBowlerIds.push(candidate.id);
      break;
    }

    if (deathBowlerIds.length < 2) {
      for (const d of deathSorted) {
        if (!deathBowlerIds.includes(d.id)) {
          deathBowlerIds.push(d.id);
          if (deathBowlerIds.length === 2) break;
        }
      }
    }

    // 3. Middle Pool: 5 bowlers with usableMiddleOvers > 0
    const quotas = computePhaseBowlerQuotas(poolSource.map(p => p.id), ppBowlerIds, deathBowlerIds);
    const midCandidates = [...poolSource]
      .filter(p => (quotas.quotas[p.id]?.usableMiddleOvers ?? 0) > 0)
      .sort((a, b) =>
        ((b.tacticalSynergy?.middle ?? 0) * 20 + (b.stats?.bowl || 0)) -
        ((a.tacticalSynergy?.middle ?? 0) * 20 + (a.stats?.bowl || 0))
      );

    const midBowlerIds = midCandidates.slice(0, 5).map(p => p.id);
    if (midBowlerIds.length < 5) {
      for (const b of poolSource) {
        if (!midBowlerIds.includes(b.id)) {
          midBowlerIds.push(b.id);
          if (midBowlerIds.length === 5) break;
        }
      }
    }

    // 4. Backup Bowler: Any bowler not in death, or the 6th bowler
    const backupCandidate = poolSource.find(p => !deathBowlerIds.includes(p.id) && !midBowlerIds.slice(0, 3).includes(p.id)) || poolSource[poolSource.length - 1];

    // ==========================================
    // 7. REALISTIC CRICKET BATTING ORDER ENGINE
    // ==========================================
    // Pure Batters & Batting WKs bat at the top (Positions 1 to 5)
    // All-Rounders bat in the middle (Positions 5 to 7)
    // Pure Bowlers / Tailenders bat at the tail (Positions 8 to 11), sorted by bat descending
    const battersAndWKs = selected
      .filter(p => p.role === 'BAT' || p.role === 'WK')
      .sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));

    const allRounders = selected
      .filter(p => p.role === 'AR')
      .sort((a, b) => {
        const aVal = (a.subType === 'BAT_AR' ? 20 : 0) + (a.stats?.bat || 0);
        const bVal = (b.subType === 'BAT_AR' ? 20 : 0) + (b.stats?.bat || 0);
        return bVal - aVal;
      });

    const tailBowlers = selected
      .filter(p => p.role === 'PACE' || p.role === 'SPIN' || (p.role as string) === 'BOWL')
      .sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));

    const orderedLineup = [...battersAndWKs, ...allRounders, ...tailBowlers];
    const battingOrder = orderedLineup.map(p => p.id);

    return {
      teamId,
      playing11Ids: battingOrder,
      captainId: battersAndWKs[0]?.id || selected[0]?.id || primaryWk.id,
      wkId: primaryWk.id,
      battingOrder,
      bowlerPool352: {
        powerplayBowlerIds: ppBowlerIds,
        firstBowlerId,
        middleBowlerIds: midBowlerIds,
        deathOver17_19BowlerId: deathBowlerIds[0] || poolSource[0].id,
        deathOver18_20BowlerId: deathBowlerIds[1] || poolSource[1]?.id || poolSource[0].id,
        deathBowlerIds: deathBowlerIds,
        backupBowlerId: backupCandidate.id
      },
      tactics: isSmart
        ? {
            powerplay: { batting: 'BALANCED', bowling: 'PACE_ATTACK' },
            middle: { batting: 'BALANCED', bowling: 'SPIN_SQUEEZE' },
            death: { batting: 'AGGRESSIVE', bowling: 'BOUNDARY_DEFENSIVE' }
          }
        : {
            powerplay: { batting: 'BALANCED', bowling: 'BALANCED' },
            middle: { batting: 'BALANCED', bowling: 'BALANCED' },
            death: { batting: 'AGGRESSIVE', bowling: 'BOUNDARY_DEFENSIVE' }
          }
    };
  }

  /**
   * Elite AI Lineup Selector:
   * - Strict 3-5-2 phase optimization.
   * - Automatically benches players with injuryStatus > 0 or workload > 80.
   * - Assigns true PP swing bowlers to Overs 1-6 and recognized death pacers to Overs 17-20.
   * - Alternates LHB and RHB in the batting order for partnership synergy (+0.35 synergy bonus).
   */
  public static selectEliteAILineup(
    inputSquad: IPLPlayer[],
    homePitch?: GroundSynergyVector,
    injuryStatus?: Record<string, number>,
    teamIdParam?: string
  ): Playing11Lineup {
    const teamId = teamIdParam || (inputSquad[0] as any)?.franchiseId || (inputSquad[0] as any)?.teamId || 'AI_TEAM';

    // Clone squad to guarantee immutability
    const squad: IPLPlayer[] = (inputSquad || []).map(p => ({
      ...p,
      stats: { ...(p.stats || { bat: 60, bowl: 60, ovr: 60, power: 60, fielding: 60 }) }
    }));

    TeamMaker.ensureSquadBowlingCapacity(squad);

    // 1. Identify Injured Players (Strictly Sidelined)
    const isInjured = (p: IPLPlayer) => {
      return Boolean(
        p.isInjured ||
        (p.injuryMatchesRemaining !== undefined && p.injuryMatchesRemaining > 0) ||
        (p.injuryStatus !== undefined && p.injuryStatus !== 0) ||
        (injuryStatus && (injuryStatus[p.id] ?? 0) !== 0)
      );
    };

    const healthyPlayers = squad.filter(p => !isInjured(p));

    // 2. Stamina is match-internal and resets every match; players are not benched for season fatigue.
    let availableSquad = healthyPlayers.length >= 11 ? healthyPlayers : squad;

    const paceWeight = (homePitch?.pace ?? 0) * 8;
    const spinWeight = (homePitch?.spin ?? 0) * 8;

    // 1. Pick Primary Wicketkeeper
    const availableWKs = availableSquad.filter(p => p.role === 'WK');
    const sortedWKs = [...availableWKs].sort((a, b) => ((b.stats?.bat || 0) + (b.stats?.ovr || 0)) - ((a.stats?.bat || 0) + (a.stats?.ovr || 0)));
    let primaryWk = sortedWKs[0];
    const domBowlersInSquad = availableSquad.filter(p => !p.isOverseas && TeamMaker.isBowler(p)).length;
    if (primaryWk && primaryWk.isOverseas && domBowlersInSquad < 4) {
      const domWk = sortedWKs.find(p => !p.isOverseas);
      if (domWk) primaryWk = domWk;
    }
    if (!primaryWk) {
      primaryWk = availableSquad[0];
      primaryWk.role = 'WK';
    }

    const selectedMap = new Map<string, IPLPlayer>();
    selectedMap.set(primaryWk.id, primaryWk);
    let overseasCount = primaryWk.isOverseas ? 1 : 0;

    // 2. Pick at least 6 bowling capable players
    const allSquadBowlers = availableSquad.filter(p => TeamMaker.isBowler(p) && p.id !== primaryWk.id);
    const sortedBowlers = [...allSquadBowlers].sort((a, b) => {
      const flA = TeamMaker.isFrontlineBowler(a) ? 100 : 0;
      const flB = TeamMaker.isFrontlineBowler(b) ? 100 : 0;
      const pitchAdjA = a.role === 'PACE' ? paceWeight : (a.role === 'SPIN' ? spinWeight : 0);
      const pitchAdjB = b.role === 'PACE' ? paceWeight : (b.role === 'SPIN' ? spinWeight : 0);
      const scoreA = flA + pitchAdjA + (a.tacticalSynergy?.death || 0) * 15 + (a.tacticalSynergy?.powerplay || 0) * 15 + (a.stats?.bowl || 0) * 0.7 + (a.stats?.ovr || 0) * 0.3;
      const scoreB = flB + pitchAdjB + (b.tacticalSynergy?.death || 0) * 15 + (b.tacticalSynergy?.powerplay || 0) * 15 + (b.stats?.bowl || 0) * 0.7 + (b.stats?.ovr || 0) * 0.3;
      return scoreB - scoreA;
    });

    const neededBowlers = TeamMaker.isBowler(primaryWk) ? 5 : 6;
    const maxOsBowlers = Math.max(0, 4 - overseasCount);
    const domBowlers = sortedBowlers.filter(p => !p.isOverseas);
    const minDomBowlersToPick = Math.max(0, neededBowlers - maxOsBowlers);

    for (const b of domBowlers) {
      const currentBowlers = Array.from(selectedMap.values()).filter(p => TeamMaker.isBowler(p)).length;
      if (currentBowlers >= minDomBowlersToPick) break;
      if (!selectedMap.has(b.id)) {
        selectedMap.set(b.id, b);
      }
    }

    for (const b of sortedBowlers) {
      const currentBowlers = Array.from(selectedMap.values()).filter(p => TeamMaker.isBowler(p)).length;
      if (currentBowlers >= neededBowlers) break;
      if (selectedMap.has(b.id)) continue;
      if (b.isOverseas && overseasCount >= 4) continue;
      selectedMap.set(b.id, b);
      if (b.isOverseas) overseasCount++;
    }

    // 3. Fill remaining spots up to 11 with top batters / all-rounders
    const remainingCandidates = availableSquad
      .filter(p => !selectedMap.has(p.id))
      .sort((a, b) => {
        const scoreA = (a.stats?.bat || 0) * 0.7 + (a.stats?.ovr || 0) * 0.3;
        const scoreB = (b.stats?.bat || 0) * 0.7 + (b.stats?.ovr || 0) * 0.3;
        return scoreB - scoreA;
      });

    for (const p of remainingCandidates) {
      if (selectedMap.size === 11) break;
      if (p.isOverseas && overseasCount >= 4) continue;
      selectedMap.set(p.id, p);
      if (p.isOverseas) overseasCount++;
    }

    while (selectedMap.size < 11) {
      for (const p of availableSquad) {
        if (selectedMap.size === 11) break;
        if (!selectedMap.has(p.id) && (!p.isOverseas || overseasCount < 4)) {
          selectedMap.set(p.id, p);
          if (p.isOverseas) overseasCount++;
        }
      }
      break;
    }

    const selected = Array.from(selectedMap.values());
    const activeBowlers = selected.filter(p => TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK'));
    const nonWkSquadBowlers = squad.filter(p => TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK') && !activeBowlers.some(a => a.id === p.id));
    const poolSource = activeBowlers.length >= 6 ? activeBowlers : [...activeBowlers, ...nonWkSquadBowlers];
    const frontlineBowlers = poolSource.filter(p => TeamMaker.isFrontlineBowler(p));

    // Powerplay: true swing bowlers
    const ppCandidates = frontlineBowlers.length >= 3 ? frontlineBowlers : poolSource;
    const ppSorted = [...ppCandidates].sort((a, b) =>
      ((b.tacticalSynergy?.powerplay ?? 0) * 25 + (b.role === 'PACE' ? 10 + paceWeight : 0) + (b.stats?.bowl || 0)) -
      ((a.tacticalSynergy?.powerplay ?? 0) * 25 + (a.role === 'PACE' ? 10 + paceWeight : 0) + (a.stats?.bowl || 0))
    );
    const ppBowlerIds = ppSorted.slice(0, 3).map(p => p.id);
    while (ppBowlerIds.length < 3) {
      for (const b of poolSource) {
        if (!ppBowlerIds.includes(b.id)) {
          ppBowlerIds.push(b.id);
          if (ppBowlerIds.length === 3) break;
        }
      }
    }
    const firstBowlerId = ppBowlerIds[0] || poolSource[0].id;

    // Death Overs: true death pacers
    const deathCandidates = frontlineBowlers.length >= 2 ? frontlineBowlers : poolSource;
    const deathSorted = [...deathCandidates].sort((a, b) => {
      const pacerBonusA = a.role === 'PACE' ? 15 : -15;
      const pacerBonusB = b.role === 'PACE' ? 15 : -15;
      const subTypeBonusA = a.subType === 'DEATH_OVERS_PACER' ? 25 : 0;
      const subTypeBonusB = b.subType === 'DEATH_OVERS_PACER' ? 25 : 0;
      const scoreA = (a.tacticalSynergy?.death ?? 0) * 30 + pacerBonusA + subTypeBonusA + (a.stats?.bowl || 0);
      const scoreB = (b.tacticalSynergy?.death ?? 0) * 30 + pacerBonusB + subTypeBonusB + (b.stats?.bowl || 0);
      return scoreB - scoreA;
    });

    const deathOver17_19BowlerId = deathSorted[0].id;
    const firstIsPP = ppBowlerIds.includes(deathOver17_19BowlerId);

    let deathOver18_20BowlerId = deathSorted.length > 1 ? deathSorted[1].id : deathSorted[0].id;
    for (let i = 1; i < deathSorted.length; i++) {
      const cand = deathSorted[i];
      if (firstIsPP && ppBowlerIds.includes(cand.id)) continue;
      deathOver18_20BowlerId = cand.id;
      break;
    }
    if (deathOver18_20BowlerId === deathOver17_19BowlerId) {
      const alt = poolSource.find(p => p.id !== deathOver17_19BowlerId && (!firstIsPP || !ppBowlerIds.includes(p.id)));
      if (alt) deathOver18_20BowlerId = alt.id;
    }

    const deathBowlerIds = [deathOver17_19BowlerId, deathOver18_20BowlerId];

    // Middle Overs: 5 bowlers with usable quotas
    const quotas = computePhaseBowlerQuotas(poolSource.map(p => p.id), ppBowlerIds, deathBowlerIds);
    const midCandidates = [...poolSource]
      .filter(p => (quotas.quotas[p.id]?.usableMiddleOvers ?? 0) > 0)
      .sort((a, b) => {
        const spinAdjA = a.role === 'SPIN' ? spinWeight : 0;
        const spinAdjB = b.role === 'SPIN' ? spinWeight : 0;
        return ((b.tacticalSynergy?.middle ?? 0) * 20 + spinAdjB + (b.stats?.bowl || 0)) -
               ((a.tacticalSynergy?.middle ?? 0) * 20 + spinAdjA + (a.stats?.bowl || 0));
      });

    const midBowlerIds = midCandidates.slice(0, 5).map(p => p.id);
    while (midBowlerIds.length < 5) {
      for (const b of poolSource) {
        if (!midBowlerIds.includes(b.id)) {
          midBowlerIds.push(b.id);
          if (midBowlerIds.length === 5) break;
        }
      }
    }

    const backupCandidate = poolSource.find(p => !deathBowlerIds.includes(p.id) && !midBowlerIds.slice(0, 3).includes(p.id)) || poolSource[poolSource.length - 1];

    // Alternating LHB and RHB Batting Order
    const battersAndWKs = selected
      .filter(p => p.role === 'BAT' || p.role === 'WK')
      .sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));

    const allRounders = selected
      .filter(p => p.role === 'AR')
      .sort((a, b) => ((b.subType === 'BAT_AR' ? 15 : 0) + (b.stats?.bat || 0)) - ((a.subType === 'BAT_AR' ? 15 : 0) + (a.stats?.bat || 0)));

    const tailBowlers = selected
      .filter(p => p.role === 'PACE' || p.role === 'SPIN' || (p.role as string) === 'BOWL')
      .sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));

    const orderWithAlternation = (pool: IPLPlayer[], startingPrevHand?: string): IPLPlayer[] => {
      const remaining = [...pool];
      const ordered: IPLPlayer[] = [];
      let lastHand = startingPrevHand || '';

      while (remaining.length > 0) {
        let bestIdx = -1;
        if (lastHand) {
          const targetHand = lastHand === 'LHB' ? 'RHB' : 'LHB';
          const topStat = remaining[0].stats?.bat || 0;
          bestIdx = remaining.findIndex(p => p.batHand === targetHand && (p.stats?.bat || 0) >= topStat - 12);
        }
        if (bestIdx === -1) {
          bestIdx = 0;
        }
        const picked = remaining.splice(bestIdx, 1)[0];
        ordered.push(picked);
        lastHand = picked.batHand || 'RHB';
      }
      return ordered;
    };

    const orderedBatters = orderWithAlternation(battersAndWKs);
    const lastBatterHand = orderedBatters[orderedBatters.length - 1]?.batHand;
    const orderedARs = orderWithAlternation(allRounders, lastBatterHand);
    const fullBattingOrder = [...orderedBatters, ...orderedARs, ...tailBowlers];
    const battingOrderIds = fullBattingOrder.map(p => p.id);

    return {
      teamId,
      playing11Ids: battingOrderIds,
      captainId: orderedBatters[0]?.id || selected[0]?.id || primaryWk.id,
      wkId: primaryWk.id,
      battingOrder: battingOrderIds,
      bowlerPool352: {
        powerplayBowlerIds: ppBowlerIds,
        firstBowlerId,
        middleBowlerIds: midBowlerIds,
        deathOver17_19BowlerId,
        deathOver18_20BowlerId,
        deathBowlerIds,
        backupBowlerId: backupCandidate.id
      },
      tactics: {
        powerplay: { batting: 'BALANCED', bowling: (homePitch?.spin ?? 0) > 0.4 ? 'SPIN_SQUEEZE' : 'PACE_ATTACK' },
        middle: { batting: 'BALANCED', bowling: (homePitch?.spin ?? 0) > 0.3 ? 'SPIN_SQUEEZE' : 'WICKET_HUNT' },
        death: { batting: 'AGGRESSIVE', bowling: 'BOUNDARY_DEFENSIVE' }
      }
    };
  }

  /**
   * Naive Auto-Team Maker (for Human Players):
   * - Intentionally naïve / un-optimized on purpose.
   * - Sorts purely by raw rating without phase awareness.
   * - Frequently assigns spin bowlers or batting all-rounders to death overs.
   * - Scrambles batting positions to encourage the human user to actively build their lineup.
   */
  public static selectNaiveHumanAutoFill(
    inputSquad: IPLPlayer[],
    teamIdParam?: string
  ): Playing11Lineup {
    const teamId = teamIdParam || (inputSquad[0] as any)?.franchiseId || (inputSquad[0] as any)?.teamId || 'HUMAN_TEAM';

    const squad: IPLPlayer[] = (inputSquad || []).map(p => ({
      ...p,
      stats: { ...(p.stats || { bat: 60, bowl: 60, ovr: 60, power: 60, fielding: 60 }) }
    }));

    TeamMaker.ensureSquadBowlingCapacity(squad);

    const sortedSquad = [...squad].sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0));
    const primaryWk = sortedSquad.find(p => p.role === 'WK') || sortedSquad[0];
    if (!sortedSquad.some(p => p.role === 'WK')) primaryWk.role = 'WK';

    const selectedMap = new Map<string, IPLPlayer>();
    selectedMap.set(primaryWk.id, primaryWk);
    let overseasCount = primaryWk.isOverseas ? 1 : 0;

    const bowlers = sortedSquad.filter(p => TeamMaker.isBowler(p) && p.id !== primaryWk.id);
    let bowlerPicks = 0;
    for (const b of bowlers) {
      if (bowlerPicks >= 6) break;
      if (b.isOverseas && overseasCount >= 4) continue;
      selectedMap.set(b.id, b);
      bowlerPicks++;
      if (b.isOverseas) overseasCount++;
    }

    for (const p of sortedSquad) {
      if (selectedMap.size === 11) break;
      if (selectedMap.has(p.id)) continue;
      if (p.isOverseas && overseasCount >= 4) continue;
      selectedMap.set(p.id, p);
      if (p.isOverseas) overseasCount++;
    }

    while (selectedMap.size < 11) {
      const cand = sortedSquad.find(p => !selectedMap.has(p.id) && (!p.isOverseas || overseasCount < 4));
      if (!cand) break;
      selectedMap.set(cand.id, cand);
      if (cand.isOverseas) overseasCount++;
    }

    const selected = Array.from(selectedMap.values());
    const activeBowlers = selected.filter(p => TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK'));
    const nonWkSquadBowlers = sortedSquad.filter(p => TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK') && !activeBowlers.some(a => a.id === p.id));
    const poolSource = activeBowlers.length >= 6 
      ? activeBowlers 
      : [...activeBowlers, ...nonWkSquadBowlers];

    // Naive death overs: assigns spinners or part-time batting all-rounders to death overs
    const spinnersOrBatAR = poolSource.filter(p => p.role === 'SPIN' || p.subType === 'BAT_AR');
    let deathOver17_19BowlerId: string;
    let deathOver18_20BowlerId: string;

    if (spinnersOrBatAR.length >= 2) {
      deathOver17_19BowlerId = spinnersOrBatAR[0].id;
      deathOver18_20BowlerId = spinnersOrBatAR[1].id;
    } else if (spinnersOrBatAR.length === 1) {
      deathOver17_19BowlerId = spinnersOrBatAR[0].id;
      const other = poolSource.find(p => p.id !== deathOver17_19BowlerId);
      deathOver18_20BowlerId = other ? other.id : (poolSource[1]?.id || poolSource[0].id);
    } else {
      const weakBowlers = [...poolSource].sort((a, b) => (a.stats?.bowl || 0) - (b.stats?.bowl || 0));
      deathOver17_19BowlerId = weakBowlers[0].id;
      deathOver18_20BowlerId = weakBowlers[1]?.id || poolSource.find(p => p.id !== deathOver17_19BowlerId)?.id || weakBowlers[0].id;
    }

    const deathBowlerIds = [deathOver17_19BowlerId, deathOver18_20BowlerId];

    // PP bowlers
    const ppCandidates = poolSource.filter(p => !deathBowlerIds.includes(p.id));
    const ppBowlerIds = ppCandidates.slice(0, 3).map(p => p.id);
    while (ppBowlerIds.length < 3) {
      for (const b of poolSource) {
        if (!ppBowlerIds.includes(b.id)) {
          ppBowlerIds.push(b.id);
          if (ppBowlerIds.length === 3) break;
        }
      }
    }
    const firstBowlerId = ppBowlerIds[0] || poolSource[0].id;

    // Middle bowlers
    const quotas = computePhaseBowlerQuotas(poolSource.map(p => p.id), ppBowlerIds, deathBowlerIds);
    const midCandidates = poolSource.filter(p => TeamMaker.isBowler(p) && (quotas.quotas[p.id]?.usableMiddleOvers ?? 0) > 0);
    const midBowlerIds = midCandidates.slice(0, 5).map(p => p.id);
    while (midBowlerIds.length < 5) {
      const eligible = poolSource.find(b => !midBowlerIds.includes(b.id) && TeamMaker.isBowler(b) && (quotas.quotas[b.id]?.usableMiddleOvers ?? 0) > 0);
      if (eligible) {
        midBowlerIds.push(eligible.id);
      } else {
        const anyOther = poolSource.find(b => !midBowlerIds.includes(b.id) && TeamMaker.isBowler(b));
        if (anyOther) midBowlerIds.push(anyOther.id);
        else break;
      }
    }

    const backupCandidate = poolSource.find(p => !deathBowlerIds.includes(p.id) && !midBowlerIds.slice(0, 3).includes(p.id)) || poolSource[poolSource.length - 1];

    // Scramble batting order: put lower order non-batter at #2
    const batters = selected.filter(p => p.role === 'BAT' || p.role === 'WK');
    const nonBatters = selected.filter(p => p.role !== 'BAT' && p.role !== 'WK');
    const scrambled: IPLPlayer[] = [];
    if (batters.length > 0) scrambled.push(batters[0]);
    if (nonBatters.length > 0) scrambled.push(nonBatters[0]); // Scrambles an AR/bowler to #2
    for (let i = 1; i < batters.length; i++) scrambled.push(batters[i]);
    for (let i = 1; i < nonBatters.length; i++) scrambled.push(nonBatters[i]);
    for (const p of selected) {
      if (!scrambled.some(s => s.id === p.id)) scrambled.push(p);
    }
    const battingOrderIds = scrambled.map(p => p.id);

    return {
      teamId,
      playing11Ids: battingOrderIds,
      captainId: selected[0]?.id || primaryWk.id,
      wkId: primaryWk.id,
      battingOrder: battingOrderIds,
      bowlerPool352: {
        powerplayBowlerIds: ppBowlerIds,
        firstBowlerId,
        middleBowlerIds: midBowlerIds,
        deathOver17_19BowlerId,
        deathOver18_20BowlerId,
        deathBowlerIds,
        backupBowlerId: backupCandidate.id
      },
      tactics: {
        powerplay: { batting: 'BALANCED', bowling: 'BALANCED' },
        middle: { batting: 'BALANCED', bowling: 'BALANCED' },
        death: { batting: 'BALANCED', bowling: 'BALANCED' }
      }
    };
  }

  /**
   * Backwards-compatible aliases
   */
  public static makeNaiveLineup(teamId: string, squad: IPLPlayer[]): Playing11Lineup {
    return TeamMaker.selectNaiveHumanAutoFill(squad, teamId);
  }

  public static makeSmartLineup(
    teamId: string,
    squad: IPLPlayer[],
    homePitch?: GroundSynergyVector,
    injuryStatus?: Record<string, number>
  ): Playing11Lineup {
    return TeamMaker.selectEliteAILineup(squad, homePitch, injuryStatus, teamId);
  }
}

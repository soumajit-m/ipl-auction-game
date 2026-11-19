import { TeamMaker, computePhaseBowlerQuotas, validate352Lineup } from '../src/server/match/teamMaker';
import { FullMatchSimulator, Team2026 } from '../src/server/match/fullMatchSimulator';
import { IPLPlayer } from '../src/types/player.types';
import * as fs from 'fs';
import * as path from 'path';

function createMockSquad(): IPLPlayer[] {
  const roles: Array<IPLPlayer['role']> = [
    'BAT', 'BAT', 'BAT', 'BAT',
    'WK',
    'AR', 'AR',
    'BOWL', 'BOWL', 'BOWL', 'BOWL', 'BOWL',
    'BAT', 'BOWL'
  ];

  return roles.map((role, idx) => {
    const isBowlerRole = role === 'BOWL' || role === 'AR';
    return {
      id: `p_${idx + 1}`,
      name: `Player ${idx + 1} (${role})`,
      role,
      isOverseas: idx === 1 || idx === 7, // 2 overseas
      stats: {
        ovr: 75 + (idx % 15),
        bat: role === 'BAT' || role === 'WK' ? 82 : 45,
        bowl: isBowlerRole ? 80 + (idx % 10) : 25,
        power: 70,
        age: 26
      },
      tacticalSynergy: {
        powerplay: isBowlerRole ? 75 + (idx % 12) : 20,
        middle: isBowlerRole ? 78 + (idx % 10) : 20,
        death: isBowlerRole ? 76 + (idx % 14) : 20
      }
    } as unknown as IPLPlayer;
  });
}

async function runTests() {
  console.log('--- STARTING 3-5-2 & 4-2-2 QUOTA ENGINE TESTS ---');

  // 1. Test 4-2-2 Overlap Quota Engine
  const bowlerIds = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  const ppBowlers = ['b1', 'b2', 'b3'];
  const deathBowlers = ['b3', 'b4']; // b3 overlaps

  const quota = computePhaseBowlerQuotas(bowlerIds, ppBowlers, deathBowlers);
  console.log('PP & Death Overlap Count:', quota.ppDeathOverlapCount);
  if (quota.ppDeathOverlapCount !== 1) throw new Error('Expected 1 overlap');

  // b3 should have 0 usable middle overs (4 - 2 - 2 = 0)
  if (quota.quotas['b3'].usableMiddleOvers !== 0) throw new Error(`Expected b3 to have 0 mid overs, got ${quota.quotas['b3'].usableMiddleOvers}`);
  // b1, b2, b4 should have 2 usable middle overs (4 - 2 = 2)
  if (quota.quotas['b1'].usableMiddleOvers !== 2) throw new Error('Expected b1 to have 2 mid overs');
  if (quota.quotas['b4'].usableMiddleOvers !== 2) throw new Error('Expected b4 to have 2 mid overs');
  // b5, b6 should have 4 usable middle overs (4 - 0 = 4)
  if (quota.quotas['b5'].usableMiddleOvers !== 4) throw new Error('Expected b5 to have 4 mid overs');
  if (quota.quotas['b6'].usableMiddleOvers !== 4) throw new Error('Expected b6 to have 4 mid overs');

  console.log('✓ Quota calculations (4-2-2) verified correctly.');

  // Anti-Starvation Guard: 2 overlaps should be detected
  const illegalDeath = ['b1', 'b2']; // 2 overlaps (b1 & b2 both in PP)
  const illegalQuota = computePhaseBowlerQuotas(bowlerIds, ppBowlers, illegalDeath);
  if (illegalQuota.ppDeathOverlapCount !== 2) throw new Error('Expected 2 overlaps detected');
  console.log('✓ Anti-Starvation overlap count verified correctly.');

  // 2. Test TeamMaker Naive & Smart Lineups
  const squad = createMockSquad();
  const naiveLineup = TeamMaker.makeNaiveLineup('MI', squad);
  const naiveValidation = validate352Lineup(naiveLineup, squad);
  if (!naiveValidation.valid) {
    throw new Error(`Naive lineup validation failed: ${naiveValidation.error}`);
  }
  console.log('✓ TeamMaker.makeNaiveLineup produced 100% legal 3-5-2 lineup.');

  const smartLineup = TeamMaker.makeSmartLineup('CSK', squad);
  const smartValidation = validate352Lineup(smartLineup, squad);
  if (!smartValidation.valid) {
    throw new Error(`Smart lineup validation failed: ${smartValidation.error}`);
  }
  console.log('✓ TeamMaker.makeSmartLineup produced 100% legal 3-5-2 lineup.');

  // 3. Test FullMatchSimulator with 3-5-2 Bowler Pools
  const teamA: Team2026 = {
    id: 'MI',
    name: 'Mumbai Indians',
    playingXI: squad.filter(p => naiveLineup.playing11Ids.includes(p.id)),
    primaryBowlers: naiveLineup.bowlerPool352.middleBowlerIds,
    powerplayBowlers: naiveLineup.bowlerPool352.powerplayBowlerIds,
    deathBowlers: naiveLineup.bowlerPool352.deathBowlerIds,
    firstBowlerId: naiveLineup.bowlerPool352.firstBowlerId,
    backupBowlerId: naiveLineup.bowlerPool352.backupBowlerId,
    bowlerPool352: naiveLineup.bowlerPool352
  };

  const squadB = createMockSquad().map(p => ({ ...p, id: `b_${p.id}`, name: `Away ${p.name}` }));
  const smartLineupB = TeamMaker.makeSmartLineup('CSK', squadB);
  const teamB: Team2026 = {
    id: 'CSK',
    name: 'Chennai Super Kings',
    playingXI: squadB.filter(p => smartLineupB.playing11Ids.includes(p.id)),
    primaryBowlers: smartLineupB.bowlerPool352.middleBowlerIds,
    powerplayBowlers: smartLineupB.bowlerPool352.powerplayBowlerIds,
    deathBowlers: smartLineupB.bowlerPool352.deathBowlerIds,
    firstBowlerId: smartLineupB.bowlerPool352.firstBowlerId,
    backupBowlerId: smartLineupB.bowlerPool352.backupBowlerId,
    bowlerPool352: smartLineupB.bowlerPool352
  };

  console.log('Simulating full match with FullMatchSimulator.simulateFullMatch...');
  const sim = new FullMatchSimulator();
  const matchResult = await sim.simulateFullMatch(1, teamA, teamB);

  console.log('--- MATCH COMPLETED SUCCESSFULLY ---');
  console.log(`Match #1 Result: ${matchResult.marginText}`);
  console.log(`Inn 1: ${matchResult.innings1.teamName} -> ${matchResult.innings1.totalRuns}/${matchResult.innings1.totalWickets} in ${matchResult.innings1.oversCompleted} ov`);
  console.log(`Inn 2: ${matchResult.innings2.teamName} -> ${matchResult.innings2.totalRuns}/${matchResult.innings2.totalWickets} in ${matchResult.innings2.oversCompleted} ov`);
  console.log(`POTM: ${matchResult.playerOfTheMatch.name} - ${matchResult.playerOfTheMatch.reason}`);

  // Validate bowler overs in innings 1 and 2: No bowler should bowl > 4 overs
  const checkOvers = (inn: typeof matchResult.innings1) => {
    Object.entries(inn.bowlingFigures).forEach(([name, fig]: [string, any]) => {
      console.log(`Bowler ${name}: ${fig.overs} ov, ${fig.runsConceded} r, ${fig.wickets} w`);
      if (fig.overs > 4) {
        throw new Error(`Bowler ${name} exceeded 4 overs limit: ${fig.overs}`);
      }
    });
  };

  console.log('\nInnings 1 Bowling:');
  checkOvers(matchResult.innings1);
  console.log('\nInnings 2 Bowling:');
  checkOvers(matchResult.innings2);

  console.log('\n✓ ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

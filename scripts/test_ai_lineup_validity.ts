import { SocketHub } from '../src/server/socketHub';
import { TeamMaker, validate352Lineup } from '../src/server/match/teamMaker';
import * as fs from 'fs';
import assert from 'assert';

const raw = fs.readFileSync('./public/data/players_active_fixed.json', 'utf-8');
const allPlayers = JSON.parse(raw);

const hub = new SocketHub();
(hub as any).flushRoomToMongoDB = () => {};

const room = hub.createRoom('TEST_LINEUP', 'host1', allPlayers);

// Mark team 0 as human with a valid 18-player squad
const teams = Object.values(room.teams);
teams[0].isHuman = true;
// Give human team 18 balanced players (12 domestic, 6 overseas)
const pool = [...allPlayers];
teams[0].squad = [
  ...pool.filter(p => !p.isOverseas && p.role === 'BAT').slice(0, 4),
  ...pool.filter(p => !p.isOverseas && p.role === 'WK').slice(0, 1),
  ...pool.filter(p => !p.isOverseas && p.role === 'AR').slice(0, 2),
  ...pool.filter(p => !p.isOverseas && p.role === 'PACE').slice(0, 3),
  ...pool.filter(p => !p.isOverseas && p.role === 'SPIN').slice(0, 2),
  ...pool.filter(p => p.isOverseas && p.role === 'BAT').slice(0, 2),
  ...pool.filter(p => p.isOverseas && p.role === 'WK').slice(0, 1),
  ...pool.filter(p => p.isOverseas && p.role === 'PACE').slice(0, 2),
  ...pool.filter(p => p.isOverseas && p.role === 'SPIN').slice(0, 1)
];

// Complete auction & skip to season (auto-fills AI teams and initializes season lineups)
hub.completeAuctionAndSkipToSeason(room);

console.log('--- Verifying Generated Lineups for all 10 teams ---');
let allValid = true;
for (const [tId, team] of Object.entries(room.teams)) {
  const squad = team.squad;
  const lineup = room.season?.lineups[tId];
  if (!lineup) {
    console.error(`[ERROR] No lineup found for ${tId}!`);
    allValid = false;
    continue;
  }

  const xi = squad.filter(p => lineup.playing11Ids.includes(p.id));
  const osCount = xi.filter(p => p.isOverseas).length;
  const bowlerCount = xi.filter(p => TeamMaker.isBowler(p)).length;
  const wkCount = xi.filter(p => p.role === 'WK').length;

  console.log(`Team ${tId} (isHuman: ${team.isHuman}): Squad=${squad.length}, XI=${xi.length}, Overseas=${osCount}/4, Bowlers=${bowlerCount}/6, WKs=${wkCount}`);

  // Check batting order
  const orderedXI = lineup.battingOrder.map(id => squad.find(p => p.id === id)!);
  console.log(`  Top 3: ${orderedXI.slice(0, 3).map(p => `${p.name} (${p.role}${p.isOverseas ? ' ✈️' : ''})`).join(', ')}`);
  console.log(`  Tail (9-11): ${orderedXI.slice(8, 11).map(p => `${p.name} (${p.role}${p.isOverseas ? ' ✈️' : ''})`).join(', ')}`);

  assert.strictEqual(xi.length, 11, `Team ${tId} playing XI must have exactly 11 players!`);
  assert.ok(osCount <= 4, `Team ${tId} overseas count (${osCount}) exceeds maximum of 4!`);
  assert.ok(wkCount >= 1, `Team ${tId} wicketkeeper count (${wkCount}) must be at least 1!`);
  assert.ok(bowlerCount >= 6, `Team ${tId} bowler count (${bowlerCount}) must be at least 6!`);

  const validation = validate352Lineup(lineup, squad);
  if (!validation.valid) {
    console.error(`  >>> INVALID LINEUP for ${tId}:`, validation.errors);
    allValid = false;
  }
}

assert.ok(allValid, 'All 10 team lineups must be strictly valid according to IPL and 3-5-2 rules!');
console.log('✓ All 10 teams have strictly valid playing 11s (Overseas <= 4, Bowlers >= 6, WKs >= 1)!');
process.exit(0);

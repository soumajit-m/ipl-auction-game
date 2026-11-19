import * as fs from 'fs';
import {
  AuctionBidderAI,
  assignFranchiseArchetypes,
  DEFAULT_IPL_FRANCHISES
} from '../src/server/auction/bidderAI';
import { IPLPlayer } from '../src/types/player.types';

const raw = fs.readFileSync('./public/data/players_active_fixed.json', 'utf-8');
const allPlayers: IPLPlayer[] = JSON.parse(raw);

const bidderAI = new AuctionBidderAI();
const teams = bidderAI.initializeTeams('TEST_ROOM', allPlayers);

// In a 1-human room, say user is CSK or another team, or 10 AIs:
// Let's test pure AI room first:
const franchises = DEFAULT_IPL_FRANCHISES.map(f => ({ id: f.id, archetype: undefined }));
assignFranchiseArchetypes(franchises);
for (const f of franchises) {
  const prof = (bidderAI as any).franchiseProfiles.get(f.id);
  if (prof) prof.archetype = f.archetype;
  const state = (bidderAI as any).franchiseStates.get(f.id);
  if (state) state.archetype = f.archetype;
  if (teams[f.id]) (teams[f.id] as any).archetype = f.archetype;
}

// Group players by set
const setsMap = new Map<number, IPLPlayer[]>();
for (const player of allPlayers) {
  const setNum = player.marqueeSet || 9;
  if (!setsMap.has(setNum)) setsMap.set(setNum, []);
  setsMap.get(setNum)!.push(player);
}

// Simulate set skips (like user might be doing, or live Vickrey)
for (let setNum = 1; setNum <= 9; setNum++) {
  const setPlayers = setsMap.get(setNum) || [];
  for (const p of setPlayers) {
    const outcome = bidderAI.resolveModeAVickrey(
      'TEST_ROOM',
      teams,
      p,
      [],
      1,
      'MAIN'
    );
    if (outcome.winnerId && outcome.soldPrice > 0) {
      bidderAI.commitLotSale(teams, p, outcome.winnerId, outcome.soldPrice);
    }
  }
  console.log(`--- After Set ${setNum} ---`);
  for (const [tId, t] of Object.entries(teams)) {
    const arch = (bidderAI as any).franchiseProfiles.get(tId)?.archetype;
    console.log(`  ${tId.padEnd(5)} (${arch?.slice(0, 2)}): Squad = ${t.squad.length}, Purse = ₹${t.purse.toFixed(2)} Cr`);
  }
}

/**
 * weakPointScout.ts - O(1) 5-Rule Tactical Weak-Point Scout
 * Analyzes rival franchise squads to produce crisp, actionable tips for Match Center and Analytics.
 */

import { IPLPlayer } from '../types/player.types';

export interface WeakPointTip {
  id: string;
  category: 'DEATH_BOWLING' | 'SPIN_CONTROL' | 'TOP_ORDER' | 'LOWER_ORDER' | 'OVERSEAS_DEPENDENCY';
  severity: 'CRITICAL' | 'WARNING' | 'OPPORTUNITY';
  title: string;
  description: string;
  recommendation: string;
}

export function scoutRivalWeakPoints(squad: IPLPlayer[], venuePitch?: { spin: number; pace: number }): WeakPointTip[] {
  const tips: WeakPointTip[] = [];

  if (squad.length === 0) return tips;

  // 1. Death Bowling Vulnerability
  const deathBowlers = squad.filter(p => p.isBowlingCapable && ((p.tacticalSynergy?.death ?? 0) >= 0.5 || p.subType === 'DEATH_OVERS_PACER'));
  const deathEconAvg = deathBowlers.length > 0
    ? deathBowlers.reduce((acc, p) => acc + (p.historical?.bowlEcon || 8.5), 0) / deathBowlers.length
    : 10.5;

  if (deathBowlers.length < 2 || deathEconAvg > 9.5) {
    tips.push({
      id: 'tip_death_vulnerability',
      category: 'DEATH_BOWLING',
      severity: 'CRITICAL',
      title: 'Death Over Fragility (Overs 17–20)',
      description: `Rival has only ${deathBowlers.length} recognized death specialist(s) with high conceded economy (${deathEconAvg.toFixed(1)}).`,
      recommendation: 'Target overs 17–20 with AGGRESSIVE power hitting tactics; preserve top finishers for death overs.'
    });
  }

  // 2. Spin Control / Spin Squeeze
  const spinners = squad.filter(p => p.role === 'SPIN');
  const hasQualitySpinner = spinners.some(p => p.stats.bowl >= 80);

  if (spinners.length < 2 || !hasQualitySpinner) {
    tips.push({
      id: 'tip_spin_deficiency',
      category: 'SPIN_CONTROL',
      severity: venuePitch && venuePitch.spin > 0.4 ? 'CRITICAL' : 'WARNING',
      title: 'Thin Spin Attack in Middle Phase',
      description: `Rival lacks premier wicket-taking spin options (${spinners.length} spinners in squad).`,
      recommendation: 'Deploy SPIN_ATTACK batting tactics and target middle overs 7–15 to accelerate run rate.'
    });
  }

  // 3. Top Order Fragility
  const topBatters = squad.filter(p => p.role === 'BAT' || p.role === 'WK').sort((a, b) => b.stats.bat - a.stats.bat).slice(0, 3);
  const avgInjuryRisk = topBatters.reduce((acc, p) => acc + p.stats.injuryRisk, 0) / (topBatters.length || 1);
  const lowPowerplaySuitability = topBatters.filter(p => (p.tacticalSynergy?.powerplay ?? 0.3) < 0.35).length;

  if (avgInjuryRisk > 0.15 || lowPowerplaySuitability >= 2) {
    tips.push({
      id: 'tip_top_order_fragility',
      category: 'TOP_ORDER',
      severity: 'WARNING',
      title: 'Top Order Powerplay Vulnerability',
      description: 'Rival openers exhibit slow powerplay strike rates and vulnerability against swinging new ball.',
      recommendation: 'Open with PACE_ATTACK / WICKET_HUNT bowling in Powerplay (Overs 1–6) with field up.'
    });
  }

  // 4. Lower Order Tail Exposure
  const bottomOrder = squad.filter(p => p.role === 'PACE' || p.role === 'SPIN').slice(0, 4);
  const avgTailBat = bottomOrder.reduce((acc, p) => acc + p.stats.bat, 0) / (bottomOrder.length || 1);

  if (avgTailBat < 38) {
    tips.push({
      id: 'tip_long_tail',
      category: 'LOWER_ORDER',
      severity: 'OPPORTUNITY',
      title: 'Exposed Lower-Order Tail (#8–11)',
      description: `Rival batting depth drops steeply below #7 (tail average bat rating: ${avgTailBat.toFixed(0)}).`,
      recommendation: '2 quick middle-over wickets triggers collapse; bowling squeeze will force reckless shots.'
    });
  }

  // 5. Overseas Dependency / Cap Strain
  const overseasStars = squad.filter(p => p.isOverseas && p.stats.ovr >= 85);
  const domesticStars = squad.filter(p => !p.isOverseas && p.stats.ovr >= 85);

  if (overseasStars.length >= 4 && domesticStars.length <= 2) {
    tips.push({
      id: 'tip_overseas_strain',
      category: 'OVERSEAS_DEPENDENCY',
      severity: 'OPPORTUNITY',
      title: 'High Overseas Dependency',
      description: 'Rival relies disproportionately on overseas stars and lacks domestic match-winners on bench.',
      recommendation: 'Target domestic support bowlers and exploit depth mismatch.'
    });
  }

  return tips;
}

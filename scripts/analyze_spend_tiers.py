"""
scripts/analyze_spend_tiers.py
Calculates exact spending tier breakdowns:
- Top 1 (Highest paid)
- Top 1-5 (Core pillars)
- Top 6-7 (Secondary anchors)
- Top 8-11 (Starting XI completions)
Across all 3 auctions, overall league and by archetype.
"""

import json
from pathlib import Path
import numpy as np
from deep_auction_analysis import run_single_auction

def main():
    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    from benchmark_1000_matches import compute_all_v_intrinsic
    v_int_map = compute_all_v_intrinsic(all_players)

    weights_map = {
        "SUPERSTAR_DUELIST": json.loads(Path("public/models/weights_sd.json").read_text(encoding="utf-8")),
        "MONEYBALL_CORE": json.loads(Path("public/models/weights_mb.json").read_text(encoding="utf-8")),
        "DISCIPLINED_PRAGMATIST": json.loads(Path("public/models/weights_dp.json").read_text(encoding="utf-8"))
    }

    all_teams_data = []

    for a_num in range(1, 4):
        seed = 4200 + a_num * 111
        sorted_teams, _ = run_single_auction(a_num, all_players, v_int_map, weights_map, seed)
        for t in sorted_teams:
            prices = sorted(t["prices_paid"], reverse=True)
            top1 = prices[0] if len(prices) >= 1 else 0.0
            top1_to_5 = prices[:5]
            top6_to_7 = prices[5:7]
            top8_to_11 = prices[7:11]

            all_teams_data.append({
                "team": t["id"],
                "archetype": t["archetype"],
                "top1": top1,
                "top1_to_5_sum": sum(top1_to_5),
                "top1_to_5_avg": np.mean(top1_to_5) if top1_to_5 else 0.0,
                "top6_to_7_sum": sum(top6_to_7),
                "top6_to_7_avg": np.mean(top6_to_7) if top6_to_7 else 0.0,
                "top8_to_11_sum": sum(top8_to_11),
                "top8_to_11_avg": np.mean(top8_to_11) if top8_to_11 else 0.0,
                "top11_total": sum(prices[:11])
            })

    # Overall League
    top1_all = [d["top1"] for d in all_teams_data]
    top1_5_sum = [d["top1_to_5_sum"] for d in all_teams_data]
    top1_5_avg = [d["top1_to_5_avg"] for d in all_teams_data]
    top6_7_sum = [d["top6_to_7_sum"] for d in all_teams_data]
    top6_7_avg = [d["top6_to_7_avg"] for d in all_teams_data]
    top8_11_sum = [d["top8_to_11_sum"] for d in all_teams_data]
    top8_11_avg = [d["top8_to_11_avg"] for d in all_teams_data]

    print("=" * 80)
    print("LEAGUE-WIDE SPENDING TIER ANALYSIS (30 TEAM AUCTIONS)")
    print("=" * 80)
    print(f"• Spent on Top 1 (Highest Player):    Avg ₹{np.mean(top1_all):.2f} Cr (Range: ₹{min(top1_all):.2f} – ₹{max(top1_all):.2f} Cr)")
    print(f"• Top 1 to 5 (Pillars):               Total ₹{np.mean(top1_5_sum):.2f} Cr | Avg ₹{np.mean(top1_5_avg):.2f} Cr / player")
    print(f"• Top 6 and 7 (Core Anchors):         Total ₹{np.mean(top6_7_sum):.2f} Cr | Avg ₹{np.mean(top6_7_avg):.2f} Cr / player")
    print(f"• Top 8 to 11 (XI Completion):        Total ₹{np.mean(top8_11_sum):.2f} Cr | Avg ₹{np.mean(top8_11_avg):.2f} Cr / player")
    print(f"• Total Top 11 (Starting XI):         Total ₹{np.mean([d['top11_total'] for d in all_teams_data]):.2f} Cr")

    print("\n" + "=" * 80)
    print("BREAKDOWN BY ARCHETYPE (SD vs MB vs DP)")
    print("=" * 80)
    for arch in ["SUPERSTAR_DUELIST", "MONEYBALL_CORE", "DISCIPLINED_PRAGMATIST"]:
        group = [d for d in all_teams_data if d["archetype"] == arch]
        print(f"\n--- {arch} ({len(group)} teams) ---")
        print(f"  • Top 1 Signings:      Avg ₹{np.mean([d['top1'] for d in group]):.2f} Cr (Peak: ₹{max([d['top1'] for d in group]):.2f} Cr)")
        print(f"  • Top 1 to 5:          Total ₹{np.mean([d['top1_to_5_sum'] for d in group]):.2f} Cr (Avg ₹{np.mean([d['top1_to_5_avg'] for d in group]):.2f} Cr / player)")
        print(f"  • Top 6 and 7:         Total ₹{np.mean([d['top6_to_7_sum'] for d in group]):.2f} Cr (Avg ₹{np.mean([d['top6_to_7_avg'] for d in group]):.2f} Cr / player)")
        print(f"  • Top 8 to 11:         Total ₹{np.mean([d['top8_to_11_sum'] for d in group]):.2f} Cr (Avg ₹{np.mean([d['top8_to_11_avg'] for d in group]):.2f} Cr / player)")
        print(f"  • Total Top 11:        ₹{np.mean([d['top11_total'] for d in group]):.2f} Cr")

if __name__ == "__main__":
    main()

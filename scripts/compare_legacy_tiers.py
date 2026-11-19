"""
scripts/compare_legacy_tiers.py
Compares the spending tiers of V1.7 (Old League AI), V2.0, and V3.0:
- Top 1
- Top 1-5
- Top 6-7
- Top 8-11
- Leftover Purse
"""

import json
from pathlib import Path
import numpy as np

# Load from benchmark_1000_matches.py
from benchmark_1000_matches import (
    CUDAMatchSim,
    compute_all_v_intrinsic,
    evaluate_v3_specialist_bid,
    evaluate_v2_bid,
    evaluate_v1_legacy_bid,
    get_next_bid_increment,
    FRANCHISES
)
import random
import copy

def main():
    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_int_map = compute_all_v_intrinsic(all_players)

    weights_sd = json.loads(Path("public/models/weights_sd.json").read_text(encoding="utf-8"))
    weights_mb = json.loads(Path("public/models/weights_mb.json").read_text(encoding="utf-8"))
    weights_dp = json.loads(Path("public/models/weights_dp.json").read_text(encoding="utf-8"))

    version_assignments = [
        ("V3.0", "SUPERSTAR_DUELIST", 18, weights_sd),
        ("V3.0", "MONEYBALL_CORE", 20, weights_mb),
        ("V3.0", "MONEYBALL_CORE", 20, weights_mb),
        ("V3.0", "DISCIPLINED_PRAGMATIST", 19, weights_dp),
        ("V2.0", "SUPERSTAR_DUELIST", 19, None),
        ("V2.0", "MONEYBALL_CORE", 19, None),
        ("V2.0", "DISCIPLINED_PRAGMATIST", 19, None),
        ("V1.7", "DISCIPLINED_PRAGMATIST", 25, None),
        ("V1.7", "SUPERSTAR_DUELIST", 25, None),
        ("V1.7", "MONEYBALL_CORE", 25, None),
    ]

    tier_records = {
        "V1.7": {"top1": [], "top1_5": [], "top6_7": [], "top8_11": [], "top11": [], "purse_left": []},
        "V2.0": {"top1": [], "top1_5": [], "top6_7": [], "top8_11": [], "top11": [], "purse_left": []},
        "V3.0": {"top1": [], "top1_5": [], "top6_7": [], "top8_11": [], "top11": [], "purse_left": []}
    }

    for s_idx in range(6):
        seed = 9000 + s_idx
        rng = random.Random(seed)

        teams = []
        for idx, pf in enumerate(FRANCHISES):
            ver, arch, target_sq, p_w = version_assignments[idx]
            teams.append({
                "idx": idx,
                "id": pf["id"],
                "version": ver,
                "archetype": arch,
                "target_squad": target_sq,
                "policy_weights": p_w,
                "purse": 125.00,
                "total_spent": 0.0,
                "squad": [],
                "prices_paid": [],
                "role_counts": {"BAT": 0, "WK": 0, "AR": 0, "PACE": 0, "SPIN": 0},
                "overseas_count": 0
            })

        shuffled = list(all_players)
        rng.shuffle(shuffled)
        shuffled.sort(key=lambda p: int(p.get("marqueeSet", 8) or 8))

        main_lots = [p for p in shuffled if int(p.get("marqueeSet", 8) or 8) <= 6]
        acc_lots = [p for p in shuffled if int(p.get("marqueeSet", 8) or 8) > 6]
        unsold = []

        for p in main_lots:
            bp = float(p.get("basePrice", 0.30) or 0.30)
            v_int = v_int_map.get(p["id"], bp)
            role = p.get("role", "BAT")
            is_os = p.get("isOverseas", False)

            current_bid = 0.0
            current_leader = None

            while True:
                inc = get_next_bid_increment(current_bid)
                next_bid = bp if current_bid == 0.0 else current_bid + inc

                candidates = []
                for t in teams:
                    if t["idx"] == current_leader: continue
                    if len(t["squad"]) >= t["target_squad"] + 2: continue
                    if is_os and t["overseas_count"] >= 8: continue

                    can_bid = False
                    if t["version"] == "V3.0":
                        can_bid = evaluate_v3_specialist_bid(t, p, current_bid, v_int)
                    elif t["version"] == "V2.0":
                        can_bid = evaluate_v2_bid(t, p, current_bid, v_int)
                    else:
                        can_bid = evaluate_v1_legacy_bid(t, p, current_bid)

                    if can_bid: candidates.append(t["idx"])

                if not candidates: break
                current_leader = rng.choice(candidates)
                current_bid = next_bid

            if current_leader is not None:
                winner = teams[current_leader]
                winner["purse"] = round(winner["purse"] - current_bid, 2)
                winner["total_spent"] = round(winner["total_spent"] + current_bid, 2)
                p_rec = copy.deepcopy(p)
                p_rec["price_paid"] = current_bid
                winner["squad"].append(p_rec)
                winner["prices_paid"].append(current_bid)
                winner["role_counts"][role] = winner["role_counts"].get(role, 0) + 1
                if is_os: winner["overseas_count"] += 1
            else:
                unsold.append(p)

        acc_pool = unsold + acc_lots
        rng.shuffle(acc_pool)

        for t in teams:
            target_sz = t["target_squad"]
            while len(t["squad"]) < target_sz and acc_pool and t["purse"] >= 0.30:
                cands = [p for p in acc_pool if (not p.get("isOverseas", False) or t["overseas_count"] < 8) and float(p.get("basePrice", 0.30) or 0.30) <= t["purse"]]
                if not cands: break
                best_p = max(cands, key=lambda pl: float(pl.get("stats", {}).get("ovr", 60)))
                acc_pool.remove(best_p)
                bp_p = float(best_p.get("basePrice", 0.30) or 0.30)
                v_p = v_int_map.get(best_p["id"], bp_p)

                rem_needed = max(1, target_sz - len(t["squad"]))
                if t["version"] == "V3.0":
                    buffer = 2.00
                    usable_purse = max(0.0, t["purse"] - buffer)
                    bench_target = usable_purse / rem_needed
                    max_allowed = max(bp_p, t["purse"] - buffer - (rem_needed - 1) * 0.40)
                    price = round(min(max(bp_p, min(v_p, bench_target)), max_allowed), 2)
                elif t["version"] == "V2.0":
                    alloc = max(bp_p, min(v_p, (t["purse"] / rem_needed) * 0.88))
                    price = round(min(t["purse"] - (rem_needed - 1) * 0.40, alloc), 2)
                else:
                    price = bp_p

                price = max(bp_p, price)
                t["purse"] = round(max(0.0, t["purse"] - price), 2)
                t["total_spent"] = round(t["total_spent"] + price, 2)
                p_rec = copy.deepcopy(best_p)
                p_rec["price_paid"] = price
                t["squad"].append(p_rec)
                t["prices_paid"].append(price)
                t["role_counts"][best_p.get("role", "BAT")] = t["role_counts"].get(best_p.get("role", "BAT"), 0) + 1
                if best_p.get("isOverseas", False): t["overseas_count"] += 1

        for t in teams:
            prices = sorted(t["prices_paid"], reverse=True)
            v = t["version"]
            tier_records[v]["top1"].append(prices[0] if prices else 0.0)
            tier_records[v]["top1_5"].append(sum(prices[:5]))
            tier_records[v]["top6_7"].append(sum(prices[5:7]))
            tier_records[v]["top8_11"].append(sum(prices[7:11]))
            tier_records[v]["top11"].append(sum(prices[:11]))
            tier_records[v]["purse_left"].append(t["purse"])

    print("=" * 80)
    print("DIRECT COMPARISON: V1.7 (OLD LEAGUE AI) vs V2.0 vs V3.0 (NEW)")
    print("=" * 80)
    print(f"{'Spending Tier':<30} | {'V1.7 (Old League AI)':<20} | {'V2.0 (Previous)':<18} | {'V3.0 (New Multi-Nature)':<22}")
    print("-" * 96)

    for k, label in [
        ("top1", "Top 1 (Peak Signing)"),
        ("top1_5", "Top 1 to 5 Total (Pillars)"),
        ("top6_7", "Top 6 & 7 Total (Anchors)"),
        ("top8_11", "Top 8 to 11 Total (Starters)"),
        ("top11", "TOTAL TOP 11 (Starting XI)"),
        ("purse_left", "LEFTOVER PURSE BUFFER")
    ]:
        v1_val = np.mean(tier_records["V1.7"][k])
        v2_val = np.mean(tier_records["V2.0"][k])
        v3_val = np.mean(tier_records["V3.0"][k])
        print(f"{label:<30} | ₹{v1_val:>7.2f} Cr           | ₹{v2_val:>7.2f} Cr        | ₹{v3_val:>7.2f} Cr")

    print("-" * 96)
    print("AVERAGE PER-PLAYER IN EACH TIER:")
    print(f"• Top 1 to 5 (Per Player):   V1.7 = ₹{np.mean(tier_records['V1.7']['top1_5'])/5:.2f} Cr  | V2.0 = ₹{np.mean(tier_records['V2.0']['top1_5'])/5:.2f} Cr  | V3.0 = ₹{np.mean(tier_records['V3.0']['top1_5'])/5:.2f} Cr")
    print(f"• Top 6 & 7 (Per Player):    V1.7 = ₹{np.mean(tier_records['V1.7']['top6_7'])/2:.2f} Cr  | V2.0 = ₹{np.mean(tier_records['V2.0']['top6_7'])/2:.2f} Cr  | V3.0 = ₹{np.mean(tier_records['V3.0']['top6_7'])/2:.2f} Cr")
    print(f"• Top 8 to 11 (Per Player):  V1.7 = ₹{np.mean(tier_records['V1.7']['top8_11'])/4:.2f} Cr  | V2.0 = ₹{np.mean(tier_records['V2.0']['top8_11'])/4:.2f} Cr  | V3.0 = ₹{np.mean(tier_records['V3.0']['top8_11'])/4:.2f} Cr")

if __name__ == "__main__":
    main()

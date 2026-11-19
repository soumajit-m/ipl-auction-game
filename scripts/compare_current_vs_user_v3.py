"""
scripts/compare_current_vs_user_v3.py
Direct 5v5 Multi-Season Tournament Benchmark:
Current AI Weights vs User-Tuned V3 Weights
Accelerated with NVIDIA CUDA on RTX GPU.
"""

import os
import json
import random
import copy
from pathlib import Path
import numpy as np

# Load intrinsic valuation and bidding functions
from benchmark_1000_matches import (
    CUDAMatchSim,
    compute_all_v_intrinsic,
    evaluate_v3_specialist_bid,
    get_next_bid_increment,
    FRANCHISES
)

def run_tournament(total_seasons: int = 20):
    print("=" * 85)
    print(f"HEAD-TO-HEAD TOURNAMENT: CURRENT AI vs USER-TUNED V3 AI ({total_seasons} FULL SEASONS)")
    print("5 Teams Current AI vs 5 Teams User-Tuned V3 AI (CUDA GPU Accelerated)")
    print("=" * 85)

    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_int_map = compute_all_v_intrinsic(all_players)
    sim = CUDAMatchSim()

    # Current AI Weights
    curr_weights = {
        "SUPERSTAR_DUELIST": json.loads(Path("public/models/weights_sd.json").read_text(encoding="utf-8")),
        "MONEYBALL_CORE": json.loads(Path("public/models/weights_mb.json").read_text(encoding="utf-8")),
        "DISCIPLINED_PRAGMATIST": json.loads(Path("public/models/weights_dp.json").read_text(encoding="utf-8"))
    }

    # User-Tuned V3 Weights
    user_weights = {
        "SUPERSTAR_DUELIST": json.loads(Path("public/models/weights_sd_v3.json").read_text(encoding="utf-8")),
        "MONEYBALL_CORE": json.loads(Path("public/models/weights_mb_v3.json").read_text(encoding="utf-8")),
        "DISCIPLINED_PRAGMATIST": json.loads(Path("public/models/weights_dp_v3.json").read_text(encoding="utf-8"))
    }

    # Team configuration:
    # 5 Teams on CURRENT_AI: MI (SD), CSK (MB), KKR (MB), RR (DP), RCB (SD)
    # 5 Teams on USER_TUNED_V3: PBKS (SD), GT (MB), LSG (MB), SRH (DP), DC (DP)
    team_configs = [
        ("CURRENT_AI", "SUPERSTAR_DUELIST", 18),
        ("CURRENT_AI", "MONEYBALL_CORE", 20),
        ("CURRENT_AI", "MONEYBALL_CORE", 20),
        ("CURRENT_AI", "SUPERSTAR_DUELIST", 18),
        ("CURRENT_AI", "DISCIPLINED_PRAGMATIST", 19),
        ("USER_TUNED_V3", "DISCIPLINED_PRAGMATIST", 19),
        ("USER_TUNED_V3", "DISCIPLINED_PRAGMATIST", 19),
        ("USER_TUNED_V3", "SUPERSTAR_DUELIST", 18),
        ("USER_TUNED_V3", "MONEYBALL_CORE", 20),
        ("USER_TUNED_V3", "MONEYBALL_CORE", 20)
    ]

    metrics = {
        "CURRENT_AI": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []},
        "USER_TUNED_V3": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []}
    }

    h2h = {"CURRENT_AI": 0, "USER_TUNED_V3": 0}
    total_matches = 0

    for s_idx in range(total_seasons):
        seed = 11000 + s_idx * 17
        rng = random.Random(seed)
        rng_sim = np.random.RandomState(seed)

        # 1. Initialize Teams
        teams = []
        for idx, pf in enumerate(FRANCHISES):
            engine, arch, target_sq = team_configs[idx]
            p_w = curr_weights[arch] if engine == "CURRENT_AI" else user_weights[arch]
            teams.append({
                "idx": idx,
                "id": pf["id"],
                "name": pf["name"],
                "engine": engine,
                "archetype": arch,
                "target_squad": target_sq,
                "policy_weights": p_w,
                "purse": 125.00,
                "total_spent": 0.0,
                "squad": [],
                "prices_paid": [],
                "role_counts": {"BAT": 0, "WK": 0, "AR": 0, "PACE": 0, "SPIN": 0},
                "overseas_count": 0,
                "wins": 0,
                "points": 0
            })

        # 2. Simulate Mega Auction
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

                    if evaluate_v3_specialist_bid(t, p, current_bid, v_int):
                        candidates.append(t["idx"])

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

        # Accelerated Round
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
                buffer = 2.00
                usable_purse = max(0.0, t["purse"] - buffer)
                bench_target = usable_purse / rem_needed
                max_allowed = max(bp_p, t["purse"] - buffer - (rem_needed - 1) * 0.40)
                price = round(min(max(bp_p, min(v_p, bench_target)), max_allowed), 2)
                price = max(bp_p, price)

                t["purse"] = round(max(0.0, t["purse"] - price), 2)
                t["total_spent"] = round(t["total_spent"] + price, 2)
                p_rec = copy.deepcopy(best_p)
                p_rec["price_paid"] = price
                t["squad"].append(p_rec)
                t["prices_paid"].append(price)
                t["role_counts"][best_p.get("role", "BAT")] = t["role_counts"].get(best_p.get("role", "BAT"), 0) + 1
                if best_p.get("isOverseas", False): t["overseas_count"] += 1

        # 3. Simulate League Matches with CUDA
        for t in teams:
            t["xi"] = sim.select_starting_xi(t["squad"])
            eng = t["engine"]
            metrics[eng]["xi_ovrs"].append(np.mean([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            metrics[eng]["weak_links"].append(min([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            metrics[eng]["top11"].append(sum(sorted(t["prices_paid"], reverse=True)[:11]))
            metrics[eng]["purse_left"].append(t["purse"])

        league_pairs = []
        for i in range(10):
            for j in range(i + 1, 10):
                league_pairs.append((teams[i], teams[j]))
                league_pairs.append((teams[j], teams[i]))

        results = sim.batch_simulate_matches(league_pairs, rng_sim)
        total_matches += len(league_pairs)

        for pair_idx, (t_h, t_a) in enumerate(league_pairs):
            h_won = results[pair_idx]
            w, l = (t_h, t_a) if h_won else (t_a, t_h)
            w["wins"] += 1; w["points"] += 2
            metrics[w["engine"]]["wins"] += 1
            metrics[w["engine"]]["matches"] += 1
            metrics[l["engine"]]["matches"] += 1
            if w["engine"] != l["engine"]:
                h2h[w["engine"]] += 1

        # 4. Playoffs
        sorted_teams = sorted(teams, key=lambda x: x["points"], reverse=True)
        top4 = sorted_teams[:4]
        for t in top4: metrics[t["engine"]]["playoffs"] += 1

        po_results = sim.batch_simulate_matches([(top4[0], top4[1]), (top4[2], top4[3])], rng_sim)
        total_matches += 2
        f1, q1_l = (top4[0], top4[1]) if po_results[0] else (top4[1], top4[0])
        el_w = top4[2] if po_results[1] else top4[3]

        q2_res = sim.batch_simulate_matches([(q1_l, el_w)], rng_sim)
        total_matches += 1
        f2 = q1_l if q2_res[0] else el_w

        fin_res = sim.batch_simulate_matches([(f1, f2)], rng_sim)
        total_matches += 1
        champ = f1 if fin_res[0] else f2
        metrics[champ["engine"]]["trophies"] += 1

        if (s_idx + 1) % 5 == 0 or s_idx == total_seasons - 1:
            print(f"Season {s_idx + 1:02d}/{total_seasons:02d} | Latest Champ: {champ['name']} ({champ['engine']}) | Matches: {total_matches}")

    # =========================================================================
    # REPORT
    # =========================================================================
    print("\n" + "=" * 85)
    print(f"HEAD-TO-HEAD BENCHMARK REPORT ({total_matches} TOTAL MATCHES)")
    print("=" * 85)
    print(f"{'Metric':<32} | {'Current AI (5 Teams)':<22} | {'User-Tuned V3 (5 Teams)':<22}")
    print("-" * 85)

    c1 = metrics["CURRENT_AI"]["trophies"]
    c2 = metrics["USER_TUNED_V3"]["trophies"]
    print(f"{'Championships Won':<32} | {c1:>3} ({c1/total_seasons*100:>4.1f}%)              | {c2:>3} ({c2/total_seasons*100:>4.1f}%)")

    p1 = metrics["CURRENT_AI"]["playoffs"] / (5 * total_seasons) * 100
    p2 = metrics["USER_TUNED_V3"]["playoffs"] / (5 * total_seasons) * 100
    print(f"{'Playoff Qual Rate (Top 4)':<32} | {p1:>8.1f}%               | {p2:>8.1f}%")

    w1 = metrics["CURRENT_AI"]["wins"] / max(1, metrics["CURRENT_AI"]["matches"]) * 100
    w2 = metrics["USER_TUNED_V3"]["wins"] / max(1, metrics["USER_TUNED_V3"]["matches"]) * 100
    print(f"{'Match Win %':<32} | {w1:>8.1f}%               | {w2:>8.1f}%")

    print(f"{'Starting XI Mean OVR':<32} | {np.mean(metrics['CURRENT_AI']['xi_ovrs']):>8.2f}                 | {np.mean(metrics['USER_TUNED_V3']['xi_ovrs']):>8.2f}")
    print(f"{'Weak Link (Min Starter OVR)':<32} | {np.mean(metrics['CURRENT_AI']['weak_links']):>8.2f}                 | {np.mean(metrics['USER_TUNED_V3']['weak_links']):>8.2f}")
    print(f"{'Mean Top 11 Spend':<32} | ₹{np.mean(metrics['CURRENT_AI']['top11']):>7.2f} Cr             | ₹{np.mean(metrics['USER_TUNED_V3']['top11']):>7.2f} Cr")
    print(f"{'Mean Leftover Purse Buffer':<32} | ₹{np.mean(metrics['CURRENT_AI']['purse_left']):>7.2f} Cr             | ₹{np.mean(metrics['USER_TUNED_V3']['purse_left']):>7.2f} Cr")

    print("-" * 85)
    c_w = h2h["CURRENT_AI"]; u_w = h2h["USER_TUNED_V3"]
    print(f"DIRECT HEAD-TO-HEAD MATCHES:")
    print(f"  • Current AI Won {c_w} vs User-Tuned V3 Won {u_w} ({c_w/(c_w+u_w)*100:.1f}% vs {u_w/(c_w+u_w)*100:.1f}%)")
    print("=" * 85)

if __name__ == "__main__":
    run_tournament(20) # 20 seasons * 94 matches = 1,880 matches

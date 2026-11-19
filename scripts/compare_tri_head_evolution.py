"""
scripts/compare_tri_head_evolution.py
Compares:
1. Single-Head V2.0 (No Confidence, No Need Head, Basic Clamp)
2. Tri-Head V3.0 (Alpha + Confidence + Need + Solvency, Single Shared Weights)
3. Current AI (Tri-Head + 3 Dedicated Specialist Trained Weights: SD, MB, DP)
"""

import json
from pathlib import Path
import numpy as np
import random
import copy

from benchmark_1000_matches import (
    CUDAMatchSim,
    compute_all_v_intrinsic,
    evaluate_v3_specialist_bid,
    evaluate_v2_bid,
    get_next_bid_increment,
    FRANCHISES
)

def evaluate_tri_head_shared(team: dict, player: dict, current_bid: float, v_int: float, shared_weights: dict) -> bool:
    # Uses Tri-Head formulas (Confidence + Need + Solvency) but with the old single shared weights
    team_copy = copy.copy(team)
    team_copy["policy_weights"] = shared_weights
    return evaluate_v3_specialist_bid(team_copy, player, current_bid, v_int)

def main():
    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_int_map = compute_all_v_intrinsic(all_players)
    sim = CUDAMatchSim()

    shared_weights = json.loads(Path("public/models/auction_policy_net_weights.json").read_text(encoding="utf-8"))
    weights_sd = json.loads(Path("public/models/weights_sd.json").read_text(encoding="utf-8"))
    weights_mb = json.loads(Path("public/models/weights_mb.json").read_text(encoding="utf-8"))
    weights_dp = json.loads(Path("public/models/weights_dp.json").read_text(encoding="utf-8"))

    # 10 Teams split across:
    # 4 Teams: Current AI (Trained Tri-Head Multi-Nature)
    # 3 Teams: Tri-Head Shared (Untrained / Single Weights)
    # 3 Teams: V2.0 Single-Head
    configs = [
        ("CURRENT_AI", "SUPERSTAR_DUELIST", 18, weights_sd),
        ("CURRENT_AI", "MONEYBALL_CORE", 20, weights_mb),
        ("CURRENT_AI", "MONEYBALL_CORE", 20, weights_mb),
        ("CURRENT_AI", "DISCIPLINED_PRAGMATIST", 19, weights_dp),
        ("TRI_HEAD_SHARED", "SUPERSTAR_DUELIST", 18, shared_weights),
        ("TRI_HEAD_SHARED", "MONEYBALL_CORE", 20, shared_weights),
        ("TRI_HEAD_SHARED", "DISCIPLINED_PRAGMATIST", 19, shared_weights),
        ("V2_SINGLE_HEAD", "SUPERSTAR_DUELIST", 19, None),
        ("V2_SINGLE_HEAD", "MONEYBALL_CORE", 19, None),
        ("V2_SINGLE_HEAD", "DISCIPLINED_PRAGMATIST", 19, None),
    ]

    metrics = {
        "CURRENT_AI": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []},
        "TRI_HEAD_SHARED": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []},
        "V2_SINGLE_HEAD": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []}
    }

    h2h = {
        ("CURRENT_AI", "TRI_HEAD_SHARED"): 0, ("TRI_HEAD_SHARED", "CURRENT_AI"): 0,
        ("CURRENT_AI", "V2_SINGLE_HEAD"): 0, ("V2_SINGLE_HEAD", "CURRENT_AI"): 0,
        ("TRI_HEAD_SHARED", "V2_SINGLE_HEAD"): 0, ("V2_SINGLE_HEAD", "TRI_HEAD_SHARED"): 0
    }

    total_seasons = 10
    total_matches = 0

    for s_idx in range(total_seasons):
        seed = 8800 + s_idx
        rng = random.Random(seed)
        rng_sim = np.random.RandomState(seed)

        teams = []
        for idx, pf in enumerate(FRANCHISES):
            engine, arch, target_sq, p_w = configs[idx]
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
                    if t["engine"] == "CURRENT_AI":
                        can_bid = evaluate_v3_specialist_bid(t, p, current_bid, v_int)
                    elif t["engine"] == "TRI_HEAD_SHARED":
                        can_bid = evaluate_tri_head_shared(t, p, current_bid, v_int, shared_weights)
                    else:
                        can_bid = evaluate_v2_bid(t, p, current_bid, v_int)

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
                if t["engine"] in ["CURRENT_AI", "TRI_HEAD_SHARED"]:
                    buffer = 2.00
                    usable_purse = max(0.0, t["purse"] - buffer)
                    bench_target = usable_purse / rem_needed
                    max_allowed = max(bp_p, t["purse"] - buffer - (rem_needed - 1) * 0.40)
                    price = round(min(max(bp_p, min(v_p, bench_target)), max_allowed), 2)
                else:
                    alloc = max(bp_p, min(v_p, (t["purse"] / rem_needed) * 0.88))
                    price = round(min(t["purse"] - (rem_needed - 1) * 0.40, alloc), 2)

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
            t["xi"] = sim.select_starting_xi(t["squad"])
            eng = t["engine"]
            metrics[eng]["xi_ovrs"].append(np.mean([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            metrics[eng]["weak_links"].append(min([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            metrics[eng]["top11"].append(sum(sorted(t["prices_paid"], reverse=True)[:11]))
            metrics[eng]["purse_left"].append(t["purse"])

        # League Matches
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
                h2h[(w["engine"], l["engine"])] += 1

        # Playoffs
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

    print("=" * 90)
    print("TRI-HEAD ARCHITECTURE EVOLUTION COMPARISON REPORT")
    print("=" * 90)
    print(f"{'Metric':<32} | {'V2.0 Single-Head':<18} | {'Tri-Head (Shared Net)':<23} | {'Current AI (Trained)':<22}")
    print("-" * 105)

    c1 = metrics["V2_SINGLE_HEAD"]["trophies"]
    c2 = metrics["TRI_HEAD_SHARED"]["trophies"]
    c3 = metrics["CURRENT_AI"]["trophies"]
    print(f"{'Championships Won':<32} | {c1:>3} ({c1/total_seasons*100:>4.1f}%)        | {c2:>3} ({c2/total_seasons*100:>4.1f}%)           | {c3:>3} ({c3/total_seasons*100:>4.1f}%)")

    p1 = metrics["V2_SINGLE_HEAD"]["playoffs"] / (3 * total_seasons) * 100
    p2 = metrics["TRI_HEAD_SHARED"]["playoffs"] / (3 * total_seasons) * 100
    p3 = metrics["CURRENT_AI"]["playoffs"] / (4 * total_seasons) * 100
    print(f"{'Playoff Qual Rate (Top 4)':<32} | {p1:>8.1f}%         | {p2:>8.1f}%              | {p3:>8.1f}%")

    w1 = metrics["V2_SINGLE_HEAD"]["wins"] / max(1, metrics["V2_SINGLE_HEAD"]["matches"]) * 100
    w2 = metrics["TRI_HEAD_SHARED"]["wins"] / max(1, metrics["TRI_HEAD_SHARED"]["matches"]) * 100
    w3 = metrics["CURRENT_AI"]["wins"] / max(1, metrics["CURRENT_AI"]["matches"]) * 100
    print(f"{'Overall Match Win %':<32} | {w1:>8.1f}%         | {w2:>8.1f}%              | {w3:>8.1f}%")

    print(f"{'Starting XI Mean OVR':<32} | {np.mean(metrics['V2_SINGLE_HEAD']['xi_ovrs']):>8.2f}           | {np.mean(metrics['TRI_HEAD_SHARED']['xi_ovrs']):>8.2f}                 | {np.mean(metrics['CURRENT_AI']['xi_ovrs']):>8.2f}")
    print(f"{'Weak Link (Min Starter OVR)':<32} | {np.mean(metrics['V2_SINGLE_HEAD']['weak_links']):>8.2f}           | {np.mean(metrics['TRI_HEAD_SHARED']['weak_links']):>8.2f}                 | {np.mean(metrics['CURRENT_AI']['weak_links']):>8.2f}")
    print(f"{'Mean Top 11 Spend':<32} | ₹{np.mean(metrics['V2_SINGLE_HEAD']['top11']):>7.2f} Cr       | ₹{np.mean(metrics['TRI_HEAD_SHARED']['top11']):>7.2f} Cr          | ₹{np.mean(metrics['CURRENT_AI']['top11']):>7.2f} Cr")
    print(f"{'Mean Leftover Purse':<32} | ₹{np.mean(metrics['V2_SINGLE_HEAD']['purse_left']):>7.2f} Cr       | ₹{np.mean(metrics['TRI_HEAD_SHARED']['purse_left']):>7.2f} Cr          | ₹{np.mean(metrics['CURRENT_AI']['purse_left']):>7.2f} Cr")

    print("\n" + "-" * 105)
    print("DIRECT HEAD-TO-HEAD MATCHES:")
    c_th = h2h[("CURRENT_AI", "TRI_HEAD_SHARED")]; th_c = h2h[("TRI_HEAD_SHARED", "CURRENT_AI")]
    print(f"  • Current AI vs Tri-Head Shared: Current AI Won {c_th} vs {th_c} ({c_th/(c_th+th_c)*100:.1f}% vs {th_c/(c_th+th_c)*100:.1f}%)")

    c_v2 = h2h[("CURRENT_AI", "V2_SINGLE_HEAD")]; v2_c = h2h[("V2_SINGLE_HEAD", "CURRENT_AI")]
    print(f"  • Current AI vs V2.0 Single-Head: Current AI Won {c_v2} vs {v2_c} ({c_v2/(c_v2+v2_c)*100:.1f}% vs {v2_c/(c_v2+v2_c)*100:.1f}%)")

    th_v2 = h2h[("TRI_HEAD_SHARED", "V2_SINGLE_HEAD")]; v2_th = h2h[("V2_SINGLE_HEAD", "TRI_HEAD_SHARED")]
    print(f"  • Tri-Head Shared vs V2.0 Single-Head: Tri-Head Won {th_v2} vs {v2_th} ({th_v2/(th_v2+v2_th)*100:.1f}% vs {v2_th/(th_v2+v2_th)*100:.1f}%)")
    print("=" * 105)

if __name__ == "__main__":
    main()

"""
scripts/benchmark_set_intelligence.py
Head-to-Head Tournament Benchmark on NVIDIA CUDA GPU:
Current AI (No Look-Ahead) vs Set-Intelligent AI (With Upcoming Queue Scanner & Set Pacing)
"""

import os
import sys
import json
import random
import copy
from pathlib import Path
import numpy as np

# Load intrinsic valuation and bidding functions
from benchmark_1000_matches import (
    CUDAMatchSim,
    compute_all_v_intrinsic,
    forward_numpy,
    extract_features_18,
    get_next_bid_increment,
    FRANCHISES,
    STARTING_XI_ROLE_TARGETS
)

def evaluate_set_intelligent_bid(
    team: dict,
    player: dict,
    current_bid: float,
    v_int: float,
    upcoming_queue: list = None
) -> bool:
    squad_sz = len(team["squad"])
    target_sq = team["target_squad"]
    purse = team["purse"]
    bp = float(player.get("basePrice", 0.30) or 0.30)
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    role = player.get("role", "BAT")
    is_os = player.get("isOverseas", False)
    arch = team["archetype"]
    player_set = int(player.get("marqueeSet", 1) or 1)

    inc = get_next_bid_increment(current_bid)
    next_bid = bp if current_bid == 0.0 else current_bid + inc

    # 1. Solvency Clamp: Purse - (0.40 * slots_to_18)
    slots_to_18 = max(0, 18 - squad_sz - 1)
    max_afford = max(0.0, purse - slots_to_18 * 0.40)
    if purse < next_bid or max_afford < next_bid:
        return False

    if is_os and team["overseas_count"] >= 8:
        return False

    # 2. Specialist Policy Output
    feat18 = extract_features_18(team, player, current_bid, v_int)
    m_policy = forward_numpy(feat18, team["policy_weights"])

    # 3. Capital Staging
    if squad_sz < 11:
        starter_slots = max(1, 11 - squad_sz)
        starter_alloc = max(0.0, purse - 16.50) / starter_slots
        m_stage = float(np.clip(1.05 + 0.12 * (starter_alloc - 9.0), 0.90, 1.35))
    else:
        bench_slots = max(1, target_sq - squad_sz)
        m_stage = float(np.clip(0.75 + 0.15 * (purse / bench_slots - 2.20), 0.55, 1.15))

    # 4. Role Need & Quota
    cur_role = team["role_counts"].get(role, 0)
    tar_role = STARTING_XI_ROLE_TARGETS.get(role, 3)
    if squad_sz < 11:
        need_factor = 1.0 + 0.12 * (tar_role - cur_role) if cur_role < tar_role else 0.90
    else:
        need_factor = 0.80 if cur_role < tar_role + 2 else 0.55

    # =========================================================================
    # 5. CALIBRATED SET KNOWLEDGE & LOOK-AHEAD QUEUE SCANNER
    # =========================================================================
    set_urgency_mult = 1.0

    if upcoming_queue:
        upcoming_same_role = [p for p in upcoming_queue[:6] if p.get("role") == role]

        # Scenario A: "Upcoming Icon Queue Reserve"
        # If we already have at least 1 player in this role, current lot is moderate (<=86 OVR),
        # and a top-tier icon (>=92 OVR) is queued within the next 3 lots:
        has_imminent_icon = any(float(p.get("stats", {}).get("ovr", 0)) >= 92.0 for p in upcoming_same_role[:3])
        if has_imminent_icon and cur_role >= 1 and ovr <= 86:
            set_urgency_mult = 0.92  # Prudent moderation, not surrender

        # Scenario B: "Scarcity Lock" (Positive Urgency Strike)
        # If this is the LAST high-quality player (>=86 OVR) of this role in the next 10 lots:
        has_future_quality = any(float(p.get("stats", {}).get("ovr", 0)) >= 86.0 for p in upcoming_queue[:10] if p.get("role") == role)
        if not has_future_quality and ovr >= 85 and cur_role < tar_role:
            set_urgency_mult = 1.15  # Don't let your XI get a weak-link hole!

    # Scenario C: Set Progression Pacing
    if player_set <= 2 and squad_sz <= 2:
        # Day 1 early sets: slight patience on non-stars
        if ovr < 84:
            set_urgency_mult = min(set_urgency_mult, 0.94)
    elif player_set >= 5 and cur_role == 0:
        # Late sets with zero in role: urgent acquisition
        set_urgency_mult = max(set_urgency_mult, 1.22)

    # Base target valuation
    target_val = v_int * m_policy * m_stage * need_factor * set_urgency_mult

    # Archetype rules
    if arch == "SUPERSTAR_DUELIST":
        superstar_cnt = sum(1 for p in team["squad"] if float(p.get("stats", {}).get("ovr", 0)) >= 90 or p.get("price_paid", 0) >= 15.0)
        if superstar_cnt < 2 and ovr >= 90 and squad_sz < 11:
            target_val = min(26.50, max(target_val, target_val * 1.30))
        else:
            target_val = min(16.50, target_val)
    elif arch == "MONEYBALL_CORE":
        if ovr > 90:
            target_val = min(13.00, v_int * 0.70)
        elif 82 <= ovr <= 90:
            target_val = min(18.50, target_val * 1.25)
        else:
            target_val = min(2.50 if squad_sz < 11 else bp * 1.5, target_val * 0.65)
    else:
        target_val = min(16.50, target_val)

    target_val = min(26.50, target_val)
    if squad_sz < 11:
        starter_cap = max(bp, max(0.0, purse - 16.50) - (max(1, 11 - squad_sz) - 1) * 0.40)
        target_val = min(target_val, starter_cap)

    target_val = max(bp, min(target_val, max_afford))
    return next_bid <= target_val

# Existing Current AI (No look-ahead)
from benchmark_1000_matches import evaluate_v3_specialist_bid

def run_tournament(total_seasons: int = 20):
    print("=" * 85)
    print(f"HEAD-TO-HEAD TOURNAMENT: CURRENT AI vs SET-INTELLIGENT AI ({total_seasons} FULL SEASONS)")
    print("5 Teams Current AI vs 5 Teams Set-Intelligent AI (CUDA GPU Accelerated)")
    print("=" * 85)

    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_int_map = compute_all_v_intrinsic(all_players)
    sim = CUDAMatchSim()

    weights = {
        "SUPERSTAR_DUELIST": json.loads(Path("public/models/weights_sd.json").read_text(encoding="utf-8")),
        "MONEYBALL_CORE": json.loads(Path("public/models/weights_mb.json").read_text(encoding="utf-8")),
        "DISCIPLINED_PRAGMATIST": json.loads(Path("public/models/weights_dp.json").read_text(encoding="utf-8"))
    }

    team_configs = [
        ("CURRENT_AI", "SUPERSTAR_DUELIST", 18),
        ("CURRENT_AI", "MONEYBALL_CORE", 20),
        ("CURRENT_AI", "MONEYBALL_CORE", 20),
        ("CURRENT_AI", "SUPERSTAR_DUELIST", 18),
        ("CURRENT_AI", "DISCIPLINED_PRAGMATIST", 19),
        ("SET_INTELLIGENT", "DISCIPLINED_PRAGMATIST", 19),
        ("SET_INTELLIGENT", "DISCIPLINED_PRAGMATIST", 19),
        ("SET_INTELLIGENT", "SUPERSTAR_DUELIST", 18),
        ("SET_INTELLIGENT", "MONEYBALL_CORE", 20),
        ("SET_INTELLIGENT", "MONEYBALL_CORE", 20)
    ]

    metrics = {
        "CURRENT_AI": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []},
        "SET_INTELLIGENT": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []}
    }

    h2h = {"CURRENT_AI": 0, "SET_INTELLIGENT": 0}
    total_matches = 0

    for s_idx in range(total_seasons):
        seed = 15000 + s_idx * 23
        rng = random.Random(seed)
        rng_sim = np.random.RandomState(seed)

        teams = []
        for idx, pf in enumerate(FRANCHISES):
            engine, arch, target_sq = team_configs[idx]
            teams.append({
                "idx": idx,
                "id": pf["id"],
                "name": pf["name"],
                "engine": engine,
                "archetype": arch,
                "target_squad": target_sq,
                "policy_weights": weights[arch],
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

        for lot_idx, p in enumerate(main_lots):
            bp = float(p.get("basePrice", 0.30) or 0.30)
            v_int = v_int_map.get(p["id"], bp)
            role = p.get("role", "BAT")
            is_os = p.get("isOverseas", False)
            upcoming_queue = main_lots[lot_idx + 1 :]

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

                    if t["engine"] == "SET_INTELLIGENT":
                        can_bid = evaluate_set_intelligent_bid(t, p, current_bid, v_int, upcoming_queue)
                    else:
                        can_bid = evaluate_v3_specialist_bid(t, p, current_bid, v_int)

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

        # 3. Simulate Matches with CUDA
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

    print("\n" + "=" * 85)
    print(f"HEAD-TO-HEAD BENCHMARK REPORT ({total_matches} TOTAL MATCHES)")
    print("=" * 85)
    print(f"{'Metric':<32} | {'Current AI (5 Teams)':<22} | {'Set-Intelligent AI (5 Teams)':<24}")
    print("-" * 88)

    c1 = metrics["CURRENT_AI"]["trophies"]
    c2 = metrics["SET_INTELLIGENT"]["trophies"]
    print(f"{'Championships Won':<32} | {c1:>3} ({c1/total_seasons*100:>4.1f}%)              | {c2:>3} ({c2/total_seasons*100:>4.1f}%)")

    p1 = metrics["CURRENT_AI"]["playoffs"] / (5 * total_seasons) * 100
    p2 = metrics["SET_INTELLIGENT"]["playoffs"] / (5 * total_seasons) * 100
    print(f"{'Playoff Qual Rate (Top 4)':<32} | {p1:>8.1f}%               | {p2:>8.1f}%")

    w1 = metrics["CURRENT_AI"]["wins"] / max(1, metrics["CURRENT_AI"]["matches"]) * 100
    w2 = metrics["SET_INTELLIGENT"]["wins"] / max(1, metrics["SET_INTELLIGENT"]["matches"]) * 100
    print(f"{'Match Win %':<32} | {w1:>8.1f}%               | {w2:>8.1f}%")

    print(f"{'Starting XI Mean OVR':<32} | {np.mean(metrics['CURRENT_AI']['xi_ovrs']):>8.2f}                 | {np.mean(metrics['SET_INTELLIGENT']['xi_ovrs']):>8.2f}")
    print(f"{'Weak Link (Min Starter OVR)':<32} | {np.mean(metrics['CURRENT_AI']['weak_links']):>8.2f}                 | {np.mean(metrics['SET_INTELLIGENT']['weak_links']):>8.2f}")
    print(f"{'Mean Top 11 Spend':<32} | ₹{np.mean(metrics['CURRENT_AI']['top11']):>7.2f} Cr             | ₹{np.mean(metrics['SET_INTELLIGENT']['top11']):>7.2f} Cr")
    print(f"{'Mean Leftover Purse Buffer':<32} | ₹{np.mean(metrics['CURRENT_AI']['purse_left']):>7.2f} Cr             | ₹{np.mean(metrics['SET_INTELLIGENT']['purse_left']):>7.2f} Cr")

    print("-" * 88)
    c_w = h2h["CURRENT_AI"]; s_w = h2h["SET_INTELLIGENT"]
    print(f"DIRECT HEAD-TO-HEAD MATCHES:")
    print(f"  • Set-Intelligent Won {s_w} vs Current AI Won {c_w} ({s_w/(s_w+c_w)*100:.1f}% vs {c_w/(c_w+c_w)*100:.1f}%)")
    print("=" * 88)

if __name__ == "__main__":
    run_tournament(20)

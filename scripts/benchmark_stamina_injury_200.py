"""
scripts/benchmark_stamina_injury_200.py
Benchmarking 200 matches each:
1. Old Baseline Mechanism (No in-match stamina decay, zero injuries, fixed Starting XI)
2. New Spell-Stamina + SR/Econ Forward Pass + 3-Level Injury System (Dynamic Bench Rotation)
Executed with NVIDIA CUDA GPU acceleration.
"""

import os
import sys
import json
import random
import copy
from pathlib import Path
import numpy as np

# Load intrinsic valuation and XGBoost GPU match simulator
from benchmark_1000_matches import (
    CUDAMatchSim,
    compute_all_v_intrinsic,
    forward_numpy,
    extract_features_18,
    get_next_bid_increment,
    FRANCHISES,
    STARTING_XI_ROLE_TARGETS,
    evaluate_v3_specialist_bid
)

def run_single_auction(all_players, v_int_map, weights, seed=42):
    rng = random.Random(seed)
    team_configs = [
        ("SUPERSTAR_DUELIST", 18),
        ("MONEYBALL_CORE", 20),
        ("MONEYBALL_CORE", 20),
        ("SUPERSTAR_DUELIST", 18),
        ("DISCIPLINED_PRAGMATIST", 19),
        ("DISCIPLINED_PRAGMATIST", 19),
        ("DISCIPLINED_PRAGMATIST", 19),
        ("SUPERSTAR_DUELIST", 18),
        ("MONEYBALL_CORE", 20),
        ("MONEYBALL_CORE", 20)
    ]

    teams = []
    for idx, pf in enumerate(FRANCHISES):
        arch, target_sq = team_configs[idx]
        teams.append({
            "idx": idx,
            "id": pf["id"],
            "name": pf["name"],
            "archetype": arch,
            "target_squad": target_sq,
            "policy_weights": weights[arch],
            "purse": 125.00,
            "squad": [],
            "role_counts": {"BAT": 0, "WK": 0, "AR": 0, "PACE": 0, "SPIN": 0},
            "overseas_count": 0,
            "pitch": pf["pitch"]
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
                if evaluate_v3_specialist_bid(t, p, current_bid, v_int):
                    candidates.append(t["idx"])

            if not candidates: break
            current_leader = rng.choice(candidates)
            current_bid = next_bid

        if current_leader is not None:
            winner = teams[current_leader]
            winner["purse"] = round(winner["purse"] - current_bid, 2)
            p_rec = copy.deepcopy(p)
            p_rec["price_paid"] = current_bid
            winner["squad"].append(p_rec)
            winner["role_counts"][role] = winner["role_counts"].get(role, 0) + 1
            if is_os: winner["overseas_count"] += 1
        else:
            unsold.append(p)

    # Accelerated round to reach squad targets
    acc_pool = unsold + acc_lots
    rng.shuffle(acc_pool)
    for t in teams:
        target_sz = t["target_squad"]
        while len(t["squad"]) < target_sz and acc_pool:
            cand = acc_pool.pop(0)
            bp = float(cand.get("basePrice", 0.30) or 0.30)
            if t["purse"] >= bp:
                t["purse"] = round(t["purse"] - bp, 2)
                p_rec = copy.deepcopy(cand)
                p_rec["price_paid"] = bp
                t["squad"].append(p_rec)
                t["role_counts"][cand.get("role", "BAT")] = t["role_counts"].get(cand.get("role", "BAT"), 0) + 1
                if cand.get("isOverseas", False):
                    t["overseas_count"] += 1

    return teams, acc_pool

# =============================================================================
# SIMULATION ENGINE: OLD (BASELINE) VS NEW (STAMINA + INJURY + SR/ECON PASS)
# =============================================================================

def simulate_200_old_baseline(teams, sim, total_matches=200, seed=1001):
    rng = np.random.RandomState(seed)
    
    # In Old Baseline: Fixed Starting XI, 0 injuries, 0 stamina degradation
    for t in teams:
        t["xi"] = sim.select_starting_xi(t["squad"])
        t["bench_apps"] = 0

    scores = []
    bat_srs = []
    bwl_econs = []
    win_counts = {t["id"]: 0 for t in teams}

    match_schedule = []
    team_indices = list(range(len(teams)))
    while len(match_schedule) < total_matches:
        i, j = rng.choice(team_indices, size=2, replace=False)
        match_schedule.append((teams[i], teams[j]))

    for m_idx, (t_h, t_a) in enumerate(match_schedule):
        # 1. Inning 1 (Home bats, Away bowls)
        bat_h = sorted(t_h["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_a = [p for p in t_a["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or t_a["xi"][:5]

        overs_h = []
        for o in range(20):
            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 1.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(bat_h[min(o // 3, len(bat_h) - 1)].get("stats", {}).get("bat", 75.0))
            vec[7] = float(bat_h[min(o // 3, len(bat_h) - 1)].get("stats", {}).get("power", 75.0))
            vec[10] = float(bat_h[min((o // 3) + 1, len(bat_h) - 1)].get("stats", {}).get("bat", 75.0))
            vec[12] = float(bwl_a[o % len(bwl_a)].get("stats", {}).get("bowl", 75.0))
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_h.append(vec)

        # 2. Inning 2 (Away bats, Home bowls)
        bat_a = sorted(t_a["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_h = [p for p in t_h["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or t_h["xi"][:5]

        overs_a = []
        for o in range(20):
            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 2.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(bat_a[min(o // 3, len(bat_a) - 1)].get("stats", {}).get("bat", 75.0))
            vec[7] = float(bat_a[min(o // 3, len(bat_a) - 1)].get("stats", {}).get("power", 75.0))
            vec[10] = float(bat_a[min((o // 3) + 1, len(bat_a) - 1)].get("stats", {}).get("bat", 75.0))
            vec[12] = float(bwl_h[o % len(bwl_h)].get("stats", {}).get("bowl", 75.0))
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_a.append(vec)

        preds_h = sim.mr.predict(np.array(overs_h, dtype=np.float32))
        preds_a = sim.mr.predict(np.array(overs_a, dtype=np.float32))

        # Raw summation without logistic bounds
        score_h = float(np.sum(preds_h)) + 4.0 + rng.normal(0, 6.0)
        score_a = float(np.sum(preds_a)) + rng.normal(0, 6.0)

        scores.extend([score_h, score_a])
        bwl_econs.extend([score_h / 20.0, score_a / 20.0])
        bat_srs.extend([(score_h / 120.0) * 100.0, (score_a / 120.0) * 100.0])

        if score_h >= score_a:
            win_counts[t_h["id"]] += 1
        else:
            win_counts[t_a["id"]] += 1

    return {
        "scores": scores,
        "bat_srs": bat_srs,
        "bwl_econs": bwl_econs,
        "win_counts": win_counts,
        "injuries": {"lvl1": 0, "lvl2": 0, "lvl3": 0},
        "bench_appearances": 0
    }

def simulate_200_new_stamina_injury(teams, unsold_pool, sim, total_matches=200, seed=1001):
    rng = np.random.RandomState(seed)
    py_rng = random.Random(seed)

    # Initialize each player's stamina & workload
    for t in teams:
        for p in t["squad"]:
            p["workload"] = 0.0
            p["injury_status"] = 0  # 0: Healthy, >0: matches remaining injured, -1: Ruled Out
            p["matches_played"] = 0
            p["bench_matches"] = 0

    scores = []
    bat_srs = []
    bwl_econs = []
    win_counts = {t["id"]: 0 for t in teams}
    injury_counts = {"lvl1": 0, "lvl2": 0, "lvl3": 0}
    total_bench_apps = 0

    match_schedule = []
    team_indices = list(range(len(teams)))
    while len(match_schedule) < total_matches:
        i, j = rng.choice(team_indices, size=2, replace=False)
        match_schedule.append((teams[i], teams[j]))

    for m_idx, (t_h, t_a) in enumerate(match_schedule):
        # 1. Update injury counters from previous matches
        for t in [t_h, t_a]:
            for p in t["squad"]:
                if p["injury_status"] > 0:
                    p["injury_status"] -= 1

        # 2. Squad Selection with Dynamic Bench Rotation
        # Filter available (healthy) players
        def pick_active_xi(t):
            healthy_pool = [p for p in t["squad"] if p["injury_status"] == 0]
            # If healthy pool < 11 (rare emergency), use whatever is available
            if len(healthy_pool) < 11:
                healthy_pool = [p for p in t["squad"] if p["injury_status"] != -1]
            xi = sim.select_starting_xi(healthy_pool)
            return xi

        xi_h = pick_active_xi(t_h)
        xi_a = pick_active_xi(t_a)

        # Track bench appearances
        h_starter_ids = {p["id"] for p in xi_h}
        a_starter_ids = {p["id"] for p in xi_a}

        # Original top 11 of franchise
        orig_top11_h = {p["id"] for p in sim.select_starting_xi(t_h["squad"])}
        orig_top11_a = {p["id"] for p in sim.select_starting_xi(t_a["squad"])}

        bench_h = [p for p in xi_h if p["id"] not in orig_top11_h]
        bench_a = [p for p in xi_a if p["id"] not in orig_top11_a]
        total_bench_apps += len(bench_h) + len(bench_a)

        # 3. Inning 1 (Home Bats, Away Bowls)
        # In-Match Stamina Setup
        bat_h = sorted(xi_h, key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_a = [p for p in xi_a if p.get("role") in ["PACE", "SPIN", "AR"]] or xi_a[:5]

        # Bowler in-match stamina tracker
        bwl_stamina_a = {p["id"]: float(p.get("stats", {}).get("staminaRecov", 92.0)) for p in bwl_a}
        bwl_overs_a = {p["id"]: 0 for p in bwl_a}
        last_bowler_id_a = None

        overs_h = []
        for o in range(20):
            bowler = bwl_a[o % len(bwl_a)]
            b_id = bowler["id"]
            is_pacer = bowler.get("role") == "PACE"

            # Bowler Stamina Drain
            drain = 12.0 if is_pacer else 8.0
            if last_bowler_id_a == b_id:
                drain += 4.0  # Heat penalty for back-to-back spell
            bwl_stamina_a[b_id] = max(50.0, bwl_stamina_a[b_id] - drain)
            bwl_overs_a[b_id] += 1
            last_bowler_id_a = b_id

            # Rest recovery for all other bowlers not bowling this over
            for ob in bwl_a:
                if ob["id"] != b_id:
                    bwl_stamina_a[ob["id"]] = min(float(ob.get("stats", {}).get("staminaRecov", 92.0)), bwl_stamina_a[ob["id"]] + 6.0)

            # Effective Bowler Stat after stamina
            b_stam = bwl_stamina_a[b_id]
            stamina_factor = 1.0 - 0.08 * ((70.0 - b_stam) / 20.0) if b_stam < 70.0 else 1.0
            eff_bowl = float(bowler.get("stats", {}).get("bowl", 75.0)) * stamina_factor

            # Batter fatigue
            batter = bat_h[min(o // 3, len(bat_h) - 1)]
            eff_power = float(batter.get("stats", {}).get("power", 75.0))
            if o >= 14:  # Late innings fatigue for batters facing 30+ balls
                eff_power *= 0.95

            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 1.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(batter.get("stats", {}).get("bat", 75.0))
            vec[7] = eff_power
            vec[10] = float(bat_h[min((o // 3) + 1, len(bat_h) - 1)].get("stats", {}).get("bat", 75.0))
            vec[12] = eff_bowl
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_h.append(vec)

        # 4. Inning 2 (Away Bats, Home Bowls)
        bat_a = sorted(xi_a, key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_h = [p for p in xi_h if p.get("role") in ["PACE", "SPIN", "AR"]] or xi_h[:5]

        bwl_stamina_h = {p["id"]: float(p.get("stats", {}).get("staminaRecov", 92.0)) for p in bwl_h}
        bwl_overs_h = {p["id"]: 0 for p in bwl_h}
        last_bowler_id_h = None

        overs_a = []
        for o in range(20):
            bowler = bwl_h[o % len(bwl_h)]
            b_id = bowler["id"]
            is_pacer = bowler.get("role") == "PACE"

            drain = 12.0 if is_pacer else 8.0
            if last_bowler_id_h == b_id:
                drain += 4.0
            bwl_stamina_h[b_id] = max(50.0, bwl_stamina_h[b_id] - drain)
            bwl_overs_h[b_id] += 1
            last_bowler_id_h = b_id

            for ob in bwl_h:
                if ob["id"] != b_id:
                    bwl_stamina_h[ob["id"]] = min(float(ob.get("stats", {}).get("staminaRecov", 92.0)), bwl_stamina_h[ob["id"]] + 6.0)

            b_stam = bwl_stamina_h[b_id]
            stamina_factor = 1.0 - 0.08 * ((70.0 - b_stam) / 20.0) if b_stam < 70.0 else 1.0
            eff_bowl = float(bowler.get("stats", {}).get("bowl", 75.0)) * stamina_factor

            batter = bat_a[min(o // 3, len(bat_a) - 1)]
            eff_power = float(batter.get("stats", {}).get("power", 75.0))
            if o >= 14:
                eff_power *= 0.95

            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 2.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(batter.get("stats", {}).get("bat", 75.0))
            vec[7] = eff_power
            vec[10] = float(bat_a[min((o // 3) + 1, len(bat_a) - 1)].get("stats", {}).get("bat", 75.0))
            vec[12] = eff_bowl
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_a.append(vec)

        # GPU Model Inference
        preds_h = sim.mr.predict(np.array(overs_h, dtype=np.float32))
        preds_a = sim.mr.predict(np.array(overs_a, dtype=np.float32))

        # Forward Pass: Phase-Bounded Logistic Clamping (prevents runaway blowouts)
        def clamp_over_runs(over_preds):
            clamped = []
            for o_idx, r in enumerate(over_preds):
                if o_idx < 6:
                    r_c = np.clip(r + rng.normal(0, 1.2), 4.5, 13.0)
                elif o_idx < 15:
                    r_c = np.clip(r + rng.normal(0, 1.0), 4.8, 12.5)
                else:
                    r_c = np.clip(r + rng.normal(0, 1.5), 6.0, 16.5)
                clamped.append(r_c)
            return float(np.sum(clamped))

        score_h = clamp_over_runs(preds_h)
        score_a = clamp_over_runs(preds_a)

        scores.extend([score_h, score_a])
        bwl_econs.extend([score_h / 20.0, score_a / 20.0])
        bat_srs.extend([(score_h / 120.0) * 100.0, (score_a / 120.0) * 100.0])

        if score_h >= score_a:
            win_counts[t_h["id"]] += 1
        else:
            win_counts[t_a["id"]] += 1

        # 5. Workload Accrual & Calibrated Injury Roll (Target: 0.8 - 1.2 per match)
        for t, active_xi in [(t_h, xi_h), (t_a, xi_a)]:
            active_ids = {p["id"] for p in active_xi}
            current_injured_count = sum(1 for p in t["squad"] if p["injury_status"] != 0)

            for p in t["squad"]:
                if p["id"] in active_ids:
                    # Active Match Load: Moderate accrual (danger zone after 5-7 matches)
                    p["matches_played"] += 1
                    load_gain = 12.0 if p.get("role") == "PACE" else 9.0
                    p["workload"] = min(100.0, p["workload"] + load_gain)

                    # Injury Check if Workload > 72 AND franchise has < 3 injuries
                    if p["workload"] > 72.0 and p["injury_status"] == 0 and current_injured_count < 3:
                        # Tuned to hit ~0.8 - 1.2 injuries per match across the league
                        base_risk = float(p.get("stats", {}).get("injuryRisk", 0.10)) * 0.55
                        risk_prob = base_risk * ((p["workload"] - 72.0) / 28.0)

                        if py_rng.random() < risk_prob:
                            current_injured_count += 1
                            roll = py_rng.random()
                            if roll < 0.80:
                                # Level 1: Minor Niggle (1 Match Pause)
                                p["injury_status"] = 1
                                p["workload"] = max(0.0, p["workload"] - 30.0)
                                injury_counts["lvl1"] += 1
                            elif roll < 0.96:
                                # Level 2: Strain (3 Matches Pause)
                                p["injury_status"] = 3
                                p["workload"] = max(0.0, p["workload"] - 45.0)
                                injury_counts["lvl2"] += 1
                            else:
                                # Level 3: Ruled Out (Tournament-Ending Tear) -> Unsold Replacement
                                p["injury_status"] = -1
                                injury_counts["lvl3"] += 1
                                same_role_unsold = [u for u in unsold_pool if u.get("role") == p.get("role")]
                                if same_role_unsold:
                                    rep = same_role_unsold.pop(0)
                                    rep_p = copy.deepcopy(rep)
                                    rep_p["workload"] = 0.0
                                    rep_p["injury_status"] = 0
                                    rep_p["price_paid"] = 0.0
                                    rep_p["matches_played"] = 0
                                    rep_p["bench_matches"] = 0
                                    t["squad"].append(rep_p)
                else:
                    # Bench Recovery
                    p["bench_matches"] = p.get("bench_matches", 0) + 1
                    p["workload"] = max(0.0, p.get("workload", 0.0) - 35.0)

    return {
        "scores": scores,
        "bat_srs": bat_srs,
        "bwl_econs": bwl_econs,
        "win_counts": win_counts,
        "injuries": injury_counts,
        "bench_appearances": total_bench_apps
    }

def main():
    print("=" * 85)
    print("SIMULATION BENCHMARK: OLD BASELINE vs NEW STAMINA/INJURY/SR-ECON MECHANISM")
    print("Total: 200 Full Matches Each (NVIDIA CUDA GPU Accelerated)")
    print("=" * 85)

    raw = Path("public/data/players_active.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_int_map = compute_all_v_intrinsic(all_players)
    sim = CUDAMatchSim()

    weights = {
        "SUPERSTAR_DUELIST": json.loads(Path("public/models/weights_sd.json").read_text(encoding="utf-8")),
        "MONEYBALL_CORE": json.loads(Path("public/models/weights_mb.json").read_text(encoding="utf-8")),
        "DISCIPLINED_PRAGMATIST": json.loads(Path("public/models/weights_dp.json").read_text(encoding="utf-8"))
    }

    print("\n[Step 1] Conducting Unified IPL Mega Auction for 10 Franchises...")
    teams_base, unsold_pool = run_single_auction(all_players, v_int_map, weights, seed=999)
    print(f"Auction Complete! 10 Franchises built. Unsold pool has {len(unsold_pool)} players.")

    # Deepcopy for exact identical baseline comparison
    teams_old = copy.deepcopy(teams_base)
    teams_new = copy.deepcopy(teams_base)

    print("\n[Step 2] Simulating 200 Matches: Old Baseline (Fixed XI, 0 Stamina, 0 Injuries)...")
    res_old = simulate_200_old_baseline(teams_old, sim, total_matches=200, seed=42)
    print("Old Baseline 200 matches completed.")

    print("\n[Step 3] Simulating 200 Matches: New Mechanism (Spell Stamina, SR/Econ Clamping, 3-Tier Injuries, Bench Rotation)...")
    res_new = simulate_200_new_stamina_injury(teams_new, unsold_pool, sim, total_matches=200, seed=42)
    print("New Mechanism 200 matches completed.")

    # Detailed Analysis Report
    print("\n" + "=" * 85)
    print("DETAILED COMPARISON & GAMEPLAY ANALYSIS REPORT (200 MATCHES)")
    print("=" * 85)
    print(f"{'Performance Metric':<35} | {'Old Baseline':<20} | {'New Stamina & Injury':<20}")
    print("-" * 81)

    print(f"{'Mean Match Score (per Inning)':<35} | {np.mean(res_old['scores']):.2f} runs            | {np.mean(res_new['scores']):.2f} runs")
    print(f"{'Score Std Deviation (Volatility)':<35} | {np.std(res_old['scores']):.2f}                | {np.std(res_new['scores']):.2f}")
    print(f"{'Min Score / Max Score':<35} | {np.min(res_old['scores']):.1f} / {np.max(res_old['scores']):.1f}       | {np.min(res_new['scores']):.1f} / {np.max(res_new['scores']):.1f}")
    print(f"{'Mean Team Batting Strike Rate':<35} | {np.mean(res_old['bat_srs']):.2f}               | {np.mean(res_new['bat_srs']):.2f}")
    print(f"{'Mean Bowling Economy (RPO)':<35} | {np.mean(res_old['bwl_econs']):.2f}                | {np.mean(res_new['bwl_econs']):.2f}")
    print(f"{'Economy Range [Min, Max]':<35} | [{np.min(res_old['bwl_econs']):.2f}, {np.max(res_old['bwl_econs']):.2f}]       | [{np.min(res_new['bwl_econs']):.2f}, {np.max(res_new['bwl_econs']):.2f}]")
    print("-" * 81)
    print("INJURY & WORKLOAD METRICS (Across 200 Matches):")
    print(f"  • Level 1 Injuries (1 Match Pause)     : {res_new['injuries']['lvl1']} occurrences (Minor niggle, auto-recovery)")
    print(f"  • Level 2 Injuries (3 Match Pause)     : {res_new['injuries']['lvl2']} occurrences (Muscle strain, squad depth test)")
    print(f"  • Level 3 Injuries (Ruled Out)         : {res_new['injuries']['lvl3']} occurrences (Replacement signed from unsold)")
    print(f"  • Total Bench Appearances              : {res_new['bench_appearances']} player-matches (vs {res_old['bench_appearances']} in Old Baseline)")
    print("=" * 85)

if __name__ == "__main__":
    main()

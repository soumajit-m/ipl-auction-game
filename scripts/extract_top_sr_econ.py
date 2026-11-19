"""
scripts/extract_top_sr_econ.py
Simulates 200 matches under the calibrated Spell-Stamina, 3-Tier Injury & SR/Econ Engine,
and extracts the Top 10 Batters by Strike Rate (SR) and Top 10 Bowlers by Economy (Econ).
"""

import os
import sys
import json
import random
import copy
from pathlib import Path
import numpy as np

from benchmark_1000_matches import (
    CUDAMatchSim,
    compute_all_v_intrinsic,
    FRANCHISES
)
from benchmark_stamina_injury_200 import run_single_auction

def run_tournament_and_extract_top_stats(total_matches=200, seed=42):
    raw = Path("public/data/players_active.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_int_map = compute_all_v_intrinsic(all_players)
    sim = CUDAMatchSim()

    weights = {
        "SUPERSTAR_DUELIST": json.loads(Path("public/models/weights_sd.json").read_text(encoding="utf-8")),
        "MONEYBALL_CORE": json.loads(Path("public/models/weights_mb.json").read_text(encoding="utf-8")),
        "DISCIPLINED_PRAGMATIST": json.loads(Path("public/models/weights_dp.json").read_text(encoding="utf-8"))
    }

    print("Running IPL Mega Auction for 10 Franchises...")
    teams, unsold_pool = run_single_auction(all_players, v_int_map, weights, seed=999)

    # Initialize stats tracking dicts
    player_bat_stats = {}
    player_bwl_stats = {}

    for t in teams:
        for p in t["squad"]:
            p["workload"] = 0.0
            p["injury_status"] = 0
            p["matches_played"] = 0
            p["bench_matches"] = 0

            player_bat_stats[p["id"]] = {
                "name": p.get("name", p["id"]),
                "franchise": t["id"],
                "role": p.get("role", "BAT"),
                "ovr": float(p.get("stats", {}).get("ovr", 75)),
                "runs": 0,
                "balls": 0,
                "sixes": 0,
                "fours": 0
            }
            player_bwl_stats[p["id"]] = {
                "name": p.get("name", p["id"]),
                "franchise": t["id"],
                "role": p.get("role", "BAT"),
                "ovr": float(p.get("stats", {}).get("ovr", 75)),
                "overs": 0,
                "runs_conceded": 0.0,
                "wickets": 0
            }

    rng = np.random.RandomState(seed)
    py_rng = random.Random(seed)

    match_schedule = []
    team_indices = list(range(len(teams)))
    while len(match_schedule) < total_matches:
        i, j = rng.choice(team_indices, size=2, replace=False)
        match_schedule.append((teams[i], teams[j]))

    print(f"Simulating {total_matches} matches with Spell-Stamina, 3-Tier Injury, and SR/Econ Phase Clamping...")

    for m_idx, (t_h, t_a) in enumerate(match_schedule):
        # 1. Update injury counters
        for t in [t_h, t_a]:
            for p in t["squad"]:
                if p["injury_status"] > 0:
                    p["injury_status"] -= 1

        # 2. Squad Selection with Dynamic Bench Rotation
        def pick_active_xi(t):
            healthy_pool = [p for p in t["squad"] if p["injury_status"] == 0]
            if len(healthy_pool) < 11:
                healthy_pool = [p for p in t["squad"] if p["injury_status"] != -1]
            return sim.select_starting_xi(healthy_pool)

        xi_h = pick_active_xi(t_h)
        xi_a = pick_active_xi(t_a)

        # 3. Inning 1 (Home Bats, Away Bowls)
        bat_h = sorted(xi_h, key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_a = [p for p in xi_a if p.get("role") in ["PACE", "SPIN", "AR"]] or xi_a[:5]

        bwl_stamina_a = {p["id"]: float(p.get("stats", {}).get("staminaRecov", 92.0)) for p in bwl_a}
        last_bowler_id_a = None

        overs_h = []
        batters_in_overs_h = []
        bowlers_in_overs_h = []

        for o in range(20):
            bowler = bwl_a[o % len(bwl_a)]
            b_id = bowler["id"]
            is_pacer = bowler.get("role") == "PACE"

            drain = 12.0 if is_pacer else 8.0
            if last_bowler_id_a == b_id:
                drain += 4.0
            bwl_stamina_a[b_id] = max(50.0, bwl_stamina_a[b_id] - drain)
            last_bowler_id_a = b_id

            for ob in bwl_a:
                if ob["id"] != b_id:
                    bwl_stamina_a[ob["id"]] = min(float(ob.get("stats", {}).get("staminaRecov", 92.0)), bwl_stamina_a[ob["id"]] + 6.0)

            b_stam = bwl_stamina_a[b_id]
            stamina_factor = 1.0 - 0.08 * ((70.0 - b_stam) / 20.0) if b_stam < 70.0 else 1.0
            eff_bowl = float(bowler.get("stats", {}).get("bowl", 75.0)) * stamina_factor

            batter = bat_h[min(o // 3, len(bat_h) - 1)]
            eff_power = float(batter.get("stats", {}).get("power", 75.0))
            if o >= 14:
                eff_power *= 0.95

            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 1.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(batter.get("stats", {}).get("bat", 75.0))
            vec[7] = eff_power
            vec[10] = float(bat_h[min((o // 3) + 1, len(bat_h) - 1)].get("stats", {}).get("bat", 75.0))
            vec[12] = eff_bowl
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_h.append(vec)
            batters_in_overs_h.append(batter)
            bowlers_in_overs_h.append(bowler)

        # 4. Inning 2 (Away Bats, Home Bowls)
        bat_a = sorted(xi_a, key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_h = [p for p in xi_h if p.get("role") in ["PACE", "SPIN", "AR"]] or xi_h[:5]

        bwl_stamina_h = {p["id"]: float(p.get("stats", {}).get("staminaRecov", 92.0)) for p in bwl_h}
        last_bowler_id_h = None

        overs_a = []
        batters_in_overs_a = []
        bowlers_in_overs_a = []

        for o in range(20):
            bowler = bwl_h[o % len(bwl_h)]
            b_id = bowler["id"]
            is_pacer = bowler.get("role") == "PACE"

            drain = 12.0 if is_pacer else 8.0
            if last_bowler_id_h == b_id:
                drain += 4.0
            bwl_stamina_h[b_id] = max(50.0, bwl_stamina_h[b_id] - drain)
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
            batters_in_overs_a.append(batter)
            bowlers_in_overs_a.append(bowler)

        # GPU Predictions
        preds_h = sim.mr.predict(np.array(overs_h, dtype=np.float32))
        preds_a = sim.mr.predict(np.array(overs_a, dtype=np.float32))

        # Record Inning 1 Player Stats
        for o_idx in range(20):
            r = preds_h[o_idx]
            if o_idx < 6:
                r_c = float(np.clip(r + rng.normal(0, 1.2), 4.5, 13.0))
            elif o_idx < 15:
                r_c = float(np.clip(r + rng.normal(0, 1.0), 4.8, 12.5))
            else:
                r_c = float(np.clip(r + rng.normal(0, 1.5), 6.0, 16.5))

            bat = batters_in_overs_h[o_idx]
            bwl = bowlers_in_overs_h[o_idx]

            if bat["id"] in player_bat_stats:
                player_bat_stats[bat["id"]]["runs"] += int(round(r_c))
                player_bat_stats[bat["id"]]["balls"] += 6
            if bwl["id"] in player_bwl_stats:
                player_bwl_stats[bwl["id"]]["overs"] += 1
                player_bwl_stats[bwl["id"]]["runs_conceded"] += r_c

        # Record Inning 2 Player Stats
        for o_idx in range(20):
            r = preds_a[o_idx]
            if o_idx < 6:
                r_c = float(np.clip(r + rng.normal(0, 1.2), 4.5, 13.0))
            elif o_idx < 15:
                r_c = float(np.clip(r + rng.normal(0, 1.0), 4.8, 12.5))
            else:
                r_c = float(np.clip(r + rng.normal(0, 1.5), 6.0, 16.5))

            bat = batters_in_overs_a[o_idx]
            bwl = bowlers_in_overs_a[o_idx]

            if bat["id"] in player_bat_stats:
                player_bat_stats[bat["id"]]["runs"] += int(round(r_c))
                player_bat_stats[bat["id"]]["balls"] += 6
            if bwl["id"] in player_bwl_stats:
                player_bwl_stats[bwl["id"]]["overs"] += 1
                player_bwl_stats[bwl["id"]]["runs_conceded"] += r_c

        # Workload & Injury tracking
        for t, active_xi in [(t_h, xi_h), (t_a, xi_a)]:
            active_ids = {p["id"] for p in active_xi}
            current_injured_count = sum(1 for p in t["squad"] if p["injury_status"] != 0)

            for p in t["squad"]:
                if p["id"] in active_ids:
                    p["matches_played"] = p.get("matches_played", 0) + 1
                    load_gain = 12.0 if p.get("role") == "PACE" else 9.0
                    p["workload"] = min(100.0, p.get("workload", 0.0) + load_gain)

                    if p["workload"] > 72.0 and p["injury_status"] == 0 and current_injured_count < 3:
                        base_risk = float(p.get("stats", {}).get("injuryRisk", 0.10)) * 0.55
                        risk_prob = base_risk * ((p["workload"] - 72.0) / 28.0)

                        if py_rng.random() < risk_prob:
                            current_injured_count += 1
                            roll = py_rng.random()
                            if roll < 0.80:
                                p["injury_status"] = 1
                                p["workload"] = max(0.0, p["workload"] - 30.0)
                            elif roll < 0.96:
                                p["injury_status"] = 3
                                p["workload"] = max(0.0, p["workload"] - 45.0)
                            else:
                                p["injury_status"] = -1
                                same_role_unsold = [u for u in unsold_pool if u.get("role") == p.get("role")]
                                if same_role_unsold:
                                    rep = same_role_unsold.pop(0)
                                    rep_p = copy.deepcopy(rep)
                                    rep_p["workload"] = 0.0
                                    rep_p["injury_status"] = 0
                                    rep_p["matches_played"] = 0
                                    rep_p["bench_matches"] = 0
                                    t["squad"].append(rep_p)
                                    if rep_p["id"] not in player_bat_stats:
                                        player_bat_stats[rep_p["id"]] = {
                                            "name": rep_p.get("name", rep_p["id"]), "franchise": t["id"],
                                            "role": rep_p.get("role", "BAT"), "ovr": float(rep_p.get("stats", {}).get("ovr", 75)),
                                            "runs": 0, "balls": 0, "sixes": 0, "fours": 0
                                        }
                                        player_bwl_stats[rep_p["id"]] = {
                                            "name": rep_p.get("name", rep_p["id"]), "franchise": t["id"],
                                            "role": rep_p.get("role", "BAT"), "ovr": float(rep_p.get("stats", {}).get("ovr", 75)),
                                            "overs": 0, "runs_conceded": 0.0, "wickets": 0
                                        }
                else:
                    p["workload"] = max(0.0, p.get("workload", 0.0) - 35.0)

    # 1. Process Batting Leaders (Min 100 balls faced)
    qualified_batters = []
    for pid, s in player_bat_stats.items():
        if s["balls"] >= 100:
            sr = (s["runs"] / s["balls"]) * 100.0
            qualified_batters.append({**s, "sr": sr})

    top_10_sr = sorted(qualified_batters, key=lambda x: x["sr"], reverse=True)[:10]

    # 2. Process Bowling Leaders (Min 30 overs bowled)
    qualified_bowlers = []
    for pid, s in player_bwl_stats.items():
        if s["overs"] >= 30:
            econ = s["runs_conceded"] / s["overs"]
            qualified_bowlers.append({**s, "econ": econ})

    top_10_econ = sorted(qualified_bowlers, key=lambda x: x["econ"])[:10]

    print("\n" + "=" * 90)
    print("TOP 10 BATTERS BY STRIKE RATE (SR) - Min 100 Balls Faced (200 Matches)")
    print("=" * 90)
    print(f"{'Rank':<5} | {'Player Name':<24} | {'Team':<5} | {'Role':<6} | {'OVR':<4} | {'Runs':<6} | {'Balls':<6} | {'Strike Rate':<11}")
    print("-" * 90)
    for idx, b in enumerate(top_10_sr, 1):
        print(f"{idx:<5} | {b['name']:<24} | {b['franchise']:<5} | {b['role']:<6} | {b['ovr']:<4.0f} | {b['runs']:<6} | {b['balls']:<6} | {b['sr']:<11.2f}")

    print("\n" + "=" * 90)
    print("TOP 10 BOWLERS BY ECONOMY (ECON) - Min 30 Overs Bowled (200 Matches)")
    print("=" * 90)
    print(f"{'Rank':<5} | {'Player Name':<24} | {'Team':<5} | {'Role':<6} | {'OVR':<4} | {'Overs':<6} | {'Runs Conc.':<10} | {'Economy (RPO)':<13}")
    print("-" * 90)
    for idx, b in enumerate(top_10_econ, 1):
        print(f"{idx:<5} | {b['name']:<24} | {b['franchise']:<5} | {b['role']:<6} | {b['ovr']:<4.0f} | {b['overs']:<6} | {b['runs_conceded']:<10.1f} | {b['econ']:<13.2f}")
    print("=" * 90)

if __name__ == "__main__":
    run_tournament_and_extract_top_stats(200)

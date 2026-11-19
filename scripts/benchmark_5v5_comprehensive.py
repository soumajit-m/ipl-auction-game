#!/usr/bin/env python3
"""
benchmark_5v5_comprehensive.py - Comprehensive 5v5 Head-to-Head Benchmark
Compares:
  - Battle 1: 5 Teams V2.0 (Multi-Nature) vs 5 Teams V3.0 (Hedge-Fund Tri-Head)
  - Battle 2: 5 Teams V1.7 (Legacy) vs 5 Teams V3.0 (Hedge-Fund Tri-Head)
Across 25 Monte Carlo Auction + Season Seeds each using Dual-XGBoost Match Simulator.
"""

import sys
import os
import json
import math
import time
import random
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn
import xgboost as xgb

# =============================================================================
# 1. VALUATION ENGINES
# =============================================================================

def compute_all_v_intrinsic(players: list) -> dict:
    surplus_list = []
    for p in players:
        st = p.get("stats", {}) or {}
        bat = float(st.get("bat", 70.0) or 70.0)
        power = float(st.get("power", 70.0) or 70.0)
        bowl = float(st.get("bowl", 70.0) or 70.0)
        fld = float(st.get("fielding", 70.0) or 70.0)
        role = p.get("role", "BAT")

        if role == "BAT":
            S_i = 0.55 * bat + 0.35 * power + 0.10 * fld
        elif role == "WK":
            S_i = 0.50 * bat + 0.32 * power + 0.18 * fld
        elif role in ["PACE", "SPIN"]:
            S_i = 0.88 * bowl + 0.07 * fld + 0.05 * bat
        else: # AR
            S_i = 0.45 * max(bat, bowl) + 0.35 * min(bat, bowl) + 0.12 * power + 0.08 * fld

        w_role = 1.16 if role == "AR" else (1.10 if role == "WK" else (1.08 if role == "PACE" else (1.03 if role == "SPIN" else 1.00)))
        w_dom = 1.28 if not p.get("isOverseas", False) else 1.00
        age = float(p.get("age", 27.0) or 27.0)
        w_age = 1.08 if age <= 24 else (1.00 if age <= 33 else 0.90)
        matches = float(p.get("historical", {}).get("matches", 20.0) or 20.0)
        w_vol = 0.85 + 0.25 * min(1.0, matches / 45.0)

        surplus = (max(0.0, S_i - 65.0) ** 2.35) * w_role * w_dom * w_age * w_vol
        surplus_list.append((p, surplus))

    surplus_list.sort(key=lambda x: x[1], reverse=True)
    top_160_surplus = sum(s for _, s in surplus_list[:160]) or 1.0

    v_intrinsic_map = {}
    for p, s in surplus_list:
        bp = float(p.get("basePrice", 0.30) or 0.30)
        v_calc = bp + 1050.0 * (s / top_160_surplus)
        real_p = float(p.get("realAuctionPrice", 0.0) or 0.0)
        v_final = 0.88 * v_calc + 0.12 * real_p if real_p >= 8.0 else v_calc
        v_final = max(bp, min(26.50, round(v_final, 2)))
        v_intrinsic_map[p["id"]] = v_final

    return v_intrinsic_map

def compute_v1_legacy_base(player: dict, dna: dict) -> float:
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    role = player.get("role", "BAT")
    is_os = player.get("isOverseas", False)
    age = float(player.get("age", 27.0) or 27.0)
    bp = float(player.get("basePrice", 0.30) or 0.30)

    real_p = float(player.get("realAuctionPrice", 0.0) or 0.0)
    if real_p > 0:
        v_base = 0.70 * real_p + 0.30 * bp
    else:
        ovr_clamped = max(60.0, min(95.0, ovr))
        norm_skill = (ovr_clamped - 60.0) / 35.0
        v_base = 0.30 + (norm_skill ** 2.2) * 11.5

    m_role = 1.15 if role == "AR" else (1.10 if role == "WK" else 1.02)
    m_nat = 0.90 if is_os else 1.12
    m_age = 1.08 if age <= 24 else (1.00 if age <= 33 else 0.85)

    z_youth = dna.get("z_youth", 0.0)
    z_role = dna.get("z_role_bias", 0.0)
    z_risk = dna.get("z_risk", 0.0)
    m_dna = 1.0 + 0.06 * z_youth + 0.05 * z_role + 0.08 * z_risk

    v_val = min(13.50, v_base * m_role * m_nat * m_age * m_dna)
    return max(bp, round(v_val, 2))

def get_next_bid_increment(current_bid: float) -> float:
    if current_bid < 5.0: return 0.25
    elif current_bid < 10.0: return 0.50
    else: return 1.00

# =============================================================================
# 2. V3.0 HEDGE-FUND BID EVALUATOR (TRI-HEAD ARCHITECTURE)
# =============================================================================

STARTING_XI_ROLE_TARGETS = {
    "BAT": 4,
    "WK": 1,
    "AR": 2,
    "PACE": 3,
    "SPIN": 2
}

def evaluate_v3_bid(team: dict, player: dict, current_bid: float, v_int: float) -> tuple:
    bp = float(player.get("basePrice", 0.30) or 0.30)
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    role = player.get("role", "BAT")
    is_os = player.get("isOverseas", False)
    squad_sz = len(team["squad"])
    purse = team["purse"]
    archetype = team.get("archetype", "DISCIPLINED_PRAGMATIST")

    inc = get_next_bid_increment(current_bid)
    next_bid = bp if current_bid == 0.0 else current_bid + inc

    # User solvency clamp: remaining_purse - (0.40 * slots_needed_to_18)
    # At 0 players: 125.0 - (17 * 0.40) = 118.2 Cr max first bid
    slots_to_18 = max(0, 18 - squad_sz - 1)
    min_reserve = slots_to_18 * 0.40
    max_affordable = max(0.0, purse - min_reserve)

    if purse < next_bid or max_affordable < next_bid:
        return False, 0.0

    # Alpha confidence: historical sample size weighting
    matches = float(player.get("historical", {}).get("matches", 20.0) or 20.0)
    confidence = 0.88 + 0.12 * min(1.0, matches / 35.0)
    v_alpha = v_int * confidence

    # Staged deployment: Target deploying ₹105-110 Cr across Top 10-11 starters
    if squad_sz < 11:
        starter_slots_left = max(1, 11 - squad_sz)
        starter_budget_rem = max(0.0, purse - 16.50) # Reserve ~₹16.5 Cr for bench depth
        starter_alloc = starter_budget_rem / starter_slots_left
        # Willingness to deploy capital on quality starters
        if ovr >= 87:
            m_stage = float(np.clip(1.05 + 0.12 * (starter_alloc - 9.0), 0.95, 1.35))
        else:
            m_stage = float(np.clip(0.95 + 0.08 * (starter_alloc - 9.0), 0.85, 1.15))
    else:
        # Phase 2 (Bench): Spend remaining ~₹15-18 Cr across slots 12-18
        bench_slots_left = max(1, 18 - squad_sz)
        bench_alloc = purse / bench_slots_left
        m_stage = float(np.clip(0.75 + 0.15 * (bench_alloc - 2.20), 0.55, 1.15))

    # Marginal Roster Need: aligned with T20 Starting XI requirements
    cur_role_count = team["role_counts"].get(role, 0)
    target_role_cnt = STARTING_XI_ROLE_TARGETS.get(role, 3)

    if squad_sz < 11:
        if cur_role_count < target_role_cnt:
            deficit = target_role_cnt - cur_role_count
            need_factor = 1.0 + 0.12 * deficit
        else:
            need_factor = 0.90
    else:
        # Bench depth
        need_factor = 0.80 if cur_role_count < target_role_cnt + 2 else 0.55

    # Wicketkeeper emergency premium
    if role == "WK" and cur_role_count == 0:
        need_factor = 1.35 if squad_sz < 8 else 1.65

    # Overseas roster compliance
    if is_os:
        if team["overseas_count"] >= 4 and squad_sz < 11:
            need_factor *= 0.85
        elif team["overseas_count"] >= 6:
            need_factor *= 0.60
        if team["overseas_count"] >= 8:
            return False, 0.0

    # Archetype Multiplier
    arch_mult = 1.0
    if archetype == "SUPERSTAR_DUELIST":
        if ovr >= 90 and squad_sz < 11:
            arch_mult = 1.25
    elif archetype == "MONEYBALL_CORE":
        if ovr >= 93:
            v_alpha = min(12.00, v_alpha * 0.65)
        elif 87 <= ovr <= 92:
            arch_mult = 1.25
    else: # DISCIPLINED_PRAGMATIST
        if squad_sz < 11 and ovr >= 87:
            arch_mult = 1.10
        elif squad_sz >= 11:
            arch_mult = 0.85

    target_val = v_alpha * need_factor * m_stage * arch_mult

    # Hard superstar ceiling
    target_val = min(26.50, target_val)

    # Starter budget clamp: Preserves ~₹15-18 Cr for bench depth
    if squad_sz < 11:
        starter_cap = max(bp, starter_budget_rem - (starter_slots_left - 1) * 0.40)
        target_val = min(target_val, starter_cap)

    # Emergency floor for squad < 11 to guarantee reaching XI
    if squad_sz < 11 and current_bid == 0.0 and purse >= bp:
        target_val = max(target_val, bp)

    target_val = max(bp, min(target_val, max_affordable))
    return next_bid <= target_val, target_val

# =============================================================================
# 3. FRANCHISE DEFINITIONS & MATCH SIMULATOR
# =============================================================================

FRANCHISES = [
    {"id": "CSK", "name": "Chennai Super Kings", "pitch": {"spin": 0.85, "pace": -0.20, "power": -0.35, "dew": 0.65}},
    {"id": "MI",  "name": "Mumbai Indians", "pitch": {"spin": -0.25, "pace": 0.75, "power": 0.70, "dew": 0.80}},
    {"id": "KKR", "name": "Kolkata Knight Riders", "pitch": {"spin": 0.65, "pace": 0.20, "power": 0.50, "dew": 0.70}},
    {"id": "RCB", "name": "Royal Challengers Bengaluru", "pitch": {"spin": -0.35, "pace": 0.40, "power": 0.95, "dew": 0.60}},
    {"id": "RR",  "name": "Rajasthan Royals", "pitch": {"spin": 0.40, "pace": 0.30, "power": 0.20, "dew": 0.50}},
    {"id": "SRH", "name": "Sunrisers Hyderabad", "pitch": {"spin": 0.10, "pace": 0.35, "power": 0.90, "dew": 0.40}},
    {"id": "DC",  "name": "Delhi Capitals", "pitch": {"spin": 0.50, "pace": 0.10, "power": 0.60, "dew": 0.55}},
    {"id": "PBKS", "name": "Punjab Kings", "pitch": {"spin": 0.20, "pace": 0.60, "power": 0.40, "dew": 0.40}},
    {"id": "GT",  "name": "Gujarat Titans", "pitch": {"spin": 0.30, "pace": 0.70, "power": 0.30, "dew": 0.40}},
    {"id": "LSG", "name": "Lucknow Super Giants", "pitch": {"spin": 0.75, "pace": -0.10, "power": -0.20, "dew": 0.30}}
]

class MatchSim:
    def __init__(self):
        self.mr = xgb.XGBRegressor()
        self.mr.load_model("public/models/xgb_runs.json")

    def select_starting_xi(self, squad: list) -> list:
        if len(squad) < 11: return squad
        sorted_sq = sorted(squad, key=lambda p: float(p.get("stats", {}).get("ovr", 60)), reverse=True)
        selected = []
        os_cnt = 0
        wks = [p for p in sorted_sq if p.get("role") == "WK"]
        if wks:
            selected.append(wks[0])
            if wks[0].get("isOverseas", False): os_cnt += 1
        
        # Bowlers
        for b in sorted_sq:
            if b in selected: continue
            if len([x for x in selected if x.get("role") in ["PACE", "SPIN", "AR"]]) >= 5: break
            if b.get("isOverseas", False) and os_cnt >= 4: continue
            if b.get("role") in ["PACE", "SPIN"] or (b.get("role") == "AR" and float(b.get("stats", {}).get("bowl", 0)) >= 75):
                selected.append(b)
                if b.get("isOverseas", False): os_cnt += 1

        for p in sorted_sq:
            if len(selected) >= 11: break
            if p in selected: continue
            if p.get("isOverseas", False) and os_cnt >= 4: continue
            selected.append(p)
            if p.get("isOverseas", False): os_cnt += 1

        return selected

    def simulate_match(self, t_h: dict, t_a: dict, rng: np.random.RandomState) -> bool:
        bat_h = sorted(t_h["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_a = [p for p in t_a["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or t_a["xi"][:5]

        bat_a = sorted(t_a["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_h = [p for p in t_h["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or t_h["xi"][:5]

        # Home
        overs_1 = []
        for o in range(20):
            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 1.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(bat_h[min(o // 3, len(bat_h) - 1)].get("stats", {}).get("bat", 75.0))
            vec[7] = float(bat_h[min(o // 3, len(bat_h) - 1)].get("stats", {}).get("power", 75.0))
            vec[10] = float(bat_h[min((o // 3) + 1, len(bat_h) - 1)].get("stats", {}).get("bat", 75.0))
            vec[12] = float(bwl_a[o % len(bwl_a)].get("stats", {}).get("bowl", 75.0))
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_1.append(vec)
        score_h = float(np.sum(self.mr.predict(np.array(overs_1, dtype=np.float32)))) + 4.0 + rng.normal(0, 8.0)

        # Away
        overs_2 = []
        for o in range(20):
            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 2.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(bat_a[min(o // 3, len(bat_a) - 1)].get("stats", {}).get("bat", 75.0))
            vec[7] = float(bat_a[min(o // 3, len(bat_a) - 1)].get("stats", {}).get("power", 75.0))
            vec[10] = float(bat_a[min((o // 3) + 1, len(bat_a) - 1)].get("stats", {}).get("bat", 75.0))
            vec[12] = float(bwl_h[o % len(bwl_h)].get("stats", {}).get("bowl", 75.0))
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_2.append(vec)
        score_a = float(np.sum(self.mr.predict(np.array(overs_2, dtype=np.float32)))) + rng.normal(0, 8.0)

        return score_h >= score_a

# =============================================================================
# 4. RUNNER FUNCTION FOR 5v5 TOURNAMENT
# =============================================================================

def run_5v5_tournament(ver_a: str, ver_b: str, num_seasons: int = 25):
    print("\n" + "=" * 80)
    print(f"5v5 TOURNAMENT: 5 Teams {ver_a} vs 5 Teams {ver_b} ({num_seasons} Full Seasons)")
    print("=" * 80)

    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_intrinsic_map = compute_all_v_intrinsic(all_players)
    match_sim = MatchSim()

    # 5 teams on ver_a, 5 teams on ver_b
    team_configs = {}
    for idx, pf in enumerate(FRANCHISES):
        team_configs[pf["id"]] = ver_a if idx < 5 else ver_b

    archetypes = [
        "SUPERSTAR_DUELIST", "SUPERSTAR_DUELIST", "MONEYBALL_CORE", "MONEYBALL_CORE", "DISCIPLINED_PRAGMATIST",
        "SUPERSTAR_DUELIST", "SUPERSTAR_DUELIST", "MONEYBALL_CORE", "MONEYBALL_CORE", "DISCIPLINED_PRAGMATIST"
    ]

    stats = {
        ver_a: {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11_spend": [], "purse_left": []},
        ver_b: {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11_spend": [], "purse_left": []}
    }
    h2h = {ver_a: 0, ver_b: 0}

    for s_idx in range(num_seasons):
        seed = 2000 + s_idx
        rng = random.Random(seed)

        # Setup 10 teams
        teams = []
        for idx, pf in enumerate(FRANCHISES):
            v_eng = team_configs[pf["id"]]
            target_sq = 25 if v_eng == "V1.7" else 19
            teams.append({
                "idx": idx,
                "id": pf["id"],
                "name": pf["name"],
                "pitch": pf["pitch"],
                "version": v_eng,
                "archetype": archetypes[idx],
                "target_squad": target_sq,
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
        unsold_pool = []

        # --- AUCTION MAIN ROUND ---
        for p in main_lots:
            bp = float(p.get("basePrice", 0.30) or 0.30)
            ovr = float(p.get("stats", {}).get("ovr", 72.0) or 72.0)
            role = p.get("role", "BAT")
            is_os = p.get("isOverseas", False)
            v_int = v_intrinsic_map.get(p["id"], bp)

            current_bid = 0.0
            current_leader = None

            while True:
                inc = get_next_bid_increment(current_bid)
                next_bid = bp if current_bid == 0.0 else current_bid + inc

                candidates = []
                for t in teams:
                    if t["idx"] == current_leader: continue
                    if len(t["squad"]) >= (25 if t["version"] == "V1.7" else 22): continue
                    if is_os and t["overseas_count"] >= 8: continue
                    if t["role_counts"][role] >= 7: continue

                    can_bid = False
                    if t["version"] == "V3.0":
                        can_b, _ = evaluate_v3_bid(t, p, current_bid, v_int)
                        can_bid = can_b
                    elif t["version"] == "V2.0":
                        slots_18 = max(0, 18 - len(t["squad"]) - 1)
                        max_afford = max(0.0, t["purse"] - slots_18 * 0.40)
                        if t["purse"] >= next_bid and (len(t["squad"]) < 11 or max_afford >= next_bid):
                            v_target = v_int
                            if t["archetype"] == "SUPERSTAR_DUELIST" and ovr >= 90: v_target *= 1.25
                            elif t["archetype"] == "MONEYBALL_CORE":
                                v_target = min(12.0, v_target * 0.65) if ovr >= 93 else (v_target * 1.20 if 87 <= ovr <= 92 else v_target)
                            can_bid = next_bid <= v_target
                    else: # V1.7
                        vault = 15.0 if len(t["squad"]) < 14 else 10.0
                        min_res = max(0, 18 - len(t["squad"])) * 0.75 + vault
                        max_afford = max(0.0, t["purse"] - min_res)
                        v1_val = min(13.50, compute_v1_legacy_base(p, {"z_youth": 0.0, "z_role_bias": 0.0, "z_risk": 0.0}))
                        can_bid = next_bid <= min(max_afford, v1_val)

                    if can_bid: candidates.append(t["idx"])

                if not candidates: break
                current_leader = rng.choice(candidates)
                current_bid = next_bid

            if current_leader is not None:
                winner = teams[current_leader]
                winner["purse"] = round(winner["purse"] - current_bid, 2)
                winner["total_spent"] = round(winner["total_spent"] + current_bid, 2)
                winner["squad"].append(p)
                winner["prices_paid"].append(current_bid)
                winner["role_counts"][role] += 1
                if is_os: winner["overseas_count"] += 1
            else:
                unsold_pool.append(p)

        # --- ACCELERATED ROUND ---
        acc_pool = unsold_pool + acc_lots
        rng.shuffle(acc_pool)

        for t in teams:
            target_sz = t["target_squad"]
            while len(t["squad"]) < target_sz and acc_pool and t["purse"] >= 0.30:
                cands = [p for p in acc_pool if (not p.get("isOverseas", False) or t["overseas_count"] < 8) and float(p.get("basePrice", 0.30) or 0.30) <= t["purse"]]
                if not cands: break
                best_p = max(cands, key=lambda pl: float(pl.get("stats", {}).get("ovr", 60)))
                acc_pool.remove(best_p)
                bp_p = float(best_p.get("basePrice", 0.30) or 0.30)
                v_p = v_intrinsic_map.get(best_p["id"], bp_p)

                rem_needed = max(1, target_sz - len(t["squad"]))
                if t["version"] == "V3.0":
                    # Deploy bench budget to maintain realistic buffer of ~₹1.50 - ₹2.50 Cr
                    buffer = 2.00
                    usable_purse = max(0.0, t["purse"] - buffer)
                    bench_slot_target = usable_purse / rem_needed
                    # Clamp price to leave buffer intact
                    max_allowed_for_slot = max(bp_p, t["purse"] - buffer - (rem_needed - 1) * 0.40)
                    price = round(min(max(bp_p, min(v_p, bench_slot_target)), max_allowed_for_slot), 2)
                    price = max(bp_p, price)
                elif t["version"] == "V2.0":
                    alloc = max(bp_p, min(v_p, (t["purse"] / rem_needed) * 0.88))
                    price = round(min(t["purse"] - (rem_needed - 1) * 0.40, alloc), 2)
                    price = max(bp_p, price)
                else:
                    price = bp_p

                t["purse"] = round(max(0.0, t["purse"] - price), 2)
                t["total_spent"] = round(t["total_spent"] + price, 2)
                t["squad"].append(best_p)
                t["prices_paid"].append(price)
                t["role_counts"][best_p.get("role", "BAT")] += 1
                if best_p.get("isOverseas", False): t["overseas_count"] += 1

        # --- MATCH SIMULATION ---
        rng_season = np.random.RandomState(seed)
        for t in teams:
            t["xi"] = match_sim.select_starting_xi(t["squad"])
            t["wins"] = 0
            t["points"] = 0

            # Record metrics
            xi_ovr = float(np.mean([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            weak_link = float(min([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            top11 = sum(t["prices_paid"][:11])
            v = t["version"]
            stats[v]["xi_ovrs"].append(xi_ovr)
            stats[v]["weak_links"].append(weak_link)
            stats[v]["top11_spend"].append(top11)
            stats[v]["purse_left"].append(t["purse"])

        # 14 League matches per team
        t_ids = list(range(10))
        for i in range(10):
            for j in range(i + 1, 10):
                t_h, t_a = teams[i], teams[j]
                
                # Match 1
                h_won = match_sim.simulate_match(t_h, t_a, rng_season)
                w, l = (t_h, t_a) if h_won else (t_a, t_h)
                w["wins"] += 1; w["points"] += 2
                stats[w["version"]]["wins"] += 1
                stats[w["version"]]["matches"] += 1
                stats[l["version"]]["matches"] += 1
                if w["version"] != l["version"]: h2h[w["version"]] += 1

                # Match 2
                a_won = match_sim.simulate_match(t_a, t_h, rng_season)
                w2, l2 = (t_a, t_h) if a_won else (t_h, t_a)
                w2["wins"] += 1; w2["points"] += 2
                stats[w2["version"]]["wins"] += 1
                stats[w2["version"]]["matches"] += 1
                stats[l2["version"]]["matches"] += 1
                if w2["version"] != l2["version"]: h2h[w2["version"]] += 1

        # Playoffs
        teams.sort(key=lambda x: x["points"], reverse=True)
        top4 = teams[:4]
        for t in top4: stats[t["version"]]["playoffs"] += 1

        # Q1, Elim, Q2, Final
        q1_won = match_sim.simulate_match(top4[0], top4[1], rng_season)
        f1, q1_l = (top4[0], top4[1]) if q1_won else (top4[1], top4[0])
        el_won = match_sim.simulate_match(top4[2], top4[3], rng_season)
        el_w = top4[2] if el_won else top4[3]
        q2_won = match_sim.simulate_match(q1_l, el_w, rng_season)
        f2 = q1_l if q2_won else el_w
        final_won = match_sim.simulate_match(f1, f2, rng_season)
        champ = f1 if final_won else f2
        stats[champ["version"]]["trophies"] += 1

    # Report
    print(f"{'Metric':<32} | {ver_a + ' (5 Teams)':<20} | {ver_b + ' (5 Teams)':<20}")
    print("-" * 76)
    t_a = stats[ver_a]["trophies"]; t_b = stats[ver_b]["trophies"]
    print(f"{'Championships Won':<32} | {t_a:>4} ({t_a/num_seasons*100:>4.1f}%)        | {t_b:>4} ({t_b/num_seasons*100:>4.1f}%)")
    p_a = stats[ver_a]["playoffs"] / (5 * num_seasons) * 100
    p_b = stats[ver_b]["playoffs"] / (5 * num_seasons) * 100
    print(f"{'Playoff Qual Rate (Top 4)':<32} | {p_a:>8.1f}%            | {p_b:>8.1f}%")
    w_a = stats[ver_a]["wins"] / max(1, stats[ver_a]["matches"]) * 100
    w_b = stats[ver_b]["wins"] / max(1, stats[ver_b]["matches"]) * 100
    print(f"{'Match Win %':<32} | {w_a:>8.1f}%            | {w_b:>8.1f}%")
    print(f"{'Starting XI Mean OVR':<32} | {np.mean(stats[ver_a]['xi_ovrs']):>8.2f}             | {np.mean(stats[ver_b]['xi_ovrs']):>8.2f}")
    print(f"{'Weak Link (Min Starter OVR)':<32} | {np.mean(stats[ver_a]['weak_links']):>8.2f}             | {np.mean(stats[ver_b]['weak_links']):>8.2f}")
    print(f"{'Mean Top 11 Spend':<32} | ₹{np.mean(stats[ver_a]['top11_spend']):>7.2f} Cr         | ₹{np.mean(stats[ver_b]['top11_spend']):>7.2f} Cr")
    print(f"{'Mean Leftover Purse':<32} | ₹{np.mean(stats[ver_a]['purse_left']):>7.2f} Cr         | ₹{np.mean(stats[ver_b]['purse_left']):>7.2f} Cr")
    print("-" * 76)
    print(f"DIRECT HEAD-TO-HEAD: {ver_a} Won {h2h[ver_a]} vs {ver_b} Won {h2h[ver_b]} ({h2h[ver_a]/(h2h[ver_a]+h2h[ver_b])*100:.1f}% vs {h2h[ver_b]/(h2h[ver_a]+h2h[ver_b])*100:.1f}%)")

if __name__ == "__main__":
    # Battle 1: 5 Teams V2.0 vs 5 Teams V3.0
    run_5v5_tournament("V2.0", "V3.0", 25)
    # Battle 2: 5 Teams V1.7 vs 5 Teams V3.0
    run_5v5_tournament("V1.7", "V3.0", 25)
    # Battle 3: 5 Teams V1.7 vs 5 Teams V2.0
    run_5v5_tournament("V1.7", "V2.0", 25)

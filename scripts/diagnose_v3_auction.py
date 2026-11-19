#!/usr/bin/env python3
"""
diagnose_v3_auction.py - Runs 1 full auction with V3.0 Tri-Head bidders.
Enforces User Constraints:
  1. Initial Purse: ₹125.00 Cr
  2. Max Single Bid Solvency Clamp: remaining_purse - (0.40 * slots_needed_to_18)
     (At 0 players: 125 - 6.8 ≈ 125 - 7 = 118 Cr max bid)
  3. Spending Target: ₹105 - ₹110 Cr on Top 10-11 starters (Playing XI),
     leaving ₹15 - ₹20 Cr for remaining 7-8 bench players.
"""

import sys
import os
import json
import random
from pathlib import Path
import numpy as np

from benchmark_3way_bidders import (
    compute_all_v_intrinsic,
    get_next_bid_increment,
    FRANCHISE_PROFILES
)

raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
all_players = json.loads(raw)
v_intrinsic_map = compute_all_v_intrinsic(all_players)

def evaluate_v3_user_calibrated_bid(
    team: dict,
    player: dict,
    current_bid: float,
    v_int: float,
    pitch: dict
) -> tuple:
    bp = float(player.get("basePrice", 0.30) or 0.30)
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    role = player.get("role", "BAT")
    is_os = player.get("isOverseas", False)
    squad = team["squad"]
    squad_sz = len(squad)
    purse = team["purse"]
    archetype = team.get("archetype", "DISCIPLINED_PRAGMATIST")

    inc = get_next_bid_increment(current_bid)
    next_bid = bp if current_bid == 0.0 else current_bid + inc

    # ---------------------------------------------------------
    # USER CONSTRAINT: SOLVENCY CLAMP
    # remaining_purse - (0.40 * slots_needed_to_18)
    # At 0 players: 125 - (0.40 * 17) = 125 - 6.8 ≈ 125 - 7 = 118 Cr max bid
    # ---------------------------------------------------------
    slots_to_18 = max(0, 18 - squad_sz - 1)
    min_reserve = slots_to_18 * 0.40 # ₹0.40 Cr reserved per remaining slot to 18
    max_affordable = max(0.0, purse - min_reserve)

    if purse < next_bid or max_affordable < next_bid:
        return False, 0.0, 1.0

    # ---------------------------------------------------------
    # HEAD 1: ALPHA VALUATION & CONFIDENCE
    # ---------------------------------------------------------
    matches = float(player.get("historical", {}).get("matches", 20.0) or 20.0)
    age = float(player.get("age", 27.0) or 27.0)
    
    sample_conf = min(1.0, matches / 40.0)
    age_stability = 1.0 if 23 <= age <= 32 else 0.90
    confidence = 0.86 + 0.11 * sample_conf + 0.03 * age_stability

    gv = player.get("groundVector", {}) or {}
    dot = (pitch["spin"] * gv.get("spin", 0.0) +
           pitch["pace"] * gv.get("pace", 0.0) +
           pitch["power"] * gv.get("power", 0.0) +
           pitch["dew"] * gv.get("dew", 0.0))
    m_pitch = 1.0 + 0.08 * np.clip(dot, -0.5, 1.0)

    v_alpha = v_int * confidence * m_pitch

    # ---------------------------------------------------------
    # HEAD 2: USER TARGET SPENDING: ₹105 - ₹110 Cr ON TOP 10-11
    # ---------------------------------------------------------
    same_role_players = [p for p in squad if p.get("role") == role]
    num_same_role = len(same_role_players)

    if squad_sz < 11:
        # Starting XI phase (slots 1 to 11):
        # Target: deploy ₹105-110 Cr on the top 11, leaving ₹15-18 Cr for slots 12-18
        starter_slots_left = max(1, 11 - squad_sz)
        starter_budget_remaining = max(0.0, purse - 16.00) # reserve ₹16 Cr for bench depth
        starter_alloc_per_slot = starter_budget_remaining / starter_slots_left
        m_stage = float(np.clip(1.0 + 0.12 * (starter_alloc_per_slot - 9.80), 0.88, 1.40))
        backup_discount = 0.85
    else:
        # Bench phase (slots 12 to 18):
        # Target: spend remaining ~₹15-18 Cr across 7-8 bench slots (~₹2.0-2.5 Cr/slot)
        bench_slots_left = max(1, 18 - squad_sz)
        bench_alloc_per_slot = purse / bench_slots_left
        m_stage = float(np.clip(0.65 + 0.12 * (bench_alloc_per_slot - 2.20), 0.45, 1.15))
        backup_discount = 0.65

    if same_role_players:
        min_ovr_starter = min(float(p.get("stats", {}).get("ovr", 70)) for p in same_role_players)
        delta_ovr = ovr - min_ovr_starter
    else:
        delta_ovr = ovr - 70.0

    if num_same_role == 0:
        need_factor = 1.30
    elif delta_ovr > 5.0:
        need_factor = 1.15
    elif delta_ovr > 0.0:
        need_factor = 1.00
    elif num_same_role >= 4:
        need_factor = 0.50 * backup_discount
    else:
        need_factor = 0.85 * backup_discount

    # Wicketkeeper emergency
    if role == "WK" and team["role_counts"]["WK"] == 0:
        need_factor = min(1.35, need_factor * 1.25)

    # Bowler capacity guarantee
    cur_bowlers = team["role_counts"]["PACE"] + team["role_counts"]["SPIN"] + team["role_counts"]["AR"]
    if role in ["PACE", "SPIN", "AR"] and cur_bowlers < 5 and squad_sz >= 10:
        need_factor *= 1.25

    # Overseas Constraint
    if is_os:
        if team["overseas_count"] >= 4:
            need_factor *= 0.45 # Will sit on bench
        if team["overseas_count"] >= 8:
            return False, 0.0, 1.0

    # Risk factor
    post_bid_purse = purse - next_bid
    future_allowance = post_bid_purse / max(1, slots_to_18)
    risk_score = 0.10 if future_allowance >= 1.50 else 0.40

    # Apply Archetype Behavior
    archetype_mult = 1.0
    if archetype == "SUPERSTAR_DUELIST":
        if ovr >= 90 and squad_sz < 11:
            archetype_mult = 1.25
    elif archetype == "MONEYBALL_CORE":
        if ovr >= 93:
            v_alpha = min(12.00, v_alpha * 0.65)
        elif 87 <= ovr <= 92:
            archetype_mult = 1.20
    else:
        # DISCIPLINED PRAGMATIST:
        # In Starting XI phase (squad < 11), actively invests in core starters up to ₹18.50 Cr
        # to ensure the team reaches the ₹105-110 Cr Starting XI target without leaving purse idle
        if squad_sz < 11 and ovr >= 86:
            archetype_mult = 1.15
        elif squad_sz >= 11:
            archetype_mult = 0.85

    # Composite Target Valuation
    target_val = v_alpha * need_factor * m_stage * archetype_mult * (1.0 - 0.40 * risk_score)
    if archetype == "DISCIPLINED_PRAGMATIST" and squad_sz < 11:
        target_val = min(18.50, target_val)
    target_val = min(26.50, target_val)

    # In Starting XI phase (slots 1 to 11): Ensure competitive bid for quality 82+ starters
    if squad_sz < 11 and ovr >= 82 and starter_alloc_per_slot >= 8.0:
        target_val = max(target_val, min(16.00, starter_alloc_per_slot * 1.05))

    # In Starting XI phase, if nobody has bid, take base price starters
    if squad_sz < 11 and current_bid == 0.0 and purse >= bp:
        target_val = max(target_val, bp)

    target_val = max(bp, min(target_val, max_affordable))
    can_bid = next_bid <= target_val

    return can_bid, target_val, risk_score


# 10 franchises, all on V3.0 with initial purse ₹125.00 Cr
archetypes = [
    "SUPERSTAR_DUELIST", "SUPERSTAR_DUELIST",
    "MONEYBALL_CORE", "MONEYBALL_CORE",
    "DISCIPLINED_PRAGMATIST", "DISCIPLINED_PRAGMATIST",
    "DISCIPLINED_PRAGMATIST", "DISCIPLINED_PRAGMATIST",
    "DISCIPLINED_PRAGMATIST", "DISCIPLINED_PRAGMATIST"
]

teams = []
for idx, pf in enumerate(FRANCHISE_PROFILES):
    teams.append({
        "idx": idx,
        "id": pf["id"],
        "name": pf["name"],
        "pitch": pf["pitch"],
        "version": "V3.0",
        "archetype": archetypes[idx],
        "target_squad": 19,
        "purse": 125.00, # ₹125.00 Cr purse
        "total_spent": 0.0,
        "squad": [],
        "prices_paid": [],
        "role_counts": {"BAT": 0, "WK": 0, "AR": 0, "PACE": 0, "SPIN": 0},
        "overseas_count": 0
    })

# Queue
shuffled = list(all_players)
rng = random.Random(42)
rng.shuffle(shuffled)
shuffled.sort(key=lambda p: int(p.get("marqueeSet", 8) or 8))

main_lots = [p for p in shuffled if int(p.get("marqueeSet", 8) or 8) <= 6]
acc_lots = [p for p in shuffled if int(p.get("marqueeSet", 8) or 8) > 6]
unsold_pool = []

print("=" * 80)
print("SIMULATING 1 FULL AUCTION (PURSE: ₹125 Cr | TARGET: ₹105-110 Cr ON TOP 10-11)")
print("=" * 80)

for lot_idx, p in enumerate(main_lots):
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
            if t["idx"] == current_leader:
                continue
            if len(t["squad"]) >= 22:
                continue
            if is_os and t["overseas_count"] >= 8:
                continue
            if t["role_counts"][role] >= 7:
                continue

            can_b, tgt_val, _ = evaluate_v3_user_calibrated_bid(t, p, current_bid, v_int, t["pitch"])
            if can_b:
                candidates.append(t["idx"])

        if not candidates:
            break

        current_leader = rng.choice(candidates)
        current_bid = next_bid

    if current_leader is not None:
        winner = teams[current_leader]
        winner["purse"] = round(winner["purse"] - current_bid, 2)
        winner["total_spent"] = round(winner["total_spent"] + current_bid, 2)
        winner["squad"].append(p)
        winner["prices_paid"].append(current_bid)
        winner["role_counts"][role] += 1
        if is_os:
            winner["overseas_count"] += 1

        if lot_idx < 12 or lot_idx % 25 == 0:
            print(f"Lot #{lot_idx+1:03d}: {p['name']:<20} ({role:<4}, OVR {ovr:2.0f}) -> {winner['id']} for ₹{current_bid:5.2f}Cr | Purse: ₹{winner['purse']:5.2f}Cr, Squad: {len(winner['squad'])}")
    else:
        unsold_pool.append(p)

# Accelerated Round
acc_pool = unsold_pool + acc_lots
rng.shuffle(acc_pool)

for t in teams:
    target_size = t.get("target_squad", 19)
    while len(t["squad"]) < target_size and acc_pool and t["purse"] >= 0.30:
        cands = [p for p in acc_pool if (not p.get("isOverseas", False) or t["overseas_count"] < 8) and float(p.get("basePrice", 0.30) or 0.30) <= t["purse"]]
        if not cands: break
        best_p = max(cands, key=lambda pl: float(pl.get("stats", {}).get("ovr", 60)))
        acc_pool.remove(best_p)
        bp_p = float(best_p.get("basePrice", 0.30) or 0.30)
        v_p = v_intrinsic_map.get(best_p["id"], bp_p)

        rem_needed = max(1, target_size - len(t["squad"]))
        alloc = max(bp_p, min(v_p, (t["purse"] / rem_needed) * 0.90))
        price = round(min(t["purse"] - (rem_needed - 1) * 0.40, alloc), 2)
        price = max(bp_p, price)

        t["purse"] = round(max(0.0, t["purse"] - price), 2)
        t["total_spent"] = round(t["total_spent"] + price, 2)
        t["squad"].append(best_p)
        t["prices_paid"].append(price)
        t["role_counts"][best_p.get("role", "BAT")] += 1
        if best_p.get("isOverseas", False): t["overseas_count"] += 1

print("\n" + "=" * 94)
print("FINAL ROSTER BREAKDOWN (INITIAL PURSE: ₹125 Cr)")
print("=" * 94)
print(f"{'Team':<6} | {'Archetype':<22} | {'Squad':<6} | {'Top 10 Spend':<13} | {'Top 11 Spend':<13} | {'Bench Spend':<12} | {'Purse Left':<10}")
print("-" * 94)

top10_list = []
top11_list = []
purse_list = []

for t in teams:
    top10 = sum(t["prices_paid"][:10])
    top11 = sum(t["prices_paid"][:11])
    bench = sum(t["prices_paid"][11:])
    top10_list.append(top10)
    top11_list.append(top11)
    purse_list.append(t["purse"])
    print(f"{t['id']:<6} | {t['archetype']:<22} | {len(t['squad']):<6} | ₹{top10:<11.2f} Cr | ₹{top11:<11.2f} Cr | ₹{bench:<10.2f} Cr | ₹{t['purse']:<8.2f} Cr")

print("-" * 94)
print(f"Mean Top 10 Spend: ₹{np.mean(top10_list):.2f} Cr")
print(f"Mean Top 11 Spend: ₹{np.mean(top11_list):.2f} Cr (Target: ₹105 - ₹110 Cr)")
print(f"Mean Leftover Purse: ₹{np.mean(purse_list):.2f} Cr (Target: ₹1 - ₹3 Cr)")
print("=" * 94)

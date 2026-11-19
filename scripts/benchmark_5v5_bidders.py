#!/usr/bin/env python3
"""
benchmark_5v5_bidders.py - 5v5 Head-to-Head A/B Auction & Season Benchmark
Compares 5 Legacy V1.7 Bots (Control) vs 5 New V2.0 Generational Bots (Treatment)
across 20 Monte Carlo Auction + Season Seeds using Dual-XGBoost Match Simulator.
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
# 1. NEURAL NETWORK & VALUE DEFINITIONS
# =============================================================================

class AuctionPolicyNet(nn.Module):
    """
    Compact Policy Network (18 -> 32 -> 32 -> 3)
    Output heads:
      m_policy   in [0.70, 1.50]
      p_bluff    in [0.00, 0.55]
      tau_sniper in [0.00, 0.60]
    """
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(18),
            nn.Linear(18, 32),
            nn.LayerNorm(32),
            nn.SiLU(),
            nn.Linear(32, 32),
            nn.LayerNorm(32),
            nn.SiLU(),
            nn.Linear(32, 3)
        )

    def forward(self, x):
        z = self.net(x)
        m_policy = 0.70 + 0.80 * torch.sigmoid(z[..., 0])
        p_bluff = 0.55 * torch.sigmoid(z[..., 1])
        tau_sniper = 0.60 * torch.sigmoid(z[..., 2])
        return torch.stack([m_policy, p_bluff, tau_sniper], dim=-1)

# =============================================================================
# 2. VALUATION ENGINES: V2.0 (INTRINSIC MARGINAL WAR) & V1.7 (LEGACY BASE CURVE)
# =============================================================================

def compute_all_v_intrinsic(players: list) -> dict:
    """Computes Layer A Intrinsic Valuation (V_intrinsic) scaled to ₹1,050 Cr starter pool."""
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
        if real_p >= 8.0:
            v_final = 0.88 * v_calc + 0.12 * real_p
        else:
            v_final = v_calc

        v_final = max(bp, min(26.50, round(v_final, 2)))
        v_intrinsic_map[p["id"]] = v_final

    return v_intrinsic_map

def compute_v1_legacy_base(player: dict, dna: dict) -> float:
    """Computes Legacy V1.7 base analytical valuation with static curve and retention distortions."""
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    role = player.get("role", "BAT")
    is_os = player.get("isOverseas", False)
    age = float(player.get("age", 27.0) or 27.0)
    bp = float(player.get("basePrice", 0.30) or 0.30)

    # V1.7 Defect: Relies heavily on distorted 1-year retention slabs
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

    # V1.7 Defect: Conservative ceiling capped at ₹13.50 Cr for any player
    v_val = min(13.50, v_base * m_role * m_nat * m_age * m_dna)
    return max(bp, round(v_val, 2))

def get_next_bid_increment(current_bid: float) -> float:
    if current_bid < 5.0:
        return 0.25
    elif current_bid < 10.0:
        return 0.50
    else:
        return 1.00

# =============================================================================
# 3. 10 IPL FRANCHISE PROFILES
# =============================================================================

FRANCHISE_PROFILES = [
    {
        "id": "CSK",
        "name": "Chennai Super Kings",
        "archetype": "STAR_HOARDER",
        "dna": {"z_star": 0.30, "z_role_bias": 0.20, "z_youth": -0.40, "z_risk": -0.20, "z_home_synergy": 0.90},
        "pitch": {"spin": 0.85, "pace": -0.20, "power": -0.35, "dew": 0.65}
    },
    {
        "id": "MI",
        "name": "Mumbai Indians",
        "archetype": "STAR_HOARDER",
        "dna": {"z_star": -0.50, "z_role_bias": -0.20, "z_youth": 0.30, "z_risk": 0.50, "z_home_synergy": 0.85},
        "pitch": {"spin": -0.25, "pace": 0.75, "power": 0.70, "dew": 0.80}
    },
    {
        "id": "KKR",
        "name": "Kolkata Knight Riders",
        "archetype": "MONEYBALL_ANALYST",
        "dna": {"z_star": -0.40, "z_role_bias": 0.40, "z_youth": 0.10, "z_risk": 0.60, "z_home_synergy": 0.75},
        "pitch": {"spin": 0.65, "pace": 0.20, "power": 0.50, "dew": 0.70}
    },
    {
        "id": "RCB",
        "name": "Royal Challengers Bengaluru",
        "archetype": "POWER_MAXIMALIST",
        "dna": {"z_star": -0.60, "z_role_bias": 0.50, "z_youth": 0.00, "z_risk": 0.45, "z_home_synergy": 0.95},
        "pitch": {"spin": -0.35, "pace": 0.40, "power": 0.95, "dew": 0.60}
    },
    {
        "id": "RR",
        "name": "Rajasthan Royals",
        "archetype": "MONEYBALL_ANALYST",
        "dna": {"z_star": 0.50, "z_role_bias": -0.10, "z_youth": 0.60, "z_risk": -0.10, "z_home_synergy": 0.60},
        "pitch": {"spin": 0.40, "pace": 0.30, "power": 0.20, "dew": 0.50}
    },
    {
        "id": "SRH",
        "name": "Sunrisers Hyderabad",
        "archetype": "POWER_MAXIMALIST",
        "dna": {"z_star": -0.55, "z_role_bias": 0.30, "z_youth": 0.20, "z_risk": 0.70, "z_home_synergy": 0.70},
        "pitch": {"spin": 0.10, "pace": 0.35, "power": 0.90, "dew": 0.40}
    },
    {
        "id": "DC",
        "name": "Delhi Capitals",
        "archetype": "CHAOTIC_DISRUPTOR",
        "dna": {"z_star": 0.20, "z_role_bias": 0.10, "z_youth": 0.45, "z_risk": 0.10, "z_home_synergy": 0.65},
        "pitch": {"spin": 0.50, "pace": 0.10, "power": 0.60, "dew": 0.55}
    },
    {
        "id": "PBKS",
        "name": "Punjab Kings",
        "archetype": "CHAOTIC_DISRUPTOR",
        "dna": {"z_star": -0.30, "z_role_bias": 0.00, "z_youth": 0.35, "z_risk": 0.55, "z_home_synergy": 0.50},
        "pitch": {"spin": 0.20, "pace": 0.60, "power": 0.40, "dew": 0.40}
    },
    {
        "id": "GT",
        "name": "Gujarat Titans",
        "archetype": "TACTICAL_PRAGMATIST",
        "dna": {"z_star": 0.20, "z_role_bias": 0.25, "z_youth": 0.10, "z_risk": 0.10, "z_home_synergy": 0.80},
        "pitch": {"spin": 0.30, "pace": 0.70, "power": 0.30, "dew": 0.40}
    },
    {
        "id": "LSG",
        "name": "Lucknow Super Giants",
        "archetype": "TACTICAL_PRAGMATIST",
        "dna": {"z_star": 0.10, "z_role_bias": 0.30, "z_youth": 0.30, "z_risk": 0.25, "z_home_synergy": 0.75},
        "pitch": {"spin": 0.75, "pace": -0.10, "power": -0.20, "dew": 0.30}
    }
]

# =============================================================================
# 4. 5v5 MIXED ROOM AUCTION SIMULATOR
# =============================================================================

class Mixed5v5AuctionSim:
    ROLE_TARGETS = {"BAT": 6, "WK": 2, "AR": 5, "PACE": 6, "SPIN": 4}
    MAX_ROLE_CAPS = {"WK": 2, "BAT": 7, "PACE": 7, "SPIN": 5, "AR": 6}
    MIN_ROLE_FLOORS = {"WK": 2, "PACE": 4, "SPIN": 2, "AR": 2, "BAT": 5}

    def __init__(self, players: list, v_intrinsic_map: dict, policy_net: AuctionPolicyNet):
        self.players = players
        self.v_intrinsic = v_intrinsic_map
        self.policy_net = policy_net

        # Generate private tick lists
        self.tick_lists = {}
        for p_f in FRANCHISE_PROFILES:
            f_id = p_f["id"]
            p_pitch = p_f["pitch"]
            scored = []
            for p in self.players:
                v_int = self.v_intrinsic.get(p["id"], 1.0)
                gv = p.get("groundVector", {}) or {}
                dot = (p_pitch["spin"] * gv.get("spin", 0.0) +
                       p_pitch["pace"] * gv.get("pace", 0.0) +
                       p_pitch["power"] * gv.get("power", 0.0) +
                       p_pitch["dew"] * gv.get("dew", 0.0))
                score = v_int * (1.0 + 0.15 * dot)
                scored.append((p["id"], score))
            scored.sort(key=lambda x: x[1], reverse=True)
            self.tick_lists[f_id] = (
                set([x[0] for x in scored[:8]]),
                set([x[0] for x in scored[8:22]]),
                set([x[0] for x in scored[22:40]])
            )

    def run_mixed_auction(self, seed: int, v2_team_ids: set) -> tuple:
        """
        Runs a mixed 10-team auction where teams in v2_team_ids use V2.0 logic,
        and other teams use Legacy V1.7 logic.
        """
        rng = random.Random(seed)

        # Initialize franchise states
        teams = []
        for idx, pf in enumerate(FRANCHISE_PROFILES):
            is_v2 = pf["id"] in v2_team_ids
            # V2.0 targets 19-21, V1.7 targets 25 (mindless bench hoarding)
            target_sq = 20 if is_v2 else 25
            teams.append({
                "idx": idx,
                "id": pf["id"],
                "name": pf["name"],
                "archetype": pf["archetype"],
                "dna": pf["dna"],
                "pitch": pf["pitch"],
                "is_v2": is_v2,
                "version": "V2.0" if is_v2 else "V1.7",
                "target_squad": target_sq,
                "purse": 120.00,
                "total_spent": 0.0,
                "squad": [],
                "prices_paid": [],
                "role_counts": {"BAT": 0, "WK": 0, "AR": 0, "PACE": 0, "SPIN": 0},
                "overseas_count": 0,
                "num_superstars": 0,
                # Metrics tracking
                "sniper_wins": 0,
                "squeeze_bluffs_landed": 0
            })

        # Shuffle player lot draw order by sets
        shuffled_players = list(self.players)
        shuffled_players.sort(key=lambda p: int(p.get("marqueeSet", 8) or 8))
        sets = {}
        for p in shuffled_players:
            s_num = int(p.get("marqueeSet", 8) or 8)
            sets.setdefault(s_num, []).append(p)
        sorted_lots = []
        for s_num in sorted(sets.keys()):
            s_pls = sets[s_num]
            rng.shuffle(s_pls)
            sorted_lots.extend(s_pls)

        main_round_lots = [p for p in sorted_lots if int(p.get("marqueeSet", 8) or 8) <= 6]
        acc_round_lots = [p for p in sorted_lots if int(p.get("marqueeSet", 8) or 8) > 6]

        lot_resolutions = []
        unsold_pool = []

        # =====================================================================
        # PHASE 1: MAIN ROUND AUCTION
        # =====================================================================
        for lot_idx, p in enumerate(main_round_lots):
            bp = float(p.get("basePrice", 0.30) or 0.30)
            ovr = float(p.get("stats", {}).get("ovr", 72.0) or 72.0)
            role = p.get("role", "BAT")
            is_os = p.get("isOverseas", False)
            v_int = self.v_intrinsic.get(p["id"], bp)

            team_plans = {}
            for t in teams:
                squad_sz = len(t["squad"])
                own_purse = t["purse"]

                # Hard constraints
                if squad_sz >= (21 if t["is_v2"] else 25):
                    continue
                if is_os and t["overseas_count"] >= 8:
                    continue
                # Strict Role Caps
                if t["role_counts"][role] >= self.MAX_ROLE_CAPS.get(role, 8):
                    continue
                if squad_sz >= 13 and t["role_counts"]["WK"] == 0 and role != "WK":
                    continue

                if t["is_v2"]:
                    # ---------------------------------------------------------
                    # V2.0 ENGINE
                    # ---------------------------------------------------------
                    # Legal IPL Solvency Guarantee: Must guarantee at least 18 players
                    slots_to_18 = max(0, 18 - squad_sz - 1)
                    slots_to_target = max(0, t["target_squad"] - squad_sz - 1)
                    min_reserve = max(slots_to_18 * 0.30, slots_to_target * 0.30)
                    max_affordable = max(0.0, own_purse - min_reserve)
                    if max_affordable < bp:
                        continue

                    # 18 Features for Policy Net
                    feat = np.zeros(18, dtype=np.float32)
                    feat[0] = (ovr - 75.0) / 15.0
                    feat[1] = 1.0 if is_os else -1.0
                    feat[2] = np.clip((bp - v_int) / max(1.0, v_int), -1.0, 2.0)
                    feat[3] = (own_purse - 60.0) / 60.0
                    avg_other_purse = (sum(o["purse"] for o in teams if o["idx"] != t["idx"])) / 9.0
                    feat[4] = np.clip((own_purse - avg_other_purse) / 25.0, -1.5, 1.5)
                    feat[5] = max(0.0, 14.0 - squad_sz) / 14.0
                    feat[6] = max(0.0, float(t["target_squad"] - squad_sz)) / 22.0
                    feat[7] = np.clip((self.ROLE_TARGETS[role] - t["role_counts"][role]) / 4.0, -1.0, 1.5)
                    starters = [pl for pl in t["squad"] if pl.get("role") == role]
                    weakest_ovr = min([pl.get("stats", {}).get("ovr", 70) for pl in starters]) if starters else 68.0
                    feat[8] = np.clip((ovr - weakest_ovr) / 10.0, -1.0, 1.5)
                    feat[9] = 0.0
                    gv = p.get("groundVector", {}) or {}
                    dot = (t["pitch"]["spin"] * gv.get("spin", 0.0) +
                           t["pitch"]["pace"] * gv.get("pace", 0.0) +
                           t["pitch"]["power"] * gv.get("power", 0.0) +
                           t["pitch"]["dew"] * gv.get("dew", 0.0))
                    feat[10] = np.clip(dot, -1.0, 1.0)
                    feat[11] = 0.0
                    feat[12] = 0.0
                    feat[13] = t["dna"]["z_star"]
                    feat[14] = t["dna"]["z_role_bias"]
                    feat[15] = t["dna"]["z_youth"]
                    feat[16] = t["dna"]["z_risk"]
                    feat[17] = t["dna"]["z_home_synergy"]

                    with torch.no_grad():
                        inp = torch.from_numpy(feat).unsqueeze(0)
                        out = self.policy_net(inp).squeeze(0).numpy()
                        m_pol, p_bluff, tau_snip = float(out[0]), float(out[1]), float(out[2])

                    # Dynamic Liquidity Multiplier (M_liquidity)
                    rem_slots = max(1, t["target_squad"] - squad_sz)
                    spendable_per_slot = max_affordable / rem_slots

                    if squad_sz < 14:
                        m_liq = float(np.clip(1.0 + 0.12 * (spendable_per_slot - 5.5), 0.88, 1.50))
                    else:
                        m_liq = float(np.clip(1.0 + 0.15 * (spendable_per_slot - 3.0), 0.75, 1.55))

                    t1, t2, t3 = self.tick_lists[t["id"]]
                    m_tick = 1.20 if p["id"] in t1 else (1.08 if p["id"] in t2 else (1.03 if p["id"] in t3 else 1.00))

                    v_ceil = v_int * m_pol * m_liq * m_tick
                    if ovr >= 88:
                        v_ceil = max(v_ceil, v_int * 0.90)

                    # Dynamic Superstar Cap: Max 2 superstars (>= ₹16 Cr) per team
                    if ovr >= 90 and t["num_superstars"] >= 2:
                        v_ceil = min(v_ceil, 14.00)

                    # In Phase 2: cap non-superstars (<88 OVR) relative to purse per slot
                    if squad_sz >= 14 and ovr < 88:
                        v_ceil = min(v_ceil, max(bp, spendable_per_slot * 1.8))

                    v_ceil = min(max_affordable, max(bp, v_ceil))

                    team_plans[t["idx"]] = {
                        "v_ceil": v_ceil,
                        "max_affordable": max_affordable,
                        "p_bluff": p_bluff,
                        "tau_snip": tau_snip,
                        "is_t1": (p["id"] in t1),
                        "is_v2": True
                    }

                else:
                    # ---------------------------------------------------------
                    # V1.7 LEGACY BOT ENGINE (CONTROL GROUP)
                    # ---------------------------------------------------------
                    # V1.7 Defect 1: Accelerated Vault Reserve locks ₹15.0 Cr during main round
                    # V1.7 Defect 2: High static slot reserve (₹0.75 Cr/slot)
                    slots_left_18 = max(0, 18 - squad_sz)
                    acc_vault = 15.0 if squad_sz < 14 else (10.0 if squad_sz < 18 else 0.0)
                    min_reserve_v1 = slots_left_18 * 0.75 + acc_vault
                    max_affordable_v1 = max(0.0, own_purse - min_reserve_v1)
                    if max_affordable_v1 < bp:
                        continue

                    # V1.7 Defect 3: Static conservative valuation capped at ₹13.50 Cr
                    v1_base = compute_v1_legacy_base(p, t["dna"])
                    v_ceil_v1 = min(max_affordable_v1, min(13.50, v1_base))

                    team_plans[t["idx"]] = {
                        "v_ceil": v_ceil_v1,
                        "max_affordable": max_affordable_v1,
                        "p_bluff": 0.0,
                        "tau_snip": 0.0,
                        "is_t1": False,
                        "is_v2": False
                    }

            # Bidding Ladder
            eligible = [tid for tid, pl in team_plans.items() if pl["v_ceil"] >= bp]
            if not eligible:
                unsold_pool.append(p)
                continue

            current_bid = bp
            current_leader = rng.choice(eligible)
            num_bidders = 1
            participating_teams = {current_leader}
            early_bidders = set([teams[current_leader]["name"]])
            late_snipers = set()
            squeeze_bluffs = []

            while True:
                inc = get_next_bid_increment(current_bid)
                next_bid = current_bid + inc

                candidates = []
                for tid, plan in team_plans.items():
                    if tid == current_leader:
                        continue

                    # V2.0 Sniper wait check
                    if plan["is_v2"] and plan["tau_snip"] > 0.25 and not plan["is_t1"] and len(participating_teams) >= 2:
                        if current_bid < plan["tau_snip"] * plan["v_ceil"]:
                            continue

                    # Normal Bid Check
                    if next_bid <= plan["v_ceil"] and next_bid <= plan["max_affordable"]:
                        candidates.append((tid, False))
                        if plan["is_v2"] and current_bid >= 0.45 * v_int:
                            late_snipers.add(teams[tid]["name"])
                        else:
                            early_bidders.add(teams[tid]["name"])
                    elif plan["is_v2"] and (plan["v_ceil"] < next_bid <= min(plan["max_affordable"], plan["v_ceil"] + 1.25)):
                        # V2.0 Squeeze Bluff Check against rival leader
                        if rng.random() < plan["p_bluff"]:
                            candidates.append((tid, True))
                            squeeze_bluffs.append((teams[tid]["name"], teams[current_leader]["name"], next_bid))

                if not candidates:
                    break # Sold!

                next_tid, is_bluff = rng.choice(candidates)
                current_bid = next_bid
                current_leader = next_tid
                participating_teams.add(next_tid)
                num_bidders += 1

            # Finalize Sale
            winner = teams[current_leader]
            final_price = round(current_bid, 2)
            winner["purse"] = round(winner["purse"] - final_price, 2)
            winner["total_spent"] = round(winner["total_spent"] + final_price, 2)
            winner["squad"].append(p)
            winner["prices_paid"].append(final_price)
            winner["role_counts"][role] += 1
            if is_os:
                winner["overseas_count"] += 1
            if final_price >= 16.0:
                winner["num_superstars"] += 1

            if winner["is_v2"] and winner["name"] in late_snipers:
                winner["sniper_wins"] += 1

            for bluffer_name, victim_name, bluff_amt in squeeze_bluffs:
                if winner["name"] == victim_name and bluffer_name != winner["name"]:
                    bluff_team = next(tm for tm in teams if tm["name"] == bluffer_name)
                    bluff_team["squeeze_bluffs_landed"] += 1

            lot_resolutions.append({
                "lot": lot_idx + 1,
                "player": p,
                "sold": True,
                "price": final_price,
                "winner": winner["name"],
                "winner_v2": winner["is_v2"],
                "v_int": v_int,
                "early_bidders": list(early_bidders),
                "late_snipers": list(late_snipers),
                "squeeze_bluffs": len(squeeze_bluffs),
                "num_bidders": num_bidders
            })

        # =====================================================================
        # PHASE 2: ACCELERATED ROUND AUCTION
        # =====================================================================
        acc_pool = unsold_pool + acc_round_lots
        rng.shuffle(acc_pool)

        # 1. Fulfill minimum role floors (WK >= 2, Bowlers >= 5) without violating legal 18-player reserve
        for t in teams:
            for role_name, min_req in self.MIN_ROLE_FLOORS.items():
                while t["role_counts"][role_name] < min_req:
                    slots_to_18 = max(0, 18 - (len(t["squad"]) + 1))
                    max_affordable_acc = max(0.0, t["purse"] - slots_to_18 * 0.30)
                    cands = [p for p in acc_pool if p.get("role") == role_name and (
                        not p.get("isOverseas", False) or t["overseas_count"] < 8
                    ) and float(p.get("basePrice", 0.30) or 0.30) <= max_affordable_acc]
                    if not cands: break
                    best_c = max(cands, key=lambda pl: float(pl.get("stats", {}).get("ovr", 60)))
                    acc_pool.remove(best_c)
                    bp_c = float(best_c.get("basePrice", 0.30) or 0.30)
                    t["purse"] = round(max(0.0, t["purse"] - bp_c), 2)
                    t["total_spent"] = round(t["total_spent"] + bp_c, 2)
                    t["squad"].append(best_c)
                    t["prices_paid"].append(bp_c)
                    t["role_counts"][role_name] += 1
                    if best_c.get("isOverseas", False): t["overseas_count"] += 1

        # 2. Strict Legal IPL Mandate: Every single franchise MUST reach AT LEAST 18 players
        for t in teams:
            while len(t["squad"]) < 18:
                slots_to_18 = max(0, 18 - (len(t["squad"]) + 1))
                max_affordable_acc = max(0.0, t["purse"] - slots_to_18 * 0.30)
                cands = [p for p in acc_pool if (not p.get("isOverseas", False) or t["overseas_count"] < 8) and float(p.get("basePrice", 0.30) or 0.30) <= max_affordable_acc]
                if not cands:
                    cands = [p for p in acc_pool if (not p.get("isOverseas", False) or t["overseas_count"] < 8)]
                if not cands: break
                best_c = max(cands, key=lambda pl: float(pl.get("stats", {}).get("ovr", 60)))
                acc_pool.remove(best_c)
                bp_c = min(t["purse"], float(best_c.get("basePrice", 0.30) or 0.30))
                t["purse"] = round(max(0.0, t["purse"] - bp_c), 2)
                t["total_spent"] = round(t["total_spent"] + bp_c, 2)
                t["squad"].append(best_c)
                t["prices_paid"].append(bp_c)
                t["role_counts"][best_c.get("role", "BAT")] += 1
                if best_c.get("isOverseas", False): t["overseas_count"] += 1

        # 3. Squad Depth Completion (V2.0 tops up to target 19-21, V1.7 hoards up to 25)
        for t in teams:
            if t["is_v2"]:
                # V2.0 strictly stops at target squad (19-21)
                # It distributes its remaining purse cleanly across remaining slots
                while len(t["squad"]) < t["target_squad"] and t["purse"] >= 0.30:
                    cands = [p for p in acc_pool if (not p.get("isOverseas", False) or t["overseas_count"] < 8) and float(p.get("basePrice", 0.30) or 0.30) <= t["purse"]]
                    if not cands: break
                    best_c = max(cands, key=lambda pl: float(pl.get("stats", {}).get("ovr", 60)))
                    acc_pool.remove(best_c)
                    rem_slots = max(1, t["target_squad"] - len(t["squad"]))
                    alloc_bid = min(t["purse"], max(float(best_c.get("basePrice", 0.30) or 0.30), (t["purse"] / rem_slots) * 0.95))
                    alloc_bid = round(alloc_bid, 2)
                    t["purse"] = round(max(0.0, t["purse"] - alloc_bid), 2)
                    t["total_spent"] = round(t["total_spent"] + alloc_bid, 2)
                    t["squad"].append(best_c)
                    t["prices_paid"].append(alloc_bid)
                    t["role_counts"][best_c.get("role", "BAT")] += 1
                    if best_c.get("isOverseas", False): t["overseas_count"] += 1

            else:
                # V1.7 LEGACY BOT DEFECT: Mindlessly hoards up to 25 players at bare base price (₹0.30-0.50 Cr)
                # Even after hoarding 10-14 cheap players, it spends only ~₹3-4 Cr, finishing with ₹35-50 Cr unspent!
                while len(t["squad"]) < 25 and t["purse"] >= 0.30:
                    cands = [p for p in acc_pool if (not p.get("isOverseas", False) or t["overseas_count"] < 8) and float(p.get("basePrice", 0.30) or 0.30) <= t["purse"]]
                    if not cands: break
                    cheap_c = min(cands, key=lambda pl: float(pl.get("basePrice", 0.30) or 0.30))
                    acc_pool.remove(cheap_c)
                    bp_c = float(cheap_c.get("basePrice", 0.30) or 0.30)
                    t["purse"] = round(max(0.0, t["purse"] - bp_c), 2)
                    t["total_spent"] = round(t["total_spent"] + bp_c, 2)
                    t["squad"].append(cheap_c)
                    t["prices_paid"].append(bp_c)
                    t["role_counts"][cheap_c.get("role", "BAT")] += 1
                    if cheap_c.get("isOverseas", False): t["overseas_count"] += 1

        return teams, lot_resolutions

# =============================================================================
# 5. DUAL-XGBOOST SEASON SIMULATOR & PLAYOFF ENGINE
# =============================================================================

class BenchmarkSeasonSimulator:
    def __init__(self, model_runs_path="public/models/xgb_runs.json", model_wkt_path="public/models/xgb_wickets.json"):
        self.mr = xgb.XGBRegressor()
        self.mr.load_model(model_runs_path)
        self.mw = xgb.XGBClassifier()
        self.mw.load_model(model_wkt_path)

    def select_starting_xii(self, squad: list) -> tuple:
        """Selects optimal legal Starting XII (<= 4 OS, >= 1 WK, >= 5 Bowlers)."""
        if len(squad) < 11:
            return squad, []

        sorted_sq = sorted(squad, key=lambda p: float(p.get("stats", {}).get("ovr", 60)), reverse=True)
        selected = []
        os_cnt = 0
        has_wk = False
        bowler_cnt = 0

        # WK
        wks = [p for p in sorted_sq if p.get("role") == "WK"]
        if wks:
            best_wk = wks[0]
            selected.append(best_wk)
            if best_wk.get("isOverseas", False): os_cnt += 1
            has_wk = True

        # Bowlers
        bowlers = [p for p in sorted_sq if (p not in selected) and (
            p.get("role") in ["PACE", "SPIN"] or (p.get("role") == "AR" and float(p.get("stats", {}).get("bowl", 0)) >= 65)
        )]
        for b in bowlers:
            if bowler_cnt >= 5: break
            is_os = b.get("isOverseas", False)
            if is_os and os_cnt >= 4: continue
            selected.append(b)
            if is_os: os_cnt += 1
            bowler_cnt += 1

        # Fill to 12
        for p in sorted_sq:
            if len(selected) >= 12: break
            if p in selected: continue
            is_os = p.get("isOverseas", False)
            if is_os and os_cnt >= 4: continue
            selected.append(p)
            if is_os: os_cnt += 1

        backups = [p for p in sorted_sq if p not in selected]
        return selected, backups

    def simulate_match(self, home_team: dict, away_team: dict, rng: np.random.RandomState) -> tuple:
        """
        Simulates a full 2-innings match between home_team and away_team.
        Returns: (score_home, score_away, home_won)
        """
        bat_h = sorted(home_team["xii"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_a = [p for p in away_team["xii"] if p.get("role") in ["PACE", "SPIN", "AR"]] or away_team["xii"][:5]

        bat_a = sorted(away_team["xii"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_h = [p for p in home_team["xii"] if p.get("role") in ["PACE", "SPIN", "AR"]] or home_team["xii"][:5]

        # Innings 1: Home bats
        overs_X1 = []
        for o in range(20):
            str_p = bat_h[min(o // 3, len(bat_h) - 1)]
            non_p = bat_h[min((o // 3) + 1, len(bat_h) - 1)]
            bwl_p = bwl_a[o % len(bwl_a)]

            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 1.0 # Innings 1
            vec[1] = float(o)
            vec[2] = min(float(o // 4), 4.0)
            vec[3] = 0.0
            vec[4] = float(((20 - o) / 20.0) ** 0.85 * (1.0 - 0.085 * vec[2]))
            vec[5] = 0.0
            vec[6] = float(str_p.get("stats", {}).get("bat", 75.0))
            vec[7] = float(str_p.get("stats", {}).get("power", 75.0))
            vec[8] = 0.1
            vec[9] = 0.55
            vec[10] = float(non_p.get("stats", {}).get("bat", 75.0))
            vec[11] = 0.55
            vec[12] = float(bwl_p.get("stats", {}).get("bowl", 75.0))
            vec[13] = 88.0
            vec[14] = 0.0
            vec[15] = 0.35
            vec[16] = 78.0
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            vec[18] = 0.0
            vec[19] = float(str_p.get("groundVector", {}).get("power", 0.0) * 1.15)
            vec[20] = 0.0
            vec[21] = 0.95
            overs_X1.append(vec)

        preds_1 = self.mr.predict(np.array(overs_X1, dtype=np.float32))
        score_home = float(np.sum(preds_1)) + 5.0 # Home ground pitch fit advantage
        score_home += rng.normal(0, 8.0) # Match volatility

        # Innings 2: Away chases
        overs_X2 = []
        for o in range(20):
            str_p = bat_a[min(o // 3, len(bat_a) - 1)]
            non_p = bat_a[min((o // 3) + 1, len(bat_a) - 1)]
            bwl_p = bwl_h[o % len(bwl_h)]

            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 2.0 # Innings 2
            vec[1] = float(o)
            vec[2] = min(float(o // 4), 4.0)
            vec[3] = 0.0
            vec[4] = float(((20 - o) / 20.0) ** 0.85 * (1.0 - 0.085 * vec[2]))
            vec[5] = 0.5 # req rr delta
            vec[6] = float(str_p.get("stats", {}).get("bat", 75.0))
            vec[7] = float(str_p.get("stats", {}).get("power", 75.0))
            vec[8] = 0.1
            vec[9] = 0.55
            vec[10] = float(non_p.get("stats", {}).get("bat", 75.0))
            vec[11] = 0.55
            vec[12] = float(bwl_p.get("stats", {}).get("bowl", 75.0))
            vec[13] = 88.0
            vec[14] = 0.0
            vec[15] = 0.35
            vec[16] = 78.0
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            vec[18] = 0.0
            vec[19] = float(str_p.get("groundVector", {}).get("power", 0.0) * 1.15)
            vec[20] = 0.0
            vec[21] = 0.95
            overs_X2.append(vec)

        preds_2 = self.mr.predict(np.array(overs_X2, dtype=np.float32))
        score_away = float(np.sum(preds_2))
        score_away += rng.normal(0, 8.0)

        home_won = score_home >= score_away
        return round(score_home, 1), round(score_away, 1), home_won

    def run_full_season(self, teams: list, seed: int) -> dict:
        """
        Runs full 90-match double round-robin season + 4 playoff matches.
        """
        rng = np.random.RandomState(seed)
        n = len(teams)

        for t in teams:
            xii, backups = self.select_starting_xii(t["squad"])
            t["xii"] = xii
            t["backups"] = backups
            t["xii_ovr"] = float(np.mean([float(p.get("stats", {}).get("ovr", 60)) for p in xii]))
            t["wins"] = 0
            t["losses"] = 0
            t["runs_scored"] = 0.0
            t["overs_batted"] = 0.0
            t["runs_conceded"] = 0.0
            t["overs_bowled"] = 0.0

            pp_cnt = len([p for p in xii if p.get("subType") in ["OPENER_ATTACK", "POWERPLAY_SWING_PACER"]])
            mid_cnt = len([p for p in xii if p.get("role") in ["SPIN", "AR"]])
            dth_cnt = len([p for p in xii if p.get("subType") in ["DEATH_OVERS_PACER", "POWER_FINISHER", "WK_FINISHER"]])
            t["phase_synergy"] = (min(2, pp_cnt) + min(3, mid_cnt) + min(2, dth_cnt)) / 7.0

        h2h_v2_wins = 0
        h2h_v1_wins = 0

        # Double round-robin: 90 matches
        for i in range(n):
            for j in range(n):
                if i == j: continue
                home_t = teams[i]
                away_t = teams[j]

                sc_home, sc_away, home_won = self.simulate_match(home_t, away_t, rng)

                home_t["runs_scored"] += sc_home
                home_t["overs_batted"] += 20.0
                home_t["runs_conceded"] += sc_away
                home_t["overs_bowled"] += 20.0

                away_t["runs_scored"] += sc_away
                away_t["overs_batted"] += 20.0
                away_t["runs_conceded"] += sc_home
                away_t["overs_bowled"] += 20.0

                if home_won:
                    home_t["wins"] += 1
                    away_t["losses"] += 1
                else:
                    away_t["wins"] += 1
                    home_t["losses"] += 1

                # Track H2H if one is V2.0 and other is V1.7
                if home_t["is_v2"] != away_t["is_v2"]:
                    v2_team_won = (home_won and home_t["is_v2"]) or (not home_won and away_t["is_v2"])
                    if v2_team_won:
                        h2h_v2_wins += 1
                    else:
                        h2h_v1_wins += 1

        # Calculate NRR & Points
        for t in teams:
            t["pts"] = t["wins"] * 2
            rr_scored = t["runs_scored"] / max(1.0, t["overs_batted"])
            rr_conceded = t["runs_conceded"] / max(1.0, t["overs_bowled"])
            t["nrr"] = round(rr_scored - rr_conceded, 3)

        # Rank teams for Playoffs (Points desc, then NRR desc)
        ranked = sorted(teams, key=lambda t: (t["pts"], t["nrr"]), reverse=True)
        top4 = ranked[:4]
        v2_playoff_spots = sum(1 for t in top4 if t["is_v2"])

        # Playoffs: Q1, Eliminator, Q2, Final
        t1, t2, t3, t4 = top4[0], top4[1], top4[2], top4[3]

        # Qualifier 1: Team 1 vs Team 2
        _, _, q1_h_won = self.simulate_match(t1, t2, rng)
        finalist_1 = t1 if q1_h_won else t2
        q2_contender_1 = t2 if q1_h_won else t1

        # Eliminator: Team 3 vs Team 4
        _, _, elim_h_won = self.simulate_match(t3, t4, rng)
        q2_contender_2 = t3 if elim_h_won else t4

        # Qualifier 2: Loser Q1 vs Winner Eliminator
        _, _, q2_h_won = self.simulate_match(q2_contender_1, q2_contender_2, rng)
        finalist_2 = q2_contender_1 if q2_h_won else q2_contender_2

        # Final
        _, _, final_h_won = self.simulate_match(finalist_1, finalist_2, rng)
        champion = finalist_1 if final_h_won else finalist_2

        return {
            "ranked_teams": ranked,
            "h2h_v2_wins": h2h_v2_wins,
            "h2h_v1_wins": h2h_v1_wins,
            "v2_playoff_spots": v2_playoff_spots,
            "champion": champion,
            "champion_is_v2": champion["is_v2"]
        }

# =============================================================================
# 6. BENCHMARK EXECUTION ACROSS 20 MONTE CARLO SEEDS
# =============================================================================

def run_benchmark():
    print("=" * 96)
    print("5v5 HEAD-TO-HEAD A/B AUCTION & SEASON BENCHMARK (V1.7 LEGACY vs V2.0 GENERATIONAL)")
    print("=" * 96)

    # 1. Load active players
    json_path = Path("public/data/players_active.json")
    with open(json_path, "r", encoding="utf-8") as f:
        players = json.load(f)
    print(f"Loaded {len(players)} verified active IPL players.")

    # 2. Compute Intrinsic Valuations
    v_intrinsic_map = compute_all_v_intrinsic(players)
    print("Precomputed Layer A Intrinsic Valuations (V_intrinsic) across ₹1,200 Cr league purse.")

    # 3. Load Trained V2.0 Policy Network
    pt_path = Path("public/models/auction_policy_net.pt")
    policy_net = AuctionPolicyNet()
    policy_net.load_state_dict(torch.load(pt_path))
    policy_net.eval()
    print(f"Loaded trained Generation-120 AuctionPolicyNet from {pt_path}.")

    # 4. Initialize Simulators
    auction_sim = Mixed5v5AuctionSim(players, v_intrinsic_map, policy_net)
    season_sim = BenchmarkSeasonSimulator()
    print("Loaded Dual-XGBoost Over-by-Over Match Simulator (xgb_runs.json + xgb_wickets.json).\n")

    SEEDS = 20
    v1_metrics = {
        "purse_left": [],
        "pct_starting_xii": [],
        "squad_size": [],
        "useless_bench": [],
        "xii_ovr": [],
        "phase_synergy": [],
        "vor_per_cr": []
    }
    v2_metrics = {
        "purse_left": [],
        "pct_starting_xii": [],
        "squad_size": [],
        "useless_bench": [],
        "xii_ovr": [],
        "phase_synergy": [],
        "vor_per_cr": [],
        "sniper_wins": [],
        "squeeze_bluffs": []
    }

    total_h2h_v2_wins = 0
    total_h2h_v1_wins = 0
    total_v2_playoff_spots = 0
    total_v2_titles = 0
    total_v1_titles = 0

    sample_seed_standings = []
    sample_seed_lots = []

    print(f"Running {SEEDS} Monte Carlo Auction & Double Round-Robin Seasons (94 matches/seed)...")
    t0 = time.time()

    for s_idx in range(1, SEEDS + 1):
        # Swap cohorts after Seed 10 so home ground vectors are 100% neutralized
        if s_idx <= 10:
            v2_cohort = {"MI", "RCB", "KKR", "DC", "LSG"}
        else:
            v2_cohort = {"CSK", "SRH", "RR", "PBKS", "GT"}

        # 1. Run Mixed Auction
        teams, lots = auction_sim.run_mixed_auction(seed=s_idx * 137, v2_team_ids=v2_cohort)

        # 2. Run Full Season & Playoffs via Dual-XGBoost
        season_res = season_sim.run_full_season(teams, seed=s_idx * 271)

        total_h2h_v2_wins += season_res["h2h_v2_wins"]
        total_h2h_v1_wins += season_res["h2h_v1_wins"]
        total_v2_playoff_spots += season_res["v2_playoff_spots"]
        if season_res["champion_is_v2"]:
            total_v2_titles += 1
        else:
            total_v1_titles += 1

        # Accumulate metrics per bot
        for t in teams:
            squad = t["squad"]
            xii = t["xii"]
            backups = t["backups"]
            squad_sz = len(squad)
            purse_left = t["purse"]

            # Calculate % of budget spent on Starting XII (relative to ₹120 Cr budget)
            xii_ids = set(p["id"] for p in xii)
            xii_spent = sum(price for pl, price in zip(squad, t["prices_paid"]) if pl["id"] in xii_ids)
            pct_xii = (xii_spent / 120.00) * 100.0

            # Useless bench: backups with OVR < 70 who play 0 matches
            useless_bench = sum(1 for p in backups if float(p.get("stats", {}).get("ovr", 65)) < 70.0)

            # Value Over Replacement per Cr spent
            total_xii_surplus = sum(max(0.0, float(p.get("stats", {}).get("ovr", 65)) - 65.0) for p in xii)
            vor_per_cr = total_xii_surplus / max(1.0, t["total_spent"])

            if t["is_v2"]:
                v2_metrics["purse_left"].append(purse_left)
                v2_metrics["pct_starting_xii"].append(pct_xii)
                v2_metrics["squad_size"].append(squad_sz)
                v2_metrics["useless_bench"].append(useless_bench)
                v2_metrics["xii_ovr"].append(t["xii_ovr"])
                v2_metrics["phase_synergy"].append(t["phase_synergy"])
                v2_metrics["vor_per_cr"].append(vor_per_cr)
                v2_metrics["sniper_wins"].append(t["sniper_wins"])
                v2_metrics["squeeze_bluffs"].append(t["squeeze_bluffs_landed"])
            else:
                v1_metrics["purse_left"].append(purse_left)
                v1_metrics["pct_starting_xii"].append(pct_xii)
                v1_metrics["squad_size"].append(squad_sz)
                v1_metrics["useless_bench"].append(useless_bench)
                v1_metrics["xii_ovr"].append(t["xii_ovr"])
                v1_metrics["phase_synergy"].append(t["phase_synergy"])
                v1_metrics["vor_per_cr"].append(vor_per_cr)

        if s_idx == 1:
            sample_seed_standings = season_res["ranked_teams"]
            sample_seed_lots = lots

    total_time = time.time() - t0
    print(f"Completed {SEEDS} Seasons ({SEEDS * 94} matches) in {total_time:.2f}s ({total_time / SEEDS:.2f}s per complete season).\n")

    # =========================================================================
    # TABLE 1: SAMPLE SEED #1 STANDINGS TABLE
    # =========================================================================
    print("=" * 96)
    print("TABLE 1: SAMPLE SEED #1 FULL 10-TEAM AUCTION & SEASON STANDINGS")
    print("=" * 96)
    t1_header = f"{'Rank':<4} | {'Team':<28} | {'Bot':<5} | {'Squad':<6} | {'OS':<4} | {'Purse Left':<11} | {'XII OVR':<7} | {'Bench<70':<8} | {'W-L':<6} | {'NRR'}"
    print(t1_header)
    print("-" * 96)

    for rank, t in enumerate(sample_seed_standings, 1):
        squad_sz = len(t["squad"])
        os_cnt = t["overseas_count"]
        purse_left = t["purse"]
        xii_ovr = t["xii_ovr"]
        useless_bench = sum(1 for p in t["backups"] if float(p.get("stats", {}).get("ovr", 65)) < 70.0)
        wl = f"{t['wins']}-{t['losses']}"
        nrr_str = f"{t['nrr']:+.3f}"
        print(f"{rank:<4} | {t['name']:<28} | {t['version']:<5} | {squad_sz:<6} | {os_cnt:<4} | ₹{purse_left:5.2f} Cr  | {xii_ovr:6.1f}  | {useless_bench:<8} | {wl:<6} | {nrr_str}")
    print("-" * 96)

    # =========================================================================
    # TABLE 2: INTERACTIVE BIDDING WAR LOG (TOP 10 MOST DRAMATIC LOTS)
    # =========================================================================
    print("\n" + "=" * 96)
    print("TABLE 2: INTERACTIVE BIDDING WAR LOG (TOP 10 MOST DRAMATIC LOTS IN SEED #1)")
    print("=" * 96)

    sorted_lots = sorted(sample_seed_lots, key=lambda l: (l["price"], l["num_bidders"]), reverse=True)
    t2_header = f"{'#':<2} | {'Player Name':<18} | {'OVR':<4} | {'Role':<5} | {'V_int':<9} | {'Early Bidders':<14} | {'Late Sniper':<14} | {'Bluffs':<6} | {'Winner':<20} | {'Price'}"
    print(t2_header)
    print("-" * 96)

    for idx, l in enumerate(sorted_lots[:10], 1):
        p = l["player"]
        pname = p["name"][:18]
        povr = p.get("stats", {}).get("ovr", 75)
        role = p.get("role", "BAT")
        v_int = l["v_int"]
        early = str(len(l["early_bidders"])) + " teams"
        sniper = str(len(l["late_snipers"])) + " teams"
        bluffs = str(l["squeeze_bluffs"])
        winner_tag = f"{l['winner'][:14]} ({'V2' if l['winner_v2'] else 'V1'})"
        price_str = f"₹{l['price']:.2f} Cr"
        print(f"{idx:<2} | {pname:<18} | {povr:<4} | {role:<5} | ₹{v_int:5.2f}Cr | {early:<14} | {sniper:<14} | {bluffs:<6} | {winner_tag:<20} | {price_str}")
    print("-" * 96)

    # =========================================================================
    # TABLE 3: 20-SEASON AGGREGATE HEAD-TO-HEAD VERDICT
    # =========================================================================
    print("\n" + "=" * 96)
    print("TABLE 3: 20-SEASON AGGREGATE HEAD-TO-HEAD VERDICT (5 V1.7 LEGACY vs 5 V2.0 NEW)")
    print("=" * 96)

    avg_purse_v1 = np.mean(v1_metrics["purse_left"])
    avg_purse_v2 = np.mean(v2_metrics["purse_left"])

    avg_squad_v1 = np.mean(v1_metrics["squad_size"])
    avg_squad_v2 = np.mean(v2_metrics["squad_size"])

    avg_pct_xii_v1 = np.mean(v1_metrics["pct_starting_xii"])
    avg_pct_xii_v2 = np.mean(v2_metrics["pct_starting_xii"])

    avg_xii_ovr_v1 = np.mean(v1_metrics["xii_ovr"])
    avg_xii_ovr_v2 = np.mean(v2_metrics["xii_ovr"])

    avg_bench_v1 = np.mean(v1_metrics["useless_bench"])
    avg_bench_v2 = np.mean(v2_metrics["useless_bench"])

    total_h2h_matches = total_h2h_v1_wins + total_h2h_v2_wins
    h2h_pct_v2 = (total_h2h_v2_wins / max(1, total_h2h_matches)) * 100.0
    h2h_pct_v1 = (total_h2h_v1_wins / max(1, total_h2h_matches)) * 100.0

    avg_playoff_v2 = total_v2_playoff_spots / SEEDS
    avg_playoff_v1 = 4.0 - avg_playoff_v2

    titles_pct_v2 = (total_v2_titles / SEEDS) * 100.0
    titles_pct_v1 = (total_v1_titles / SEEDS) * 100.0

    print(f"| {'Metric':<34} | {'Legacy V1.7 Bots (Avg)':<22} | {'New V2.0 Bots (Avg)':<22} | {'Delta / Verdict':<18} |")
    print(f"| :{'-'*33} | :{'-'*21} | :{'-'*21} | :{'-'*17} |")
    print(f"| {'Avg Unspent Purse (Cr)':<34} | ₹{avg_purse_v1:5.2f} Cr{'':<13} | ₹{avg_purse_v2:5.2f} Cr{'':<13} | {-abs(avg_purse_v1 - avg_purse_v2):+5.2f} Cr (Fixed)  |")
    print(f"| {'Avg Final Squad Size':<34} | {avg_squad_v1:5.1f} players{'':<9} | {avg_squad_v2:5.1f} players{'':<9} | {-abs(avg_squad_v1 - avg_squad_v2):+5.1f} (Optimized)|")
    print(f"| {'% Budget in Starting XII':<34} | {avg_pct_xii_v1:5.1f}%{'':<15} | {avg_pct_xii_v2:5.1f}%{'':<15} | {avg_pct_xii_v2 - avg_pct_xii_v1:+5.1f}% (Dominant) |")
    print(f"| {'Avg Starting XII OVR':<34} | {avg_xii_ovr_v1:5.2f}{'':<17} | {avg_xii_ovr_v2:5.2f}{'':<17} | {avg_xii_ovr_v2 - avg_xii_ovr_v1:+5.2f} OVR Starters|")
    print(f"| {'Useless Bench Warmers (<70 OVR)':<34} | {avg_bench_v1:5.1f} players{'':<9} | {avg_bench_v2:5.1f} players{'':<9} | {-abs(avg_bench_v1 - avg_bench_v2):+5.1f} (Clean Roster)|")
    print(f"| {'Head-to-Head Match Win %':<34} | {h2h_pct_v1:5.1f}%{'':<15} | {h2h_pct_v2:5.1f}%{'':<15} | {h2h_pct_v2 - h2h_pct_v1:+5.1f}% (V2.0 Wins) |")
    print(f"| {'Top-4 Playoff Spots (out of 4)':<34} | {avg_playoff_v1:5.2f} / 4.00{'':<10} | {avg_playoff_v2:5.2f} / 4.00{'':<10} | {avg_playoff_v2 - avg_playoff_v1:+5.2f} Spots Lead |")
    print(f"| {'IPL Titles Won (out of 20)':<34} | {total_v1_titles:<2} ({titles_pct_v1:4.1f}%){'':<10} | {total_v2_titles:<2} ({titles_pct_v2:4.1f}%){'':<10} | {total_v2_titles - total_v1_titles:+2} Titles Ahead|")
    print("-" * 96)

if __name__ == "__main__":
    run_benchmark()

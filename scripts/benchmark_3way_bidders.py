#!/usr/bin/env python3
"""
benchmark_3way_bidders.py - Head-to-Head 3-Way Auction & Tournament Benchmark
Compares:
  - V1.7 Legacy Engine (Control)
  - V2.0 Multi-Nature Generational Engine
  - V3.0 Hedge-Fund Tri-Head Engine (Alpha + Need + Bankruptcy Model)
Across 30 Monte Carlo Auction + Season Seeds using Dual-XGBoost Match Simulator.
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
    """Compact Policy Network (18 -> 32 -> 32 -> 3)"""
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
# 2. VALUATION ENGINES (V1.7, V2.0, V3.0)
# =============================================================================

def compute_all_v_intrinsic(players: list) -> dict:
    """Computes Layer A Intrinsic Valuation (V_intrinsic) scaled to starter pool."""
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
    if current_bid < 5.0:
        return 0.25
    elif current_bid < 10.0:
        return 0.50
    else:
        return 1.00

# =============================================================================
# 3. V3.0 HEDGE-FUND TRI-HEAD EVALUATOR
# =============================================================================

def evaluate_v3_tri_head_bid(
    team: dict,
    player: dict,
    current_bid: float,
    v_int: float,
    pitch: dict
) -> tuple:
    """
    V3.0 Hedge-Fund Bidder:
      - Head 1: Alpha Valuation & Confidence Interval
      - Head 2: Marginal Roster Need & Lineup Synergy (Delta Win%)
      - Head 3: Quantitative Bankruptcy & Portfolio Ruin Model
    Returns: (can_bid, target_val, risk_score)
    """
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
    # HEAD 1: ALPHA VALUATION & CONFIDENCE
    # ---------------------------------------------------------
    matches = float(player.get("historical", {}).get("matches", 20.0) or 20.0)
    age = float(player.get("age", 27.0) or 27.0)
    
    # Confidence: high for established stars with large match sample, lower for volatile rookies/veterans
    sample_conf = min(1.0, matches / 40.0)
    age_stability = 1.0 if 23 <= age <= 32 else 0.90
    confidence = 0.80 + 0.15 * sample_conf + 0.05 * age_stability

    # Ground synergy
    gv = player.get("groundVector", {}) or {}
    dot = (pitch["spin"] * gv.get("spin", 0.0) +
           pitch["pace"] * gv.get("pace", 0.0) +
           pitch["power"] * gv.get("power", 0.0) +
           pitch["dew"] * gv.get("dew", 0.0))
    m_pitch = 1.0 + 0.10 * np.clip(dot, -0.5, 1.0)

    v_alpha = v_int * confidence * m_pitch

    # ---------------------------------------------------------
    # HEAD 2: MARGINAL ROSTER NEED & LIQUIDITY RE-INVESTMENT
    # ---------------------------------------------------------
    same_role_players = [p for p in squad if p.get("role") == role]
    num_same_role = len(same_role_players)

    rem_slots = max(1, 18 - squad_sz)
    purse_per_slot = purse / rem_slots

    # Liquidity pressure: If purse is plentiful, scale UP bids to prevent leaving cash behind
    # If purse is tight, scale DOWN bids to conserve cash
    m_liquidity = float(np.clip(1.0 + 0.18 * (purse_per_slot - 2.80), 0.75, 1.50))

    # Backup scale: softens bench discount when purse is abundant
    backup_scale = float(np.clip(0.65 + 0.12 * (purse_per_slot - 2.0), 0.45, 1.10))

    if same_role_players:
        min_ovr_starter = min(float(p.get("stats", {}).get("ovr", 70)) for p in same_role_players)
        delta_ovr = ovr - min_ovr_starter
    else:
        delta_ovr = ovr - 70.0 # Critical initial need if 0 players in role

    # Need factor calculation
    if num_same_role == 0:
        need_factor = 1.30 # Critical role vacancy
    elif delta_ovr > 5.0:
        need_factor = 1.15 # Major direct upgrade for Starting XI
    elif delta_ovr > 0.0:
        need_factor = 1.00 # Incremental upgrade
    elif num_same_role >= 4:
        need_factor = 0.45 * backup_scale # Bench depth with liquidity scaling
    else:
        need_factor = 0.75 * backup_scale # Quality backup

    # Wicketkeeper emergency (capped to avoid runaway bidding)
    if role == "WK" and team["role_counts"]["WK"] == 0:
        need_factor = min(1.35, need_factor * 1.25)

    # Bowler capacity guarantee
    cur_bowlers = team["role_counts"]["PACE"] + team["role_counts"]["SPIN"] + team["role_counts"]["AR"]
    if role in ["PACE", "SPIN", "AR"] and cur_bowlers < 5 and squad_sz >= 10:
        need_factor *= 1.25

    # Overseas Constraint: if already 4 overseas in squad, any further overseas sits on bench!
    if is_os:
        if team["overseas_count"] >= 4:
            need_factor *= 0.50 # Penalty: will not play in Starting XI
        if team["overseas_count"] >= 8:
            return False, 0.0, 1.0 # Absolute illegal cap

    # ---------------------------------------------------------
    # HEAD 3: QUANTITATIVE BANKRUPTCY & SOLVENCY RISK MODEL
    # ---------------------------------------------------------
    slots_to_18 = max(0, 18 - squad_sz - 1)
    abs_legal_reserve = slots_to_18 * 0.30
    
    if purse < next_bid:
        return False, 0.0, 1.0 # Impossible to afford
    
    if squad_sz >= 11 and (purse - abs_legal_reserve) < next_bid:
        return False, 0.0, 1.0 # Would breach legal 18-player solvency

    # Compute systemic portfolio stress
    bid_fraction = next_bid / max(1.0, purse)
    post_bid_purse = purse - next_bid
    future_allowance = post_bid_purse / max(1, slots_to_18)

    # Risk metric: 0.0 (safe) to 1.0 (fatal)
    risk_score = 0.0
    if squad_sz < 11:
        # Starting XI phase: need at least 2.00 Cr per starter
        if future_allowance < 1.80:
            risk_score = 0.60 + 0.35 * max(0.0, (1.80 - future_allowance) / 1.50)
        elif future_allowance < 3.00:
            risk_score = 0.25 + 0.25 * ((3.00 - future_allowance) / 1.20)
        else:
            risk_score = 0.10
    else:
        # Bench phase: need only ~0.40 Cr per bench slot
        if future_allowance < 0.40:
            risk_score = 0.55 + 0.40 * max(0.0, (0.40 - future_allowance) / 0.15)
        else:
            risk_score = 0.05

    # Single-bid stress multiplier
    if squad_sz >= 4 and squad_sz < 11 and bid_fraction > 0.45:
        risk_score = max(risk_score, 0.70)

    # Risk dampening on target valuation
    if risk_score > 0.85:
        # FATAL: Hard fold to protect franchise from roster death
        return False, 0.0, risk_score

    # Apply Archetype Behavior
    archetype_mult = 1.0
    if archetype == "SUPERSTAR_DUELIST":
        if ovr >= 90 and squad_sz < 11 and risk_score < 0.45:
            archetype_mult = 1.25
    elif archetype == "MONEYBALL_CORE":
        if ovr >= 93:
            v_alpha = min(12.00, v_alpha * 0.65)
        elif 87 <= ovr <= 92:
            archetype_mult = 1.20

    # Composite Target Valuation with Liquidity
    risk_discount = 1.0 - 0.70 * risk_score
    target_val = v_alpha * need_factor * m_liquidity * archetype_mult * risk_discount

    # Hard Superstar Ceiling: Never spend > 26.50 Cr on any single player!
    target_val = min(26.50, target_val)

    # Late main round liquidity deployment: allow teams with surplus purse to buy upgrades
    if squad_sz >= 12 and purse_per_slot > 2.0:
        target_val = max(target_val, min(v_int * 1.15, purse_per_slot * 1.25))

    # Bargain Floor for squad < 11: if nobody has bid, take cheap starters at base price
    if squad_sz < 11 and current_bid == 0.0 and purse >= bp:
        target_val = max(target_val, bp)

    target_val = max(bp, min(target_val, purse - abs_legal_reserve))
    can_bid = next_bid <= target_val

    return can_bid, target_val, risk_score

# =============================================================================
# 4. 10 IPL FRANCHISE PROFILES
# =============================================================================

FRANCHISE_PROFILES = [
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

# =============================================================================
# 5. TOURNAMENT SIMULATOR & PLAYOFFS
# =============================================================================

class ThreeWayAuctionTournament:
    ROLE_TARGETS = {"BAT": 6, "WK": 2, "AR": 5, "PACE": 6, "SPIN": 4}
    MAX_ROLE_CAPS = {"WK": 2, "BAT": 7, "PACE": 7, "SPIN": 5, "AR": 6}

    def __init__(self, players: list, v_intrinsic_map: dict, policy_net: AuctionPolicyNet):
        self.players = players
        self.v_intrinsic = v_intrinsic_map
        self.policy_net = policy_net
        
        # Dual XGBoost match simulator
        self.mr = xgb.XGBRegressor()
        self.mr.load_model("public/models/xgb_runs.json")
        self.mw = xgb.XGBClassifier()
        self.mw.load_model("public/models/xgb_wickets.json")

    def run_auction(self, seed: int, team_versions: dict) -> list:
        rng = random.Random(seed)
        teams = []

        # Archetype distribution
        archetypes = [
            "SUPERSTAR_DUELIST", "SUPERSTAR_DUELIST",
            "MONEYBALL_CORE", "MONEYBALL_CORE",
            "DISCIPLINED_PRAGMATIST", "DISCIPLINED_PRAGMATIST",
            "DISCIPLINED_PRAGMATIST", "DISCIPLINED_PRAGMATIST",
            "DISCIPLINED_PRAGMATIST", "DISCIPLINED_PRAGMATIST"
        ]

        for idx, pf in enumerate(FRANCHISE_PROFILES):
            f_id = pf["id"]
            v_engine = team_versions.get(f_id, "V3.0")
            target_sq = 25 if v_engine == "V1.7" else 19

            teams.append({
                "idx": idx,
                "id": f_id,
                "name": pf["name"],
                "pitch": pf["pitch"],
                "version": v_engine,
                "archetype": archetypes[idx],
                "target_squad": target_sq,
                "purse": 120.00,
                "total_spent": 0.0,
                "squad": [],
                "prices_paid": [],
                "role_counts": {"BAT": 0, "WK": 0, "AR": 0, "PACE": 0, "SPIN": 0},
                "overseas_count": 0
            })

        # Shuffle player queue
        shuffled = list(self.players)
        rng.shuffle(shuffled)
        shuffled.sort(key=lambda p: int(p.get("marqueeSet", 8) or 8))

        main_lots = [p for p in shuffled if int(p.get("marqueeSet", 8) or 8) <= 6]
        acc_lots = [p for p in shuffled if int(p.get("marqueeSet", 8) or 8) > 6]
        unsold_pool = []

        # --- MAIN ROUND ---
        for lot_idx, p in enumerate(main_lots):
            bp = float(p.get("basePrice", 0.30) or 0.30)
            ovr = float(p.get("stats", {}).get("ovr", 72.0) or 72.0)
            role = p.get("role", "BAT")
            is_os = p.get("isOverseas", False)
            v_int = self.v_intrinsic.get(p["id"], bp)

            current_bid = 0.0
            current_leader = None

            while True:
                inc = get_next_bid_increment(current_bid)
                next_bid = bp if current_bid == 0.0 else current_bid + inc

                candidates = []
                for t in teams:
                    if t["idx"] == current_leader:
                        continue
                    if len(t["squad"]) >= (25 if t["version"] == "V1.7" else 22):
                        continue
                    if is_os and t["overseas_count"] >= 8:
                        continue
                    if t["role_counts"][role] >= self.MAX_ROLE_CAPS.get(role, 8):
                        continue

                    # Engine-Specific Evaluation
                    can_bid = False
                    if t["version"] == "V3.0":
                        can_b, tgt_val, _ = evaluate_v3_tri_head_bid(t, p, current_bid, v_int, t["pitch"])
                        can_bid = can_b
                    elif t["version"] == "V2.0":
                        # V2.0 Multi-Nature with Staged Reserves
                        slots_18 = max(0, 18 - len(t["squad"]) - 1)
                        abs_res = slots_18 * 0.30
                        max_afford = max(0.0, t["purse"] - abs_res)
                        if t["purse"] >= next_bid and (len(t["squad"]) < 11 or max_afford >= next_bid):
                            # Staged valuation cap
                            v_target = v_int
                            if t["archetype"] == "SUPERSTAR_DUELIST" and ovr >= 90:
                                v_target *= 1.25
                            elif t["archetype"] == "MONEYBALL_CORE":
                                v_target = min(12.0, v_target * 0.65) if ovr >= 93 else (v_target * 1.25 if 87 <= ovr <= 92 else v_target)
                            can_bid = next_bid <= v_target
                    else:
                        # V1.7 Legacy Engine (Capped at 13.5 Cr, vault reserve)
                        vault = 15.0 if len(t["squad"]) < 14 else 10.0
                        min_res = max(0, 18 - len(t["squad"])) * 0.75 + vault
                        max_afford = max(0.0, t["purse"] - min_res)
                        v1_val = min(13.50, compute_v1_legacy_base(p, {"z_youth": 0.0, "z_role_bias": 0.0, "z_risk": 0.0}))
                        can_bid = next_bid <= min(max_afford, v1_val)

                    if can_bid:
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
            else:
                unsold_pool.append(p)

        # --- ACCELERATED ROUND ---
        acc_pool = unsold_pool + acc_lots
        rng.shuffle(acc_pool)

        # Accelerated Round: Teams with surplus purse actively invest to secure top unsold talent
        for t in teams:
            target_size = t.get("target_squad", 19)
            while len(t["squad"]) < target_size and acc_pool and t["purse"] >= 0.30:
                cands = [p for p in acc_pool if (not p.get("isOverseas", False) or t["overseas_count"] < 8) and float(p.get("basePrice", 0.30) or 0.30) <= t["purse"]]
                if not cands: break
                best_p = max(cands, key=lambda pl: float(pl.get("stats", {}).get("ovr", 60)))
                acc_pool.remove(best_p)
                bp_p = float(best_p.get("basePrice", 0.30) or 0.30)
                v_p = self.v_intrinsic.get(best_p["id"], bp_p)

                # Competitive acquisition price: active re-investment of surplus purse down to ~₹1-2 Cr buffer
                rem_needed = max(1, target_size - len(t["squad"]))
                if t["version"] in ["V2.0", "V3.0"]:
                    alloc = max(bp_p, min(v_p, (t["purse"] / rem_needed) * 0.88))
                    price = round(min(t["purse"] - (rem_needed - 1) * 0.30, alloc), 2)
                    price = max(bp_p, price)
                else:
                    price = bp_p

                t["purse"] = round(max(0.0, t["purse"] - price), 2)
                t["total_spent"] = round(t["total_spent"] + price, 2)
                t["squad"].append(best_p)
                t["prices_paid"].append(price)
                t["role_counts"][best_p.get("role", "BAT")] += 1
                if best_p.get("isOverseas", False): t["overseas_count"] += 1

        return teams

    def select_starting_xi(self, squad: list) -> list:
        """Selects optimal legal Starting XI (<= 4 OS, >= 1 WK, >= 5 frontline bowlers)."""
        if len(squad) < 11:
            return squad

        sorted_sq = sorted(squad, key=lambda p: float(p.get("stats", {}).get("ovr", 60)), reverse=True)
        selected = []
        os_cnt = 0
        bowler_cnt = 0

        # 1. Mandatory WK
        wks = [p for p in sorted_sq if p.get("role") == "WK"]
        if wks:
            best_wk = wks[0]
            selected.append(best_wk)
            if best_wk.get("isOverseas", False): os_cnt += 1

        # 2. Frontline Bowlers (PACE/SPIN or BOWL_AR)
        frontline_bowlers = [p for p in sorted_sq if p not in selected and (
            p.get("role") in ["PACE", "SPIN"] or (p.get("role") == "AR" and p.get("subType") == "BOWL_AR" and float(p.get("stats", {}).get("bowl", 0)) >= 78)
        )]

        for b in frontline_bowlers:
            if bowler_cnt >= 5: break
            if b.get("isOverseas", False) and os_cnt >= 4: continue
            selected.append(b)
            if b.get("isOverseas", False): os_cnt += 1
            bowler_cnt += 1

        # 3. Fill remaining positions with best available obeying OS <= 4
        for p in sorted_sq:
            if len(selected) >= 11: break
            if p in selected: continue
            if p.get("isOverseas", False) and os_cnt >= 4: continue
            selected.append(p)
            if p.get("isOverseas", False): os_cnt += 1

        return selected

    def simulate_match(self, home_team: dict, away_team: dict, rng: np.random.RandomState) -> tuple:
        """Simulates full 2-innings T20 match using XGBoost."""
        bat_h = sorted(home_team["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_a = [p for p in away_team["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or away_team["xi"][:5]

        bat_a = sorted(away_team["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_h = [p for p in home_team["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or home_team["xi"][:5]

        # Innings 1: Home
        overs_1 = []
        for o in range(20):
            str_p = bat_h[min(o // 3, len(bat_h) - 1)]
            non_p = bat_h[min((o // 3) + 1, len(bat_h) - 1)]
            bwl_p = bwl_a[o % len(bwl_a)]

            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 1.0
            vec[1] = float(o)
            vec[2] = min(float(o // 4), 4.0)
            vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(str_p.get("stats", {}).get("bat", 75.0))
            vec[7] = float(str_p.get("stats", {}).get("power", 75.0))
            vec[10] = float(non_p.get("stats", {}).get("bat", 75.0))
            vec[12] = float(bwl_p.get("stats", {}).get("bowl", 75.0))
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_1.append(vec)

        score_h = float(np.sum(self.mr.predict(np.array(overs_1, dtype=np.float32)))) + 4.0 + rng.normal(0, 8.0)

        # Innings 2: Away
        overs_2 = []
        for o in range(20):
            str_p = bat_a[min(o // 3, len(bat_a) - 1)]
            non_p = bat_a[min((o // 3) + 1, len(bat_a) - 1)]
            bwl_p = bwl_h[o % len(bwl_h)]

            vec = np.zeros(22, dtype=np.float32)
            vec[0] = 2.0
            vec[1] = float(o)
            vec[2] = min(float(o // 4), 4.0)
            vec[4] = float(((20 - o) / 20.0) ** 0.85)
            vec[6] = float(str_p.get("stats", {}).get("bat", 75.0))
            vec[7] = float(str_p.get("stats", {}).get("power", 75.0))
            vec[10] = float(non_p.get("stats", {}).get("bat", 75.0))
            vec[12] = float(bwl_p.get("stats", {}).get("bowl", 75.0))
            vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
            overs_2.append(vec)

        score_a = float(np.sum(self.mr.predict(np.array(overs_2, dtype=np.float32)))) + rng.normal(0, 8.0)

        home_won = score_h >= score_a
        return round(score_h, 1), round(score_a, 1), home_won

# =============================================================================
# 6. BENCHMARK EXECUTION
# =============================================================================

def run_3way_benchmark(num_seasons=30):
    print("=" * 80)
    print(f"STARTING 3-WAY HEAD-TO-HEAD BENCHMARK: V1.7 vs V2.0 vs V3.0 ({num_seasons} SEASONS)")
    print("=" * 80)

    # 1. Load Data
    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_intrinsic_map = compute_all_v_intrinsic(all_players)

    # 2. Policy Net
    policy_net = AuctionPolicyNet()
    pt_path = Path("public/models/auction_policy_net.pt")
    if pt_path.exists():
        policy_net.load_state_dict(torch.load(pt_path, map_location="cpu"))
    policy_net.eval()

    tournament = ThreeWayAuctionTournament(all_players, v_intrinsic_map, policy_net)

    # Assign versions:
    # 3 teams on V1.7 Legacy (PBKS, GT, LSG)
    # 3 teams on V2.0 Multi-Nature (RR, SRH, DC)
    # 4 teams on V3.0 Hedge-Fund Tri-Head (CSK, MI, KKR, RCB)
    team_versions = {
        "PBKS": "V1.7", "GT": "V1.7", "LSG": "V1.7",
        "RR": "V2.0", "SRH": "V2.0", "DC": "V2.0",
        "CSK": "V3.0", "MI": "V3.0", "KKR": "V3.0", "RCB": "V3.0"
    }

    # Aggregate tracking per version
    stats = {
        "V1.7": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "purse_left": []},
        "V2.0": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "purse_left": []},
        "V3.0": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "purse_left": []}
    }

    head_to_head = {
        ("V3.0", "V2.0"): [0, 0], # [V3 wins, V2 wins]
        ("V3.0", "V1.7"): [0, 0],
        ("V2.0", "V1.7"): [0, 0]
    }

    start_time = time.time()

    for s_idx in range(num_seasons):
        seed = 1000 + s_idx
        teams = tournament.run_auction(seed, team_versions)

        # Select Starting XIs
        for t in teams:
            t["xi"] = tournament.select_starting_xi(t["squad"])
            t["wins"] = 0
            t["points"] = 0
            t["runs_for"] = 0.0
            t["overs_for"] = 0.0
            t["runs_against"] = 0.0
            t["overs_against"] = 0.0

            # Record metrics
            xi_ovr = float(np.mean([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            weak_link = float(min([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            ver = t["version"]
            stats[ver]["xi_ovrs"].append(xi_ovr)
            stats[ver]["weak_links"].append(weak_link)
            stats[ver]["purse_left"].append(t["purse"])

        # Simulate 14 league matches per team (Round-Robin style)
        rng_season = np.random.RandomState(seed)
        t_map = {t["id"]: t for t in teams}
        team_ids = list(t_map.keys())

        for i in range(len(team_ids)):
            for j in range(i + 1, len(team_ids)):
                h_id, a_id = team_ids[i], team_ids[j]
                t_h, t_a = t_map[h_id], t_map[a_id]
                
                # Match 1 (h vs a)
                sh1, sa1, h1_won = tournament.simulate_match(t_h, t_a, rng_season)
                t_h["runs_for"] += sh1; t_h["overs_for"] += 20; t_h["runs_against"] += sa1; t_h["overs_against"] += 20
                t_a["runs_for"] += sa1; t_a["overs_for"] += 20; t_a["runs_against"] += sh1; t_a["overs_against"] += 20
                if h1_won:
                    t_h["wins"] += 1; t_h["points"] += 2
                    w_ver, l_ver = t_h["version"], t_a["version"]
                else:
                    t_a["wins"] += 1; t_a["points"] += 2
                    w_ver, l_ver = t_a["version"], t_h["version"]

                stats[t_h["version"]]["matches"] += 1
                stats[t_a["version"]]["matches"] += 1
                stats[w_ver]["wins"] += 1
                if (w_ver, l_ver) in head_to_head: head_to_head[(w_ver, l_ver)][0] += 1
                elif (l_ver, w_ver) in head_to_head: head_to_head[(l_ver, w_ver)][1] += 1

                # Match 2 (a vs h)
                sa2, sh2, a2_won = tournament.simulate_match(t_a, t_h, rng_season)
                t_a["runs_for"] += sa2; t_a["overs_for"] += 20; t_a["runs_against"] += sh2; t_a["overs_against"] += 20
                t_h["runs_for"] += sh2; t_h["overs_for"] += 20; t_h["runs_against"] += sa2; t_h["overs_against"] += 20
                if a2_won:
                    t_a["wins"] += 1; t_a["points"] += 2
                    w_ver, l_ver = t_a["version"], t_h["version"]
                else:
                    t_h["wins"] += 1; t_h["points"] += 2
                    w_ver, l_ver = t_h["version"], t_a["version"]

                stats[t_h["version"]]["matches"] += 1
                stats[t_a["version"]]["matches"] += 1
                stats[w_ver]["wins"] += 1
                if (w_ver, l_ver) in head_to_head: head_to_head[(w_ver, l_ver)][0] += 1
                elif (l_ver, w_ver) in head_to_head: head_to_head[(l_ver, w_ver)][1] += 1

        # Calculate NRR and Standings
        for t in teams:
            t["nrr"] = (t["runs_for"] / max(1.0, t["overs_for"])) - (t["runs_against"] / max(1.0, t["overs_against"]))

        teams.sort(key=lambda x: (x["points"], x["nrr"]), reverse=True)

        # Playoffs (Top 4)
        top4 = teams[:4]
        for t in top4:
            stats[t["version"]]["playoffs"] += 1

        # Q1: 1 vs 2
        _, _, q1_won = tournament.simulate_match(top4[0], top4[1], rng_season)
        finalist_1 = top4[0] if q1_won else top4[1]
        q1_loser = top4[1] if q1_won else top4[0]

        # Eliminator: 3 vs 4
        _, _, el_won = tournament.simulate_match(top4[2], top4[3], rng_season)
        el_winner = top4[2] if el_won else top4[3]

        # Q2: Q1 Loser vs Eliminator Winner
        _, _, q2_won = tournament.simulate_match(q1_loser, el_winner, rng_season)
        finalist_2 = q1_loser if q2_won else el_winner

        # FINAL
        _, _, final_won = tournament.simulate_match(finalist_1, finalist_2, rng_season)
        champion = finalist_1 if final_won else finalist_2
        stats[champion["version"]]["trophies"] += 1

        if (s_idx + 1) % 10 == 0:
            print(f"  Processed {s_idx + 1}/{num_seasons} seasons... (Latest Champion: {champion['name']} [{champion['version']}])")

    elapsed = time.time() - start_time
    print(f"\nCompleted {num_seasons} full tournament simulations in {elapsed:.1f}s.\n")

    # =========================================================================
    # 7. METRICS & COMPARISON SUMMARY
    # =========================================================================
    print("=" * 80)
    print("3-WAY HEAD-TO-HEAD BENCHMARK REPORT")
    print("=" * 80)
    print(f"{'Metric':<32} | {'V1.7 Legacy':<14} | {'V2.0 Multi-Nature':<18} | {'V3.0 Hedge-Fund Tri-Head':<20}")
    print("-" * 88)

    # 1. Championships
    t1 = stats["V1.7"]["trophies"]
    t2 = stats["V2.0"]["trophies"]
    t3 = stats["V3.0"]["trophies"]
    print(f"{'Championships Won':<32} | {t1:>4} ({t1/num_seasons*100:>4.1f}%)    | {t2:>4} ({t2/num_seasons*100:>4.1f}%)       | {t3:>4} ({t3/num_seasons*100:>4.1f}%)")

    # 2. Playoff Qualifications
    p1 = stats["V1.7"]["playoffs"] / (3 * num_seasons) * 100
    p2 = stats["V2.0"]["playoffs"] / (3 * num_seasons) * 100
    p3 = stats["V3.0"]["playoffs"] / (4 * num_seasons) * 100
    print(f"{'Playoff Qual Rate (Top 4)':<32} | {p1:>8.1f}%     | {p2:>12.1f}%      | {p3:>14.1f}%")

    # 3. Overall Win Rate
    w1 = stats["V1.7"]["wins"] / max(1, stats["V1.7"]["matches"]) * 100
    w2 = stats["V2.0"]["wins"] / max(1, stats["V2.0"]["matches"]) * 100
    w3 = stats["V3.0"]["wins"] / max(1, stats["V3.0"]["matches"]) * 100
    print(f"{'Match Win % (League + Playoff)':<32} | {w1:>8.1f}%     | {w2:>12.1f}%      | {w3:>14.1f}%")

    # 4. Starting XI Mean OVR
    ovr1 = np.mean(stats["V1.7"]["xi_ovrs"])
    ovr2 = np.mean(stats["V2.0"]["xi_ovrs"])
    ovr3 = np.mean(stats["V3.0"]["xi_ovrs"])
    print(f"{'Starting XI Mean OVR':<32} | {ovr1:>9.2f}     | {ovr2:>13.2f}      | {ovr3:>15.2f}")

    # 5. Weak Link (Min OVR in XI)
    wl1 = np.mean(stats["V1.7"]["weak_links"])
    wl2 = np.mean(stats["V2.0"]["weak_links"])
    wl3 = np.mean(stats["V3.0"]["weak_links"])
    print(f"{'Weak Link (Worst XI Starter OVR)':<32} | {wl1:>9.2f}     | {wl2:>13.2f}      | {wl3:>15.2f}")

    # 6. Purse Utilization
    pur1 = np.mean(stats["V1.7"]["purse_left"])
    pur2 = np.mean(stats["V2.0"]["purse_left"])
    pur3 = np.mean(stats["V3.0"]["purse_left"])
    print(f"{'Mean Leftover Purse (Cr)':<32} | ₹{pur1:>7.2f} Cr   | ₹{pur2:>11.2f} Cr    | ₹{pur3:>13.2f} Cr")

    print("-" * 88)
    print("\n--- DIRECT HEAD-TO-HEAD MATCHUPS ---")
    v3_v2_w, v3_v2_l = head_to_head[("V3.0", "V2.0")]
    v3_v1_w, v3_v1_l = head_to_head[("V3.0", "V1.7")]
    v2_v1_w, v2_v1_l = head_to_head[("V2.0", "V1.7")]

    print(f"• V3.0 vs V2.0 : V3.0 Won {v3_v2_w} - {v3_v2_l} ({v3_v2_w/(v3_v2_w+v3_v2_l)*100:.1f}% Win Rate)")
    print(f"• V3.0 vs V1.7 : V3.0 Won {v3_v1_w} - {v3_v1_l} ({v3_v1_w/(v3_v1_w+v3_v1_l)*100:.1f}% Win Rate)")
    print(f"• V2.0 vs V1.7 : V2.0 Won {v2_v1_w} - {v2_v1_l} ({v2_v1_w/(v2_v1_w+v2_v1_l)*100:.1f}% Win Rate)")
    print("=" * 80)

if __name__ == "__main__":
    run_3way_benchmark(30)

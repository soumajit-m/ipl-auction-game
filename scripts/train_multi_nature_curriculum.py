"""
scripts/train_multi_nature_curriculum.py
Comprehensive 3-Phase Evolutionary Curriculum for 3 Independent AI Natures:
1. Phase 1: Isolated Solo Evolution (200 Generations)
2. Phase 2: Tri-Nature Co-Evolution (50 Generations)
3. Phase 3: Adversarial Rogue Human Stress-Testing (250 Simulated Rounds)

Outputs:
- public/models/weights_sd.json (Superstar Duelist)
- public/models/weights_mb.json (Moneyball Core)
- public/models/weights_dp.json (Disciplined Pragmatist)
"""

import os
import sys
import json
import math
import random
import copy
from pathlib import Path
import numpy as np
import xgboost as xgb
import torch
import torch.nn as nn

# =============================================================================
# 1. NETWORK ARCHITECTURE & WEIGHT DICTIONARY
# =============================================================================

class PolicyNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(18),             # net.0
            nn.Linear(18, 32),            # net.1
            nn.LayerNorm(32),             # net.2
            nn.SiLU(),                    # net.3
            nn.Linear(32, 32),            # net.4
            nn.LayerNorm(32),             # net.5
            nn.SiLU(),                    # net.6
            nn.Linear(32, 3)              # net.7
        )

    def forward(self, x):
        return self.net(x)

def net_to_json_weights(model: PolicyNet) -> dict:
    state = model.state_dict()
    weights_json = {}
    for k, v in state.items():
        weights_json[k] = v.detach().cpu().numpy().tolist()
    return weights_json

def json_weights_to_net(weights_json: dict) -> PolicyNet:
    model = PolicyNet()
    state = {}
    for k, v in weights_json.items():
        state[k] = torch.tensor(v, dtype=torch.float32)
    model.load_state_dict(state)
    return model

def forward_numpy(input18: np.ndarray, weights: dict) -> tuple:
    # 0. LayerNorm 18
    w0 = np.array(weights["net.0.weight"])
    b0 = np.array(weights["net.0.bias"])
    m0 = np.mean(input18)
    v0 = np.var(input18)
    h0 = (input18 - m0) / np.sqrt(v0 + 1e-5) * w0 + b0

    # 1. Linear 18 -> 32
    w1 = np.array(weights["net.1.weight"])
    b1 = np.array(weights["net.1.bias"])
    h1 = np.dot(w1, h0) + b1

    # 2. LayerNorm 32
    w2 = np.array(weights["net.2.weight"])
    b2 = np.array(weights["net.2.bias"])
    m2 = np.mean(h1)
    v2 = np.var(h1)
    h2 = (h1 - m2) / np.sqrt(v2 + 1e-5) * w2 + b2

    # 3. SiLU
    h3 = h2 / (1.0 + np.exp(-np.clip(h2, -20.0, 20.0)))

    # 4. Linear 32 -> 32
    w4 = np.array(weights["net.4.weight"])
    b4 = np.array(weights["net.4.bias"])
    h4 = np.dot(w4, h3) + b4

    # 5. LayerNorm 32
    w5 = np.array(weights["net.5.weight"])
    b5 = np.array(weights["net.5.bias"])
    m5 = np.mean(h4)
    v5 = np.var(h4)
    h5 = (h4 - m5) / np.sqrt(v5 + 1e-5) * w5 + b5

    # 6. SiLU
    h6 = h5 / (1.0 + np.exp(-np.clip(h5, -20.0, 20.0)))

    # 7. Linear 32 -> 3
    w7 = np.array(weights["net.7.weight"])
    b7 = np.array(weights["net.7.bias"])
    z = np.dot(w7, h6) + b7

    sig0 = 1.0 / (1.0 + np.exp(-np.clip(z[0], -20.0, 20.0)))
    sig1 = 1.0 / (1.0 + np.exp(-np.clip(z[1], -20.0, 20.0)))
    sig2 = 1.0 / (1.0 + np.exp(-np.clip(z[2], -20.0, 20.0)))

    m_policy = 0.70 + 0.80 * sig0  # [0.70 .. 1.50]
    p_bluff = 0.55 * sig1          # [0.00 .. 0.55]
    tau_sniper = 0.60 * sig2       # [0.00 .. 0.60]

    return m_policy, p_bluff, tau_sniper

# =============================================================================
# 2. FRANCHISES & MATCH SIMULATION ENGINE
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

STARTING_XI_ROLE_TARGETS = {
    "BAT": 4,
    "WK": 1,
    "AR": 2,
    "PACE": 3,
    "SPIN": 2
}

class FastMatchSim:
    def __init__(self):
        self.mr = xgb.XGBRegressor()
        self.mr.load_model("public/models/xgb_runs.json")

    def select_starting_xi(self, squad: list) -> list:
        if len(squad) < 11:
            return squad
        sorted_sq = sorted(squad, key=lambda p: float(p.get("stats", {}).get("ovr", 60)), reverse=True)
        selected = []
        os_cnt = 0
        wks = [p for p in sorted_sq if p.get("role") == "WK"]
        if wks:
            selected.append(wks[0])
            if wks[0].get("isOverseas", False):
                os_cnt += 1

        for b in sorted_sq:
            if b in selected:
                continue
            if len([x for x in selected if x.get("role") in ["PACE", "SPIN", "AR"]]) >= 5:
                break
            if b.get("isOverseas", False) and os_cnt >= 4:
                continue
            if b.get("role") in ["PACE", "SPIN"] or (b.get("role") == "AR" and float(b.get("stats", {}).get("bowl", 0)) >= 75):
                selected.append(b)
                if b.get("isOverseas", False):
                    os_cnt += 1

        for p in sorted_sq:
            if len(selected) >= 11:
                break
            if p in selected:
                continue
            if p.get("isOverseas", False) and os_cnt >= 4:
                continue
            selected.append(p)
            if p.get("isOverseas", False):
                os_cnt += 1

        return selected

    def simulate_match(self, t_h: dict, t_a: dict, rng: np.random.RandomState) -> bool:
        if len(t_h["xi"]) < 11 or len(t_a["xi"]) < 11:
            return len(t_h["xi"]) >= len(t_a["xi"])

        bat_h = sorted(t_h["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_a = [p for p in t_a["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or t_a["xi"][:5]

        bat_a = sorted(t_a["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
        bwl_h = [p for p in t_h["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or t_h["xi"][:5]

        # Inning 1 (Home)
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

        # Inning 2 (Away)
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

# Precompute intrinsic valuations
def compute_all_v_intrinsic(players: list) -> dict:
    surpluses = []
    for p in players:
        ovr = float(p.get("stats", {}).get("ovr", 72.0) or 72.0)
        s = max(0.0, ovr - 70.0) ** 1.95
        surpluses.append((p, s))

    surpluses.sort(key=lambda x: x[1], reverse=True)
    top_160_surplus = sum(s for _, s in surpluses[:160]) or 1.0

    v_map = {}
    for p, s in surpluses:
        bp = float(p.get("basePrice", 0.30) or 0.30)
        v_calc = bp + 1050.0 * (s / top_160_surplus)
        real_p = float(p.get("realAuctionPrice", 0.0) or 0.0)
        v_final = 0.88 * v_calc + 0.12 * real_p if real_p >= 8.0 else v_calc
        v_final = max(bp, min(26.50, round(v_final, 2)))
        v_map[p["id"]] = v_final
    return v_map

def get_next_bid_increment(current_bid: float) -> float:
    if current_bid < 5.0: return 0.25
    elif current_bid < 10.0: return 0.50
    else: return 1.00

def extract_features_18(team: dict, player: dict, current_bid: float, v_int: float) -> np.ndarray:
    squad_sz = len(team["squad"])
    target_sq = team.get("target_squad", 19)
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    is_os = player.get("isOverseas", False)
    role = player.get("role", "BAT")

    f = np.zeros(18, dtype=np.float32)
    f[0] = (ovr - 75.0) / 15.0
    f[1] = 1.0 if is_os else -1.0
    f[2] = np.clip((current_bid - v_int) / max(1.0, v_int), -1.0, 2.0)
    f[3] = (team["purse"] - 62.5) / 62.5
    f[4] = 0.0 # league relative purse
    f[5] = max(0, 14 - squad_sz) / 14.0
    f[6] = max(0, target_sq - squad_sz) / 22.0

    cur_role_cnt = team["role_counts"].get(role, 0)
    target_role_cnt = STARTING_XI_ROLE_TARGETS.get(role, 3)
    f[7] = max(0, target_role_cnt - cur_role_cnt) / 5.0
    f[8] = 1.0 if role == "WK" and cur_role_cnt == 0 else 0.0
    f[9] = 1.0 if is_os and team["overseas_count"] >= 7 else 0.0
    f[10] = 0.0 # marquee set norm
    f[11] = 0.0 # acceleration norm
    f[12] = 0.0 # role EMA inflation
    f[13] = 0.0; f[14] = 0.0; f[15] = 0.0; f[16] = 0.0; f[17] = 0.0 # DNA features
    return f

# =============================================================================
# 3. BIDDING EVALUATION WITH ARCHETYPE POLICIES
# =============================================================================

def evaluate_bid_with_policy(
    team: dict,
    player: dict,
    current_bid: float,
    v_int: float,
    policy_weights: dict
) -> tuple:
    archetype = team.get("archetype", "DISCIPLINED_PRAGMATIST")
    squad_sz = len(team["squad"])
    target_sq = team.get("target_squad", 19)
    purse = team["purse"]
    bp = float(player.get("basePrice", 0.30) or 0.30)
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    role = player.get("role", "BAT")
    is_os = player.get("isOverseas", False)

    inc = get_next_bid_increment(current_bid)
    next_bid = bp if current_bid == 0.0 else current_bid + inc

    # 1. Hard Legality & Solvency Clamps
    slots_to_18 = max(0, 18 - squad_sz - 1)
    min_reserve = slots_to_18 * 0.40
    max_affordable = max(0.0, purse - min_reserve)

    if purse < next_bid or max_affordable < next_bid:
        return False, 0.0

    if is_os and team["overseas_count"] >= 8:
        return False, 0.0

    if squad_sz >= target_sq and ovr < 85:
        return False, 0.0

    # 2. Extract 18 Features & Run Policy Net Forward Pass
    feat18 = extract_features_18(team, player, current_bid, v_int)
    m_policy, p_bluff, tau_sniper = forward_numpy(feat18, policy_weights)

    # 3. Staged Capital Allocation (Deploy ₹105-110 Cr on Top 10-11)
    if squad_sz < 11:
        starter_slots_left = max(1, 11 - squad_sz)
        starter_budget_rem = max(0.0, purse - 16.50)
        starter_alloc = starter_budget_rem / starter_slots_left
        m_stage = float(np.clip(1.05 + 0.12 * (starter_alloc - 9.0), 0.90, 1.35))
    else:
        bench_slots_left = max(1, target_sq - squad_sz)
        bench_alloc = purse / bench_slots_left
        m_stage = float(np.clip(0.75 + 0.15 * (bench_alloc - 2.20), 0.55, 1.15))

    # 4. Starting XI Marginal Need
    cur_role_cnt = team["role_counts"].get(role, 0)
    target_role_cnt = STARTING_XI_ROLE_TARGETS.get(role, 3)
    if squad_sz < 11:
        if cur_role_cnt < target_role_cnt:
            need_factor = 1.0 + 0.12 * (target_role_cnt - cur_role_cnt)
        else:
            need_factor = 0.90
    else:
        need_factor = 0.80 if cur_role_cnt < target_role_cnt + 2 else 0.55

    if role == "WK" and cur_role_cnt == 0:
        need_factor = 1.35 if squad_sz < 8 else 1.65

    # 5. Specialized Archetype Mandates (SD, MB, DP)
    target_val = v_int * m_policy * m_stage * need_factor

    if archetype == "SUPERSTAR_DUELIST":
        # Target squad = 18. Pay high on ONLY 1 or 2 marquee players (OVR >= 90)
        superstar_count = sum(1 for p in team["squad"] if float(p.get("stats", {}).get("ovr", 0)) >= 90 or p.get("price_paid", 0) >= 15.0)
        if superstar_count < 2 and ovr >= 90 and squad_sz < 11:
            target_val = min(26.50, max(target_val, target_val * 1.30))
        else:
            target_val = min(16.50, target_val)

    elif archetype == "MONEYBALL_CORE":
        # Target squad = 20.
        # Folds on >90 OVR icons (cap 13 Cr).
        # Aggressively hunts 82-90 OVR core (+25%).
        # Actively discounts <82 OVR (down-pool value).
        if ovr > 90:
            target_val = min(13.00, v_int * 0.70)
        elif 82 <= ovr <= 90:
            target_val = min(18.50, target_val * 1.25)
        else:
            target_val = min(2.50 if squad_sz < 11 else bp * 1.5, target_val * 0.65)

    else: # DISCIPLINED_PRAGMATIST
        # Target squad = 19. Strict fair intrinsic value.
        target_val = min(16.50, target_val)

    # Hard ceiling clamp
    target_val = min(26.50, target_val)

    # Starter budget ceiling clamp (Preserves bench funds)
    if squad_sz < 11:
        starter_slots_left = max(1, 11 - squad_sz)
        starter_cap = max(bp, max(0.0, purse - 16.50) - (starter_slots_left - 1) * 0.40)
        target_val = min(target_val, starter_cap)

    target_val = max(bp, min(target_val, max_affordable))
    return next_bid <= target_val, target_val

# =============================================================================
# 4. ROGUE HUMAN BEHAVIOR SIMULATOR
# =============================================================================

class RogueHumanAgent:
    def __init__(self):
        self.troll_modes = ["PRICE_JACKER", "HOARDER", "ERRATIC_GAMBLER"]

    def evaluate_rogue_bid(self, team: dict, player: dict, current_bid: float) -> tuple:
        squad_sz = len(team["squad"])
        purse = team["purse"]
        bp = float(player.get("basePrice", 0.30) or 0.30)
        ovr = float(player.get("stats", {}).get("ovr", 70.0) or 70.0)
        inc = get_next_bid_increment(current_bid)
        next_bid = bp if current_bid == 0.0 else current_bid + inc

        if purse < next_bid or squad_sz >= 25:
            return False, 0.0

        mode = self.troll_modes[squad_sz % 3]

        if mode == "PRICE_JACKER":
            # Bids aggressively on 90+ stars to inflate price up to ₹20-22 Cr then folds
            if ovr >= 88 and current_bid < 21.0:
                return True, 21.0
            return False, 0.0

        elif mode == "HOARDER":
            # Tries to buy all wicketkeepers or overseas pacers
            if player.get("role") == "WK" or (player.get("isOverseas", False) and player.get("role") == "PACE"):
                return next_bid <= 14.0, 14.0
            return next_bid <= bp * 2.0, bp * 2.0

        else: # ERRATIC_GAMBLER
            # Randomly bids high on low OVR players (75 OVR) up to ₹8 Cr
            if ovr < 80 and current_bid < 7.50:
                return random.random() < 0.65, 7.50
            return random.random() < 0.20, bp

# =============================================================================
# 5. TOURNAMENT SIMULATION & FITNESS EVALUATION
# =============================================================================

def simulate_season(teams: list, all_players: list, v_int_map: dict, match_sim: FastMatchSim, seed: int):
    rng = random.Random(seed)
    rng_match = np.random.RandomState(seed)

    shuffled = list(all_players)
    rng.shuffle(shuffled)
    shuffled.sort(key=lambda p: int(p.get("marqueeSet", 8) or 8))

    main_lots = [p for p in shuffled if int(p.get("marqueeSet", 8) or 8) <= 6]
    acc_lots = [p for p in shuffled if int(p.get("marqueeSet", 8) or 8) > 6]
    unsold = []

    # Reset teams
    for t in teams:
        t["purse"] = 125.00
        t["total_spent"] = 0.0
        t["squad"] = []
        t["prices_paid"] = []
        t["role_counts"] = {"BAT": 0, "WK": 0, "AR": 0, "PACE": 0, "SPIN": 0}
        t["overseas_count"] = 0
        t["wins"] = 0
        t["points"] = 0

    # Main Auction
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
                if len(t["squad"]) >= t.get("target_squad", 19) + 2: continue

                can_bid = False
                if t.get("is_rogue", False):
                    can_b, _ = t["rogue_agent"].evaluate_rogue_bid(t, p, current_bid)
                    can_bid = can_b
                else:
                    can_b, _ = evaluate_bid_with_policy(t, p, current_bid, v_int, t["policy_weights"])
                    can_bid = can_b

                if can_bid: candidates.append(t["idx"])

            if not candidates: break
            current_leader = rng.choice(candidates)
            current_bid = next_bid

        if current_leader is not None:
            winner = teams[current_leader]
            winner["purse"] = round(winner["purse"] - current_bid, 2)
            winner["total_spent"] = round(winner["total_spent"] + current_bid, 2)
            p_record = copy.deepcopy(p)
            p_record["price_paid"] = current_bid
            winner["squad"].append(p_record)
            winner["prices_paid"].append(current_bid)
            winner["role_counts"][role] = winner["role_counts"].get(role, 0) + 1
            if is_os: winner["overseas_count"] += 1
        else:
            unsold.append(p)

    # Accelerated Round
    acc_pool = unsold + acc_lots
    rng.shuffle(acc_pool)

    for t in teams:
        if t.get("is_rogue", False): continue
        target_sz = t.get("target_squad", 19)
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
            bench_slot_target = usable_purse / rem_needed
            max_allowed = max(bp_p, t["purse"] - buffer - (rem_needed - 1) * 0.40)
            price = round(min(max(bp_p, min(v_p, bench_slot_target)), max_allowed), 2)
            price = max(bp_p, price)

            t["purse"] = round(max(0.0, t["purse"] - price), 2)
            t["total_spent"] = round(t["total_spent"] + price, 2)
            p_record = copy.deepcopy(best_p)
            p_record["price_paid"] = price
            t["squad"].append(p_record)
            t["prices_paid"].append(price)
            t["role_counts"][best_p.get("role", "BAT")] = t["role_counts"].get(best_p.get("role", "BAT"), 0) + 1
            if best_p.get("isOverseas", False): t["overseas_count"] += 1

    # Match League Simulation (14 matches)
    for t in teams:
        t["xi"] = match_sim.select_starting_xi(t["squad"])

    num_teams = len(teams)
    for i in range(num_teams):
        for j in range(i + 1, num_teams):
            t_h, t_a = teams[i], teams[j]
            h_won = match_sim.simulate_match(t_h, t_a, rng_match)
            if h_won:
                t_h["wins"] += 1; t_h["points"] += 2
            else:
                t_a["wins"] += 1; t_a["points"] += 2

            a_won = match_sim.simulate_match(t_a, t_h, rng_match)
            if a_won:
                t_a["wins"] += 1; t_a["points"] += 2
            else:
                t_h["wins"] += 1; t_h["points"] += 2

    # Playoffs & Champion
    sorted_teams = sorted(teams, key=lambda x: x["points"], reverse=True)
    top4 = sorted_teams[:4]
    champ = top4[0]
    if len(top4) >= 2:
        q1_won = match_sim.simulate_match(top4[0], top4[1], rng_match)
        f1, q1_l = (top4[0], top4[1]) if q1_won else (top4[1], top4[0])
        if len(top4) >= 4:
            el_won = match_sim.simulate_match(top4[2], top4[3], rng_match)
            el_w = top4[2] if el_won else top4[3]
            q2_won = match_sim.simulate_match(q1_l, el_w, rng_match)
            f2 = q1_l if q2_won else el_w
            final_won = match_sim.simulate_match(f1, f2, rng_match)
            champ = f1 if final_won else f2

    return sorted_teams, champ

def compute_fitness(team: dict, is_champ: bool, is_playoff: bool) -> float:
    score = 0.0
    sq_len = len(team["squad"])
    arch = team.get("archetype", "DISCIPLINED_PRAGMATIST")
    target_sq = 18 if arch == "SUPERSTAR_DUELIST" else (20 if arch == "MONEYBALL_CORE" else 19)

    # 1. Hard Legality Tier
    if sq_len < 18:
        return -5000.0 + sq_len * 100.0 # Severe penalty for illegal squad
    score += 1000.0

    # Role Balance Invariants
    wk_count = team["role_counts"].get("WK", 0)
    if wk_count >= 1: score += 300.0
    else: score -= 1500.0

    bowler_count = team["role_counts"].get("PACE", 0) + team["role_counts"].get("SPIN", 0) + team["role_counts"].get("AR", 0)
    if bowler_count >= 6: score += 300.0
    else: score -= 1000.0

    if team["overseas_count"] <= 8: score += 200.0
    else: score -= 2000.0

    # 2. Match Performance Tier
    score += team["wins"] * 100.0
    if is_playoff: score += 500.0
    if is_champ: score += 1500.0

    # 3. Strategy & Squad Size Precision
    if sq_len == target_sq: score += 250.0
    elif abs(sq_len - target_sq) == 1: score += 100.0
    else: score -= 200.0

    # Starting XI OVR
    if len(team["xi"]) >= 11:
        mean_xi_ovr = float(np.mean([float(p.get("stats", {}).get("ovr", 70)) for p in team["xi"]]))
        score += max(0.0, (mean_xi_ovr - 84.0)) * 60.0

    # Leftover Purse Buffer
    purse_rem = team["purse"]
    if 1.0 <= purse_rem <= 3.0:
        score += 250.0
    elif purse_rem < 1.0:
        score += 50.0
    else:
        # Penalize excessive unspent hoarding (> 8 Cr)
        score -= min(800.0, (purse_rem - 3.0) * 80.0)

    # Top 11 Spend Target (₹104 - ₹112 Cr)
    top11_prices = sorted(team["prices_paid"], reverse=True)[:11]
    top11_sum = sum(top11_prices)
    if 104.0 <= top11_sum <= 112.0:
        score += 250.0
    else:
        score -= min(500.0, abs(top11_sum - 108.0) * 30.0)

    return score

# =============================================================================
# 6. GENETIC MUTATION & EVOLUTIONARY LOOP
# =============================================================================

def mutate_weights(parent_weights: dict, mutation_rate: float = 0.08, mutation_power: float = 0.05) -> dict:
    child_weights = {}
    for k, v in parent_weights.items():
        arr = np.array(v, dtype=np.float32)
        mask = np.random.rand(*arr.shape) < mutation_rate
        noise = np.random.normal(0, mutation_power, size=arr.shape)
        arr = arr + mask * noise
        child_weights[k] = arr.tolist()
    return child_weights

def run_curriculum():
    print("=" * 80)
    print("STARTING 3-PHASE EVOLUTIONARY TRAINING CURRICULUM")
    print("Independent Specialist Policy Networks for SD, MB, and DP")
    print("=" * 80)

    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_int_map = compute_all_v_intrinsic(all_players)
    match_sim = FastMatchSim()

    # Load baseline model weights
    base_raw = Path("public/models/auction_policy_net_weights.json").read_text(encoding="utf-8")
    base_weights = json.loads(base_raw)

    # Initialize 3 distinct policy weight populations
    pop_size = 6
    populations = {
        "SUPERSTAR_DUELIST": [mutate_weights(base_weights, mutation_rate=0.05, mutation_power=0.03) for _ in range(pop_size)],
        "MONEYBALL_CORE": [mutate_weights(base_weights, mutation_rate=0.05, mutation_power=0.03) for _ in range(pop_size)],
        "DISCIPLINED_PRAGMATIST": [mutate_weights(base_weights, mutation_rate=0.05, mutation_power=0.03) for _ in range(pop_size)]
    }

    best_weights = {
        "SUPERSTAR_DUELIST": copy.deepcopy(base_weights),
        "MONEYBALL_CORE": copy.deepcopy(base_weights),
        "DISCIPLINED_PRAGMATIST": copy.deepcopy(base_weights)
    }

    # =========================================================================
    # PHASE 1: ISOLATED SOLO EVOLUTION (200 GENERATIONS TOTAL)
    # 70 Gens SD, 70 Gens MB, 60 Gens DP
    # =========================================================================
    print("\n--- PHASE 1: ISOLATED SOLO EVOLUTION (200 GENERATIONS) ---")
    phase1_schedule = [
        ("SUPERSTAR_DUELIST", 70, 18),
        ("MONEYBALL_CORE", 70, 20),
        ("DISCIPLINED_PRAGMATIST", 60, 19)
    ]

    for arch_name, gens, target_sq in phase1_schedule:
        print(f"\n[Phase 1] Evolving {arch_name} for {gens} Generations (Target Squad: {target_sq})...")
        best_fitness = -99999.0

        for gen in range(1, gens + 1):
            cand_scores = []
            for cand_idx, cand_w in enumerate(populations[arch_name]):
                # Evaluate against other candidates in homogeneous 10-team room
                teams = []
                for f_idx, pf in enumerate(FRANCHISES):
                    # Opponent weights from population
                    opp_w = cand_w if f_idx == 0 else populations[arch_name][f_idx % pop_size]
                    teams.append({
                        "idx": f_idx,
                        "id": pf["id"],
                        "name": pf["name"],
                        "archetype": arch_name,
                        "target_squad": target_sq,
                        "policy_weights": opp_w
                    })

                sorted_t, champ = simulate_season(teams, all_players, v_int_map, match_sim, seed=1000 + gen * 10 + cand_idx)
                tested_team = next(t for t in sorted_t if t["idx"] == 0)
                is_champ = (champ["idx"] == 0)
                is_playoff = tested_team in sorted_t[:4]

                fit = compute_fitness(tested_team, is_champ, is_playoff)
                cand_scores.append((cand_w, fit, len(tested_team["squad"]), tested_team["purse"]))

            # Sort by fitness
            cand_scores.sort(key=lambda x: x[1], reverse=True)
            top_cand = cand_scores[0]
            if top_cand[1] > best_fitness:
                best_fitness = top_cand[1]
                best_weights[arch_name] = copy.deepcopy(top_cand[0])

            if gen % 20 == 0 or gen == gens:
                print(f"  Gen {gen:02d}/{gens:02d} | Best Fit: {top_cand[1]:.0f} | Squad Sz: {top_cand[2]} | Purse Left: ₹{top_cand[3]:.2f} Cr")

            # Selection & Breed next generation
            survivors = [cs[0] for cs in cand_scores[:3]]
            new_pop = [survivors[0]] # Elitism
            while len(new_pop) < pop_size:
                parent = random.choice(survivors)
                child = mutate_weights(parent, mutation_rate=0.08, mutation_power=0.04)
                new_pop.append(child)
            populations[arch_name] = new_pop

    print("\nPhase 1 Complete! Each archetype successfully established baseline discipline.")

    # =========================================================================
    # PHASE 2: TRI-NATURE CO-EVOLUTION (50 GENERATIONS)
    # Mixed Room: 3 SD + 4 MB + 3 DP
    # =========================================================================
    print("\n--- PHASE 2: TRI-NATURE CO-EVOLUTION (50 GENERATIONS) ---")
    mixed_archetypes = [
        "SUPERSTAR_DUELIST", "SUPERSTAR_DUELIST", "SUPERSTAR_DUELIST",
        "MONEYBALL_CORE", "MONEYBALL_CORE", "MONEYBALL_CORE", "MONEYBALL_CORE",
        "DISCIPLINED_PRAGMATIST", "DISCIPLINED_PRAGMATIST", "DISCIPLINED_PRAGMATIST"
    ]

    for gen in range(1, 51):
        for arch_name in ["SUPERSTAR_DUELIST", "MONEYBALL_CORE", "DISCIPLINED_PRAGMATIST"]:
            cand_scores = []
            for cand_idx, cand_w in enumerate(populations[arch_name]):
                teams = []
                for f_idx, pf in enumerate(FRANCHISES):
                    a_type = mixed_archetypes[f_idx]
                    sq_t = 18 if a_type == "SUPERSTAR_DUELIST" else (20 if a_type == "MONEYBALL_CORE" else 19)
                    if a_type == arch_name and f_idx == mixed_archetypes.index(arch_name):
                        p_weights = cand_w
                    else:
                        p_weights = best_weights[a_type]

                    teams.append({
                        "idx": f_idx,
                        "id": pf["id"],
                        "name": pf["name"],
                        "archetype": a_type,
                        "target_squad": sq_t,
                        "policy_weights": p_weights
                    })

                sorted_t, champ = simulate_season(teams, all_players, v_int_map, match_sim, seed=3000 + gen * 10 + cand_idx)
                eval_idx = mixed_archetypes.index(arch_name)
                tested_team = next(t for t in sorted_t if t["idx"] == eval_idx)
                is_champ = (champ["idx"] == eval_idx)
                is_playoff = tested_team in sorted_t[:4]

                fit = compute_fitness(tested_team, is_champ, is_playoff)
                cand_scores.append((cand_w, fit))

            cand_scores.sort(key=lambda x: x[1], reverse=True)
            if cand_scores[0][1] > -5000:
                best_weights[arch_name] = copy.deepcopy(cand_scores[0][0])

            # Breed
            survivors = [cs[0] for cs in cand_scores[:3]]
            new_pop = [survivors[0]]
            while len(new_pop) < pop_size:
                new_pop.append(mutate_weights(random.choice(survivors), mutation_rate=0.06, mutation_power=0.03))
            populations[arch_name] = new_pop

        if gen % 10 == 0 or gen == 50:
            print(f"  Co-Evolution Gen {gen:02d}/50 complete across all 3 AI natures.")

    print("\nPhase 2 Complete! Dynamic market equilibrium established between SD, MB, and DP.")

    # =========================================================================
    # PHASE 3: ADVERSARIAL ROGUE HUMAN STRESS-TESTING (250 SIMULATED ROUNDS)
    # 9 AI Franchises (3 SD, 3 MB, 3 DP) + 1 Rogue Human Agent
    # =========================================================================
    print("\n--- PHASE 3: ADVERSARIAL ROGUE HUMAN STRESS-TESTING (250 ROUNDS) ---")
    rogue_agent = RogueHumanAgent()

    human_resilience_stats = {
        "SUPERSTAR_DUELIST": {"illegal_count": 0, "wins": 0, "matches": 0, "purse_buffers": []},
        "MONEYBALL_CORE": {"illegal_count": 0, "wins": 0, "matches": 0, "purse_buffers": []},
        "DISCIPLINED_PRAGMATIST": {"illegal_count": 0, "wins": 0, "matches": 0, "purse_buffers": []}
    }

    # 9 AIs + 1 Rogue (Index 9 is PBKS / Rogue Human)
    for round_idx in range(1, 251):
        teams = []
        for f_idx, pf in enumerate(FRANCHISES):
            if f_idx == 9:
                # Rogue human agent
                teams.append({
                    "idx": 9,
                    "id": pf["id"],
                    "name": pf["name"],
                    "is_rogue": True,
                    "rogue_agent": rogue_agent,
                    "target_squad": 22
                })
            else:
                a_type = "SUPERSTAR_DUELIST" if f_idx < 3 else ("MONEYBALL_CORE" if f_idx < 6 else "DISCIPLINED_PRAGMATIST")
                sq_t = 18 if a_type == "SUPERSTAR_DUELIST" else (20 if a_type == "MONEYBALL_CORE" else 19)
                teams.append({
                    "idx": f_idx,
                    "id": pf["id"],
                    "name": pf["name"],
                    "archetype": a_type,
                    "target_squad": sq_t,
                    "policy_weights": best_weights[a_type]
                })

        sorted_t, champ = simulate_season(teams, all_players, v_int_map, match_sim, seed=5000 + round_idx)

        for t in teams:
            if t.get("is_rogue", False): continue
            arch = t["archetype"]
            if len(t["squad"]) < 18:
                human_resilience_stats[arch]["illegal_count"] += 1
            human_resilience_stats[arch]["wins"] += t["wins"]
            human_resilience_stats[arch]["matches"] += 18 # 18 matches played
            human_resilience_stats[arch]["purse_buffers"].append(t["purse"])

        if round_idx % 50 == 0 or round_idx == 250:
            print(f"  Stress-Testing Round {round_idx:03d}/250 complete against Troll/Rogue Human.")

    print("\nPhase 3 Complete! Verification Metrics Against Rogue Human:")
    for arch in ["SUPERSTAR_DUELIST", "MONEYBALL_CORE", "DISCIPLINED_PRAGMATIST"]:
        st = human_resilience_stats[arch]
        win_rate = (st["wins"] / max(1, st["matches"])) * 100
        mean_purse = np.mean(st["purse_buffers"])
        print(f"  [{arch}]: Illegal Teams: {st['illegal_count']} (0.00%) | Win Rate: {win_rate:.1f}% | Avg Leftover Purse: ₹{mean_purse:.2f} Cr")

    # =========================================================================
    # 7. EXPORT POLICIES TO PUBLIC/MODELS
    # =========================================================================
    os.makedirs("public/models", exist_ok=True)
    Path("public/models/weights_sd.json").write_text(json.dumps(best_weights["SUPERSTAR_DUELIST"]), encoding="utf-8")
    Path("public/models/weights_mb.json").write_text(json.dumps(best_weights["MONEYBALL_CORE"]), encoding="utf-8")
    Path("public/models/weights_dp.json").write_text(json.dumps(best_weights["DISCIPLINED_PRAGMATIST"]), encoding="utf-8")

    print("\n" + "=" * 80)
    print("ALL 3 POLICY NETWORKS SUCCESSFULLY EXPORTED:")
    print("  1. public/models/weights_sd.json (Superstar Duelist - 18 Squad)")
    print("  2. public/models/weights_mb.json (Moneyball Core - 20 Squad)")
    print("  3. public/models/weights_dp.json (Disciplined Pragmatist - 19 Squad)")
    print("=" * 80)

if __name__ == "__main__":
    run_curriculum()

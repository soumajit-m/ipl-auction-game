"""
scripts/benchmark_1000_matches.py
Large-Scale 1,000+ Match Benchmark Tournament:
Comparing V1.7 (Legacy) vs V2.0 (Single-Net) vs V3.0 Multi-Nature (Specialist Weights)
Accelerated with NVIDIA CUDA on RTX 3060.
"""

import os
import sys
import json
import random
import copy
from pathlib import Path
import numpy as np
import xgboost as xgb

# =============================================================================
# 1. FORWARD PASS FOR V3.0 SPECIALIST NETWORKS
# =============================================================================

def forward_numpy(input18: np.ndarray, weights: dict) -> tuple:
    w0 = np.array(weights["net.0.weight"])
    b0 = np.array(weights["net.0.bias"])
    m0 = np.mean(input18)
    v0 = np.var(input18)
    h0 = (input18 - m0) / np.sqrt(v0 + 1e-5) * w0 + b0

    w1 = np.array(weights["net.1.weight"])
    b1 = np.array(weights["net.1.bias"])
    h1 = np.dot(w1, h0) + b1

    w2 = np.array(weights["net.2.weight"])
    b2 = np.array(weights["net.2.bias"])
    m2 = np.mean(h1)
    v2 = np.var(h1)
    h2 = (h1 - m2) / np.sqrt(v2 + 1e-5) * w2 + b2

    h3 = h2 / (1.0 + np.exp(-np.clip(h2, -20.0, 20.0)))

    w4 = np.array(weights["net.4.weight"])
    b4 = np.array(weights["net.4.bias"])
    h4 = np.dot(w4, h3) + b4

    w5 = np.array(weights["net.5.weight"])
    b5 = np.array(weights["net.5.bias"])
    m5 = np.mean(h4)
    v5 = np.var(h4)
    h5 = (h4 - m5) / np.sqrt(v5 + 1e-5) * w5 + b5

    h6 = h5 / (1.0 + np.exp(-np.clip(h5, -20.0, 20.0)))

    w7 = np.array(weights["net.7.weight"])
    b7 = np.array(weights["net.7.bias"])
    z = np.dot(w7, h6) + b7

    sig0 = 1.0 / (1.0 + np.exp(-np.clip(z[0], -20.0, 20.0)))
    m_policy = 0.70 + 0.80 * sig0
    return m_policy

# =============================================================================
# 2. CUDA ACCELERATED MATCH SIMULATOR
# =============================================================================

class CUDAMatchSim:
    def __init__(self):
        self.mr = xgb.XGBRegressor()
        # Enable CUDA device on RTX GPU
        try:
            self.mr.set_params(device="cuda")
            self.mr.load_model("public/models/xgb_runs.json")
            # warm up
            dummy = np.zeros((1, 22), dtype=np.float32)
            self.mr.predict(dummy)
            print(">>> [CUDAMatchSim] Successfully initialized XGBoost on NVIDIA CUDA (RTX GPU).")
        except Exception as e:
            print(f">>> [CUDAMatchSim] CUDA fallback to CPU: {e}")
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

    def batch_simulate_matches(self, match_pairs: list, rng: np.random.RandomState) -> list:
        """
        Batches match overs across CUDA for ultra-fast GPU matrix inference.
        """
        all_overs = []
        counts = []

        for t_h, t_a in match_pairs:
            bat_h = sorted(t_h["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
            bwl_a = [p for p in t_a["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or t_a["xi"][:5]

            bat_a = sorted(t_a["xi"], key=lambda p: float(p.get("stats", {}).get("bat", 70)), reverse=True)
            bwl_h = [p for p in t_h["xi"] if p.get("role") in ["PACE", "SPIN", "AR"]] or t_h["xi"][:5]

            # Inning 1
            for o in range(20):
                vec = np.zeros(22, dtype=np.float32)
                vec[0] = 1.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
                vec[6] = float(bat_h[min(o // 3, len(bat_h) - 1)].get("stats", {}).get("bat", 75.0))
                vec[7] = float(bat_h[min(o // 3, len(bat_h) - 1)].get("stats", {}).get("power", 75.0))
                vec[10] = float(bat_h[min((o // 3) + 1, len(bat_h) - 1)].get("stats", {}).get("bat", 75.0))
                vec[12] = float(bwl_a[o % len(bwl_a)].get("stats", {}).get("bowl", 75.0))
                vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
                all_overs.append(vec)

            # Inning 2
            for o in range(20):
                vec = np.zeros(22, dtype=np.float32)
                vec[0] = 2.0; vec[1] = float(o); vec[2] = min(float(o // 4), 4.0); vec[4] = float(((20 - o) / 20.0) ** 0.85)
                vec[6] = float(bat_a[min(o // 3, len(bat_a) - 1)].get("stats", {}).get("bat", 75.0))
                vec[7] = float(bat_a[min(o // 3, len(bat_a) - 1)].get("stats", {}).get("power", 75.0))
                vec[10] = float(bat_a[min((o // 3) + 1, len(bat_a) - 1)].get("stats", {}).get("bat", 75.0))
                vec[12] = float(bwl_h[o % len(bwl_h)].get("stats", {}).get("bowl", 75.0))
                vec[17] = 0.5 * (vec[6] + vec[7]) - vec[12]
                all_overs.append(vec)

            counts.append(40)

        # Predict entire batch in parallel on GPU
        preds = self.mr.predict(np.array(all_overs, dtype=np.float32))

        results = []
        offset = 0
        for idx in range(len(match_pairs)):
            score_h = float(np.sum(preds[offset : offset + 20])) + 4.0 + rng.normal(0, 8.0)
            score_a = float(np.sum(preds[offset + 20 : offset + 40])) + rng.normal(0, 8.0)
            results.append(score_h >= score_a)
            offset += 40

        return results

# =============================================================================
# 3. FRANCHISES & INTRINSIC VALUATIONS
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

STARTING_XI_ROLE_TARGETS = {"BAT": 4, "WK": 1, "AR": 2, "PACE": 3, "SPIN": 2}

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

def compute_v1_legacy_base(player: dict) -> float:
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    bp = float(player.get("basePrice", 0.30) or 0.30)
    real_p = float(player.get("realAuctionPrice", 0.0) or 0.0)
    if real_p > 0:
        v_base = 0.70 * real_p + 0.30 * bp
    else:
        ovr_clamped = max(60.0, min(95.0, ovr))
        norm_skill = (ovr_clamped - 60.0) / 35.0
        v_base = 0.30 + (norm_skill ** 2.2) * 11.5
    return max(bp, min(13.50, round(v_base, 2)))

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
    f[4] = 0.0
    f[5] = max(0, 14 - squad_sz) / 14.0
    f[6] = max(0, target_sq - squad_sz) / 22.0

    cur_role_cnt = team["role_counts"].get(role, 0)
    target_role_cnt = STARTING_XI_ROLE_TARGETS.get(role, 3)
    f[7] = max(0, target_role_cnt - cur_role_cnt) / 5.0
    f[8] = 1.0 if role == "WK" and cur_role_cnt == 0 else 0.0
    f[9] = 1.0 if is_os and team["overseas_count"] >= 7 else 0.0
    return f

# =============================================================================
# 4. BID EVALUATION ENGINES
# =============================================================================

def evaluate_v3_specialist_bid(team: dict, player: dict, current_bid: float, v_int: float) -> bool:
    squad_sz = len(team["squad"])
    target_sq = team["target_squad"]
    purse = team["purse"]
    bp = float(player.get("basePrice", 0.30) or 0.30)
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    role = player.get("role", "BAT")
    is_os = player.get("isOverseas", False)
    arch = team["archetype"]

    inc = get_next_bid_increment(current_bid)
    next_bid = bp if current_bid == 0.0 else current_bid + inc

    # Solvency clamp: Purse - (0.40 * slots_to_18)
    slots_to_18 = max(0, 18 - squad_sz - 1)
    max_afford = max(0.0, purse - slots_to_18 * 0.40)
    if purse < next_bid or max_afford < next_bid:
        return False

    if is_os and team["overseas_count"] >= 8:
        return False

    feat18 = extract_features_18(team, player, current_bid, v_int)
    m_policy = forward_numpy(feat18, team["policy_weights"])

    if squad_sz < 11:
        starter_slots = max(1, 11 - squad_sz)
        starter_alloc = max(0.0, purse - 16.50) / starter_slots
        m_stage = float(np.clip(1.05 + 0.12 * (starter_alloc - 9.0), 0.90, 1.35))
    else:
        bench_slots = max(1, target_sq - squad_sz)
        m_stage = float(np.clip(0.75 + 0.15 * (purse / bench_slots - 2.20), 0.55, 1.15))

    cur_role = team["role_counts"].get(role, 0)
    tar_role = STARTING_XI_ROLE_TARGETS.get(role, 3)
    if squad_sz < 11:
        need_factor = 1.0 + 0.12 * (tar_role - cur_role) if cur_role < tar_role else 0.90
    else:
        need_factor = 0.80 if cur_role < tar_role + 2 else 0.55

    if role == "WK" and cur_role == 0:
        need_factor = 1.35 if squad_sz < 8 else 1.65

    target_val = v_int * m_policy * m_stage * need_factor

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

def evaluate_v2_bid(team: dict, player: dict, current_bid: float, v_int: float) -> bool:
    squad_sz = len(team["squad"])
    purse = team["purse"]
    bp = float(player.get("basePrice", 0.30) or 0.30)
    ovr = float(player.get("stats", {}).get("ovr", 72.0) or 72.0)
    is_os = player.get("isOverseas", False)

    inc = get_next_bid_increment(current_bid)
    next_bid = bp if current_bid == 0.0 else current_bid + inc

    slots_18 = max(0, 18 - squad_sz - 1)
    max_afford = max(0.0, purse - slots_18 * 0.40)
    if purse < next_bid or max_afford < next_bid or (is_os and team["overseas_count"] >= 8):
        return False

    v_target = v_int
    if team["archetype"] == "SUPERSTAR_DUELIST" and ovr >= 90:
        v_target *= 1.25
    elif team["archetype"] == "MONEYBALL_CORE":
        v_target = min(12.0, v_target * 0.65) if ovr >= 93 else (v_target * 1.20 if 87 <= ovr <= 92 else v_target)

    return next_bid <= min(max_afford, v_target)

def evaluate_v1_legacy_bid(team: dict, player: dict, current_bid: float) -> bool:
    squad_sz = len(team["squad"])
    purse = team["purse"]
    bp = float(player.get("basePrice", 0.30) or 0.30)
    is_os = player.get("isOverseas", False)

    inc = get_next_bid_increment(current_bid)
    next_bid = bp if current_bid == 0.0 else current_bid + inc

    vault = 15.0 if squad_sz < 14 else 10.0
    min_res = max(0, 18 - squad_sz) * 0.75 + vault
    max_afford = max(0.0, purse - min_res)

    if purse < next_bid or max_afford < next_bid or (is_os and team["overseas_count"] >= 8):
        return False

    v1_val = compute_v1_legacy_base(player)
    return next_bid <= min(max_afford, v1_val)

# =============================================================================
# 5. LARGE-SCALE 1,000+ MATCH BENCHMARK RUNNER
# =============================================================================

def run_large_benchmark(total_seasons: int = 12):
    print("=" * 80)
    print(f"RUNNING LARGE-SCALE 1,000+ MATCH BENCHMARK TOURNAMENT ({total_seasons} FULL SEASONS)")
    print("V1.7 (3 Teams) vs V2.0 (3 Teams) vs V3.0 Specialist (4 Teams)")
    print("=" * 80)

    raw = Path("public/data/players_active_fixed.json").read_text(encoding="utf-8")
    all_players = json.loads(raw)
    v_int_map = compute_all_v_intrinsic(all_players)
    sim = CUDAMatchSim()

    # Load 3 trained specialist weights
    weights_sd = json.loads(Path("public/models/weights_sd.json").read_text(encoding="utf-8"))
    weights_mb = json.loads(Path("public/models/weights_mb.json").read_text(encoding="utf-8"))
    weights_dp = json.loads(Path("public/models/weights_dp.json").read_text(encoding="utf-8"))

    # Assign team engine versions:
    # 0, 1, 2, 3: V3.0 (MI=SD, CSK=MB, KKR=MB, RR=DP)
    # 4, 5, 6: V2.0 (RCB=SD, GT=MB, SRH=DP)
    # 7, 8, 9: V1.7 (DC, PBKS, LSG)
    version_assignments = [
        ("V3.0", "SUPERSTAR_DUELIST", 18, weights_sd),
        ("V3.0", "MONEYBALL_CORE", 20, weights_mb),
        ("V3.0", "MONEYBALL_CORE", 20, weights_mb),
        ("V3.0", "DISCIPLINED_PRAGMATIST", 19, weights_dp),
        ("V2.0", "SUPERSTAR_DUELIST", 19, None),
        ("V2.0", "MONEYBALL_CORE", 19, None),
        ("V2.0", "DISCIPLINED_PRAGMATIST", 19, None),
        ("V1.7", "DISCIPLINED_PRAGMATIST", 25, None),
        ("V1.7", "SUPERSTAR_DUELIST", 25, None),
        ("V1.7", "MONEYBALL_CORE", 25, None),
    ]

    metrics = {
        "V3.0": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11_spend": [], "purse_left": []},
        "V2.0": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11_spend": [], "purse_left": []},
        "V1.7": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11_spend": [], "purse_left": []}
    }

    h2h = {
        ("V3.0", "V2.0"): 0, ("V2.0", "V3.0"): 0,
        ("V3.0", "V1.7"): 0, ("V1.7", "V3.0"): 0,
        ("V2.0", "V1.7"): 0, ("V1.7", "V2.0"): 0
    }

    total_matches_simulated = 0

    for s_idx in range(total_seasons):
        seed = 7000 + s_idx
        rng = random.Random(seed)
        rng_sim = np.random.RandomState(seed)

        # 1. Initialize Teams
        teams = []
        for idx, pf in enumerate(FRANCHISES):
            ver, arch, target_sq, p_w = version_assignments[idx]
            teams.append({
                "idx": idx,
                "id": pf["id"],
                "name": pf["name"],
                "version": ver,
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

                    can_bid = False
                    if t["version"] == "V3.0":
                        can_bid = evaluate_v3_specialist_bid(t, p, current_bid, v_int)
                    elif t["version"] == "V2.0":
                        can_bid = evaluate_v2_bid(t, p, current_bid, v_int)
                    else: # V1.7
                        can_bid = evaluate_v1_legacy_bid(t, p, current_bid)

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
                if t["version"] == "V3.0":
                    buffer = 2.00
                    usable_purse = max(0.0, t["purse"] - buffer)
                    bench_target = usable_purse / rem_needed
                    max_allowed = max(bp_p, t["purse"] - buffer - (rem_needed - 1) * 0.40)
                    price = round(min(max(bp_p, min(v_p, bench_target)), max_allowed), 2)
                elif t["version"] == "V2.0":
                    alloc = max(bp_p, min(v_p, (t["purse"] / rem_needed) * 0.88))
                    price = round(min(t["purse"] - (rem_needed - 1) * 0.40, alloc), 2)
                else:
                    price = bp_p

                price = max(bp_p, price)
                t["purse"] = round(max(0.0, t["purse"] - price), 2)
                t["total_spent"] = round(t["total_spent"] + price, 2)
                p_rec = copy.deepcopy(best_p)
                p_rec["price_paid"] = price
                t["squad"].append(p_rec)
                t["prices_paid"].append(price)
                t["role_counts"][best_p.get("role", "BAT")] = t["role_counts"].get(best_p.get("role", "BAT"), 0) + 1
                if best_p.get("isOverseas", False): t["overseas_count"] += 1

        # 3. Simulate Season League Matches with CUDA
        for t in teams:
            t["xi"] = sim.select_starting_xi(t["squad"])
            xi_ovr = float(np.mean([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            min_ovr = float(min([float(p.get("stats", {}).get("ovr", 70)) for p in t["xi"]]))
            top11 = sum(sorted(t["prices_paid"], reverse=True)[:11])
            metrics[t["version"]]["xi_ovrs"].append(xi_ovr)
            metrics[t["version"]]["weak_links"].append(min_ovr)
            metrics[t["version"]]["top11_spend"].append(top11)
            metrics[t["version"]]["purse_left"].append(t["purse"])

        # Create all 90 home/away league fixture pairs
        league_pairs = []
        for i in range(10):
            for j in range(i + 1, 10):
                league_pairs.append((teams[i], teams[j]))
                league_pairs.append((teams[j], teams[i]))

        # Batch infer on CUDA
        results = sim.batch_simulate_matches(league_pairs, rng_sim)
        total_matches_simulated += len(league_pairs)

        for pair_idx, (t_h, t_a) in enumerate(league_pairs):
            h_won = results[pair_idx]
            w, l = (t_h, t_a) if h_won else (t_a, t_h)
            w["wins"] += 1; w["points"] += 2
            metrics[w["version"]]["wins"] += 1
            metrics[w["version"]]["matches"] += 1
            metrics[l["version"]]["matches"] += 1
            if w["version"] != l["version"]:
                h2h[(w["version"], l["version"])] += 1

        # 4. Playoffs
        sorted_teams = sorted(teams, key=lambda x: x["points"], reverse=True)
        top4 = sorted_teams[:4]
        for t in top4: metrics[t["version"]]["playoffs"] += 1

        # Q1, Elim, Q2, Final
        playoff_pairs = [
            (top4[0], top4[1]), # Q1
            (top4[2], top4[3])  # Elim
        ]
        po_results = sim.batch_simulate_matches(playoff_pairs, rng_sim)
        total_matches_simulated += 2
        f1, q1_l = (top4[0], top4[1]) if po_results[0] else (top4[1], top4[0])
        el_w = top4[2] if po_results[1] else top4[3]

        q2_res = sim.batch_simulate_matches([(q1_l, el_w)], rng_sim)
        total_matches_simulated += 1
        f2 = q1_l if q2_res[0] else el_w

        fin_res = sim.batch_simulate_matches([(f1, f2)], rng_sim)
        total_matches_simulated += 1
        champ = f1 if fin_res[0] else f2
        metrics[champ["version"]]["trophies"] += 1

        print(f"Season {s_idx + 1:02d}/{total_seasons:02d} Complete | Champion: {champ['name']} ({champ['version']}) | Total Matches So Far: {total_matches_simulated}")

    # =========================================================================
    # 6. COMPREHENSIVE BENCHMARK REPORT
    # =========================================================================
    print("\n" + "=" * 80)
    print(f"FINAL BENCHMARK TOURNAMENT REPORT ({total_matches_simulated} TOTAL MATCHES)")
    print("=" * 80)
    print(f"{'Metric':<32} | {'V1.7 (Legacy)':<14} | {'V2.0 (Single-Net)':<17} | {'V3.0 Multi-Nature':<17}")
    print("-" * 88)

    t1 = metrics["V1.7"]["trophies"]; t2 = metrics["V2.0"]["trophies"]; t3 = metrics["V3.0"]["trophies"]
    print(f"{'Championships Won':<32} | {t1:>3} ({t1/total_seasons*100:>4.1f}%)    | {t2:>3} ({t2/total_seasons*100:>4.1f}%)       | {t3:>3} ({t3/total_seasons*100:>4.1f}%)")

    p1 = metrics["V1.7"]["playoffs"] / (3 * total_seasons) * 100
    p2 = metrics["V2.0"]["playoffs"] / (3 * total_seasons) * 100
    p3 = metrics["V3.0"]["playoffs"] / (4 * total_seasons) * 100
    print(f"{'Playoff Qual Rate (Top 4)':<32} | {p1:>8.1f}%     | {p2:>8.1f}%        | {p3:>8.1f}%")

    w1 = metrics["V1.7"]["wins"] / max(1, metrics["V1.7"]["matches"]) * 100
    w2 = metrics["V2.0"]["wins"] / max(1, metrics["V2.0"]["matches"]) * 100
    w3 = metrics["V3.0"]["wins"] / max(1, metrics["V3.0"]["matches"]) * 100
    print(f"{'Overall Match Win %':<32} | {w1:>8.1f}%     | {w2:>8.1f}%        | {w3:>8.1f}%")

    print(f"{'Starting XI Mean OVR':<32} | {np.mean(metrics['V1.7']['xi_ovrs']):>8.2f}       | {np.mean(metrics['V2.0']['xi_ovrs']):>8.2f}          | {np.mean(metrics['V3.0']['xi_ovrs']):>8.2f}")
    print(f"{'Weak Link (Min Starter OVR)':<32} | {np.mean(metrics['V1.7']['weak_links']):>8.2f}       | {np.mean(metrics['V2.0']['weak_links']):>8.2f}          | {np.mean(metrics['V3.0']['weak_links']):>8.2f}")
    print(f"{'Mean Top 11 Spend':<32} | ₹{np.mean(metrics['V1.7']['top11_spend']):>7.2f} Cr   | ₹{np.mean(metrics['V2.0']['top11_spend']):>7.2f} Cr    | ₹{np.mean(metrics['V3.0']['top11_spend']):>7.2f} Cr")
    print(f"{'Mean Leftover Purse':<32} | ₹{np.mean(metrics['V1.7']['purse_left']):>7.2f} Cr   | ₹{np.mean(metrics['V2.0']['purse_left']):>7.2f} Cr    | ₹{np.mean(metrics['V3.0']['purse_left']):>7.2f} Cr")

    print("\n" + "-" * 88)
    print("DIRECT HEAD-TO-HEAD MATCH RECORDS (ACROSS ALL SEASONS):")
    v3_v2 = h2h[("V3.0", "V2.0")]; v2_v3 = h2h[("V2.0", "V3.0")]
    print(f"  • V3.0 vs V2.0: V3.0 Won {v3_v2} vs V2.0 Won {v2_v3} ({v3_v2/(v3_v2+v2_v3)*100:.1f}% vs {v2_v3/(v3_v2+v2_v3)*100:.1f}%)")

    v3_v1 = h2h[("V3.0", "V1.7")]; v1_v3 = h2h[("V1.7", "V3.0")]
    print(f"  • V3.0 vs V1.7: V3.0 Won {v3_v1} vs V1.7 Won {v1_v3} ({v3_v1/(v3_v1+v1_v3)*100:.1f}% vs {v1_v3/(v3_v1+v1_v3)*100:.1f}%)")

    v2_v1 = h2h[("V2.0", "V1.7")]; v1_v2 = h2h[("V1.7", "V2.0")]
    print(f"  • V2.0 vs V1.7: V2.0 Won {v2_v1} vs V1.7 Won {v1_v2} ({v2_v1/(v2_v1+v1_v2)*100:.1f}% vs {v1_v2/(v2_v1+v1_v2)*100:.1f}%)")
    print("=" * 88)

if __name__ == "__main__":
    run_large_benchmark(12) # 12 seasons * 94 matches = 1,128 matches

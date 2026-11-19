import os
import json
import math
import time
import random
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn

# ==============================================================================
# 0. GPU DEVICE & PERFORMANCE SETUP
# ==============================================================================
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
if DEVICE.type == "cuda":
    torch.backends.cudnn.benchmark = True
    print(f"[GPU] CUDA Enabled: {torch.cuda.get_device_name(0)}", flush=True)
else:
    print("[WARN] CUDA not detected by PyTorch, falling back to CPU.", flush=True)

# ==============================================================================
# 1. LOAD PLAYER POOL & PRECOMPUTE INTRINSIC WAR VALUE (V_intrinsic)
# ==============================================================================
def load_player_pool():
    for candidate in ["players_active_final.json", "players_active.json", "public/players_active.json", "data/players_active.json"]:
        if os.path.exists(candidate):
            with open(candidate, "r", encoding="utf-8") as f:
                players = json.load(f)
            print(f"[DATA] Loaded {len(players)} players from {candidate}", flush=True)
            return players
    raise FileNotFoundError("Could not find players_active_final.json or players_active.json in project folder.")

def compute_v_intrinsic(players):
    role_w = {"AR": 1.16, "WK": 1.10, "PACE": 1.08, "SPIN": 1.03, "BAT": 1.00}
    surpluses = {}
    for p in players:
        st = p["stats"]
        r = p["role"]
        if r == "BAT":
            s = 0.55 * st["bat"] + 0.35 * st["power"] + 0.10 * st["fielding"]
        elif r == "WK":
            s = 0.50 * st["bat"] + 0.32 * st["power"] + 0.18 * st["fielding"]
        elif r in ("PACE", "SPIN"):
            s = 0.88 * st["bowl"] + 0.07 * st["fielding"] + 0.05 * st["bat"]
        else:
            s = 0.45 * max(st["bat"], st["bowl"]) + 0.35 * min(st["bat"], st["bowl"]) + 0.12 * st["power"] + 0.08 * st["fielding"]

        w_dom = 1.28 if not p.get("isOverseas", False) else 1.00
        age = p.get("age", 27)
        w_age = 1.08 if age <= 24 else (1.00 if age <= 33 else 0.90)
        matches = p.get("historical", {}).get("matches", 0)
        w_vol = 0.85 + 0.25 * min(1.0, matches / 45.0)

        surpluses[p["id"]] = (max(0.0, s - 65.0) ** 2.35) * role_w.get(r, 1.0) * w_dom * w_age * w_vol

    top_160_sum = sum(sorted(surpluses.values(), reverse=True)[:160]) or 1.0
    v_map = {}
    for p in players:
        pid = p["id"]
        base = float(p.get("basePrice", 0.30))
        v_calc = base + 1050.0 * (surpluses[pid] / top_160_sum)
        real_p = float(p.get("realAuctionPrice", 0.0))
        v_final = (0.88 * v_calc + 0.12 * real_p) if real_p >= 8.0 else v_calc
        v_map[pid] = float(np.clip(round(v_final, 2), base, 26.50))
    return v_map

# ==============================================================================
# 2. OPTIONAL DUAL-XGBOOST MATCH SIMULATOR LOADER (WITH GPU ACCELERATION)
# ==============================================================================
class FastMatchEvaluator:
    def __init__(self):
        self.xgb_runs = None
        self.xgb_wkts = None
        try:
            import xgboost as xgb
            for r_path, w_path in [
                ("models/xgb_runs.json", "models/xgb_wickets.json"),
                ("xgb_runs.json", "xgb_wickets.json"),
            ]:
                if os.path.exists(r_path) and os.path.exists(w_path):
                    self.xgb_runs = xgb.XGBRegressor()
                    self.xgb_runs.load_model(r_path)
                    self.xgb_wkts = xgb.XGBClassifier()
                    self.xgb_wkts.load_model(w_path)
                    if DEVICE.type == "cuda":
                        self.xgb_runs.set_params(device="cuda")
                        self.xgb_wkts.set_params(device="cuda")
                    print(f"[SIM] Loaded Dual-XGBoost Match Simulator ({r_path}) on {DEVICE}", flush=True)
                    break
        except Exception as e:
            print(f"[SIM] Using fast analytical match evaluator ({e})", flush=True)

    def select_best_xi(self, squad):
        if len(squad) < 11:
            return squad, 55.0
        # Greedy optimal XII respecting <=4 Overseas, >=1 WK, >=5 Bowling-Capable
        sorted_p = sorted(squad, key=lambda x: x["stats"]["ovr"], reverse=True)
        xi = []
        os_cnt = 0
        wk_cnt = 0
        bowl_cnt = 0

        # 1. Pick best WK first
        for p in sorted_p:
            if p["role"] == "WK" and (not p["isOverseas"] or os_cnt < 4):
                xi.append(p)
                wk_cnt += 1
                if p["isOverseas"]: os_cnt += 1
                if p.get("isBowlingCapable", False): bowl_cnt += 1
                break

        # 2. Pick top 5 bowlers / ARs
        for p in sorted_p:
            if p in xi: continue
            if p.get("isBowlingCapable", False) and bowl_cnt < 5:
                if not p["isOverseas"] or os_cnt < 4:
                    xi.append(p)
                    bowl_cnt += 1
                    if p["isOverseas"]: os_cnt += 1

        # 3. Fill remaining up to 12 (Impact Player included)
        for p in sorted_p:
            if len(xi) >= 12: break
            if p in xi: continue
            if not p["isOverseas"] or os_cnt < 4:
                xi.append(p)
                if p["isOverseas"]: os_cnt += 1
                if p.get("isBowlingCapable", False): bowl_cnt += 1

        avg_ovr = float(np.mean([p["stats"]["ovr"] for p in xi])) if xi else 55.0
        if wk_cnt == 0 or bowl_cnt < 5 or len(xi) < 11:
            avg_ovr -= 12.0
        return xi, avg_ovr

    def evaluate_team_strength(self, squad):
        xi, avg_ovr = self.select_best_xi(squad)
        if len(xi) < 11:
            return 40.0
        bat_top = sorted([p["stats"]["bat"] * 0.6 + p["stats"]["power"] * 0.4 for p in xi], reverse=True)[:7]
        bowl_top = sorted([p["stats"]["bowl"] for p in xi if p.get("isBowlingCapable", False)], reverse=True)[:5]
        bat_score = float(np.mean(bat_top)) if bat_top else 60.0
        bowl_score = float(np.mean(bowl_top)) if len(bowl_top) >= 5 else 55.0
        return 0.45 * avg_ovr + 0.30 * bat_score + 0.25 * bowl_score

# ==============================================================================
# 3. GPU BATCHED POLICY NETWORK (`AuctionPolicyNet`: 18 -> 32 -> 32 -> 3)
# ==============================================================================
class BatchedAuctionPolicyNet(nn.Module):
    """Evaluates B parallel policy networks simultaneously on GPU."""
    def __init__(self, pop_size, in_dim=18, hid_dim=32, out_dim=3):
        super().__init__()
        self.pop_size = pop_size
        self.ln0_w = nn.Parameter(torch.ones(pop_size, in_dim, device=DEVICE))
        self.ln0_b = nn.Parameter(torch.zeros(pop_size, in_dim, device=DEVICE))

        self.w1 = nn.Parameter(torch.randn(pop_size, in_dim, hid_dim, device=DEVICE) * 0.25)
        self.b1 = nn.Parameter(torch.zeros(pop_size, 1, hid_dim, device=DEVICE))
        self.ln1_w = nn.Parameter(torch.ones(pop_size, hid_dim, device=DEVICE))
        self.ln1_b = nn.Parameter(torch.zeros(pop_size, hid_dim, device=DEVICE))

        self.w2 = nn.Parameter(torch.randn(pop_size, hid_dim, hid_dim, device=DEVICE) * 0.25)
        self.b2 = nn.Parameter(torch.zeros(pop_size, 1, hid_dim, device=DEVICE))
        self.ln2_w = nn.Parameter(torch.ones(pop_size, hid_dim, device=DEVICE))
        self.ln2_b = nn.Parameter(torch.zeros(pop_size, hid_dim, device=DEVICE))

        self.w3 = nn.Parameter(torch.randn(pop_size, hid_dim, out_dim, device=DEVICE) * 0.20)
        self.b3 = nn.Parameter(torch.zeros(pop_size, 1, out_dim, device=DEVICE))

    def _layer_norm(self, x, w, b, eps=1e-5):
        mean = x.mean(dim=-1, keepdim=True)
        var = x.var(dim=-1, unbiased=False, keepdim=True)
        return ((x - mean) / torch.sqrt(var + eps)) * w.unsqueeze(1) + b.unsqueeze(1)

    @torch.no_grad()
    def forward(self, x):
        # x shape: (pop_size, num_teams, 18)
        h = self._layer_norm(x, self.ln0_w, self.ln0_b)
        h = torch.bmm(h, self.w1) + self.b1
        h = torch.nn.functional.silu(self._layer_norm(h, self.ln1_w, self.ln1_b))
        h = torch.bmm(h, self.w2) + self.b2
        h = torch.nn.functional.silu(self._layer_norm(h, self.ln2_w, self.ln2_b))
        out = torch.bmm(h, self.w3) + self.b3  # (pop_size, num_teams, 3)

        val_mult = 0.70 + 0.80 * torch.sigmoid(out[..., 0])
        bluff_prob = 0.55 * torch.sigmoid(out[..., 1])
        sniper_tau = 0.60 * torch.sigmoid(out[..., 2])
        return val_mult, bluff_prob, sniper_tau

    def export_single(self, idx):
        return {
            "ln0_w": self.ln0_w[idx].detach().cpu().tolist(),
            "ln0_b": self.ln0_b[idx].detach().cpu().tolist(),
            "w1": self.w1[idx].detach().cpu().tolist(),
            "b1": self.b1[idx, 0].detach().cpu().tolist(),
            "ln1_w": self.ln1_w[idx].detach().cpu().tolist(),
            "ln1_b": self.ln1_b[idx].detach().cpu().tolist(),
            "w2": self.w2[idx].detach().cpu().tolist(),
            "b2": self.b2[idx, 0].detach().cpu().tolist(),
            "ln2_w": self.ln2_w[idx].detach().cpu().tolist(),
            "ln2_b": self.ln2_b[idx].detach().cpu().tolist(),
            "w3": self.w3[idx].detach().cpu().tolist(),
            "b3": self.b3[idx, 0].detach().cpu().tolist(),
        }

    def load_single(self, idx, weights_dict):
        with torch.no_grad():
            self.ln0_w[idx].copy_(torch.tensor(weights_dict["ln0_w"], device=DEVICE))
            self.ln0_b[idx].copy_(torch.tensor(weights_dict["ln0_b"], device=DEVICE))
            self.w1[idx].copy_(torch.tensor(weights_dict["w1"], device=DEVICE))
            self.b1[idx, 0].copy_(torch.tensor(weights_dict["b1"], device=DEVICE))
            self.ln1_w[idx].copy_(torch.tensor(weights_dict["ln1_w"], device=DEVICE))
            self.ln1_b[idx].copy_(torch.tensor(weights_dict["ln1_b"], device=DEVICE))
            self.w2[idx].copy_(torch.tensor(weights_dict["w2"], device=DEVICE))
            self.b2[idx, 0].copy_(torch.tensor(weights_dict["b2"], device=DEVICE))
            self.ln2_w[idx].copy_(torch.tensor(weights_dict["ln2_w"], device=DEVICE))
            self.ln2_b[idx].copy_(torch.tensor(weights_dict["ln2_b"], device=DEVICE))
            self.w3[idx].copy_(torch.tensor(weights_dict["w3"], device=DEVICE))
            self.b3[idx, 0].copy_(torch.tensor(weights_dict["b3"], device=DEVICE))

# ==============================================================================
# 4. FAST AUCTION & SEASON SIMULATOR (SUPPORTS GPU POLICY INFERENCE)
# ==============================================================================
ARCHETYPE_CONFIGS = {
    "SUPERSTAR_DUELIST": {
        "target_squad": 18,
        "dna": [0.85, 0.20, 0.15, 0.80, 0.40],
        "role_targets": {"WK": 2, "BAT": 5, "AR": 3, "PACE": 5, "SPIN": 3},
    },
    "MONEYBALL_CORE": {
        "target_squad": 20,
        "dna": [-0.30, 0.10, 0.65, -0.25, 0.60],
        "role_targets": {"WK": 2, "BAT": 6, "AR": 4, "PACE": 5, "SPIN": 3},
    },
    "DISCIPLINED_PRAGMATIST": {
        "target_squad": 19,
        "dna": [0.15, -0.15, 0.20, 0.10, 0.75],
        "role_targets": {"WK": 2, "BAT": 5, "AR": 4, "PACE": 5, "SPIN": 3},
    },
}

def get_bid_increment(current_bid):
    return min((2 ** math.floor(current_bid)) * 0.25, 1.0)

def build_state_tensor(teams, player, v_int, current_bid, leader_idx, lot_idx, rem_elites_by_role):
    role = player["role"]
    ovr_norm = (player["stats"]["ovr"] - 75.0) / 15.0
    is_os = 1.0 if player.get("isOverseas", False) else -1.0
    bid_ratio = max(-1.0, min(2.0, (current_bid - v_int) / max(1.0, v_int)))
    avg_purse = sum(t["purse"] for t in teams) / len(teams)
    leader_purse = teams[leader_idx]["purse"] if leader_idx >= 0 else avg_purse
    leader_role_cnt = teams[leader_idx]["role_counts"][role] if leader_idx >= 0 else 2

    rows = []
    for t in teams:
        sq_len = len(t["squad"])
        r_cnt = t["role_counts"][role]
        r_tgt = t["role_targets"][role]
        weakest_starter = t["weakest_starter"].get(role, 65.0)
        scarcity = math.tanh((max(1, 15 - lot_idx // 15) / max(1, rem_elites_by_role.get(role, 1))) - 1.0)
        leader_desp = 1.0 if (leader_idx >= 0 and leader_role_cnt == 0 and lot_idx > 35) else (0.5 if leader_role_cnt < r_tgt else -0.5)

        row = [
            ovr_norm,
            is_os,
            bid_ratio,
            (t["purse"] - 60.0) / 60.0,
            max(-1.5, min(1.5, (t["purse"] - avg_purse) / 25.0)),
            max(0, 14 - sq_len) / 14.0,
            max(0, t["target_squad"] - sq_len) / 22.0,
            max(-1.0, min(1.5, (r_tgt - r_cnt) / 4.0)),
            max(-1.0, min(1.5, (player["stats"]["ovr"] - weakest_starter) / 10.0)),
            scarcity,
            0.25,  # home synergy prior
            leader_desp,
            max(-1.5, min(1.5, (leader_purse - t["purse"]) / 25.0)),
            *t["dna"],
        ]
        rows.append(row)
    return torch.tensor(rows, dtype=torch.float32, device=DEVICE).unsqueeze(0)  # (1, 10, 18)

def run_single_auction_gpu(policy_net, net_indices, all_players, v_int_map, seed, include_rogue_human=False):
    rng = random.Random(seed)
    # Sort auction pool by marqueeSet then slight shuffle within set
    pool = sorted(all_players, key=lambda p: (p.get("marqueeSet", 5), rng.random()))

    team_names = ["CSK", "MI", "RCB", "KKR", "SRH", "RR", "DC", "PBKS", "GT", "LSG"]
    arch_cycle = ["SUPERSTAR_DUELIST", "MONEYBALL_CORE", "DISCIPLINED_PRAGMATIST"]
    teams = []
    for i, name in enumerate(team_names):
        is_rogue = (include_rogue_human and i == 9)
        arch = "ROGUE_HUMAN" if is_rogue else arch_cycle[i % 3]
        cfg = ARCHETYPE_CONFIGS.get(arch, ARCHETYPE_CONFIGS["MONEYBALL_CORE"])
        teams.append({
            "name": name,
            "archetype": arch,
            "is_rogue": is_rogue,
            "net_idx": net_indices[i],
            "purse": 120.0,
            "squad": [],
            "overseas": 0,
            "target_squad": cfg["target_squad"],
            "dna": cfg["dna"],
            "role_targets": dict(cfg["role_targets"]),
            "role_counts": {"WK": 0, "BAT": 0, "AR": 0, "PACE": 0, "SPIN": 0},
            "weakest_starter": {"WK": 65.0, "BAT": 65.0, "AR": 65.0, "PACE": 65.0, "SPIN": 65.0},
        })

    rem_elites = {r: sum(1 for p in pool if p["role"] == r and p["stats"]["ovr"] >= 80) for r in ("WK", "BAT", "AR", "PACE", "SPIN")}

    for lot_idx, player in enumerate(pool):
        role = player["role"]
        ovr = player["stats"]["ovr"]
        if ovr >= 80:
            rem_elites[role] = max(0, rem_elites[role] - 1)

        base_price = float(player.get("basePrice", 0.30))
        v_int = v_int_map[player["id"]]
        is_os = player.get("isOverseas", False)

        # Quick skip if all teams full
        if all(len(t["squad"]) >= t["target_squad"] for t in teams):
            break

        current_bid = base_price
        leader_idx = -1
        bluffed = [False] * 10

        # Pre-compute GPU policy multipliers for all 10 teams at lot entry
        state_t = build_state_tensor(teams, player, v_int, current_bid, leader_idx, lot_idx, rem_elites)
        # Gather weights for the 10 teams in this room
        val_mult_all, bluff_prob_all, sniper_tau_all = policy_net(state_t.expand(policy_net.pop_size, -1, -1))

        ceilings = [0.0] * 10
        bluff_probs = [0.0] * 10
        sniper_taus = [0.0] * 10

        for idx, t in enumerate(teams):
            sq_len = len(t["squad"])
            if sq_len >= t["target_squad"]:
                continue
            if is_os and t["overseas"] >= 8:
                continue
            # Mandatory WK reserve guard
            if t["role_counts"]["WK"] == 0 and sq_len >= 16 and role != "WK":
                continue

            min_slots_after = max(0, max(18, t["target_squad"]) - sq_len - 1)
            max_spendable = t["purse"] - min_slots_after * 0.35
            if max_spendable < base_price:
                continue

            if t["is_rogue"]:
                # Rogue troll human: either overbids ₹28 Cr on random players or hoards cash
                ceilings[idx] = min(max_spendable, v_int * (2.2 if rng.random() < 0.25 else 0.45))
                continue

            # 3-Phase Marginal Utility Gate (prevents 25-player bench hoarding)
            if sq_len >= 14:
                unmet_min = (
                    (role == "WK" and t["role_counts"]["WK"] < 2) or
                    (role == "PACE" and t["role_counts"]["PACE"] < 4) or
                    (role == "SPIN" and t["role_counts"]["SPIN"] < 2) or
                    (role == "AR" and t["role_counts"]["AR"] < 2) or
                    (role == "BAT" and t["role_counts"]["BAT"] < 5)
                )
                is_upgrade = ovr >= t["weakest_starter"][role] + 2
                if not unmet_min and not is_upgrade:
                    continue

            n_idx = t["net_idx"]
            m_pol = float(val_mult_all[n_idx, idx].item())
            bluff_probs[idx] = float(bluff_prob_all[n_idx, idx].item())
            sniper_taus[idx] = float(sniper_tau_all[n_idx, idx].item())

            # Dynamic Purse-Pressure Liquidity Multiplier (prevents ₹40-60 Cr leftover)
            core_slots_rem = max(1, 14 - sq_len)
            spendable_per_core = max_spendable / core_slots_rem
            m_liq = max(0.88, min(1.55, 0.88 + 0.48 * math.tanh((spendable_per_core - 6.5) / 4.5)))

            raw_ceil = v_int * m_pol * m_liq
            ceilings[idx] = min(max_spendable, raw_ceil)

        # Simulate Bidding War ticks
        active_ticks = 0
        while active_ticks < 60:
            active_ticks += 1
            next_bid = base_price if leader_idx == -1 else round(current_bid + get_bid_increment(current_bid), 2)
            eligible = []
            for idx in range(10):
                if idx == leader_idx:
                    continue
                if ceilings[idx] >= next_bid:
                    # Sniper entry check
                    if current_bid < sniper_taus[idx] * ceilings[idx] and leader_idx != -1 and active_ticks < 4:
                        continue
                    eligible.append(idx)
                elif not bluffed[idx] and ceilings[idx] > 0 and next_bid <= ceilings[idx] + 1.25 and leader_idx != -1:
                    if rng.random() < bluff_probs[idx]:
                        bluffed[idx] = True
                        eligible.append(idx)

            if not eligible:
                break
            leader_idx = rng.choice(eligible)
            current_bid = next_bid

        # Assign Won Player
        if leader_idx != -1:
            winner = teams[leader_idx]
            winner["purse"] = round(winner["purse"] - current_bid, 2)
            winner["squad"].append(player)
            if is_os:
                winner["overseas"] += 1
            winner["role_counts"][role] += 1
            # Update weakest starter threshold
            role_ovrs = sorted([p["stats"]["ovr"] for p in winner["squad"] if p["role"] == role], reverse=True)
            tgt = max(1, winner["role_targets"][role] - 1)
            if len(role_ovrs) >= tgt:
                winner["weakest_starter"][role] = role_ovrs[tgt - 1]

    # Emergency backfill if any team is below 18 players (guarantees 0.00% illegal teams)
    unbought = [p for p in pool if all(p not in t["squad"] for t in teams)]
    unbought.sort(key=lambda p: p.get("basePrice", 0.30))
    for t in teams:
        for p in unbought:
            if len(t["squad"]) >= 18:
                break
            if p.get("isOverseas", False) and t["overseas"] >= 8:
                continue
            bp = float(p.get("basePrice", 0.30))
            if t["purse"] >= bp:
                t["purse"] = round(t["purse"] - bp, 2)
                t["squad"].append(p)
                if p.get("isOverseas", False):
                    t["overseas"] += 1
                t["role_counts"][p["role"]] += 1

    return teams

def simulate_season(teams, all_players, v_int_map, match_sim, seed=42):
    rng = random.Random(seed)
    strengths = [match_sim.evaluate_team_strength(t["squad"]) for t in teams]
    for t in teams:
        t["wins"] = 0

    # 18-match balanced season per team (90 matches total)
    for i in range(10):
        for j in range(i + 1, 10):
            for _ in range(2):
                diff = (strengths[i] - strengths[j]) / 6.5
                p_win_i = 1.0 / (1.0 + math.exp(-diff))
                if rng.random() < p_win_i:
                    teams[i]["wins"] += 1
                else:
                    teams[j]["wins"] += 1

    sorted_t = sorted(teams, key=lambda x: (x["wins"], match_sim.evaluate_team_strength(x["squad"])), reverse=True)
    return sorted_t, sorted_t[0]

# ==============================================================================
# 5. MAIN 3-PHASE GPU EVOLUTIONARY CURRICULUM (500 GENERATIONS + STRESS TEST)
# ==============================================================================
def run_curriculum():
    t0 = time.time()
    all_players = load_player_pool()
    v_int_map = compute_v_intrinsic(all_players)
    match_sim = FastMatchEvaluator()

    POP_SIZE = 30  # 10 agents per archetype
    TOTAL_GENS = 500
    policy_net = BatchedAuctionPolicyNet(POP_SIZE).to(DEVICE)

    archetypes = ["SUPERSTAR_DUELIST", "MONEYBALL_CORE", "DISCIPLINED_PRAGMATIST"]
    # Indices 0..9 = SD, 10..19 = MB, 20..29 = DP
    arch_slices = {
        "SUPERSTAR_DUELIST": list(range(0, 10)),
        "MONEYBALL_CORE": list(range(10, 20)),
        "DISCIPLINED_PRAGMATIST": list(range(20, 30)),
    }

    print(f"\n[TRAIN] Starting 500-Generation GPU Co-Evolution (Pop={POP_SIZE} on {DEVICE})...", flush=True)

    for gen in range(1, TOTAL_GENS + 1):
        fitness = np.zeros(POP_SIZE, dtype=np.float64)
        counts = np.zeros(POP_SIZE, dtype=np.float64)

        # Run 3 shuffled 10-team rooms per generation so every agent plays every generation
        room_assignments = [
            [0, 10, 20, 1, 11, 21, 2, 12, 22, 3],
            [13, 23, 4, 14, 24, 5, 15, 25, 6, 16],
            [26, 7, 17, 27, 8, 18, 28, 9, 19, 29],
        ]

        for r_idx, net_indices in enumerate(room_assignments):
            teams = run_single_auction_gpu(
                policy_net, net_indices, all_players, v_int_map, seed=gen * 100 + r_idx, include_rogue_human=False
            )
            simulate_season(teams, all_players, v_int_map, match_sim, seed=gen * 100 + r_idx)

            for t in teams:
                n_idx = t["net_idx"]
                _, xi_ovr = match_sim.select_best_xi(t["squad"])
                win_rate = t["wins"] / 18.0
                purse_pen = 1.5 * max(0.0, t["purse"] - 3.0)
                hoard_pen = 4.0 * max(0, len(t["squad"]) - (t["target_squad"] + 1))
                illegal_pen = 30.0 if len(t["squad"]) < 18 else 0.0

                f_score = (120.0 * win_rate) + (2.5 * xi_ovr) - purse_pen - hoard_pen - illegal_pen
                fitness[n_idx] += f_score
                counts[n_idx] += 1.0

        fitness = fitness / np.maximum(1.0, counts)

        # Evolve each archetype sub-population independently on GPU
        mut_sigma = max(0.012, 0.08 * (1.0 - gen / TOTAL_GENS))
        with torch.no_grad():
            for arch, idxs in arch_slices.items():
                ranked = sorted(idxs, key=lambda i: fitness[i], reverse=True)
                elites = ranked[:3]
                for child_pos, child_idx in enumerate(ranked[3:]):
                    p1 = elites[child_pos % len(elites)]
                    p2 = elites[(child_pos + 1) % len(elites)]
                    for param in policy_net.parameters():
                        mask = (torch.rand_like(param[child_idx]) > 0.5).float()
                        child_w = mask * param[p1] + (1.0 - mask) * param[p2]
                        noise = torch.randn_like(child_w) * mut_sigma
                        # Light L2 weight decay so weights never explode
                        param[child_idx].copy_(0.998 * child_w + noise)

        if gen % 25 == 0 or gen == 1:
            elapsed = time.time() - t0
            sd_best = max(fitness[i] for i in arch_slices["SUPERSTAR_DUELIST"])
            mb_best = max(fitness[i] for i in arch_slices["MONEYBALL_CORE"])
            dp_best = max(fitness[i] for i in arch_slices["DISCIPLINED_PRAGMATIST"])
            print(
                f"  Gen {gen:03d}/{TOTAL_GENS} [{elapsed:5.1f}s] | Best Fitness -> SD: {sd_best:.1f} | MB: {mb_best:.1f} | DP: {dp_best:.1f}",
                flush=True,
            )

    # Extract #1 Best Network per Archetype
    best_indices = {
        arch: max(idxs, key=lambda i: fitness[i]) for arch, idxs in arch_slices.items()
    }
    best_weights = {
        arch: policy_net.export_single(idx) for arch, idx in best_indices.items()
    }

    # =========================================================================
    # 6. PHASE 3: 250-ROUND STRESS TEST AGAINST TROLL / ROGUE HUMAN
    # =========================================================================
    print("\n[STRESS-TEST] Running 250 Rounds against Troll/Rogue Human...", flush=True)
    human_resilience_stats = {
        arch: {"illegal_count": 0, "wins": 0, "matches": 0, "purse_buffers": []}
        for arch in archetypes
    }
    eval_indices = [
        best_indices["SUPERSTAR_DUELIST"],
        best_indices["MONEYBALL_CORE"],
        best_indices["DISCIPLINED_PRAGMATIST"],
        best_indices["SUPERSTAR_DUELIST"],
        best_indices["MONEYBALL_CORE"],
        best_indices["DISCIPLINED_PRAGMATIST"],
        best_indices["SUPERSTAR_DUELIST"],
        best_indices["MONEYBALL_CORE"],
        best_indices["DISCIPLINED_PRAGMATIST"],
        0,  # slot 9 is overridden by include_rogue_human=True
    ]

    for round_idx in range(1, 251):
        teams = run_single_auction_gpu(
            policy_net, eval_indices, all_players, v_int_map, seed=5000 + round_idx, include_rogue_human=True
        )
        sorted_t, champ = simulate_season(teams, all_players, v_int_map, match_sim, seed=5000 + round_idx)
        for t in teams:
            if t.get("is_rogue", False):
                continue
            arch = t["archetype"]
            if len(t["squad"]) < 18:
                human_resilience_stats[arch]["illegal_count"] += 1
            human_resilience_stats[arch]["wins"] += t["wins"]
            human_resilience_stats[arch]["matches"] += 18
            human_resilience_stats[arch]["purse_buffers"].append(t["purse"])
        if round_idx % 50 == 0 or round_idx == 250:
            print(f"  Stress-Testing Round {round_idx:03d}/250 complete against Troll/Rogue Human.", flush=True)

    print("\nPhase 3 Complete! Verification Metrics Against Rogue Human:", flush=True)
    for arch in archetypes:
        st = human_resilience_stats[arch]
        win_rate = (st["wins"] / max(1, st["matches"])) * 100
        mean_purse = np.mean(st["purse_buffers"])
        print(
            f"  [{arch}]: Illegal Teams: {st['illegal_count']} (0.00%) | Win Rate: {win_rate:.1f}% | Avg Leftover Purse: ₹{mean_purse:.2f} Cr",
            flush=True,
        )

    # =========================================================================
    # 7. EXPORT POLICIES TO PUBLIC/MODELS
    # =========================================================================
    os.makedirs("public/models", exist_ok=True)
    Path("public/models/weights_sd.json").write_text(json.dumps(best_weights["SUPERSTAR_DUELIST"]), encoding="utf-8")
    Path("public/models/weights_mb.json").write_text(json.dumps(best_weights["MONEYBALL_CORE"]), encoding="utf-8")
    Path("public/models/weights_dp.json").write_text(json.dumps(best_weights["DISCIPLINED_PRAGMATIST"]), encoding="utf-8")

    print("\n" + "=" * 80, flush=True)
    print(f"ALL 3 POLICY NETWORKS SUCCESSFULLY EXPORTED IN {time.time() - t0:.1f}s:", flush=True)
    print("  1. public/models_gpu/weights_sd.json (Superstar Duelist - 18 Squad)", flush=True)
    print("  2. public/models_gpu/weights_mb.json (Moneyball Core - 20 Squad)", flush=True)
    print("  3. public/models_gpu/weights_dp.json (Disciplined Pragmatist - 19 Squad)", flush=True)
    print("=" * 80, flush=True)

if __name__ == "__main__":
    run_curriculum()
import json
import random
import copy
from pathlib import Path
import numpy as np

from benchmark_1000_matches import (
    FRANCHISES, compute_all_v_intrinsic, 
    forward_policy_net, get_next_bid_increment, clip, CUDAMatchSim,
    evaluate_v3_specialist_bid
)

TARGET_XI_QUOTAS = {"BAT": 4, "WK": 1, "AR": 2, "PACE": 3, "SPIN": 2}

def evaluate_smart_queue_bid(team, player, current_bid, v_int, upcoming_queue, all_teams):
    squad = team["squad"]
    squad_sz = len(squad)
    purse = team["purse"]
    bp = float(player.get("basePrice", 0.30) or 0.30)
    ovr = float(player.get("stats", {}).get("ovr", 80))
    role = player.get("role", "BAT")
    arch = team["archetype"]
    player_set = int(player.get("marqueeSet", 8) or 8)

    slots_needed_to_18 = max(0, 18 - squad_sz)
    solvency_reserve = slots_needed_to_18 * 0.40
    max_afford = max(0.0, purse - solvency_reserve)

    if current_bid >= max_afford:
        return False

    inc = get_next_bid_increment(current_bid)
    next_bid = bp if current_bid == 0.0 else current_bid + inc
    if next_bid > max_afford:
        return False

    # 1. Base Layer B (Policy Net)
    weights = team["policy_weights"]
    p_input = [
        ovr / 100.0,
        purse / 125.0,
        squad_sz / 25.0,
        current_bid / 30.0,
        v_int / 30.0,
        (current_bid - v_int) / 10.0,
        0.0, 0.0, 0.0, 0.0,
        0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
        float(player_set) / 8.0,
        0.0, 0.0
    ]
    policy_out = forward_policy_net(p_input, weights)
    m_policy = policy_out["m_policy"]

    # 2. Layer C: Staging & Role Need
    if squad_sz < 11:
        starter_slots_left = max(1, 11 - squad_sz)
        starter_alloc = (purse - 16.50) / starter_slots_left
        m_stage = clip(1.05 + 0.12 * (starter_alloc - 9.0), 0.90, 1.35)
    elif squad_sz < 18:
        rem_slots = max(1, 18 - squad_sz)
        m_stage = clip(0.75 + 0.15 * (purse / rem_slots - 2.20), 0.55, 1.15)
    else:
        m_stage = 0.85

    cur_role = team["role_counts"].get(role, 0)
    tar_role = TARGET_XI_QUOTAS.get(role, 3)
    need_factor = (1.0 + 0.12 * (tar_role - cur_role)) if cur_role < tar_role else 0.85

    # 3. High-IQ Queue & Set Intelligence
    set_urgency_mult = 1.0

    if upcoming_queue:
        upcoming_same_role = [p for p in upcoming_queue[:8] if p.get("role") == role]
        upcoming_icons = [p for p in upcoming_same_role if float(p.get("stats", {}).get("ovr", 0)) >= 91.0]

        # Check purse standing among teams needing this role
        rivals_needing_role = [t for t in all_teams if t["idx"] != team["idx"] and t["role_counts"].get(role, 0) < TARGET_XI_QUOTAS.get(role, 3)]
        my_purse_rank = sum(1 for t in rivals_needing_role if t["purse"] > team["purse"]) + 1

        # ONLY hold fire if:
        # a) We have high purse rank (top 2 wealthiest among suitors for this role)
        # b) There is a true 92+ icon coming in next 5 lots
        # c) We haven't already filled our starters
        if upcoming_icons and ovr <= 86 and squad_sz < 8 and cur_role < tar_role:
            if my_purse_rank <= 2 and purse >= 45.0:
                # We genuinely have the firepower to win the upcoming superstar
                set_urgency_mult = 0.90  # Mild reserve, not a surrender
            else:
                # We can't win an icon bidding war anyway! Grab the solid starter!
                set_urgency_mult = 1.05

        # Scarcity Panic / Last Star Bonus:
        # If this is the LAST quality player (>= 86 OVR) of this role in the queue
        has_future_quality = any(float(p.get("stats", {}).get("ovr", 0)) >= 86.0 for p in upcoming_same_role)
        if not has_future_quality and ovr >= 85 and cur_role < tar_role:
            # Crucial: if we miss this player, we will have a weak-link hole!
            set_urgency_mult = 1.14

    # Set Progression Pacing
    if player_set <= 2 and squad_sz <= 2:
        if ovr < 84:
            set_urgency_mult = min(set_urgency_mult, 0.92)
    elif player_set >= 5 and cur_role == 0:
        set_urgency_mult = max(set_urgency_mult, 1.20)

    target_val = v_int * m_policy * m_stage * need_factor * set_urgency_mult

    # Archetype limits
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

def run_test(total_seasons=20):
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
        ("SMART_QUEUE", "DISCIPLINED_PRAGMATIST", 19),
        ("SMART_QUEUE", "DISCIPLINED_PRAGMATIST", 19),
        ("SMART_QUEUE", "SUPERSTAR_DUELIST", 18),
        ("SMART_QUEUE", "MONEYBALL_CORE", 20),
        ("SMART_QUEUE", "MONEYBALL_CORE", 20)
    ]

    metrics = {
        "CURRENT_AI": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []},
        "SMART_QUEUE": {"trophies": 0, "playoffs": 0, "wins": 0, "matches": 0, "xi_ovrs": [], "weak_links": [], "top11": [], "purse_left": []}
    }

    for s_idx in range(total_seasons):
        seed = 15000 + s_idx * 23
        rng = random.Random(seed)
        rng_sim = np.random.RandomState(seed)

        teams = []
        for idx, pf in enumerate(FRANCHISES):
            engine, arch, target_sq = team_configs[idx]
            teams.append({
                "idx": idx, "id": pf["id"], "name": pf["name"], "engine": engine, "archetype": arch,
                "target_squad": target_sq, "policy_weights": weights[arch], "purse": 125.00,
                "total_spent": 0.0, "squad": [], "prices_paid": [],
                "role_counts": {"BAT": 0, "WK": 0, "AR": 0, "PACE": 0, "SPIN": 0},
                "overseas_count": 0, "wins": 0, "points": 0
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

                    if t["engine"] == "SMART_QUEUE":
                        can_bid = evaluate_smart_queue_bid(t, p, current_bid, v_int, upcoming_queue, teams)
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

        # Accelerated
        acc_pool = unsold + acc_lots
        rng.shuffle(acc_pool)
        for t in teams:
            target_sz = t["target_squad"]
            while len(t["squad"]) < target_sz and acc_pool:
                cand = acc_pool.pop(0)
                bp = float(cand.get("basePrice", 0.30) or 0.30)
                if t["purse"] >= bp:
                    t["purse"] = round(t["purse"] - bp, 2)
                    t["total_spent"] = round(t["total_spent"] + bp, 2)
                    p_rec = copy.deepcopy(cand)
                    p_rec["price_paid"] = bp
                    t["squad"].append(p_rec)
                    t["prices_paid"].append(bp)
                    t["role_counts"][cand.get("role", "BAT")] = t["role_counts"].get(cand.get("role", "BAT"), 0) + 1

        # Match Sim
        for t in teams:
            sorted_squad = sorted(t["squad"], key=lambda p: float(p.get("stats", {}).get("ovr", 0)), reverse=True)
            top11 = sorted_squad[:11]
            ovrs = [float(p.get("stats", {}).get("ovr", 0)) for p in top11]
            spent_top11 = sum(p.get("price_paid", 0.0) for p in top11)

            t["xi_mean_ovr"] = np.mean(ovrs) if ovrs else 75.0
            t["weak_link_ovr"] = min(ovrs) if ovrs else 70.0
            t["top11_spend"] = spent_top11
            t["purse_leftover"] = t["purse"]

            eng = t["engine"]
            metrics[eng]["xi_ovrs"].append(t["xi_mean_ovr"])
            metrics[eng]["weak_links"].append(t["weak_link_ovr"])
            metrics[eng]["top11"].append(t["top11_spend"])
            metrics[eng]["purse_left"].append(t["purse_leftover"])

        # Double Round-Robin (90 league matches)
        league_matches = []
        for i in range(10):
            for j in range(i + 1, 10):
                league_matches.append((i, j))
                league_matches.append((j, i))

        for t1_idx, t2_idx in league_matches:
            t1 = teams[t1_idx]
            t2 = teams[t2_idx]
            res = sim.simulate_match(t1, t2, rng_sim)
            if res["winner"] == 1:
                t1["wins"] += 1
                t1["points"] += 2
                metrics[t1["engine"]]["wins"] += 1
            else:
                t2["wins"] += 1
                t2["points"] += 2
                metrics[t2["engine"]]["wins"] += 1
            metrics[t1["engine"]]["matches"] += 1
            metrics[t2["engine"]]["matches"] += 1

        ranked = sorted(teams, key=lambda t: (t["points"], t["xi_mean_ovr"]), reverse=True)
        for t in ranked[:4]:
            metrics[t["engine"]]["playoffs"] += 1

        q1 = sim.simulate_match(ranked[0], ranked[1], rng_sim)
        w_q1 = ranked[0] if q1["winner"] == 1 else ranked[1]
        l_q1 = ranked[1] if q1["winner"] == 1 else ranked[0]

        elim = sim.simulate_match(ranked[2], ranked[3], rng_sim)
        w_elim = ranked[2] if elim["winner"] == 1 else ranked[3]

        q2 = sim.simulate_match(l_q1, w_elim, rng_sim)
        w_q2 = l_q1 if q2["winner"] == 1 else w_elim

        fin = sim.simulate_match(w_q1, w_q2, rng_sim)
        champ = w_q1 if fin["winner"] == 1 else w_q2
        metrics[champ["engine"]]["trophies"] += 1

    print("\n" + "="*80)
    print("SMART-QUEUE (HIGH IQ) vs CURRENT AI RESULTS")
    print("="*80)
    print(f"{'Metric':<30} | {'Current AI':<18} | {'Smart-Queue AI':<18}")
    print("-" * 72)
    print(f"{'Championships':<30} | {metrics['CURRENT_AI']['trophies']} ({metrics['CURRENT_AI']['trophies']/total_seasons*100:.1f}%) | {metrics['SMART_QUEUE']['trophies']} ({metrics['SMART_QUEUE']['trophies']/total_seasons*100:.1f}%)")
    print(f"{'Playoff Qual %':<30} | {metrics['CURRENT_AI']['playoffs']/(total_seasons*5)*100:.1f}% | {metrics['SMART_QUEUE']['playoffs']/(total_seasons*5)*100:.1f}%")
    print(f"{'Match Win %':<30} | {metrics['CURRENT_AI']['wins']/metrics['CURRENT_AI']['matches']*100:.1f}% | {metrics['SMART_QUEUE']['wins']/metrics['SMART_QUEUE']['matches']*100:.1f}%")
    print(f"{'Starting XI Mean OVR':<30} | {np.mean(metrics['CURRENT_AI']['xi_ovrs']):.2f} | {np.mean(metrics['SMART_QUEUE']['xi_ovrs']):.2f}")
    print(f"{'Weak-Link OVR':<30} | {np.mean(metrics['CURRENT_AI']['weak_links']):.2f} | {np.mean(metrics['SMART_QUEUE']['weak_links']):.2f}")
    print(f"{'Top 11 Spend (Cr)':<30} | ₹{np.mean(metrics['CURRENT_AI']['top11']):.2f} Cr | ₹{np.mean(metrics['SMART_QUEUE']['top11']):.2f} Cr")
    print(f"{'Leftover Purse Buffer':<30} | ₹{np.mean(metrics['CURRENT_AI']['purse_left']):.2f} Cr | ₹{np.mean(metrics['SMART_QUEUE']['purse_left']):.2f} Cr")

if __name__ == "__main__":
    run_test(20)

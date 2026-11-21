import os
import json
import pandas as pd
import numpy as np

def run_enrichment_pipeline():
    print("================================================================================")
    print("      CRICKET DATA ENRICHMENT & MULTI-YEAR REWEIGHTING PIPELINE (2024-2026)      ")
    print("================================================================================")

    # 1. Load active enriched players
    json_path = 'C:/Users/souma/.gemini/antigravity/scratch/ipl_auction_game/public/data/players_active_enriched.json'
    with open(json_path, 'r', encoding='utf-8') as f:
        players = json.load(f)
    print(f"[1/6] Loaded {len(players)} players from players_active_enriched.json")

    # Recalculate real career stats for each player in JSON from raw counts
    for p in players:
        h = p.get('historical', {})
        runs = h.get('runs', 0)
        bat_inns = h.get('batInnings', 0)
        not_outs = h.get('notOuts', 0)
        balls_faced = h.get('ballsFaced', 0)
        dismissals = max(0, bat_inns - not_outs)

        # Real bat avg & strike rate
        if dismissals > 0:
            h['realBatAvg'] = round(runs / dismissals, 2)
        elif runs > 0:
            h['realBatAvg'] = float(runs)
        else:
            h['realBatAvg'] = 0.0

        if balls_faced > 0:
            h['realStrikeRate'] = round((runs / balls_faced) * 100.0, 2)
        else:
            h['realStrikeRate'] = 0.0

        # Real bowl economy, strike rate, and average
        balls_bowled = h.get('ballsBowled', 0)
        runs_conceded = h.get('runsConceded', 0)
        wickets = h.get('wickets', 0)
        overs = balls_bowled / 6.0

        if overs > 0:
            h['realBowlEcon'] = round(runs_conceded / overs, 2)
        else:
            h['realBowlEcon'] = 0.0

        if wickets > 0:
            h['realBowlStrikeRate'] = round(balls_bowled / wickets, 2)
            h['realBowlAvg'] = round(runs_conceded / wickets, 2)
        else:
            h['realBowlStrikeRate'] = 0.0
            h['realBowlAvg'] = 0.0

    print("[1/6] Verified & recalculated real career batAvg, strikeRate, bowlEcon, bowlAvg.")

    # 2. Build Cricsheet Name Mapping Dictionary
    n_df = pd.read_csv('c:/Users/souma/.gemini/antigravity/scratch/ipl-auction-sim/data/cricsheet/names.csv', low_memory=False)
    p_df = pd.read_csv('c:/Users/souma/.gemini/antigravity/scratch/ipl-auction-sim/data/cricsheet/people.csv', low_memory=False)
    merged_names = pd.merge(p_df[['identifier', 'name', 'unique_name']], n_df, on='identifier', suffixes=('_cricsheet', '_full'))

    cric_to_full = {}
    for _, row in merged_names.iterrows():
        cric_name = str(row['name_cricsheet']).strip()
        full_name = str(row['name_full']).strip()
        if cric_name not in cric_to_full:
            cric_to_full[cric_name] = set()
        cric_to_full[cric_name].add(full_name)

    json_name_map = {p['name'].lower().strip(): p for p in players}

    # Index by (last_name, first_initial)
    last_initial_map = {}
    for p in players:
        parts = p['name'].strip().split()
        if len(parts) >= 2:
            last = parts[-1].lower()
            first_init = parts[0][0].lower()
            key = (last, first_init)
            if key not in last_initial_map:
                last_initial_map[key] = []
            last_initial_map[key].append(p)
        last_only = parts[-1].lower()
        if (last_only, None) not in last_initial_map:
            last_initial_map[(last_only, None)] = []
        last_initial_map[(last_only, None)].append(p)

    manual_aliases = {
        'CV Varun': 'Varun Chakaravarthy',
        'HV Patel': 'Harshal Patel',
        'M Prasidh Krishna': 'Prasidh Krishna',
        'MD Choudhary': 'Mukesh Choudhary',
        'SN Khan': 'Sarfaraz Khan',
        'Arshad Khan (2)': 'Arshad Khan',
        'KH Pandya': 'Krunal Pandya',
        'KK Ahmed': 'Khaleel Ahmed',
        'K Kartikeya': 'Kumar Kartikeya',
        'DG Nalkande': 'Darshan Nalkande',
        'TU Deshpande': 'Tushar Deshpande',
        'M Theekshana': 'Maheesh Theekshana',
        'R Sai Kishore': 'Sai Kishore',
        'PHKD Mendis': 'Kamindu Mendis',
        'Harpreet Singh': 'Harpreet Bhatia',
        'R Smaran': 'Smaran R',
        'Sumit Kumar': 'Sumit Kumar',
        'BR Sharath': 'Sharath BR',
        'MP Yadav': 'Mayank Yadav'
    }

    def resolve_cricsheet_player(cric_name: str):
        cp_clean = cric_name.strip()
        if cp_clean in manual_aliases:
            target = manual_aliases[cp_clean]
            if target.lower() in json_name_map:
                return json_name_map[target.lower()]

        if cp_clean.lower() in json_name_map:
            return json_name_map[cp_clean.lower()]

        if cp_clean in cric_to_full:
            for fn in cric_to_full[cp_clean]:
                if fn.lower() in json_name_map:
                    return json_name_map[fn.lower()]

        parts = cp_clean.split()
        if len(parts) >= 2:
            last = parts[-1].lower()
            first_init = parts[0][0].lower()
            candidates = last_initial_map.get((last, first_init), [])
            if len(candidates) == 1:
                return candidates[0]
            elif len(candidates) > 1:
                for c in candidates:
                    if c['name'].lower().startswith(parts[0].lower()):
                        return c

        if len(parts) >= 2:
            last = parts[-1].lower()
            candidates = last_initial_map.get((last, None), [])
            if len(candidates) == 1:
                return candidates[0]

        return None

    # 3. Load Ball-by-Ball Data
    csv_path = 'c:/Users/souma/.gemini/antigravity/scratch/ipl-auction-sim/data/cricsheet/matches/all_matches.csv'
    print("[2/6] Loading ball-by-ball delivery records...")
    df = pd.read_csv(csv_path, low_memory=False)
    df['season_str'] = df['season'].astype(str)

    bowler_wicket_types = {'caught', 'bowled', 'lbw', 'stumped', 'caught and bowled', 'hit wicket'}

    season_dfs = {
        '2024': df[df['season_str'] == '2024'],
        '2025': df[df['season_str'] == '2025'],
        '2026': df[df['season_str'] == '2026']
    }

    season_player_stats = {'2024': {}, '2025': {}, '2026': {}}
    all_cric_players_per_season = {'2024': set(), '2025': set(), '2026': set()}

    print("[3/6] Computing granular ball-by-ball metrics for 2024, 2025, 2026...")

    for year in ['2024', '2025', '2026']:
        sdf = season_dfs[year]
        strikers = set(sdf['striker'].dropna().unique())
        non_strikers = set(sdf['non_striker'].dropna().unique())
        bowlers = set(sdf['bowler'].dropna().unique())
        all_season_players = strikers | non_strikers | bowlers
        all_cric_players_per_season[year] = all_season_players

        matches_per_player = {}
        for match_id, m_group in sdf.groupby('match_id'):
            m_players = set(m_group['striker'].dropna().unique()) | set(m_group['non_striker'].dropna().unique()) | set(m_group['bowler'].dropna().unique())
            for p_name in m_players:
                matches_per_player[p_name] = matches_per_player.get(p_name, 0) + 1

        bat_inns_set = set()
        runs_per_player = {}
        balls_faced_per_player = {}
        fours_per_player = {}
        sixes_per_player = {}
        dismissals_per_player = {}
        innings_runs = {}

        for _, row in sdf.iterrows():
            st = row['striker']
            mid = row['match_id']
            inn = row['innings']
            rob = row['runs_off_bat']
            wides = row['wides'] if pd.notna(row['wides']) else 0

            if pd.notna(st):
                bat_inns_set.add((mid, inn, st))
                runs_per_player[st] = runs_per_player.get(st, 0) + rob
                if wides == 0:
                    balls_faced_per_player[st] = balls_faced_per_player.get(st, 0) + 1
                if rob == 4:
                    fours_per_player[st] = fours_per_player.get(st, 0) + 1
                elif rob == 6:
                    sixes_per_player[st] = sixes_per_player.get(st, 0) + 1

                key = (mid, inn, st)
                innings_runs[key] = innings_runs.get(key, 0) + rob

            pdism = row['player_dismissed']
            if pd.notna(pdism):
                dismissals_per_player[pdism] = dismissals_per_player.get(pdism, 0) + 1

        fifties_per_player = {}
        hundreds_per_player = {}
        for (mid, inn, st), score in innings_runs.items():
            if 50 <= score < 100:
                fifties_per_player[st] = fifties_per_player.get(st, 0) + 1
            elif score >= 100:
                hundreds_per_player[st] = hundreds_per_player.get(st, 0) + 1

        bat_inns_count = {}
        for (mid, inn, st) in bat_inns_set:
            bat_inns_count[st] = bat_inns_count.get(st, 0) + 1

        bowl_inns_set = set()
        balls_bowled_per_player = {}
        runs_conceded_per_player = {}
        wickets_per_player = {}

        for _, row in sdf.iterrows():
            bw = row['bowler']
            if pd.isna(bw): continue
            mid = row['match_id']
            inn = row['innings']
            bowl_inns_set.add((mid, inn, bw))

            wides = row['wides'] if pd.notna(row['wides']) else 0
            noballs = row['noballs'] if pd.notna(row['noballs']) else 0
            rob = row['runs_off_bat'] if pd.notna(row['runs_off_bat']) else 0

            if wides == 0 and noballs == 0:
                balls_bowled_per_player[bw] = balls_bowled_per_player.get(bw, 0) + 1

            conceded = rob + wides + noballs
            runs_conceded_per_player[bw] = runs_conceded_per_player.get(bw, 0) + conceded

            w_type = row['wicket_type']
            if pd.notna(w_type) and str(w_type).lower().strip() in bowler_wicket_types:
                wickets_per_player[bw] = wickets_per_player.get(bw, 0) + 1

        bowl_inns_count = {}
        for (mid, inn, bw) in bowl_inns_set:
            bowl_inns_count[bw] = bowl_inns_count.get(bw, 0) + 1

        for cp in all_season_players:
            m = matches_per_player.get(cp, 0)
            b_inns = bat_inns_count.get(cp, 0)
            r = runs_per_player.get(cp, 0)
            bf = balls_faced_per_player.get(cp, 0)
            d = dismissals_per_player.get(cp, 0)
            no = max(0, b_inns - d)
            fours = fours_per_player.get(cp, 0)
            sixes = sixes_per_player.get(cp, 0)
            fifties = fifties_per_player.get(cp, 0)
            hundreds = hundreds_per_player.get(cp, 0)

            bat_avg = round(r / d, 2) if d > 0 else (float(r) if r > 0 else 0.0)
            sr = round((r / bf) * 100.0, 2) if bf > 0 else 0.0

            bw_inns = bowl_inns_count.get(cp, 0)
            bb = balls_bowled_per_player.get(cp, 0)
            rc = runs_conceded_per_player.get(cp, 0)
            w = wickets_per_player.get(cp, 0)
            overs = bb / 6.0
            econ = round(rc / overs, 2) if overs > 0 else 0.0
            bw_sr = round(bb / w, 2) if w > 0 else 0.0
            bw_avg = round(rc / w, 2) if w > 0 else 0.0

            season_player_stats[year][cp] = {
                'cricsheetName': cp,
                'matches': m,
                'batInnings': b_inns,
                'runs': r,
                'ballsFaced': bf,
                'dismissals': d,
                'notOuts': no,
                'fours': fours,
                'sixes': sixes,
                'fifties': fifties,
                'hundreds': hundreds,
                'batAvg': bat_avg,
                'strikeRate': sr,
                'bowlInnings': bw_inns,
                'ballsBowled': bb,
                'runsConceded': rc,
                'wickets': w,
                'bowlEcon': econ,
                'bowlStrikeRate': bw_sr,
                'bowlAvg': bw_avg
            }

        print(f"   -> Season {year}: {len(season_player_stats[year])} active players processed.")

    # 4. Save the 3 Season JSON files
    for year in ['2024', '2025', '2026']:
        out_file = f'C:/Users/souma/.gemini/antigravity/scratch/ipl_auction_game/public/data/player_stats_{year}.json'
        with open(out_file, 'w', encoding='utf-8') as f:
            json.dump(season_player_stats[year], f, indent=2)
    print("[4/6] Saved player_stats_2024.json, player_stats_2025.json, and player_stats_2026.json.")

    # 5. Check Players in All 3 Years & Unfound Players
    all_3_years_cric = all_cric_players_per_season['2024'] & all_cric_players_per_season['2025'] & all_cric_players_per_season['2026']
    union_all_years = all_cric_players_per_season['2024'] | all_cric_players_per_season['2025'] | all_cric_players_per_season['2026']

    players_all_3_years = []
    players_not_found = []

    for cp in sorted(list(union_all_years)):
        matched_player = resolve_cricsheet_player(cp)
        if matched_player:
            if cp in all_3_years_cric:
                players_all_3_years.append({
                    'id': matched_player['id'],
                    'name': matched_player['name'],
                    'cricsheetName': cp,
                    'matches2024': season_player_stats['2024'][cp]['matches'],
                    'matches2025': season_player_stats['2025'][cp]['matches'],
                    'matches2026': season_player_stats['2026'][cp]['matches']
                })
        else:
            seasons_present = [y for y in ['2024', '2025', '2026'] if cp in all_cric_players_per_season[y]]
            players_not_found.append({
                'cricsheetName': cp,
                'seasonsActive': seasons_present,
                'playedAll3Years': (cp in all_3_years_cric),
                'statsSummary': {
                    y: season_player_stats[y][cp] for y in seasons_present
                }
            })

    with open('C:/Users/souma/.gemini/antigravity/scratch/ipl_auction_game/public/data/players_played_all_3_years.json', 'w', encoding='utf-8') as f:
        json.dump(players_all_3_years, f, indent=2)

    with open('C:/Users/souma/.gemini/antigravity/scratch/ipl_auction_game/public/data/player_not_found.json', 'w', encoding='utf-8') as f:
        json.dump(players_not_found, f, indent=2)

    print(f"[5/6] Identified {len(players_all_3_years)} players who played in ALL 3 seasons (2024, 2025, 2026).")
    print(f"[5/6] Identified {len(players_not_found)} players present in Cricsheet ball-by-ball but not in active auction JSON (saved to player_not_found.json).")

    # 6. Adaptive Dynamic Reweighting & Master Player Calibration
    print("[6/6] Computing self-weighted multi-year master metrics...")

    json_to_cric = {}
    for cp in union_all_years:
        mp = resolve_cricsheet_player(cp)
        if mp:
            json_to_cric[mp['id']] = cp

    master_players = []

    for p in players:
        p_id = p['id']
        cp = json_to_cric.get(p_id)

        has_24 = cp in season_player_stats['2024'] if cp else False
        has_25 = cp in season_player_stats['2025'] if cp else False
        has_26 = cp in season_player_stats['2026'] if cp else False

        st24 = season_player_stats['2024'].get(cp) if has_24 else None
        st25 = season_player_stats['2025'].get(cp) if has_25 else None
        st26 = season_player_stats['2026'].get(cp) if has_26 else None

        w24, w25, w26 = 0.0, 0.0, 0.0

        if has_24 and has_25 and has_26:
            # Performance score in each season
            pi24 = st24['runs'] * (st24['strikeRate'] / 100.0) + st24['wickets'] * 25.0 + max(0, 10.0 - st24['bowlEcon']) * (st24['ballsBowled'] / 6.0)
            pi25 = st25['runs'] * (st25['strikeRate'] / 100.0) + st25['wickets'] * 25.0 + max(0, 10.0 - st25['bowlEcon']) * (st25['ballsBowled'] / 6.0)
            pi26 = st26['runs'] * (st26['strikeRate'] / 100.0) + st26['wickets'] * 25.0 + max(0, 10.0 - st26['bowlEcon']) * (st26['ballsBowled'] / 6.0)

            # User rule 1: If player played well in 2024 but dipped in 2025/2026:
            # "if a player played in 24 well but did nit in 25 26 we make good player but not form so exmple 0.4 24 0.4 26 0.2 25"
            if pi24 > 1.25 * pi25 and pi24 > 1.25 * pi26:
                w24, w25, w26 = 0.40, 0.20, 0.40
            # User rule 2: If played well in 2025:
            # "if played well in 25 , 0.1 24 0.55 25 , 0.35 26"
            elif pi25 > 1.25 * pi24 and pi25 > 1.25 * pi26:
                w24, w25, w26 = 0.10, 0.55, 0.35
            # Baseline: 0.2 2024, 0.3 2025, 0.5 2026
            else:
                w24, w25, w26 = 0.20, 0.30, 0.50

        # User rule 3: Played in 2026 but didn't appear in 24 or 25
        elif has_26 and not has_24 and not has_25:
            w24, w25, w26 = 0.0, 0.0, 1.0
        elif has_25 and has_26 and not has_24:
            w24, w25, w26 = 0.0, 0.375, 0.625
        elif has_24 and has_26 and not has_25:
            w24, w25, w26 = 0.286, 0.0, 0.714
        elif has_24 and has_25 and not has_26:
            w24, w25, w26 = 0.40, 0.60, 0.0
        elif has_25 and not has_24 and not has_26:
            w24, w25, w26 = 0.0, 1.0, 0.0
        elif has_24 and not has_25 and not has_26:
            w24, w25, w26 = 1.0, 0.0, 0.0

        p['seasonWeights'] = {
            'w2024': round(w24, 3),
            'w2025': round(w25, 3),
            'w2026': round(w26, 3),
            'has2024': has_24,
            'has2025': has_25,
            'has2026': has_26
        }

        # Compute exact weighted aggregates
        if has_24 or has_25 or has_26:
            w_runs = (w24 * st24['runs'] if has_24 else 0) + (w25 * st25['runs'] if has_25 else 0) + (w26 * st26['runs'] if has_26 else 0)
            w_dismissals = (w24 * st24['dismissals'] if has_24 else 0) + (w25 * st25['dismissals'] if has_25 else 0) + (w26 * st26['dismissals'] if has_26 else 0)
            w_bf = (w24 * st24['ballsFaced'] if has_24 else 0) + (w25 * st25['ballsFaced'] if has_25 else 0) + (w26 * st26['ballsFaced'] if has_26 else 0)
            w_sixes = (w24 * st24['sixes'] if has_24 else 0) + (w25 * st25['sixes'] if has_25 else 0) + (w26 * st26['sixes'] if has_26 else 0)

            w_batAvg = round(w_runs / w_dismissals, 2) if w_dismissals > 0 else (float(w_runs) if w_runs > 0 else p['historical'].get('realBatAvg', 20.0))
            w_strikeRate = round((w_runs / w_bf) * 100.0, 2) if w_bf > 0 else p['historical'].get('realStrikeRate', 120.0)
            six_rate = round((w_sixes / max(1.0, w_bf)) * 100.0, 2)

            w_bb = (w24 * st24['ballsBowled'] if has_24 else 0) + (w25 * st25['ballsBowled'] if has_25 else 0) + (w26 * st26['ballsBowled'] if has_26 else 0)
            w_rc = (w24 * st24['runsConceded'] if has_24 else 0) + (w25 * st25['runsConceded'] if has_25 else 0) + (w26 * st26['runsConceded'] if has_26 else 0)
            w_w = (w24 * st24['wickets'] if has_24 else 0) + (w25 * st25['wickets'] if has_25 else 0) + (w26 * st26['wickets'] if has_26 else 0)

            w_overs = w_bb / 6.0
            w_bowlEcon = round(w_rc / w_overs, 2) if w_overs > 0 else p['historical'].get('realBowlEcon', 8.5)
            w_bowlStrikeRate = round(w_bb / w_w, 2) if w_w > 0 else p['historical'].get('realBowlStrikeRate', 24.0)
            w_bowlAvg = round(w_rc / w_w, 2) if w_w > 0 else p['historical'].get('realBowlAvg', 30.0)
        else:
            w_batAvg = p['historical'].get('realBatAvg', 20.0)
            w_strikeRate = p['historical'].get('realStrikeRate', 120.0)
            w_bowlEcon = p['historical'].get('realBowlEcon', 8.5)
            w_bowlStrikeRate = p['historical'].get('realBowlStrikeRate', 24.0)
            w_bowlAvg = p['historical'].get('realBowlAvg', 30.0)
            tot_sixes = p['historical'].get('sixes', 0)
            tot_bf = p['historical'].get('ballsFaced', 1)
            six_rate = round((tot_sixes / max(1.0, tot_bf)) * 100.0, 2)

        p['weightedGameStats'] = {
            'batAvg': w_batAvg,
            'strikeRate': w_strikeRate,
            'bowlEcon': w_bowlEcon,
            'bowlStrikeRate': w_bowlStrikeRate,
            'bowlAvg': w_bowlAvg,
            'sixRatePct': six_rate
        }

        # Foundational stats anchor (60% career class baseline, 40% 3-year self-weighted form)
        base_bat = p['stats'].get('bat', 70)
        base_pwr = p['stats'].get('power', 70)
        base_bowl = p['stats'].get('bowl', 70)
        fielding = p['stats'].get('fielding', 75)

        if has_24 or has_25 or has_26:
            # Batting form: elite BA >= 40 & SR >= 155 -> ~95+
            form_bat = 30.0 + np.clip(w_batAvg, 10.0, 55.0) * 0.75 + np.clip(w_strikeRate - 90.0, 0.0, 90.0) * 0.45
            form_pwr = 30.0 + np.clip(six_rate, 0.0, 15.0) * 3.0 + np.clip(w_strikeRate - 100.0, 0.0, 80.0) * 0.35

            final_bat = int(np.clip(round(0.60 * base_bat + 0.40 * form_bat), 35, 99))
            final_pwr = int(np.clip(round(0.55 * base_pwr + 0.45 * form_pwr), 35, 99))

            if p.get('isBowlingCapable', False) or p.get('role') in ['PACE', 'SPIN', 'AR']:
                form_bowl = 35.0 + np.clip(11.0 - w_bowlEcon, 0.0, 4.5) * 8.5 + np.clip(32.0 - w_bowlStrikeRate, 0.0, 18.0) * 1.5
                final_bowl = int(np.clip(round(0.60 * base_bowl + 0.40 * form_bowl), 35, 99))
            else:
                final_bowl = base_bowl
        else:
            final_bat = base_bat
            final_pwr = base_pwr
            final_bowl = base_bowl

        # Overall rating calculation based on role
        role = p.get('role', 'BAT')
        if role == 'BAT':
            ovr = 0.65 * final_bat + 0.35 * final_pwr
        elif role == 'WK':
            ovr = 0.60 * final_bat + 0.30 * final_pwr + 0.10 * fielding
        elif role in ['PACE', 'SPIN']:
            ovr = 0.88 * final_bowl + 0.08 * fielding + 0.04 * final_bat
        else: # AR
            ovr = 0.48 * max(final_bat, final_bowl) + 0.36 * min(final_bat, final_bowl) + 0.16 * final_pwr

        final_ovr = int(np.clip(round(ovr), 50, 99))

        # Update stats
        p['stats']['bat'] = final_bat
        p['stats']['power'] = final_pwr
        p['stats']['bowl'] = final_bowl
        p['stats']['ovr'] = final_ovr

        master_players.append(p)

    master_path = 'C:/Users/souma/.gemini/antigravity/scratch/ipl_auction_game/public/data/master_players_active.json'
    with open(master_path, 'w', encoding='utf-8') as f:
        json.dump(master_players, f, indent=2)

    active_path = 'C:/Users/souma/.gemini/antigravity/scratch/ipl_auction_game/public/data/players_active.json'
    with open(active_path, 'w', encoding='utf-8') as f:
        json.dump(master_players, f, indent=2)

    print("[6/6] Saved master_players_active.json and updated public/data/players_active.json.")
    print("================================================================================")
    print("                      PIPELINE COMPLETED SUCCESSFULLY!                          ")
    print("================================================================================")

if __name__ == '__main__':
    run_enrichment_pipeline()

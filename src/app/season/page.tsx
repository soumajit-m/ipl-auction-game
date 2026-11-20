'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useGameRoomStore } from '@/lib/useGameRoomStore';
import { IPLPlayer } from '@/types/player.types';
import { Playing11Lineup } from '@/types/match.types';
import { TeamMaker, computePhaseBowlerQuotas, validate352Lineup } from '@/server/match/teamMaker';
import {
  Trophy,
  Users,
  Calendar,
  BarChart2,
  Medal,
  Play,
  RotateCw,
  FastForward,
  ShieldAlert,
  ArrowRight,
  ArrowLeft,
  Flame,
  Award,
  Save,
  CheckCircle2,
  Sparkles,
  Zap,
  Clock,
  Sliders,
  AlertCircle,
  ChevronUp,
  ChevronDown,
  Check,
  Star,
  ShieldCheck,
  Info,
  TrendingUp,
  Activity,
  Layers,
  Search,
  Eye,
  Target,
  LogOut
} from 'lucide-react';

export default function SeasonHubPage() {
  const router = useRouter();
  const {
    roomState,
    roomCode,
    mySeat,
    deviceUUID,
    playerName,
    initSocket,
    joinOrSyncRoom,
    hostAction,
    sendMatchReady,
    simulateMatch,
    voteSimulate,
    forceSimulateMatch,
    isHost,
    hostAuth,
    saveStatus,
    updateLineup,
    leaveRoom,
    setSimAlpha
  } = useGameRoomStore();

  const handleQuitRoom = () => {
    const confirmed = window.confirm(`Quit season room [${roomCode || '---'}] and return to Home?`);
    if (!confirmed) return;
    leaveRoom();
    router.push('/');
  };

  const [activeTab, setActiveTab] = useState<'MATCH_CENTER' | 'TEAM_MANAGER' | 'FIXTURES' | 'POINTS_TABLE' | 'STATS'>('MATCH_CENTER');
  const [managerStage, setManagerStage] = useState<'STAGE_1' | 'STAGE_2'>('STAGE_1');
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [workingXI, setWorkingXI] = useState<string[]>([]);
  const [battingOrder, setBattingOrder] = useState<string[]>([]);
  const [captainId, setCaptainId] = useState<string>('');
  const [designatedWkId, setDesignatedWkId] = useState<string>('');
  const [ppBowlerIds, setPpBowlerIds] = useState<string[]>([]);
  const [firstBowlerId, setFirstBowlerId] = useState<string>('');
  const [deathOver17_19BowlerId, setDeathOver17_19BowlerId] = useState<string>('');
  const [deathOver18_20BowlerId, setDeathOver18_20BowlerId] = useState<string>('');
  const [deathBowlerIds, setDeathBowlerIds] = useState<string[]>([]);
  const [midBowlerIds, setMidBowlerIds] = useState<string[]>([]);
  const [backupBowlerId, setBackupBowlerId] = useState<string>('');
  const [isSimulating, setIsSimulating] = useState(false);
  const [showSimulateAllConfirm, setShowSimulateAllConfirm] = useState(false);

  // Deep Match Analytics & Graphs State
  const [inspectedMatchNumber, setInspectedMatchNumber] = useState<number | null>(null);
  const [matchReviewTab, setMatchReviewTab] = useState<'GRAPHS' | 'SCORECARD' | 'OVER_BY_OVER'>('GRAPHS');
  const [graphViewMode, setGraphViewMode] = useState<'WORM' | 'MANHATTAN' | 'PHASE_MATRIX'>('WORM');
  const [scorecardInningsTab, setScorecardInningsTab] = useState<'INN1' | 'INN2' | 'BOTH'>('BOTH');
  const [overByOverInningsTab, setOverByOverInningsTab] = useState<'INN1' | 'INN2' | 'SIDE_BY_SIDE'>('SIDE_BY_SIDE');
  const [hoveredGraphOver, setHoveredGraphOver] = useState<number | null>(null);

  // Initialize socket and sync room state on mount
  useEffect(() => {
    initSocket();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlRoom = params.get('room') || params.get('roomCode');
      const activeCode = urlRoom || roomCode || roomState?.roomCode || localStorage.getItem('active_ipl_room_code');
      if (activeCode) {
        localStorage.setItem('active_ipl_room_code', activeCode);
        joinOrSyncRoom(activeCode);
      }
    }
  }, [initSocket, joinOrSyncRoom]);

  // Flash "Saved to Cloud ✓" badge when saveStatus updates
  useEffect(() => {
    if (saveStatus?.timestamp) {
      setSaveSuccessMsg(`Saved to Cloud ✓ ${new Date(saveStatus.timestamp).toLocaleTimeString()}`);
      const timer = setTimeout(() => setSaveSuccessMsg(null), 3500);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const season = (roomState as any)?.season;
  const simAlpha = typeof season?.simAlpha === 'number' ? season.simAlpha : 0.8;
  const handleAlphaChange = (newAlpha: number) => {
    setSimAlpha(newAlpha);
  };
  const teams = roomState?.teams || {};

  // Strict Client-to-Franchise Identity Binding (Bug 1):
  // Resolve user's claimed team with strict precedence:
  // 1. Authoritative mySeat from server
  // 2. Matching deviceUUID / playerName in roomState.seats
  // 3. Stored claimed team in localStorage
  const myFranchiseId = useMemo(() => {
    if (mySeat?.teamId && teams[mySeat.teamId]) return mySeat.teamId;

    if (roomState?.seats && Array.isArray(roomState.seats)) {
      if (playerName) {
        const namedSeat = roomState.seats.find(s => s.isHuman && s.playerName === playerName);
        if (namedSeat && teams[namedSeat.teamId]) return namedSeat.teamId;
      }
      if (deviceUUID) {
        const uuidSeat = roomState.seats.find((s: any) => s.isHuman && (s.deviceUUID === deviceUUID || s.lastDeviceUUID === deviceUUID));
        if (uuidSeat && teams[uuidSeat.teamId]) return uuidSeat.teamId;
      }
    }

    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('ipl_claimed_team_id');
      if (stored && teams[stored]) return stored;
    }

    // Fallback: If only one human team exists in the room
    const humanTeams = Object.values(teams).filter(t => t.isHuman);
    if (humanTeams.length === 1) return humanTeams[0].franchiseId;

    return Object.keys(teams)[0] || '';
  }, [mySeat, teams, roomState?.seats, playerName, deviceUUID]);

  const isManagingMyTeam = selectedTeamId === myFranchiseId;

  // Strictly bind selected team directly to user's assigned franchise (Never default to CSK)
  useEffect(() => {
    if (myFranchiseId && teams[myFranchiseId]) {
      setSelectedTeamId(myFranchiseId);
    } else if (Object.keys(teams).length > 0 && (!selectedTeamId || !teams[selectedTeamId])) {
      setSelectedTeamId(Object.keys(teams)[0]);
    }
  }, [myFranchiseId, teams, selectedTeamId]);

  const currentTeam = teams[selectedTeamId] || Object.values(teams)[0];
  const currentSquad = currentTeam?.squad || [];
  const currentServerLineup = season?.lineups?.[selectedTeamId];

  // Helper to sync all lineup states from a Playing11Lineup
  const syncLineupStates = (lineup: Playing11Lineup) => {
    setWorkingXI(lineup.playing11Ids);
    setBattingOrder(lineup.battingOrder && lineup.battingOrder.length === 11 ? lineup.battingOrder : lineup.playing11Ids);
    setCaptainId(lineup.captainId || lineup.playing11Ids[0]);
    const finalWk = lineup.wkId || lineup.playing11Ids[0];
    setDesignatedWkId(finalWk);
    if (lineup.bowlerPool352) {
      const squadBowlerIds = currentSquad
        .filter(p => TeamMaker.isBowler(p) && p.role !== 'WK' && !p.subType?.startsWith('WK') && p.id !== finalWk)
        .map(p => p.id);
      const cleanPP = (lineup.bowlerPool352.powerplayBowlerIds || []).filter(id => squadBowlerIds.includes(id));
      const d17 = lineup.bowlerPool352.deathOver17_19BowlerId || lineup.bowlerPool352.deathBowlerIds?.[0] || '';
      const d18 = lineup.bowlerPool352.deathOver18_20BowlerId || lineup.bowlerPool352.deathBowlerIds?.[1] || '';
      const cleanD17 = squadBowlerIds.includes(d17) ? d17 : '';
      const cleanD18 = squadBowlerIds.includes(d18) ? d18 : '';
      const cleanMid = (lineup.bowlerPool352.middleBowlerIds || []).filter(id => squadBowlerIds.includes(id));

      setPpBowlerIds(cleanPP);
      setFirstBowlerId(cleanPP.includes(lineup.bowlerPool352.firstBowlerId) ? lineup.bowlerPool352.firstBowlerId : cleanPP[0] || '');
      setDeathOver17_19BowlerId(cleanD17);
      setDeathOver18_20BowlerId(cleanD18);
      setDeathBowlerIds([cleanD17, cleanD18].filter(Boolean));
      setMidBowlerIds(cleanMid);
      setBackupBowlerId(lineup.bowlerPool352.backupBowlerId || '');
    }
  };

  // Track selected team transitions to avoid clobbering in-progress lineup edits
  const prevSelectedTeamRef = React.useRef<string>(selectedTeamId);
  const serverLineupIds = currentServerLineup?.playing11Ids;
  const serverLineupKey = serverLineupIds ? serverLineupIds.join(',') : '';

  // Sync states whenever switching franchises or on initial mount
  useEffect(() => {
    const isNewTeam = prevSelectedTeamRef.current !== selectedTeamId;
    prevSelectedTeamRef.current = selectedTeamId;

    if (isNewTeam || workingXI.length === 0) {
      const isServerLineupValid = currentServerLineup?.playing11Ids?.length === 11 &&
        validate352Lineup(currentServerLineup, currentSquad).valid;

      if (isServerLineupValid && currentServerLineup) {
        syncLineupStates(currentServerLineup);
      } else if (currentSquad.length >= 11) {
        try {
          const fallback = currentTeam?.isHuman
            ? TeamMaker.makeNaiveLineup(selectedTeamId, currentSquad)
            : TeamMaker.makeSmartLineup(selectedTeamId, currentSquad);
          syncLineupStates(fallback);
        } catch {
          const os = currentSquad.filter(p => p.isOverseas).sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0)).slice(0, 4);
          const dom = currentSquad.filter(p => !p.isOverseas).sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0));
          const pool = [...os, ...dom].slice(0, 11);
          const bats = pool.filter(p => p.role === 'BAT' || p.role === 'WK').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
          const ars = pool.filter(p => p.role === 'AR').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
          const bowls = pool.filter(p => p.role === 'PACE' || p.role === 'SPIN').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
          const orderedIds = [...bats, ...ars, ...bowls].map(p => p.id);
          setWorkingXI(orderedIds);
          setBattingOrder(orderedIds);
        }
      }
    }
  }, [selectedTeamId, serverLineupKey]);

  const currentMatchIndex = season?.currentMatchIndex || 0;
  const fixtures = season?.fixtures || [];
  const nextFixture = fixtures[currentMatchIndex];
  const completedFixtures = useMemo(() => fixtures.filter((f: any) => f.completed), [fixtures]);
  const latestCompletedMatch = completedFixtures[completedFixtures.length - 1] || null;
  const allCompleted = currentMatchIndex >= fixtures.length && fixtures.length > 0;

  // Clear active room code from localStorage once tournament concludes so players can start new rooms
  useEffect(() => {
    if (allCompleted && typeof window !== 'undefined') {
      localStorage.removeItem('active_ipl_room_code');
      localStorage.removeItem('ipl_claimed_team_id');
    }
  }, [allCompleted]);

  // Active match being inspected in deep match center
  const activeInspectedMatch = useMemo(() => {
    if (inspectedMatchNumber !== null) {
      const match = fixtures.find((f: any) => f.matchNumber === inspectedMatchNumber && f.completed);
      if (match) return match;
    }
    return latestCompletedMatch;
  }, [inspectedMatchNumber, fixtures, latestCompletedMatch]);

  // Most Runs & Most Wickets for Innings 1 and Innings 2
  const matchTopPerformers = useMemo(() => {
    if (!activeInspectedMatch) return null;

    const extractPerformers = (inn: any) => {
      if (!inn) return { topBatter: null, topBowler: null, battersList: [], bowlersList: [] };
      const battersList = Object.values(inn.battingScorecard || {}).sort((a: any, b: any) => (b.runs || 0) - (a.runs || 0));
      const topBatter = (battersList[0] as any) || null;

      const bowlersList = Object.values(inn.bowlingFigures || {}).sort((a: any, b: any) => {
        if ((b.wickets || 0) !== (a.wickets || 0)) {
          return (b.wickets || 0) - (a.wickets || 0);
        }
        return (a.runsConceded || 0) - (b.runsConceded || 0);
      });
      const topBowler = (bowlersList[0] as any) || null;

      return { topBatter, topBowler, battersList, bowlersList };
    };

    return {
      inn1: extractPerformers(activeInspectedMatch.innings1),
      inn2: extractPerformers(activeInspectedMatch.innings2)
    };
  }, [activeInspectedMatch]);

  // Phase comparison stats (Powerplay, Middle, Death) for both innings
  const matchPhaseComparison = useMemo(() => {
    if (!activeInspectedMatch) return null;

    const calcPhase = (overs: any[]) => {
      const runs = overs.reduce((sum, o) => sum + (o.runs || 0), 0);
      const wickets = overs.reduce((sum, o) => sum + (o.wickets || 0), 0);
      const fours = overs.reduce((sum, o) => sum + (o.fours || 0), 0);
      const sixes = overs.reduce((sum, o) => sum + (o.sixes || 0), 0);
      const dots = overs.reduce((sum, o) => sum + (o.dots || 0), 0);
      const count = overs.length;
      const runRate = count > 0 ? Math.round((runs / count) * 100) / 100 : 0;
      return { runs, wickets, fours, sixes, dots, count, runRate };
    };

    const inn1Overs = activeInspectedMatch.innings1?.overSummaries || [];
    const inn2Overs = activeInspectedMatch.innings2?.overSummaries || [];

    return {
      inn1: {
        pp: calcPhase(inn1Overs.filter((o: any) => o.overNum <= 6)),
        mid: calcPhase(inn1Overs.filter((o: any) => o.overNum > 6 && o.overNum <= 16)),
        death: calcPhase(inn1Overs.filter((o: any) => o.overNum > 16))
      },
      inn2: {
        pp: calcPhase(inn2Overs.filter((o: any) => o.overNum <= 6)),
        mid: calcPhase(inn2Overs.filter((o: any) => o.overNum > 6 && o.overNum <= 16)),
        death: calcPhase(inn2Overs.filter((o: any) => o.overNum > 16))
      }
    };
  }, [activeInspectedMatch]);

  const standings = season?.standings ? Object.values(season.standings) : [];
  const sortedStandings = [...standings].sort((a: any, b: any) => b.points - a.points || b.nrr - a.nrr);

  // Aggregated Season Statistics (Orange Cap, Purple Cap, MVP, Records)
  const seasonStats = useMemo(() => {
    const completedFixtures = fixtures.filter((f: any) => f.completed);
    const batterMap: Record<string, {
      name: string;
      teamName: string;
      runs: number;
      innings: number;
      balls: number;
      fours: number;
      sixes: number;
      highestScore: number;
    }> = {};

    const bowlerMap: Record<string, {
      name: string;
      teamName: string;
      wickets: number;
      overs: number;
      runsConceded: number;
      maidens: number;
      dots: number;
      bestW: number;
      bestR: number;
    }> = {};

    const mvpMap: Record<string, { name: string; team: string; potmCount: number; points: number }> = {};
    let totalSixes = 0;
    let totalFours = 0;
    let highestTotal = { score: 0, wkts: 0, team: '', opp: '', matchNum: 0 };

    // Authoritative player-to-franchise resolver: prioritizes active tournament franchise rosters
    const resolvePlayerTeam = (playerName: string, explicitTeam?: string, matchInningsTeam?: string) => {
      if (!playerName) return 'Unknown';
      for (const t of Object.values(teams)) {
        if (t?.squad?.some(p => p.name === playerName || p.id === playerName)) {
          return t.name || t.franchiseId || (t as any).id;
        }
      }
      if (explicitTeam && explicitTeam.trim().length > 0 && explicitTeam !== 'Unknown') {
        return teams[explicitTeam]?.name || explicitTeam;
      }
      if (matchInningsTeam && matchInningsTeam.trim().length > 0 && matchInningsTeam !== 'Unknown') {
        return teams[matchInningsTeam]?.name || matchInningsTeam;
      }
      return 'Unknown';
    };

    for (const f of completedFixtures) {
      const inn1BatTeamName = f.innings1?.teamName || teams[f.innings1?.teamId]?.name || f.innings1?.teamId || '';
      const inn1BowlTeamName = f.innings2?.teamName || (f.innings1?.teamId === f.homeTeamId ? (teams[f.awayTeamId]?.name || f.awayTeamId) : (teams[f.homeTeamId]?.name || f.homeTeamId)) || '';

      const inn2BatTeamName = f.innings2?.teamName || teams[f.innings2?.teamId]?.name || f.innings2?.teamId || '';
      const inn2BowlTeamName = f.innings1?.teamName || (f.innings2?.teamId === f.homeTeamId ? (teams[f.awayTeamId]?.name || f.awayTeamId) : (teams[f.homeTeamId]?.name || f.homeTeamId)) || '';

      if (f.innings1) {
        if (f.innings1.totalRuns > highestTotal.score) {
          highestTotal = {
            score: f.innings1.totalRuns,
            wkts: f.innings1.totalWickets,
            team: inn1BatTeamName,
            opp: inn1BowlTeamName,
            matchNum: f.matchNumber
          };
        }
        if (f.innings1.battingScorecard) {
          for (const b of Object.values(f.innings1.battingScorecard) as any[]) {
            totalFours += b.fours || 0;
            totalSixes += b.sixes || 0;
            const resolvedTeam = resolvePlayerTeam(b.name, b.teamName, inn1BatTeamName);
            if (!batterMap[b.name]) {
              batterMap[b.name] = {
                name: b.name,
                teamName: resolvedTeam,
                runs: 0,
                innings: 0,
                balls: 0,
                fours: 0,
                sixes: 0,
                highestScore: 0
              };
            }
            const bm = batterMap[b.name];
            bm.teamName = resolvedTeam;
            bm.runs += b.runs || 0;
            bm.balls += b.balls || 0;
            bm.fours += b.fours || 0;
            bm.sixes += b.sixes || 0;
            bm.innings += 1;
            if ((b.runs || 0) > bm.highestScore) bm.highestScore = b.runs;
          }
        }
        if (f.innings1.bowlingFigures) {
          for (const bw of Object.values(f.innings1.bowlingFigures) as any[]) {
            const resolvedTeam = resolvePlayerTeam(bw.name, bw.teamName, inn1BowlTeamName);
            if (!bowlerMap[bw.name]) {
              bowlerMap[bw.name] = {
                name: bw.name,
                teamName: resolvedTeam,
                wickets: 0,
                overs: 0,
                runsConceded: 0,
                maidens: 0,
                dots: 0,
                bestW: 0,
                bestR: 99
              };
            }
            const bwm = bowlerMap[bw.name];
            bwm.teamName = resolvedTeam;
            bwm.wickets += bw.wickets || 0;
            bwm.overs += bw.overs || 0;
            bwm.runsConceded += bw.runsConceded || 0;
            bwm.maidens += bw.maidens || 0;
            bwm.dots += bw.dots || 0;
            if (bw.wickets > bwm.bestW || (bw.wickets === bwm.bestW && bw.runsConceded < bwm.bestR)) {
              bwm.bestW = bw.wickets;
              bwm.bestR = bw.runsConceded;
            }
          }
        }
      }

      if (f.innings2) {
        if (f.innings2.totalRuns > highestTotal.score) {
          highestTotal = {
            score: f.innings2.totalRuns,
            wkts: f.innings2.totalWickets,
            team: inn2BatTeamName,
            opp: inn2BowlTeamName,
            matchNum: f.matchNumber
          };
        }
        if (f.innings2.battingScorecard) {
          for (const b of Object.values(f.innings2.battingScorecard) as any[]) {
            totalFours += b.fours || 0;
            totalSixes += b.sixes || 0;
            const resolvedTeam = resolvePlayerTeam(b.name, b.teamName, inn2BatTeamName);
            if (!batterMap[b.name]) {
              batterMap[b.name] = {
                name: b.name,
                teamName: resolvedTeam,
                runs: 0,
                innings: 0,
                balls: 0,
                fours: 0,
                sixes: 0,
                highestScore: 0
              };
            }
            const bm = batterMap[b.name];
            bm.teamName = resolvedTeam;
            bm.runs += b.runs || 0;
            bm.balls += b.balls || 0;
            bm.fours += b.fours || 0;
            bm.sixes += b.sixes || 0;
            bm.innings += 1;
            if ((b.runs || 0) > bm.highestScore) bm.highestScore = b.runs;
          }
        }
        if (f.innings2.bowlingFigures) {
          for (const bw of Object.values(f.innings2.bowlingFigures) as any[]) {
            const resolvedTeam = resolvePlayerTeam(bw.name, bw.teamName, inn2BowlTeamName);
            if (!bowlerMap[bw.name]) {
              bowlerMap[bw.name] = {
                name: bw.name,
                teamName: resolvedTeam,
                wickets: 0,
                overs: 0,
                runsConceded: 0,
                maidens: 0,
                dots: 0,
                bestW: 0,
                bestR: 99
              };
            }
            const bwm = bowlerMap[bw.name];
            bwm.teamName = resolvedTeam;
            bwm.wickets += bw.wickets || 0;
            bwm.overs += bw.overs || 0;
            bwm.runsConceded += bw.runsConceded || 0;
            bwm.maidens += bw.maidens || 0;
            bwm.dots += bw.dots || 0;
            if (bw.wickets > bwm.bestW || (bw.wickets === bwm.bestW && bw.runsConceded < bwm.bestR)) {
              bwm.bestW = bw.wickets;
              bwm.bestR = bw.runsConceded;
            }
          }
        }
      }

      if (f.playerOfTheMatch?.name) {
        const pName = f.playerOfTheMatch.name;
        const resolvedTeam = resolvePlayerTeam(pName, f.playerOfTheMatch.team);
        if (!mvpMap[pName]) {
          mvpMap[pName] = { name: pName, team: resolvedTeam, potmCount: 0, points: 0 };
        } else {
          mvpMap[pName].team = resolvedTeam;
        }
        mvpMap[pName].potmCount += 1;
        mvpMap[pName].points += f.playerOfTheMatch.impactPoints || 25;
      }
    }

    const orangeCapList = Object.values(batterMap)
      .sort((a, b) => b.runs - a.runs || (b.runs / (b.balls || 1)) - (a.runs / (a.balls || 1)))
      .slice(0, 10);

    const purpleCapList = Object.values(bowlerMap)
      .sort((a, b) => b.wickets - a.wickets || (a.runsConceded / (a.overs || 1)) - (b.runsConceded / (b.overs || 1)))
      .slice(0, 10);

    const mvpList = Object.values(mvpMap)
      .sort((a, b) => b.potmCount - a.potmCount || b.points - a.points)
      .slice(0, 5);

    return {
      completedCount: completedFixtures.length,
      totalSixes,
      totalFours,
      highestTotal,
      orangeCapList,
      purpleCapList,
      mvpList
    };
  }, [fixtures]);

  // Lineup validation helpers
  const selectedPlayers = useMemo(() => {
    return currentSquad.filter(p => workingXI.includes(p.id));
  }, [currentSquad, workingXI]);

  const benchPlayers = useMemo(() => {
    return currentSquad.filter(p => !workingXI.includes(p.id));
  }, [currentSquad, workingXI]);

  const candidateBowlers = useMemo(() => {
    return selectedPlayers.filter(p => TeamMaker.isBowler(p) && p.role !== 'WK' && p.id !== designatedWkId);
  }, [selectedPlayers, designatedWkId]);

  const candidateBowlerIds = useMemo(() => {
    return candidateBowlers.map(p => p.id);
  }, [candidateBowlers]);

  const ppCandidates = useMemo(() => {
    return [...candidateBowlers]
      .sort((a, b) => (b.tacticalSynergy?.powerplay ?? b.stats.bowl) - (a.tacticalSynergy?.powerplay ?? a.stats.bowl));
  }, [candidateBowlers]);

  const deathCandidates = useMemo(() => {
    return [...candidateBowlers]
      .sort((a, b) => (b.tacticalSynergy?.death ?? b.stats.bowl) - (a.tacticalSynergy?.death ?? a.stats.bowl));
  }, [candidateBowlers]);

  const midCandidates = useMemo(() => {
    return candidateBowlers;
  }, [candidateBowlers]);

  // 4-2-2 Overlap Quota Engine live computation
  const quotaResult = useMemo(() => {
    return computePhaseBowlerQuotas(candidateBowlerIds, ppBowlerIds, deathBowlerIds);
  }, [candidateBowlerIds, ppBowlerIds, deathBowlerIds]);

  // Prune any non-bowlers (e.g. WK / pure bats) or benched players from bowler phase selections
  useEffect(() => {
    if (candidateBowlerIds.length > 0) {
      setPpBowlerIds(prev => {
        const next = prev.filter(id => candidateBowlerIds.includes(id));
        return (next.length === prev.length && next.every((id, i) => id === prev[i])) ? prev : next;
      });
      setMidBowlerIds(prev => {
        const next = prev.filter(id => candidateBowlerIds.includes(id));
        return (next.length === prev.length && next.every((id, i) => id === prev[i])) ? prev : next;
      });
      setDeathBowlerIds(prev => {
        const next = prev.filter(id => candidateBowlerIds.includes(id));
        return (next.length === prev.length && next.every((id, i) => id === prev[i])) ? prev : next;
      });
      setFirstBowlerId(prev => (prev && candidateBowlerIds.includes(prev) ? prev : ''));
      setDeathOver17_19BowlerId(prev => (prev && candidateBowlerIds.includes(prev) ? prev : ''));
      setDeathOver18_20BowlerId(prev => (prev && candidateBowlerIds.includes(prev) ? prev : ''));
    }
  }, [candidateBowlerIds]);

  const selectedCount = workingXI.length;
  const overseasCount = selectedPlayers.filter(p => p.isOverseas).length;
  const wkCount = selectedPlayers.filter(p => p.role === 'WK').length;
  const bowlerCount = candidateBowlers.length;
  const injuredInXI = selectedPlayers.filter(p => (p.injuryStatus !== undefined && p.injuryStatus !== 0));

  // Stage 1 legality
  const isStage1Valid = selectedCount === 11 && overseasCount <= 4 && wkCount >= 1 && bowlerCount >= 6 && injuredInXI.length === 0;

  // Stage 2 legality
  const isPPValid = ppBowlerIds.length === 3 && ppBowlerIds.includes(firstBowlerId);
  const isDeathValid = Boolean(
    deathOver17_19BowlerId &&
    deathOver18_20BowlerId &&
    deathOver17_19BowlerId !== deathOver18_20BowlerId &&
    workingXI.includes(deathOver17_19BowlerId) &&
    workingXI.includes(deathOver18_20BowlerId) &&
    quotaResult.ppDeathOverlapCount <= 1
  );
  const validMidBowlerIds = useMemo(() => midBowlerIds.filter(id => candidateBowlerIds.includes(id)), [midBowlerIds, candidateBowlerIds]);
  const isMidValid = validMidBowlerIds.length === 5 && validMidBowlerIds.every(id => (quotaResult.quotas[id]?.usableMiddleOvers ?? 0) > 0);
  const isBackupValid = Boolean(backupBowlerId && workingXI.includes(backupBowlerId));

  const isStage2Valid = isStage1Valid && isPPValid && isDeathValid && isMidValid && isBackupValid;

  const stage2Blockers = useMemo(() => {
    const blockers: string[] = [];
    if (!isStage1Valid) {
      if (selectedCount !== 11) blockers.push(`Playing 11 must contain 11 players (currently ${selectedCount})`);
      if (overseasCount > 4) blockers.push(`Max 4 overseas allowed (currently ${overseasCount})`);
      if (wkCount < 1) blockers.push('At least 1 qualified Wicketkeeper required');
      if (bowlerCount < 6) blockers.push(`At least 6 bowling-capable players required (currently ${bowlerCount})`);
      if (injuredInXI.length > 0) blockers.push(`Injured player in Starting 11: ${injuredInXI.map(p => p.name).join(', ')} must be benched`);
    }
    if (ppBowlerIds.length !== 3) blockers.push(`Select exactly 3 Powerplay bowlers (currently ${ppBowlerIds.length})`);
    else if (!ppBowlerIds.includes(firstBowlerId)) blockers.push('Designate an Over 1 Starter from the 3 Powerplay bowlers');

    if (!deathOver17_19BowlerId || !deathOver18_20BowlerId) blockers.push('Assign both Death Overs slots (Overs 17 & 19 and Overs 18 & 20)');
    else if (deathOver17_19BowlerId === deathOver18_20BowlerId) blockers.push('Overs 17 & 19 and Overs 18 & 20 must be two distinct bowlers');

    if (quotaResult.ppDeathOverlapCount > 1) blockers.push('Over limit exceeded: At most 1 bowler can bowl in both Powerplay and Death overs');

    const ghostMids = midBowlerIds.filter(id => !candidateBowlerIds.includes(id));
    if (ghostMids.length > 0) {
      const names = ghostMids.map(id => selectedPlayers.find(p => p.id === id)?.name || id).join(', ');
      blockers.push(`Selection notice: ${names} is a non-bowler. Please choose a bowling-capable player or click Auto-Fill.`);
    }

    if (validMidBowlerIds.length !== 5) {
      blockers.push(`Select exactly 5 Middle Overs bowlers (currently ${validMidBowlerIds.length})`);
    } else {
      const exhaustedMids = validMidBowlerIds.filter(id => (quotaResult.quotas[id]?.usableMiddleOvers ?? 0) === 0);
      if (exhaustedMids.length > 0) {
        const names = exhaustedMids.map(id => selectedPlayers.find(p => p.id === id)?.name || id).join(', ');
        blockers.push(`Over allocation: ${names} has reached their 4-over maximum in Powerplay & Death. Select another middle-overs bowler.`);
      }
    }

    if (!backupBowlerId || !workingXI.includes(backupBowlerId)) blockers.push('Designate a valid Backup Bowler from the Playing 11');

    return blockers;
  }, [isStage1Valid, selectedCount, overseasCount, wkCount, bowlerCount, ppBowlerIds, firstBowlerId, deathOver17_19BowlerId, deathOver18_20BowlerId, quotaResult, midBowlerIds, selectedPlayers, backupBowlerId, workingXI]);

  const handleBenchPlayer = (playerId: string) => {
    setWorkingXI(prev => prev.filter(id => id !== playerId));
    setBattingOrder(prev => prev.filter(id => id !== playerId));
    setPpBowlerIds(prev => prev.filter(id => id !== playerId));
    setDeathBowlerIds(prev => prev.filter(id => id !== playerId));
    setMidBowlerIds(prev => prev.filter(id => id !== playerId));
    if (firstBowlerId === playerId) setFirstBowlerId('');
    if (deathOver17_19BowlerId === playerId) setDeathOver17_19BowlerId('');
    if (deathOver18_20BowlerId === playerId) setDeathOver18_20BowlerId('');
    if (backupBowlerId === playerId) setBackupBowlerId('');
  };

  const handleAddPlayer = (player: IPLPlayer) => {
    if (workingXI.length >= 11) return;
    if (player.injuryStatus !== undefined && player.injuryStatus !== 0) return;
    if (player.isOverseas && overseasCount >= 4) return;
    const nextXI = [...workingXI, player.id];
    setWorkingXI(nextXI);
    if (!battingOrder.includes(player.id)) {
      setBattingOrder([...battingOrder, player.id]);
    }
  };

  const togglePPBowler = (id: string) => {
    if (ppBowlerIds.includes(id)) {
      const next = ppBowlerIds.filter(x => x !== id);
      setPpBowlerIds(next);
      if (firstBowlerId === id) setFirstBowlerId(next[0] || '');
    } else {
      if (ppBowlerIds.length >= 3) return;
      const next = [...ppBowlerIds, id];
      setPpBowlerIds(next);
      if (!firstBowlerId) setFirstBowlerId(id);
      if (deathBowlerIds.includes(id)) {
        setMidBowlerIds(prev => prev.filter(x => x !== id));
      }
    }
  };

  const toggleDeathBowler = (id: string) => {
    if (deathBowlerIds.includes(id)) {
      setDeathBowlerIds(deathBowlerIds.filter(x => x !== id));
    } else {
      if (deathBowlerIds.length >= 2) return;
      if (ppBowlerIds.includes(id) && quotaResult.ppDeathOverlapCount >= 1) return;
      setDeathBowlerIds([...deathBowlerIds, id]);
    }
  };

  const toggleMidBowler = (id: string) => {
    if (!candidateBowlerIds.includes(id)) return;
    if (midBowlerIds.includes(id)) {
      setMidBowlerIds(midBowlerIds.filter(x => x !== id));
    } else {
      const currentValid = midBowlerIds.filter(x => candidateBowlerIds.includes(x));
      if (currentValid.length >= 5) return;
      const remaining = quotaResult.quotas[id]?.usableMiddleOvers ?? 0;
      if (remaining === 0) return;
      setMidBowlerIds([...currentValid, id]);
    }
  };

  const moveBattingOrder = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= battingOrder.length) return;
    const next = [...battingOrder];
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    setBattingOrder(next);
  };

  const handleAutoPickSmart = () => {
    try {
      const smart = TeamMaker.makeSmartLineup(selectedTeamId, currentSquad);
      syncLineupStates(smart);
      updateLineup(smart);
      setSaveSuccessMsg(`Smart 11 generated for ${currentTeam?.name || selectedTeamId}!`);
      setTimeout(() => setSaveSuccessMsg(null), 3000);
    } catch (e: any) {
      console.warn(e);
      setSaveSuccessMsg(`Auto-pick error: ${e?.message}`);
      setTimeout(() => setSaveSuccessMsg(null), 3500);
    }
  };

  const handleAutoPickNaive = () => {
    try {
      if (!currentSquad || currentSquad.length < 11) {
        setSaveSuccessMsg(`Squad has only ${currentSquad?.length || 0} players (need at least 11).`);
        setTimeout(() => setSaveSuccessMsg(null), 3000);
        return;
      }
      const naive = TeamMaker.makeNaiveLineup(selectedTeamId, currentSquad);
      syncLineupStates(naive);
      updateLineup(naive);
      setSaveSuccessMsg(`Auto-Picked Best 11 (Top Ratings) for ${currentTeam?.name || selectedTeamId}! Lineup saved.`);
      setTimeout(() => setSaveSuccessMsg(null), 3000);
    } catch (e: any) {
      console.error('Error generating naive lineup:', e);
      setSaveSuccessMsg(`Auto-pick error: ${e?.message || 'Check squad limits'}`);
      setTimeout(() => setSaveSuccessMsg(null), 3500);
    }
  };

  const handleSaveLineup = () => {
    const finalBattingOrder = battingOrder.length === 11 ? battingOrder : workingXI;
    const finalWk = designatedWkId || selectedPlayers.find(p => p.role === 'WK')?.id || workingXI[0];
    const finalCaptain = captainId || workingXI[0];

    const slotted17 = deathOver17_19BowlerId || deathBowlerIds[0] || workingXI[0];
    const slotted18 = deathOver18_20BowlerId || deathBowlerIds[1] || workingXI[1];

    const lineup: Playing11Lineup = {
      teamId: selectedTeamId,
      playing11Ids: workingXI,
      captainId: finalCaptain,
      wkId: finalWk,
      battingOrder: finalBattingOrder,
      bowlerPool352: {
        powerplayBowlerIds: ppBowlerIds.filter(id => candidateBowlerIds.includes(id)),
        firstBowlerId: firstBowlerId || ppBowlerIds[0] || workingXI[0],
        middleBowlerIds: validMidBowlerIds,
        deathOver17_19BowlerId: slotted17,
        deathOver18_20BowlerId: slotted18,
        deathBowlerIds: [slotted17, slotted18].filter(Boolean),
        backupBowlerId: backupBowlerId || workingXI[workingXI.length - 1]
      },
      tactics: currentServerLineup?.tactics || {
        powerplay: { batting: 'BALANCED', bowling: 'PACE_ATTACK' },
        middle: { batting: 'BALANCED', bowling: 'SPIN_SQUEEZE' },
        death: { batting: 'AGGRESSIVE', bowling: 'BOUNDARY_DEFENSIVE' }
      }
    };

    const val = validate352Lineup(lineup, currentSquad);
    if (!val.valid) {
      setSaveSuccessMsg(`❌ ${val.errors[0]}`);
      setTimeout(() => setSaveSuccessMsg(null), 4000);
      return;
    }

    updateLineup(lineup);
    setSaveSuccessMsg(`✓ 3-5-2 Lineup & Tactics saved for ${currentTeam?.name || selectedTeamId}!`);
    setTimeout(() => setSaveSuccessMsg(null), 3000);
  };

  const isStrictHost = Boolean(
    (hostAuth?.token && hostAuth.hostId && roomState?.hostId && hostAuth.hostId === roomState.hostId) ||
    (deviceUUID && roomState?.hostDeviceUUID && deviceUUID === roomState.hostDeviceUUID) ||
    (isHost && (!roomState?.hostDeviceUUID || deviceUUID === roomState?.hostDeviceUUID))
  );
  const isHostEffective = isStrictHost;

  const handlePlayNextMatch = () => {
    setIsSimulating(true);
    simulateMatch();
    setTimeout(() => setIsSimulating(false), 800);
  };

  const handleSimulateAll = () => {
    setShowSimulateAllConfirm(true);
  };

  const handleConfirmSimulateAll = () => {
    setShowSimulateAllConfirm(false);
    setIsSimulating(true);
    hostAction('SIMULATE_ALL_MATCHES');
    setTimeout(() => setIsSimulating(false), 2500);
  };

  return (
    <div className="min-h-screen bg-canvas text-slate-100 flex flex-col font-sans select-none">
      {/* Persistent Top Nav Bar */}
      <header className="sticky top-0 z-30 bg-[#12151E]/95 backdrop-blur border-b border-white/[0.08] px-6 py-2.5 flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-brand-gold" />
            <span className="font-mono font-bold text-sm text-slate-100">IPL 2026 SEASON HUB</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-canvas border border-borderDark text-brand-gold">
              [{roomCode || 'ROOM'}]
            </span>
          </div>

          <nav className="ios-segmented flex items-center gap-1 font-mono text-xs">
            {[
              { id: 'MATCH_CENTER', label: 'Match Center' },
              { id: 'TEAM_MANAGER', label: 'Team Manager' },
              { id: 'FIXTURES', label: 'Fixtures' },
              { id: 'POINTS_TABLE', label: 'Points Table' },
              { id: 'STATS', label: 'Season Stats' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`h-8 px-3 rounded-lg transition-all duration-150 ${
                  activeTab === tab.id
                    ? 'ios-segmented-active bg-[#2C3246] text-white font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Global Action & Save Controls */}
        <div className="flex items-center gap-3">
          {saveSuccessMsg && (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded bg-brand-emerald/15 border border-brand-emerald/40 text-brand-emerald text-xs font-mono animate-fadeIn">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{saveSuccessMsg}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            {isStrictHost ? (
              <>
                <button
                  onClick={() => hostAction('FORCE_SAVE')}
                  className="h-9 py-[7px] px-[15px] rounded-xl bg-surfaceDark hover:bg-[#2C3246] border border-white/[0.08] text-xs font-mono font-bold text-slate-300 transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap"
                  title="Force Save Room to MongoDB"
                >
                  <Save className="w-3.5 h-3.5 text-brand-cyan" />
                  <span>Save Game</span>
                </button>

                <button
                  onClick={() => hostAction('TOGGLE_AUTO_SKIP_AI')}
                  className={`h-9 py-[7px] px-[15px] rounded-xl text-xs font-mono font-bold border transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap ${
                    season?.autoSkipAI
                      ? 'bg-brand-emerald/15 border-brand-emerald/40 text-brand-emerald'
                      : 'bg-surfaceDark hover:bg-[#2C3246] border-white/[0.08] text-slate-400'
                  }`}
                >
                  <FastForward className="w-3.5 h-3.5" />
                  <span>Auto-Skip AI: {season?.autoSkipAI ? 'ON' : 'OFF'}</span>
                </button>

                {/* Sim Alpha Setting Slider */}
                <div
                  className="h-9 px-3 rounded-xl bg-surfaceDark border border-white/[0.08] text-xs font-mono font-bold flex items-center gap-2 shadow-sm"
                  title="Simulation Alpha (α): Scales batting SR by α and bowling Economy by (2 - α). Range: 0.50 to 1.50 (Default 0.80)"
                >
                  <Sliders className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-slate-400 font-semibold text-[11px] whitespace-nowrap">α Alpha:</span>
                  <span className="text-amber-400 font-mono font-bold text-xs min-w-[2.2rem] text-center">
                    {simAlpha.toFixed(2)}
                  </span>
                  <input
                    type="range"
                    min="0.5"
                    max="1.5"
                    step="0.05"
                    value={simAlpha}
                    onChange={(e) => handleAlphaChange(parseFloat(e.target.value))}
                    className="w-20 accent-amber-400 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
                  />
                </div>
              </>
            ) : (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-canvas border border-white/[0.08] text-xs font-mono text-slate-400 whitespace-nowrap">
                <span className="w-2 h-2 rounded-full bg-brand-emerald" />
                <span>Cloud Synced</span>
                {season?.autoSkipAI && <span className="text-slate-500">• Auto-Skip AI: ON</span>}
              </div>
            )}

            {!allCompleted && nextFixture && (
              <button
                onClick={handlePlayNextMatch}
                disabled={isSimulating}
                className="h-9 py-[7px] px-[19px] rounded-xl bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-xs font-mono transition-transform active:scale-95 flex items-center gap-1.5 shadow-sm shadow-brand-gold/20 disabled:opacity-50 whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Play Match #{nextFixture.matchNumber}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleQuitRoom}
              className="h-9 py-[7px] px-3.5 rounded-xl bg-red-950/40 hover:bg-red-900/60 border border-red-800/60 text-xs font-mono font-bold text-red-300 transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap"
              title="Quit room and return to Home"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Quit Room</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {/* ========================================== */}
        {/* SUBVIEW 1: MATCH CENTER & FIXTURE ENGINE */}
        {/* ========================================== */}
        {activeTab === 'MATCH_CENTER' && (
          <div className="space-y-6">
            {/* UPCOMING MATCH HERO CARD (Role-Gated Permissions, Voting Handshake, Infinite Human Prep & Host Controls) */}
            {!allCompleted && nextFixture ? (() => {
              const matchLifecycle = season?.matchLifecycle;
              const prepTimerMs = matchLifecycle?.prepTimerMsRemaining ?? (matchLifecycle?.isHumanMatch ? 0 : 15000);
              const prepSeconds = Math.max(0, Math.ceil(prepTimerMs / 1000));
              const readyTeamIds = matchLifecycle?.readyTeamIds || [];
              const simulateVotes = matchLifecycle?.simulateVotes || [];

              const isHomeHuman = Boolean(teams[nextFixture.homeTeamId]?.isHuman);
              const isAwayHuman = Boolean(teams[nextFixture.awayTeamId]?.isHuman);
              const isUserHome = myFranchiseId === nextFixture.homeTeamId;
              const isUserAway = myFranchiseId === nextFixture.awayTeamId;
              const isUserParticipant = isUserHome || isUserAway;

              const activeHumanSeats = roomState?.seats?.filter(s => s.isHuman) || [];
              const activeHumanCount = Math.max(1, activeHumanSeats.length || Object.values(teams).filter(t => t.isHuman).length || 1);
              const hasUserVoted = simulateVotes.includes(myFranchiseId) || Boolean(mySeat && simulateVotes.includes(mySeat.teamId));

              const homeReady = readyTeamIds.includes(nextFixture.homeTeamId);
              const awayReady = readyTeamIds.includes(nextFixture.awayTeamId);
              const userTeamReady = isUserHome ? homeReady : (isUserAway ? awayReady : hasUserVoted);

              return (
                <div className="bg-tile border border-borderDark rounded-2xl p-6 relative overflow-hidden shadow-xl">
                  {/* Top Bar with Match Number & Venue */}
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pb-4 border-b border-borderDark font-mono text-xs text-slate-400">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-brand-gold animate-pulse" />
                      <span className="text-brand-gold font-bold uppercase tracking-wider">
                        UPCOMING FIXTURE • MATCH #{nextFixture.matchNumber} OF {fixtures.length}
                      </span>
                    </div>
                    <span className="text-slate-400">
                      📍 {nextFixture.venueName || `${teams[nextFixture.homeTeamId]?.name} Stadium`}
                    </span>
                  </div>

                  {/* Countdown Banner / State Banner */}
                  {matchLifecycle?.stage === 'RESULT_VIEW' ? (
                    <div className="mt-4 p-3 bg-gradient-to-r from-brand-gold/15 to-amber-500/10 border border-brand-gold/30 rounded-xl font-mono">
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="flex items-center gap-1.5 text-slate-200 font-bold">
                          <Clock className="w-3.5 h-3.5 text-brand-gold animate-spin" />
                          POST-MATCH RESULT REVIEW COUNTDOWN
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-brand-gold font-bold tabular-nums">
                            {Math.max(0, Math.ceil((matchLifecycle.resultTimerMsRemaining || 0) / 1000))}s remaining
                          </span>
                          <button
                            type="button"
                            onClick={() => hostAction('NEXT_MATCH')}
                            className="px-2 py-0.5 rounded bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-[10px] transition-all"
                            title="Skip review countdown and advance to next match"
                          >
                            Skip Countdown
                          </button>
                        </div>
                      </div>
                      <div className="w-full bg-tile rounded-full h-2 border border-borderDark/60 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-brand-gold to-amber-500 transition-all duration-1000"
                          style={{ width: `${Math.max(0, Math.min(100, ((matchLifecycle.resultTimerMsRemaining || 0) / 15000) * 100))}%` }}
                        />
                      </div>
                    </div>
                  ) : (isHomeHuman || isAwayHuman) ? (
                    <div className="mt-4 p-3 bg-canvas/80 border border-brand-emerald/30 rounded-xl font-mono">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 text-slate-200 font-bold">
                          <Clock className="w-3.5 h-3.5 text-brand-emerald" />
                          UNTIMED PRE-MATCH PREPARATION
                        </span>
                        <span className="text-brand-emerald font-bold">
                          Unlimited Prep Time (No Auto-Countdown)
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1">
                        Humans have unlimited time to adjust squad, lineup, and tactics before launching the match.
                      </p>
                    </div>
                  ) : (
                    <div className="mt-4 p-3 bg-canvas/80 border border-borderDark rounded-xl font-mono">
                      <div className="flex items-center justify-between text-xs mb-1.5">
                        <span className="flex items-center gap-1.5 text-slate-300 font-bold">
                          <Clock className="w-3.5 h-3.5 text-brand-gold animate-spin" />
                          AI vs AI AUTO-START COUNTDOWN
                        </span>
                        <span className="text-brand-gold font-bold tabular-nums">
                          {prepSeconds}s remaining (auto-simulates on 0s)
                        </span>
                      </div>
                      <div className="w-full bg-tile rounded-full h-2 border border-borderDark/60 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-brand-gold to-amber-500 transition-all duration-1000"
                          style={{ width: `${Math.max(0, Math.min(100, (prepTimerMs / 15000) * 100))}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Matchup Teams Banner */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center my-6">
                    {/* Home Team */}
                    <div className="p-4 rounded-xl bg-canvas border border-borderDark text-center md:text-left flex flex-col items-center md:items-start">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">HOME FRANCHISE</span>
                        {isHomeHuman && (
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-brand-gold/15 text-brand-gold border border-brand-gold/30">
                            HUMAN
                          </span>
                        )}
                      </div>
                      <h3 className="text-xl font-extrabold text-slate-100 mt-1">
                        {teams[nextFixture.homeTeamId]?.name || nextFixture.homeTeamId}
                      </h3>
                      <span className="text-xs font-mono text-brand-gold mt-1">
                        {teams[nextFixture.homeTeamId]?.squad?.length || 0} Squad Members
                      </span>
                    </div>

                    {/* Center Action & Role-Gated Simulation Controls */}
                    <div className="flex flex-col items-center justify-center gap-2.5">
                      <span className="text-xs font-mono font-bold px-3 py-0.5 rounded-full bg-subpill text-slate-400 border border-borderDark">
                        VS
                      </span>

                      {/* CASE 1: AI vs AI */}
                      {!isHomeHuman && !isAwayHuman && (
                        <div className="w-full flex flex-col items-center gap-2">
                          <button
                            onClick={() => {
                              setIsSimulating(true);
                              voteSimulate();
                              setTimeout(() => setIsSimulating(false), 800);
                            }}
                            disabled={isSimulating || hasUserVoted}
                            className={`w-full py-3 px-6 rounded-xl font-mono font-extrabold text-sm transition-all shadow-lg flex items-center justify-center gap-2 active:scale-95 ${
                              hasUserVoted
                                ? 'bg-brand-emerald/20 border border-brand-emerald text-brand-emerald cursor-default'
                                : 'bg-brand-gold hover:bg-brand-gold/90 text-slate-950 shadow-brand-gold/25'
                            }`}
                          >
                            <Play className="w-4 h-4 fill-current" />
                            <span>
                              {hasUserVoted
                                ? `✓ VOTED TO SIMULATE (${simulateVotes.length}/${activeHumanCount} VOTES)`
                                : `VOTE TO SIMULATE MATCH (${simulateVotes.length}/${activeHumanCount} VOTED • >50% REQUIRED)`}
                            </span>
                          </button>
                          <span className="text-[10px] font-mono text-slate-400">
                            Match auto-simulates when &gt; 50% of active humans vote or on 15s timer
                          </span>
                        </div>
                      )}

                      {/* CASE 2: Human vs AI */}
                      {((isHomeHuman && !isAwayHuman) || (!isHomeHuman && isAwayHuman)) && (
                        <div className="w-full flex flex-col items-center gap-2">
                          {isUserParticipant ? (
                            <button
                              onClick={handlePlayNextMatch}
                              disabled={isSimulating}
                              className="w-full py-3 px-6 rounded-xl bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-mono font-extrabold text-sm transition-all shadow-lg shadow-brand-gold/25 flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
                            >
                              <Play className="w-4 h-4 fill-current" />
                              <span>{isSimulating ? 'SIMULATING...' : `SIMULATE MATCH #${nextFixture.matchNumber}`}</span>
                            </button>
                          ) : (
                            <div className="w-full py-2.5 px-4 rounded-xl bg-subpill/80 border border-borderDark text-center font-mono text-xs text-slate-400 flex items-center justify-center gap-2">
                              <Clock className="w-3.5 h-3.5 text-brand-gold animate-spin" />
                              <span>Waiting for {teams[isHomeHuman ? nextFixture.homeTeamId : nextFixture.awayTeamId]?.name} to simulate...</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* CASE 3: Human vs Human (Both Must Vote to Simulate) */}
                      {isHomeHuman && isAwayHuman && (
                        <div className="w-full flex flex-col items-center gap-2">
                          {isUserParticipant ? (
                            <button
                              onClick={() => {
                                setIsSimulating(true);
                                voteSimulate();
                                sendMatchReady();
                                setTimeout(() => setIsSimulating(false), 800);
                              }}
                              disabled={isSimulating || userTeamReady}
                              className={`w-full py-3 px-6 rounded-xl font-mono font-extrabold text-sm transition-all shadow-lg flex items-center justify-center gap-2 active:scale-95 ${
                                userTeamReady
                                  ? 'bg-brand-emerald/20 border border-brand-emerald text-brand-emerald cursor-default'
                                  : 'bg-brand-gold hover:bg-brand-gold/90 text-slate-950 shadow-brand-gold/25'
                              }`}
                            >
                              <CheckCircle2 className="w-4 h-4" />
                              <span>{userTeamReady ? '✓ VOTE CAST (WAITING FOR OPPONENT)' : 'VOTE TO SIMULATE MATCH'}</span>
                            </button>
                          ) : (
                            <div className="w-full py-2.5 px-4 rounded-xl bg-subpill/80 border border-borderDark text-center font-mono text-xs text-slate-400 flex items-center justify-center gap-2">
                              <Clock className="w-3.5 h-3.5 text-brand-gold animate-spin" />
                              <span>Human vs Human • Waiting for both managers to vote...</span>
                            </div>
                          )}

                          {/* Handshake Status Pill */}
                          <div className={`w-full py-2 px-3 rounded-xl border text-center font-mono text-xs flex items-center justify-center gap-2 ${
                            homeReady && awayReady
                              ? 'bg-brand-emerald/15 border-brand-emerald/40 text-brand-emerald font-bold'
                              : (homeReady || awayReady)
                              ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                              : 'bg-subpill/80 border-borderDark text-slate-400'
                          }`}>
                            {homeReady && awayReady ? (
                              <span>Both Managers Voted! Simulating...</span>
                            ) : homeReady ? (
                              <span>{teams[nextFixture.homeTeamId]?.name} Voted (1/2) • Waiting for {teams[nextFixture.awayTeamId]?.name}...</span>
                            ) : awayReady ? (
                              <span>{teams[nextFixture.awayTeamId]?.name} Voted (1/2) • Waiting for {teams[nextFixture.homeTeamId]?.name}...</span>
                            ) : (
                              <span>Waiting for Both Human Managers to Vote (0/2 Ready)</span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Host Controls */}
                      {isHostEffective && (
                        <div className="w-full pt-3 mt-1 border-t border-borderDark/60 flex flex-col sm:flex-row items-center justify-center gap-3">
                          <button
                            onClick={() => {
                              setIsSimulating(true);
                              forceSimulateMatch();
                              hostAction('FORCE_SIMULATE');
                              setTimeout(() => setIsSimulating(false), 800);
                            }}
                            disabled={isSimulating}
                            className="px-3.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 font-mono font-bold text-xs transition-all flex items-center gap-1.5 active:scale-95"
                            title="Host Override: Immediately simulate current match"
                          >
                            <Zap className="w-3.5 h-3.5 text-amber-400" />
                            <span>Force Simulate Match</span>
                          </button>

                          {currentMatchIndex < 70 && (
                            <div className="relative">
                              <button
                                onClick={handleSimulateAll}
                                disabled={isSimulating}
                                className="px-3.5 py-1.5 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/40 text-blue-300 font-mono font-bold text-xs transition-all flex items-center gap-1.5 active:scale-95"
                                title="Host Action: Fast-forward remaining regular season matches to Match 70 (Playoffs)"
                              >
                                <FastForward className="w-3.5 h-3.5 text-blue-400" />
                                <span>Fast-Forward to Match 70 (Playoffs)</span>
                              </button>

                              {showSimulateAllConfirm && (
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-3 bg-[#1C202E] border border-amber-400/50 rounded-xl shadow-2xl z-50 text-left animate-fadeIn font-mono">
                                  <div className="text-xs font-bold text-amber-300 flex items-center gap-1.5 mb-1">
                                    <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                                    <span>Simulate All Till Match 70?</span>
                                  </div>
                                  <p className="text-[11px] text-slate-300 mb-3 leading-relaxed">
                                    Auto-simulate all remaining regular-season fixtures up to Match 70 in a fast-forward batch and pause at the Playoff Qualifiers.
                                  </p>
                                  <div className="flex items-center justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setShowSimulateAllConfirm(false)}
                                      className="px-2.5 py-1 rounded bg-subpill text-slate-400 hover:text-white text-[11px]"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={handleConfirmSimulateAll}
                                      className="px-2.5 py-1 rounded bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-[11px]"
                                    >
                                      Confirm Simulate
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Away Team */}
                    <div className="p-4 rounded-xl bg-canvas border border-borderDark text-center md:text-right flex flex-col items-center md:items-end">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">AWAY FRANCHISE</span>
                        {isAwayHuman && (
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-brand-gold/15 text-brand-gold border border-brand-gold/30">
                            HUMAN
                          </span>
                        )}
                      </div>
                      <h3 className="text-xl font-extrabold text-slate-100 mt-1">
                        {teams[nextFixture.awayTeamId]?.name || nextFixture.awayTeamId}
                      </h3>
                      <span className="text-xs font-mono text-brand-gold mt-1">
                        {teams[nextFixture.awayTeamId]?.squad?.length || 0} Squad Members
                      </span>
                    </div>
                  </div>

                  {/* Expected Lineups Preview */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-borderDark">
                    {/* Home XI Preview */}
                    {(() => {
                      const homeTeam = teams[nextFixture.homeTeamId];
                      const homeSquad = homeTeam?.squad || [];
                      const homeLineup = season?.lineups?.[nextFixture.homeTeamId];
                      let homeXI: IPLPlayer[] = [];

                      const isHomeLineupValid = homeLineup &&
                        homeLineup.playing11Ids?.length === 11 &&
                        validate352Lineup(homeLineup, homeSquad).valid;

                      if (isHomeLineupValid && homeLineup) {
                        const order = (homeLineup.battingOrder && homeLineup.battingOrder.length === 11)
                          ? homeLineup.battingOrder
                          : homeLineup.playing11Ids;
                        homeXI = order.map((id: string) => homeSquad.find((p: IPLPlayer) => p.id === id)).filter((p: any): p is IPLPlayer => Boolean(p));
                      }

                      if (homeXI.length !== 11 && homeSquad.length >= 11) {
                        try {
                          const gen = TeamMaker.makeSmartLineup(nextFixture.homeTeamId, homeSquad);
                          homeXI = gen.battingOrder.map((id: string) => homeSquad.find((p: IPLPlayer) => p.id === id)).filter((p: any): p is IPLPlayer => Boolean(p));
                        } catch {
                          const os = homeSquad.filter(p => p.isOverseas).sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0)).slice(0, 4);
                          const dom = homeSquad.filter(p => !p.isOverseas).sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0));
                          const pool = [...os, ...dom].slice(0, 11);
                          const bats = pool.filter(p => p.role === 'BAT' || p.role === 'WK').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
                          const ars = pool.filter(p => p.role === 'AR').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
                          const bowls = pool.filter(p => p.role === 'PACE' || p.role === 'SPIN').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
                          homeXI = [...bats, ...ars, ...bowls];
                        }
                      }
                      const homeOS = homeXI.filter((p: IPLPlayer) => p.isOverseas).length;

                      return (
                        <div className="p-3 bg-canvas/60 rounded-xl border border-borderDark/60">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-mono font-bold text-slate-400 uppercase">
                              {homeTeam?.name} PLAYING 11
                            </span>
                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${homeOS <= 4 ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/60' : 'bg-red-950/60 text-red-400 border border-red-800/60'}`}>
                              Overseas: {homeOS}/4
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
                            {homeXI.map((p, idx) => (
                              <span key={p.id} className="px-2 py-0.5 rounded bg-subpill text-slate-300 border border-borderDark flex items-center gap-1">
                                <span className="text-brand-gold font-bold">#{idx + 1}</span>
                                <span>{p.name}</span>
                                {p.isOverseas && <span title="Overseas Player">✈️</span>}
                                {p.role === 'WK' && <span title="Wicketkeeper" className="text-amber-400">★</span>}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Away XI Preview */}
                    {(() => {
                      const awayTeam = teams[nextFixture.awayTeamId];
                      const awaySquad = awayTeam?.squad || [];
                      const awayLineup = season?.lineups?.[nextFixture.awayTeamId];
                      let awayXI: IPLPlayer[] = [];

                      const isAwayLineupValid = awayLineup &&
                        awayLineup.playing11Ids?.length === 11 &&
                        validate352Lineup(awayLineup, awaySquad).valid;

                      if (isAwayLineupValid && awayLineup) {
                        const order = (awayLineup.battingOrder && awayLineup.battingOrder.length === 11)
                          ? awayLineup.battingOrder
                          : awayLineup.playing11Ids;
                        awayXI = order.map((id: string) => awaySquad.find((p: IPLPlayer) => p.id === id)).filter((p: any): p is IPLPlayer => Boolean(p));
                      }

                      if (awayXI.length !== 11 && awaySquad.length >= 11) {
                        try {
                          const gen = TeamMaker.makeSmartLineup(nextFixture.awayTeamId, awaySquad);
                          awayXI = gen.battingOrder.map((id: string) => awaySquad.find((p: IPLPlayer) => p.id === id)).filter((p: any): p is IPLPlayer => Boolean(p));
                        } catch {
                          const os = awaySquad.filter(p => p.isOverseas).sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0)).slice(0, 4);
                          const dom = awaySquad.filter(p => !p.isOverseas).sort((a, b) => (b.stats?.ovr || 0) - (a.stats?.ovr || 0));
                          const pool = [...os, ...dom].slice(0, 11);
                          const bats = pool.filter(p => p.role === 'BAT' || p.role === 'WK').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
                          const ars = pool.filter(p => p.role === 'AR').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
                          const bowls = pool.filter(p => p.role === 'PACE' || p.role === 'SPIN').sort((a, b) => (b.stats?.bat || 0) - (a.stats?.bat || 0));
                          awayXI = [...bats, ...ars, ...bowls];
                        }
                      }
                      const awayOS = awayXI.filter((p: IPLPlayer) => p.isOverseas).length;

                      return (
                        <div className="p-3 bg-canvas/60 rounded-xl border border-borderDark/60">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-mono font-bold text-slate-400 uppercase">
                              {awayTeam?.name} PLAYING 11
                            </span>
                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${awayOS <= 4 ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/60' : 'bg-red-950/60 text-red-400 border border-red-800/60'}`}>
                              Overseas: {awayOS}/4
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
                            {awayXI.map((p, idx) => (
                              <span key={p.id} className="px-2 py-0.5 rounded bg-subpill text-slate-300 border border-borderDark flex items-center gap-1">
                                <span className="text-brand-gold font-bold">#{idx + 1}</span>
                                <span>{p.name}</span>
                                {p.isOverseas && <span title="Overseas Player">✈️</span>}
                                {p.role === 'WK' && <span title="Wicketkeeper" className="text-amber-400">★</span>}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })() : allCompleted ? (() => {
              const finalMatch = completedFixtures.find((f: any) => f.matchNumber === 74 || f.matchType === 'FINAL') || completedFixtures[completedFixtures.length - 1];
              const winnerTeam = finalMatch?.winnerTeamId ? (teams[finalMatch.winnerTeamId] || { name: finalMatch.winnerTeamId }) : null;
              return (
                <div className="bg-tile border-2 border-brand-gold/60 rounded-2xl p-8 sm:p-12 text-center shadow-[0_0_60px_rgba(234,179,8,0.2)] relative overflow-hidden animate-fadeIn">
                  <div className="absolute inset-0 bg-gradient-to-b from-brand-gold/15 via-brand-gold/5 to-transparent pointer-events-none" />
                  <Trophy className="w-16 h-16 sm:w-20 sm:h-20 text-brand-gold mx-auto mb-3 animate-bounce filter drop-shadow-[0_0_20px_rgba(234,179,8,0.6)]" />
                  <div className="text-xs font-mono font-bold text-brand-gold tracking-widest uppercase mb-1">
                    🏆 TATA IPL 2026 CHAMPIONS 🏆
                  </div>
                  <h2 className="text-3xl sm:text-5xl font-black text-brand-gold tracking-wide drop-shadow-[0_2px_15px_rgba(234,179,8,0.5)] my-2">
                    {winnerTeam?.name || 'TOURNAMENT CHAMPIONS'}
                  </h2>
                  <p className="text-xs sm:text-sm font-mono text-slate-300 mt-2 max-w-lg mx-auto leading-relaxed">
                    All 74 matches concluded! <span className="text-brand-gold font-bold">{winnerTeam?.name || 'The Champions'}</span> have conquered the tournament and lifted the IPL 2026 Trophy!
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        leaveRoom();
                        router.push('/');
                      }}
                      className="h-9 px-5 rounded-xl bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-xs font-mono transition-transform active:scale-95 shadow-lg shadow-brand-gold/20 flex items-center gap-1.5"
                    >
                      <Sparkles className="w-4 h-4 fill-current" />
                      <span>Start New Tournament</span>
                    </button>
                  </div>
                </div>
              );
            })() : (
              <div className="bg-tile border border-borderDark rounded-2xl p-8 text-center flex flex-col items-center justify-center">
                <RotateCw className="w-8 h-8 text-brand-gold animate-spin mb-3" />
                <h3 className="text-base font-bold text-slate-200">Syncing Fixtures & Tournament Schedule...</h3>
                <p className="text-xs text-slate-400 font-mono mt-1">
                  Connecting to season simulator and loading the 45-match schedule.
                </p>
                <button
                  type="button"
                  onClick={handlePlayNextMatch}
                  className="mt-4 px-5 py-2.5 rounded-xl bg-brand-gold text-slate-950 font-bold font-mono text-xs hover:bg-brand-gold/90 transition-all flex items-center gap-1.5 shadow-lg shadow-brand-gold/20"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>▶ Play Match #1</span>
                </button>
              </div>
            )}

            {/* ============================================================== */}
            {/* DEEP MATCH ANALYTICS: SCORECARDS, OVER-BY-OVER DATA & GRAPHS   */}
            {/* ============================================================== */}
            {activeInspectedMatch && (
              <div className="bg-tile border border-borderDark rounded-2xl p-5 sm:p-6 shadow-2xl space-y-6">
                {/* 15-Second Post-Match Result Review Countdown Bar (Bug 5) */}
                {season?.matchLifecycle?.stage === 'RESULT_VIEW' && (
                  <div className="p-4 rounded-xl bg-gradient-to-r from-brand-gold/15 to-amber-500/10 border border-brand-gold/30 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs font-mono shadow-md">
                    <div className="flex items-center gap-2.5">
                      <Clock className="w-4 h-4 text-brand-gold animate-spin" />
                      <div>
                        <span className="text-slate-200 font-bold block">
                          POST-MATCH RESULT REVIEW: <strong className="text-brand-gold tabular-nums">{Math.max(0, Math.ceil((season.matchLifecycle.resultTimerMsRemaining || 0) / 1000))}s remaining</strong>
                        </span>
                        <span className="text-slate-400 text-[10px]">Auto-advancing to next fixture on 0s</span>
                      </div>
                    </div>
                    <button
                      onClick={() => hostAction('NEXT_MATCH')}
                      className="py-2 px-4 rounded-xl bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-xs transition-transform active:scale-95 shadow-md flex items-center gap-1.5 shrink-0"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Next Fixture ▶</span>
                    </button>
                  </div>
                )}

                {/* 1. MATCH SELECTOR & TOP CONTEXT BAR */}
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 pb-4 border-b border-borderDark font-mono text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2.5 py-1 rounded bg-brand-gold/15 text-brand-gold border border-brand-gold/30 font-bold">
                      MATCH #{activeInspectedMatch.matchNumber} {activeInspectedMatch.isPlayoff ? `• ${activeInspectedMatch.playoffStage?.replace('_', ' ')}` : '• LEAGUE'}
                    </span>
                    <span className="text-slate-400">
                      📍 {activeInspectedMatch.venueName}
                    </span>
                    <span className="text-slate-600">•</span>
                    <span className="text-slate-400">
                      Toss: <strong className="text-slate-200">{activeInspectedMatch.tossWinner}</strong> ({activeInspectedMatch.tossDecision === 'BAT' ? 'Batting 1st' : 'Bowling 1st'})
                    </span>
                  </div>

                  {/* Match-by-Match Switcher */}
                  <div className="flex items-center gap-2 self-end md:self-auto">
                    {completedFixtures.length > 1 && (
                      <div className="flex items-center gap-1 bg-canvas p-1 rounded-xl border border-borderDark text-[11px]">
                        <button
                          type="button"
                          disabled={!completedFixtures.some((f: any) => f.matchNumber < activeInspectedMatch.matchNumber)}
                          onClick={() => {
                            const prev = [...completedFixtures].reverse().find((f: any) => f.matchNumber < activeInspectedMatch.matchNumber);
                            if (prev) setInspectedMatchNumber(prev.matchNumber);
                          }}
                          className="px-2 py-0.5 rounded hover:bg-subpill text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Previous Match"
                        >
                          ◀ Prev
                        </button>

                        <select
                          value={activeInspectedMatch.matchNumber}
                          onChange={e => setInspectedMatchNumber(Number(e.target.value))}
                          className="bg-tile border-none text-brand-gold font-bold px-2 py-0.5 rounded text-xs focus:outline-none cursor-pointer"
                        >
                          {completedFixtures.map((f: any) => (
                            <option key={f.matchNumber} value={f.matchNumber}>
                              Match #{f.matchNumber}: {f.innings1.teamName} vs {f.innings2.teamName}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          disabled={!completedFixtures.some((f: any) => f.matchNumber > activeInspectedMatch.matchNumber)}
                          onClick={() => {
                            const next = completedFixtures.find((f: any) => f.matchNumber > activeInspectedMatch.matchNumber);
                            if (next) setInspectedMatchNumber(next.matchNumber);
                          }}
                          className="px-2 py-0.5 rounded hover:bg-subpill text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Next Match"
                        >
                          Next ▶
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 2. MATCH RESULT & SCORES BANNER */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Innings 1 Team Score Card */}
                  <div className="p-4 rounded-xl bg-canvas border border-borderDark flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-brand-gold" />
                        <h4 className="font-extrabold text-lg text-slate-100">
                          {activeInspectedMatch.innings1.teamName}
                        </h4>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-subpill text-slate-400">1st Inn</span>
                      </div>
                      <p className="text-xs text-slate-400 font-mono mt-1">
                        {activeInspectedMatch.innings1.oversCompleted} Overs Completed • RR: {activeInspectedMatch.innings1.runRate}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-3xl font-extrabold font-mono text-brand-gold">
                        {activeInspectedMatch.innings1.totalRuns} / {activeInspectedMatch.innings1.totalWickets}
                      </div>
                      <span className="text-[11px] font-mono text-slate-500">
                        ({activeInspectedMatch.innings1.oversCompleted} / 20 Ov)
                      </span>
                    </div>
                  </div>

                  {/* Innings 2 Team Score Card */}
                  <div className="p-4 rounded-xl bg-canvas border border-borderDark flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-brand-emerald" />
                        <h4 className="font-extrabold text-lg text-slate-100">
                          {activeInspectedMatch.innings2.teamName}
                        </h4>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-subpill text-slate-400">2nd Inn</span>
                      </div>
                      <p className="text-xs text-slate-400 font-mono mt-1">
                        {activeInspectedMatch.innings2.oversCompleted} Overs Completed • RR: {activeInspectedMatch.innings2.runRate}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-3xl font-extrabold font-mono text-brand-emerald">
                        {activeInspectedMatch.innings2.totalRuns} / {activeInspectedMatch.innings2.totalWickets}
                      </div>
                      <span className="text-[11px] font-mono text-slate-500">
                        Target: {activeInspectedMatch.innings1.totalRuns + 1}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Match Outcome & Player of the Match Row */}
                <div className="p-3.5 rounded-xl bg-subpill/60 border border-borderDark flex flex-col sm:flex-row items-center justify-between gap-3 text-xs font-mono">
                  <div className="flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-brand-gold" />
                    <span className="text-brand-emerald font-extrabold text-sm">
                      {activeInspectedMatch.marginText}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-slate-300">
                    <Medal className="w-4 h-4 text-brand-gold" />
                    <span>
                      Player of the Match:{' '}
                      <strong className="text-brand-gold">{activeInspectedMatch.playerOfTheMatch.name}</strong>{' '}
                      <span className="text-slate-400">({activeInspectedMatch.playerOfTheMatch.reason})</span>
                    </span>
                    {activeInspectedMatch.playerOfTheMatch.impactPoints && (
                      <span className="px-1.5 py-0.2 rounded bg-brand-gold/15 text-brand-gold text-[10px] font-bold">
                        {activeInspectedMatch.playerOfTheMatch.impactPoints} pts
                      </span>
                    )}
                  </div>
                </div>

                {/* 20-Over Manhattan Pill Strip (Over-by-Over Progression) */}
                <div className="p-4 rounded-xl bg-canvas border border-borderDark space-y-3 font-mono">
                  <div className="flex items-center justify-between text-xs pb-2 border-b border-borderDark/60">
                    <span className="font-bold text-slate-300 flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5 text-brand-gold" />
                      <span>20-OVER RUN STRIP (OVER-BY-OVER PROGRESSION)</span>
                    </span>
                    <span className="text-[10px] text-slate-500">Run intensity & wickets fallen</span>
                  </div>

                  {/* Innings 1 Over Pills */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-brand-gold font-bold">{activeInspectedMatch.innings1.teamName} (1st Inn):</span>
                      <span className="text-slate-400">{activeInspectedMatch.innings1.totalRuns}/{activeInspectedMatch.innings1.totalWickets} ({activeInspectedMatch.innings1.oversCompleted} Ov)</span>
                    </div>
                    <div className="grid grid-cols-10 sm:grid-cols-20 gap-1 text-[10px]">
                      {(activeInspectedMatch.innings1.overSummaries || []).map((ov: any) => {
                        const hasWicket = (ov.wickets || 0) > 0;
                        const isHighRun = (ov.runs || 0) >= 12;
                        return (
                          <div
                            key={ov.overNum}
                            title={`Over ${ov.overNum}: ${ov.runs} runs, ${ov.wickets || 0} wkts (Bowler: ${ov.bowlerName})`}
                            className={`p-1 rounded text-center border transition-all ${
                              hasWicket
                                ? 'bg-rose-500/20 border-rose-500 text-rose-300 font-bold'
                                : isHighRun
                                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 font-bold'
                                : 'bg-subpill/60 border-borderDark text-slate-300'
                            }`}
                          >
                            <div className="text-[9px] text-slate-500">O{ov.overNum}</div>
                            <div className="font-extrabold">{ov.runs}{hasWicket ? 'W' : ''}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Innings 2 Over Pills */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-brand-emerald font-bold">{activeInspectedMatch.innings2.teamName} (2nd Inn):</span>
                      <span className="text-slate-400">{activeInspectedMatch.innings2.totalRuns}/{activeInspectedMatch.innings2.totalWickets} ({activeInspectedMatch.innings2.oversCompleted} Ov)</span>
                    </div>
                    <div className="grid grid-cols-10 sm:grid-cols-20 gap-1 text-[10px]">
                      {(activeInspectedMatch.innings2.overSummaries || []).map((ov: any) => {
                        const hasWicket = (ov.wickets || 0) > 0;
                        const isHighRun = (ov.runs || 0) >= 12;
                        return (
                          <div
                            key={ov.overNum}
                            title={`Over ${ov.overNum}: ${ov.runs} runs, ${ov.wickets || 0} wkts (Bowler: ${ov.bowlerName})`}
                            className={`p-1 rounded text-center border transition-all ${
                              hasWicket
                                ? 'bg-rose-500/20 border-rose-500 text-rose-300 font-bold'
                                : isHighRun
                                ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 font-bold'
                                : 'bg-subpill/60 border-borderDark text-slate-300'
                            }`}
                          >
                            <div className="text-[9px] text-slate-500">O{ov.overNum}</div>
                            <div className="font-extrabold">{ov.runs}{hasWicket ? 'W' : ''}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* 3. TOP PERFORMERS SPOTLIGHT: MOST RUNS & MOST WICKETS (INN 1 & INN 2) */}
                {matchTopPerformers && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                        <Flame className="w-4 h-4 text-brand-gold" />
                        <span>MATCH TOP PERFORMERS (MOST RUNS & MOST WICKETS)</span>
                      </h4>
                      <span className="text-[11px] font-mono text-slate-500">Innings 1 & 2 Leaders</span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      {/* Innings 1 Most Runs */}
                      <div className="p-3.5 rounded-xl bg-canvas border border-amber-500/30 flex flex-col justify-between shadow-sm">
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-2">
                          <span className="text-amber-400 font-bold">🏏 INN 1 MOST RUNS</span>
                          <span className="text-slate-500">{activeInspectedMatch.innings1.teamName}</span>
                        </div>
                        {matchTopPerformers.inn1.topBatter ? (
                          <div>
                            <div className="flex items-center gap-1.5 font-bold text-slate-100 text-sm">
                              <span>👑 {matchTopPerformers.inn1.topBatter.name}</span>
                            </div>
                            <div className="flex items-baseline gap-2 mt-1">
                              <span className="text-xl font-extrabold font-mono text-amber-400">
                                {matchTopPerformers.inn1.topBatter.runs}
                              </span>
                              <span className="text-xs font-mono text-slate-400">
                                ({matchTopPerformers.inn1.topBatter.balls} balls)
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 mt-1 flex items-center gap-1.5">
                              <span>SR: {matchTopPerformers.inn1.topBatter.strikeRate || Math.round((matchTopPerformers.inn1.topBatter.runs / (matchTopPerformers.inn1.topBatter.balls || 1)) * 100)}</span>
                              <span>•</span>
                              <span>{matchTopPerformers.inn1.topBatter.fours}x4</span>
                              <span>•</span>
                              <span>{matchTopPerformers.inn1.topBatter.sixes}x6</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs font-mono text-slate-500 italic">No batter data</div>
                        )}
                      </div>

                      {/* Innings 1 Most Wickets */}
                      <div className="p-3.5 rounded-xl bg-canvas border border-purple-500/30 flex flex-col justify-between shadow-sm">
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-2">
                          <span className="text-purple-400 font-bold">🎯 INN 1 MOST WICKETS</span>
                          <span className="text-slate-500">{activeInspectedMatch.innings2.teamName}</span>
                        </div>
                        {matchTopPerformers.inn1.topBowler ? (
                          <div>
                            <div className="flex items-center gap-1.5 font-bold text-slate-100 text-sm">
                              <span>{matchTopPerformers.inn1.topBowler.name}</span>
                            </div>
                            <div className="flex items-baseline gap-2 mt-1">
                              <span className="text-xl font-extrabold font-mono text-purple-400">
                                {matchTopPerformers.inn1.topBowler.wickets} / {matchTopPerformers.inn1.topBowler.runsConceded}
                              </span>
                              <span className="text-xs font-mono text-slate-400">
                                ({matchTopPerformers.inn1.topBowler.overs} ov)
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 mt-1 flex items-center gap-1.5">
                              <span>Econ: {matchTopPerformers.inn1.topBowler.economy || (matchTopPerformers.inn1.topBowler.runsConceded / (matchTopPerformers.inn1.topBowler.overs || 1)).toFixed(2)}</span>
                              <span>•</span>
                              <span>Mdn: {matchTopPerformers.inn1.topBowler.maidens || 0}</span>
                              {matchTopPerformers.inn1.topBowler.dots && <span>• {matchTopPerformers.inn1.topBowler.dots} dots</span>}
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs font-mono text-slate-500 italic">No bowler data</div>
                        )}
                      </div>

                      {/* Innings 2 Most Runs */}
                      <div className="p-3.5 rounded-xl bg-canvas border border-amber-500/30 flex flex-col justify-between shadow-sm">
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-2">
                          <span className="text-amber-400 font-bold">🏏 INN 2 MOST RUNS</span>
                          <span className="text-slate-500">{activeInspectedMatch.innings2.teamName}</span>
                        </div>
                        {matchTopPerformers.inn2.topBatter ? (
                          <div>
                            <div className="flex items-center gap-1.5 font-bold text-slate-100 text-sm">
                              <span>👑 {matchTopPerformers.inn2.topBatter.name}</span>
                            </div>
                            <div className="flex items-baseline gap-2 mt-1">
                              <span className="text-xl font-extrabold font-mono text-amber-400">
                                {matchTopPerformers.inn2.topBatter.runs}
                              </span>
                              <span className="text-xs font-mono text-slate-400">
                                ({matchTopPerformers.inn2.topBatter.balls} balls)
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 mt-1 flex items-center gap-1.5">
                              <span>SR: {matchTopPerformers.inn2.topBatter.strikeRate || Math.round((matchTopPerformers.inn2.topBatter.runs / (matchTopPerformers.inn2.topBatter.balls || 1)) * 100)}</span>
                              <span>•</span>
                              <span>{matchTopPerformers.inn2.topBatter.fours}x4</span>
                              <span>•</span>
                              <span>{matchTopPerformers.inn2.topBatter.sixes}x6</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs font-mono text-slate-500 italic">No batter data</div>
                        )}
                      </div>

                      {/* Innings 2 Most Wickets */}
                      <div className="p-3.5 rounded-xl bg-canvas border border-purple-500/30 flex flex-col justify-between shadow-sm">
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-2">
                          <span className="text-purple-400 font-bold">🎯 INN 2 MOST WICKETS</span>
                          <span className="text-slate-500">{activeInspectedMatch.innings1.teamName}</span>
                        </div>
                        {matchTopPerformers.inn2.topBowler ? (
                          <div>
                            <div className="flex items-center gap-1.5 font-bold text-slate-100 text-sm">
                              <span>{matchTopPerformers.inn2.topBowler.name}</span>
                            </div>
                            <div className="flex items-baseline gap-2 mt-1">
                              <span className="text-xl font-extrabold font-mono text-purple-400">
                                {matchTopPerformers.inn2.topBowler.wickets} / {matchTopPerformers.inn2.topBowler.runsConceded}
                              </span>
                              <span className="text-xs font-mono text-slate-400">
                                ({matchTopPerformers.inn2.topBowler.overs} ov)
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 mt-1 flex items-center gap-1.5">
                              <span>Econ: {matchTopPerformers.inn2.topBowler.economy || (matchTopPerformers.inn2.topBowler.runsConceded / (matchTopPerformers.inn2.topBowler.overs || 1)).toFixed(2)}</span>
                              <span>•</span>
                              <span>Mdn: {matchTopPerformers.inn2.topBowler.maidens || 0}</span>
                              {matchTopPerformers.inn2.topBowler.dots && <span>• {matchTopPerformers.inn2.topBowler.dots} dots</span>}
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs font-mono text-slate-500 italic">No bowler data</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* 4. SUB-NAVIGATION TABS: GRAPHS, FULL SCORECARDS, OVER-BY-OVER DATA */}
                <div className="pt-2 border-t border-borderDark flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 font-mono text-xs">
                  <div className="flex items-center gap-1 p-1 rounded-xl bg-canvas border border-borderDark">
                    {[
                      { id: 'GRAPHS', label: 'Match Graphs & Worm Chart', icon: TrendingUp },
                      { id: 'SCORECARD', label: 'Full Scorecards', icon: BarChart2 },
                      { id: 'OVER_BY_OVER', label: 'Over-by-Over Deep Log', icon: Activity }
                    ].map(tab => {
                      const Icon = tab.icon;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setMatchReviewTab(tab.id as any)}
                          className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all font-bold ${
                            matchReviewTab === tab.id
                              ? 'bg-[#2C3246] text-white shadow-sm'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          <span>{tab.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Secondary control depending on active review tab */}
                  {matchReviewTab === 'GRAPHS' && (
                    <div className="flex items-center gap-1 p-1 rounded-xl bg-canvas border border-borderDark text-[11px]">
                      {(['WORM', 'MANHATTAN', 'PHASE_MATRIX'] as const).map(gm => (
                        <button
                          key={gm}
                          type="button"
                          onClick={() => setGraphViewMode(gm)}
                          className={`px-2.5 py-1 rounded-lg transition-all ${
                            graphViewMode === gm
                              ? 'bg-brand-gold text-slate-950 font-bold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {gm === 'WORM' ? 'Worm Chart' : gm === 'MANHATTAN' ? 'Manhattan Chart' : 'Phase Comparison'}
                        </button>
                      ))}
                    </div>
                  )}

                  {matchReviewTab === 'SCORECARD' && (
                    <div className="flex items-center gap-1 p-1 rounded-xl bg-canvas border border-borderDark text-[11px]">
                      {(['BOTH', 'INN1', 'INN2'] as const).map(tab => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setScorecardInningsTab(tab)}
                          className={`px-2.5 py-1 rounded-lg transition-all ${
                            scorecardInningsTab === tab
                              ? 'bg-brand-gold text-slate-950 font-bold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {tab === 'BOTH' ? 'Both Innings' : tab === 'INN1' ? activeInspectedMatch.innings1.teamName : activeInspectedMatch.innings2.teamName}
                        </button>
                      ))}
                    </div>
                  )}

                  {matchReviewTab === 'OVER_BY_OVER' && (
                    <div className="flex items-center gap-1 p-1 rounded-xl bg-canvas border border-borderDark text-[11px]">
                      {(['SIDE_BY_SIDE', 'INN1', 'INN2'] as const).map(tab => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setOverByOverInningsTab(tab)}
                          className={`px-2.5 py-1 rounded-lg transition-all ${
                            overByOverInningsTab === tab
                              ? 'bg-brand-gold text-slate-950 font-bold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {tab === 'SIDE_BY_SIDE' ? 'Side-by-Side (1-20)' : tab === 'INN1' ? `1st Inn: ${activeInspectedMatch.innings1.teamName}` : `2nd Inn: ${activeInspectedMatch.innings2.teamName}`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* 5. TAB VIEW 1: MATCH GRAPHS & VISUALIZATIONS */}
                {matchReviewTab === 'GRAPHS' && (
                  <div className="space-y-4 font-mono">
                    {/* WORM CHART */}
                    {graphViewMode === 'WORM' && (() => {
                      const inn1Overs = activeInspectedMatch.innings1?.overSummaries || [];
                      const inn2Overs = activeInspectedMatch.innings2?.overSummaries || [];
                      const totalRuns1 = activeInspectedMatch.innings1.totalRuns;
                      const totalRuns2 = activeInspectedMatch.innings2.totalRuns;
                      const maxRuns = Math.max(180, totalRuns1, totalRuns2);
                      const scaleMaxRuns = Math.ceil((maxRuns + 20) / 20) * 20;

                      const width = 800;
                      const height = 360;
                      const padLeft = 60;
                      const padRight = 30;
                      const padTop = 40;
                      const padBottom = 45;
                      const plotWidth = width - padLeft - padRight;
                      const plotHeight = height - padTop - padBottom;

                      const getX = (over: number) => padLeft + (over / 20) * plotWidth;
                      const getY = (runs: number) => (padTop + plotHeight) - (runs / scaleMaxRuns) * plotHeight;

                      let inn1Running = 0;
                      const inn1Points: Array<{ over: number; runs: number; wickets: number; bowler: string; score: string }> = [
                        { over: 0, runs: 0, wickets: 0, bowler: '', score: '0/0' }
                      ];
                      for (const o of inn1Overs) {
                        inn1Running = o.cumulativeRuns ?? (inn1Running + o.runs);
                        inn1Points.push({
                          over: o.overNum,
                          runs: inn1Running,
                          wickets: o.wickets,
                          bowler: o.bowlerName,
                          score: o.scoreSoFar
                        });
                      }

                      let inn2Running = 0;
                      const inn2Points: Array<{ over: number; runs: number; wickets: number; bowler: string; score: string }> = [
                        { over: 0, runs: 0, wickets: 0, bowler: '', score: '0/0' }
                      ];
                      for (const o of inn2Overs) {
                        inn2Running = o.cumulativeRuns ?? (inn2Running + o.runs);
                        inn2Points.push({
                          over: o.overNum,
                          runs: inn2Running,
                          wickets: o.wickets,
                          bowler: o.bowlerName,
                          score: o.scoreSoFar
                        });
                      }

                      const path1 = inn1Points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getX(pt.over).toFixed(1)} ${getY(pt.runs).toFixed(1)}`).join(' ');
                      const path2 = inn2Points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getX(pt.over).toFixed(1)} ${getY(pt.runs).toFixed(1)}`).join(' ');

                      const targetScore = totalRuns1 + 1;
                      const targetY = getY(targetScore);

                      const step = scaleMaxRuns <= 200 ? 40 : 50;
                      const yTicks: number[] = [];
                      for (let r = 0; r <= scaleMaxRuns; r += step) yTicks.push(r);

                      return (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-3 px-2 text-xs">
                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-2">
                                <span className="w-3.5 h-1.5 rounded-full bg-brand-gold" />
                                <span className="font-bold text-slate-200">
                                  {activeInspectedMatch.innings1.teamName}: {totalRuns1}/{activeInspectedMatch.innings1.totalWickets} ({activeInspectedMatch.innings1.oversCompleted} Ov)
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="w-3.5 h-1.5 rounded-full bg-brand-emerald" />
                                <span className="font-bold text-slate-200">
                                  {activeInspectedMatch.innings2.teamName}: {totalRuns2}/{activeInspectedMatch.innings2.totalWickets} ({activeInspectedMatch.innings2.oversCompleted} Ov)
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-3 text-slate-400">
                              <div className="flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 rounded-full bg-rose-500 border border-white" />
                                <span className="text-[11px]">Wicket Marker</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="w-4 h-0 border-t border-dashed border-rose-400/80" />
                                <span className="text-[11px]">Target ({targetScore})</span>
                              </div>
                            </div>
                          </div>

                          <div className="relative w-full overflow-hidden bg-canvas/70 rounded-xl border border-borderDark p-2">
                            <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none font-mono">
                              {/* Phase Shading */}
                              <rect x={getX(0)} y={padTop} width={getX(6) - getX(0)} height={plotHeight} fill="#0284c7" fillOpacity="0.04" />
                              <rect x={getX(6)} y={padTop} width={getX(16) - getX(6)} height={plotHeight} fill="#6366f1" fillOpacity="0.02" />
                              <rect x={getX(16)} y={padTop} width={getX(20) - getX(16)} height={plotHeight} fill="#e11d48" fillOpacity="0.04" />

                              {/* Phase Boundary Guides */}
                              <line x1={getX(6)} y1={padTop} x2={getX(6)} y2={padTop + plotHeight} stroke="#334155" strokeDasharray="3 3" />
                              <text x={getX(6)} y={padTop - 8} fill="#94a3b8" fontSize="10" textAnchor="middle">PP (Ov 6)</text>

                              <line x1={getX(16)} y1={padTop} x2={getX(16)} y2={padTop + plotHeight} stroke="#334155" strokeDasharray="3 3" />
                              <text x={getX(16)} y={padTop - 8} fill="#94a3b8" fontSize="10" textAnchor="middle">Middle (Ov 16)</text>

                              {/* Horizontal Gridlines */}
                              {yTicks.map(runs => {
                                const y = getY(runs);
                                return (
                                  <g key={runs}>
                                    <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="#1e293b" strokeDasharray="2 4" />
                                    <text x={padLeft - 10} y={y + 3.5} fill="#64748b" fontSize="10" textAnchor="end">
                                      {runs}
                                    </text>
                                  </g>
                                );
                              })}

                              {/* Target Line */}
                              {targetScore <= scaleMaxRuns && (
                                <g>
                                  <line
                                    x1={padLeft}
                                    y1={targetY}
                                    x2={width - padRight}
                                    y2={targetY}
                                    stroke="#f43f5e"
                                    strokeWidth="1.5"
                                    strokeDasharray="4 4"
                                    strokeOpacity="0.75"
                                  />
                                  <text x={width - padRight - 5} y={targetY - 5} fill="#f43f5e" fontSize="9" textAnchor="end" fontWeight="bold">
                                    Target: {targetScore}
                                  </text>
                                </g>
                              )}

                              {/* X-Axis Labels */}
                              {Array.from({ length: 21 }, (_, i) => i).map(ov => {
                                const x = getX(ov);
                                return (
                                  <g key={ov}>
                                    <line x1={x} y1={padTop} x2={x} y2={padTop + plotHeight} stroke={ov === 0 ? '#475569' : '#1e293b'} strokeDasharray={ov === 0 ? '' : '1 6'} />
                                    {ov % 2 === 0 && (
                                      <text x={x} y={padTop + plotHeight + 18} fill="#64748b" fontSize="10" textAnchor="middle">
                                        {ov === 0 ? 'Start' : ov}
                                      </text>
                                    )}
                                  </g>
                                );
                              })}
                              <text x={padLeft + plotWidth / 2} y={height - 8} fill="#94a3b8" fontSize="11" textAnchor="middle" fontWeight="bold">
                                OVERS COMPLETED
                              </text>

                              {/* Innings 1 Curve */}
                              <path d={path1} fill="none" stroke="#F59E0B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

                              {/* Innings 2 Curve */}
                              <path d={path2} fill="none" stroke="#10B981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

                              {/* Wickets Innings 1 */}
                              {inn1Points.filter(p => p.wickets > 0).map((p, idx) => (
                                <g key={`inn1-w-${idx}`}>
                                  <circle cx={getX(p.over)} cy={getY(p.runs)} r="5" fill="#EF4444" stroke="#FFFFFF" strokeWidth="1.5" />
                                  <text x={getX(p.over)} y={getY(p.runs) - 8} fill="#FCA5A5" fontSize="9" textAnchor="middle" fontWeight="bold">
                                    W
                                  </text>
                                </g>
                              ))}

                              {/* Wickets Innings 2 */}
                              {inn2Points.filter(p => p.wickets > 0).map((p, idx) => (
                                <g key={`inn2-w-${idx}`}>
                                  <circle cx={getX(p.over)} cy={getY(p.runs)} r="5" fill="#EF4444" stroke="#FFFFFF" strokeWidth="1.5" />
                                  <text x={getX(p.over)} y={getY(p.runs) - 8} fill="#FCA5A5" fontSize="9" textAnchor="middle" fontWeight="bold">
                                    W
                                  </text>
                                </g>
                              ))}

                              {/* Hover Indicator */}
                              {hoveredGraphOver !== null && hoveredGraphOver >= 1 && hoveredGraphOver <= 20 && (() => {
                                const hx = getX(hoveredGraphOver);
                                const inn1Pt = inn1Points.find(p => p.over === hoveredGraphOver);
                                const inn2Pt = inn2Points.find(p => p.over === hoveredGraphOver);
                                return (
                                  <g pointerEvents="none">
                                    <line x1={hx} y1={padTop} x2={hx} y2={padTop + plotHeight} stroke="#38BDF8" strokeWidth="1.5" strokeDasharray="3 3" />
                                    {inn1Pt && (
                                      <circle cx={hx} cy={getY(inn1Pt.runs)} r="6" fill="#F59E0B" stroke="#FFFFFF" strokeWidth="2" />
                                    )}
                                    {inn2Pt && (
                                      <circle cx={hx} cy={getY(inn2Pt.runs)} r="6" fill="#10B981" stroke="#FFFFFF" strokeWidth="2" />
                                    )}
                                  </g>
                                );
                              })()}

                              {/* Hover Slices */}
                              {Array.from({ length: 20 }, (_, i) => i + 1).map(ov => (
                                <rect
                                  key={`hover-slice-${ov}`}
                                  x={getX(ov - 1)}
                                  y={padTop}
                                  width={getX(ov) - getX(ov - 1)}
                                  height={plotHeight}
                                  fill="transparent"
                                  className="cursor-crosshair"
                                  onMouseEnter={() => setHoveredGraphOver(ov)}
                                  onMouseLeave={() => setHoveredGraphOver(null)}
                                />
                              ))}
                            </svg>

                            {/* Hover Details Card */}
                            {hoveredGraphOver !== null && hoveredGraphOver >= 1 && hoveredGraphOver <= 20 && (() => {
                              const inn1Ov = inn1Overs[hoveredGraphOver - 1];
                              const inn2Ov = inn2Overs[hoveredGraphOver - 1];
                              const inn1Pt = inn1Points.find(p => p.over === hoveredGraphOver);
                              const inn2Pt = inn2Points.find(p => p.over === hoveredGraphOver);

                              return (
                                <div className="mt-2 p-2.5 rounded-lg bg-tile border border-borderDark flex flex-wrap items-center justify-between gap-3 text-xs animate-fadeIn">
                                  <span className="font-bold text-sky-400">
                                    OVER #{hoveredGraphOver} PROGRESSION:
                                  </span>
                                  <div className="flex items-center gap-4 flex-wrap">
                                    <div className="flex items-center gap-1.5">
                                      <span className="w-2.5 h-2.5 rounded-full bg-brand-gold" />
                                      <span className="text-slate-300 font-bold">{activeInspectedMatch.innings1.teamName}:</span>
                                      <span className="text-brand-gold font-bold">{inn1Pt ? `${inn1Pt.runs}r (${inn1Pt.score})` : 'DNB'}</span>
                                      {inn1Ov && <span className="text-[11px] text-slate-400">(+{inn1Ov.runs}r, {inn1Ov.wickets}w b. {inn1Ov.bowlerName})</span>}
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="w-2.5 h-2.5 rounded-full bg-brand-emerald" />
                                      <span className="text-slate-300 font-bold">{activeInspectedMatch.innings2.teamName}:</span>
                                      <span className="text-brand-emerald font-bold">{inn2Pt ? `${inn2Pt.runs}r (${inn2Pt.score})` : 'DNB'}</span>
                                      {inn2Ov && <span className="text-[11px] text-slate-400">(+{inn2Ov.runs}r, {inn2Ov.wickets}w b. {inn2Ov.bowlerName})</span>}
                                    </div>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      );
                    })()}

                    {/* MANHATTAN CHART */}
                    {graphViewMode === 'MANHATTAN' && (() => {
                      const inn1Overs = activeInspectedMatch.innings1?.overSummaries || [];
                      const inn2Overs = activeInspectedMatch.innings2?.overSummaries || [];

                      const width = 800;
                      const height = 340;
                      const padLeft = 50;
                      const padRight = 20;
                      const padTop = 35;
                      const padBottom = 45;
                      const plotWidth = width - padLeft - padRight;
                      const plotHeight = height - padTop - padBottom;
                      const colWidth = plotWidth / 20;

                      let maxOverRuns = 16;
                      for (const o of inn1Overs) if (o.runs > maxOverRuns) maxOverRuns = o.runs;
                      for (const o of inn2Overs) if (o.runs > maxOverRuns) maxOverRuns = o.runs;
                      const scaleMaxOverRuns = Math.ceil((maxOverRuns + 2) / 5) * 5;

                      const getY = (runs: number) => (padTop + plotHeight) - (runs / scaleMaxOverRuns) * plotHeight;
                      const barWidth = Math.max(8, colWidth * 0.38);

                      return (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-3 px-2 text-xs">
                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3 rounded bg-brand-gold" />
                                <span className="font-bold text-slate-200">{activeInspectedMatch.innings1.teamName} (Runs/Over)</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3 rounded bg-brand-emerald" />
                                <span className="font-bold text-slate-200">{activeInspectedMatch.innings2.teamName} (Runs/Over)</span>
                              </div>
                            </div>
                            <span className="text-slate-400 text-[11px]">Red dot (W) indicates a wicket fell in that over</span>
                          </div>

                          <div className="w-full overflow-hidden bg-canvas/70 rounded-xl border border-borderDark p-2">
                            <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none font-mono">
                              {/* Phase Bands */}
                              <rect x={padLeft} y={padTop} width={colWidth * 6} height={plotHeight} fill="#0284c7" fillOpacity="0.04" />
                              <rect x={padLeft + colWidth * 6} y={padTop} width={colWidth * 10} height={plotHeight} fill="#6366f1" fillOpacity="0.02" />
                              <rect x={padLeft + colWidth * 16} y={padTop} width={colWidth * 4} height={plotHeight} fill="#e11d48" fillOpacity="0.04" />

                              {/* Gridlines */}
                              {[0, 5, 10, 15, 20, 25, 30].filter(r => r <= scaleMaxOverRuns).map(r => {
                                const y = getY(r);
                                return (
                                  <g key={r}>
                                    <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="#1e293b" strokeDasharray="2 4" />
                                    <text x={padLeft - 8} y={y + 3.5} fill="#64748b" fontSize="10" textAnchor="end">{r}</text>
                                  </g>
                                );
                              })}

                              {/* Bars per Over */}
                              {Array.from({ length: 20 }, (_, i) => i + 1).map(ov => {
                                const colX = padLeft + (ov - 1) * colWidth;
                                const o1 = inn1Overs[ov - 1];
                                const o2 = inn2Overs[ov - 1];
                                const r1 = o1?.runs ?? 0;
                                const r2 = o2?.runs ?? 0;
                                const w1 = o1?.wickets ?? 0;
                                const w2 = o2?.wickets ?? 0;

                                const h1 = (r1 / scaleMaxOverRuns) * plotHeight;
                                const y1 = padTop + plotHeight - h1;

                                const h2 = (r2 / scaleMaxOverRuns) * plotHeight;
                                const y2 = padTop + plotHeight - h2;

                                const x1 = colX + (colWidth / 2) - barWidth - 1.5;
                                const x2 = colX + (colWidth / 2) + 1.5;

                                return (
                                  <g key={ov}>
                                    {/* Innings 1 Bar */}
                                    {o1 && (
                                      <rect
                                        x={x1}
                                        y={y1}
                                        width={barWidth}
                                        height={h1}
                                        rx="2"
                                        fill="#F59E0B"
                                        fillOpacity="0.85"
                                      />
                                    )}
                                    {w1 > 0 && (
                                      <g>
                                        <circle cx={x1 + barWidth / 2} cy={y1 - 7} r="4.5" fill="#EF4444" stroke="#FFF" strokeWidth="1" />
                                        <text x={x1 + barWidth / 2} y={y1 - 4.5} fill="#FFF" fontSize="7" textAnchor="middle" fontWeight="bold">W</text>
                                      </g>
                                    )}

                                    {/* Innings 2 Bar */}
                                    {o2 && (
                                      <rect
                                        x={x2}
                                        y={y2}
                                        width={barWidth}
                                        height={h2}
                                        rx="2"
                                        fill="#10B981"
                                        fillOpacity="0.85"
                                      />
                                    )}
                                    {w2 > 0 && (
                                      <g>
                                        <circle cx={x2 + barWidth / 2} cy={y2 - 7} r="4.5" fill="#EF4444" stroke="#FFF" strokeWidth="1" />
                                        <text x={x2 + barWidth / 2} y={y2 - 4.5} fill="#FFF" fontSize="7" textAnchor="middle" fontWeight="bold">W</text>
                                      </g>
                                    )}

                                    {/* Over Number Label */}
                                    <text x={colX + colWidth / 2} y={padTop + plotHeight + 16} fill="#64748b" fontSize="10" textAnchor="middle">
                                      {ov}
                                    </text>
                                  </g>
                                );
                              })}
                            </svg>
                          </div>
                        </div>
                      );
                    })()}

                    {/* PHASE COMPARISON MATRIX */}
                    {graphViewMode === 'PHASE_MATRIX' && matchPhaseComparison && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {[
                          {
                            title: '1. POWERPLAY (OV 1-6)',
                            p1: matchPhaseComparison.inn1.pp,
                            p2: matchPhaseComparison.inn2.pp,
                            color: 'border-sky-500/30'
                          },
                          {
                            title: '2. MIDDLE OVERS (OV 7-16)',
                            p1: matchPhaseComparison.inn1.mid,
                            p2: matchPhaseComparison.inn2.mid,
                            color: 'border-indigo-500/30'
                          },
                          {
                            title: '3. DEATH OVERS (OV 17-20)',
                            p1: matchPhaseComparison.inn1.death,
                            p2: matchPhaseComparison.inn2.death,
                            color: 'border-rose-500/30'
                          }
                        ].map((ph, idx) => {
                          const runsDiff = ph.p1.runs - ph.p2.runs;
                          return (
                            <div key={idx} className={`p-4 rounded-xl bg-canvas border ${ph.color} flex flex-col justify-between shadow-sm`}>
                              <div className="pb-3 border-b border-borderDark flex items-center justify-between">
                                <h5 className="font-bold text-slate-200 text-xs">{ph.title}</h5>
                                <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${
                                  runsDiff > 0
                                    ? 'bg-amber-500/20 text-amber-300'
                                    : runsDiff < 0
                                    ? 'bg-emerald-500/20 text-emerald-300'
                                    : 'bg-subpill text-slate-400'
                                }`}>
                                  {runsDiff > 0 ? `+${runsDiff}r ${activeInspectedMatch.innings1.teamName}` : runsDiff < 0 ? `+${Math.abs(runsDiff)}r ${activeInspectedMatch.innings2.teamName}` : 'Even'}
                                </span>
                              </div>

                              <div className="my-3 space-y-3 text-xs">
                                {/* Inn 1 */}
                                <div>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="font-bold text-brand-gold">{activeInspectedMatch.innings1.teamName}:</span>
                                    <span className="font-bold text-slate-200">{ph.p1.runs}r / {ph.p1.wickets}w (RR {ph.p1.runRate})</span>
                                  </div>
                                  <div className="text-[10px] text-slate-500 flex items-center gap-2">
                                    <span>{ph.p1.fours} Fours</span>
                                    <span>•</span>
                                    <span>{ph.p1.sixes} Sixes</span>
                                    <span>•</span>
                                    <span>{ph.p1.count} Overs</span>
                                  </div>
                                </div>

                                {/* Inn 2 */}
                                <div>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="font-bold text-brand-emerald">{activeInspectedMatch.innings2.teamName}:</span>
                                    <span className="font-bold text-slate-200">{ph.p2.runs}r / {ph.p2.wickets}w (RR {ph.p2.runRate})</span>
                                  </div>
                                  <div className="text-[10px] text-slate-500 flex items-center gap-2">
                                    <span>{ph.p2.fours} Fours</span>
                                    <span>•</span>
                                    <span>{ph.p2.sixes} Sixes</span>
                                    <span>•</span>
                                    <span>{ph.p2.count} Overs</span>
                                  </div>
                                </div>
                              </div>

                              {/* Progress Comparison Meter */}
                              <div className="w-full bg-subpill rounded-full h-2 flex overflow-hidden">
                                <div
                                  className="bg-brand-gold h-full"
                                  style={{
                                    width: `${(ph.p1.runs / ((ph.p1.runs + ph.p2.runs) || 1)) * 100}%`
                                  }}
                                  title={`${activeInspectedMatch.innings1.teamName}: ${ph.p1.runs} runs`}
                                />
                                <div
                                  className="bg-brand-emerald h-full"
                                  style={{
                                    width: `${(ph.p2.runs / ((ph.p1.runs + ph.p2.runs) || 1)) * 100}%`
                                  }}
                                  title={`${activeInspectedMatch.innings2.teamName}: ${ph.p2.runs} runs`}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* 6. TAB VIEW 2: FULL SCORECARDS (BATTING & BOWLING TABLES) */}
                {matchReviewTab === 'SCORECARD' && (
                  <div className="space-y-6 font-mono text-xs">
                    {/* INNINGS 1 SCORECARD */}
                    {(scorecardInningsTab === 'BOTH' || scorecardInningsTab === 'INN1') && (
                      <div className="bg-canvas border border-borderDark rounded-xl overflow-hidden shadow-sm">
                        <div className="p-3.5 bg-tile border-b border-borderDark flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full bg-brand-gold" />
                            <h4 className="font-bold text-slate-200 uppercase">
                              1ST INNINGS: {activeInspectedMatch.innings1.teamName} BATTING
                            </h4>
                          </div>
                          <span className="text-brand-gold font-bold">
                            {activeInspectedMatch.innings1.totalRuns} / {activeInspectedMatch.innings1.totalWickets} ({activeInspectedMatch.innings1.oversCompleted} Ov)
                          </span>
                        </div>

                        {/* Batting Scorecard Table */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead className="bg-subpill text-slate-400 text-[11px] border-b border-borderDark">
                              <tr>
                                <th className="py-2 px-4">BATTER</th>
                                <th className="py-2 px-3">DISMISSAL</th>
                                <th className="py-2 px-3 text-right font-bold text-amber-400">R</th>
                                <th className="py-2 px-3 text-right">B</th>
                                <th className="py-2 px-3 text-right">4s</th>
                                <th className="py-2 px-3 text-right">6s</th>
                                <th className="py-2 px-4 text-right">SR</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-borderDark/40">
                              {(matchTopPerformers?.inn1.battersList || []).map((b: any, idx: number) => {
                                const isTop = idx === 0;
                                const isFifty = b.runs >= 50;
                                const sr = b.strikeRate ?? (b.balls > 0 ? Math.round((b.runs / b.balls) * 100) : 0);
                                const isHighSR = sr >= 160;

                                return (
                                  <tr key={b.name} className={`hover:bg-subpill/30 ${isTop ? 'bg-amber-500/[0.04]' : ''}`}>
                                    <td className="py-2 px-4 font-bold text-slate-200 flex items-center gap-1.5">
                                      {isTop && <span>👑</span>}
                                      <span>{b.name}</span>
                                    </td>
                                    <td className="py-2 px-3 text-slate-400 text-[11px]">
                                      {b.dismissalText || (b.isOut ? 'dismissed' : <span className="text-emerald-400 font-bold">not out</span>)}
                                    </td>
                                    <td className={`py-2 px-3 text-right font-black ${isFifty ? 'text-brand-gold bg-brand-gold/15 rounded px-2' : 'text-amber-400'}`}>
                                      {b.runs}{isFifty ? ' ★' : ''}
                                    </td>
                                    <td className="py-2 px-3 text-right text-slate-300">{b.balls}</td>
                                    <td className="py-2 px-3 text-right text-slate-400">{b.fours}</td>
                                    <td className="py-2 px-3 text-right text-slate-400">{b.sixes}</td>
                                    <td className={`py-2 px-4 text-right font-bold ${isHighSR ? 'text-emerald-400 font-black' : 'text-slate-300'}`}>
                                      {sr}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            <tfoot className="border-t border-borderDark bg-subpill/40 text-[11px] font-bold text-slate-300">
                              <tr>
                                <td colSpan={2} className="py-2 px-4 text-slate-400">Total (RR: {activeInspectedMatch.innings1.runRate})</td>
                                <td className="py-2 px-3 text-right text-brand-gold font-extrabold">{activeInspectedMatch.innings1.totalRuns}</td>
                                <td colSpan={4} className="py-2 px-3 text-slate-400 font-normal">
                                  ({activeInspectedMatch.innings1.totalWickets} wkts, {activeInspectedMatch.innings1.oversCompleted} Ov)
                                </td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>

                        {/* Fall of Wickets line if available */}
                        {activeInspectedMatch.innings1.fallOfWickets && activeInspectedMatch.innings1.fallOfWickets.length > 0 && (
                          <div className="p-3 border-t border-borderDark/60 bg-canvas/40 text-[10px] text-slate-400">
                            <strong className="text-slate-300">Fall of Wickets: </strong>
                            {activeInspectedMatch.innings1.fallOfWickets.map((w: any, idx: number) => (
                              <span key={idx} className="mr-2">
                                {w.score}/{w.wicketNum} ({w.batterName}, {w.overLabel} ov){idx < activeInspectedMatch.innings1.fallOfWickets.length - 1 ? ',' : ''}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Bowling Figures Table */}
                        <div className="p-3.5 bg-tile/70 border-t border-b border-borderDark flex items-center justify-between">
                          <h5 className="font-bold text-slate-300 uppercase text-[11px]">
                            {activeInspectedMatch.innings2.teamName} BOWLING FIGURES
                          </h5>
                          <span className="text-[11px] text-slate-500">Economy & Wickets</span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead className="bg-subpill text-slate-400 text-[11px] border-b border-borderDark">
                              <tr>
                                <th className="py-2 px-4">BOWLER</th>
                                <th className="py-2 px-3 text-right">O</th>
                                <th className="py-2 px-3 text-right">M</th>
                                <th className="py-2 px-3 text-right">R</th>
                                <th className="py-2 px-3 text-right font-bold text-purple-400">W</th>
                                <th className="py-2 px-4 text-right">ECON</th>
                                <th className="py-2 px-3 text-right">DOTS</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-borderDark/40">
                              {(matchTopPerformers?.inn1.bowlersList || []).map((bw: any, idx: number) => {
                                const isTop = idx === 0 && bw.wickets > 0;
                                const isThreeWkts = bw.wickets >= 3;
                                const econ = Number(bw.economy || (bw.runsConceded / (bw.overs || 1)).toFixed(2));
                                const isEconomical = econ < 7.0 && bw.overs > 0;

                                return (
                                  <tr key={bw.name} className={`hover:bg-subpill/30 ${isTop ? 'bg-purple-500/[0.04]' : ''}`}>
                                    <td className="py-2 px-4 font-bold text-slate-200 flex items-center gap-1.5">
                                      {isTop && <span>🎯</span>}
                                      <span>{bw.name}</span>
                                    </td>
                                    <td className="py-2 px-3 text-right text-slate-300">{bw.overs}</td>
                                    <td className="py-2 px-3 text-right text-slate-400">{bw.maidens || 0}</td>
                                    <td className="py-2 px-3 text-right text-slate-300">{bw.runsConceded}</td>
                                    <td className={`py-2 px-3 text-right font-black ${isThreeWkts ? 'text-brand-gold bg-brand-gold/15 rounded px-2' : 'text-purple-400 font-extrabold'}`}>
                                      {bw.wickets}{isThreeWkts ? ' 🎯' : ''}
                                    </td>
                                    <td className={`py-2 px-4 text-right font-bold ${isEconomical ? 'text-emerald-400' : 'text-slate-300'}`}>
                                      {econ.toFixed(2)}
                                    </td>
                                    <td className="py-2 px-3 text-right text-slate-400">{bw.dots ?? (bw.maidens * 6 || '-')}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* INNINGS 2 SCORECARD */}
                    {(scorecardInningsTab === 'BOTH' || scorecardInningsTab === 'INN2') && (
                      <div className="bg-canvas border border-borderDark rounded-xl overflow-hidden shadow-sm">
                        <div className="p-3.5 bg-tile border-b border-borderDark flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full bg-brand-emerald" />
                            <h4 className="font-bold text-slate-200 uppercase">
                              2ND INNINGS: {activeInspectedMatch.innings2.teamName} BATTING
                            </h4>
                          </div>
                          <span className="text-brand-emerald font-bold">
                            {activeInspectedMatch.innings2.totalRuns} / {activeInspectedMatch.innings2.totalWickets} ({activeInspectedMatch.innings2.oversCompleted} Ov)
                          </span>
                        </div>

                        {/* Batting Scorecard Table */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead className="bg-subpill text-slate-400 text-[11px] border-b border-borderDark">
                              <tr>
                                <th className="py-2 px-4">BATTER</th>
                                <th className="py-2 px-3">DISMISSAL</th>
                                <th className="py-2 px-3 text-right font-bold text-amber-400">R</th>
                                <th className="py-2 px-3 text-right">B</th>
                                <th className="py-2 px-3 text-right">4s</th>
                                <th className="py-2 px-3 text-right">6s</th>
                                <th className="py-2 px-4 text-right">SR</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-borderDark/40">
                              {(matchTopPerformers?.inn2.battersList || []).map((b: any, idx: number) => {
                                const isTop = idx === 0;
                                const isFifty = b.runs >= 50;
                                const sr = b.strikeRate ?? (b.balls > 0 ? Math.round((b.runs / b.balls) * 100) : 0);
                                const isHighSR = sr >= 160;

                                return (
                                  <tr key={b.name} className={`hover:bg-subpill/30 ${isTop ? 'bg-amber-500/[0.04]' : ''}`}>
                                    <td className="py-2 px-4 font-bold text-slate-200 flex items-center gap-1.5">
                                      {isTop && <span>👑</span>}
                                      <span>{b.name}</span>
                                    </td>
                                    <td className="py-2 px-3 text-slate-400 text-[11px]">
                                      {b.dismissalText || (b.isOut ? 'dismissed' : <span className="text-emerald-400 font-bold">not out</span>)}
                                    </td>
                                    <td className={`py-2 px-3 text-right font-black ${isFifty ? 'text-brand-gold bg-brand-gold/15 rounded px-2' : 'text-amber-400'}`}>
                                      {b.runs}{isFifty ? ' ★' : ''}
                                    </td>
                                    <td className="py-2 px-3 text-right text-slate-300">{b.balls}</td>
                                    <td className="py-2 px-3 text-right text-slate-400">{b.fours}</td>
                                    <td className="py-2 px-3 text-right text-slate-400">{b.sixes}</td>
                                    <td className={`py-2 px-4 text-right font-bold ${isHighSR ? 'text-emerald-400 font-black' : 'text-slate-300'}`}>
                                      {sr}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            <tfoot className="border-t border-borderDark bg-subpill/40 text-[11px] font-bold text-slate-300">
                              <tr>
                                <td colSpan={2} className="py-2 px-4 text-slate-400">Total (RR: {activeInspectedMatch.innings2.runRate})</td>
                                <td className="py-2 px-3 text-right text-brand-emerald font-extrabold">{activeInspectedMatch.innings2.totalRuns}</td>
                                <td colSpan={4} className="py-2 px-3 text-slate-400 font-normal">
                                  ({activeInspectedMatch.innings2.totalWickets} wkts, {activeInspectedMatch.innings2.oversCompleted} Ov)
                                </td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>

                        {/* Fall of Wickets line */}
                        {activeInspectedMatch.innings2.fallOfWickets && activeInspectedMatch.innings2.fallOfWickets.length > 0 && (
                          <div className="p-3 border-t border-borderDark/60 bg-canvas/40 text-[10px] text-slate-400">
                            <strong className="text-slate-300">Fall of Wickets: </strong>
                            {activeInspectedMatch.innings2.fallOfWickets.map((w: any, idx: number) => (
                              <span key={idx} className="mr-2">
                                {w.score}/{w.wicketNum} ({w.batterName}, {w.overLabel} ov){idx < activeInspectedMatch.innings2.fallOfWickets.length - 1 ? ',' : ''}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Bowling Figures Table */}
                        <div className="p-3.5 bg-tile/70 border-t border-b border-borderDark flex items-center justify-between">
                          <h5 className="font-bold text-slate-300 uppercase text-[11px]">
                            {activeInspectedMatch.innings1.teamName} BOWLING FIGURES
                          </h5>
                          <span className="text-[11px] text-slate-500">Economy & Wickets</span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead className="bg-subpill text-slate-400 text-[11px] border-b border-borderDark">
                              <tr>
                                <th className="py-2 px-4">BOWLER</th>
                                <th className="py-2 px-3 text-right">O</th>
                                <th className="py-2 px-3 text-right">M</th>
                                <th className="py-2 px-3 text-right">R</th>
                                <th className="py-2 px-3 text-right font-bold text-purple-400">W</th>
                                <th className="py-2 px-4 text-right">ECON</th>
                                <th className="py-2 px-3 text-right">DOTS</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-borderDark/40">
                              {(matchTopPerformers?.inn2.bowlersList || []).map((bw: any, idx: number) => {
                                const isTop = idx === 0 && bw.wickets > 0;
                                const isThreeWkts = bw.wickets >= 3;
                                const econ = Number(bw.economy || (bw.runsConceded / (bw.overs || 1)).toFixed(2));
                                const isEconomical = econ < 7.0 && bw.overs > 0;

                                return (
                                  <tr key={bw.name} className={`hover:bg-subpill/30 ${isTop ? 'bg-purple-500/[0.04]' : ''}`}>
                                    <td className="py-2 px-4 font-bold text-slate-200 flex items-center gap-1.5">
                                      {isTop && <span>🎯</span>}
                                      <span>{bw.name}</span>
                                    </td>
                                    <td className="py-2 px-3 text-right text-slate-300">{bw.overs}</td>
                                    <td className="py-2 px-3 text-right text-slate-400">{bw.maidens || 0}</td>
                                    <td className="py-2 px-3 text-right text-slate-300">{bw.runsConceded}</td>
                                    <td className={`py-2 px-3 text-right font-black ${isThreeWkts ? 'text-brand-gold bg-brand-gold/15 rounded px-2' : 'text-purple-400 font-extrabold'}`}>
                                      {bw.wickets}{isThreeWkts ? ' 🎯' : ''}
                                    </td>
                                    <td className={`py-2 px-4 text-right font-bold ${isEconomical ? 'text-emerald-400' : 'text-slate-300'}`}>
                                      {econ.toFixed(2)}
                                    </td>
                                    <td className="py-2 px-3 text-right text-slate-400">{bw.dots ?? (bw.maidens * 6 || '-')}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 7. TAB VIEW 3: OVER-BY-OVER DEEP LOG */}
                {matchReviewTab === 'OVER_BY_OVER' && (() => {
                  const inn1Overs = activeInspectedMatch.innings1?.overSummaries || [];
                  const inn2Overs = activeInspectedMatch.innings2?.overSummaries || [];

                  return (
                    <div className="space-y-4 font-mono text-xs">
                      {/* SIDE-BY-SIDE OVER VIEW */}
                      {overByOverInningsTab === 'SIDE_BY_SIDE' && (
                        <div className="bg-canvas border border-borderDark rounded-xl overflow-hidden shadow-sm">
                          <div className="p-3 bg-tile border-b border-borderDark flex items-center justify-between">
                            <h4 className="font-bold text-slate-200 uppercase text-xs">
                              SIDE-BY-SIDE OVER PROGRESSION (OVERS 1 TO 20)
                            </h4>
                            <span className="text-[11px] text-slate-400">
                              {activeInspectedMatch.innings1.teamName} (Inn 1) vs {activeInspectedMatch.innings2.teamName} (Inn 2)
                            </span>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full text-left">
                              <thead className="bg-subpill text-slate-400 text-[11px] border-b border-borderDark">
                                <tr>
                                  <th className="py-2.5 px-3 w-16 text-center">OVER</th>
                                  <th className="py-2.5 px-3">{activeInspectedMatch.innings2.teamName} BOWLER</th>
                                  <th className="py-2.5 px-3 text-center">INN 1 RUNS</th>
                                  <th className="py-2.5 px-3 text-right">INN 1 TOTAL</th>
                                  <th className="py-2.5 px-3 border-l border-borderDark/60">{activeInspectedMatch.innings1.teamName} BOWLER</th>
                                  <th className="py-2.5 px-3 text-center">INN 2 RUNS</th>
                                  <th className="py-2.5 px-3 text-right">INN 2 TOTAL</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-borderDark/40">
                                {Array.from({ length: 20 }, (_, i) => i + 1).map(ov => {
                                  const o1 = inn1Overs[ov - 1];
                                  const o2 = inn2Overs[ov - 1];
                                  if (!o1 && !o2) return null;

                                  const phaseBadge = ov <= 6 ? 'PP' : ov >= 17 ? 'DEATH' : 'MID';
                                  const phaseColor = ov <= 6 ? 'text-sky-300' : ov >= 17 ? 'text-rose-300' : 'text-indigo-300';

                                  return (
                                    <tr key={ov} className="hover:bg-subpill/30 transition-colors">
                                      <td className="py-2 px-3 text-center font-bold text-slate-400">
                                        <span>Ov {ov}</span>
                                        <span className={`block text-[9px] ${phaseColor}`}>{phaseBadge}</span>
                                      </td>

                                      {/* Inn 1 Col */}
                                      <td className="py-2 px-3 text-slate-300 font-medium">
                                        {o1 ? o1.bowlerName : '-'}
                                      </td>
                                      <td className="py-2 px-3 text-center font-bold">
                                        {o1 ? (
                                          <span className={`inline-block px-2 py-0.5 rounded text-[11px] ${
                                            o1.wickets > 0
                                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                              : o1.runs >= 12
                                              ? 'bg-amber-500/20 text-amber-300'
                                              : 'text-slate-300'
                                          }`}>
                                            +{o1.runs}r {o1.wickets > 0 && `• ${o1.wickets}w`}
                                          </span>
                                        ) : '-'}
                                      </td>
                                      <td className="py-2 px-3 text-right font-bold text-brand-gold">
                                        {o1 ? o1.scoreSoFar : '-'}
                                      </td>

                                      {/* Inn 2 Col */}
                                      <td className="py-2 px-3 border-l border-borderDark/60 text-slate-300 font-medium">
                                        {o2 ? o2.bowlerName : '-'}
                                      </td>
                                      <td className="py-2 px-3 text-center font-bold">
                                        {o2 ? (
                                          <span className={`inline-block px-2 py-0.5 rounded text-[11px] ${
                                            o2.wickets > 0
                                              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                              : o2.runs >= 12
                                              ? 'bg-amber-500/20 text-amber-300'
                                              : 'text-slate-300'
                                          }`}>
                                            +{o2.runs}r {o2.wickets > 0 && `• ${o2.wickets}w`}
                                          </span>
                                        ) : '-'}
                                      </td>
                                      <td className="py-2 px-3 text-right font-bold text-brand-emerald">
                                        {o2 ? o2.scoreSoFar : '-'}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* SINGLE INNINGS DETAILED LOG (INN 1 OR INN 2) */}
                      {(overByOverInningsTab === 'INN1' || overByOverInningsTab === 'INN2') && (() => {
                        const targetOvers = overByOverInningsTab === 'INN1' ? inn1Overs : inn2Overs;
                        const targetTeam = overByOverInningsTab === 'INN1' ? activeInspectedMatch.innings1.teamName : activeInspectedMatch.innings2.teamName;

                        return (
                          <div className="bg-canvas border border-borderDark rounded-xl overflow-hidden shadow-sm">
                            <div className="p-3 bg-tile border-b border-borderDark flex items-center justify-between">
                              <h4 className="font-bold text-slate-200 uppercase text-xs">
                                OVER-BY-OVER CHRONOLOGY: {targetTeam}
                              </h4>
                              <span className="text-[11px] text-slate-400">{targetOvers.length} Overs Bowled</span>
                            </div>

                            <div className="overflow-x-auto">
                              <table className="w-full text-left">
                                <thead className="bg-subpill text-slate-400 text-[11px] border-b border-borderDark">
                                  <tr>
                                    <th className="py-2.5 px-4 w-16 text-center">OVER</th>
                                    <th className="py-2.5 px-3 w-20">PHASE</th>
                                    <th className="py-2.5 px-4">BOWLER</th>
                                    <th className="py-2.5 px-3 text-center">RUNS CONCEDED</th>
                                    <th className="py-2.5 px-3 text-center">WICKETS</th>
                                    <th className="py-2.5 px-4 text-right">SCORE AFTER OVER</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-borderDark/40">
                                  {targetOvers.map((o: any) => (
                                    <tr key={o.overNum} className="hover:bg-subpill/30">
                                      <td className="py-2.5 px-4 text-center font-bold text-slate-400">
                                        Ov {o.overNum}
                                      </td>
                                      <td className="py-2.5 px-3">
                                        <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                                          o.overNum <= 6
                                            ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                                            : o.overNum >= 17
                                            ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                                            : 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
                                        }`}>
                                          {o.overNum <= 6 ? 'POWERPLAY' : o.overNum >= 17 ? 'DEATH' : 'MIDDLE'}
                                        </span>
                                      </td>
                                      <td className="py-2.5 px-4 font-bold text-slate-200">
                                        {o.bowlerName}
                                      </td>
                                      <td className="py-2.5 px-3 text-center font-mono font-bold">
                                        <span className={`px-2 py-0.5 rounded ${
                                          o.runs <= 4
                                            ? 'bg-emerald-500/20 text-emerald-400'
                                            : o.runs >= 12
                                            ? 'bg-amber-500/20 text-amber-300'
                                            : 'text-slate-200'
                                        }`}>
                                          {o.runs} runs
                                        </span>
                                      </td>
                                      <td className="py-2.5 px-3 text-center font-bold">
                                        {o.wickets > 0 ? (
                                          <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/40 text-[11px] animate-pulse">
                                            💥 {o.wickets} Wicket{o.wickets > 1 ? 's' : ''}
                                          </span>
                                        ) : (
                                          <span className="text-slate-600">-</span>
                                        )}
                                      </td>
                                      <td className="py-2.5 px-4 text-right font-extrabold text-brand-gold text-sm">
                                        {o.scoreSoFar}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* ========================================== */}
        {/* SUBVIEW 2: TEAM MANAGER (STAGE 1 & STAGE 2) */}
        {/* ========================================== */}
        {activeTab === 'TEAM_MANAGER' && (
          <div className="space-y-6">
            {/* Franchise Management Card */}
            <div className="bg-tile border border-borderDark rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-brand-gold/10 border border-brand-gold/30 flex items-center justify-center font-mono font-black text-brand-gold text-base shrink-0">
                  {currentTeam?.franchiseId || selectedTeamId}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-mono font-bold text-slate-100">
                      {isManagingMyTeam ? `MANAGING: ${currentTeam?.name}` : `SCOUTING: ${currentTeam?.name}`}
                    </h2>
                    {isManagingMyTeam ? (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-brand-emerald/20 text-brand-emerald border border-brand-emerald/40 font-bold flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-brand-emerald animate-pulse" />
                        YOUR HUMAN FRANCHISE
                      </span>
                    ) : (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold">
                        OPPONENT ROSTER (READ-ONLY)
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 font-mono mt-0.5">
                    {isManagingMyTeam
                      ? 'Configure your active 11-player lineup, batting order, and 3-5-2 bowling quotas.'
                      : 'Viewing opponent roster. Lineup editing is locked to your own franchise.'}
                  </p>
                </div>
              </div>

              {/* Franchise Ownership Badge (Bug 1: Opponent Scouting Locked) */}
              <div className="flex items-center gap-2">
                <span className="px-3 py-1.5 rounded-lg bg-subpill border border-borderDark text-xs font-mono text-brand-gold font-bold flex items-center gap-1.5 shadow-sm">
                  <span className="w-2 h-2 rounded-full bg-brand-gold animate-pulse" />
                  <span>MANAGING: {currentTeam?.name || selectedTeamId}</span>
                </span>
              </div>
            </div>

            {/* Stage Segmented Navigation */}
            <div className="flex items-center gap-2 p-1 bg-tile border border-borderDark rounded-xl text-xs font-mono">
              <button
                type="button"
                onClick={() => setManagerStage('STAGE_1')}
                className={`flex-1 py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-all ${
                  managerStage === 'STAGE_1'
                    ? 'bg-brand-gold text-slate-950 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>Stage 1: Squad & Playing 11</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${isStage1Valid ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-300'}`}>
                  {selectedCount}/11 • {bowlerCount}/6+ Bowlers
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (isStage1Valid) setManagerStage('STAGE_2');
                }}
                disabled={!isStage1Valid}
                className={`flex-1 py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  managerStage === 'STAGE_2'
                    ? 'bg-brand-gold text-slate-950 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>Stage 2: Batting Order & 3-5-2 Bowling</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${isStage2Valid ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-300'}`}>
                  {isStage2Valid ? 'Ready ✓' : 'Setup Required'}
                </span>
              </button>
            </div>

            {/* ========================================================= */}
            {/* STAGE 1: SQUAD SWAP & PLAYING 11 (MINIMUM 6 BOWLERS RULE) */}
            {/* ========================================================= */}
            {managerStage === 'STAGE_1' && (
              <div className="space-y-6">
                {/* Header & Quick Auto-Pick */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-tile border border-borderDark rounded-xl p-4">
                  <div>
                    <h2 className="text-base font-mono font-bold text-slate-100 flex items-center gap-2">
                      <span>PLAYING 11: {currentTeam?.name || selectedTeamId}</span>
                      {currentTeam?.isHuman ? (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-brand-emerald/20 text-brand-emerald border border-brand-emerald/40 font-normal">
                          YOUR HUMAN TEAM
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-700/50 text-slate-400 border border-borderDark font-normal">
                          AI CONTROLLED
                        </span>
                      )}
                    </h2>
                    <p className="text-xs text-slate-400 font-mono mt-1">
                      Stage 1 Constraints: Exactly 11 players • Max 4 Overseas • At least 1 WK • <strong>Hard Minimum 6 Bowlers</strong>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {currentTeam?.isHuman ? (
                      <button
                        type="button"
                        onClick={handleAutoPickNaive}
                        className="px-3.5 py-1.5 rounded-lg bg-brand-gold hover:bg-brand-gold/90 text-slate-950 text-xs font-mono font-bold transition-all flex items-center gap-1.5 active:scale-95 shadow-sm shadow-brand-gold/25"
                        title="Naive Auto-Picker: Instantly selects the top-rated legal 11 by OVR rating"
                      >
                        <Zap className="w-3.5 h-3.5 fill-current" />
                        <span>Auto-Pick Team (Top Ratings)</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleAutoPickSmart}
                        className="px-3.5 py-1.5 rounded-lg bg-brand-cyan/20 hover:bg-brand-cyan/30 border border-brand-cyan/50 text-brand-cyan text-xs font-mono font-bold transition-all flex items-center gap-1.5 active:scale-95 shadow-sm"
                        title="Smart AI Lineup: 3-5-2 Phase balance with death specialists and tactical synergy"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Auto-Pick Smart 11 (AI)</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setManagerStage('STAGE_2')}
                      disabled={!isStage1Valid}
                      className="px-4 py-1.5 rounded-lg bg-brand-emerald hover:bg-brand-emerald/90 text-slate-950 font-bold text-xs font-mono transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-sm shadow-brand-emerald/20"
                    >
                      <span>Configure Stage 2</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Validation Status Banner */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
                  <div className={`p-2.5 rounded-lg border flex items-center justify-between ${selectedCount === 11 ? 'bg-brand-emerald/10 border-brand-emerald/30 text-brand-emerald' : 'bg-canvas border-borderDark text-amber-400'}`}>
                    <span>PLAYERS:</span>
                    <span className="font-bold">{selectedCount} / 11</span>
                  </div>
                  <div className={`p-2.5 rounded-lg border flex items-center justify-between ${overseasCount <= 4 ? 'bg-canvas border-borderDark text-slate-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-400 font-bold'}`}>
                    <span>OVERSEAS ✈️:</span>
                    <span className="font-bold">{overseasCount} / 4</span>
                  </div>
                  <div className={`p-2.5 rounded-lg border flex items-center justify-between ${wkCount >= 1 ? 'bg-canvas border-borderDark text-slate-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-400 font-bold'}`}>
                    <span>WICKETKEEPER:</span>
                    <span className="font-bold">{wkCount} / 1+</span>
                  </div>
                  <div className={`p-2.5 rounded-lg border flex items-center justify-between ${bowlerCount >= 6 ? 'bg-brand-emerald/10 border-brand-emerald/30 text-brand-emerald font-bold' : 'bg-rose-500/10 border-rose-500/30 text-rose-400 font-bold'}`}>
                    <span>BOWLERS (MIN 6):</span>
                    <span className="font-bold">{bowlerCount} / 6+</span>
                  </div>
                </div>

                {/* Two-Column Deck: Starting XI (Left) & Available Squad Bench (Right) */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Box A: Starting XI */}
                  <div className="bg-tile border border-borderDark rounded-xl p-5 flex flex-col">
                    <div className="flex items-center justify-between pb-3 border-b border-borderDark mb-3">
                      <h3 className="text-xs font-mono font-bold text-brand-emerald uppercase tracking-wider flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-brand-emerald" />
                        STARTING 11 (ACTIVE)
                      </h3>
                      <span className="text-xs font-mono text-slate-400">
                        {selectedCount} / 11 Players
                      </span>
                    </div>

                    <div className="space-y-2 flex-1 overflow-y-auto max-h-[520px] pr-1">
                      {selectedPlayers.length === 0 ? (
                        <div className="p-8 text-center text-xs font-mono text-slate-500">
                          No players selected in Starting 11.<br />
                          Click <strong>[Auto-Pick Team (Top Ratings)]</strong> above or add from the bench.
                        </div>
                      ) : (
                        selectedPlayers.map((p, idx) => (
                          <div key={p.id} className="p-3 rounded-lg bg-canvas border border-borderDark hover:border-slate-600 transition-colors flex items-center justify-between text-xs">
                            <div>
                              <div className="font-bold text-slate-200 flex items-center gap-1.5 flex-wrap">
                                <span className="text-slate-500 font-mono text-[11px]">#{idx + 1}</span>
                                <span>{p.name}</span>
                                {p.isOverseas && <span>✈️</span>}
                                {p.role === 'WK' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-gold/20 text-brand-gold font-bold">WK</span>}
                                {TeamMaker.isBowler(p) && <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-emerald/20 text-brand-emerald font-bold">BOWL</span>}
                                {p.injuryStatus === 1 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30">🩹 Niggle (Out 1M)</span>}
                                {p.injuryStatus !== undefined && p.injuryStatus > 1 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 font-bold border border-rose-500/30">🚑 Strain ({p.injuryStatus}M)</span>}
                                {p.stamina !== undefined && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 font-mono font-bold border border-sky-500/20" title="Stamina / Capacity">
                                    🔋 {p.stamina.toFixed(1)} / {p.stats?.staminaRecov ?? 80}
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                                {p.role} • OVR {p.stats.ovr} • BAT {p.stats.bat} • BOWL {p.stats.bowl} • PWR {p.stats.power}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleBenchPlayer(p.id)}
                              className="px-2.5 py-1 rounded bg-subpill hover:bg-rose-500/20 hover:text-rose-300 border border-borderDark text-[11px] text-slate-300 font-mono transition-colors"
                            >
                              Bench
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Box B: Available Squad Bench */}
                  <div className="bg-tile border border-borderDark rounded-xl p-5 flex flex-col">
                    <div className="flex items-center justify-between pb-3 border-b border-borderDark mb-3">
                      <h3 className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-slate-500" />
                        SQUAD BENCH (AVAILABLE)
                      </h3>
                      <span className="text-xs font-mono text-slate-400">
                        {benchPlayers.length} Reserves
                      </span>
                    </div>

                    <div className="space-y-2 flex-1 overflow-y-auto max-h-[520px] pr-1">
                      {benchPlayers.length === 0 ? (
                        <div className="p-8 text-center text-xs font-mono text-slate-500">
                          All squad members are in the Starting 11.
                        </div>
                      ) : (
                        benchPlayers.map(p => (
                          <div key={p.id} className="p-3 rounded-lg bg-canvas border border-borderDark hover:border-slate-600 transition-colors flex items-center justify-between text-xs">
                            <div>
                              <div className="font-bold text-slate-300 flex items-center gap-1.5 flex-wrap">
                                <span>{p.name}</span>
                                {p.isOverseas && <span>✈️</span>}
                                {p.role === 'WK' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-gold/20 text-brand-gold font-bold">WK</span>}
                                {TeamMaker.isBowler(p) && <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-emerald/20 text-brand-emerald font-bold">BOWL</span>}
                                {p.injuryStatus === 1 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30">🩹 Niggle (Out 1M)</span>}
                                {p.injuryStatus !== undefined && p.injuryStatus > 1 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 font-bold border border-rose-500/30">🚑 Strain ({p.injuryStatus}M)</span>}
                                {p.stamina !== undefined && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 font-mono font-bold border border-sky-500/20" title="Stamina / Capacity">
                                    🔋 {p.stamina.toFixed(1)} / {p.stats?.staminaRecov ?? 80}
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                                {p.role} • OVR {p.stats.ovr} • BAT {p.stats.bat} • BOWL {p.stats.bowl} • PWR {p.stats.power}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleAddPlayer(p)}
                              disabled={selectedCount >= 11 || (p.isOverseas && overseasCount >= 4) || (p.injuryStatus !== undefined && p.injuryStatus !== 0)}
                              className="px-2.5 py-1 rounded bg-subpill hover:bg-brand-gold/20 hover:text-brand-gold border border-borderDark text-[11px] text-slate-300 font-mono transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              {p.injuryStatus !== undefined && p.injuryStatus !== 0 ? 'Sidelined' : 'Add to XI'}
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {/* Stage 1 Valid Navigation Callout */}
                {isStage1Valid && (
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 bg-brand-emerald/10 border border-brand-emerald/30 rounded-xl">
                    <div className="flex items-center gap-2 text-xs font-mono text-brand-emerald">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Stage 1 Complete: 11 Legal Players selected with {bowlerCount} bowling options.</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setManagerStage('STAGE_2')}
                      className="px-4 py-2 rounded-lg bg-brand-emerald hover:bg-brand-emerald/90 text-slate-950 font-bold text-xs font-mono transition-transform active:scale-95 flex items-center gap-2 shadow-sm shadow-brand-emerald/25"
                    >
                      <span>Proceed to Stage 2: Batting Order & 3-5-2 Bowling</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ========================================================= */}
            {/* STAGE 2: BATTING ORDER & 3-5-2 PHASE BOWLER QUOTA ENGINE */}
            {/* ========================================================= */}
            {managerStage === 'STAGE_2' && (
              <div className="space-y-6">
                {/* Header Controls */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-tile border border-borderDark rounded-xl p-4">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setManagerStage('STAGE_1')}
                      className="p-2 rounded-lg bg-canvas hover:bg-subpill border border-borderDark text-slate-300 transition-colors"
                      title="Back to Squad Swap"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>
                    <div>
                      <h2 className="text-base font-mono font-bold text-slate-100 flex items-center gap-2">
                        <span>STAGE 2: BATTING ORDER & 3-5-2 BOWLING MANAGER</span>
                      </h2>
                      <p className="text-xs text-slate-400 font-mono mt-0.5">
                        20 Overs Total • Max 4 Overs Per Bowler • Standard Phase Allocation
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAutoPickNaive}
                      className="px-3.5 py-1.5 rounded-lg bg-canvas hover:bg-subpill border border-borderDark text-slate-300 text-xs font-mono transition-all flex items-center gap-1.5 active:scale-95"
                    >
                      <Zap className="w-3.5 h-3.5 text-brand-gold fill-current" />
                      <span>Auto-Configure 3-5-2</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleSaveLineup}
                      disabled={!isStage2Valid}
                      className="px-4 py-1.5 rounded-lg bg-brand-emerald hover:bg-brand-emerald/90 text-slate-950 font-bold text-xs font-mono transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-sm shadow-brand-emerald/20"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>Save Lineup & Tactics</span>
                    </button>
                  </div>
                </div>

                {/* 4-2-2 Quota Overview Banner */}
                <div className="p-4 rounded-xl bg-canvas border border-borderDark grid grid-cols-2 md:grid-cols-4 gap-4 font-mono text-xs">
                  <div className="p-2.5 rounded-lg bg-tile border border-borderDark">
                    <div className="text-slate-400 text-[10px]">POWERPLAY (OV 1-6)</div>
                    <div className="text-base font-bold text-slate-100 mt-1 flex items-center justify-between">
                      <span>{ppBowlerIds.length} / 3 Bowlers</span>
                      <span className="text-[11px] text-brand-gold">6 Overs</span>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-tile border border-borderDark">
                    <div className="text-slate-400 text-[10px]">MIDDLE OVERS (OV 7-16)</div>
                    <div className="text-base font-bold text-slate-100 mt-1 flex items-center justify-between">
                      <span>{validMidBowlerIds.length} / 5 Bowlers</span>
                      <span className="text-[11px] text-brand-gold">10 Overs</span>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-tile border border-borderDark">
                    <div className="text-slate-400 text-[10px]">DEATH OVERS (OV 17-20)</div>
                    <div className="text-base font-bold text-slate-100 mt-1 flex items-center justify-between">
                      <span>{deathBowlerIds.length} / 2 Bowlers</span>
                      <span className="text-[11px] text-brand-gold">4 Overs</span>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-tile border border-borderDark">
                    <div className="text-slate-400 text-[10px]">PP & DEATH OVERLAP</div>
                    <div className="text-base font-bold text-slate-100 mt-1 flex items-center justify-between">
                      <span>{quotaResult.ppDeathOverlapCount} / 1 Max</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${quotaResult.ppDeathOverlapCount <= 1 ? 'bg-brand-emerald/20 text-brand-emerald' : 'bg-rose-500/20 text-rose-400'}`}>
                        {quotaResult.ppDeathOverlapCount <= 1 ? 'Legal ✓' : 'Exceeded'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Section A: Batting Order Reorder */}
                <div className="bg-tile border border-borderDark rounded-xl p-5">
                  <div className="flex items-center justify-between pb-3 border-b border-borderDark mb-3">
                    <h3 className="text-xs font-mono font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                      <span>BATTING ORDER (POSITIONS 1 TO 11)</span>
                    </h3>
                    <span className="text-xs font-mono text-slate-400">
                      Click ▲ / ▼ to reorder positions
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {battingOrder.map((pId, idx) => {
                      const p = selectedPlayers.find(x => x.id === pId);
                      if (!p) return null;
                      const isCap = captainId === p.id;
                      const isWk = designatedWkId === p.id || p.role === 'WK';

                      return (
                        <div key={p.id} className="p-2.5 rounded-lg bg-canvas border border-borderDark flex items-center justify-between text-xs font-mono">
                          <div className="flex items-center gap-2">
                            <span className="w-5 text-slate-500 font-bold">#{idx + 1}</span>
                            <div>
                              <div className="font-bold text-slate-200 flex items-center gap-1">
                                <span>{p.name}</span>
                                {p.isOverseas && <span>✈️</span>}
                                {isCap && <span className="text-[9px] px-1 rounded bg-brand-gold text-slate-950 font-bold">C</span>}
                                {isWk && <span className="text-[9px] px-1 rounded bg-brand-cyan/20 text-brand-cyan font-bold">WK</span>}
                              </div>
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                {p.role} • BAT {p.stats.bat} • PWR {p.stats.power}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => moveBattingOrder(idx, idx - 1)}
                              disabled={idx === 0}
                              className="p-1 rounded bg-subpill hover:bg-slate-700 disabled:opacity-20 text-slate-300"
                              title="Move Up"
                            >
                              <ChevronUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveBattingOrder(idx, idx + 1)}
                              disabled={idx === battingOrder.length - 1}
                              className="p-1 rounded bg-subpill hover:bg-slate-700 disabled:opacity-20 text-slate-300"
                              title="Move Down"
                            >
                              <ChevronDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setCaptainId(p.id)}
                              className={`p-1 rounded text-[10px] border ${isCap ? 'bg-brand-gold text-slate-950 border-brand-gold font-bold' : 'bg-canvas text-slate-400 border-borderDark hover:text-slate-200'}`}
                              title="Designate Captain"
                            >
                              ★
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Section B: 3-5-2 Phase Bowler Selection Deck */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-mono text-xs">
                  {/* BOX 1: POWERPLAY POOL (SELECT 3 BOWLERS • 2 OVERS EACH) */}
                  <div className="bg-tile border border-borderDark rounded-xl p-5 flex flex-col">
                    <div className="flex items-center justify-between pb-3 border-b border-borderDark mb-3">
                      <div>
                        <h4 className="font-bold text-slate-200 uppercase tracking-wider text-xs">
                          1. POWERPLAY POOL (OV 1-6)
                        </h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          Select 3 Bowlers • 2 Overs Each (6 Total)
                        </p>
                      </div>
                      <span className={`px-2 py-0.5 rounded font-bold ${ppBowlerIds.length === 3 ? 'bg-brand-emerald/20 text-brand-emerald border border-brand-emerald/40' : 'bg-canvas border border-borderDark text-amber-400'}`}>
                        {ppBowlerIds.length} / 3
                      </span>
                    </div>

                    <div className="space-y-2 flex-1">
                      {ppCandidates.map(p => {
                        const isSelected = ppBowlerIds.includes(p.id);
                        const isFirst = firstBowlerId === p.id;

                        return (
                          <div
                            key={p.id}
                            className={`p-3 rounded-lg border transition-all ${
                              isSelected
                                ? 'bg-brand-emerald/10 border-brand-emerald/40 text-slate-100'
                                : 'bg-canvas border-borderDark text-slate-400 hover:border-slate-600'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <label className="flex items-center gap-2 cursor-pointer flex-1">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => togglePPBowler(p.id)}
                                  className="rounded border-borderDark text-brand-emerald focus:ring-0 cursor-pointer"
                                />
                                <span className="font-bold text-slate-200">{p.name}</span>
                                <span className="text-[11px] text-slate-400 font-normal">({p.role} • OVR {p.stats?.ovr})</span>
                              </label>
                            </div>

                            {/* Over 1 First Bowler Toggle */}
                            {isSelected && (
                              <div className="mt-2.5 pt-2 border-t border-borderDark/60 flex items-center justify-between text-[11px]">
                                <span className="text-slate-400">Designate Over 1:</span>
                                <button
                                  type="button"
                                  onClick={() => setFirstBowlerId(p.id)}
                                  className={`px-2 py-0.5 rounded transition-all font-bold ${
                                    isFirst
                                      ? 'bg-brand-gold text-slate-950 shadow-sm'
                                      : 'bg-canvas text-slate-400 border border-borderDark hover:text-slate-200'
                                  }`}
                                >
                                  {isFirst ? '★ First Bowler (Over 1)' : 'Set as Over 1'}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* BOX 2: DEATH OVERS SLOTTING (OVERS 17-20) */}
                  <div className="bg-tile border border-borderDark rounded-xl p-5 flex flex-col">
                    <div className="flex items-center justify-between pb-3 border-b border-borderDark mb-3">
                      <div>
                        <h4 className="font-bold text-slate-200 uppercase tracking-wider text-xs">
                          2. DEATH OVERS SLOTTING (OV 17-20)
                        </h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          Assign 2 Bowlers • Overs 17 & 19 / Overs 18 & 20
                        </p>
                      </div>
                      <span className={`px-2 py-0.5 rounded font-bold ${isDeathValid ? 'bg-brand-emerald/20 text-brand-emerald border border-brand-emerald/40' : 'bg-canvas border border-borderDark text-amber-400'}`}>
                        {isDeathValid ? '2 / 2 Slotted' : 'Select Slots'}
                      </span>
                    </div>

                    <div className="space-y-4 flex-1">
                      {/* Slot 1: Overs 17 & 19 Specialist */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-brand-gold" />
                          Overs 17 & 19 Specialist:
                        </label>
                        <select
                          value={deathOver17_19BowlerId}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDeathOver17_19BowlerId(val);
                            setDeathBowlerIds([val, deathOver18_20BowlerId].filter(Boolean));
                            if (val && ppBowlerIds.includes(val)) {
                              setMidBowlerIds(prev => prev.filter(x => x !== val));
                            }
                          }}
                          className="w-full bg-canvas border border-borderDark rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-brand-gold font-mono"
                        >
                          <option value="">-- Select Specialist for Overs 17 & 19 --</option>
                          {candidateBowlers.map(p => {
                            const isAssignedOther = p.id === deathOver18_20BowlerId;
                            return (
                              <option key={p.id} value={p.id} disabled={isAssignedOther}>
                                {p.name} ({p.role} • OVR {p.stats?.ovr}){isAssignedOther ? ' [Assigned 18 & 20]' : ''}
                              </option>
                            );
                          })}
                        </select>
                      </div>

                      {/* Slot 2: Overs 18 & 20 Closer */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-brand-emerald" />
                          Overs 18 & 20 Closer:
                        </label>
                        <select
                          value={deathOver18_20BowlerId}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDeathOver18_20BowlerId(val);
                            setDeathBowlerIds([deathOver17_19BowlerId, val].filter(Boolean));
                            if (val && ppBowlerIds.includes(val)) {
                              setMidBowlerIds(prev => prev.filter(x => x !== val));
                            }
                          }}
                          className="w-full bg-canvas border border-borderDark rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-brand-gold font-mono"
                        >
                          <option value="">-- Select Closer for Overs 18 & 20 --</option>
                          {candidateBowlers.map(p => {
                            const isAssignedOther = p.id === deathOver17_19BowlerId;
                            return (
                              <option key={p.id} value={p.id} disabled={isAssignedOther}>
                                {p.name} ({p.role} • OVR {p.stats?.ovr}){isAssignedOther ? ' [Assigned 17 & 19]' : ''}
                              </option>
                            );
                          })}
                        </select>
                      </div>

                      {/* Validation / Conflict Notices */}
                      {deathOver17_19BowlerId && deathOver18_20BowlerId && deathOver17_19BowlerId === deathOver18_20BowlerId && (
                        <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[11px]">
                          ⚠️ Distinct bowlers required for Overs 17 & 19 and Overs 18 & 20.
                        </div>
                      )}

                      {quotaResult.ppDeathOverlapCount > 1 && (
                        <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[11px]">
                          ⚠️ Over Limit: Maximum 1 bowler can bowl in both Powerplay and Death overs.
                        </div>
                      )}

                      {/* Available Candidate Death Bowlers */}
                      <div className="pt-2 border-t border-borderDark/60 space-y-1.5">
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">
                          Candidate Death Bowlers:
                        </span>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                          {candidateBowlers.map(p => {
                            const isSlot1 = deathOver17_19BowlerId === p.id;
                            const isSlot2 = deathOver18_20BowlerId === p.id;
                            const isPP = ppBowlerIds.includes(p.id);

                            return (
                              <div
                                key={p.id}
                                className={`p-2 rounded-lg border flex items-center justify-between text-[11px] ${
                                  isSlot1 || isSlot2
                                    ? 'bg-brand-emerald/10 border-brand-emerald/40 text-slate-100'
                                    : 'bg-canvas border-borderDark text-slate-400'
                                }`}
                              >
                                <div className="flex items-center gap-1.5">
                                  <span className="font-bold text-slate-200">{p.name}</span>
                                  {isSlot1 && (
                                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-brand-gold/20 text-brand-gold border border-brand-gold/40">
                                      Ov 17 & 19
                                    </span>
                                  )}
                                  {isSlot2 && (
                                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-brand-emerald/20 text-brand-emerald border border-brand-emerald/40">
                                      Ov 18 & 20
                                    </span>
                                  )}
                                  {isPP && (
                                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300">
                                      PP
                                    </span>
                                  )}
                                </div>
                                <span className="text-[10px] text-slate-400 font-mono font-semibold">OVR {p.stats?.ovr}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* BOX 3: MIDDLE OVERS POOL (SELECT 5 BOWLERS • 10 OVERS TOTAL) */}
                  <div className="bg-tile border border-borderDark rounded-xl p-5 flex flex-col">
                    <div className="flex items-center justify-between pb-3 border-b border-borderDark mb-3">
                      <div>
                        <h4 className="font-bold text-slate-200 uppercase tracking-wider text-xs">
                          3. MIDDLE OVERS POOL (OV 7-16)
                        </h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          Select 5 Bowlers • 10 Overs Total
                        </p>
                      </div>
                      <span className={`px-2 py-0.5 rounded font-bold ${validMidBowlerIds.length === 5 ? 'bg-brand-emerald/20 text-brand-emerald border border-brand-emerald/40' : 'bg-canvas border border-borderDark text-amber-400'}`}>
                        {validMidBowlerIds.length} / 5
                      </span>
                    </div>

                    <div className="space-y-2 flex-1 overflow-y-auto max-h-[380px] pr-1">
                      {midCandidates.map(p => {
                        const isSelected = midBowlerIds.includes(p.id);
                        const quota = quotaResult.quotas[p.id]?.usableMiddleOvers ?? 2;
                        const isExhausted = quota === 0;

                        return (
                          <div
                            key={p.id}
                            className={`p-3 rounded-lg border transition-all ${
                              isSelected
                                ? 'bg-brand-emerald/10 border-brand-emerald/40 text-slate-100'
                                : isExhausted
                                ? 'bg-canvas/50 border-borderDark text-slate-600 opacity-60'
                                : 'bg-canvas border-borderDark text-slate-400 hover:border-slate-600'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <label className="flex items-center gap-2 cursor-pointer flex-1">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  disabled={!isSelected && (isExhausted || validMidBowlerIds.length >= 5)}
                                  onChange={() => toggleMidBowler(p.id)}
                                  className="rounded border-borderDark text-brand-emerald focus:ring-0 cursor-pointer disabled:cursor-not-allowed"
                                />
                                <span className={`font-bold ${isExhausted ? 'text-slate-500' : 'text-slate-200'}`}>
                                  {p.name}
                                </span>
                              </label>

                              {/* Live 4-2-2 Usable Middle Quota Badge */}
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                                  quota === 4
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : quota === 2
                                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                    : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                }`}
                                title={`${quota} overs available for Middle overs`}
                              >
                                {quota} Ov Available
                              </span>
                            </div>

                            {isExhausted && (
                              <p className="text-[10px] text-rose-400/80 mt-1.5">
                                0 overs available: Max 4 overs used in PP (2) & Death (2).
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Section C: Backup / Injury Replacement Bowler Dropdown */}
                <div className="bg-tile border border-borderDark rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 font-mono text-xs">
                  <div>
                    <span className="font-bold text-slate-200 flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-brand-gold" />
                      BACKUP / INJURY REPLACEMENT BOWLER:
                    </span>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Designate 1 bowler from Playing 11 who automatically absorbs overs if an active bowler is injured.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      value={backupBowlerId}
                      onChange={e => setBackupBowlerId(e.target.value)}
                      className="bg-canvas border border-borderDark text-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono focus:border-brand-gold focus:outline-none"
                    >
                      <option value="">-- Select Backup Bowler --</option>
                      {candidateBowlers.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.role} • OVR {p.stats.ovr})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Validation Blockers Notice (If Any) */}
                {!isStage2Valid && stage2Blockers.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs font-mono space-y-1.5 animate-fadeIn">
                    <div className="flex items-center gap-2 text-amber-300 font-bold">
                      <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                      <span>Lineup Incomplete ({stage2Blockers.length} issues to resolve before saving):</span>
                    </div>
                    <ul className="list-disc list-inside space-y-1 text-slate-300 pl-1 text-[11px]">
                      {stage2Blockers.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                    {stage2Blockers.some(b => b.includes('Middle overs')) && (
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            const validMids = candidateBowlerIds.filter(id => (quotaResult.quotas[id]?.usableMiddleOvers ?? 0) > 0);
                            setMidBowlerIds(validMids.slice(0, 5));
                          }}
                          className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded text-[10px] font-bold transition-all"
                        >
                          Auto-Fill Middle Overs Selection
                        </button>
                      </div>
                    )}

                  </div>
                )}

                {/* Validation Summary & Save Lineup Bar */}
                <div className="p-4 rounded-xl bg-tile border border-borderDark flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-xs">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-slate-400">CHECKS:</span>
                    <span className={ppBowlerIds.length === 3 ? 'text-brand-emerald font-bold' : 'text-slate-500'}>
                      {ppBowlerIds.length === 3 ? '✓ 3 PP Bowlers' : '✗ 3 PP Bowlers'}
                    </span>
                    <span className={firstBowlerId && ppBowlerIds.includes(firstBowlerId) ? 'text-brand-emerald font-bold' : 'text-slate-500'}>
                      {firstBowlerId && ppBowlerIds.includes(firstBowlerId) ? '✓ Over 1 Starter' : '✗ Over 1 Starter'}
                    </span>
                    <span className={isDeathValid ? 'text-brand-emerald font-bold' : 'text-amber-400 font-bold'}>
                      {isDeathValid ? '✓ 2 Death Bowlers' : '✗ 2 Death Bowlers'}
                    </span>
                    <span className={isMidValid ? 'text-brand-emerald font-bold' : 'text-amber-400 font-bold'}>
                      {isMidValid ? '✓ 5 Middle Bowlers' : '✗ 5 Middle Bowlers'}
                    </span>
                    <span className={isBackupValid ? 'text-brand-emerald font-bold' : 'text-slate-500'}>
                      {isBackupValid ? '✓ Backup Bowler' : '✗ Backup Bowler'}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveLineup}
                    disabled={!isStage2Valid}
                    className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-brand-emerald hover:bg-brand-emerald/90 text-slate-950 font-bold font-mono text-xs transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-brand-emerald/25"
                  >
                    <Save className="w-4 h-4" />
                    <span>SAVE 3-5-2 LINEUP & TACTICS</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================== */}
        {/* SUBVIEW 3: TOURNAMENT FIXTURES */}
        {/* ========================================== */}
        {activeTab === 'FIXTURES' && (
          <div className="bg-tile border border-borderDark rounded-xl p-5">
            <div className="flex items-center justify-between pb-4 border-b border-borderDark mb-4">
              <h3 className="text-xs font-mono font-bold text-slate-200 uppercase tracking-wider">
                TOURNAMENT FIXTURES SCHEDULE ({fixtures.length} MATCHES)
              </h3>
              <span className="text-xs font-mono text-brand-gold">
                {currentMatchIndex} / {fixtures.length} COMPLETED
              </span>
            </div>

            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {fixtures.map((f: any) => (
                <div key={f.matchId} className="p-3.5 rounded-lg bg-canvas border border-borderDark flex items-center justify-between text-xs hover:border-slate-600 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-slate-500 text-[11px] w-16">Match #{f.matchNumber}</span>
                    <strong className="text-slate-200">{teams[f.homeTeamId]?.name || f.homeTeamId}</strong>
                    <span className="text-slate-500 mx-1">vs</span>
                    <strong className="text-slate-200">{teams[f.awayTeamId]?.name || f.awayTeamId}</strong>
                  </div>
                  <div className="font-mono text-right">
                    {f.completed ? (
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <span className="text-brand-emerald font-bold">{f.marginText}</span>
                          <div className="text-[10px] text-slate-500">POTM: {f.playerOfTheMatch?.name}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setInspectedMatchNumber(f.matchNumber);
                            setActiveTab('MATCH_CENTER');
                          }}
                          className="px-2.5 py-1 rounded-lg bg-brand-gold/15 hover:bg-brand-gold/25 border border-brand-gold/30 text-brand-gold text-[10px] font-bold transition-all flex items-center gap-1 active:scale-95"
                          title="Open Deep Scorecard, Over-by-Over log & Graphs"
                        >
                          <Eye className="w-3 h-3" />
                          <span>Deep Review</span>
                        </button>
                      </div>
                    ) : f.matchNumber === currentMatchIndex + 1 ? (
                      <span className="text-brand-gold font-bold px-2 py-0.5 rounded bg-brand-gold/10 border border-brand-gold/30">
                        NEXT UP
                      </span>
                    ) : (
                      <span className="text-slate-500">Scheduled</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ========================================== */}
        {/* SUBVIEW 4: POINTS TABLE LEADERBOARD */}
        {/* ========================================== */}
        {activeTab === 'POINTS_TABLE' && (
          <div className="bg-tile border border-borderDark rounded-xl overflow-hidden">
            <div className="p-4 bg-canvas border-b border-borderDark flex items-center justify-between">
              <h3 className="text-xs font-mono font-bold text-slate-200 uppercase tracking-wider">
                IPL 2026 STANDINGS LEADERBOARD
              </h3>
              <span className="text-[11px] font-mono text-slate-400">Top 4 Qualify for Playoffs</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-subpill text-slate-400 border-b border-borderDark text-[11px]">
                  <tr>
                    <th className="py-2.5 px-4">POS</th>
                    <th className="py-2.5 px-4">TEAM</th>
                    <th className="py-2.5 px-3 text-center">P</th>
                    <th className="py-2.5 px-3 text-center">W</th>
                    <th className="py-2.5 px-3 text-center">L</th>
                    <th className="py-2.5 px-3 text-center">T</th>
                    <th className="py-2.5 px-3 text-center font-bold">PTS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-borderDark/40">
                  {sortedStandings.map((s: any, idx) => (
                    <tr key={s.teamId} className={`hover:bg-subpill/40 ${idx < 4 ? 'bg-brand-emerald/5' : ''}`}>
                      <td className="py-2.5 px-4 text-slate-500 font-bold">
                        <span className={`inline-block w-5 text-center ${idx < 4 ? 'text-brand-emerald font-extrabold' : ''}`}>
                          #{idx + 1}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 font-bold text-slate-200 flex items-center gap-2">
                        <span>{s.teamName}</span>
                        {idx < 4 && <span className="text-[9px] px-1 rounded bg-brand-emerald/20 text-brand-emerald">Q</span>}
                      </td>
                      <td className="py-2.5 px-3 text-center">{s.played}</td>
                      <td className="py-2.5 px-3 text-center text-brand-emerald">{s.won}</td>
                      <td className="py-2.5 px-3 text-center text-brand-rose">{s.lost}</td>
                      <td className="py-2.5 px-3 text-center text-slate-400">{s.tied}</td>
                      <td className="py-2.5 px-3 text-center font-bold text-brand-gold text-sm">{s.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ========================================== */}
        {/* SUBVIEW 5: STATS LEADERS & TOURNAMENT HONORS */}
        {/* ========================================== */}
        {activeTab === 'STATS' && (
          <div className="space-y-6 font-mono">
            {/* Top Stat Highlights Bar */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 rounded-xl bg-tile border border-borderDark flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-slate-400 font-bold block">COMPLETED MATCHES</span>
                  <span className="text-xl font-extrabold text-brand-gold mt-1 block">
                    {seasonStats.completedCount} <span className="text-xs text-slate-500 font-normal">/ {fixtures.length}</span>
                  </span>
                </div>
                <Calendar className="w-6 h-6 text-brand-gold/60" />
              </div>

              <div className="p-4 rounded-xl bg-tile border border-borderDark flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-slate-400 font-bold block">TOTAL SIXES 💥</span>
                  <span className="text-xl font-extrabold text-brand-cyan mt-1 block">
                    {seasonStats.totalSixes}
                  </span>
                </div>
                <Flame className="w-6 h-6 text-brand-cyan/60" />
              </div>

              <div className="p-4 rounded-xl bg-tile border border-borderDark flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-slate-400 font-bold block">TOTAL FOURS 🏏</span>
                  <span className="text-xl font-extrabold text-brand-emerald mt-1 block">
                    {seasonStats.totalFours}
                  </span>
                </div>
                <Zap className="w-6 h-6 text-brand-emerald/60" />
              </div>

              <div className="p-4 rounded-xl bg-tile border border-borderDark flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-slate-400 font-bold block">HIGHEST TEAM SCORE</span>
                  <span className="text-base font-extrabold text-slate-200 mt-1 block">
                    {seasonStats.highestTotal.score > 0
                      ? `${seasonStats.highestTotal.score}/${seasonStats.highestTotal.wkts}`
                      : 'N/A'}
                  </span>
                  <span className="text-[10px] text-slate-500 block truncate max-w-[120px]">
                    {seasonStats.highestTotal.team || 'Pending'}
                  </span>
                </div>
                <Trophy className="w-6 h-6 text-brand-gold/60" />
              </div>
            </div>

            {seasonStats.completedCount === 0 ? (
              <div className="bg-tile border border-borderDark rounded-2xl p-12 text-center">
                <BarChart2 className="w-10 h-10 text-brand-gold mx-auto mb-3 opacity-60" />
                <h3 className="text-base font-mono font-bold text-slate-200">No Tournament Matches Simulated Yet</h3>
                <p className="text-xs text-slate-400 font-mono mt-1 max-w-md mx-auto">
                  Simulate fixtures in the Match Center to unlock live Orange Cap, Purple Cap, and tournament milestones.
                </p>
              </div>
            ) : (
              <>
                {/* 2-Column Deck: Orange Cap (Left) & Purple Cap (Right) */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* ORANGE CAP LEADERBOARD */}
                  <div className="bg-tile border border-borderDark rounded-2xl p-5 flex flex-col shadow-lg">
                    <div className="flex items-center justify-between pb-3 border-b border-borderDark mb-3">
                      <div className="flex items-center gap-2">
                        <Award className="w-5 h-5 text-amber-500" />
                        <div>
                          <h3 className="text-xs font-mono font-bold text-slate-100 uppercase tracking-wider">
                            ORANGE CAP (TOP RUN-SCORERS)
                          </h3>
                          <span className="text-[10px] text-slate-400">
                            Leading run-scorer across all tournament fixtures
                          </span>
                        </div>
                      </div>
                      {seasonStats.orangeCapList[0] && (
                        <div className="px-2.5 py-1 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center gap-1.5">
                          <span>👑 {seasonStats.orangeCapList[0].name}</span>
                          <span>({seasonStats.orangeCapList[0].runs}r)</span>
                        </div>
                      )}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-canvas text-slate-400 border-b border-borderDark text-[10px]">
                          <tr>
                            <th className="py-2 px-3">#</th>
                            <th className="py-2 px-3">BATTER</th>
                            <th className="py-2 px-3">TEAM</th>
                            <th className="py-2 px-2 text-center">INNS</th>
                            <th className="py-2 px-2 text-center font-bold text-amber-400">RUNS</th>
                            <th className="py-2 px-2 text-center">HS</th>
                            <th className="py-2 px-2 text-center">SR</th>
                            <th className="py-2 px-2 text-center">4s</th>
                            <th className="py-2 px-2 text-center">6s</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-borderDark/40">
                          {seasonStats.orangeCapList.map((b, idx) => {
                            const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : '0.0';
                            return (
                              <tr key={b.name} className={`hover:bg-subpill/40 ${idx === 0 ? 'bg-amber-500/10' : ''}`}>
                                <td className="py-2 px-3 font-bold text-slate-500">
                                  <span className={`inline-block w-4 text-center ${idx === 0 ? 'text-amber-400 font-extrabold' : ''}`}>
                                    {idx + 1}
                                  </span>
                                </td>
                                <td className="py-2 px-3 font-bold text-slate-200">
                                  <span>{b.name}</span>
                                  {idx === 0 && <span className="ml-1.5 text-[9px] px-1 py-0.2 rounded bg-amber-500 text-slate-950 font-bold">CAP</span>}
                                </td>
                                <td className="py-2 px-3 text-slate-400 text-[11px] truncate max-w-[100px]">{b.teamName}</td>
                                <td className="py-2 px-2 text-center text-slate-300">{b.innings}</td>
                                <td className="py-2 px-2 text-center font-bold text-amber-400">{b.runs}</td>
                                <td className="py-2 px-2 text-center text-slate-300">{b.highestScore}</td>
                                <td className="py-2 px-2 text-center text-slate-400">{sr}</td>
                                <td className="py-2 px-2 text-center text-slate-400">{b.fours}</td>
                                <td className="py-2 px-2 text-center text-slate-400">{b.sixes}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* PURPLE CAP LEADERBOARD */}
                  <div className="bg-tile border border-borderDark rounded-2xl p-5 flex flex-col shadow-lg">
                    <div className="flex items-center justify-between pb-3 border-b border-borderDark mb-3">
                      <div className="flex items-center gap-2">
                        <Medal className="w-5 h-5 text-purple-400" />
                        <div>
                          <h3 className="text-xs font-mono font-bold text-slate-100 uppercase tracking-wider">
                            PURPLE CAP (TOP WICKET-TAKERS)
                          </h3>
                          <span className="text-[10px] text-slate-400">
                            Leading wicket-taker across all tournament fixtures
                          </span>
                        </div>
                      </div>
                      {seasonStats.purpleCapList[0] && (
                        <div className="px-2.5 py-1 rounded bg-purple-500/15 border border-purple-500/40 text-purple-300 text-xs font-bold flex items-center gap-1.5">
                          <span>👑 {seasonStats.purpleCapList[0].name}</span>
                          <span>({seasonStats.purpleCapList[0].wickets}w)</span>
                        </div>
                      )}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-canvas text-slate-400 border-b border-borderDark text-[10px]">
                          <tr>
                            <th className="py-2 px-3">#</th>
                            <th className="py-2 px-3">BOWLER</th>
                            <th className="py-2 px-3">TEAM</th>
                            <th className="py-2 px-2 text-center">OVERS</th>
                            <th className="py-2 px-2 text-center font-bold text-purple-400">WKTS</th>
                            <th className="py-2 px-2 text-center">ECON</th>
                            <th className="py-2 px-2 text-center">BEST</th>
                            <th className="py-2 px-2 text-center">DOTS</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-borderDark/40">
                          {seasonStats.purpleCapList.map((bw, idx) => {
                            const econ = bw.overs > 0 ? (bw.runsConceded / bw.overs).toFixed(2) : '0.00';
                            return (
                              <tr key={bw.name} className={`hover:bg-subpill/40 ${idx === 0 ? 'bg-purple-500/10' : ''}`}>
                                <td className="py-2 px-3 font-bold text-slate-500">
                                  <span className={`inline-block w-4 text-center ${idx === 0 ? 'text-purple-400 font-extrabold' : ''}`}>
                                    {idx + 1}
                                  </span>
                                </td>
                                <td className="py-2 px-3 font-bold text-slate-200">
                                  <span>{bw.name}</span>
                                  {idx === 0 && <span className="ml-1.5 text-[9px] px-1 py-0.2 rounded bg-purple-500 text-white font-bold">CAP</span>}
                                </td>
                                <td className="py-2 px-3 text-slate-400 text-[11px] truncate max-w-[100px]">{bw.teamName}</td>
                                <td className="py-2 px-2 text-center text-slate-300">{bw.overs}</td>
                                <td className="py-2 px-2 text-center font-bold text-purple-400">{bw.wickets}</td>
                                <td className="py-2 px-2 text-center text-slate-400">{econ}</td>
                                <td className="py-2 px-2 text-center text-slate-300">{bw.bestW}/{bw.bestR === 99 ? 0 : bw.bestR}</td>
                                <td className="py-2 px-2 text-center text-slate-400">{bw.dots}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* TOURNAMENT MVP / POTM HONORS */}
                {seasonStats.mvpList.length > 0 && (
                  <div className="bg-tile border border-borderDark rounded-2xl p-5 shadow-lg">
                    <div className="flex items-center gap-2 pb-3 border-b border-borderDark mb-3">
                      <Sparkles className="w-5 h-5 text-brand-gold" />
                      <h3 className="text-xs font-mono font-bold text-slate-100 uppercase tracking-wider">
                        MOST VALUABLE PLAYERS (PLAYER OF THE MATCH AWARDS)
                      </h3>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
                      {seasonStats.mvpList.map((m, idx) => (
                        <div key={m.name} className="p-3 rounded-xl bg-canvas border border-borderDark flex flex-col justify-between">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-slate-500 font-bold">RANK #{idx + 1}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-gold/20 text-brand-gold font-bold">
                              {m.potmCount}x POTM
                            </span>
                          </div>
                          <div className="mt-2">
                            <div className="font-bold text-slate-200 text-xs truncate">{m.name}</div>
                            <div className="text-[10px] text-slate-400 truncate mt-0.5">{m.team}</div>
                          </div>
                          <div className="mt-2 pt-2 border-t border-borderDark/60 text-[10px] text-slate-500">
                            {m.points} Impact Pts
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

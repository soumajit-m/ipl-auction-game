'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useGameRoomStore } from '@/lib/useGameRoomStore';
import {
  Gavel,
  Shield,
  Clock,
  Save,
  Pause,
  Play,
  Users,
  AlertCircle,
  TrendingUp,
  Sparkles,
  Plane,
  ChevronRight,
  ExternalLink,
  Star,
  CheckCircle2,
  Check,
  Filter,
  EyeOff,
  RotateCcw,
  FastForward,
  Search,
  X,
  LogOut
} from 'lucide-react';

function getDynamicBidIncrement(currentBid: number): number {
  const steps = Math.floor(Math.max(0, currentBid) / 5.0);
  return Math.min(Math.pow(2, steps) * 0.25, 1.00);
}

function getHumanMinPurseReserve(currentSquadCount: number): number {
  if (currentSquadCount >= 18) return 0.00;
  if (currentSquadCount <= 12) {
    return Number((6.60 - currentSquadCount * 0.30).toFixed(2));
  }
  return Number(((18 - currentSquadCount) * 0.50).toFixed(2));
}

export default function AuctionArenaPage() {
  const router = useRouter();
  const {
    roomState,
    roomCode,
    mySeat,
    initSocket,
    joinOrSyncRoom,
    claimSeat,
    placeBid,
    unskipAndBid,
    updateLiveFilter,
    toggleManualSkip,
    hostAction,
    isHost,
    saveStatus,
    errorMessage,
    clearError,
    skipAuctionDebug,
    voteSkipAuction,
    voteSkipSet,
    leaveRoom
  } = useGameRoomStore();

  const handleQuitRoom = () => {
    const confirmed = window.confirm(`Quit auction room [${roomCode || '---'}]? Your franchise will be handed over to AI Manager.`);
    if (!confirmed) return;
    leaveRoom();
    router.push('/');
  };

  const [inspectingTeamId, setInspectingTeamId] = useState<string>('CSK');
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [showSaveTick, setShowSaveTick] = useState(false);
  const [isBidLocked, setIsBidLocked] = useState(false);
  const [optimisticSkipped, setOptimisticSkipped] = useState<string | null>(null);
  const [skipAlert, setSkipAlert] = useState<string | null>(null);
  const [isDebugMode, setIsDebugMode] = useState(false);

  // Player Pool Master List Modal State
  const [allPlayers, setAllPlayers] = useState<any[]>([]);
  const [showPlayerPoolModal, setShowPlayerPoolModal] = useState(false);
  const [showSquadsModal, setShowSquadsModal] = useState(false);
  const [squadsModalTeamId, setSquadsModalTeamId] = useState<string>('CSK');
  const [poolSearch, setPoolSearch] = useState('');
  const [poolStatusFilter, setPoolStatusFilter] = useState<'ALL' | 'QUEUED' | 'LIVE' | 'SOLD' | 'UNSOLD'>('ALL');
  const [poolSetFilter, setPoolSetFilter] = useState<string>('CURRENT');
  const [poolRoleFilter, setPoolRoleFilter] = useState<string>('ALL');
  const [poolSortBy, setPoolSortBy] = useState<'OVR_DESC' | 'OVR_ASC' | 'PRICE_DESC' | 'PRICE_ASC' | 'NAME_ASC' | 'BASE_DESC'>('OVR_DESC');
  const [poolOverseasOnly, setPoolOverseasOnly] = useState(false);

  useEffect(() => {
    fetch(`/api/players?_t=${Date.now()}`, { cache: 'no-store' })
      .then(res => res.json())
      .then(data => {
        if (data?.players) setAllPlayers(data.players);
      })
      .catch(err => console.error('Failed to load auction player pool:', err));
  }, []);

  // FIX 6: Re-sync Room State on Mount or URL Query Changes (e.g. ?debug=true)
  useEffect(() => {
    initSocket();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlRoom = params.get('room') || params.get('roomCode');
      const activeCode = urlRoom || roomState?.roomCode || localStorage.getItem('active_ipl_room_code');
      if (activeCode) {
        localStorage.setItem('active_ipl_room_code', activeCode);
        joinOrSyncRoom(activeCode);
      }
      if (params.has('debug')) {
        setIsDebugMode(true);
        const debugVal = params.get('debug')?.toLowerCase();
        if (!debugVal || debugVal === 'true' || debugVal === '1' || debugVal === 'skip' || debugVal === 'auto') {
          setTimeout(() => {
            skipAuctionDebug();
          }, 600);
        }
      }
    }
  }, [initSocket, joinOrSyncRoom, skipAuctionDebug]);

  // Auto-fast-forward auction if ?debug=true is in URL and room arrives in AUCTION phase
  useEffect(() => {
    if (isDebugMode && roomState?.status === 'AUCTION') {
      const timer = setTimeout(() => {
        skipAuctionDebug();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isDebugMode, roomState?.status, skipAuctionDebug]);

  // Bento 4: Live Auto-Skip Control Deck State (FIX 5)
  const [minOvr, setMinOvr] = useState(60); // 60 = Off
  const [minBat, setMinBat] = useState(20); // 20 = Off
  const [minBowl, setMinBowl] = useState(20); // 20 = Off
  const [minPower, setMinPower] = useState(20); // 20 = Off
  const [maxBasePrice, setMaxBasePrice] = useState(2.00); // 2.00 = Off
  const [mutedRoles, setMutedRoles] = useState<string[]>([]);
  const [skipOverseas, setSkipOverseas] = useState(false);
  const [skipUncapped, setSkipUncapped] = useState(false);
  const [wishlistOnlyMode, setWishlistOnlyMode] = useState(false);

  const handleResetFilters = () => {
    setMinOvr(60);
    setMinBat(20);
    setMinBowl(20);
    setMinPower(20);
    setMaxBasePrice(2.00);
    setMutedRoles([]);
    setSkipOverseas(false);
    setSkipUncapped(false);
    setWishlistOnlyMode(false);
  };

  const toggleMuteRole = (role: string) => {
    setMutedRoles(prev => prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]);
  };

  useEffect(() => {
    if (roomState?.status === 'ANALYTICS') {
      const isDebug = typeof window !== 'undefined' && window.location.search.includes('debug');
      router.push(`/analytics?room=${roomState.roomCode || ''}${isDebug ? '&debug=true' : ''}`);
    } else if (roomState?.status === 'SEASON') {
      const isDebug = typeof window !== 'undefined' && window.location.search.includes('debug');
      router.push(`/season?room=${roomState.roomCode || ''}${isDebug ? '&debug=true' : ''}`);
    }
  }, [roomState?.status, roomState?.roomCode, router]);

  // Sync Live Filters to Server
  useEffect(() => {
    updateLiveFilter({
      skipOverseas,
      skipUncapped,
      wishlistOnlyMode,
      minOvr: minOvr > 60 ? minOvr : undefined,
      minBat: minBat > 20 ? minBat : undefined,
      minBowl: minBowl > 20 ? minBowl : undefined,
      minPower: minPower > 20 ? minPower : undefined,
      maxBasePrice: maxBasePrice < 2.00 ? maxBasePrice : undefined,
      mutedRoles: mutedRoles.length > 0 ? mutedRoles : undefined
    });
  }, [
    skipOverseas,
    skipUncapped,
    wishlistOnlyMode,
    minOvr,
    minBat,
    minBowl,
    minPower,
    maxBasePrice,
    mutedRoles,
    updateLiveFilter
  ]);

  // Flash compact green circular checkmark (✓) for 10 seconds on save
  useEffect(() => {
    if (saveStatus?.timestamp) {
      setShowSaveTick(true);
      const timer = setTimeout(() => setShowSaveTick(false), 10000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const currentLot = roomState?.currentLot;

  // Clear optimistic skip whenever lot changes
  useEffect(() => {
    setOptimisticSkipped(null);
  }, [currentLot?.lotId]);

  // 300ms Bid Cooldown Lock whenever ANY bid is placed
  useEffect(() => {
    if (currentLot?.bidHistory && currentLot.bidHistory.length > 0) {
      setIsBidLocked(true);
      const timer = setTimeout(() => setIsBidLocked(false), 300);
      return () => clearTimeout(timer);
    }
  }, [currentLot?.currentPrice, currentLot?.bidHistory?.length]);

  const teams = roomState?.teams || {};
  const storedTeamId = typeof window !== 'undefined' ? localStorage.getItem('ipl_claimed_team_id') : null;
  const humanTeamFromState = Object.values(teams).find(t => t.isHuman)?.franchiseId;
  const myTeamId = mySeat?.teamId || storedTeamId || humanTeamFromState || Object.keys(teams)[0];
  const myTeam = myTeamId ? teams[myTeamId] : null;

  // FIX 5: Human Purse Reserve & Max Allowed Bid calculation
  const squadCount = myTeam?.squad?.length || 0;
  const minReserve = getHumanMinPurseReserve(squadCount);
  const maxAllowedBid = Math.max(0, Number(((myTeam?.purse || 0) - minReserve).toFixed(2)));

  // Dynamic Bid Increment Formula: min((2 ** floor(current_bid)) * 0.25, 1.0) Cr
  const currentPrice = currentLot?.currentPrice || 0;
  const hasLeadingBid = Boolean(currentLot?.currentBidder);
  const bidIncrement = hasLeadingBid ? getDynamicBidIncrement(currentPrice) : 0.0;
  const nextBidAmount = hasLeadingBid
    ? Math.round((currentPrice + bidIncrement) * 100) / 100
    : (currentLot?.player?.basePrice || 0);

  const isModeA = currentLot?.biddingMode === 'MODE_A';
  const timerMs = currentLot?.timerMs || 0;
  // Decoupled Visual Countdown: 4.0s visual bar over 5.0s server window (or 800ms visual bar over 1000ms in 5x mode)
  const is5x = roomState?.auctionSpeedMultiplier === 5;
  const visualMaxMs = is5x ? 800 : 4000;
  const latencyBufferMs = is5x ? 200 : 1000;
  const visualMs = Math.max(0, timerMs - latencyBufferMs);
  const visualPercent = Math.max(0, Math.min(100, (visualMs / visualMaxMs) * 100));
  const isFinalCall = timerMs > 0 && timerMs <= latencyBufferMs;

  const inspectingTeam = teams[inspectingTeamId] || Object.values(teams)[0];

  const isPriorityTarget = Boolean(
    myTeam && currentLot && myTeam.wishlistIds && myTeam.wishlistIds.includes(currentLot.player.id)
  );

  const isManuallySkipped = Boolean(
    (myTeam && currentLot && myTeam.skipLotIds && myTeam.skipLotIds.includes(currentLot.player.id)) ||
    (optimisticSkipped && optimisticSkipped === currentLot?.player.id)
  );

  // Extract last 3 bids for horizontal trail
  const last3Bids = useMemo(() => {
    if (!currentLot || !currentLot.bidHistory) return [];
    return [...currentLot.bidHistory].slice(-3).reverse();
  }, [currentLot]);

  // Map of completed lots for looking up sold prices in roster inspector
  const completedLotsMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const lot of roomState?.completedLots || []) {
      if (lot.player?.id && lot.soldPrice !== null && lot.soldPrice !== undefined) {
        map.set(lot.player.id, lot.soldPrice);
      }
    }
    return map;
  }, [roomState?.completedLots]);

  // Player Pool Status Tracking (QUEUED, LIVE, SOLD, UNSOLD)
  const playerStatusMap = useMemo(() => {
    const statusMap = new Map<string, {
      status: 'SOLD' | 'UNSOLD' | 'LIVE' | 'QUEUED';
      soldPrice?: number;
      soldTo?: string;
      soldToName?: string;
    }>();

    // 1. Completed Lots
    for (const lot of roomState?.completedLots || []) {
      if (lot.player?.id) {
        if (lot.soldTo !== null && lot.soldPrice !== null) {
          const teamName = teams[lot.soldTo]?.name || lot.soldTo;
          statusMap.set(lot.player.id, {
            status: 'SOLD',
            soldPrice: lot.soldPrice,
            soldTo: lot.soldTo,
            soldToName: teamName
          });
        } else {
          statusMap.set(lot.player.id, {
            status: 'UNSOLD'
          });
        }
      }
    }

    // 2. Already assigned squad members (safety fallback)
    for (const team of Object.values(teams)) {
      for (const p of team.squad || []) {
        if (!statusMap.has(p.id) || statusMap.get(p.id)?.status !== 'SOLD') {
          statusMap.set(p.id, {
            status: 'SOLD',
            soldPrice: p.soldPrice || p.basePrice || 0.50,
            soldTo: team.franchiseId,
            soldToName: team.name
          });
        }
      }
    }

    // 3. Current Lot on hammer
    if (currentLot?.player?.id) {
      statusMap.set(currentLot.player.id, {
        status: 'LIVE',
        soldPrice: currentLot.currentPrice,
        soldTo: currentLot.currentBidder || undefined,
        soldToName: currentLot.currentBidderName || undefined
      });
    }

    return statusMap;
  }, [roomState?.completedLots, teams, currentLot]);

  const poolCounts = useMemo(() => {
    let sold = 0;
    let unsold = 0;
    let live = 0;
    let queued = 0;

    for (const p of allPlayers) {
      const st = playerStatusMap.get(p.id)?.status || 'QUEUED';
      if (st === 'SOLD') sold++;
      else if (st === 'UNSOLD') unsold++;
      else if (st === 'LIVE') live++;
      else queued++;
    }

    return { total: allPlayers.length, sold, unsold, live, queued };
  }, [allPlayers, playerStatusMap]);

  const filteredPoolPlayers = useMemo(() => {
    const list = allPlayers.filter(p => {
      const info = playerStatusMap.get(p.id) || { status: 'QUEUED' };
      const st = info.status;

      if (poolStatusFilter !== 'ALL' && st !== poolStatusFilter) return false;

      // Set Filter (Task 9: marqueeSet)
      if (poolSetFilter !== 'ALL') {
        const activeSet = currentLot?.player?.marqueeSet ?? 1;
        if (poolSetFilter === 'CURRENT') {
          if (p.marqueeSet !== activeSet) return false;
        } else {
          if (p.marqueeSet !== Number(poolSetFilter)) return false;
        }
      }

      if (poolRoleFilter !== 'ALL') {
        if (poolRoleFilter === 'BOWL') {
          if (p.role !== 'PACE' && p.role !== 'SPIN' && (p.role as any) !== 'BOWL') return false;
        } else if (p.role !== poolRoleFilter) {
          return false;
        }
      }

      if (poolOverseasOnly && !p.isOverseas) return false;

      if (poolSearch.trim()) {
        const q = poolSearch.toLowerCase();
        const matchName = p.name.toLowerCase().includes(q);
        const matchRole = p.role.toLowerCase().includes(q);
        const matchTeam = info.soldToName?.toLowerCase().includes(q) || info.soldTo?.toLowerCase().includes(q);
        if (!matchName && !matchRole && !matchTeam) return false;
      }

      return true;
    });

    list.sort((a, b) => {
      const infoA = playerStatusMap.get(a.id);
      const infoB = playerStatusMap.get(b.id);

      if (poolSortBy === 'OVR_DESC') {
        return (b.stats?.ovr || 0) - (a.stats?.ovr || 0);
      }
      if (poolSortBy === 'OVR_ASC') {
        return (a.stats?.ovr || 0) - (b.stats?.ovr || 0);
      }
      if (poolSortBy === 'PRICE_DESC') {
        const priceA = infoA?.soldPrice ?? a.basePrice ?? 0;
        const priceB = infoB?.soldPrice ?? b.basePrice ?? 0;
        return priceB - priceA;
      }
      if (poolSortBy === 'PRICE_ASC') {
        const priceA = infoA?.soldPrice ?? a.basePrice ?? 0;
        const priceB = infoB?.soldPrice ?? b.basePrice ?? 0;
        return priceA - priceB;
      }
      if (poolSortBy === 'BASE_DESC') {
        return (b.basePrice || 0) - (a.basePrice || 0);
      }
      if (poolSortBy === 'NAME_ASC') {
        return a.name.localeCompare(b.name);
      }
      return 0;
    });

    return list;
  }, [allPlayers, playerStatusMap, poolStatusFilter, poolSetFilter, poolRoleFilter, poolOverseasOnly, poolSearch, poolSortBy, currentLot?.player?.marqueeSet]);

  const handlePlaceBid = () => {
    if (!currentLot || !myTeam || isBidLocked || currentLot.currentBidder === myTeamId || roomState?.isPaused || roomState?.isAuctionPaused) return;
    setIsBidLocked(true);
    setTimeout(() => setIsBidLocked(false), 300);
    placeBid(currentLot.lotId, currentLot.currentPrice, nextBidAmount);
  };

  const handleToggleSkip = () => {
    if (!currentLot) return;
    if (isManuallySkipped) {
      setOptimisticSkipped(null);
    } else {
      setOptimisticSkipped(currentLot.player.id);
    }
    toggleManualSkip(myTeamId || undefined, roomCode || undefined);
  };

  const handleUnskip = () => {
    if (!currentLot) return;
    unskipAndBid(currentLot.lotId);
  };

  const handleForceSave = () => {
    hostAction('FORCE_SAVE');
  };

  const humanTeams = useMemo(() => {
    return Object.values(teams).filter(t => t.isHuman);
  }, [teams]);
  const totalHumanCount = humanTeams.length;
  const skipVotes = roomState?.skipVotes || [];
  const myTeamHasVoted = Boolean(myTeamId && skipVotes.includes(myTeamId));

  const handleVoteSkipToSeason = () => {
    if (!myTeam) {
      setSkipAlert('You must manage a franchise to vote for Season fast-forward.');
      setTimeout(() => setSkipAlert(null), 4000);
      return;
    }

    const curSquad = myTeam.squad || [];
    const count = curSquad.length;
    const wkCount = curSquad.filter(p => p.role === 'WK').length;
    const osCount = curSquad.filter(p => p.isOverseas).length;
    const bowlerCount = curSquad.filter(p => p.role === 'PACE' || p.role === 'SPIN' || p.role === 'AR' || (p.stats && p.stats.bowl >= 60)).length;

    if (count < 18) {
      setSkipAlert(`Cannot skip yet: ${myTeam.name} has only ${count}/18 players. Minimum 18 required for a legal squad!`);
      setTimeout(() => setSkipAlert(null), 5000);
      return;
    }
    if (wkCount < 1) {
      setSkipAlert(`Cannot skip yet: ${myTeam.name} has 0 Wicketkeepers. At least 1 WK is required!`);
      setTimeout(() => setSkipAlert(null), 5000);
      return;
    }
    if (bowlerCount < 6) {
      setSkipAlert(`Cannot skip yet: ${myTeam.name} has only ${bowlerCount}/6 bowlers required for 3-5-2 system!`);
      setTimeout(() => setSkipAlert(null), 5000);
      return;
    }
    if (osCount > 8) {
      setSkipAlert(`Cannot skip yet: ${myTeam.name} has ${osCount} overseas players (limit is 8)!`);
      setTimeout(() => setSkipAlert(null), 5000);
      return;
    }

    voteSkipAuction(!myTeamHasVoted);
  };

  const setSkipVotes = roomState?.setSkipVotes || [];
  const myTeamHasVotedSetSkip = myTeamId ? setSkipVotes.includes(myTeamId) : false;
  const handleVoteSkipSet = () => {
    voteSkipSet(!myTeamHasVotedSetSkip, myTeamId || undefined, roomCode || undefined);
  };

  return (
    <div className="h-screen w-screen bg-canvas text-slate-100 flex flex-col overflow-hidden select-none font-sans">
      {/* Top Host & Global Status Bar */}
      <header className="h-14 bg-tile border-b border-borderDark px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-brand-emerald animate-pulse" />
            <h1 className="font-mono font-bold text-sm tracking-wider text-slate-200">
              AUCTION ARENA
            </h1>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-canvas border border-borderDark text-brand-gold">
              [{roomCode || 'ROOM'}]
            </span>
          </div>

          <span className="hidden md:inline-block text-xs font-mono text-slate-400">
            {currentLot ? `LOT #${currentLot.lotNumber} OF ${currentLot.totalLots}` : 'WAITING FOR NEXT LOT...'}
          </span>

          <span className="hidden lg:inline-block text-[11px] font-mono px-2 py-0.5 rounded bg-subpill text-slate-300">
            PHASE: {roomState?.phase || 'MAIN'}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          {/* Auto-Save Status Container: Fixed w-7 h-7 slot placed before Skip to Season button so button never shifts */}
          <div className="w-7 h-7 flex items-center justify-center shrink-0">
            {showSaveTick && (
              <div
                className="w-7 h-7 rounded-full bg-brand-emerald/20 border border-brand-emerald/60 flex items-center justify-center text-brand-emerald shadow-sm animate-fadeIn"
                title="Saved to Cloud"
              >
                <Check className="w-4 h-4 stroke-[2.5]" />
              </div>
            )}
          </div>

          {/* Skip Set Button (Unanimous Human Consent & Silent AI Vickrey Resolution) */}
          <button
            type="button"
            onClick={handleVoteSkipSet}
            className={`h-9 py-[7px] px-[15px] rounded-xl border text-xs font-mono font-bold transition-all flex items-center gap-1.5 shadow-sm active:scale-95 whitespace-nowrap ${
              myTeamHasVotedSetSkip
                ? 'bg-sky-500/20 border-sky-400 text-sky-300 shadow-sky-500/20'
                : 'bg-surfaceDark hover:bg-subpill text-slate-200 border-borderDark hover:border-sky-400/60'
            }`}
            title="Vote to skip remaining players in current set. If all humans agree, AI franchises will silently bid and sign players via AI Mode A."
          >
            <FastForward className="w-3.5 h-3.5" />
            <span>
              {myTeamHasVotedSetSkip
                ? `Set Skipped (${setSkipVotes.length}/${totalHumanCount})`
                : totalHumanCount > 1
                ? `Skip Set (${setSkipVotes.length}/${totalHumanCount} Humans Agreed)`
                : 'Skip Set'}
            </span>
          </button>

          {/* Skip to Season Button (Auto-fill AI, Preserve Human Teams) */}
          <button
            type="button"
            onClick={handleVoteSkipToSeason}
            className={`h-9 py-[7px] px-[17px] rounded-xl border text-xs font-mono font-bold transition-all flex items-center gap-1.5 shadow-sm active:scale-95 whitespace-nowrap ${
              myTeamHasVoted
                ? 'bg-brand-emerald/20 border-brand-emerald text-brand-emerald shadow-brand-emerald/20'
                : 'bg-brand-gold hover:bg-brand-gold/90 text-slate-950 border-brand-gold shadow-brand-gold/20'
            }`}
            title="Fast-forward auction into Season Hub once all human teams have legal squads (AI teams are auto-completed without touching human teams)"
          >
            <FastForward className="w-3.5 h-3.5 fill-current" />
            <span>
              {myTeamHasVoted
                ? `Voted (${skipVotes.length}/${totalHumanCount})`
                : totalHumanCount > 1
                ? `Skip to Season (${skipVotes.length}/${totalHumanCount})`
                : 'Skip to Season'}
            </span>
          </button>

          {/* Debug Button if ?debug in URL */}
          {isDebugMode && (
            <button
              onClick={() => skipAuctionDebug()}
              className="h-9 py-[7px] px-[15px] rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400 text-amber-300 font-mono font-bold text-xs animate-pulse transition-all shadow-md shadow-amber-500/20 flex items-center gap-1.5 whitespace-nowrap active:scale-95"
              title="Instant Auto-Fill All Squads and Skip to Season"
            >
              <span>⚡ DEBUG SKIP</span>
            </button>
          )}

          {/* Persistent Auction Controls (Pause/Resume, 5x Speed, Save Game) */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => hostAction('TOGGLE_PAUSE')}
              className={`h-9 py-[7px] px-[15px] rounded-xl border text-xs font-mono font-bold transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap ${
                roomState?.isPaused || roomState?.isAuctionPaused
                  ? 'bg-amber-500/20 text-amber-300 border-amber-400/50'
                  : 'bg-surfaceDark hover:bg-subpill border-borderDark text-slate-300'
              }`}
              title="Pause or resume auction countdown"
            >
              {roomState?.isPaused || roomState?.isAuctionPaused ? <Play className="w-3.5 h-3.5 fill-current text-brand-emerald" /> : <Pause className="w-3.5 h-3.5" />}
              <span>{roomState?.isPaused || roomState?.isAuctionPaused ? 'Resume' : 'Pause'}</span>
            </button>

            <button
              onClick={() => hostAction('TOGGLE_SPEED')}
              className={`h-9 py-[7px] px-[15px] rounded-xl border text-xs font-mono font-bold transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap ${
                roomState?.auctionSpeedMultiplier === 5
                  ? 'bg-amber-500/20 text-amber-300 border-amber-400/50 shadow-[0_0_10px_rgba(245,158,11,0.2)]'
                  : 'bg-surfaceDark hover:bg-subpill border-borderDark text-slate-300'
              }`}
              title="Toggle 5x Turbo Auction Speed"
            >
              <span>⚡ 5x Speed</span>
            </button>

            <button
              onClick={handleForceSave}
              className="h-9 py-[7px] px-[15px] rounded-xl bg-surfaceDark hover:bg-subpill border border-borderDark text-xs font-mono font-bold text-slate-300 transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5 text-brand-cyan" />
              <span>Save Game</span>
            </button>
          </div>

          <div className="hidden lg:flex items-center gap-1.5 px-2.5 h-9 rounded-xl bg-canvas border border-borderDark text-[11px] font-mono text-slate-400 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-emerald" />
            <span>CLOUD SYNCED</span>
          </div>

          {/* Player Pool Master List Popup Trigger Button */}
          <button
            type="button"
            onClick={() => setShowPlayerPoolModal(true)}
            className="h-9 py-[7px] px-[15px] rounded-xl bg-[#1C202E] hover:bg-[#2C3246] border border-white/[0.1] text-xs font-mono font-bold text-slate-200 transition-all shadow-sm active:scale-95 flex items-center gap-1.5 whitespace-nowrap"
            title="Open Master Player Pool List (Queued, Live, Sold, Unsold)"
          >
            <Users className="w-3.5 h-3.5 text-brand-gold" />
            <span>Players List</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-brand-gold/15 text-brand-gold font-bold">
              {allPlayers.length || '314'}
            </span>
          </button>

          {/* Quit Room Button */}
          <button
            type="button"
            onClick={handleQuitRoom}
            className="h-9 py-[7px] px-3.5 rounded-xl bg-red-950/40 hover:bg-red-900/60 border border-red-800/60 text-xs font-mono font-bold text-red-300 transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap"
            title="Quit auction room and return to Home"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Quit Room</span>
          </button>

          <button
            onClick={() => {
              const isDebug = typeof window !== 'undefined' && window.location.search.includes('debug');
              router.push(`/analytics${roomCode ? `?room=${roomCode}` : ''}${isDebug ? (roomCode ? '&debug=true' : '?debug=true') : ''}`);
            }}
            className="h-9 py-[7px] px-[15px] rounded-xl bg-brand-gold/10 hover:bg-brand-gold/20 border border-brand-gold/30 text-xs font-mono font-bold text-brand-gold transition-all shadow-sm flex items-center gap-1 active:scale-95 whitespace-nowrap"
          >
            <span>Analytics</span>
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      </header>

      {/* Set Summary Banner */}
      {roomState?.lastSetSummary && (
        <div className="bg-sky-500/20 border-b border-sky-500/40 px-6 py-2 flex items-center justify-between text-xs text-sky-200 font-mono animate-fadeIn">
          <div className="flex items-center gap-2">
            <span className="text-base">📋</span>
            <span className="font-bold">{roomState.lastSetSummary}</span>
          </div>
        </div>
      )}

      {/* Skip Alert banner */}
      {skipAlert && (
        <div className="bg-amber-500/20 border-b border-amber-500/40 px-6 py-2 flex items-center justify-between text-xs text-amber-200 font-mono animate-fadeIn">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{skipAlert}</span>
          </div>
          <button onClick={() => setSkipAlert(null)} className="underline text-[11px] hover:text-white">Dismiss</button>
        </div>
      )}


      {/* Error banner */}
      {errorMessage && (
        <div className="bg-brand-rose/20 border-b border-brand-rose/40 px-6 py-2 flex items-center justify-between text-xs text-brand-rose">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={clearError} className="underline text-[11px] hover:text-slate-100">Dismiss</button>
        </div>
      )}


      {/* 5-Bento Locked 100vh Main Grid */}
      <div className="flex-1 grid grid-cols-12 gap-4 p-4 min-h-0 overflow-hidden">
        {/* Left Col (3 cols): Dedicated Top-Left Navigation Card & Bento 1 Franchises Board */}
        <div className="col-span-3 flex flex-col gap-3 min-h-0 overflow-hidden">
          {/* Top-Left Dedicated Navigation Box (Pool List & Squads) */}
          <div className="bg-tile border border-borderDark rounded-xl p-2.5 shrink-0 shadow-sm flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2 font-mono">
              {/* [Pool List] Button */}
              <button
                type="button"
                onClick={() => setShowPlayerPoolModal(true)}
                className="w-full py-2 px-2.5 rounded-lg bg-surfaceDark hover:bg-subpill border border-borderDark hover:border-brand-gold/60 text-slate-200 hover:text-white transition-all flex items-center justify-center gap-1.5 shadow-sm text-xs font-bold active:scale-95 group"
                title="Open full Auction Player Pool modal with live status counts"
              >
                <Users className="w-3.5 h-3.5 text-brand-gold group-hover:scale-110 transition-transform" />
                <span>Pool List</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-gold/15 text-brand-gold font-bold">
                  {allPlayers.length || '564'}
                </span>
              </button>

              {/* [Squads] Button */}
              <button
                type="button"
                onClick={() => {
                  if (myTeamId) setInspectingTeamId(myTeamId);
                  setShowSquadsModal(true);
                }}
                className="w-full py-2 px-2.5 rounded-lg bg-surfaceDark hover:bg-subpill border border-borderDark hover:border-brand-cyan/60 text-slate-200 hover:text-white transition-all flex items-center justify-center gap-1.5 shadow-sm text-xs font-bold active:scale-95 group"
                title="Open Franchise Rosters & Squads breakdown view"
              >
                <Shield className="w-3.5 h-3.5 text-brand-cyan group-hover:scale-110 transition-transform" />
                <span>Squads</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-cyan/15 text-brand-cyan font-bold">
                  {Object.keys(teams).length || '10'}
                </span>
              </button>
            </div>
          </div>

          {/* Bento 1: 10-Team Franchise Board */}
          <div className="bg-tile border border-borderDark rounded-xl flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="px-3 py-2 bg-canvas border-b border-borderDark flex items-center justify-between text-xs font-mono text-slate-400 shrink-0">
              <span>10 FRANCHISES</span>
              <span>PURSE / SQUAD</span>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-borderDark/40">
            {Object.values(teams).map(t => {
              const isSelected = inspectingTeamId === t.franchiseId;
              const isMyTeam = myTeamId === t.franchiseId;
              const isLeading = currentLot?.currentBidder === t.franchiseId;
              const overseasCount = t.squad.filter(p => p.isOverseas).length;
              const wkCount = t.squad.filter(p => p.role === 'WK').length;

              return (
                <div
                  key={t.franchiseId}
                  onClick={() => setInspectingTeamId(t.franchiseId)}
                  className={`px-2.5 py-[9px] transition-all cursor-pointer flex items-center justify-between text-xs rounded-md ${
                    isLeading
                      ? 'bg-emerald-500/15 border border-emerald-400 ring-1 ring-emerald-400/50 shadow-sm shadow-emerald-500/20'
                      : isSelected
                      ? 'bg-subpill/80 border-l-2 border-brand-gold'
                      : 'hover:bg-subpill/40'
                  }`}
                >
                  <div className="min-w-0 pr-2">
                    <div className="flex items-center gap-1.5 font-bold text-slate-200 truncate">
                      <span className="truncate">{t.name}</span>
                      <span className="text-[10px] text-slate-400 font-mono shrink-0">({t.franchiseId})</span>
                      {isLeading && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500 text-slate-950 font-mono font-bold animate-pulse flex items-center gap-1 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-950" />
                          LEADING
                        </span>
                      )}
                      {isMyTeam && (
                        <span className="text-[9px] px-1 rounded bg-brand-gold/20 text-brand-gold font-mono shrink-0">
                          YOU
                        </span>
                      )}
                      {t.isHuman && !isMyTeam && (
                        <span className="text-[9px] px-1 rounded bg-brand-cyan/20 text-brand-cyan font-mono shrink-0">
                          HUMAN
                        </span>
                      )}
                    </div>
                    {/* Squad info shifted directly under the name of team */}
                    <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5 mt-0.5">
                      <span className="text-slate-300 font-semibold">{t.squad.length}/25 Squad</span>
                      <span>•</span>
                      <span>{overseasCount}/8 OS</span>
                      <span>•</span>
                      <span>{wkCount} WK</span>
                    </div>
                  </div>

                  <div className="text-right font-mono shrink-0">
                    <div className="font-bold text-brand-gold text-xs">
                      ₹{t.purse.toFixed(2)} Cr
                    </div>
                    <span className="text-[9px] text-slate-500 block">
                      {25 - t.squad.length} slots left
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bento 2: Redesigned Central Bidding Board Hero & Live Bidder Readout (Center Col - 6 cols) */}
        <div className="col-span-6 flex flex-col gap-3 overflow-hidden">
          <div className="bg-tile border border-borderDark rounded-xl p-5 flex-1 flex flex-col justify-between overflow-hidden relative">
            {currentLot ? (
              <div className="flex flex-col justify-between h-full space-y-3">
                {/* -------------------------------------------------------------
                    ROW 1: Player Name & Primary Tags (FIX 4)
                   ------------------------------------------------------------- */}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-canvas border border-borderDark text-brand-gold">
                        SET {currentLot.player.marqueeSet}
                      </span>
                      {currentLot.player.isOverseas && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-brand-cyan/20 text-brand-cyan border border-brand-cyan/30 flex items-center gap-1">
                          <Plane className="w-3 h-3" />
                          <span>OVERSEAS</span>
                        </span>
                      )}
                      {currentLot.player.isUncapped && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-subpill text-slate-300 border border-borderDark">
                          UNCAPPED
                        </span>
                      )}
                      {isPriorityTarget && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-brand-gold/20 text-brand-gold border border-brand-gold/40 flex items-center gap-1 animate-pulse">
                          <Star className="w-3 h-3 fill-current" />
                          <span>PRIORITY TARGET</span>
                        </span>
                      )}
                      {isManuallySkipped && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-brand-rose/20 text-brand-rose border border-brand-rose/40">
                          SKIPPED BY YOU
                        </span>
                      )}
                    </div>

                    <h2 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight mt-1.5">
                      {currentLot.player.name}
                    </h2>
                    <div className="text-xs text-slate-400 font-mono mt-0.5">
                      {currentLot.player.country} • Age {currentLot.player.age}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-[10px] font-mono text-slate-500 uppercase">Base Price</div>
                    <div className="text-xl font-bold font-mono text-brand-gold tabular-nums">
                      ₹{currentLot.player.basePrice.toFixed(2)} Cr
                    </div>
                  </div>
                </div>

                {/* -------------------------------------------------------------
                    ROW 2: Immediate Core Ratings & Style Strip (Directly Below Name) (FIX 4)
                   ------------------------------------------------------------- */}
                <div className="p-2.5 rounded-lg bg-canvas border border-borderDark flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded bg-brand-gold text-slate-950 font-mono font-black text-xs tabular-nums">
                      OVR {currentLot.player.stats.ovr}
                    </span>
                    <span className="px-2 py-1 rounded bg-subpill border border-borderDark font-mono text-xs text-slate-200 tabular-nums">
                      BAT {currentLot.player.stats.bat}
                    </span>
                    <span className="px-2 py-1 rounded bg-subpill border border-borderDark font-mono text-xs text-slate-200 tabular-nums">
                      BOWL {currentLot.player.stats.bowl}
                    </span>
                    <span className="px-2 py-1 rounded bg-subpill border border-borderDark font-mono text-xs text-slate-200 tabular-nums">
                      PWR {currentLot.player.stats.power}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="px-2 py-1 rounded bg-brand-cyan/10 text-brand-cyan border border-brand-cyan/20 font-bold">
                      {currentLot.player.role}
                    </span>
                    <span className="text-slate-400">
                      {currentLot.player.batHand} • {currentLot.player.bowlStyleLabel !== 'None' ? currentLot.player.bowlStyleLabel : currentLot.player.subType.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>

                {/* -------------------------------------------------------------
                    ROW 3: Live Current Bid & Leading Bidder Box + Last 3 Bids Trail (FIX 5)
                   ------------------------------------------------------------- */}
                <div className="p-4 rounded-xl bg-canvas border border-borderDark flex flex-col justify-between space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    {/* Left Side: Current Price */}
                    <div>
                      <div className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                        {hasLeadingBid ? 'CURRENT LEADING BID' : 'STARTING LOT PRICE'}
                      </div>
                      <div className="text-3xl md:text-4xl font-black font-mono text-slate-100 tracking-tight tabular-nums">
                        ₹{currentPrice.toFixed(2)} <span className="text-sm font-normal text-slate-400">Cr</span>
                      </div>
                    </div>

                    {/* Right Side: Who holds current bid */}
                    <div className="text-left sm:text-right">
                      <div className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                        HIGHEST BIDDER / HELD BY
                      </div>
                      {hasLeadingBid ? (
                        <div className="inline-flex items-center gap-2 mt-1 px-3 py-1.5 rounded-lg bg-brand-emerald/15 border border-brand-emerald/40 text-brand-emerald font-mono font-bold text-xs">
                          <span className="w-2 h-2 rounded-full bg-brand-emerald animate-ping" />
                          <span>{currentLot.currentBidderName}</span>
                        </div>
                      ) : (
                        <div className="inline-block mt-1 px-2.5 py-1 rounded bg-subpill text-slate-400 font-mono text-xs border border-borderDark">
                          NO BIDS YET — OPEN AT BASE PRICE
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Below inside same box: Last 3 Bids Horizontal Trail */}
                  <div className="pt-2.5 border-t border-borderMuted flex items-center gap-2 overflow-x-auto text-[11px] font-mono text-slate-400">
                    <span className="text-slate-500 text-[10px] shrink-0 uppercase">BID TRAIL:</span>
                    {last3Bids.length === 0 ? (
                      <span className="text-slate-600 text-[10px]">Awaiting opening bid...</span>
                    ) : (
                      last3Bids.map((b, idx) => (
                        <React.Fragment key={idx}>
                          {idx > 0 && <span className="text-slate-600">←</span>}
                          <span className={`px-2 py-0.5 rounded ${idx === 0 ? 'bg-brand-emerald/20 text-brand-emerald font-bold' : 'bg-subpill text-slate-300'} tabular-nums`}>
                            {b.bidderName.split(' ')[0]} ₹{b.amount.toFixed(2)} Cr
                          </span>
                        </React.Fragment>
                      ))
                    )}
                  </div>
                </div>

                {/* -------------------------------------------------------------
                    ROW 4: 5.0s Countdown Bar & Bidding Buttons (FIX 5)
                   ------------------------------------------------------------- */}
                <div className="space-y-3">
                  {/* Subtle AUCTION PAUSED status badge */}
                  {(roomState?.isPaused || roomState?.isAuctionPaused) && (
                    <div className="py-2 px-3 rounded-lg bg-amber-500/20 border border-amber-400/40 text-amber-300 font-mono text-center text-xs font-bold tracking-wider animate-pulse flex items-center justify-center gap-2">
                      <Pause className="w-3.5 h-3.5 fill-current" />
                      <span>AUCTION PAUSED BY HOST</span>
                    </div>
                  )}

                  {/* Thick Silent Countdown Progress Bar (Increased height to fill black space, rounded pill, zero numeric seconds text) */}
                  <div className="w-full bg-canvas rounded-full h-6 sm:h-7 border border-borderDark/80 p-1 overflow-hidden shadow-inner">
                    <div
                      className={`h-full rounded-full transition-all duration-300 shadow-md ${
                        roomState?.isPaused || roomState?.isAuctionPaused
                          ? 'bg-amber-500 opacity-60'
                          : isFinalCall
                          ? 'bg-amber-400 animate-pulse'
                          : visualPercent > 40
                          ? 'bg-brand-emerald'
                          : 'bg-brand-rose'
                      }`}
                      style={{ width: `${visualPercent}%` }}
                    />
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-3">
                    {isModeA ? (
                      <div className="w-full flex items-center justify-between p-3 rounded-xl bg-subpill/60 border border-brand-cyan/30">
                        <div>
                          <div className="text-xs font-mono font-bold text-brand-cyan">ACCELERATED BIDDING: AI RESOLUTION</div>
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                            All human managers passed. AI counter-bids calculating.
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleUnskip}
                          disabled={Boolean(roomState?.isPaused || roomState?.isAuctionPaused)}
                          className="py-2.5 px-4 rounded-lg bg-brand-gold hover:bg-brand-gold/90 disabled:opacity-50 text-slate-950 font-bold text-xs font-mono transition-transform active:scale-95 flex items-center gap-2"
                        >
                          <Gavel className="w-4 h-4 fill-current" />
                          <span>UNSKIP & BID ₹{currentLot.player.basePrice.toFixed(2)} Cr</span>
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={handlePlaceBid}
                          disabled={!myTeam || currentLot.currentBidder === myTeamId || isBidLocked || nextBidAmount > maxAllowedBid || timerMs <= 0 || Boolean(roomState?.isPaused || roomState?.isAuctionPaused)}
                          className={`flex-1 py-3 px-6 rounded-lg font-extrabold text-sm font-mono transition-transform active:scale-95 flex items-center justify-center gap-2 shadow-lg ${
                            roomState?.isPaused || roomState?.isAuctionPaused
                              ? 'bg-surfaceDark border border-borderDark text-slate-500 cursor-not-allowed opacity-60'
                              : currentLot.currentBidder === myTeamId
                              ? 'bg-brand-emerald/15 border border-brand-emerald/40 text-brand-emerald cursor-not-allowed opacity-80'
                              : isBidLocked
                              ? 'bg-surfaceDark border border-borderDark text-slate-500 cursor-not-allowed opacity-60'
                              : nextBidAmount > maxAllowedBid
                              ? 'bg-surfaceDark border border-borderDark text-slate-500 cursor-not-allowed opacity-60'
                              : 'bg-brand-emerald hover:bg-brand-emerald/90 text-slate-950 border border-brand-emerald'
                          }`}
                          title={
                            currentLot.currentBidder === myTeamId
                              ? 'You already hold the highest bid'
                              : isBidLocked
                              ? 'Bid cooldown active (300ms)'
                              : nextBidAmount > maxAllowedBid
                              ? `Bid exceeds max allowed bid ₹${maxAllowedBid.toFixed(2)} Cr`
                              : `Place bid for ₹${nextBidAmount.toFixed(2)} Cr`
                          }
                        >
                          <Gavel className="w-4 h-4 fill-current" />
                          <span>
                            {currentLot.currentBidder === myTeamId
                              ? `HOLDING HIGH BID (₹${currentPrice.toFixed(2)} Cr)`
                              : !hasLeadingBid
                              ? `OPENING BID ₹${nextBidAmount.toFixed(2)} Cr`
                              : `BID ₹${nextBidAmount.toFixed(2)} Cr (+₹${bidIncrement.toFixed(2)} Cr)`}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={handleToggleSkip}
                          disabled={!currentLot}
                          className={`px-4 py-3 rounded-lg border text-xs font-mono font-semibold transition-colors flex items-center gap-1.5 active:scale-95 ${
                            isManuallySkipped
                              ? 'bg-brand-rose/20 border-brand-rose text-brand-rose'
                              : 'bg-subpill hover:bg-subpillHover border-borderDark text-slate-300'
                          }`}
                          title="Skip this lot. Conclude bidding immediately and move to next player."
                        >
                          <FastForward className="w-3.5 h-3.5" />
                          <span>{isManuallySkipped ? 'Skipped (Click to Unskip)' : 'Skip Player'}</span>
                        </button>
                      </>
                    )}
                  </div>

                  {/* FIX 5: Human Purse Reserve & Max Allowed Bid Readout */}
                  <div className="pt-2 mt-2 border-t border-borderMuted flex items-center justify-between text-xs font-mono">
                    <span className="text-slate-300">
                      Max Allowed Bid: <strong className="text-brand-gold font-bold">₹{maxAllowedBid.toFixed(2)} Cr</strong>
                    </span>
                    <span className="text-slate-500 text-[11px]">
                      (Reserved for 18-man squad: ₹{minReserve.toFixed(2)} Cr)
                    </span>
                  </div>
                </div>
              </div>
            ) : (() => {
              const allCompletedLots = roomState?.completedLots || [];
              const lastResolvedLot = roomState?.lastResolvedLot || (
                allCompletedLots.length > 0
                  ? {
                      player: allCompletedLots[allCompletedLots.length - 1].player,
                      sold: allCompletedLots[allCompletedLots.length - 1].soldTo !== null,
                      winningPrice: allCompletedLots[allCompletedLots.length - 1].soldPrice || 0,
                      winningFranchiseId: allCompletedLots[allCompletedLots.length - 1].soldTo || undefined
                    }
                  : null
              );

              if (lastResolvedLot) {
                return (
                  <div className="flex-1 flex flex-col items-center justify-center p-8 animate-in fade-in duration-300">
                    <div className={`p-4 rounded-full mb-3 shadow-xl ${
                      lastResolvedLot.sold
                        ? 'bg-brand-emerald/20 border border-brand-emerald/40 text-brand-emerald'
                        : 'bg-brand-rose/20 border border-brand-rose/40 text-brand-rose'
                    }`}>
                      <Gavel className="w-10 h-10 fill-current animate-bounce" />
                    </div>

                    {lastResolvedLot.sold ? (
                      <div className="text-center space-y-2">
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-emerald/10 border border-brand-emerald/30 text-brand-emerald font-mono font-bold text-xs uppercase tracking-wider">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>HAMMER DOWN • SOLD</span>
                        </div>
                        <h2 className="text-2xl font-black text-slate-100 tracking-tight">
                          SOLD TO{' '}
                          <span className="text-brand-gold">
                            {teams[lastResolvedLot.winningFranchiseId!]?.name || lastResolvedLot.winningFranchiseId}
                          </span>
                        </h2>
                        <div className="text-3xl md:text-4xl font-black font-mono text-brand-emerald">
                          ₹{(lastResolvedLot.winningPrice || 0).toFixed(2)} Cr
                        </div>
                        <div className="mt-3 p-3 bg-canvas/80 border border-borderDark rounded-xl max-w-sm mx-auto flex items-center justify-between text-xs font-mono">
                          <div className="text-left">
                            <span className="text-slate-200 font-bold block">{lastResolvedLot.player.name}</span>
                            <span className="text-slate-400 text-[11px]">{lastResolvedLot.player.role} • {lastResolvedLot.player.country}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-brand-gold font-bold">OVR: {lastResolvedLot.player.stats?.ovr ?? 75}</span>
                            <span className="text-slate-400 text-[11px] block">Base: ₹{lastResolvedLot.player.basePrice.toFixed(2)} Cr</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center space-y-2">
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-rose/10 border border-brand-rose/30 text-brand-rose font-mono font-bold text-xs uppercase tracking-wider">
                          <span>HAMMER DOWN • UNSOLD</span>
                        </div>
                        <h2 className="text-2xl font-black text-brand-rose tracking-tight uppercase">
                          [UNSOLD]
                        </h2>
                        <p className="text-slate-400 text-xs font-mono">
                          Will return in Accelerated Auction if requested.
                        </p>
                        <div className="mt-3 p-3 bg-canvas/80 border border-borderDark rounded-xl max-w-sm mx-auto flex items-center justify-between text-xs font-mono">
                          <div className="text-left">
                            <span className="text-slate-200 font-bold block">{lastResolvedLot.player.name}</span>
                            <span className="text-slate-400 text-[11px]">{lastResolvedLot.player.role} • {lastResolvedLot.player.country}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-slate-300 font-bold">Base Price</span>
                            <span className="text-brand-rose font-bold block">₹{lastResolvedLot.player.basePrice.toFixed(2)} Cr</span>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="mt-5 flex items-center gap-2 text-[11px] font-mono text-slate-500">
                      <Clock className="w-3.5 h-3.5 animate-spin text-brand-gold" />
                      <span>Next lot preparing...</span>
                    </div>
                  </div>
                );
              }

              return (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                  <Clock className="w-8 h-8 text-brand-gold animate-spin mb-3" />
                  <h3 className="text-base font-bold text-slate-200">Auction Initializing</h3>
                  <p className="text-xs text-slate-400 max-w-sm mt-1 font-mono">
                    Waiting for first lot to open on the auction floor...
                  </p>
                </div>
              );
            })()}
          </div>

          {/* Bento 5: Live Commentary Ticker (Bottom of Center Col, strictly fixed h-28 without resizing vbox) */}
          <div className="h-28 bg-tile border border-borderDark rounded-xl p-2.5 flex flex-col overflow-hidden shadow-sm">
            <div className="flex items-center justify-between text-[10px] font-mono pb-1 border-b border-borderDark/80 shrink-0">
              <div className="flex items-center gap-1.5 text-brand-gold font-bold tracking-wider">
                <span className="text-xs">🎙️</span>
                <span>LIVE BROADCAST COMMENTARY</span>
              </div>
              <div className="flex items-center gap-1.5 text-[9px] text-emerald-400 font-mono font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                <span>ON AIR</span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 font-mono text-[11px] pt-1.5 pr-1">
              {(roomState?.commentaryTicker || []).map((t, i) => {
                const isMilestone = t.includes('🔥') || t.includes('⚡') || t.includes('bidding war') || t.includes('historic');
                const isSold = t.includes('🔨 [SOLD]') || t.includes('sold to') || t.includes('steal of the round') || t.includes('statement signing');
                const isUnsold = t.includes('🔨 [UNSOLD]') || t.includes('went unsold') || t.includes('passed unsold');
                const isSniper = t.includes('🎯') || t.includes('Late sniper');
                const isGoing = t.includes('Going once') || t.includes('going twice');
                const isAnnouncement = t.includes('🎙️') || t.includes('hammer');

                let lineStyle = "leading-tight px-1.5 py-0.5 rounded text-slate-300 transition-colors";
                if (isMilestone) {
                  lineStyle = "leading-tight px-2 py-0.5 rounded-r bg-gradient-to-r from-amber-500/25 via-amber-500/10 to-transparent border-l-2 border-amber-400 text-amber-200 font-bold shadow-sm";
                } else if (isSold) {
                  lineStyle = "leading-tight px-2 py-0.5 rounded-r bg-gradient-to-r from-emerald-500/25 via-emerald-500/10 to-transparent border-l-2 border-emerald-400 text-emerald-200 font-bold shadow-sm";
                } else if (isUnsold) {
                  lineStyle = "leading-tight px-2 py-0.5 rounded-r bg-gradient-to-r from-rose-500/20 to-transparent border-l-2 border-rose-400 text-rose-300 font-semibold";
                } else if (isSniper) {
                  lineStyle = "leading-tight px-2 py-0.5 rounded-r bg-gradient-to-r from-cyan-500/20 to-transparent border-l-2 border-cyan-400 text-cyan-200 font-bold";
                } else if (isGoing) {
                  lineStyle = "leading-tight px-2 py-0.5 rounded bg-amber-400/15 border border-amber-400/40 text-amber-300 font-bold animate-pulse";
                } else if (isAnnouncement) {
                  lineStyle = "leading-tight px-2 py-0.5 rounded-r bg-gradient-to-r from-brand-gold/20 to-transparent border-l-2 border-brand-gold text-brand-gold font-semibold";
                }

                return (
                  <div key={i} className={lineStyle}>
                    {t}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Col (3 cols): Bento 4 Auto-Skip Deck & Bento 3 Roster Inspector */}
        <div className="col-span-3 flex flex-col gap-3 min-h-0 overflow-hidden">
          {/* Bento 4: Auto-Skip Control Deck */}
          <div className="bg-tile border border-borderDark rounded-xl p-3 shrink-0 space-y-2 text-xs font-mono shadow-sm">
            <div className="flex items-center justify-between border-b border-borderDark/60 pb-1.5">
              <span className="font-bold text-slate-200 flex items-center gap-1.5 text-[11px]">
                <Filter className="w-3.5 h-3.5 text-brand-gold" />
                AUTO-SKIP CONTROL DECK
              </span>
              <button
                type="button"
                onClick={handleResetFilters}
                className="text-[10px] text-slate-400 hover:text-white flex items-center gap-1 bg-surfaceDark px-2 py-0.5 rounded border border-borderDark transition-colors"
                title="Reset all filters to default"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            </div>

            {/* Quick Switches */}
            <div className="grid grid-cols-3 gap-1.5 font-mono text-[10px]">
              <button
                type="button"
                onClick={() => setSkipOverseas(!skipOverseas)}
                className={`py-1 px-1.5 rounded border text-center transition-all ${
                  skipOverseas
                    ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 font-bold'
                    : 'bg-surfaceDark text-slate-400 border-borderDark hover:text-slate-200'
                }`}
                title="Automatically skip overseas players"
              >
                ✈️ Skip OS
              </button>
              <button
                type="button"
                onClick={() => setSkipUncapped(!skipUncapped)}
                className={`py-1 px-1.5 rounded border text-center transition-all ${
                  skipUncapped
                    ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 font-bold'
                    : 'bg-surfaceDark text-slate-400 border-borderDark hover:text-slate-200'
                }`}
                title="Automatically skip uncapped players"
              >
                🇮🇳 Skip Uncapped
              </button>
              <button
                type="button"
                onClick={() => setWishlistOnlyMode(!wishlistOnlyMode)}
                className={`py-1 px-1.5 rounded border text-center transition-all ${
                  wishlistOnlyMode
                    ? 'bg-brand-gold/20 text-brand-gold border-brand-gold/50 font-bold'
                    : 'bg-surfaceDark text-slate-400 border-borderDark hover:text-slate-200'
                }`}
                title="Only stay active for wishlist/priority targets"
              >
                ★ Wishlist Only
              </button>
            </div>

            {/* Role Mute Pills */}
            <div className="space-y-0.5">
              <span className="text-[9px] font-mono text-slate-500">MUTE ROLES:</span>
              <div className="flex flex-wrap gap-1">
                {['BAT', 'WK', 'AR', 'PACE', 'SPIN'].map(role => {
                  const isMuted = mutedRoles.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => toggleMuteRole(role)}
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-all ${
                        isMuted
                          ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 line-through font-bold'
                          : 'bg-surfaceDark text-slate-300 border-borderDark hover:border-slate-500'
                      }`}
                    >
                      {role}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sliders in compact 2x2 Grid (~20% vertical reduction, all filters directly accessible) */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 pt-1 border-t border-borderDark/60 font-mono">
              {/* Min OVR */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-slate-400">Min OVR</span>
                  <span className={`px-1 rounded text-[9px] ${minOvr > 60 ? 'bg-brand-gold/20 text-brand-gold font-bold' : 'text-slate-500'}`}>
                    {minOvr > 60 ? minOvr : 'OFF'}
                  </span>
                </div>
                <input
                  type="range"
                  min="60"
                  max="95"
                  step="1"
                  value={minOvr}
                  onChange={e => setMinOvr(Number(e.target.value))}
                  className="w-full accent-brand-gold h-1 bg-surfaceDark rounded cursor-pointer"
                />
              </div>

              {/* Min BAT */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-slate-400">Min BAT</span>
                  <span className={`px-1 rounded text-[9px] ${minBat > 20 ? 'bg-brand-gold/20 text-brand-gold font-bold' : 'text-slate-500'}`}>
                    {minBat > 20 ? minBat : 'OFF'}
                  </span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="95"
                  step="1"
                  value={minBat}
                  onChange={e => setMinBat(Number(e.target.value))}
                  className="w-full accent-brand-gold h-1 bg-surfaceDark rounded cursor-pointer"
                />
              </div>

              {/* Min BOWL */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-slate-400">Min BOWL</span>
                  <span className={`px-1 rounded text-[9px] ${minBowl > 20 ? 'bg-brand-gold/20 text-brand-gold font-bold' : 'text-slate-500'}`}>
                    {minBowl > 20 ? minBowl : 'OFF'}
                  </span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="95"
                  step="1"
                  value={minBowl}
                  onChange={e => setMinBowl(Number(e.target.value))}
                  className="w-full accent-brand-gold h-1 bg-surfaceDark rounded cursor-pointer"
                />
              </div>

              {/* Max Base Price */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-[9px]">
                  <span className="text-slate-400">Max Base</span>
                  <span className={`px-1 rounded text-[9px] ${maxBasePrice < 2.00 ? 'bg-brand-gold/20 text-brand-gold font-bold' : 'text-slate-500'}`}>
                    {maxBasePrice < 2.00 ? `₹${maxBasePrice.toFixed(2)}` : 'ANY'}
                  </span>
                </div>
                <input
                  type="range"
                  min="0.30"
                  max="2.00"
                  step="0.10"
                  value={maxBasePrice}
                  onChange={e => setMaxBasePrice(Number(e.target.value))}
                  className="w-full accent-brand-gold h-1 bg-surfaceDark rounded cursor-pointer"
                />
              </div>
            </div>

            <div className="pt-0.5 text-[9px] text-slate-500 font-mono flex items-center gap-1">
              <Star className="w-2.5 h-2.5 text-brand-gold shrink-0" />
              <span>Wishlist targets NEVER auto-skip even if matching filters.</span>
            </div>
          </div>

          {/* Bento 3: Franchise Roster Inspector */}
          <div className="bg-tile border border-borderDark rounded-xl flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="p-3 bg-canvas border-b border-borderDark flex items-center justify-between text-xs font-mono text-slate-400 shrink-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-200">ROSTER: {inspectingTeam?.name || inspectingTeamId}</span>
                {(!mySeat || !mySeat.isHuman) && !inspectingTeam?.isHuman && (
                  <button
                    onClick={() => claimSeat(inspectingTeamId, 'Manager')}
                    className="bg-brand-gold/20 hover:bg-brand-gold/30 text-brand-gold border border-brand-gold/40 text-[9px] font-mono px-2 py-0.5 rounded transition-all flex items-center gap-1"
                    title="Take over this franchise and play live"
                  >
                    <span>⚡ Take Control</span>
                  </button>
                )}
              </div>
              <span className="text-brand-gold font-bold">₹{inspectingTeam?.purse?.toFixed(2)} Cr</span>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-borderDark/30 p-2">
              {!inspectingTeam?.squad || inspectingTeam.squad.length === 0 ? (
                <div className="p-8 text-center text-xs font-mono text-slate-600">
                  Squad is currently empty.<br />Won lots will appear here.
                </div>
              ) : (
                inspectingTeam.squad.map((p, idx) => {
                  const soldPrice = p.soldPrice ?? completedLotsMap.get(p.id) ?? p.basePrice;
                  return (
                    <div key={p.id} className="py-2 px-1 flex items-center justify-between text-xs">
                      <div>
                        <div className="font-medium text-slate-200 flex items-center gap-1">
                          <span>{p.name}</span>
                          {p.isOverseas && <span className="text-[10px]">✈️</span>}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono">
                          #{idx + 1} • {p.role} • OVR {p.stats.ovr}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-xs font-bold text-brand-gold">
                          ₹{Number(soldPrice).toFixed(2)} Cr
                        </div>
                        <div className="text-[9px] font-mono text-slate-500">
                          SOLD
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ======================================================== */}
      {/* POPUP WINDOW: AUCTION MASTER PLAYER POOL & LIVE STATUS */}
      {/* ======================================================== */}
      {showPlayerPoolModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 animate-fadeIn">
          <div className="bg-[#12151E] border border-white/[0.12] rounded-2xl w-full max-w-5xl h-[88vh] flex flex-col shadow-2xl overflow-hidden font-sans">
            {/* Modal Header */}
            <div className="px-6 py-4 bg-tile border-b border-borderDark flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-brand-gold/15 border border-brand-gold/30 flex items-center justify-center">
                  <Users className="w-5 h-5 text-brand-gold" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-mono font-bold text-slate-100 uppercase tracking-wide">
                      AUCTION MASTER PLAYER POOL
                    </h2>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-brand-gold/15 text-brand-gold border border-brand-gold/30 font-bold">
                      {allPlayers.length} PLAYERS
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 font-mono mt-0.5">
                    Live player ratings, base prices, and real-time auction outcomes.
                  </p>
                </div>
              </div>

              {/* Status Breakdown Pills & Close Button */}
              <div className="flex items-center gap-2 self-end sm:self-auto">
                <div className="flex items-center gap-1.5 font-mono text-[11px] bg-canvas px-3 py-1.5 rounded-xl border border-borderDark">
                  <span className="text-sky-300 font-bold" title="Yet to come up for auction">
                    QUEUED: {poolCounts.queued}
                  </span>
                  <span className="text-slate-600">•</span>
                  <span className="text-amber-400 font-bold flex items-center gap-1" title="Currently on hammer">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    LIVE: {poolCounts.live}
                  </span>
                  <span className="text-slate-600">•</span>
                  <span className="text-emerald-400 font-bold" title="Sold to a franchise">
                    SOLD: {poolCounts.sold}
                  </span>
                  <span className="text-slate-600">•</span>
                  <span className="text-rose-400 font-bold" title="Passed unsold">
                    UNSOLD: {poolCounts.unsold}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowPlayerPoolModal(false)}
                  className="p-1.5 rounded-lg bg-canvas hover:bg-subpill border border-borderDark text-slate-400 hover:text-white transition-colors"
                  title="Close (ESC)"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Clean 2-Row Responsive Filter Header (Zero Horizontal Clipping) */}
            <div className="p-3 sm:p-4 bg-canvas/80 border-b border-borderDark flex flex-col gap-3 shrink-0 font-mono text-xs">
              {/* Row 1: Search Input (flex-1 min-w-[220px]) + Status Segmented Control (full-width flex-wrap, no scrollbar, zero clipping) */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
                {/* Search Input */}
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search player name..."
                    value={poolSearch}
                    onChange={e => setPoolSearch(e.target.value)}
                    className="w-full pl-9 pr-8 py-2 rounded-xl bg-tile border border-borderDark text-slate-200 placeholder:text-slate-500 text-xs focus:outline-none focus:border-brand-gold transition-colors"
                  />
                  {poolSearch && (
                    <button
                      type="button"
                      onClick={() => setPoolSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm font-bold"
                      title="Clear search"
                    >
                      ×
                    </button>
                  )}
                </div>

                {/* Status Tabs: Rendered as a full-width non-scrolling flex pill group (zero horizontal scrollbar or clipping) */}
                <div className="flex items-center flex-wrap gap-1 p-1 rounded-xl bg-tile border border-borderDark shrink-0">
                  {(['ALL', 'QUEUED', 'LIVE', 'SOLD', 'UNSOLD'] as const).map(st => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setPoolStatusFilter(st)}
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all whitespace-nowrap ${
                        poolStatusFilter === st
                          ? st === 'SOLD'
                            ? 'bg-emerald-500 text-slate-950 shadow-sm'
                            : st === 'UNSOLD'
                            ? 'bg-rose-500 text-white shadow-sm'
                            : st === 'LIVE'
                            ? 'bg-amber-400 text-slate-950 shadow-sm'
                            : st === 'QUEUED'
                            ? 'bg-sky-500 text-slate-950 shadow-sm'
                            : 'bg-brand-gold text-slate-950 shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {st}
                      <span className="ml-1 opacity-80 text-[10px]">
                        ({st === 'ALL' ? poolCounts.total : st === 'QUEUED' ? poolCounts.queued : st === 'LIVE' ? poolCounts.live : st === 'SOLD' ? poolCounts.sold : poolCounts.unsold})
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Row 2: Compact Dropdown Filters (Merged Set, Role, Sort, Overseas Toggle) */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Merged Set Filter Dropdown */}
                <select
                  value={poolSetFilter}
                  onChange={e => setPoolSetFilter(e.target.value)}
                  className="bg-tile border border-borderDark rounded-xl px-3 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-brand-gold font-mono"
                >
                  <option value="CURRENT">Current Set ({currentLot?.player?.marqueeSet ? `Set ${currentLot.player.marqueeSet}` : 'Set 1'})</option>
                  <option value="ALL">All Sets</option>
                  <option value="1">Set 1 (Marquee)</option>
                  <option value="2">Set 2 (Batters)</option>
                  <option value="3">Set 3 (All-Rounders)</option>
                  <option value="4">Set 4 (Wicketkeepers)</option>
                  <option value="5">Set 5 (Fast Bowlers)</option>
                  <option value="6">Set 6 (Spin Bowlers)</option>
                  <option value="7">Set 7 (Uncapped Batters)</option>
                  <option value="8">Set 8 (Uncapped All-Rounders)</option>
                  <option value="9">Set 9 (Uncapped Bowlers)</option>
                </select>

                {/* Role Filter Dropdown: All Roles, BAT, WK, AR, PACE, SPIN */}
                <select
                  value={poolRoleFilter}
                  onChange={e => setPoolRoleFilter(e.target.value)}
                  className="bg-tile border border-borderDark rounded-xl px-3 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-brand-gold font-mono"
                >
                  <option value="ALL">All Roles</option>
                  <option value="BAT">BAT</option>
                  <option value="WK">WK</option>
                  <option value="AR">AR</option>
                  <option value="PACE">PACE</option>
                  <option value="SPIN">SPIN</option>
                  <option value="BOWL">All Bowlers</option>
                </select>

                {/* Sort Dropdown: Rating: High → Low, Price: High → Low, Base Price */}
                <select
                  value={poolSortBy}
                  onChange={e => setPoolSortBy(e.target.value as any)}
                  className="bg-tile border border-borderDark rounded-xl px-3 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-brand-gold font-mono"
                >
                  <option value="OVR_DESC">Rating: High → Low</option>
                  <option value="PRICE_DESC">Price: High → Low</option>
                  <option value="BASE_DESC">Base Price</option>
                  <option value="OVR_ASC">Rating: Low → High</option>
                  <option value="PRICE_ASC">Price: Low → High</option>
                  <option value="NAME_ASC">Name: A → Z</option>
                </select>

                {/* Overseas Toggle: Clean OS Only pill checkbox */}
                <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-tile border border-borderDark text-slate-300 hover:text-white cursor-pointer select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={poolOverseasOnly}
                    onChange={e => setPoolOverseasOnly(e.target.checked)}
                    className="rounded border-borderDark text-brand-gold focus:ring-0 cursor-pointer"
                  />
                  <span>✈️ OS Only</span>
                </label>
              </div>
            </div>

            {/* Scrollable Table Area */}
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="sticky top-0 z-10 bg-tile text-slate-400 border-b border-borderDark text-[11px]">
                  <tr>
                    <th className="py-2.5 px-4 w-12 text-slate-500">#</th>
                    <th className="py-2.5 px-3 w-28">STATUS</th>
                    <th className="py-2.5 px-4">PLAYER</th>
                    <th className="py-2.5 px-3 w-20 text-center">ROLE</th>
                    <th className="py-2.5 px-3 w-24 text-center font-bold text-slate-200">OVR</th>
                    <th className="py-2.5 px-4 hidden sm:table-cell">ATTRIBUTES</th>
                    <th className="py-2.5 px-3 text-right">BASE PRICE</th>
                    <th className="py-2.5 px-4 text-right">AUCTION OUTCOME</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-borderDark/40">
                  {filteredPoolPlayers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-16 text-center text-slate-500 text-xs font-mono">
                        No players found matching your search and filter criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredPoolPlayers.map((p, idx) => {
                      const info = playerStatusMap.get(p.id) || { status: 'QUEUED' };
                      const st = info.status;
                      const isLive = st === 'LIVE';
                      const isSold = st === 'SOLD';
                      const isUnsold = st === 'UNSOLD';
                      const isQueued = st === 'QUEUED';

                      const ovr = p.stats?.ovr || 75;
                      const ovrColor =
                        ovr >= 88
                          ? 'bg-brand-gold text-slate-950 font-black'
                          : ovr >= 80
                          ? 'bg-brand-emerald/20 text-brand-emerald border border-brand-emerald/40 font-bold'
                          : ovr >= 72
                          ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                          : 'bg-slate-800 text-slate-400 border border-borderDark';

                      return (
                        <tr
                          key={p.id}
                          className={`hover:bg-subpill/40 transition-colors ${
                            isLive
                              ? 'bg-amber-500/10'
                              : isSold
                              ? 'bg-emerald-500/[0.03]'
                              : isUnsold
                              ? 'bg-rose-500/[0.03]'
                              : ''
                          }`}
                        >
                          {/* Row Number */}
                          <td className="py-2.5 px-4 text-slate-500 font-bold text-[11px]">
                            #{idx + 1}
                          </td>

                          {/* Status Pill */}
                          <td className="py-2.5 px-3">
                            {isLive && (
                              <span className="px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-300 border border-amber-400/50 font-bold text-[10px] flex items-center gap-1 w-max">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                                LIVE NOW
                              </span>
                            )}
                            {isSold && (
                              <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-bold text-[10px] w-max block">
                                SOLD ✓
                              </span>
                            )}
                            {isUnsold && (
                              <span className="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/40 font-bold text-[10px] w-max block">
                                UNSOLD
                              </span>
                            )}
                            {isQueued && (
                              <span className="px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 text-[10px] font-bold w-max block">
                                QUEUED
                              </span>
                            )}
                          </td>

                          {/* Player Name & Badges */}
                          <td className="py-2.5 px-4 font-bold text-slate-200">
                            <div className="flex items-center gap-1.5">
                              <span>{p.name}</span>
                              {p.isOverseas && <span title="Overseas Player">✈️</span>}
                              {p.role === 'WK' && (
                                <span className="text-[9px] px-1 rounded bg-brand-cyan/20 text-brand-cyan font-bold">
                                  WK
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Role */}
                          <td className="py-2.5 px-3 text-center">
                            <span className="text-[10px] px-2 py-0.5 rounded bg-subpill text-slate-300 border border-borderDark">
                              {p.role}
                            </span>
                          </td>

                          {/* OVR Rating */}
                          <td className="py-2.5 px-3 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded text-xs ${ovrColor}`}>
                              {ovr}
                            </span>
                          </td>

                          {/* Attributes */}
                          <td className="py-2.5 px-4 hidden sm:table-cell text-slate-400 text-[11px]">
                            <span>BAT {p.stats?.bat || 50}</span>
                            <span className="text-slate-600 mx-1">•</span>
                            <span>BOWL {p.stats?.bowl || 50}</span>
                            <span className="text-slate-600 mx-1">•</span>
                            <span>PWR {p.stats?.power || 50}</span>
                          </td>

                          {/* Base Price */}
                          <td className="py-2.5 px-3 text-right text-slate-400">
                            ₹{Number(p.basePrice || 0.50).toFixed(2)} Cr
                          </td>

                          {/* Auction Outcome */}
                          <td className="py-2.5 px-4 text-right">
                            {isSold ? (
                              <div>
                                <span className="font-bold text-brand-gold">
                                  ₹{Number(info.soldPrice).toFixed(2)} Cr
                                </span>
                                <div className="text-[10px] text-emerald-400 font-bold truncate max-w-[140px] ml-auto">
                                  {info.soldToName}
                                </div>
                              </div>
                            ) : isLive ? (
                              <div>
                                <span className="font-bold text-amber-400 animate-pulse">
                                  ₹{Number(currentPrice).toFixed(2)} Cr
                                </span>
                                <div className="text-[10px] text-slate-400 truncate max-w-[140px] ml-auto">
                                  {currentLot?.currentBidderName ? `Bid by ${currentLot.currentBidderName}` : 'Opening Base'}
                                </div>
                              </div>
                            ) : isUnsold ? (
                              <span className="text-slate-500 italic text-[11px]">Passed</span>
                            ) : (
                              <span className="text-sky-400/80 text-[11px]">Awaiting Call</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 bg-tile border-t border-borderDark flex items-center justify-between font-mono text-xs text-slate-400 shrink-0">
              <span>Showing {filteredPoolPlayers.length} of {allPlayers.length} players</span>
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline-block">Press ESC or click close to return to bidding</span>
                <button
                  type="button"
                  onClick={() => setShowPlayerPoolModal(false)}
                  className="px-4 py-1.5 rounded-lg bg-canvas hover:bg-subpill border border-borderDark text-slate-200 font-bold"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Franchise Rosters & Squads Breakdown Modal */}
      {showSquadsModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 animate-fadeIn">
          <div className="bg-canvas border border-borderDark rounded-2xl w-full max-w-6xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden font-mono">
            {/* Modal Header */}
            <div className="p-4 bg-tile border-b border-borderDark flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <Shield className="w-5 h-5 text-brand-cyan" />
                <div>
                  <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider flex items-center gap-2">
                    <span>FRANCHISE ROSTERS & SQUADS BREAKDOWN</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-cyan/20 text-brand-cyan border border-brand-cyan/40">
                      10 TEAMS LIVE
                    </span>
                  </h2>
                  <p className="text-[11px] text-slate-400">
                    Live team composition, purse reserves, overseas slots, and player signings.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowSquadsModal(false)}
                className="p-1.5 rounded-lg bg-canvas hover:bg-subpill border border-borderDark text-slate-400 hover:text-white transition-colors"
                title="Close (ESC)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Franchise Selector Pills */}
            <div className="p-3 bg-canvas/80 border-b border-borderDark flex items-center gap-1.5 overflow-x-auto shrink-0">
              {Object.values(teams).map(t => {
                const isSelected = (squadsModalTeamId || inspectingTeamId) === t.franchiseId;
                const isMyTeam = myTeamId === t.franchiseId;
                return (
                  <button
                    key={t.franchiseId}
                    type="button"
                    onClick={() => {
                      setSquadsModalTeamId(t.franchiseId);
                      setInspectingTeamId(t.franchiseId);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1.5 border ${
                      isSelected
                        ? 'bg-brand-cyan/20 border-brand-cyan text-brand-cyan shadow-sm'
                        : isMyTeam
                        ? 'bg-brand-gold/10 border-brand-gold/40 text-brand-gold hover:bg-brand-gold/20'
                        : 'bg-tile border-borderDark text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>{t.franchiseId}</span>
                    <span className="text-[10px] opacity-75 font-normal">({t.squad.length}/25)</span>
                    {isMyTeam && <span className="text-[9px] text-brand-gold font-bold">★</span>}
                  </button>
                );
              })}
            </div>

            {/* Selected Franchise Summary & Squad Table */}
            {(() => {
              const activeSquadTeam = teams[squadsModalTeamId] || teams[inspectingTeamId] || Object.values(teams)[0];
              if (!activeSquadTeam) return null;
              const overseasCount = activeSquadTeam.squad.filter(p => p.isOverseas).length;
              const wkCount = activeSquadTeam.squad.filter(p => p.role === 'WK').length;
              const totalSpent = (activeSquadTeam.squad || []).reduce((acc, p) => {
                return acc + (p.soldPrice ?? completedLotsMap.get(p.id) ?? p.basePrice ?? 0);
              }, 0);

              return (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  {/* Summary Bar */}
                  <div className="p-3 bg-tile/60 border-b border-borderDark grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs shrink-0">
                    <div>
                      <span className="text-[10px] text-slate-500 block">FRANCHISE</span>
                      <span className="font-bold text-slate-100">{activeSquadTeam.name} ({activeSquadTeam.franchiseId})</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">PURSE REMAINING</span>
                      <span className="font-bold text-brand-gold">₹{activeSquadTeam.purse.toFixed(2)} Cr</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">TOTAL SPENT</span>
                      <span className="font-bold text-slate-200">₹{totalSpent.toFixed(2)} Cr</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">SQUAD SIZE</span>
                      <span className={`font-bold ${activeSquadTeam.squad.length >= 18 ? 'text-brand-emerald' : 'text-amber-400'}`}>
                        {activeSquadTeam.squad.length} / 25 (min 18)
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">OVERSEAS / WK</span>
                      <span className="font-bold text-slate-200">
                        {overseasCount}/8 OS • {wkCount} WK
                      </span>
                    </div>
                  </div>

                  {/* Squad Table */}
                  <div className="flex-1 overflow-y-auto">
                    {activeSquadTeam.squad.length === 0 ? (
                      <div className="p-12 text-center text-xs text-slate-500">
                        No players signed yet. Won auction lots will appear here.
                      </div>
                    ) : (
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="sticky top-0 z-10 bg-tile text-slate-400 border-b border-borderDark text-[11px]">
                          <tr>
                            <th className="py-2.5 px-4 w-12 text-slate-500">#</th>
                            <th className="py-2.5 px-4">PLAYER</th>
                            <th className="py-2.5 px-3 w-20 text-center">ROLE</th>
                            <th className="py-2.5 px-3 w-16 text-center">OVR</th>
                            <th className="py-2.5 px-3 w-28 text-right">BASE PRICE</th>
                            <th className="py-2.5 px-4 w-32 text-right">SOLD PRICE</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-borderDark/40">
                          {activeSquadTeam.squad.map((p, idx) => {
                            const soldPrice = p.soldPrice ?? completedLotsMap.get(p.id) ?? p.basePrice;
                            return (
                              <tr key={p.id || idx} className="hover:bg-subpill/30 transition-colors">
                                <td className="py-2 px-4 text-slate-500">{idx + 1}</td>
                                <td className="py-2 px-4 font-medium text-slate-200">
                                  <div className="flex items-center gap-1.5">
                                    <span>{p.name}</span>
                                    {p.isOverseas && <span className="text-[10px]" title="Overseas Player">✈️</span>}
                                  </div>
                                </td>
                                <td className="py-2 px-3 text-center">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-subpill text-slate-300 font-bold">
                                    {p.role}
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-center font-bold text-brand-gold">
                                  {p.stats?.ovr ?? 75}
                                </td>
                                <td className="py-2 px-3 text-right text-slate-400">
                                  ₹{p.basePrice?.toFixed(2)} Cr
                                </td>
                                <td className="py-2 px-4 text-right font-bold text-emerald-400">
                                  ₹{soldPrice?.toFixed(2)} Cr
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Modal Footer */}
            <div className="px-6 py-3 bg-tile border-t border-borderDark flex items-center justify-between font-mono text-xs text-slate-400 shrink-0">
              <span>Franchise Rosters & Squads Live View</span>
              <button
                type="button"
                onClick={() => setShowSquadsModal(false)}
                className="px-4 py-1.5 rounded-lg bg-canvas hover:bg-subpill border border-borderDark text-slate-200 font-bold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

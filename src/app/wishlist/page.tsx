'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useGameRoomStore } from '@/lib/useGameRoomStore';
import { IPLPlayer, PrimaryRole } from '@/types/player.types';
import {
  Star,
  Search,
  Filter,
  Clock,
  Send,
  Users,
  CheckCircle,
  Plane,
  ChevronRight,
  TrendingUp,
  AlertCircle,
  LogOut
} from 'lucide-react';

export default function WishlistPage() {
  const router = useRouter();
  const {
    roomState,
    roomCode,
    mySeat,
    submitWishlist,
    hostAction,
    isHost,
    skipAuctionDebug,
    leaveRoom,
    initSocket,
    joinOrSyncRoom
  } = useGameRoomStore();

  const handleQuitRoom = () => {
    if (window.confirm('Quit this room and return to home screen?')) {
      leaveRoom();
      router.push('/');
    }
  };

  const [players, setPlayers] = useState<IPLPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(180);

  useEffect(() => {
    initSocket();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.has('debug')) {
        setIsDebugMode(true);
      }
      const urlRoom = params.get('room') || params.get('roomCode');
      if (urlRoom && urlRoom.toUpperCase().trim() !== roomCode) {
        joinOrSyncRoom(urlRoom.toUpperCase().trim());
      }
    }
  }, []);

  // Live 1000ms countdown timer
  useEffect(() => {
    const endsAt = roomState?.wishlistEndsAt || (roomState?.wishlistTimer as any)?.wishlistEndsAt;
    const calc = () => {
      if (!endsAt) {
        return Math.max(0, Math.ceil((roomState?.wishlistTimer?.msRemaining ?? 180000) / 1000));
      }
      return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    };

    setSecondsRemaining(calc());
    const interval = setInterval(() => {
      setSecondsRemaining(calc());
    }, 1000);

    return () => clearInterval(interval);
  }, [roomState?.wishlistEndsAt, roomState?.wishlistTimer]);

  // Filters
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [overseasOnly, setOverseasOnly] = useState(false);
  const [uncappedOnly, setUncappedOnly] = useState(false);
  const [highOvrOnly, setHighOvrOnly] = useState(false);

  useEffect(() => {
    fetch(`/api/players?_t=${Date.now()}`, { cache: 'no-store' })
      .then(res => res.json())
      .then(data => {
        if (data.players) setPlayers(data.players);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (roomState?.status === 'AUCTION') {
      const isDebug = typeof window !== 'undefined' && window.location.search.includes('debug');
      router.push(`/auction?room=${roomCode || ''}${isDebug ? '&debug=true' : ''}`);
    }
  }, [roomState?.status, roomCode, router]);

  const toggleTarget = (id: string) => {
    if (hasSubmitted) return;
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        return prev.filter(x => x !== id);
      }
      return [...prev, id];
    });
  };

  const handleSelect90Plus = () => {
    if (hasSubmitted) return;
    const ids90Plus = players.filter(p => (p.stats?.ovr ?? 70) >= 90).map(p => p.id);
    setSelectedIds(prev => Array.from(new Set([...prev, ...ids90Plus])));
  };

  const handleClearAll = () => {
    if (hasSubmitted) return;
    setSelectedIds([]);
  };

  const handleSubmit = () => {
    setHasSubmitted(true);
    submitWishlist(selectedIds);
  };

  // Filtered Players
  const filteredPlayers = useMemo(() => {
    return players.filter(p => {
      if (search) {
        const q = search.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.country.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (roleFilter !== 'ALL' && p.role !== roleFilter) return false;
      if (overseasOnly && !p.isOverseas) return false;
      if (uncappedOnly && !p.isUncapped) return false;
      if (highOvrOnly && p.stats.ovr < 85) return false;
      return true;
    });
  }, [players, search, roleFilter, overseasOnly, uncappedOnly, highOvrOnly]);

  const selectedPlayers = useMemo(() => {
    return players.filter(p => selectedIds.includes(p.id));
  }, [players, selectedIds]);

  const roleCounts = useMemo(() => {
    const counts: Record<string, number> = { BAT: 0, WK: 0, AR: 0, PACE: 0, SPIN: 0 };
    selectedPlayers.forEach(p => {
      if (counts[p.role] !== undefined) counts[p.role]++;
    });
    return counts;
  }, [selectedPlayers]);

  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  const formattedTimer = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  const submittedCount = roomState?.wishlistTimer?.submittedCount ?? 0;
  const totalHumans = roomState?.wishlistTimer?.totalHumans ?? 1;

  return (
    <div className="min-h-screen bg-canvas text-slate-100 flex flex-col">
      {/* Floating Top Status Bar */}
      <header className="sticky top-0 z-30 bg-[#12151E]/95 backdrop-blur border-b border-white/[0.08] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-brand-gold animate-pulse" />
            <span className="font-mono font-bold text-sm text-slate-200">PRE-AUCTION SQUAD TARGETS</span>
            <span className="text-xs font-mono text-slate-500">[{roomCode || 'LOBBY'}]</span>
          </div>

          <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-xl bg-[#1C202E] border border-white/[0.06] text-xs font-mono text-slate-300">
            <Users className="w-3.5 h-3.5 text-brand-cyan" />
            <span>SUBMITTED: <strong className="text-white tabular-nums">{submittedCount}</strong> / {Math.max(1, totalHumans)} MANAGERS</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Debug Button if ?debug in URL */}
          {isDebugMode && (
            <button
              onClick={() => skipAuctionDebug()}
              className="h-9 px-3 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400 text-amber-300 font-mono font-bold text-xs animate-pulse transition-all shadow-md shadow-amber-500/20"
              title="Instant Auto-Fill All Squads and Skip to Season"
            >
              <span>⚡ DEBUG: AUTO-FILL ALL SQUADS & SKIP TO SEASON</span>
            </button>
          )}

          <div className="flex items-center gap-2 h-9 px-3.5 rounded-xl bg-[#1C202E] border border-white/[0.06] font-mono text-sm">
            <Clock className="w-4 h-4 text-brand-gold" />
            <span className="text-brand-gold font-bold tabular-nums">{formattedTimer}</span>
          </div>

          <button
            onClick={handleSubmit}
            disabled={hasSubmitted}
            className={`h-9 flex items-center gap-2 px-4 rounded-xl text-xs font-semibold font-mono transition-all ${
              hasSubmitted
                ? 'bg-brand-emerald/20 text-brand-emerald border border-brand-emerald/30 cursor-default'
                : 'bg-brand-gold hover:bg-brand-gold/90 text-slate-950'
            }`}
          >
            {hasSubmitted ? (
              <>
                <CheckCircle className="w-3.5 h-3.5" />
                <span>LOCKED ({selectedIds.length})</span>
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" />
                <span>LOCK WISHLIST ({selectedIds.length})</span>
              </>
            )}
          </button>

          {isHost && (
            <button
              onClick={() => hostAction('START_AUCTION')}
              className="h-9 px-3 rounded-xl bg-[#1C202E] hover:bg-[#2C3246] border border-white/[0.06] text-xs font-mono text-slate-300 transition-colors"
            >
              Start Auction Now
            </button>
          )}

          <button
            type="button"
            onClick={handleQuitRoom}
            className="h-9 px-3 rounded-xl bg-red-950/40 hover:bg-red-900/60 border border-red-800/60 text-xs font-mono font-bold text-red-300 transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap"
            title="Quit room and return to Home"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline">Quit Room</span>
          </button>
        </div>
      </header>

      {/* Bento Main Layout */}
      <div className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto w-full">
        {/* Table + Filter Column */}
        <div className="lg:col-span-8 flex flex-col space-y-4">
          {/* Bento 1: Filter Bar */}
          <div className="bg-tile border border-borderDark rounded-xl p-4 flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
              <input
                type="text"
                placeholder="Search player name, country..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-canvas border border-borderDark text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-brand-gold"
              />
            </div>

            {/* Role Filter Pills */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
              {['ALL', 'BAT', 'WK', 'AR', 'PACE', 'SPIN'].map(role => (
                <button
                  key={role}
                  onClick={() => setRoleFilter(role)}
                  className={`px-2.5 py-1.5 rounded text-xs font-mono transition-colors ${
                    roleFilter === role
                      ? 'bg-brand-gold text-slate-950 font-bold'
                      : 'bg-canvas text-slate-400 hover:text-slate-200 border border-borderDark'
                  }`}
                >
                  {role}
                </button>
              ))}
            </div>

            {/* Quick Checkboxes */}
            <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overseasOnly}
                  onChange={e => setOverseasOnly(e.target.checked)}
                  className="accent-brand-gold"
                />
                <span>✈️ OS</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={uncappedOnly}
                  onChange={e => setUncappedOnly(e.target.checked)}
                  className="accent-brand-gold"
                />
                <span>Uncapped</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={highOvrOnly}
                  onChange={e => setHighOvrOnly(e.target.checked)}
                  className="accent-brand-gold"
                />
                <span>OVR≥85</span>
              </label>
            </div>
          </div>

          {/* Bento 2: Player Pool Table */}
          <div className="bg-tile border border-borderDark rounded-xl overflow-hidden flex-1 flex flex-col">
            <div className="p-3 bg-canvas border-b border-borderDark flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-slate-400">
              <div className="flex items-center gap-2">
                <span>SHOWING {filteredPlayers.length} OF {players.length} PLAYERS</span>
                <span className="text-slate-600">•</span>
                <span className="text-brand-gold font-bold">{selectedIds.length} TARGETED</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={hasSubmitted}
                  onClick={handleSelect90Plus}
                  className="px-2.5 py-1 rounded-lg bg-[#1C202E] hover:bg-[#2C3246] border border-white/[0.08] text-[11px] text-brand-gold font-mono disabled:opacity-40 transition-colors"
                  title="Select all players with 90+ OVR rating"
                >
                  Select 90+ Rated
                </button>
                <button
                  type="button"
                  disabled={hasSubmitted || selectedIds.length === 0}
                  onClick={handleClearAll}
                  className="px-2.5 py-1 rounded-lg bg-[#1C202E] hover:bg-brand-rose/20 border border-white/[0.08] text-[11px] text-slate-400 hover:text-brand-rose font-mono disabled:opacity-40 transition-colors"
                >
                  Clear All
                </button>
              </div>
            </div>

            <div className="overflow-x-auto flex-1 max-h-[600px] overflow-y-auto">
              {loading ? (
                <div className="p-12 text-center text-xs font-mono text-slate-500">Loading verified player database...</div>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-tile border-b border-borderDark text-[11px] font-mono text-slate-400">
                    <tr>
                      <th className="py-2.5 px-3 w-10">TICK</th>
                      <th className="py-2.5 px-3">PLAYER</th>
                      <th className="py-2.5 px-3">ROLE / TYPE</th>
                      <th className="py-2.5 px-3 text-center">OVR</th>
                      <th className="py-2.5 px-3 text-center">BAT</th>
                      <th className="py-2.5 px-3 text-center">PWR</th>
                      <th className="py-2.5 px-3 text-center">BOWL</th>
                      <th className="py-2.5 px-3 text-right">BASE</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-borderDark/40">
                    {filteredPlayers.map(p => {
                      const isTicked = selectedIds.includes(p.id);
                      return (
                        <tr
                          key={p.id}
                          onClick={() => toggleTarget(p.id)}
                          className={`cursor-pointer transition-colors ${
                            isTicked
                              ? 'bg-brand-gold/10 hover:bg-brand-gold/15'
                              : 'hover:bg-subpill/50'
                          }`}
                        >
                          <td className="py-2.5 px-3">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleTarget(p.id);
                              }}
                              className="focus:outline-none"
                            >
                              <Star
                                className={`w-4 h-4 transition-colors ${
                                  isTicked
                                    ? 'fill-brand-gold text-brand-gold'
                                    : 'text-slate-600 hover:text-slate-400'
                                }`}
                              />
                            </button>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-1.5 font-medium text-slate-100">
                              <span>{p.name}</span>
                              {p.isOverseas && <span title="Overseas Player">✈️</span>}
                              {p.isUncapped && (
                                <span className="text-[9px] px-1 rounded bg-subpill text-slate-400 font-mono">
                                  UNC
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono">
                              {p.country} • Set {p.marqueeSet} • Age {p.age}
                            </div>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-mono text-[11px] font-semibold text-slate-300">
                              {p.role}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate max-w-[130px]">
                              {p.subType.replace(/_/g, ' ')}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono font-bold text-slate-100">
                            <span className={`px-1.5 py-0.5 rounded ${p.stats.ovr >= 85 ? 'bg-brand-gold/20 text-brand-gold' : 'bg-subpill text-slate-300'}`}>
                              {p.stats.ovr}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-center font-mono text-slate-300">{p.stats.bat}</td>
                          <td className="py-2.5 px-3 text-center font-mono text-slate-300">{p.stats.power}</td>
                          <td className="py-2.5 px-3 text-center font-mono text-slate-300">{p.stats.bowl}</td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-brand-gold">
                            ₹{p.basePrice.toFixed(2)} Cr
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* Bento 3: My Ticked Targets Sidebar */}
        <div className="lg:col-span-4 bg-tile border border-borderDark rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-borderMuted">
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 fill-brand-gold text-brand-gold" />
                <h3 className="text-xs font-mono font-bold tracking-wider uppercase text-slate-200">
                  Targeted Shortlist
                </h3>
              </div>
              <span className="text-xs font-mono font-bold text-brand-gold">
                {selectedIds.length} TARGETED
              </span>
            </div>

            {/* Role Breakdown Pills */}
            <div className="grid grid-cols-5 gap-1.5 my-3">
              {Object.entries(roleCounts).map(([r, c]) => (
                <div key={r} className="p-1.5 rounded bg-canvas border border-borderDark text-center font-mono text-[10px]">
                  <div className="text-slate-500">{r}</div>
                  <div className={`font-bold ${c > 0 ? 'text-brand-gold' : 'text-slate-600'}`}>{c}</div>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-slate-400 mb-3">
              Players ticked here bypass the live auction auto-skip filter with golden highlight priority.
            </p>

            {/* Ticked List */}
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
              {selectedPlayers.length === 0 ? (
                <div className="p-8 text-center text-xs font-mono text-slate-600">
                  No players targeted yet.<br />Click stars in table to tick targets.
                </div>
              ) : (
                selectedPlayers.map(p => (
                  <div
                    key={p.id}
                    className="p-2 rounded bg-canvas border border-borderDark flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="font-medium text-slate-200 flex items-center gap-1">
                        <span>{p.name}</span>
                        {p.isOverseas && <span className="text-[10px]">✈️</span>}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        {p.role} • OVR {p.stats.ovr}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-brand-gold">
                        ₹{p.basePrice.toFixed(2)} Cr
                      </span>
                      <button
                        onClick={() => toggleTarget(p.id)}
                        className="text-slate-500 hover:text-brand-rose text-xs px-1"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-borderMuted flex items-center justify-between text-xs font-mono">
            <button
              onClick={() => setSelectedIds([])}
              disabled={hasSubmitted || selectedIds.length === 0}
              className="text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-40"
            >
              Clear All
            </button>
            <span className="text-[11px] text-slate-400">
              EST. BASE: ₹{selectedPlayers.reduce((acc, p) => acc + p.basePrice, 0).toFixed(2)} Cr
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

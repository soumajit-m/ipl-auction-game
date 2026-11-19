'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useGameRoomStore } from '@/lib/useGameRoomStore';
import {
  Users,
  Copy,
  Check,
  Play,
  ShieldAlert,
  Bot,
  User,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  LogOut
} from 'lucide-react';

const FRANCHISE_METADATA: Record<string, { name: string; city: string; primaryColor: string; accentColor: string }> = {
  CSK: { name: 'Chennai Super Kings', city: 'Chennai', primaryColor: 'from-amber-500/20 to-yellow-600/10', accentColor: 'border-amber-500/40 text-amber-400' },
  MI: { name: 'Mumbai Indians', city: 'Mumbai', primaryColor: 'from-blue-600/20 to-blue-800/10', accentColor: 'border-blue-500/40 text-blue-400' },
  RCB: { name: 'Royal Challengers Bengaluru', city: 'Bengaluru', primaryColor: 'from-red-600/20 to-red-900/10', accentColor: 'border-red-500/40 text-red-400' },
  KKR: { name: 'Kolkata Knight Riders', city: 'Kolkata', primaryColor: 'from-purple-600/20 to-indigo-950/20', accentColor: 'border-purple-500/40 text-purple-400' },
  SRH: { name: 'Sunrisers Hyderabad', city: 'Hyderabad', primaryColor: 'from-orange-600/20 to-amber-700/10', accentColor: 'border-orange-500/40 text-orange-400' },
  RR: { name: 'Rajasthan Royals', city: 'Jaipur', primaryColor: 'from-pink-600/20 to-rose-900/10', accentColor: 'border-pink-500/40 text-pink-400' },
  DC: { name: 'Delhi Capitals', city: 'Delhi', primaryColor: 'from-sky-600/20 to-blue-900/10', accentColor: 'border-sky-500/40 text-sky-400' },
  PBKS: { name: 'Punjab Kings', city: 'Mohali', primaryColor: 'from-rose-600/20 to-red-800/10', accentColor: 'border-rose-500/40 text-rose-400' },
  LSG: { name: 'Lucknow Super Giants', city: 'Lucknow', primaryColor: 'from-cyan-600/20 to-teal-900/10', accentColor: 'border-cyan-500/40 text-cyan-400' },
  GT: { name: 'Gujarat Titans', city: 'Ahmedabad', primaryColor: 'from-slate-700/30 to-blue-950/20', accentColor: 'border-slate-400/40 text-slate-300' }
};

const ORDERED_FRANCHISE_IDS = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'DC', 'PBKS', 'LSG', 'GT'];

export default function PreGameLobbyPage() {
  const router = useRouter();
  const {
    roomState,
    roomCode,
    mySeat,
    playerName,
    isHost,
    claimSeat,
    hostAction,
    connected,
    leaveRoom,
    initSocket,
    joinOrSyncRoom
  } = useGameRoomStore();

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    initSocket();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlRoom = params.get('room') || params.get('roomCode');
      if (urlRoom && urlRoom.toUpperCase().trim() !== roomCode) {
        joinOrSyncRoom(urlRoom.toUpperCase().trim());
      }
    }
  }, []);

  const handleQuitRoom = () => {
    if (window.confirm('Quit this lobby and return to home screen?')) {
      leaveRoom();
      router.push('/');
    }
  };

  // Watch room phase transitions
  useEffect(() => {
    if (!roomCode && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlRoom = params.get('room') || params.get('roomCode') || localStorage.getItem('active_ipl_room_code');
      if (!urlRoom) {
        router.push('/');
      }
      return;
    }

    if (roomState?.status === 'WISHLIST') {
      router.push(`/wishlist${roomCode ? `?room=${roomCode}` : ''}`);
    } else if (roomState?.status === 'AUCTION') {
      router.push(`/auction${roomCode ? `?room=${roomCode}` : ''}`);
    } else if (roomState?.status === 'SEASON') {
      router.push(`/season${roomCode ? `?room=${roomCode}` : ''}`);
    }
  }, [roomState?.status, roomCode, router]);

  const handleCopyPin = () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleClaimFranchise = (teamId: string) => {
    const handle = playerName || mySeat?.playerName || 'Manager';
    claimSeat(teamId, handle);
  };

  const seats = roomState?.seats || [];
  const teams = roomState?.teams || {};

  // Extract human players
  const connectedHumans = seats.filter(s => s.isHuman);

  return (
    <div className="min-h-screen bg-canvas text-slate-100 flex flex-col font-sans select-none">
      {/* Top Header */}
      <header className="bg-tile border-b border-borderDark px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full bg-brand-gold animate-pulse" />
          <h1 className="font-mono font-bold text-base md:text-lg tracking-wider text-slate-100">
            PRE-GAME WAITING LOBBY
          </h1>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-subpill border border-borderDark text-slate-400">
            PHASE: WAITING FOR MANAGERS
          </span>
        </div>

        {/* Room PIN Copy Badge */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-canvas border border-borderDark shadow-inner">
            <span className="text-xs font-mono text-slate-400">ROOM PIN:</span>
            <span className="font-mono font-bold text-base tracking-widest text-brand-gold">
              {roomCode || '---'}
            </span>
            <button
              onClick={handleCopyPin}
              title="Copy Room PIN"
              className="p-1.5 rounded-lg bg-subpill hover:bg-subpillHover border border-borderDark text-slate-300 hover:text-white transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-brand-emerald" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>

          <button
            type="button"
            onClick={handleQuitRoom}
            className="h-10 px-3.5 rounded-xl bg-red-950/40 hover:bg-red-900/60 border border-red-800/60 text-xs font-mono font-bold text-red-300 transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap"
            title="Quit room and return to Home"
          >
            <LogOut className="w-4 h-4" />
            <span>Quit Room</span>
          </button>

          {copied && (
            <span className="text-xs font-mono text-brand-emerald animate-fadeIn">
              Copied to clipboard!
            </span>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full flex flex-col gap-6">
        {/* Banner with Instructions & Connected Humans */}
        <div className="bg-[#12151E] border border-white/[0.08] rounded-2xl p-5 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold font-mono tracking-wide text-white uppercase flex items-center gap-2">
              <Users className="w-4 h-4 text-brand-cyan" />
              <span>FRANCHISE SEAT SELECTION</span>
            </h2>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl">
              Each manager must claim one of the 10 franchises below. Any unclaimed slots will be managed autonomously by the AI Manager.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-10 px-3.5 rounded-xl bg-[#1C202E] border border-white/[0.06] text-xs font-mono text-slate-300 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-brand-emerald" />
              <span>CONNECTED MANAGERS: <strong className="text-white tabular-nums">{connectedHumans.length}</strong> / 10</span>
            </div>

            {/* Host-Only Start Button */}
            {isHost && (
              <button
                onClick={() => hostAction('START_AUCTION')}
                className="h-10 px-6 rounded-xl bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-xs font-mono tracking-wider flex items-center gap-2 shadow-lg shadow-brand-gold/15 transition-transform active:scale-95"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>START GAME → LAUNCH WISHLIST</span>
              </button>
            )}
          </div>
        </div>

        {/* 10 IPL Franchises in a 2x5 Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {ORDERED_FRANCHISE_IDS.map(teamId => {
            const meta = FRANCHISE_METADATA[teamId] || { name: teamId, city: '', primaryColor: 'from-slate-800 to-slate-900', accentColor: 'border-slate-600 text-slate-300' };
            const seat = seats.find(s => s.teamId === teamId);
            const team = teams[teamId];
            const isHuman = seat?.isHuman || team?.isHuman;
            const isMyTeam = mySeat?.teamId === teamId;
            const ownerDisplayName = seat?.playerName || team?.ownerName || '';

            return (
              <div
                key={teamId}
                className={`rounded-2xl border p-4 flex flex-col justify-between transition-all bg-gradient-to-b ${meta.primaryColor} ${
                  isMyTeam
                    ? 'border-brand-gold ring-1 ring-brand-gold/50 shadow-md shadow-brand-gold/10 bg-[#12151E]'
                    : isHuman
                    ? 'border-brand-cyan/40 bg-[#12151E]'
                    : 'border-white/[0.08] hover:border-slate-500 bg-[#12151E]'
                }`}
              >
                <div>
                  {/* Top Row: Team Badge & Ownership Badge */}
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <span className="font-mono font-black text-xl tracking-tight text-white">
                        {teamId}
                      </span>
                      <div className="text-[11px] text-slate-400 font-sans truncate max-w-[130px]" title={meta.name}>
                        {meta.name}
                      </div>
                    </div>

                    {isMyTeam ? (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-brand-gold text-slate-950 font-bold tracking-wider">
                        YOUR TEAM
                      </span>
                    ) : isHuman ? (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-brand-cyan/20 text-brand-cyan border border-brand-cyan/40">
                        HUMAN
                      </span>
                    ) : (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#1C202E] text-slate-400 border border-white/[0.06] flex items-center gap-1">
                        <Bot className="w-3 h-3 text-slate-500" />
                        AI
                      </span>
                    )}
                  </div>

                  {/* Purse Readout */}
                  <div className="text-xs font-mono text-slate-400 mt-3 pt-2 border-t border-white/[0.06] flex justify-between">
                    <span>PURSE:</span>
                    <span className="text-brand-gold font-bold tabular-nums">₹125.00 Cr</span>
                  </div>
                </div>

                {/* Bottom Action / Ownership Status */}
                <div className="mt-4 pt-3 border-t border-white/[0.06]">
                  {isMyTeam ? (
                    <div className="flex items-center justify-between text-xs font-mono text-brand-gold font-bold">
                      <div className="flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-brand-gold" />
                        <span>YOUR FRANCHISE</span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-brand-gold/15 text-brand-gold">Active</span>
                    </div>
                  ) : isHuman ? (
                    <div className="flex items-center gap-1.5 text-xs font-mono text-slate-300">
                      <User className="w-3.5 h-3.5 text-brand-cyan" />
                      <span className="truncate">OWNER: <strong>{ownerDisplayName || 'Claimed'}</strong></span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleClaimFranchise(teamId)}
                      className={`w-full h-9 px-3 rounded-xl border text-xs font-mono transition-all flex items-center justify-center gap-1.5 group ${
                        mySeat
                          ? 'bg-[#1C202E] hover:bg-brand-cyan/20 border-white/[0.08] hover:border-brand-cyan/40 text-brand-cyan'
                          : 'bg-[#1C202E] hover:bg-[#2C3246] border-white/[0.06] text-brand-gold hover:text-white'
                      }`}
                    >
                      <span>{mySeat ? 'Switch to Team' : 'Claim Franchise'}</span>
                      <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Connected Players Roster Box */}
        <div className="bg-[#12151E] border border-white/[0.08] rounded-2xl p-5">
          <h3 className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Users className="w-3.5 h-3.5 text-brand-emerald" />
            <span>CONNECTED MANAGERS ROSTER ({connectedHumans.length})</span>
          </h3>

          {connectedHumans.length === 0 ? (
            <p className="text-xs text-slate-500 font-mono italic">
              No human managers have claimed a team yet. Click any franchise card above to take ownership.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {connectedHumans.map(s => (
                <div
                  key={s.teamId}
                  className="p-3 rounded-lg bg-canvas border border-borderDark flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-brand-emerald" />
                    <span className="text-slate-200 font-bold">{s.playerName}</span>
                  </div>
                  <span className="text-brand-gold font-bold">{s.teamId}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer info for non-hosts */}
        {!isHost && (
          <div className="text-center py-4 text-xs font-mono text-slate-500 flex items-center justify-center gap-2">
            <span className="w-2 h-2 rounded-full bg-brand-gold animate-pulse" />
            <span>Waiting for the Host to start the game...</span>
          </div>
        )}
      </main>
    </div>
  );
}

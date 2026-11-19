'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useGameRoomStore } from '@/lib/useGameRoomStore';
import { scoutRivalWeakPoints, WeakPointTip } from '@/lib/weakPointScout';
import {
  BarChart3,
  ShieldAlert,
  ArrowRight,
  ArrowLeft,
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  ExternalLink,
  Users,
  LogOut
} from 'lucide-react';

export default function PostAuctionAnalyticsPage() {
  const router = useRouter();
  const { roomState, roomCode, mySeat, initSocket, joinOrSyncRoom, leaveRoom } = useGameRoomStore();

  const handleQuitRoom = () => {
    if (window.confirm('Quit this room and return to home screen?')) {
      leaveRoom();
      router.push('/');
    }
  };

  useEffect(() => {
    initSocket();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlRoom = params.get('room') || params.get('roomCode');
      const activeCode = urlRoom || roomCode || localStorage.getItem('active_ipl_room_code');
      if (activeCode) {
        joinOrSyncRoom(activeCode);
      }
    }
  }, [initSocket, joinOrSyncRoom, roomCode]);

  const teams = roomState?.teams || {};
  const teamList = Object.values(teams);
  const defaultSelectedTeamId = mySeat?.teamId || teamList[0]?.franchiseId || 'CSK';
  const [selectedTeamId, setSelectedTeamId] = useState<string>(defaultSelectedTeamId);

  // Check whether the auction is still active or completed
  const isAuctionActive = Boolean(
    roomState?.status === 'AUCTION' ||
    (roomState && !roomState.season && roomState.status !== 'SEASON')
  );

  const selectedTeam = teams[selectedTeamId] || teamList[0];

  // Scout weak points for selected team
  const tips: WeakPointTip[] = useMemo(() => {
    if (!selectedTeam) return [];
    return scoutRivalWeakPoints(selectedTeam.squad);
  }, [selectedTeam]);

  // Squad Strength Metric Computations
  const squadMetrics = useMemo(() => {
    return teamList.map(t => {
      const squad = t.squad;
      const count = squad.length || 1;
      const avgOvr = squad.reduce((acc, p) => acc + p.stats.ovr, 0) / count;
      const avgBat = squad.reduce((acc, p) => acc + p.stats.bat, 0) / count;
      const avgPwr = squad.reduce((acc, p) => acc + p.stats.power, 0) / count;
      const avgBowl = squad.reduce((acc, p) => acc + p.stats.bowl, 0) / count;
      const deathCount = squad.filter(p => (p.tacticalSynergy?.death ?? 0) >= 0.5 || p.subType === 'DEATH_OVERS_PACER').length;
      return {
        id: t.franchiseId,
        name: t.name,
        count: squad.length,
        purseLeft: t.purse,
        avgOvr: Math.round(avgOvr),
        avgBat: Math.round(avgBat),
        avgPwr: Math.round(avgPwr),
        avgBowl: Math.round(avgBowl),
        deathCount
      };
    }).sort((a, b) => b.avgOvr - a.avgOvr);
  }, [teamList]);

  return (
    <div className="min-h-screen bg-canvas text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-tile border-b border-borderDark px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-5 h-5 text-brand-gold" />
          <h1 className="font-mono font-bold text-sm tracking-wider text-slate-100">
            SQUAD INTELLIGENCE & RIVAL SCOUTING
          </h1>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-canvas border border-borderDark text-brand-gold">
            [{roomCode || 'LOBBY'}]
          </span>
        </div>

        <div className="flex items-center gap-3">
          {isAuctionActive ? (
            <button
              type="button"
              onClick={() => {
                const isDebug = typeof window !== 'undefined' && window.location.search.includes('debug');
                const targetRoom = roomCode || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('room') : null);
                router.push(`/auction${targetRoom ? `?room=${targetRoom}` : ''}${isDebug ? (targetRoom ? '&debug=true' : '?debug=true') : ''}`);
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-xs font-mono transition-transform active:scale-95 shadow-md"
              title="Return to the live auction room"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to Auction</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const isDebug = typeof window !== 'undefined' && window.location.search.includes('debug');
                const targetRoom = roomCode || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('room') : null);
                router.push(`/season${targetRoom ? `?room=${targetRoom}` : ''}${isDebug ? (targetRoom ? '&debug=true' : '?debug=true') : ''}`);
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-xs font-mono transition-transform active:scale-95 shadow-md"
              title="Enter Season Hub schedule and match center"
            >
              <span>Enter Season Hub</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            onClick={handleQuitRoom}
            className="h-9 px-3.5 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-800/60 text-xs font-mono font-bold text-red-300 transition-all shadow-sm flex items-center gap-1.5 active:scale-95 whitespace-nowrap"
            title="Quit room and return to Home"
          >
            <LogOut className="w-4 h-4" />
            <span>Quit Room</span>
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: 10-Team Comparison Bar Board */}
        <section className="lg:col-span-7 bg-tile border border-borderDark rounded-xl p-5 flex flex-col">
          <div className="flex items-center justify-between pb-3 border-b border-borderMuted mb-4">
            <h2 className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">
              FRANCHISE OVERALL SQUAD RATINGS
            </h2>
            <span className="text-[11px] font-mono text-slate-500">AVERAGE SQUAD OVR</span>
          </div>

          <div className="space-y-3 flex-1 overflow-y-auto">
            {squadMetrics.map((sm, rank) => {
              const isSelected = selectedTeamId === sm.id;
              const barWidth = Math.max(10, Math.min(100, ((sm.avgOvr - 60) / 38) * 100));

              return (
                <div
                  key={sm.id}
                  onClick={() => setSelectedTeamId(sm.id)}
                  className={`p-3 rounded-lg border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-subpill border-brand-gold'
                      : 'bg-canvas border-borderDark hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-slate-500">#{rank + 1}</span>
                      <span className="font-bold text-slate-200">{sm.name} ({sm.id})</span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {sm.count} players • ₹{sm.purseLeft.toFixed(2)} Cr left
                      </span>
                    </div>
                    <span className="font-mono font-extrabold text-brand-gold">
                      OVR {sm.avgOvr}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-subpill rounded-full h-2 overflow-hidden mb-2">
                    <div
                      className="bg-brand-gold h-full rounded-full transition-all"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>

                  {/* Secondary Metrics */}
                  <div className="grid grid-cols-4 gap-2 text-[10px] font-mono text-slate-400">
                    <div>BAT: <span className="text-slate-200 font-bold">{sm.avgBat}</span></div>
                    <div>PWR: <span className="text-slate-200 font-bold">{sm.avgPwr}</span></div>
                    <div>BOWL: <span className="text-slate-200 font-bold">{sm.avgBowl}</span></div>
                    <div>DEATH: <span className="text-slate-200 font-bold">{sm.deathCount}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Right: Tactical Weak-Point Scout Card */}
        <section className="lg:col-span-5 bg-tile border border-borderDark rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-borderMuted mb-4">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-brand-rose" />
                <h2 className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">
                  RIVAL WEAK-POINT SCOUT
                </h2>
              </div>
              <select
                value={selectedTeamId}
                onChange={e => setSelectedTeamId(e.target.value)}
                className="bg-canvas border border-borderDark text-xs font-mono px-2.5 py-1 rounded text-slate-200 focus:outline-none focus:border-brand-gold"
              >
                {teamList.map(t => (
                  <option key={t.franchiseId} value={t.franchiseId}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3 overflow-y-auto max-h-[520px] pr-1">
              {tips.length === 0 ? (
                <div className="p-8 text-center text-xs font-mono text-slate-500">
                  No critical tactical vulnerabilities detected for {selectedTeam?.name}. Balanced roster.
                </div>
              ) : (
                tips.map(tip => (
                  <div
                    key={tip.id}
                    className="p-3.5 rounded-lg bg-canvas border border-borderDark space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-100 flex items-center gap-1.5">
                        {tip.severity === 'CRITICAL' && <AlertTriangle className="w-3.5 h-3.5 text-brand-rose" />}
                        {tip.severity === 'WARNING' && <ShieldAlert className="w-3.5 h-3.5 text-brand-gold" />}
                        {tip.severity === 'OPPORTUNITY' && <Lightbulb className="w-3.5 h-3.5 text-brand-cyan" />}
                        <span>{tip.title}</span>
                      </span>
                      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase font-bold ${
                        tip.severity === 'CRITICAL' ? 'bg-brand-rose/20 text-brand-rose border border-brand-rose/30' :
                        tip.severity === 'WARNING' ? 'bg-brand-gold/20 text-brand-gold border border-brand-gold/30' :
                        'bg-brand-cyan/20 text-brand-cyan border border-brand-cyan/30'
                      }`}>
                        {tip.severity}
                      </span>
                    </div>

                    <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                      {tip.description}
                    </p>

                    <div className="p-2 rounded bg-subpill/70 border border-borderDark text-[11px] text-slate-300 font-mono flex items-start gap-1.5">
                      <span className="text-brand-gold font-bold">TACTIC:</span>
                      <span>{tip.recommendation}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-borderMuted text-[11px] text-slate-500 font-mono flex items-center justify-between">
            <span>TACTICAL SCOUT REPORT</span>
            <button
              onClick={() => router.push('/season')}
              className="text-brand-gold hover:underline flex items-center gap-1 font-bold"
            >
              <span>Configure Playing 11</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

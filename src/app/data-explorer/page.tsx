'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { IPLPlayer } from '@/types/player.types';
import { Search, Database, ArrowLeft, Download, Sliders } from 'lucide-react';

export default function DataExplorerPage() {
  const router = useRouter();
  const [players, setPlayers] = useState<IPLPlayer[]>([]);
  const [stadiums, setStadiums] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');

  useEffect(() => {
    fetch(`/api/players?_t=${Date.now()}`, { cache: 'no-store' })
      .then(res => res.json())
      .then(data => {
        if (data.players) setPlayers(data.players);
        if (data.stadiums) setStadiums(data.stadiums);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    return players.filter(p => {
      if (search) {
        const q = search.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.country.toLowerCase().includes(q)) return false;
      }
      if (roleFilter !== 'ALL' && p.role !== roleFilter) return false;
      return true;
    });
  }, [players, search, roleFilter]);

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(players, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'players_active_314.json';
    a.click();
  };

  return (
    <div className="min-h-screen bg-canvas text-slate-100 flex flex-col font-sans">
      <header className="bg-tile border-b border-borderDark px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/')}
            className="p-1.5 rounded hover:bg-subpill text-slate-400 hover:text-slate-200 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <Database className="w-5 h-5 text-brand-gold" />
          <h1 className="font-mono font-bold text-sm tracking-wider text-slate-100">
            IPL PLAYER DATABASE & VENUES SCOUT
          </h1>
        </div>

        <button
          onClick={handleExportJSON}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-subpill hover:bg-subpillHover border border-borderDark text-xs font-mono text-slate-200 transition-colors"
        >
          <Download className="w-4 h-4 text-brand-gold" />
          <span>Export 314 Active Players</span>
        </button>
      </header>

      <main className="p-6 max-w-7xl mx-auto w-full flex-1 flex flex-col space-y-4">
        {/* Controls */}
        <div className="p-4 bg-tile border border-borderDark rounded-xl flex flex-col md:flex-row gap-4 justify-between items-center">
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
            <input
              type="text"
              placeholder="Search by name, country..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-canvas border border-borderDark text-xs focus:outline-none focus:border-brand-gold"
            />
          </div>

          <div className="flex items-center gap-1 font-mono text-xs">
            {['ALL', 'BAT', 'WK', 'AR', 'PACE', 'SPIN'].map(r => (
              <button
                key={r}
                onClick={() => setRoleFilter(r)}
                className={`px-3 py-1.5 rounded transition-colors ${
                  roleFilter === r
                    ? 'bg-brand-gold text-slate-950 font-bold'
                    : 'bg-canvas text-slate-400 hover:text-slate-200 border border-borderDark'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-tile border border-borderDark rounded-xl overflow-hidden flex-1 flex flex-col">
          <div className="p-3 bg-canvas border-b border-borderDark text-xs font-mono text-slate-400 flex justify-between">
            <span>VERIFIED PLAYERS: {filtered.length} OF {players.length}</span>
            <span>STADIUMS: {stadiums.length} HOMES</span>
          </div>

          <div className="overflow-x-auto flex-1 max-h-[650px] overflow-y-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-tile sticky top-0 border-b border-borderDark text-slate-400 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4">ID</th>
                  <th className="py-2.5 px-4">NAME</th>
                  <th className="py-2.5 px-3">ROLE</th>
                  <th className="py-2.5 px-3">SUB-TYPE</th>
                  <th className="py-2.5 px-3 text-center">OVR</th>
                  <th className="py-2.5 px-3 text-center">BAT</th>
                  <th className="py-2.5 px-3 text-center">PWR</th>
                  <th className="py-2.5 px-3 text-center">BOWL</th>
                  <th className="py-2.5 px-3 text-center">FLD</th>
                  <th className="py-2.5 px-4 text-right">BASE (CR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-borderDark/40">
                {filtered.map(p => (
                  <tr key={p.id} className="hover:bg-subpill/40">
                    <td className="py-2.5 px-4 text-slate-500">{p.id}</td>
                    <td className="py-2.5 px-4 font-bold text-slate-200">
                      {p.name} {p.isOverseas && '✈️'} {p.isUncapped && <span className="text-[10px] text-slate-500 font-normal">UNC</span>}
                    </td>
                    <td className="py-2.5 px-3 text-brand-gold">{p.role}</td>
                    <td className="py-2.5 px-3 text-slate-400 text-[10px]">{p.subType}</td>
                    <td className="py-2.5 px-3 text-center font-bold text-slate-100">{p.stats.ovr}</td>
                    <td className="py-2.5 px-3 text-center text-slate-300">{p.stats.bat}</td>
                    <td className="py-2.5 px-3 text-center text-slate-300">{p.stats.power}</td>
                    <td className="py-2.5 px-3 text-center text-slate-300">{p.stats.bowl}</td>
                    <td className="py-2.5 px-3 text-center text-slate-300">{p.stats.fielding}</td>
                    <td className="py-2.5 px-4 text-right font-bold text-brand-gold">₹{p.basePrice.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}

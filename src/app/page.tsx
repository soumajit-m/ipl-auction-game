'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useGameRoomStore } from '@/lib/useGameRoomStore';
import {
  ShieldAlert,
  Play,
  RotateCw,
  Users,
  Server,
  Sliders,
  Settings,
  Sparkles,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Trash2,
  LogOut,
  UserCheck,
  Mail,
  KeyRound,
  ArrowRight,
  Send,
  Lock,
  ChevronRight
} from 'lucide-react';

export default function EntryLobbyPage() {
  const router = useRouter();
  const {
    initSocket,
    connected,
    joinRoom,
    claimSeat,
    claimableSeats,
    roomState,
    mySeat,
    hostAuth,
    setHostAuth,
    logoutHost,
    deleteSavedRoom,
    errorMessage,
    clearError
  } = useGameRoomStore();

  // Mode Switcher: Guest Quick Join vs. Host Command
  const [activeTab, setActiveTab] = useState<'GUEST' | 'HOST'>('GUEST');

  // Guest State
  const [guestName, setGuestName] = useState('');
  const [roomPin, setRoomPin] = useState('');

  // Host Auth State
  const [hostSubMode, setHostSubMode] = useState<'SIGN_IN' | 'REGISTER'>('SIGN_IN');
  const [hostLoginType, setHostLoginType] = useState<'PASSWORD' | 'OTP'>('PASSWORD');
  const [hostEmail, setHostEmail] = useState('');
  const [hostName, setHostName] = useState('');
  const [hostPassword, setHostPassword] = useState('');
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([]);

  const [otpSent, setOtpSent] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [devOtpPreview, setDevOtpPreview] = useState<string | null>(null);

  const [hostAuthError, setHostAuthError] = useState('');
  const [hostAuthLoading, setHostAuthLoading] = useState(false);

  // Room Creation & Saved Rooms State
  const [aiAggression, setAiAggression] = useState(0.45);
  const [matchDeterminism, setMatchDeterminism] = useState(0.45);
  const [minPlayerOvr, setMinPlayerOvr] = useState<number>(60);
  const [simAlpha, setSimAlpha] = useState<number>(0.80);
  const [humanTax, setHumanTax] = useState(true);
  const [showConfigDrawer, setShowConfigDrawer] = useState(false);
  const [savedRooms, setSavedRooms] = useState<any[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);

  useEffect(() => {
    initSocket();
  }, [initSocket]);

  useEffect(() => {
    if (hostAuth?.hostId) {
      fetchSavedRooms(hostAuth.hostId, hostAuth.token);
    } else {
      setSavedRooms([]);
    }
  }, [hostAuth]);

  // Resend countdown ticker
  useEffect(() => {
    if (resendCountdown > 0) {
      const timer = setTimeout(() => setResendCountdown(resendCountdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCountdown]);

  useEffect(() => {
    // When landing on the home page, clear any active room state from the store so old sessions do not hijack
    useGameRoomStore.setState({ roomCode: null, roomState: null, mySeat: null });
  }, []);

  const fetchSavedRooms = async (hostId: string, token?: string) => {
    setLoadingRooms(true);
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`/api/rooms/host-history?hostId=${hostId}`, { headers });
      const data = await res.json();
      if (data.rooms) setSavedRooms(data.rooms);
    } catch (e) {
      console.warn('Failed to load room history');
    } finally {
      setLoadingRooms(false);
    }
  };

  const handleGuestJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomPin.trim() || !guestName.trim()) return;
    const cleanPin = roomPin.toUpperCase().trim();
    joinRoom(cleanPin, guestName, false);
    router.push(`/lobby?room=${cleanPin}`);
  };

  const handleClaim = (teamId: string) => {
    if (!guestName.trim()) return;
    claimSeat(teamId, guestName);
  };

  const handleOtpChange = (index: number, val: string) => {
    const clean = val.replace(/\D/g, '');
    if (clean.length > 1) {
      const next = [...otpDigits];
      for (let i = 0; i < 6; i++) {
        if (clean[i]) next[i] = clean[i];
      }
      setOtpDigits(next);
      const nextFocus = Math.min(5, clean.length - 1);
      otpInputsRef.current[nextFocus]?.focus();
      return;
    }

    const next = [...otpDigits];
    next[index] = clean.slice(-1);
    setOtpDigits(next);

    if (clean && index < 5) {
      otpInputsRef.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpInputsRef.current[index - 1]?.focus();
    }
  };

  const handleSendOtp = async (purpose: 'REGISTER' | 'LOGIN_OTP') => {
    setHostAuthError('');
    if (!hostEmail.trim() || !hostEmail.includes('@')) {
      setHostAuthError('Please enter a valid email address first.');
      return;
    }

    setSendingOtp(true);
    const cleanEmail = hostEmail.trim().toLowerCase();
    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, purpose })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setOtpSent(true);
        setResendCountdown(60);
        if (data.devOtpPreview) {
          setDevOtpPreview(data.devOtpPreview);
        }
      } else {
        setHostAuthError(data.error || 'Failed to send OTP code.');
      }
    } catch (err) {
      setHostAuthError('Network error sending verification code.');
    } finally {
      setSendingOtp(false);
    }
  };

  const handleHostAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setHostAuthError('');
    setHostAuthLoading(true);

    const cleanEmail = hostEmail.trim().toLowerCase();
    try {
      if (hostSubMode === 'REGISTER') {
        const otpCode = otpDigits.join('');
        if (otpCode.length !== 6) {
          setHostAuthError('Please enter all 6 digits of your verification code.');
          setHostAuthLoading(false);
          return;
        }

        const res = await fetch('/api/auth/verify-and-register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: cleanEmail,
            name: hostName.trim() || cleanEmail.split('@')[0],
            password: hostPassword,
            otp: otpCode
          })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          setHostAuth(data.hostId, data.email, data.token, data.email, data.name);
          setHostPassword('');
          setOtpDigits(['', '', '', '', '', '']);
        } else {
          setHostAuthError(data.error || 'Registration failed.');
        }
      } else {
        // Sign In
        const payload: any = { email: cleanEmail };
        if (hostLoginType === 'OTP') {
          const otpCode = otpDigits.join('');
          if (otpCode.length !== 6) {
            setHostAuthError('Please enter all 6 digits of your verification code.');
            setHostAuthLoading(false);
            return;
          }
          payload.otp = otpCode;
        } else {
          payload.password = hostPassword;
        }

        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.ok && data.success) {
          setHostAuth(data.hostId, data.email || data.username, data.token, data.email, data.name);
          setHostPassword('');
          setOtpDigits(['', '', '', '', '', '']);
        } else {
          setHostAuthError(data.error || 'Sign in failed.');
        }
      }
    } catch (err) {
      setHostAuthError('Network error connecting to auth server.');
    } finally {
      setHostAuthLoading(false);
    }
  };

  const handleCreateRoom = async () => {
    if (!hostAuth) return;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (hostAuth.token) headers['Authorization'] = `Bearer ${hostAuth.token}`;

      const res = await fetch('/api/rooms/create', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          hostId: hostAuth.hostId,
          hostUsername: hostAuth.username,
          determinismRatio: matchDeterminism,
          aiAggression: aiAggression,
          humanTaxEnabled: humanTax,
          minOvr: minPlayerOvr,
          simAlpha: simAlpha,
          hostDeviceUUID: typeof window !== 'undefined' ? localStorage.getItem('ipl_device_uuid') || undefined : undefined
        })
      });
      const data = await res.json();
      if (data.roomCode) {
        const cleanCode = data.roomCode.toUpperCase().trim();
        joinRoom(cleanCode, hostAuth.name || hostAuth.username, true);
        router.push(`/lobby?room=${cleanCode}`);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteRoom = async (code: string) => {
    const confirmed = window.confirm(`Permanently delete saved room [${code}]? This cannot be undone.`);
    if (!confirmed) return;

    const ok = await deleteSavedRoom(code);
    if (ok && hostAuth) {
      fetchSavedRooms(hostAuth.hostId, hostAuth.token);
    }
  };

  return (
    <main className="min-h-screen bg-[#090B10] text-slate-100 p-4 md:p-8 flex flex-col justify-between font-sans select-none">
      {/* Top Header */}
      <header className="max-w-4xl mx-auto w-full flex flex-col sm:flex-row justify-between items-center gap-3 pb-6 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <span className="w-2.5 h-2.5 rounded-full bg-brand-gold animate-pulse" />
          <h1 className="text-lg md:text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>IPL AUCTION & FRANCHISE MANAGER</span>
            <span className="text-xs px-2 py-0.5 rounded-md bg-[#1C202E] border border-white/[0.08] text-brand-gold font-mono">
              2026
            </span>
          </h1>
        </div>

        <div className="flex items-center gap-2.5 text-xs">
          <div className="flex items-center gap-2 h-9 px-3 rounded-xl bg-[#12151E] border border-white/[0.06] text-slate-300 font-mono">
            <Server className={`w-3.5 h-3.5 ${connected ? 'text-brand-emerald' : 'text-brand-rose'}`} />
            <span>{connected ? 'CONNECTED' : 'OFFLINE'}</span>
          </div>

          <button
            onClick={() => router.push('/data-explorer')}
            className="flex items-center gap-1.5 h-9 px-3 rounded-xl bg-[#1C202E] hover:bg-[#2C3246] border border-white/[0.06] text-slate-300 hover:text-white transition-all text-xs"
          >
            <span>Players</span>
            <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
          </button>
        </div>
      </header>

      {/* Global Error Notification */}
      {errorMessage && (
        <div className="max-w-[460px] mx-auto w-full my-3 p-3 bg-brand-rose/15 border border-brand-rose/30 rounded-xl flex items-center justify-between text-xs text-brand-rose">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={clearError} className="underline text-[11px] hover:text-white">Dismiss</button>
        </div>
      )}

      {/* ==============================================================
          SINGLE CENTERED CARD WITH IOS SEGMENTED CONTROL SWITCHER
         ============================================================== */}
      <div className="flex-1 flex items-center justify-center my-6">
        <div className="max-w-[460px] w-full mx-auto ios-card-lg bg-[#12151E] border border-white/[0.08] rounded-3xl p-6 shadow-2xl flex flex-col justify-between min-h-[540px]">
          <div>
            {/* Top iOS Segmented Mode Switcher */}
            <div className="ios-segmented grid grid-cols-2 gap-1 mb-5">
              <button
                type="button"
                onClick={() => { setActiveTab('GUEST'); setHostAuthError(''); }}
                className={`h-9 flex items-center justify-center gap-2 text-xs font-semibold rounded-lg transition-all duration-150 ${
                  activeTab === 'GUEST'
                    ? 'ios-segmented-active bg-[#2C3246] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Users className="w-4 h-4" />
                <span>Quick Join (Guest)</span>
              </button>

              <button
                type="button"
                onClick={() => { setActiveTab('HOST'); setHostAuthError(''); }}
                className={`h-9 flex items-center justify-center gap-2 text-xs font-semibold rounded-lg transition-all duration-150 ${
                  activeTab === 'HOST'
                    ? 'ios-segmented-active bg-[#2C3246] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <ShieldAlert className="w-4 h-4" />
                <span>Host Command</span>
              </button>
            </div>

            {/* TAB 1: GUEST QUICK JOIN */}
            {activeTab === 'GUEST' && (
              <div className="min-h-[420px] flex flex-col justify-between">
                <div>
                  <div className="mb-4">
                    <h2 className="text-sm font-bold tracking-tight text-white flex items-center gap-1.5">
                      <span>Manager Entry</span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Enter your manager handle and room PIN to join a live mega auction.
                    </p>
                  </div>

                  {claimableSeats.length > 0 ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs font-mono text-brand-emerald">
                        <span>SELECT AN OPEN FRANCHISE:</span>
                        <span className="text-[10px] text-slate-400">{claimableSeats.length} available</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                        {claimableSeats.map(s => (
                          <button
                            key={s.teamId}
                            onClick={() => handleClaim(s.teamId)}
                            className="p-2.5 text-left rounded-xl bg-[#1C202E] hover:bg-[#2C3246] border border-white/[0.06] text-xs transition-colors flex items-center justify-between group"
                          >
                            <div>
                              <span className="font-bold text-white">{s.teamId}</span>
                              <div className="text-[10px] text-slate-400 truncate max-w-[100px]">{s.teamName}</div>
                            </div>
                            <ChevronRight className="w-3.5 h-3.5 text-brand-gold opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleGuestJoin} className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-300 mb-1.5">MANAGER DISPLAY NAME</label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. Rahul_Tactician"
                          value={guestName}
                          onChange={e => setGuestName(e.target.value)}
                          className="w-full h-11 px-4 rounded-xl bg-[#1C202E] border border-white/[0.06] text-sm text-white focus:outline-none focus:border-brand-gold placeholder:text-slate-600 transition-all"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-300 mb-1.5">ROOM PIN CODE</label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. IPL-8X9K"
                          value={roomPin}
                          onChange={e => setRoomPin(e.target.value.toUpperCase())}
                          className="w-full h-11 px-4 rounded-xl bg-[#1C202E] border border-white/[0.06] text-sm font-mono tracking-widest text-white uppercase focus:outline-none focus:border-brand-gold placeholder:text-slate-600 transition-all"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={!connected || !guestName.trim() || !roomPin.trim()}
                        className="w-full h-11 mt-2 rounded-xl bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md shadow-brand-gold/20"
                      >
                        <Play className="w-4 h-4 fill-current" />
                        <span>Join Live Room</span>
                      </button>
                    </form>
                  )}
                </div>

                <div className="pt-4 border-t border-white/[0.06] text-[11px] text-slate-500 font-mono flex items-center justify-between">
                  <span>DEVICE IDENTITY: <span className="text-slate-400">ACTIVE</span></span>
                  <span className="text-brand-emerald">SEAT SYNC READY</span>
                </div>
              </div>
            )}

            {/* TAB 2: HOST COMMAND CENTER */}
            {activeTab === 'HOST' && (
              <div className="min-h-[420px] flex flex-col justify-between">
                {!hostAuth ? (
                  <div className="flex-1 flex flex-col justify-between">
                    <div>
                      {/* Secondary compact pill toggle: Sign In vs Register */}
                      <div className="ios-segmented grid grid-cols-2 gap-1 mb-4">
                        <button
                          type="button"
                          onClick={() => { setHostSubMode('SIGN_IN'); setHostAuthError(''); }}
                          className={`h-8 text-xs font-semibold rounded-lg transition-all ${
                            hostSubMode === 'SIGN_IN'
                              ? 'ios-segmented-active bg-[#2C3246] text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Sign In
                        </button>
                        <button
                          type="button"
                          onClick={() => { setHostSubMode('REGISTER'); setHostAuthError(''); }}
                          className={`h-8 text-xs font-semibold rounded-lg transition-all ${
                            hostSubMode === 'REGISTER'
                              ? 'ios-segmented-active bg-[#2C3246] text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Register (Email OTP)
                        </button>
                      </div>

                      {/* Dev mode OTP preview banner */}
                      {devOtpPreview && (
                        <div className="mb-3 p-2.5 rounded-xl bg-brand-cyan/15 border border-brand-cyan/40 text-xs text-brand-cyan font-mono flex items-center justify-between animate-fadeIn">
                          <span>DEV OTP: <strong>{devOtpPreview}</strong></span>
                          <button
                            type="button"
                            onClick={() => {
                              const digits = devOtpPreview.split('');
                              setOtpDigits(digits);
                            }}
                            className="underline text-[10px]"
                          >
                            Auto-fill
                          </button>
                        </div>
                      )}

                      <form onSubmit={handleHostAuthSubmit} className="space-y-3">
                        {/* Register Name field */}
                        {hostSubMode === 'REGISTER' && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-300 mb-1">HOST NAME</label>
                            <input
                              type="text"
                              required
                              placeholder="e.g. Souma Host"
                              value={hostName}
                              onChange={e => setHostName(e.target.value)}
                              className="w-full h-11 px-4 rounded-xl bg-[#1C202E] border border-white/[0.06] text-sm text-white focus:outline-none focus:border-brand-cyan placeholder:text-slate-600 transition-all"
                            />
                          </div>
                        )}

                        {/* Email Address with Inline [Send Code] button */}
                        <div>
                          <label className="block text-[11px] font-medium text-slate-300 mb-1">EMAIL ADDRESS</label>
                          <div className="relative flex items-center">
                            <input
                              type="email"
                              required
                              placeholder="host@example.com"
                              value={hostEmail}
                              onChange={e => setHostEmail(e.target.value)}
                              className="w-full h-11 pl-4 pr-24 rounded-xl bg-[#1C202E] border border-white/[0.06] text-sm text-white focus:outline-none focus:border-brand-cyan placeholder:text-slate-600 transition-all"
                            />
                            {(hostSubMode === 'REGISTER' || hostLoginType === 'OTP') && (
                              <button
                                type="button"
                                disabled={sendingOtp || resendCountdown > 0 || !hostEmail.includes('@')}
                                onClick={() => handleSendOtp(hostSubMode === 'REGISTER' ? 'REGISTER' : 'LOGIN_OTP')}
                                className="absolute right-1.5 h-8 px-2.5 rounded-lg bg-[#2C3246] hover:bg-white/20 text-brand-cyan font-medium text-xs disabled:opacity-40 transition-colors"
                              >
                                {sendingOtp ? 'Sending...' : resendCountdown > 0 ? `${resendCountdown}s` : 'Send Code'}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* If Sign In: Toggle between Password vs OTP */}
                        {hostSubMode === 'SIGN_IN' && (
                          <div className="flex items-center justify-between text-[11px] pt-0.5 px-1">
                            <span className="text-slate-400">Sign-in method:</span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setHostLoginType('PASSWORD')}
                                className={`text-[11px] transition-colors ${hostLoginType === 'PASSWORD' ? 'text-brand-cyan font-bold underline' : 'text-slate-400'}`}
                              >
                                Password
                              </button>
                              <span className="text-slate-600">•</span>
                              <button
                                type="button"
                                onClick={() => setHostLoginType('OTP')}
                                className={`text-[11px] transition-colors ${hostLoginType === 'OTP' ? 'text-brand-cyan font-bold underline' : 'text-slate-400'}`}
                              >
                                6-Digit OTP
                              </button>
                            </div>
                          </div>
                        )}

                        {/* 6-Box OTP Row on Register or OTP Login */}
                        {(hostSubMode === 'REGISTER' || hostLoginType === 'OTP') && (
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <label className="text-[11px] font-medium text-slate-300">6-DIGIT VERIFICATION CODE</label>
                              {otpSent && <span className="text-[10px] text-brand-emerald">Code sent to email ✓</span>}
                            </div>
                            <div className="grid grid-cols-6 gap-2">
                              {otpDigits.map((digit, idx) => (
                                <input
                                  key={idx}
                                  ref={el => { otpInputsRef.current[idx] = el; }}
                                  type="text"
                                  inputMode="numeric"
                                  maxLength={1}
                                  value={digit}
                                  onChange={e => handleOtpChange(idx, e.target.value)}
                                  onKeyDown={e => handleOtpKeyDown(idx, e)}
                                  className="w-full h-11 text-center font-mono font-bold text-lg rounded-xl bg-[#1C202E] border border-white/[0.08] text-brand-gold focus:outline-none focus:border-brand-gold transition-all tabular-nums"
                                />
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Password input on Register or Password Login */}
                        {(hostSubMode === 'REGISTER' || hostLoginType === 'PASSWORD') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-300 mb-1">
                              {hostSubMode === 'REGISTER' ? 'CREATE PASSWORD (MIN 6 CHARS)' : 'PASSWORD'}
                            </label>
                            <input
                              type="password"
                              required
                              placeholder="••••••••"
                              value={hostPassword}
                              onChange={e => setHostPassword(e.target.value)}
                              className="w-full h-11 px-4 rounded-xl bg-[#1C202E] border border-white/[0.06] text-sm text-white focus:outline-none focus:border-brand-cyan placeholder:text-slate-600 transition-all"
                            />
                          </div>
                        )}

                        {/* Error Slot with Fixed Height to Prevent Shifting */}
                        <div className="h-5">
                          {hostAuthError && (
                            <p className="text-[11px] text-brand-rose leading-tight truncate">{hostAuthError}</p>
                          )}
                        </div>

                        {/* Bottom-Pinned Submit Button */}
                        <button
                          type="submit"
                          disabled={hostAuthLoading}
                          className="w-full h-11 rounded-xl bg-brand-cyan hover:bg-brand-cyan/90 text-slate-950 font-bold text-sm transition-all disabled:opacity-50 mt-1 shadow-md shadow-brand-cyan/20"
                        >
                          {hostAuthLoading
                            ? 'Authenticating...'
                            : hostSubMode === 'REGISTER'
                            ? 'Verify & Create Host Account'
                            : 'Sign In as Host'}
                        </button>
                      </form>
                    </div>
                  </div>
                ) : (
                  /* ==============================================================
                      LOGGED IN HOST VIEW
                     ============================================================== */
                  <div className="flex-1 flex flex-col justify-between">
                    <div>
                      {/* Host Profile Header Badge */}
                      <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/[0.06]">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-brand-emerald" />
                          <div className="leading-tight">
                            <div className="text-xs font-bold text-white flex items-center gap-1">
                              <span>{hostAuth.name || 'Verified Host'}</span>
                              <UserCheck className="w-3.5 h-3.5 text-brand-emerald" />
                            </div>
                            <div className="text-[10px] text-slate-400 font-mono truncate max-w-[200px]">
                              {hostAuth.email || hostAuth.username}
                            </div>
                          </div>
                        </div>

                        <button
                          onClick={logoutHost}
                          className="h-8 px-2.5 rounded-lg bg-[#1C202E] hover:bg-brand-rose/20 text-slate-400 hover:text-brand-rose border border-white/[0.06] transition-colors text-xs flex items-center gap-1.5"
                          title="Sign Out"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          <span>Sign Out</span>
                        </button>
                      </div>

                      {/* Primary Action: Create Room + Small Settings Button */}
                      <div className="flex items-center gap-2 mb-3">
                        <button
                          onClick={handleCreateRoom}
                          className="flex-1 h-11 rounded-xl bg-brand-gold hover:bg-brand-gold/90 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 shadow-md shadow-brand-gold/20 transition-transform active:scale-[0.98]"
                        >
                          <Sparkles className="w-4 h-4 fill-current" />
                          <span>+ Create New Auction Room</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowConfigDrawer(!showConfigDrawer)}
                          className={`h-11 w-11 rounded-xl border flex items-center justify-center transition-all ${
                            showConfigDrawer
                              ? 'bg-brand-gold text-slate-950 border-brand-gold shadow-md shadow-brand-gold/25'
                              : 'bg-[#1C202E] border-white/[0.08] text-slate-400 hover:text-white hover:border-slate-500'
                          }`}
                          title="Open Room & Simulation Settings Menu"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Settings Menu (3 Distinct Sliders + Counter-Bidding Toggle) */}
                      {showConfigDrawer && (
                        <div className="mb-4 p-4 rounded-xl bg-[#1C202E] border border-brand-gold/30 space-y-3.5 animate-fadeIn font-mono">
                          <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
                            <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                              <Settings className="w-3.5 h-3.5 text-brand-gold" />
                              ROOM & SIMULATION SETTINGS
                            </span>
                            <button
                              type="button"
                              onClick={() => setShowConfigDrawer(false)}
                              className="text-[10px] text-slate-400 hover:text-white"
                            >
                              Close ✕
                            </button>
                          </div>

                          {/* Slider 1: AI Auction Bidding Aggression */}
                          <div>
                            <div className="flex justify-between text-[11px] text-slate-300 mb-1">
                              <span>1. AI Bidding Aggression:</span>
                              <span className="text-brand-gold font-bold">
                                {aiAggression <= 0.30 ? 'Bolder / Upside (0.20)' : aiAggression >= 0.65 ? 'Conservative (0.80)' : 'Balanced (0.45)'}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0.20"
                              max="0.80"
                              step="0.05"
                              value={aiAggression}
                              onChange={e => setAiAggression(parseFloat(e.target.value))}
                              className="w-full accent-brand-gold cursor-pointer"
                            />
                            <div className="flex justify-between text-[9px] text-slate-500 mt-0.5">
                              <span>0.20 (Bolder Stars)</span>
                              <span>0.45 (Balanced)</span>
                              <span>0.80 (Value Discipline)</span>
                            </div>
                          </div>

                          {/* Slider 2: Match Engine Determinism & Volatility */}
                          <div className="pt-2 border-t border-white/[0.04]">
                            <div className="flex justify-between text-[11px] text-slate-300 mb-1">
                              <span>2. Match Engine Determinism:</span>
                              <span className="text-brand-gold font-bold">
                                {matchDeterminism <= 0.30 ? 'High Upsets (0.20)' : matchDeterminism >= 0.65 ? 'Skill Predictable (0.80)' : 'Balanced T20 (0.45)'}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0.20"
                              max="0.80"
                              step="0.05"
                              value={matchDeterminism}
                              onChange={e => setMatchDeterminism(parseFloat(e.target.value))}
                              className="w-full accent-brand-gold cursor-pointer"
                            />
                            <div className="flex justify-between text-[9px] text-slate-500 mt-0.5">
                              <span>0.20 (80% Upsets & Volatility)</span>
                              <span>0.45 (Realistic T20)</span>
                              <span>0.80 (80% Skill Anchor)</span>
                            </div>
                          </div>

                          {/* Slider 3: Minimum Player OVR (Min 60, Max 75) */}
                          <div className="pt-2 border-t border-white/[0.04]">
                            <div className="flex justify-between text-[11px] text-slate-300 mb-1">
                              <span>3. Minimum Player OVR:</span>
                              <span className="text-brand-gold font-bold">{minPlayerOvr} OVR</span>
                            </div>
                            <input
                              type="range"
                              min="60"
                              max="75"
                              step="1"
                              value={minPlayerOvr}
                              onChange={e => setMinPlayerOvr(parseInt(e.target.value, 10))}
                              className="w-full accent-brand-gold cursor-pointer"
                            />
                            <div className="flex justify-between text-[9px] text-slate-500 mt-0.5">
                              <span>60 (Full Pool ~560+ players)</span>
                              <span>68 (Balanced Tier)</span>
                              <span>75 (Galácticos Only)</span>
                            </div>
                          </div>

                          {/* Slider 4: Match Sim Alpha (α) - Controls Batting SR & Bowling Econ */}
                          <div className="pt-2 border-t border-white/[0.04]">
                            <div className="flex justify-between text-[11px] text-slate-300 mb-1">
                              <span>4. Match Sim Alpha (α):</span>
                              <span className="text-brand-gold font-bold">{simAlpha.toFixed(2)}</span>
                            </div>
                            <input
                              type="range"
                              min="0.5"
                              max="1.5"
                              step="0.05"
                              value={simAlpha}
                              onChange={e => setSimAlpha(parseFloat(e.target.value))}
                              className="w-full accent-brand-gold cursor-pointer"
                            />
                            <div className="flex justify-between text-[9px] text-slate-500 mt-0.5">
                              <span>0.50 (Low Scoring)</span>
                              <span>0.80 (Default T20)</span>
                              <span>1.00 (Standard)</span>
                              <span>1.50 (Runfest)</span>
                            </div>
                            <p className="text-[9px] text-slate-400 mt-1">
                              Batting SR (SR × α) &amp; Bowling Econ (Econ × (2 - α)). At 1.0 = baseline, 0.8 = 0.8× SR &amp; 1.2× Econ.
                            </p>
                          </div>

                          {/* Toggle: Competitive Counter-Bidding */}
                          <label className="flex items-center justify-between text-[11px] text-slate-300 pt-2 border-t border-white/[0.04] cursor-pointer">
                            <div>
                              <span>Competitive Counter-Bidding</span>
                              <p className="text-[9px] text-slate-500">AI pressures human bids on 80+ OVR lots</p>
                            </div>
                            <input
                              type="checkbox"
                              checked={humanTax}
                              onChange={e => setHumanTax(e.target.checked)}
                              className="accent-brand-gold w-4 h-4 cursor-pointer"
                            />
                          </label>
                        </div>
                      )}

                      {/* Saved Rooms List */}
                      <div>
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-2">
                          <span>SAVED ROOMS ({savedRooms.length}):</span>
                          <button
                            onClick={() => fetchSavedRooms(hostAuth.hostId, hostAuth.token)}
                            className="hover:text-slate-200 flex items-center gap-1"
                          >
                            <RotateCw className={`w-3 h-3 ${loadingRooms ? 'animate-spin' : ''}`} />
                            <span>Refresh</span>
                          </button>
                        </div>

                        {savedRooms.length === 0 ? (
                          <div className="p-4 rounded-xl bg-[#1C202E]/60 border border-white/[0.04] text-xs text-slate-500 text-center font-mono">
                            No saved rooms found. Create your first room above!
                          </div>
                        ) : (
                          <div className="space-y-1.5 max-h-[170px] overflow-y-auto pr-1">
                            {savedRooms.map(r => (
                              <div
                                key={r.roomCode}
                                className="p-2.5 rounded-xl bg-[#1C202E] border border-white/[0.06] flex items-center justify-between text-xs"
                              >
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono font-bold text-brand-gold">{r.roomCode}</span>
                                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-black/40 text-slate-400 font-mono">
                                      {r.status}
                                    </span>
                                  </div>
                                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                                    {r.completedLotsCount || 0} lots • {new Date(r.updatedAt).toLocaleTimeString()}
                                  </div>
                                </div>

                                <div className="flex items-center gap-1.5">
                                  <button
                                    onClick={() => {
                                      const cleanCode = r.roomCode.toUpperCase().trim();
                                      joinRoom(cleanCode, hostAuth.name || hostAuth.username, true);
                                      let target = '/lobby';
                                      if (r.status === 'SEASON') target = '/season';
                                      else if (r.status === 'AUCTION') target = '/auction';
                                      else if (r.status === 'WISHLIST') target = '/wishlist';
                                      else if (r.status === 'ANALYTICS') target = '/analytics';
                                      router.push(`${target}?room=${cleanCode}`);
                                    }}
                                    className="h-7 px-2.5 rounded-lg bg-[#2C3246] hover:bg-white/20 text-slate-200 text-xs transition-colors"
                                  >
                                    Resume
                                  </button>
                                  <button
                                    onClick={() => handleDeleteRoom(r.roomCode)}
                                    title="Delete Room"
                                    className="h-7 w-7 rounded-lg hover:bg-brand-rose/20 text-slate-500 hover:text-brand-rose flex items-center justify-center transition-colors"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="pt-3 border-t border-white/[0.06] text-[11px] text-slate-500 font-mono flex justify-between">
                      <span>CLOUD SYNC: <span className="text-brand-emerald">ACTIVE</span></span>
                      <span>AUTHENTICATED HOST</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer & Creator Attribution */}
      <footer className="mt-auto py-6 max-w-4xl mx-auto w-full border-t border-white/[0.06] text-center text-xs text-zinc-500 font-medium tracking-wide flex flex-col items-center gap-1.5">
        <div className="font-mono text-slate-500 text-[11px]">
          Official ₹125.00 Cr Purse • Real 2026 Squad Bounds • Live Multiplayer Engine
        </div>
        <div>
          Crafted with passion for IPL & Cricket by{' '}
          <span className="text-zinc-300 font-semibold hover:text-amber-400 transition-colors cursor-default">
            Soumajit
          </span>
        </div>
      </footer>
    </main>
  );
}

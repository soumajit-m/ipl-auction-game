'use client';

import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { SanitizeRoomDTO } from '@/types/auction.types';
import { Playing11Lineup } from '@/types/match.types';

export interface ClientSeat {
  teamId: string;
  teamName: string;
  isHuman: boolean;
  playerName: string;
  token?: string;
  connected?: boolean;
}

export interface HostAuth {
  hostId: string;
  username: string;
  token: string;
  email?: string;
  name?: string;
}

interface GameRoomStore {
  socket: Socket | null;
  connected: boolean;
  roomCode: string | null;
  playerName: string;
  deviceUUID: string;
  isHost: boolean;
  hostAuth: HostAuth | null;
  mySeat: ClientSeat | null;
  claimableSeats: ClientSeat[];
  roomState: SanitizeRoomDTO | null;
  errorMessage: string | null;
  saveStatus: { success: boolean; timestamp: number; message?: string } | null;

  initSocket: () => void;
  setHostAuth: (hostId: string, username: string, token: string, email?: string, name?: string) => void;
  logoutHost: () => void;
  joinRoom: (roomCode: string, playerName?: string, isHost?: boolean) => void;
  claimSeat: (teamId: string, playerName: string) => void;
  submitWishlist: (wishlistIds: string[]) => void;
  placeBid: (lotId: string, expectedPrice: number, bidAmount: number) => void;
  unskipAndBid: (lotId: string) => void;
  updateLiveFilter: (filterConfig: any) => void;
  toggleManualSkip: (teamId?: string, roomCode?: string) => void;
  hostAction: (action: 'START_AUCTION' | 'FORCE_SAVE' | 'TOGGLE_PAUSE' | 'TOGGLE_SPEED' | 'REPLACE_HUMAN_WITH_AI' | 'TOGGLE_AUTO_SKIP_AI' | 'NEXT_MATCH' | 'SIMULATE_ALL_MATCHES' | 'FORCE_SIMULATE' | 'SET_SIM_ALPHA', targetTeamId?: any) => void;
  setSimAlpha: (alpha: number) => void;
  sendMatchReady: () => void;
  simulateMatch: () => void;
  voteSimulate: () => void;
  forceSimulateMatch: () => void;
  joinOrSyncRoom: (roomCode: string) => void;
  skipAuctionDebug: () => void;
  voteSkipAuction: (agreed?: boolean) => void;
  voteSkipSet: (agreed?: boolean, teamId?: string, roomCode?: string) => void;
  updateLineup: (lineup: Playing11Lineup) => void;
  deleteSavedRoom: (roomCode: string) => Promise<boolean>;
  leaveRoom: () => void;
  clearError: () => void;
}

export function getOrCreateDeviceUUID(): string {
  if (typeof window === 'undefined') return 'server_uuid';
  let uuid = localStorage.getItem('ipl_device_uuid');
  if (!uuid) {
    uuid = 'dev_' + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
    localStorage.setItem('ipl_device_uuid', uuid);
  }
  return uuid;
}

function getSavedHostAuth(): HostAuth | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('ipl_host_auth');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function formatAuctionError(msg: string): string {
  if (!msg) return msg;
  if (msg.includes('SOLVENCY_RISK') || msg.includes('solvency') || msg.includes('Reserved')) {
    return 'Purse reserved: You must save budget to complete an 18-player squad.';
  }
  if (msg.includes('ROLE_SATURATED')) {
    return 'Squad full for this role.';
  }
  if (msg.includes('SOCKET_TIMEOUT')) {
    return 'Reconnecting to auction room...';
  }
  return msg;
}

export const useGameRoomStore = create<GameRoomStore>((set, get) => ({
  socket: null,
  connected: false,
  roomCode: null,
  playerName: '',
  deviceUUID: '',
  isHost: false,
  hostAuth: getSavedHostAuth(),
  mySeat: null,
  claimableSeats: [],
  roomState: null,
  errorMessage: null,
  saveStatus: null,

  initSocket: () => {
    if (get().socket) return;

    const deviceUUID = getOrCreateDeviceUUID();
    const wsUrl = typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3000');
    const socket = io(wsUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true
    });

    socket.on('connect', () => {
      set({ connected: true });
      const isHome = typeof window !== 'undefined' && window.location.pathname === '/';
      const activeCode = get().roomCode || (!isHome && typeof window !== 'undefined' ? localStorage.getItem('active_ipl_room_code') : null);
      if (activeCode) {
        socket.emit('room:join_or_sync', { roomCode: activeCode, deviceUUID });
      }
    });

    socket.on('disconnect', () => {
      set({ connected: false });
    });

    socket.on('room_update', (dto: SanitizeRoomDTO) => {
      const { hostAuth, isHost } = get();
      const recognizedAsHost = isHost || Boolean(dto.hostId && hostAuth?.hostId === dto.hostId);
      set({ roomState: dto, isHost: recognizedAsHost });
    });

    socket.on('seat_confirmed', (data: { seat: ClientSeat }) => {
      set({ mySeat: data.seat, claimableSeats: [] });
    });

    socket.on('claimable_seats', (data: { availableSeats: ClientSeat[] }) => {
      set({ claimableSeats: data.availableSeats });
    });

    socket.on('error_message', (data: { message: string }) => {
      set({ errorMessage: formatAuctionError(data.message) });
    });

    socket.on('bid_rejected', (data: { reason: string }) => {
      set({ errorMessage: formatAuctionError(data.reason) });
    });

    socket.on('save_status', (data: { success: boolean; timestamp: number; message?: string }) => {
      set({ saveStatus: data });
    });

    set({ socket, deviceUUID });
  },

  setHostAuth: (hostId: string, username: string, token: string, email?: string, name?: string) => {
    const auth: HostAuth = {
      hostId,
      username,
      token,
      email: email || (username.includes('@') ? username : undefined),
      name: name || (username.includes('@') ? username.split('@')[0] : username)
    };
    if (typeof window !== 'undefined') {
      localStorage.setItem('ipl_host_auth', JSON.stringify(auth));
    }
    set({ hostAuth: auth, isHost: true });
  },

  logoutHost: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('ipl_host_auth');
    }
    set({ hostAuth: null, isHost: false });
  },

  joinRoom: (roomCode: string, playerName?: string, isHost?: boolean) => {
    const { socket, deviceUUID, hostAuth } = get();
    if (!socket) return;

    const code = roomCode.toUpperCase().trim();
    if (typeof window !== 'undefined') {
      localStorage.setItem('active_ipl_room_code', code);
    }
    set({
      roomCode: code,
      playerName: playerName || '',
      isHost: Boolean(isHost),
      roomState: null,
      mySeat: null,
      claimableSeats: []
    });

    socket.emit('join_room', {
      roomCode: code,
      playerName: playerName?.trim(),
      deviceUUID,
      isHost: Boolean(isHost),
      token: hostAuth?.token
    });
  },

  claimSeat: (teamId: string, playerName: string) => {
    const { socket, roomCode, deviceUUID } = get();
    if (!socket || !roomCode) return;

    socket.emit('claim_seat', {
      roomCode,
      teamId,
      playerName: playerName.trim(),
      deviceUUID
    });
  },

  submitWishlist: (wishlistIds: string[]) => {
    const { socket } = get();
    if (!socket) return;
    socket.emit('submit_wishlist', { wishlistIds });
  },

  placeBid: (lotId: string, expectedPrice: number, bidAmount: number) => {
    const { socket, roomCode } = get();
    if (!socket) return;
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    socket.emit('place_bid', { lotId, expectedPrice, bidAmount, roomCode: activeCode });
  },

  unskipAndBid: (lotId: string) => {
    const { socket } = get();
    if (!socket) return;
    socket.emit('unskip_and_bid', { lotId });
  },

  updateLiveFilter: (filterConfig: any) => {
    const { socket } = get();
    if (!socket) return;
    socket.emit('update_live_filter', { filterConfig });
  },

  toggleManualSkip: (teamId?: string, roomCode?: string) => {
    const { socket, mySeat, roomCode: storeRoomCode } = get();
    if (!socket) return;
    const activeCode = (roomCode || storeRoomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    const activeTeamId = teamId || mySeat?.teamId || (typeof window !== 'undefined' ? localStorage.getItem('ipl_claimed_team_id') : null);
    socket.emit('toggle_manual_skip', { teamId: activeTeamId, roomCode: activeCode });
  },

  hostAction: (action, targetTeamId) => {
    const { socket, roomCode, roomState } = get();
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    if (action === 'TOGGLE_SPEED' && roomState) {
      const nextSpeed = (roomState as any).auctionSpeedMultiplier === 5 ? 1 : 5;
      set({ roomState: { ...roomState, auctionSpeedMultiplier: nextSpeed } as any });
    }
    if (action === 'TOGGLE_PAUSE' && roomState) {
      const nextPaused = !(roomState as any).isPaused;
      set({ roomState: { ...roomState, isPaused: nextPaused } as any });
    }
    if (!socket) return;
    socket.emit('host_action', { action, targetTeamId, roomCode: activeCode });
  },

  setSimAlpha: (alpha: number) => {
    const { socket, roomCode, roomState } = get();
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    if (roomState && (roomState as any).season) {
      set({ roomState: { ...roomState, season: { ...(roomState as any).season, simAlpha: alpha } } as any });
    }
    if (!socket) return;
    socket.emit('set_sim_alpha', { alpha, roomCode: activeCode });
    socket.emit('host_action', { action: 'SET_SIM_ALPHA', alpha, roomCode: activeCode });
  },

  sendMatchReady: () => {
    const { socket, roomCode } = get();
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    if (!socket) return;
    socket.emit('match_ready', { roomCode: activeCode });
  },

  simulateMatch: () => {
    const { socket, roomCode, hostAuth } = get();
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    if (!socket) return;
    socket.emit('simulate_match', { roomCode: activeCode, hostId: hostAuth?.hostId });
  },

  voteSimulate: () => {
    const { socket, roomCode } = get();
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    if (!socket) return;
    socket.emit('vote_simulate', { roomCode: activeCode });
  },

  forceSimulateMatch: () => {
    const { socket, roomCode, hostAuth } = get();
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    if (!socket) return;
    socket.emit('force_simulate_match', { roomCode: activeCode, hostId: hostAuth?.hostId });
  },

  joinOrSyncRoom: (roomCode: string) => {
    const { initSocket, isHost, hostAuth } = get();
    initSocket();
    const curSocket = get().socket;
    const deviceUUID = getOrCreateDeviceUUID();
    const cleanCode = (roomCode || '').toUpperCase().trim();
    if (typeof window !== 'undefined') {
      localStorage.setItem('active_ipl_room_code', cleanCode);
    }
    set({ roomCode: cleanCode, deviceUUID });
    if (curSocket) {
      curSocket.emit('room:join_or_sync', {
        roomCode: cleanCode,
        deviceUUID,
        isHost: isHost || Boolean(hostAuth?.token),
        token: hostAuth?.token,
        hostId: hostAuth?.hostId
      });
    }
  },

  skipAuctionDebug: () => {
    const { socket, roomCode } = get();
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    if (!socket || !activeCode) return;
    socket.emit('debug:skip_auction', { roomCode: activeCode });
  },

  voteSkipAuction: (agreed: boolean = true) => {
    const { socket, roomCode } = get();
    if (!socket) return;
    const activeCode = (roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    socket.emit('vote_skip_auction', { agreed, roomCode: activeCode });
  },

  voteSkipSet: (agreed?: boolean, teamId?: string, roomCode?: string) => {
    const { socket, mySeat, roomCode: storeRoomCode } = get();
    if (!socket) return;
    const activeCode = (roomCode || storeRoomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null) || '').toUpperCase().trim();
    const activeTeamId = teamId || mySeat?.teamId || (typeof window !== 'undefined' ? localStorage.getItem('ipl_claimed_team_id') : null);
    socket.emit('vote_skip_set', { agreed, teamId: activeTeamId, roomCode: activeCode });
  },

  updateLineup: (lineup: Playing11Lineup) => {
    const { socket, roomCode, roomState } = get();
    const activeCode = roomCode || (typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('room') || localStorage.getItem('active_ipl_room_code')) : null);

    // Optimistically update local roomState
    if (roomState && (roomState as any).season) {
      const curSeason = (roomState as any).season;
      const updatedSeason = {
        ...curSeason,
        lineups: {
          ...(curSeason.lineups || {}),
          [lineup.teamId]: lineup
        }
      };
      set({ roomState: { ...roomState, season: updatedSeason } as any });
    }

    if (!socket) return;
    socket.emit('update_lineup', { lineup, roomCode: activeCode });
  },

  deleteSavedRoom: async (targetRoomCode: string): Promise<boolean> => {
    const { hostAuth } = get();
    try {
      const headers: Record<string, string> = {};
      if (hostAuth?.token) {
        headers['Authorization'] = `Bearer ${hostAuth.token}`;
      }
      const res = await fetch(`/api/rooms/${targetRoomCode}?hostId=${hostAuth?.hostId || ''}`, {
        method: 'DELETE',
        headers
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  },

  leaveRoom: () => {
    const { socket, roomCode, deviceUUID } = get();
    if (socket && roomCode) {
      socket.emit('leave_room', { roomCode, deviceUUID });
    }
    if (typeof window !== 'undefined') {
      localStorage.removeItem('active_ipl_room_code');
      localStorage.removeItem('ipl_claimed_team_id');
      sessionStorage.removeItem('active_ipl_room_code');
      sessionStorage.removeItem('ipl_claimed_team_id');
    }
    set({
      roomCode: null,
      roomState: null,
      mySeat: null,
      claimableSeats: [],
      errorMessage: null,
      saveStatus: null
    });
  },

  clearError: () => set({ errorMessage: null })
}));

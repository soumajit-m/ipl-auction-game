/**
 * socketHub.ts - Authoritative WebSocket Multiplayer Engine & State Machine
 * Manages Map<roomCode, RoomState> in RAM for <0.2ms O(1) live bidding and 7-second MongoDB persistence.
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import * as crypto from 'crypto';
import { IPLPlayer, PrimaryRole } from '../types/player.types';
import {
  TeamAuctionState,
  AuctionLot,
  BiddingMode,
  AuctionPhase,
  SanitizeRoomDTO,
  BidEntry
} from '../types/auction.types';
import {
  MatchResult,
  TeamStanding,
  Playing11Lineup,
  SeasonState
} from '../types/match.types';
import { AuctionBidderAI, DEFAULT_IPL_FRANCHISES, getNextBidIncrement, getAcceleratedBasePrice } from './auction/bidderAI';
import { TeamMaker, validate352Lineup } from './match/teamMaker';
import { FullMatchSimulator, Team2026 } from './match/fullMatchSimulator';
import { GameRoom } from '../lib/mongodb';
import { env } from '../lib/env';

export interface RoomSeat {
  teamId: string;
  teamName: string;
  isHuman: boolean;
  playerName: string;
  socketId: string | null;
  ipHash: string;
  deviceUUID: string;
  token: string;
  connected: boolean;
  lastDeviceUUID?: string;
  lastPlayerName?: string;
}

export interface InternalRoomState {
  roomCode: string;
  hostId: string;
  hostUsername: string;
  hostSocketId: string | null;
  status: 'LOBBY' | 'WISHLIST' | 'AUCTION' | 'ANALYTICS' | 'SEASON';
  phase: AuctionPhase;
  determinismRatio: number;
  aiAggression?: number;
  humanTaxEnabled: boolean;
  acceleratedRoundMode: '1-ACC' | '2-ACC';
  isPaused: boolean;
  isDirty: boolean;
  lastSavedAt: number;
  seats: RoomSeat[];
  teams: Record<string, TeamAuctionState>;
  allPlayers: IPLPlayer[];
  lotQueue: IPLPlayer[];
  currentLot: AuctionLot | null;
  completedLots: Array<{ player: IPLPlayer; soldPrice: number | null; soldTo: string | null }>;
  lastResolvedLot?: { player: IPLPlayer; sold: boolean; winningPrice?: number; winningFranchiseId?: string } | null;
  wishlistTimer: {
    msRemaining: number;
    totalMs: number;
    submittedTeamIds: string[];
  };
  wishlistEndsAt?: number;
  humanSkipCooldowns: Record<string, number>; // teamId -> timestamp
  humanFilterConfigs: Record<string, any>;   // teamId -> filter options
  commentaryTicker: string[];
  season: SeasonState | null;
  skipVotes?: Set<string>;
  setSkipVotes?: Set<string>;
  lastSetSummary?: string | null;
  speedMultiplier: number;
  isAdvancingMatch?: boolean;
  // Internal clock interval references
  lotClockInterval?: NodeJS.Timeout | null;
  wishlistClockInterval?: NodeJS.Timeout | null;
  seasonClockInterval?: NodeJS.Timeout | null;
  aiBidTimeouts: NodeJS.Timeout[];
}

/**
 * Exact Human Purse Reservation Rule (FIX 5):
 * 6 slots @ 0.50 Cr + 12 slots @ 0.30 Cr = 6.60 Cr max reserve to guarantee legal 18-man squad
 */
export function getHumanMinPurseReserve(currentSquadCount: number): number {
  if (currentSquadCount >= 18) return 0.00;
  if (currentSquadCount <= 12) {
    return Number((6.60 - currentSquadCount * 0.30).toFixed(2));
  }
  return Number(((18 - currentSquadCount) * 0.50).toFixed(2));
}

export class SocketHub {
  private io: SocketIOServer;
  public rooms: Map<string, InternalRoomState> = new Map();
  public bidderAI: AuctionBidderAI;
  public matchSimulator: FullMatchSimulator;
  private autoSaveTimer?: NodeJS.Timeout;
  private allPlayers: IPLPlayer[] = [];

  constructor(io: SocketIOServer, allPlayers: IPLPlayer[]) {
    this.io = io;
    this.allPlayers = allPlayers;
    this.bidderAI = new AuctionBidderAI();
    this.matchSimulator = new FullMatchSimulator();
    this.initAI();
    this.start7SecondAutoSaveLoop();
  }

  private async initAI() {
    await this.bidderAI.initModel();
    await this.matchSimulator.init();
  }

  public generateGuestToken(roomCode: string, teamId: string, playerName: string, ipHash: string, deviceUUID: string): string {
    return crypto.createHmac('sha256', env.JWT_SECRET)
      .update(`${roomCode}:${teamId}:${playerName}:${ipHash}:${deviceUUID}`)
      .digest('hex');
  }

  public hashIP(ip: string): string {
    return crypto.createHash('sha256').update(ip + env.JWT_SECRET).digest('hex').slice(0, 16);
  }

  public getRoom(roomCode?: string): InternalRoomState | undefined {
    if (roomCode) {
      const clean = roomCode.toUpperCase().trim();
      let room = this.rooms.get(clean);
      if (room) return room;
      room = Array.from(this.rooms.values()).find(rm => rm.roomCode.toUpperCase() === clean);
      if (room) return room;
      return undefined;
    }
    // Fallback: If no roomCode was provided and only 1 room is loaded in memory
    if (this.rooms.size === 1) {
      return Array.from(this.rooms.values())[0];
    }
    return undefined;
  }

  public createRoom(
    roomCode: string,
    hostId: string,
    allPlayers: IPLPlayer[],
    determinismRatio: number = 0.45,
    humanTaxEnabled: boolean = true,
    hostUsername: string = 'admin',
    aiAggression: number = 0.45
  ): InternalRoomState {
    this.bidderAI.config.determinismRatio = aiAggression;
    this.bidderAI.config.humanTaxEnabled = humanTaxEnabled;
    const teams = this.bidderAI.initializeTeams(roomCode, allPlayers);
    const seats: RoomSeat[] = DEFAULT_IPL_FRANCHISES.map(p => ({
      teamId: p.id,
      teamName: p.name,
      isHuman: false,
      playerName: 'AI Manager',
      socketId: null,
      ipHash: '',
      deviceUUID: '',
      token: '',
      connected: false
    }));

    // Organize Lot Queue by IPL Sets: Sets appear in strict sequential order (Set 1, Set 2, ... Set 9),
    // but within each set, the individual players are shuffled randomly (Fisher-Yates).
    const setsMap = new Map<number, IPLPlayer[]>();
    for (const player of allPlayers) {
      const setNum = player.marqueeSet || 9;
      if (!setsMap.has(setNum)) setsMap.set(setNum, []);
      setsMap.get(setNum)!.push(player);
    }

    const sortedSetNums = Array.from(setsMap.keys()).sort((a, b) => a - b);
    const orderedLotQueue: IPLPlayer[] = [];
    for (const setNum of sortedSetNums) {
      const setPlayers = [...setsMap.get(setNum)!];
      for (let i = setPlayers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [setPlayers[i], setPlayers[j]] = [setPlayers[j], setPlayers[i]];
      }
      orderedLotQueue.push(...setPlayers);
    }

    const room: InternalRoomState = {
      roomCode,
      hostId,
      hostUsername,
      hostSocketId: null,
      status: 'LOBBY',
      phase: 'MAIN',
      determinismRatio,
      aiAggression,
      humanTaxEnabled,
      acceleratedRoundMode: '1-ACC',
      isPaused: false,
      isDirty: true,
      lastSavedAt: Date.now(),
      seats,
      teams,
      allPlayers: [...allPlayers],
      lotQueue: orderedLotQueue,
      currentLot: null,
      completedLots: [],
      lastResolvedLot: null,
      wishlistTimer: {
        msRemaining: 180000, // 3:00 minutes
        totalMs: 180000,
        submittedTeamIds: []
      },
      humanSkipCooldowns: {},
      humanFilterConfigs: {},
      commentaryTicker: [`Room ${roomCode} created. Welcome to IPL Auction & Manager 2026.`],
      season: null,
      setSkipVotes: new Set<string>(),
      lastSetSummary: null,
      speedMultiplier: 1,
      aiBidTimeouts: []
    };

    this.rooms.set(roomCode, room);
    this.flushRoomToMongoDB(room);
    return room;
  }

  public async restoreRoomFromDB(roomCode: string): Promise<InternalRoomState | null> {
    try {
      const mongoose = await import('mongoose');
      let isDbConnected = mongoose.default.connection.readyState === 1;
      if (!isDbConnected) {
        const { connectToDatabase } = await import('../lib/mongodb');
        await connectToDatabase();
        isDbConnected = mongoose.default.connection.readyState === 1;
      }
      if (!isDbConnected) return null;

      const doc = await GameRoom.findOne({ roomCode: roomCode.toUpperCase().trim() });
      if (!doc) return null;

      const assignedPlayerIds = new Set<string>();
      for (const team of Object.values(doc.teams || {})) {
        for (const p of (team as any).squad || []) {
          assignedPlayerIds.add(p.id);
        }
      }
      for (const cl of (doc.completedLots || []) as any[]) {
        if (cl.player?.id) assignedPlayerIds.add(cl.player.id);
      }

      // Group remaining players by set and shuffle
      const remainingPlayers = this.allPlayers.filter(p => !assignedPlayerIds.has(p.id));
      const setsMap = new Map<number, IPLPlayer[]>();
      for (const player of remainingPlayers) {
        const setNum = player.marqueeSet || 9;
        if (!setsMap.has(setNum)) setsMap.set(setNum, []);
        setsMap.get(setNum)!.push(player);
      }
      const sortedSetNums = Array.from(setsMap.keys()).sort((a, b) => a - b);
      const orderedLotQueue: IPLPlayer[] = [];
      for (const setNum of sortedSetNums) {
        const setPlayers = [...setsMap.get(setNum)!];
        for (let i = setPlayers.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [setPlayers[i], setPlayers[j]] = [setPlayers[j], setPlayers[i]];
        }
        orderedLotQueue.push(...setPlayers);
      }

      const room: InternalRoomState = {
        roomCode: doc.roomCode,
        hostId: doc.hostId,
        hostUsername: doc.hostUsername || 'admin',
        hostSocketId: null,
        status: doc.status as any,
        phase: (doc.phase as any) || 'MAIN',
        determinismRatio: doc.determinismRatio ?? 0.45,
        humanTaxEnabled: doc.humanTaxEnabled ?? true,
        acceleratedRoundMode: (doc.acceleratedRoundMode as any) || '1-ACC',
        isPaused: doc.isPaused ?? false,
        isDirty: false,
        lastSavedAt: Date.now(),
        seats: doc.seats || [],
        teams: doc.teams || {},
        allPlayers: [...this.allPlayers],
        lotQueue: orderedLotQueue,
        currentLot: null,
        completedLots: doc.completedLots || [],
        lastResolvedLot: null,
        wishlistTimer: {
          msRemaining: 0,
          totalMs: 180000,
          submittedTeamIds: []
        },
        humanSkipCooldowns: {},
        humanFilterConfigs: {},
        commentaryTicker: [`Room ${doc.roomCode} restored from MongoDB cloud save.`],
        season: null,
        setSkipVotes: new Set<string>(),
        lastSetSummary: null,
        speedMultiplier: (doc as any).speedMultiplier || 1,
        aiBidTimeouts: []
      };

      if (room.status === 'SEASON') {
        if (doc.season && doc.season.fixtures && doc.season.fixtures.length > 0) {
          room.season = doc.season;
          this.startSeasonClock(room);
        } else {
          this.initSeason(room);
        }
      }

      this.rooms.set(room.roomCode, room);
      return room;
    } catch (e) {
      console.warn(`[SocketHub] Failed to restore room ${roomCode} from DB:`, (e as Error).message);
      return null;
    }
  }

  public handleConnection(socket: Socket) {
    const clientIP = (socket.handshake.headers['x-forwarded-for'] as string) || socket.handshake.address || '127.0.0.1';
    const ipHash = this.hashIP(clientIP);

    // ==========================================
    // 1. JOIN ROOM & SEAT BINDING
    // ==========================================
    socket.on('join_room', async (data: { roomCode: string; playerName?: string; deviceUUID?: string; isHost?: boolean; token?: string }) => {
      const { roomCode, playerName, deviceUUID = 'uuid_default', isHost = false } = data;
      let room = this.getRoom(roomCode);
      if (!room && roomCode) {
        room = (await this.restoreRoomFromDB(roomCode.toUpperCase().trim())) || undefined;
      }

      if (!room) {
        socket.emit('error_message', { message: `Room ${roomCode} not found.` });
        return;
      }

      const cleanCode = room.roomCode.toUpperCase().trim();
      socket.join(cleanCode);
      socket.join(cleanCode.toLowerCase());
      socket.data.roomCode = cleanCode;
      socket.data.ipHash = ipHash;
      socket.data.deviceUUID = deviceUUID;

      if (isHost) {
        socket.data.isHost = true;
        room.hostSocketId = socket.id;
        if (room.status === 'SEASON' && !room.seasonClockInterval) {
          this.startSeasonClock(room);
        }
        socket.emit('host_registered', { roomCode });
        this.broadcastRoomState(roomCode);
        return;
      }

      // Guest seat matching or reconnection
      let matchedSeat = room.seats.find(s => s.isHuman && s.deviceUUID === deviceUUID && s.playerName === playerName);
      if (!matchedSeat && playerName) {
        // Fallback match on name + IP
        matchedSeat = room.seats.find(s => s.isHuman && s.playerName === playerName && s.ipHash === ipHash);
      }
      if (!matchedSeat && deviceUUID) {
        // Reconnection for seat previously taken over by AI
        matchedSeat = room.seats.find(s => s.lastDeviceUUID === deviceUUID);
        if (matchedSeat) {
          matchedSeat.isHuman = true;
          matchedSeat.playerName = matchedSeat.lastPlayerName || playerName || 'Manager';
          matchedSeat.deviceUUID = deviceUUID;
          const team = room.teams[matchedSeat.teamId];
          if (team) {
            team.isHuman = true;
            team.ownerName = matchedSeat.playerName;
            team.connected = true;
          }
          this.pushCommentary(room, `${matchedSeat.playerName} rejoined and resumed control of ${matchedSeat.teamName}!`);
        }
      }

      if (matchedSeat) {
        // Re-bind disconnected human
        matchedSeat.socketId = socket.id;
        matchedSeat.connected = true;
        matchedSeat.token = this.generateGuestToken(roomCode, matchedSeat.teamId, matchedSeat.playerName, ipHash, deviceUUID);
        socket.data.teamId = matchedSeat.teamId;
        socket.data.playerName = matchedSeat.playerName;

        const team = room.teams[matchedSeat.teamId];
        if (team) team.connected = true;

        // If room was paused due to this human disconnect, check if all humans back
        if (room.isPaused) {
          const anyHumanDisconnected = room.seats.some(s => s.isHuman && !s.connected);
          if (!anyHumanDisconnected) {
            room.isPaused = false;
            this.pushCommentary(room, `${matchedSeat.playerName} reconnected to ${matchedSeat.teamName}. Game resumed.`);
          }
        }

        socket.emit('seat_confirmed', { seat: matchedSeat });
        this.broadcastRoomState(roomCode);
      } else {
        // Unclaimed AI franchise picker
        const availableSeats = room.seats.filter(s => !s.isHuman);
        socket.emit('claimable_seats', { availableSeats });
      }
    });

    // ==========================================
    // 2. CLAIM SEAT (Guest chooses AI franchise)
    // Enforcing strict invariant: 1 Human = Maximum 1 Franchise
    // ==========================================
    const handleClaimFranchise = (data: { roomCode: string; teamId: string; playerName: string; deviceUUID: string }) => {
      const { roomCode, teamId, playerName, deviceUUID } = data;
      const room = this.rooms.get(roomCode);
      if (!room) return;

      const seat = room.seats.find(s => s.teamId === teamId);
      if (!seat) {
        socket.emit('error_message', { message: 'Franchise unavailable.' });
        return;
      }

      // If user is already on this team, nothing to change
      if (seat.isHuman && (seat.socketId === socket.id || (deviceUUID && seat.deviceUUID === deviceUUID))) {
        return;
      }

      // If team is already claimed by another human
      if (seat.isHuman && seat.socketId !== socket.id && (!deviceUUID || seat.deviceUUID !== deviceUUID)) {
        socket.emit('error_message', { message: 'Franchise already claimed by another manager.' });
        return;
      }

      // 1 Human (deviceUUID / socket / name) = Maximum 1 Franchise per room
      // Release any other franchise previously controlled by this human back to AI
      for (const otherSeat of room.seats) {
        if (otherSeat.teamId === teamId) continue;
        const isSameHuman = (deviceUUID && otherSeat.deviceUUID === deviceUUID) ||
                            (otherSeat.socketId && otherSeat.socketId === socket.id) ||
                            (playerName && otherSeat.playerName === playerName && otherSeat.isHuman);

        if (otherSeat.isHuman && isSameHuman) {
          otherSeat.isHuman = false;
          otherSeat.playerName = 'AI Manager';
          otherSeat.deviceUUID = '';
          otherSeat.socketId = null;
          otherSeat.connected = true;
          otherSeat.token = '';

          const oldTeam = room.teams[otherSeat.teamId];
          if (oldTeam) {
            oldTeam.isHuman = false;
            oldTeam.ownerName = 'AI Manager';
            oldTeam.connected = true;
          }
          this.pushCommentary(room, `${playerName} switched to ${seat.teamName} (released ${otherSeat.teamName} to AI).`);
        }
      }

      seat.isHuman = true;
      seat.playerName = playerName.slice(0, 20);
      seat.deviceUUID = deviceUUID;
      seat.ipHash = ipHash;
      seat.socketId = socket.id;
      seat.connected = true;
      seat.token = this.generateGuestToken(roomCode, teamId, seat.playerName, ipHash, deviceUUID);

      const team = room.teams[teamId];
      if (team) {
        team.isHuman = true;
        team.ownerName = seat.playerName;
        team.connected = true;
      }

      socket.data.teamId = teamId;
      socket.data.playerName = seat.playerName;
      room.isDirty = true;

      this.pushCommentary(room, `${seat.playerName} took ownership of ${seat.teamName}.`);
      socket.emit('seat_confirmed', { seat });
      this.broadcastRoomState(roomCode);
    };

    socket.on('claim_seat', handleClaimFranchise);
    socket.on('claim_team', handleClaimFranchise);
    socket.on('select_franchise', handleClaimFranchise);

    // ==========================================
    // 3. WISHLIST SUBMISSION (Screen 2) - Unlimited Human Ticks
    // ==========================================
    socket.on('submit_wishlist', (data: { wishlistIds: string[] }) => {
      const room = this.rooms.get(socket.data.roomCode);
      const teamId = socket.data.teamId;
      if (!room || !teamId || room.status !== 'WISHLIST') return;

      const team = room.teams[teamId];
      if (team) {
        // Unlimited human ticks - no 30-player cap for human managers
        team.wishlistIds = Array.isArray(data.wishlistIds) ? data.wishlistIds : [];
      }

      if (!room.wishlistTimer.submittedTeamIds.includes(teamId)) {
        room.wishlistTimer.submittedTeamIds.push(teamId);
      }

      room.isDirty = true;

      // Auto-start immediately if all human managers have locked their wishlists
      const totalHumans = room.seats.filter(s => s.isHuman).length;
      if (totalHumans > 0 && room.wishlistTimer.submittedTeamIds.length >= totalHumans) {
        this.pushCommentary(room, 'All human managers locked their wishlists! Auto-starting auction immediately...');
        this.startAuctionPhaseImmediately(room);
        return;
      }

      this.broadcastRoomState(room.roomCode);
    });

    // ==========================================
    // 4. AUCTION BIDDING (Screen 3)
    // ==========================================
    socket.on('place_bid', (data: { lotId: string; expectedPrice: number; bidAmount: number; roomCode?: string }) => {
      const room = this.getRoom(data?.roomCode || socket.data.roomCode);
      const teamId = socket.data.teamId || (room?.seats.find(s => s.socketId === socket.id)?.teamId) || Object.values(room?.teams || {}).find(t => t.isHuman)?.franchiseId;
      if (!room || !teamId || room.status !== 'AUCTION' || room.isPaused) return;

      const lot = room.currentLot;
      if (!lot || lot.lotId !== data.lotId || lot.state !== 'OPEN') return;

      // Latency-Buffered Server Cutoff (5.0s window + 200ms grace)
      if (lot.timerMs < -200) {
        socket.emit('bid_rejected', { reason: 'Bidding has concluded for this lot.' });
        return;
      }

      // Self-outbid prevention: Cannot bid against oneself
      if (lot.currentBidder === teamId) {
        socket.emit('bid_rejected', { reason: 'You already hold the highest bid.' });
        return;
      }

      // Optimistic concurrency check
      if (Math.abs(lot.currentPrice - data.expectedPrice) > 0.01) {
        socket.emit('bid_rejected', { reason: 'Price updated by another bidder. Please retry.' });
        return;
      }

      const team = room.teams[teamId];
      if (!team) return;

      // FIX 5: Human Bids are NEVER subject to AI Valuation Ceilings
      // Constrained strictly by squad capacity, overseas cap, and the 6.60 Cr squad reserve rule
      const squadCount = team.squad.length;
      if (squadCount >= 25) {
        socket.emit('bid_rejected', { reason: 'Squad is full (maximum 25 players).' });
        return;
      }

      if (lot.player.isOverseas) {
        const overseasCount = team.squad.filter(p => p.isOverseas).length;
        if (overseasCount >= 8) {
          socket.emit('bid_rejected', { reason: 'Overseas limit reached (maximum 8 overseas players).' });
          return;
        }
      }

      // Dynamic Bid Increment Formula: min((2 ** floor(current_bid / 5)) * 0.25, 1.0) Cr
      const inc = lot.currentBidder ? getNextBidIncrement(lot.currentPrice) : 0.0;
      const expectedNext = Math.round((lot.currentPrice + inc) * 100) / 100;
      const nextPrice = (data.bidAmount && data.bidAmount > lot.currentPrice) ? data.bidAmount : expectedNext;
      const minReserve = getHumanMinPurseReserve(squadCount);
      const maxAllowedBid = Number((team.purse - minReserve).toFixed(2));

      if (nextPrice > maxAllowedBid) {
        socket.emit('bid_rejected', {
          reason: `Bid ₹${nextPrice.toFixed(2)} Cr exceeds max allowed bid ₹${maxAllowedBid.toFixed(2)} Cr (Reserved ₹${minReserve.toFixed(2)} Cr for remaining 18-man squad slots).`
        });
        return;
      }

      // Accept bid
      this.clearAIBidTimeouts(room);
      const prevPrice = lot.currentPrice;
      const prevBidder = lot.currentBidder ? room.teams[lot.currentBidder]?.name : null;
      lot.currentPrice = nextPrice;
      lot.currentBidder = teamId;
      lot.currentBidderName = team.name;
      lot.biddingMode = 'MODE_B'; // Force Mode B live clock
      lot.timerMs = room.speedMultiplier === 5 ? 1000 : 5000;
      lot.bidHistory.push({
        bidderId: teamId,
        bidderName: `${team.name} (Human - ${team.ownerName})`,
        amount: nextPrice,
        timestamp: Date.now()
      });

      // Bidding War Escalation Milestones: ₹5 Cr, ₹10 Cr, ₹15 Cr, ₹20+ Cr
      if (nextPrice >= 20.0 && prevPrice < 20.0 && prevBidder) {
        this.pushCommentary(room, `🔥 "₹${nextPrice.toFixed(2)} Cr! ${team.name} and ${prevBidder} locked in a historic blockbuster bidding war!"`);
      } else if (nextPrice >= 15.0 && prevPrice < 15.0 && prevBidder) {
        this.pushCommentary(room, `⚡ "₹${nextPrice.toFixed(2)} Cr! ${team.name} and ${prevBidder} locked in a fierce tug-of-war for this match-winner!"`);
      } else if (nextPrice >= 10.0 && prevPrice < 10.0 && prevBidder) {
        this.pushCommentary(room, `💥 "Eight figures crossed! ₹${nextPrice.toFixed(2)} Cr on the board as ${team.name} counters ${prevBidder}!"`);
      } else if (nextPrice >= 5.0 && prevPrice < 5.0 && prevBidder) {
        this.pushCommentary(room, `📈 "Bidding surges past ₹5.00 Cr! ${team.name} raises the stakes!"`);
      } else {
        this.pushCommentary(room, `[BID] ${team.name} bid ₹${nextPrice.toFixed(2)} Cr for ${lot.player.name}`);
      }

      room.isDirty = true;
      this.broadcastRoomState(room.roomCode);

      // Restart lot clock for full window
      this.startLotClock(room);

      // Trigger AI counter-bids after reaction delay
      this.scheduleAICounterBids(room);
    });

    // ==========================================
    // 5. HUMAN UNSKIP & BID (Mode A -> Mode B Interruption)
    // ==========================================
    socket.on('unskip_and_bid', (data: { lotId: string }) => {
      const room = this.rooms.get(socket.data.roomCode);
      const teamId = socket.data.teamId;
      if (!room || !teamId || room.status !== 'AUCTION' || room.isPaused) return;

      const now = Date.now();
      const lastCd = room.humanSkipCooldowns[teamId] || 0;
      if (now - lastCd < 1500) {
        socket.emit('bid_rejected', { reason: 'Cooldown active (1.5s between unskip toggles).' });
        return;
      }
      room.humanSkipCooldowns[teamId] = now;

      const lot = room.currentLot;
      if (!lot || lot.lotId !== data.lotId || lot.state !== 'OPEN') return;

      const team = room.teams[teamId];
      if (!team) return;

      const squadCount = team.squad.length;
      if (squadCount >= 25) {
        socket.emit('bid_rejected', { reason: 'Squad full (maximum 25 players).' });
        return;
      }

      if (lot.player.isOverseas && team.squad.filter(p => p.isOverseas).length >= 8) {
        socket.emit('bid_rejected', { reason: 'Overseas limit reached (maximum 8 overseas players).' });
        return;
      }

      const minReserve = getHumanMinPurseReserve(squadCount);
      const maxAllowedBid = Number((team.purse - minReserve).toFixed(2));
      if (lot.player.basePrice > maxAllowedBid) {
        socket.emit('bid_rejected', {
          reason: `Base price ₹${lot.player.basePrice.toFixed(2)} Cr exceeds max allowed bid ₹${maxAllowedBid.toFixed(2)} Cr (Reserved ₹${minReserve.toFixed(2)} Cr for remaining squad slots).`
        });
        return;
      }

      // Discard provisional Mode A outcome and transition to Mode B Live
      this.clearAIBidTimeouts(room);
      lot.biddingMode = 'MODE_B';
      lot.currentPrice = lot.player.basePrice;
      lot.currentBidder = teamId;
      lot.currentBidderName = team.name;
      lot.timerMs = room.speedMultiplier === 5 ? 1000 : 5000;
      lot.bidHistory.push({
        bidderId: teamId,
        bidderName: `${team.name} (Human - ${team.ownerName})`,
        amount: lot.currentPrice,
        timestamp: Date.now()
      });

      this.pushCommentary(room, `[UNSKIP] ${team.name} jumped in with opening bid of ₹${lot.currentPrice.toFixed(2)} Cr!`);
      room.isDirty = true;
      this.broadcastRoomState(room.roomCode);

      this.scheduleAICounterBids(room);
    });

    // ==========================================
    // LIVE SKIP FILTERS & MANUAL SKIP TOGGLES
    // ==========================================
    socket.on('update_live_filter', (data: { filterConfig: any }) => {
      const room = this.rooms.get(socket.data.roomCode);
      const teamId = socket.data.teamId;
      if (!room || !teamId) return;

      room.humanFilterConfigs[teamId] = data.filterConfig;
      room.isDirty = true;
    });

    socket.on('toggle_manual_skip', (data?: { teamId?: string; roomCode?: string }) => {
      const room = this.getRoom(data?.roomCode || socket.data.roomCode);
      if (!room || !room.currentLot) return;

      const teamId = data?.teamId || socket.data.teamId || room.seats.find(s => s.socketId === socket.id)?.teamId || Object.values(room.teams).find(t => t.isHuman)?.franchiseId;
      if (!teamId) return;

      const team = room.teams[teamId];
      if (team) {
        const playerId = room.currentLot.player.id;
        if (!team.skipLotIds) team.skipLotIds = [];
        if (!team.skipLotIds.includes(playerId)) {
          team.skipLotIds.push(playerId);
        }
      }

      // Check if all active humans in the room have skipped this lot
      const activeHumanSeats = room.seats.filter(s => s.isHuman && s.connected);
      const allHumansHaveSkipped = activeHumanSeats.length <= 1 || activeHumanSeats.every(s => {
        const hTeam = room.teams[s.teamId];
        return hTeam && hTeam.skipLotIds && hTeam.skipLotIds.includes(room.currentLot!.player.id);
      });

      const lot = room.currentLot;
      if (lot && lot.state === 'OPEN') {
        if (allHumansHaveSkipped) {
          this.clearAIBidTimeouts(room);
          if (room.lotClockInterval) {
            clearInterval(room.lotClockInterval);
            room.lotClockInterval = null;
          }

          // Resolve lot among AI franchises via Mode A Vickrey
          const outcome = this.bidderAI.resolveModeAVickrey(
            room.roomCode,
            room.teams,
            lot.player,
            room.lotQueue,
            room.completedLots.length + 1,
            room.phase,
            lot.currentPrice
          );

          lot.biddingMode = 'MODE_A';
          lot.modeAProvisionalWinner = outcome.winnerId;
          lot.modeAProvisionalPrice = outcome.soldPrice;
          lot.modeASecondHighestVal = outcome.secondValuation;

          if (outcome.winnerId && outcome.soldPrice > 0) {
            const winnerName = room.teams[outcome.winnerId]?.name || outcome.winnerId;
            this.pushCommentary(
              room,
              `[SKIPPED BY MANAGER] AI franchises bid: ${lot.player.name} won by ${winnerName} for ₹${outcome.soldPrice.toFixed(2)} Cr.`
            );
          } else {
            this.pushCommentary(
              room,
              `[SKIPPED BY MANAGER] No AI franchise placed a bid. ${lot.player.name} passed UNSOLD at base price ₹${lot.player.basePrice.toFixed(2)} Cr.`
            );
          }

          this.commitCurrentLot(room);
        } else {
          this.pushCommentary(room, `[SKIP] ${team?.name || 'Manager'} skipped ${lot.player.name}. Waiting for other managers or AI.`);
          room.isDirty = true;
          this.broadcastRoomState(room.roomCode);
        }
      }
    });

    // ==========================================
    // 6. HOST CONTROLS (Force Save, Pause, Replace with AI)
    // ==========================================
    socket.on('host_action', async (data: { action: 'START_AUCTION' | 'FORCE_SAVE' | 'TOGGLE_PAUSE' | 'TOGGLE_SPEED' | 'REPLACE_HUMAN_WITH_AI' | 'TOGGLE_AUTO_SKIP_AI' | 'NEXT_MATCH' | 'SIMULATE_ALL_MATCHES' | 'FORCE_SIMULATE'; targetTeamId?: string; roomCode?: string; hostId?: string }) => {
      const rawCode = data?.roomCode || socket.data.roomCode;
      let room = this.getRoom(rawCode);
      if (!room && rawCode) {
        room = (await this.restoreRoomFromDB(rawCode.toUpperCase().trim())) || undefined;
      }
      if (!room) return;

      const isHost = Boolean(
        socket.data.isHost ||
        (data?.hostId && data.hostId === room.hostId) ||
        socket.id === room.hostSocketId ||
        !room.seats.some(s => s.isHuman)
      );

      // Privileged host-only commands require verified host rights
      const privilegedActions = [
        'START_AUCTION',
        'FORCE_SAVE',
        'TOGGLE_PAUSE',
        'TOGGLE_SPEED',
        'REPLACE_HUMAN_WITH_AI',
        'TOGGLE_AUTO_SKIP_AI',
        'SIMULATE_ALL_MATCHES',
        'FORCE_SIMULATE'
      ];

      if (privilegedActions.includes(data.action) && !isHost) {
        socket.emit('error_message', { message: 'Unauthorized: Host privileges required for this action.' });
        return;
      }

      switch (data.action) {
        case 'START_AUCTION':
          if (room.status === 'LOBBY') {
            room.status = 'WISHLIST';
            const duration = env.DEV_FAST_CLOCK ? 15000 : 180000;
            room.wishlistEndsAt = Date.now() + duration;
            room.wishlistTimer.msRemaining = duration;
            room.wishlistTimer.totalMs = duration;
            this.startWishlistClock(room);
            this.pushCommentary(room, 'Pre-Auction Wishlist phase started (3:00).');
            this.broadcastRoomState(room.roomCode);
          } else if (room.status === 'WISHLIST') {
            this.startAuctionPhase(room);
          }
          break;

        case 'FORCE_SAVE':
          await this.flushRoomToMongoDB(room);
          this.io.to(room.roomCode).emit('save_status', {
            success: true,
            timestamp: Date.now(),
            message: 'Saved to Cloud ✓'
          });
          break;

        case 'TOGGLE_PAUSE':
          room.isPaused = !room.isPaused;
          if (room.isPaused) {
            this.clearAIBidTimeouts(room);
            if (room.lotClockInterval) {
              clearInterval(room.lotClockInterval);
              room.lotClockInterval = null;
            }
            this.pushCommentary(room, 'Auction paused by Host.');
          } else {
            this.pushCommentary(room, 'Auction resumed.');
            if (room.status === 'AUCTION' && room.currentLot) {
              this.startLotClock(room);
              this.scheduleAICounterBids(room);
            }
          }
          room.isDirty = true;
          this.broadcastRoomState(room.roomCode);
          break;

        case 'TOGGLE_SPEED':
          room.speedMultiplier = room.speedMultiplier === 5 ? 1 : 5;
          this.pushCommentary(room, `Host set auction speed to ${room.speedMultiplier}x ${room.speedMultiplier === 5 ? '⚡' : ''}.`);
          if (room.currentLot && room.currentLot.timerMs > (room.speedMultiplier === 5 ? 1000 : 5000)) {
            room.currentLot.timerMs = room.speedMultiplier === 5 ? 1000 : 5000;
          }
          if (!room.isPaused && room.currentLot) {
            this.startLotClock(room);
            this.scheduleAICounterBids(room);
          }
          room.isDirty = true;
          this.broadcastRoomState(room.roomCode);
          break;

        case 'REPLACE_HUMAN_WITH_AI':
          if (data.targetTeamId) {
            const seat = room.seats.find(s => s.teamId === data.targetTeamId);
            const team = room.teams[data.targetTeamId];
            if (seat && team) {
              seat.isHuman = false;
              seat.playerName = 'AI Manager';
              team.isHuman = false;
              // Preserve wishlist as Tier-1 AI ticks
              team.privateTicks.tier1 = [...new Set([...team.privateTicks.tier1, ...team.wishlistIds])].slice(0, 10);
              room.isPaused = false;
              this.pushCommentary(room, `Host replaced ${seat.teamName} with AI Manager.`);
            }
          }
          break;

        case 'TOGGLE_AUTO_SKIP_AI':
          if (room.season) {
            room.season.autoSkipAI = !room.season.autoSkipAI;
          }
          break;

        case 'FORCE_SIMULATE':
          if (room.status === 'SEASON' && room.season) {
            await this.handleSimulateVote(room, socket, socket.data.teamId, true);
          }
          break;

        case 'NEXT_MATCH':
          if (room.status === 'SEASON' && room.season) {
            const ml = room.season.matchLifecycle;
            // If in 15s post-match review view, NEXT_MATCH immediately transitions to next match pre-match prep
            if (ml && ml.stage === 'RESULT_VIEW') {
              const nextIdx = room.season.currentMatchIndex;
              const nextFixture = room.season.fixtures[nextIdx];
              if (nextFixture) {
                const isNextHuman = Boolean(room.teams[nextFixture.homeTeamId]?.isHuman || room.teams[nextFixture.awayTeamId]?.isHuman);
                ml.stage = 'PRE_MATCH_PREP';
                ml.prepTimerMsRemaining = isNextHuman ? 0 : 15000;
                ml.resultTimerMsRemaining = 15000;
                ml.readyTeamIds = [];
                ml.simulateVotes = [];
                ml.isHumanMatch = isNextHuman;
                ml.matchNumber = nextFixture.matchNumber;
                this.broadcastRoomState(room.roomCode);
                return;
              }
            }

            const isHost = Boolean(
              socket.data.isHost ||
              (data?.hostId && data.hostId === room.hostId) ||
              socket.id === room.hostSocketId ||
              !room.seats.some(s => s.isHuman)
            );
            await this.handleSimulateVote(room, socket, socket.data.teamId, isHost);
          }
          break;

        case 'SIMULATE_ALL_MATCHES':
          if (room.status === 'SEASON' && room.season) {
            socket.data.isHost = true;
            // Stop background season clock interval during bulk simulation
            const wasClockRunning = Boolean(room.seasonClockInterval);
            if (room.seasonClockInterval) {
              clearInterval(room.seasonClockInterval);
              room.seasonClockInterval = null;
            }

            this.pushCommentary(room, 'Simulating fixtures...');

            // If in League Phase (< 70), simulate remaining league fixtures up to 70
            // If already in playoffs (>= 70), simulate remaining playoff matches up to 74
            const targetIndex = room.season.currentMatchIndex < 70 ? 70 : room.season.fixtures.length;

            while (room.season.currentMatchIndex < targetIndex && room.season.currentMatchIndex < room.season.fixtures.length) {
              this.ensurePlayoffTeamsAssigned(room);
              const curFixture = room.season.fixtures[room.season.currentMatchIndex];
              if (!curFixture) break;
              if (curFixture.homeTeamId.startsWith('TBD') || curFixture.awayTeamId.startsWith('TBD')) {
                break;
              }
              await this.advanceSeasonMatch(room);
            }

            this.ensurePlayoffTeamsAssigned(room);

            if (room.season.currentMatchIndex >= 70 && room.season.currentMatchIndex < 74) {
              this.pushCommentary(room, '🏁 League Phase concluded! Top 4 Playoff bracket ready for play!');
            } else if (room.season.currentMatchIndex >= 74) {
              this.pushCommentary(room, '🏆 Tournament concluded! IPL 2026 Grand Final Complete!');
            }

            if (wasClockRunning && room.season.currentMatchIndex < room.season.fixtures.length) {
              this.startSeasonClock(room);
            }
          }
          break;
      }

      room.isDirty = true;
      this.broadcastRoomState(room.roomCode);
    });

    // Direct simulate_match socket handler
    socket.on('simulate_match', async (data?: { roomCode?: string; hostId?: string }) => {
      const targetRoomCode = data?.roomCode || socket.data.roomCode;
      const room = this.rooms.get(targetRoomCode);
      if (!room || !room.season || room.status !== 'SEASON') return;

      const isHost = Boolean(
        socket.data.isHost ||
        (data?.hostId && data.hostId === room.hostId) ||
        socket.id === room.hostSocketId ||
        !room.seats.some(s => s.isHuman)
      );

      await this.handleSimulateVote(room, socket, socket.data.teamId, isHost);
    });

    socket.on('vote_simulate', async (data?: { roomCode?: string; hostId?: string }) => {
      const targetRoomCode = data?.roomCode || socket.data.roomCode;
      const room = this.rooms.get(targetRoomCode);
      if (!room || !room.season || room.status !== 'SEASON') return;

      const isHost = Boolean(
        socket.data.isHost ||
        (data?.hostId && data.hostId === room.hostId) ||
        socket.id === room.hostSocketId ||
        !room.seats.some(s => s.isHuman)
      );

      await this.handleSimulateVote(room, socket, socket.data.teamId, isHost);
    });

    socket.on('force_simulate_match', async (data?: { roomCode?: string; hostId?: string }) => {
      const targetRoomCode = data?.roomCode || socket.data.roomCode;
      const room = this.rooms.get(targetRoomCode);
      if (!room || !room.season || room.status !== 'SEASON') return;

      const isHost = Boolean(
        socket.data.isHost ||
        (data?.hostId && data.hostId === room.hostId) ||
        socket.id === room.hostSocketId ||
        !room.seats.some(s => s.isHuman)
      );

      if (isHost) {
        await this.handleSimulateVote(room, socket, socket.data.teamId, true);
      } else {
        socket.emit('error_message', { message: 'Only the Host can force simulate matches.' });
      }
    });

    socket.on('match_ready', async (data: { roomCode?: string }) => {
      const targetRoomCode = data?.roomCode || socket.data.roomCode;
      const room = this.rooms.get(targetRoomCode);
      if (!room || !room.season || room.status !== 'SEASON') return;

      const isHost = Boolean(
        socket.data.isHost ||
        socket.id === room.hostSocketId ||
        !room.seats.some(s => s.isHuman)
      );

      await this.handleSimulateVote(room, socket, socket.data.teamId, isHost);
    });

    // ==========================================
    // 7. LINEUP SWAP & TACTICS UPDATE (Screen 5)
    // ==========================================
    socket.on('update_lineup', async (data: { lineup: Playing11Lineup; roomCode?: string }) => {
      const targetRoomCode = data?.roomCode || socket.data.roomCode;
      let room = this.rooms.get(targetRoomCode);
      if (!room && targetRoomCode) {
        room = (await this.restoreRoomFromDB(targetRoomCode)) || undefined;
      }
      const teamId = data?.lineup?.teamId || socket.data.teamId;
      if (!room || !teamId) return;

      // Identity validation: Only the franchise owner or the room host can update a lineup
      if (!socket.data.isHost && socket.data.teamId !== teamId) {
        socket.emit('error_message', { message: 'Unauthorized: You can only edit the lineup for your own franchise.' });
        return;
      }

      if (!room.season) {
        this.initSeason(room);
      }

      const squad = room.teams[teamId]?.squad || [];

      // Complete 11 and 3-5-2 validation
      const validation = validate352Lineup(data.lineup, squad);
      if (!validation.valid) {
        socket.emit('error_message', { message: validation.errors.join(' ') });
        return;
      }

      const wk = squad.find(p => p.id === data.lineup.wkId || p.role === 'WK');

      if (room.season) {
        room.season.lineups[teamId] = {
          ...data.lineup,
          teamId,
          wkId: wk ? wk.id : data.lineup.playing11Ids[0]
        };
      }
      room.isDirty = true;
      this.pushCommentary(room, `Playing 11 updated for ${room.teams[teamId]?.name || teamId}.`);
      this.flushRoomToMongoDB(room);
      this.broadcastRoomState(room.roomCode);
    });

    // ==========================================
    // 7.5. HUMAN VOTE SKIP AUCTION & SKIP TO SEASON
    // ==========================================
    socket.on('vote_skip_auction', (data?: { agreed?: boolean }) => {
      const roomCode = socket.data.roomCode;
      const room = this.rooms.get(roomCode);
      if (!room || room.status !== 'AUCTION') return;

      const teamId = socket.data.teamId;
      if (!teamId) {
        socket.emit('error_message', { message: 'You must control a franchise to vote.' });
        return;
      }

      // Check human squads legality
      const check = this.checkHumanSquadsLegal(room);
      if (!check.legal) {
        socket.emit('error_message', {
          message: `Cannot skip auction to Season yet. Incomplete human squad requirements:\n• ${check.errors.join('\n• ')}`
        });
        this.pushCommentary(room, `Skip to Season blocked: All human franchises must complete a legal squad (18-25 players, 1+ WK, 6+ Bowlers).`);
        this.broadcastRoomState(room.roomCode);
        return;
      }

      if (!room.skipVotes) room.skipVotes = new Set<string>();
      if (data?.agreed !== false) {
        room.skipVotes.add(teamId);
      } else {
        room.skipVotes.delete(teamId);
      }

      const humanTeams = Object.values(room.teams).filter(t => t.isHuman);
      const totalHumans = humanTeams.length;
      const currentVotes = room.skipVotes.size;

      this.pushCommentary(room, `[SKIP VOTE] ${room.teams[teamId]?.name || teamId} voted to Fast-Forward to Season (${currentVotes}/${totalHumans} human managers agreed).`);

      if (currentVotes >= totalHumans && totalHumans > 0) {
        this.completeAuctionAndSkipToSeason(room);
      } else {
        this.broadcastRoomState(room.roomCode);
      }
    });

    // ==========================================
    // 7.5b. HUMAN VOTE SKIP SET (Unanimous Human Consent & Silent AI Mode A Resolution)
    // ==========================================
    socket.on('vote_skip_set', async (data?: { agreed?: boolean; teamId?: string; roomCode?: string }) => {
      const room = this.getRoom(data?.roomCode || socket.data.roomCode);
      if (!room || room.status !== 'AUCTION') return;

      this.pushCommentary(
        room,
        `[SET SKIP] Skip Set activated. Resolving remaining set lots with AI Mode A...`
      );

      await this.resolveEntireCurrentSetSilently(room);
    });

    socket.on('debug:skip_auction', (data?: { roomCode?: string }) => {
      const targetRoomCode = data?.roomCode || socket.data.roomCode;
      const room = this.rooms.get(targetRoomCode);
      if (!room) return;
      this.completeAuctionAndSkipToSeason(room);
    });

    // ==========================================
    // 7.6. ROOM RECONNECT & MID-AUCTION STATE RE-SYNC (Fix 6)
    // ==========================================
    socket.on('room:join_or_sync', async (data: { roomCode: string; deviceUUID?: string; isHost?: boolean; hostId?: string }) => {
      const { roomCode, deviceUUID, isHost, hostId } = data;
      let room = this.getRoom(roomCode);
      if (!room && roomCode) {
        room = (await this.restoreRoomFromDB(roomCode.toUpperCase().trim())) || undefined;
      }
      if (!room) {
        socket.emit('error_message', { message: `Room ${roomCode} not found.` });
        return;
      }

      const cleanCode = room.roomCode.toUpperCase().trim();
      socket.join(cleanCode);
      socket.join(cleanCode.toLowerCase());
      socket.data.roomCode = cleanCode;

      if (isHost || (hostId && hostId === room.hostId) || socket.id === room.hostSocketId || !room.seats.some(s => s.isHuman)) {
        socket.data.isHost = true;
        room.hostSocketId = socket.id;
      }

      // Re-bind human seat if deviceUUID matches
      if (deviceUUID) {
        let matchedSeat = room.seats.find(s => s.isHuman && s.deviceUUID === deviceUUID);
        if (!matchedSeat) {
          // Check if this device previously owned a seat that was taken over by AI
          matchedSeat = room.seats.find(s => s.lastDeviceUUID === deviceUUID);
          if (matchedSeat) {
            matchedSeat.isHuman = true;
            matchedSeat.playerName = matchedSeat.lastPlayerName || 'Manager';
            matchedSeat.deviceUUID = deviceUUID;
            const team = room.teams[matchedSeat.teamId];
            if (team) {
              team.isHuman = true;
              team.ownerName = matchedSeat.playerName;
              team.connected = true;
            }
            this.pushCommentary(room, `${matchedSeat.playerName} returned and resumed control of ${matchedSeat.teamName}!`);
          }
        }

        if (matchedSeat) {
          matchedSeat.socketId = socket.id;
          matchedSeat.connected = true;
          socket.data.teamId = matchedSeat.teamId;
          socket.data.playerName = matchedSeat.playerName;
          const team = room.teams[matchedSeat.teamId];
          if (team) team.connected = true;
          socket.emit('seat_confirmed', { seat: matchedSeat });
        }
      }

      // If in AUCTION phase and currentLot is null or timer stalled, restart/spawn lot
      if (room.status === 'AUCTION') {
        if (!room.currentLot && room.lotQueue.length > 0) {
          this.spawnNextLot(room);
        } else if (room.currentLot && !room.lotClockInterval && !room.isPaused) {
          this.startLotClock(room);
        }
      } else if (room.status === 'SEASON') {
        if (!room.season || !room.season.fixtures || room.season.fixtures.length === 0) {
          this.initSeason(room);
        }
      }

      // Immediately send updated DTO to this socket
      const dto = this.bidderAI.sanitizeRoomDTO(room);
      socket.emit('room_update', dto);
    });

    // ==========================================
    // 8. DISCONNECT & LEAVE (Instant AI Takeover - Fix 4)
    // ==========================================
    const handleHumanDisconnectOrLeave = (room: InternalRoomState, seat: RoomSeat) => {
      if (!seat || !seat.isHuman) return;

      const team = room.teams[seat.teamId];
      const previousOwnerName = seat.playerName;

      if (room.status === 'LOBBY') {
        seat.isHuman = false;
        seat.playerName = 'AI Manager';
        seat.socketId = null;
        seat.deviceUUID = '';
        seat.token = '';
        seat.connected = true;
        if (team) {
          team.isHuman = false;
          team.ownerName = 'AI Manager';
          team.connected = true;
        }
        this.pushCommentary(room, `${previousOwnerName} left the lobby (${seat.teamName}).`);
      } else {
        // Active Game (WISHLIST, AUCTION, SEASON): Instant AI Takeover (NO Auto-Pause)
        seat.lastDeviceUUID = seat.deviceUUID;
        seat.lastPlayerName = seat.playerName;
        seat.isHuman = false;
        seat.playerName = 'AI Manager';
        seat.socketId = null;
        seat.deviceUUID = '';
        seat.token = '';
        seat.connected = true;

        if (team) {
          team.isHuman = false;
          team.ownerName = 'AI Manager';
          team.connected = true;

          // Transfer human's wishlist into AI Tier-1 priority ticks
          if (team.wishlistIds && team.wishlistIds.length > 0) {
            if (!team.privateTicks) {
              team.privateTicks = { tier1: [], tier2: [], tier3: [] };
            }
            team.privateTicks.tier1 = Array.from(new Set([...team.privateTicks.tier1, ...team.wishlistIds]));
          }
        }

        // Never freeze the room clock - unpause if room was paused
        room.isPaused = false;
        room.isDirty = true;
        this.pushCommentary(room, `${seat.teamName} is now controlled by AI Manager (instant takeover from ${previousOwnerName}).`);

        // If in auction and current lot is open, trigger AI evaluation immediately
        if (room.status === 'AUCTION' && room.currentLot && room.currentLot.state === 'OPEN') {
          this.scheduleAICounterBids(room);
        }
      }

      this.flushRoomToMongoDB(room);
      this.broadcastRoomState(room.roomCode);
    };

    socket.on('disconnect', () => {
      const room = this.rooms.get(socket.data.roomCode);
      if (!room) return;
      const seat = room.seats.find(s => s.socketId === socket.id);
      if (seat) handleHumanDisconnectOrLeave(room, seat);
    });

    socket.on('leave_room', (data?: { roomCode?: string; deviceUUID?: string }) => {
      const code = data?.roomCode || socket.data.roomCode;
      const room = code ? this.rooms.get(code) : undefined;
      if (room) {
        const seat = room.seats.find(s => s.socketId === socket.id || (data?.deviceUUID && s.deviceUUID === data.deviceUUID));
        if (seat) handleHumanDisconnectOrLeave(room, seat);
        if (code) {
          socket.leave(code);
        }
      }
      socket.data.roomCode = null;
    });
  }

  // ==========================================
  // STATE MACHINE & TIMERS
  // ==========================================

  public startWishlistClock(room: InternalRoomState) {
    if (room.wishlistClockInterval) clearInterval(room.wishlistClockInterval);

    if (!room.wishlistEndsAt) {
      const duration = env.DEV_FAST_CLOCK ? 15000 : 180000;
      room.wishlistEndsAt = Date.now() + duration;
      room.wishlistTimer.msRemaining = duration;
      room.wishlistTimer.totalMs = duration;
    }

    room.wishlistClockInterval = setInterval(() => {
      if (room.isPaused) return;

      const now = Date.now();
      const remaining = Math.max(0, (room.wishlistEndsAt || now) - now);
      room.wishlistTimer.msRemaining = remaining;

      const totalHumans = room.seats.filter(s => s.isHuman).length;
      const allHumansSubmitted = totalHumans > 0 && room.wishlistTimer.submittedTeamIds.length >= totalHumans;

      // Fix 3: In active 1000ms room tick interval, auto-start auction immediately on 0:00 or all submitted
      if (room.status === 'WISHLIST' && (remaining <= 0 || allHumansSubmitted)) {
        clearInterval(room.wishlistClockInterval!);
        room.wishlistClockInterval = null;
        this.startAuctionPhaseImmediately(room);
      } else {
        this.broadcastRoomState(room.roomCode);
      }
    }, 1000);
  }

  public checkHumanSquadsLegal(room: InternalRoomState): { legal: boolean; errors: string[] } {
    const humanTeams = Object.values(room.teams).filter(t => t.isHuman);
    const errors: string[] = [];

    for (const ht of humanTeams) {
      const count = ht.squad.length;
      const wk = ht.squad.filter(p => p.role === 'WK').length;
      const os = ht.squad.filter(p => p.isOverseas).length;
      const bowlers = ht.squad.filter(p => TeamMaker.isBowler(p)).length;

      if (count < 18) {
        errors.push(`${ht.name} has only ${count} players (minimum 18 required)`);
      } else if (count > 25) {
        errors.push(`${ht.name} exceeds squad limit with ${count} players (maximum 25)`);
      }
      if (wk < 1) {
        errors.push(`${ht.name} has no Wicketkeeper (at least 1 WK required)`);
      }
      if (os > 8) {
        errors.push(`${ht.name} exceeds overseas limit with ${os} overseas players (maximum 8)`);
      }
      if (bowlers < 6) {
        errors.push(`${ht.name} has only ${bowlers} bowling options (at least 6 required)`);
      }
    }

    return { legal: errors.length === 0, errors };
  }

  public completeAuctionAndSkipToSeason(room: InternalRoomState) {
    if (room.lotClockInterval) {
      clearInterval(room.lotClockInterval);
      room.lotClockInterval = null;
    }
    if (room.wishlistClockInterval) {
      clearInterval(room.wishlistClockInterval);
      room.wishlistClockInterval = null;
    }
    this.clearAIBidTimeouts(room);
    room.currentLot = null;

    const assignedPlayerIds = new Set<string>();
    for (const team of Object.values(room.teams)) {
      for (const p of team.squad) {
        assignedPlayerIds.add(p.id);
      }
    }

    const availablePlayers = room.allPlayers.filter(p => !assignedPlayerIds.has(p.id));
    const teams = Object.values(room.teams);

    // USER RULE: "auto ai team donot touch human team and skip to season"
    // Auto-fill AI teams only!
    for (const team of teams) {
      if (team.isHuman) continue; // DO NOT TOUCH HUMAN TEAMS!
      while (team.squad.length < 18 && availablePlayers.length > 0) {
        const osCount = team.squad.filter(p => p.isOverseas).length;
        const domCount = team.squad.filter(p => !p.isOverseas).length;
        const slotsLeft = 18 - team.squad.length;

        const candidateIdx = availablePlayers.findIndex(p => {
          if (assignedPlayerIds.has(p.id)) return false;
          if (p.isOverseas && (osCount >= 8 || (domCount < 7 && slotsLeft <= (7 - domCount)))) return false;
          return true;
        });

        if (candidateIdx === -1) break;
        const [candidate] = availablePlayers.splice(candidateIdx, 1);
        assignedPlayerIds.add(candidate.id);

        const baseCost = candidate.basePrice ?? (candidate as any).basePriceCr ?? 0.30;
        const cost = Math.min(baseCost, team.purse > 0 ? team.purse : baseCost);

        team.squad.push({ ...candidate, soldPrice: cost });
        room.completedLots.push({ player: candidate, soldPrice: cost, soldTo: team.franchiseId });
        team.purse = Math.max(0.0, Math.round((team.purse - cost) * 100) / 100);
      }
    }

    // Guard: Ensure every AI team has at least 1 WK
    for (const team of teams) {
      if (team.isHuman) continue; // DO NOT TOUCH HUMAN TEAMS!
      const wkCount = team.squad.filter(p => p.role === 'WK').length;
      if (wkCount === 0) {
        const availableWK = availablePlayers.find(p => p.role === 'WK' && !assignedPlayerIds.has(p.id));
        if (availableWK) {
          const wkWithPrice = { ...availableWK, soldPrice: availableWK.basePrice };
          team.squad.push(wkWithPrice);
          room.completedLots.push({ player: availableWK, soldPrice: availableWK.basePrice, soldTo: team.franchiseId });
          assignedPlayerIds.add(availableWK.id);
        }
      }
    }

    // Guard: Ensure every AI team has at least 7 bowlers and at least 3 domestic bowlers, respecting overseas <= 8
    for (const team of teams) {
      if (team.isHuman) continue; // DO NOT TOUCH HUMAN TEAMS!
      let bowlers = team.squad.filter(p => TeamMaker.isBowler(p));
      let domBowlers = bowlers.filter(p => !p.isOverseas);
      let osCount = team.squad.filter(p => p.isOverseas).length;

      // 1. Ensure at least 3 domestic bowlers
      while (domBowlers.length < 3) {
        const availableDom = availablePlayers.find(p => !p.isOverseas && TeamMaker.isBowler(p) && !assignedPlayerIds.has(p.id));
        if (!availableDom) break;
        const bCost = availableDom.basePrice || 0.50;
        team.squad.push({ ...availableDom, soldPrice: bCost });
        assignedPlayerIds.add(availableDom.id);
        bowlers = team.squad.filter(p => TeamMaker.isBowler(p));
        domBowlers = bowlers.filter(p => !p.isOverseas);
      }

      // 2. Ensure at least 7 total bowlers
      while (bowlers.length < 7) {
        const availableBowler = availablePlayers.find(p => TeamMaker.isBowler(p) && !assignedPlayerIds.has(p.id) && (!p.isOverseas || osCount < 8));
        if (!availableBowler) break;
        const bCost = availableBowler.basePrice || 0.50;
        team.squad.push({ ...availableBowler, soldPrice: bCost });
        assignedPlayerIds.add(availableBowler.id);
        if (availableBowler.isOverseas) osCount++;
        bowlers = team.squad.filter(p => TeamMaker.isBowler(p));
      }

      // 3. Guarantee squad bowling capacity
      TeamMaker.ensureSquadBowlingCapacity(team.squad);
    }

    room.isDirty = true;
    this.pushCommentary(room, '⚡ AI squads auto-filled (Human squads preserved). Fast-forwarding directly to Season Hub!');
    this.finishAuction(room);
  }

  public fastForwardAuctionDebug(room: InternalRoomState) {
    this.completeAuctionAndSkipToSeason(room);
  }

  public startAuctionPhaseImmediately(room: InternalRoomState) {
    if (room.wishlistClockInterval) {
      clearInterval(room.wishlistClockInterval);
      room.wishlistClockInterval = null;
    }

    room.status = 'AUCTION';
    room.phase = 'MAIN';
    room.isDirty = true;

    // Dynamically assign archetypes to active AI franchises based on room AI count
    const aiIds = Object.values(room.teams).filter(t => !t.isHuman).map(t => t.franchiseId);
    this.bidderAI.assignRoomAIArchetypes(aiIds);

    this.pushCommentary(room, 'Wishlist phase closed. Mega Auction officially started!');
    this.spawnNextLot(room);
    this.broadcastRoomState(room.roomCode);
  }

  public startAuctionPhase(room: InternalRoomState) {
    this.startAuctionPhaseImmediately(room);
  }

  public checkAndTriggerModeAIfAllHumansSkipped(room: InternalRoomState): boolean {
    const lot = room.currentLot;
    if (!lot || lot.state !== 'OPEN') return false;

    // If a human is currently holding the leading bid, do NOT resolve Mode A
    if (lot.currentBidder && room.teams[lot.currentBidder]?.isHuman) {
      return false;
    }

    // Check all human teams in the room
    const humanTeams = Object.values(room.teams).filter(t => t.isHuman);
    if (humanTeams.length === 0) return false;

    let allHumansSkipped = true;
    for (const team of humanTeams) {
      const player = lot.player;

      // 1. Explicit manual skip takes absolute priority over wishlist/capacity/needs
      const isManuallySkipped = team.skipLotIds && team.skipLotIds.includes(player.id);
      if (isManuallySkipped) {
        continue; // This human explicitly skipped this player
      }

      // 2. Capacity & Solvency checks
      const squadCount = team.squad.length;
      if (squadCount >= 25) continue;
      if (player.isOverseas && team.squad.filter(p => p.isOverseas).length >= 8) continue;
      const minReserve = getHumanMinPurseReserve(squadCount);
      if (player.basePrice > team.purse - minReserve) continue;

      // 3. Wishlist check
      const isWishlist = team.wishlistIds && team.wishlistIds.includes(player.id);
      if (isWishlist) {
        allHumansSkipped = false;
        break;
      }

      // 4. Critical role need checks
      const wkCount = team.squad.filter(p => p.role === 'WK').length;
      const osCount = team.squad.filter(p => p.isOverseas).length;
      const remLegalWk = room.lotQueue.filter(p => p.role === 'WK' && (!p.isOverseas || osCount < 8)).length;
      if (wkCount === 0 && player.role === 'WK' && remLegalWk <= 2) {
        allHumansSkipped = false;
        break;
      }

      const remLegalPool = room.lotQueue.filter(p => !p.isOverseas || osCount < 8).length;
      if (remLegalPool <= Math.max(0, 18 - squadCount)) {
        allHumansSkipped = false;
        break;
      }

      // 5. Live Filter Config
      const filterConfig = room.humanFilterConfigs[team.franchiseId];
      let matchesFilter = false;
      if (filterConfig) {
        if (filterConfig.wishlistOnlyMode && !isWishlist) matchesFilter = true;
        if (filterConfig.skipOverseas && player.isOverseas) matchesFilter = true;
        if (filterConfig.skipUncapped && player.isUncapped) matchesFilter = true;
        if (filterConfig.minOvr && player.stats.ovr < filterConfig.minOvr) matchesFilter = true;
        if (filterConfig.minBat && player.stats.bat < filterConfig.minBat) matchesFilter = true;
        if (filterConfig.minBowl && player.stats.bowl < filterConfig.minBowl) matchesFilter = true;
        if (filterConfig.minPower && player.stats.power < filterConfig.minPower) matchesFilter = true;
        if (filterConfig.maxBasePrice && player.basePrice > filterConfig.maxBasePrice) matchesFilter = true;
        if (filterConfig.mutedRoles && Array.isArray(filterConfig.mutedRoles) && filterConfig.mutedRoles.includes(player.role)) matchesFilter = true;
        if (filterConfig.skipOvrBelow && player.stats.ovr < filterConfig.skipOvrBelow) matchesFilter = true;
        if (filterConfig.skipBatBelow && player.stats.bat < filterConfig.skipBatBelow) matchesFilter = true;
        if (filterConfig.skipBowlBelow && player.stats.bowl < filterConfig.skipBowlBelow) matchesFilter = true;
        if (filterConfig.skipIfRoleFull && team.squad.filter(p => p.role === player.role).length >= 6) matchesFilter = true;
      }

      if (matchesFilter) {
        continue;
      }

      allHumansSkipped = false;
      break;
    }

    if (allHumansSkipped) {
      this.clearAIBidTimeouts(room);
      if (room.lotClockInterval) {
        clearInterval(room.lotClockInterval);
        room.lotClockInterval = null;
      }
      // Fast-resolve lot via AI Mode A Vickrey so AI franchises bid and buy players they want
      const outcome = this.bidderAI.resolveModeAVickrey(
        room.roomCode,
        room.teams,
        lot.player,
        room.lotQueue,
        room.completedLots.length + 1,
        room.phase,
        lot.currentPrice
      );

      lot.biddingMode = 'MODE_A';
      lot.modeAProvisionalWinner = outcome.winnerId;
      lot.modeAProvisionalPrice = outcome.soldPrice;
      lot.modeASecondHighestVal = outcome.secondValuation;

      if (outcome.winnerId && outcome.soldPrice > 0) {
        const winnerName = room.teams[outcome.winnerId]?.name || outcome.winnerId;
        this.pushCommentary(
          room,
          `[SKIPPED BY MANAGER] AI bidding resolved: ${lot.player.name} signed by ${winnerName} for ₹${outcome.soldPrice.toFixed(2)} Cr.`
        );
      } else {
        this.pushCommentary(
          room,
          `[SKIPPED BY MANAGER] No AI franchise placed a bid. ${lot.player.name} passed UNSOLD at base price ₹${lot.player.basePrice.toFixed(2)} Cr.`
        );
      }

      this.commitCurrentLot(room);
      return true;
    }
    return false;
  }

  public spawnNextLot(room: InternalRoomState) {
    if (room.status !== 'AUCTION') return;
    this.clearAIBidTimeouts(room);

    if (room.lotQueue.length === 0) {
      // Transition to Accelerated or Season
      if (room.phase === 'MAIN') {
        const unsoldPlayers = room.completedLots
          .filter(l => l.soldTo === null)
          .map(l => ({
            ...l.player,
            basePrice: getAcceleratedBasePrice(l.player.basePrice) as any
          }));
        if (unsoldPlayers.length > 0) {
          room.phase = 'ACCELERATED_1';
          room.lotQueue = unsoldPlayers;
          this.pushCommentary(room, 'Main Round concluded. Accelerated Round 1 starting with halved/reduced base prices!');
          this.spawnNextLot(room);
          return;
        }
      } else if (room.phase === 'ACCELERATED_1' && room.acceleratedRoundMode === '2-ACC') {
        const unsoldPlayers = room.completedLots
          .filter(l => l.soldTo === null)
          .map(l => ({
            ...l.player,
            basePrice: getAcceleratedBasePrice(l.player.basePrice) as any
          }));
        if (unsoldPlayers.length > 0) {
          room.phase = 'ACCELERATED_2';
          room.lotQueue = unsoldPlayers;
          this.pushCommentary(room, 'Accelerated Round 1 concluded. Accelerated Round 2 starting!');
          this.spawnNextLot(room);
          return;
        }
      }

      this.finishAuction(room);
      return;
    }

    const player = room.lotQueue.shift()!;
    const lotNumber = room.completedLots.length + 1;

    // Strict V1.7 human_skip_eval_order at t = 0.0s lot spawn
    const humanSeats = room.seats.filter(s => s.isHuman && s.connected);
    // If no human seats exist at all in room, allHumansSkipped is true (pure AI room)
    let allHumansSkipped = humanSeats.length > 0;

    for (const seat of humanSeats) {
      const team = room.teams[seat.teamId];
      if (!team) continue;

      const isWishlist = team.wishlistIds.includes(player.id);
      const isWk = player.role === 'WK';
      const wkCount = team.squad.filter(p => p.role === 'WK').length;
      const osCount = team.squad.filter(p => p.isOverseas).length;

      // Rule 1: Wishlist Tick Priority (Force ACTIVE, overrides all skip filters)
      if (isWishlist) {
        allHumansSkipped = false;
        continue;
      }

      // Rule 2: Mandatory WK Guard (Force ACTIVE if 0 WK and <= 2 remain in pool)
      const remLegalWk = room.lotQueue.filter(p => p.role === 'WK' && (!p.isOverseas || osCount < 8)).length;
      if (wkCount === 0 && isWk && remLegalWk <= 2) {
        allHumansSkipped = false;
        continue;
      }

      // Rule 3: Mandatory 18-Slot Guard (Force ACTIVE if pool <= unfilled slots)
      const remLegalPool = room.lotQueue.filter(p => !p.isOverseas || osCount < 8).length;
      if (remLegalPool <= Math.max(0, 18 - team.squad.length)) {
        allHumansSkipped = false;
        continue;
      }

      // Rule 4: Live Server Filters (Checked explicitly by user in Bento 4 Deck)
      const filterConfig = room.humanFilterConfigs[seat.teamId];
      let matchesFilter = false;
      if (filterConfig) {
        if (filterConfig.wishlistOnlyMode && !isWishlist) matchesFilter = true;
        if (filterConfig.skipOverseas && player.isOverseas) matchesFilter = true;
        if (filterConfig.skipUncapped && player.isUncapped) matchesFilter = true;
        if (filterConfig.minOvr && player.stats.ovr < filterConfig.minOvr) matchesFilter = true;
        if (filterConfig.minBat && player.stats.bat < filterConfig.minBat) matchesFilter = true;
        if (filterConfig.minBowl && player.stats.bowl < filterConfig.minBowl) matchesFilter = true;
        if (filterConfig.minPower && player.stats.power < filterConfig.minPower) matchesFilter = true;
        if (filterConfig.maxBasePrice && player.basePrice > filterConfig.maxBasePrice) matchesFilter = true;
        if (filterConfig.mutedRoles && Array.isArray(filterConfig.mutedRoles) && filterConfig.mutedRoles.includes(player.role)) matchesFilter = true;
        if (filterConfig.skipOvrBelow && player.stats.ovr < filterConfig.skipOvrBelow) matchesFilter = true;
        if (filterConfig.skipBatBelow && player.stats.bat < filterConfig.skipBatBelow) matchesFilter = true;
        if (filterConfig.skipBowlBelow && player.stats.bowl < filterConfig.skipBowlBelow) matchesFilter = true;
        if (filterConfig.skipIfRoleFull && team.squad.filter(p => p.role === player.role).length >= 6) matchesFilter = true;
      }

      // Manual Skip (Explicitly toggled via UI skip toggle for this player)
      const isManuallySkipped = team.skipLotIds && team.skipLotIds.includes(player.id);

      if (matchesFilter || isManuallySkipped) {
        // This human is skipped for this lot
        continue;
      }

      // Rule 5: Default for unticked players is strictly ACTIVE!
      allHumansSkipped = false;
    }

    // Clear set skip votes if transitioning to a new set
    const curMarqueeSet = player.marqueeSet || 1;
    if (room.setSkipVotes && room.setSkipVotes.size > 0) {
      const prevMarqueeSet = room.completedLots[room.completedLots.length - 1]?.player?.marqueeSet;
      if (prevMarqueeSet && prevMarqueeSet !== curMarqueeSet) {
        room.setSkipVotes.clear();
      }
    }

    const lotDuration = room.speedMultiplier === 5 ? 1000 : 5000;
    const lot: AuctionLot = {
      lotId: `lot_${lotNumber}_${player.id}`,
      player,
      lotNumber,
      totalLots: room.completedLots.length + room.lotQueue.length + 1,
      phase: room.phase,
      currentPrice: player.basePrice,
      currentBidder: null,
      currentBidderName: null,
      biddingMode: allHumansSkipped ? 'MODE_A' : 'MODE_B',
      timerMs: lotDuration,
      timerTotalMs: lotDuration,
      isTimerRunning: true,
      bidHistory: [],
      state: 'OPEN'
    };

    if (allHumansSkipped) {
      // AI franchises resolve Vickrey Mode A bidding for this lot
      const outcome = this.bidderAI.resolveModeAVickrey(
        room.roomCode,
        room.teams,
        player,
        room.lotQueue,
        lotNumber,
        room.phase
      );
      lot.modeAProvisionalWinner = outcome.winnerId;
      lot.modeAProvisionalPrice = outcome.soldPrice;
      lot.modeASecondHighestVal = outcome.secondValuation;
    }

    // Broadcast opening announcement commentary
    const marqueeTag = player.marqueeSet ? ` [Set ${player.marqueeSet}]` : '';
    this.pushCommentary(
      room,
      `🎙️ "Next under the hammer: ${player.name} (${player.role}, OVR ${player.stats.ovr}) at Base Price ₹${player.basePrice.toFixed(2)} Cr${marqueeTag}."`
    );

    room.currentLot = lot;
    room.isDirty = true;
    this.broadcastRoomState(room.roomCode);

    this.startLotClock(room);

    // If Mode B and no human bids initially, schedule AI opening bid
    if (!allHumansSkipped) {
      this.scheduleAICounterBids(room);
    }
  }

  private startLotClock(room: InternalRoomState) {
    if (room.lotClockInterval) clearInterval(room.lotClockInterval);

    const isSpeed5x = room.speedMultiplier === 5;
    const tickInterval = isSpeed5x ? 200 : 1000;
    const decrementAmount = isSpeed5x ? 200 : 1000;

    room.lotClockInterval = setInterval(() => {
      if (room.status !== 'AUCTION') {
        if (room.lotClockInterval) clearInterval(room.lotClockInterval);
        room.lotClockInterval = null;
        return;
      }
      if (room.isPaused || !room.currentLot) return;

      room.currentLot.timerMs -= decrementAmount;

      // Broadcast Going once... going twice call when final second remains
      const finalCallThreshold = isSpeed5x ? 400 : 1000;
      if (room.currentLot.timerMs === finalCallThreshold && room.currentLot.currentPrice > 0) {
        this.pushCommentary(
          room,
          `🎙️ "Going once... going twice at ₹${room.currentLot.currentPrice.toFixed(2)} Cr..."`
        );
      }

      if (room.currentLot.timerMs <= 0) {
        clearInterval(room.lotClockInterval!);
        room.lotClockInterval = null;
        this.broadcastRoomState(room.roomCode);
        const graceMs = isSpeed5x ? 50 : 200;
        setTimeout(() => {
          if (room.status === 'AUCTION' && room.currentLot && room.currentLot.timerMs <= 0) {
            this.commitCurrentLot(room);
          }
        }, graceMs);
      } else {
        this.broadcastRoomState(room.roomCode);
      }
    }, tickInterval);
  }

  private scheduleAICounterBids(room: InternalRoomState) {
    this.clearAIBidTimeouts(room);
    const lot = room.currentLot;
    if (!lot || lot.state !== 'OPEN') return;

    this.bidderAI.config.determinismRatio = room.determinismRatio ?? 0.45;
    this.bidderAI.config.humanTaxEnabled = room.humanTaxEnabled ?? true;

    for (const [teamId, team] of Object.entries(room.teams)) {
      if (team.isHuman || teamId === lot.currentBidder) continue;
      const profile = this.bidderAI.franchiseProfiles.get(teamId);
      if (!profile) continue;

      const inc = lot.currentBidder ? getNextBidIncrement(lot.currentPrice) : 0.0;
      const nextBidAmount = Math.round((lot.currentPrice + inc) * 100) / 100;
      const leadingBidderIsHuman = lot.currentBidder ? (room.teams[lot.currentBidder]?.isHuman ?? false) : false;
      const humanPurse = leadingBidderIsHuman && lot.currentBidder ? room.teams[lot.currentBidder].purse : 0;
      const humanSquadSize = leadingBidderIsHuman && lot.currentBidder ? room.teams[lot.currentBidder].squad.length : 0;

      const dec = this.bidderAI.evaluateBidEligibility(
        room.roomCode,
        team,
        profile,
        lot.player,
        nextBidAmount,
        room.lotQueue,
        lot.lotNumber,
        room.phase,
        leadingBidderIsHuman,
        humanPurse,
        humanSquadSize
      );

      if (dec.state === 'ELIGIBLE' && dec.reactionDelayMs) {
        const baseDelay = Math.min(dec.reactionDelayMs, 3500);
        const actualDelay = room.speedMultiplier === 5 ? Math.max(50, Math.round(baseDelay * 0.20)) : baseDelay;
        const isLateSniper = actualDelay > (room.speedMultiplier === 5 ? 350 : 1800) && lot.currentPrice >= lot.player.basePrice * 1.5;

        const timeout = setTimeout(() => {
          if (room.isPaused || !room.currentLot || room.currentLot.lotId !== lot.lotId) return;

          // Re-evaluate live dynamic increment based on current price
          const liveInc = lot.currentBidder ? getNextBidIncrement(lot.currentPrice) : 0.0;
          const actualNextPrice = Math.round((lot.currentPrice + liveInc) * 100) / 100;
          if (dec.mValue && actualNextPrice > dec.mValue) return;

          const prevPrice = lot.currentPrice;
          const prevBidder = lot.currentBidder ? room.teams[lot.currentBidder]?.name : null;
          lot.currentPrice = actualNextPrice;
          lot.currentBidder = teamId;
          lot.currentBidderName = team.name;
          lot.timerMs = room.speedMultiplier === 5 ? 1000 : 5000;
          lot.bidHistory.push({
            bidderId: teamId,
            bidderName: `${team.name} (AI)`,
            amount: actualNextPrice,
            timestamp: Date.now()
          });

          if (isLateSniper) {
            this.pushCommentary(room, `🎯 "Late sniper entry! ${team.name} swoops in at the wire with ₹${actualNextPrice.toFixed(2)} Cr for ${lot.player.name}!"`);
          } else if (actualNextPrice >= 20.0 && prevPrice < 20.0 && prevBidder) {
            this.pushCommentary(room, `🔥 "₹${actualNextPrice.toFixed(2)} Cr! ${team.name} and ${prevBidder} locked in a historic blockbuster bidding war!"`);
          } else if (actualNextPrice >= 15.0 && prevPrice < 15.0 && prevBidder) {
            this.pushCommentary(room, `⚡ "₹${actualNextPrice.toFixed(2)} Cr! ${team.name} and ${prevBidder} locked in a fierce tug-of-war for this match-winner!"`);
          } else if (actualNextPrice >= 10.0 && prevPrice < 10.0 && prevBidder) {
            this.pushCommentary(room, `💥 "Eight figures crossed! ₹${actualNextPrice.toFixed(2)} Cr on the board as ${team.name} counters ${prevBidder}!"`);
          } else if (actualNextPrice >= 5.0 && prevPrice < 5.0 && prevBidder) {
            this.pushCommentary(room, `📈 "Bidding surges past ₹5.00 Cr! ${team.name} raises the stakes!"`);
          } else {
            this.pushCommentary(room, `[BID] ${team.name} counter-bid ₹${actualNextPrice.toFixed(2)} Cr for ${lot.player.name}`);
          }
          room.isDirty = true;
          this.broadcastRoomState(room.roomCode);

          this.scheduleAICounterBids(room);
        }, actualDelay);

        room.aiBidTimeouts.push(timeout);
      }
    }
  }

  private clearAIBidTimeouts(room: InternalRoomState) {
    room.aiBidTimeouts.forEach(t => clearTimeout(t));
    room.aiBidTimeouts = [];
  }

  private commitCurrentLot(room: InternalRoomState) {
    const lot = room.currentLot;
    if (!lot) return;

    lot.state = 'SOLD';
    let winnerId: string | null = null;
    let soldPrice: number = 0;

    if (lot.biddingMode === 'MODE_A') {
      winnerId = lot.modeAProvisionalWinner || null;
      soldPrice = lot.modeAProvisionalPrice || 0;
    } else {
      winnerId = lot.currentBidder;
      soldPrice = lot.currentPrice;
    }

    const winnerName = winnerId ? (room.teams[winnerId]?.name || winnerId) : null;

    if (winnerId) {
      this.bidderAI.commitLotSale(room.teams, lot.player, winnerId, soldPrice);
      room.completedLots.push({ player: lot.player, soldPrice, soldTo: winnerId });

      if (soldPrice <= lot.player.basePrice * 1.25) {
        this.pushCommentary(room, `🔨 [SOLD] Gavel hammered! ${lot.player.name} sold to ${winnerName} for ₹${soldPrice.toFixed(2)} Cr — absolute steal of the round!`);
      } else if (soldPrice >= 12.0) {
        this.pushCommentary(room, `🔨 [SOLD] Massive statement signing! ${lot.player.name} goes to ${winnerName} for a mammoth ₹${soldPrice.toFixed(2)} Cr!`);
      } else {
        this.pushCommentary(room, `🔨 [SOLD] Gavel down! ${lot.player.name} sold to ${winnerName} for ₹${soldPrice.toFixed(2)} Cr!`);
      }
    } else {
      lot.state = 'UNSOLD';
      this.bidderAI.commitLotSale(room.teams, lot.player, null, 0);
      room.completedLots.push({ player: lot.player, soldPrice: null, soldTo: null });
      this.pushCommentary(room, `🔨 [UNSOLD] ${lot.player.name} passed unsold at base price ₹${lot.player.basePrice.toFixed(2)} Cr.`);
    }

    const sold = winnerId !== null;
    room.lastResolvedLot = {
      player: lot.player,
      sold,
      winningPrice: sold ? soldPrice : undefined,
      winningFranchiseId: sold && winnerId ? winnerId : undefined
    };

    room.currentLot = null;
    room.isDirty = true;
    this.broadcastRoomState(room.roomCode);

    // Gavel overlay hold: 400ms in 5x mode, 1700ms in 1x mode
    const holdDuration = room.speedMultiplier === 5 ? 400 : 1700;
    setTimeout(() => {
      if (room.status === 'AUCTION') {
        this.spawnNextLot(room);
      }
    }, holdDuration);
  }

  public async resolveEntireCurrentSetSilently(room: InternalRoomState) {
    if (room.status !== 'AUCTION') return;
    this.clearAIBidTimeouts(room);
    if (room.lotClockInterval) {
      clearInterval(room.lotClockInterval);
      room.lotClockInterval = null;
    }

    const currentSet = Number(room.currentLot?.player?.marqueeSet || (room.lotQueue[0]?.marqueeSet) || 1);
    let signedCount = 0;
    let unsoldCount = 0;

    // 1. Resolve current lot if it belongs to current set
    if (room.currentLot) {
      const curPlayer = room.currentLot.player;
      if (Number(curPlayer.marqueeSet || 1) === currentSet) {
        const outcome = this.bidderAI.resolveModeAVickrey(
          room.roomCode,
          room.teams,
          curPlayer,
          room.lotQueue,
          room.completedLots.length + 1,
          room.phase
        );
        if (outcome.winnerId && outcome.soldPrice > 0) {
          this.bidderAI.commitLotSale(room.teams, curPlayer, outcome.winnerId, outcome.soldPrice);
          room.completedLots.push({ player: curPlayer, soldPrice: outcome.soldPrice, soldTo: outcome.winnerId });
          signedCount++;
        } else {
          this.bidderAI.commitLotSale(room.teams, curPlayer, null, 0);
          room.completedLots.push({ player: curPlayer, soldPrice: null, soldTo: null });
          unsoldCount++;
        }
      } else {
        // Put back at head of queue if not matching set
        room.lotQueue.unshift(curPlayer);
      }
      room.currentLot = null;
    }

    // 2. Iterate remaining players in queue belonging to currentSet
    const remainingInQueue: IPLPlayer[] = [];
    for (const p of room.lotQueue) {
      if (Number(p.marqueeSet || 1) === currentSet) {
        const outcome = this.bidderAI.resolveModeAVickrey(
          room.roomCode,
          room.teams,
          p,
          room.lotQueue,
          room.completedLots.length + 1,
          room.phase
        );
        if (outcome.winnerId && outcome.soldPrice > 0) {
          this.bidderAI.commitLotSale(room.teams, p, outcome.winnerId, outcome.soldPrice);
          room.completedLots.push({ player: p, soldPrice: outcome.soldPrice, soldTo: outcome.winnerId });
          signedCount++;
        } else {
          this.bidderAI.commitLotSale(room.teams, p, null, 0);
          room.completedLots.push({ player: p, soldPrice: null, soldTo: null });
          unsoldCount++;
        }
      } else {
        remainingInQueue.push(p);
      }
    }
    room.lotQueue = remainingInQueue;

    // 3. Clear skip votes and announce summary banner
    if (room.setSkipVotes) {
      room.setSkipVotes.clear();
    }
    const summaryMsg = `Set ${currentSet} Skipped — AI Franchises signed ${signedCount} players, ${unsoldCount} Unsold`;
    room.lastSetSummary = summaryMsg;
    this.pushCommentary(room, summaryMsg);
    room.isDirty = true;
    this.broadcastRoomState(room.roomCode);

    // 4. Advance immediately to next lot
    this.spawnNextLot(room);
  }

  public finishAuction(room: InternalRoomState) {
    if (room.lotClockInterval) {
      clearInterval(room.lotClockInterval);
      room.lotClockInterval = null;
    }
    if (room.wishlistClockInterval) {
      clearInterval(room.wishlistClockInterval);
      room.wishlistClockInterval = null;
    }
    this.clearAIBidTimeouts(room);
    room.currentLot = null;
    room.status = 'SEASON';
    this.initSeason(room);
    this.pushCommentary(room, 'Auction complete! Transitioning to IPL 2026 Season Hub.');
    this.flushRoomToMongoDB(room);
    this.broadcastRoomState(room.roomCode);
  }

  public initSeason(room: InternalRoomState) {
    const standings: Record<string, TeamStanding> = {};
    const lineups: Record<string, Playing11Lineup> = {};

    // Safety Auto-Fill: Ensure every team has at least 18 players (and strictly >= 11)
    const allAssignedIds = new Set<string>();
    for (const t of Object.values(room.teams)) {
      for (const p of t.squad) allAssignedIds.add(p.id);
    }
    const unassignedPool = (room.allPlayers || []).filter(p => !allAssignedIds.has(p.id));
    let unassignedIdx = 0;

    for (const [tId, t] of Object.entries(room.teams)) {
      if (t.squad.length < 18) {
        console.log(`[SocketHub] Auto-filling squad for ${t.name} from ${t.squad.length} to 18 players using available player pool.`);
        while (t.squad.length < 18 && unassignedIdx < unassignedPool.length) {
          const candidate = unassignedPool[unassignedIdx++];
          const osCount = t.squad.filter(p => p.isOverseas).length;
          const domCount = t.squad.filter(p => !p.isOverseas).length;
          if (candidate.isOverseas && (osCount >= 8 || (domCount < 7 && (18 - t.squad.length) <= (7 - domCount)))) {
            continue;
          }
          t.squad.push(candidate);
          allAssignedIds.add(candidate.id);
        }
      }

      // Guard 1: Ensure every team has at least 1 WK
      const wkCount = t.squad.filter(p => p.role === 'WK').length;
      if (wkCount === 0) {
        const availableWK = unassignedPool.find(p => p.role === 'WK' && !allAssignedIds.has(p.id));
        if (availableWK) {
          t.squad.push(availableWK);
          allAssignedIds.add(availableWK.id);
        }
      }

      // Guard 2: Ensure every team has at least 3 domestic bowlers and 6 total bowlers
      let bowlers = t.squad.filter(p => TeamMaker.isBowler(p));
      let domBowlers = bowlers.filter(p => !p.isOverseas);
      while (domBowlers.length < 3) {
        const availableDom = unassignedPool.find(p => !p.isOverseas && TeamMaker.isBowler(p) && !allAssignedIds.has(p.id));
        if (!availableDom) break;
        t.squad.push(availableDom);
        allAssignedIds.add(availableDom.id);
        bowlers = t.squad.filter(p => TeamMaker.isBowler(p));
        domBowlers = bowlers.filter(p => !p.isOverseas);
      }
      while (bowlers.length < 6) {
        const osCount = t.squad.filter(p => p.isOverseas).length;
        const availableBowler = unassignedPool.find(p => TeamMaker.isBowler(p) && !allAssignedIds.has(p.id) && (!p.isOverseas || osCount < 8));
        if (!availableBowler) break;
        t.squad.push(availableBowler);
        allAssignedIds.add(availableBowler.id);
        bowlers = t.squad.filter(p => TeamMaker.isBowler(p));
      }

      // Guard 3: Guarantee bowling capacity
      TeamMaker.ensureSquadBowlingCapacity(t.squad);
    }

    for (const [tId, t] of Object.entries(room.teams)) {
      standings[tId] = {
        teamId: tId,
        teamName: t.name,
        played: 0,
        won: 0,
        lost: 0,
        tied: 0,
        points: 0,
        nrr: 0.0,
        totalRunsScored: 0,
        totalOversBatted: 0,
        totalRunsConceded: 0,
        totalOversBowled: 0,
        recentForm: []
      };

      // Generate lineups: Elite AI with 3-5-2 & LHB/RHB synergy vs Naïve default for Human until customized
      if (t.isHuman) {
        lineups[tId] = TeamMaker.selectNaiveHumanAutoFill(t.squad, tId);
      } else {
        const homeProfile = DEFAULT_IPL_FRANCHISES.find(p => p.id === tId);
        lineups[tId] = TeamMaker.selectEliteAILineup(t.squad, homeProfile?.homePitch, undefined, tId);
      }
    }

    const teamIds = Object.keys(room.teams);
    const fixtures: MatchResult[] = [];
    let matchCounter = 1;

    // 1. Generate 70 League Matches (each of the 10 teams plays exactly 14 matches)
    if (teamIds.length >= 10) {
      const groupA = teamIds.slice(0, 5);
      const groupB = teamIds.slice(5, 10);
      const leaguePairs: Array<{ home: string; away: string }> = [];

      // Group A intra-group home & away (20 matches)
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          if (i !== j) leaguePairs.push({ home: groupA[i], away: groupA[j] });
        }
      }

      // Group B intra-group home & away (20 matches)
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          if (i !== j) leaguePairs.push({ home: groupB[i], away: groupB[j] });
        }
      }

      // Cross-group counterpart home & away (10 matches)
      for (let i = 0; i < 5; i++) {
        leaguePairs.push({ home: groupA[i], away: groupB[i] });
        leaguePairs.push({ home: groupB[i], away: groupA[i] });
      }

      // Cross-group other pairs with balanced 7 home / 7 away (20 matches)
      for (let i = 0; i < 5; i++) {
        for (let diff = 1; diff <= 4; diff++) {
          const j = (i + diff) % 5;
          if (diff <= 2) {
            leaguePairs.push({ home: groupA[i], away: groupB[j] });
          } else {
            leaguePairs.push({ home: groupB[j], away: groupA[i] });
          }
        }
      }

      // STRICT UNIT ASSERTIONS (Bug 4: Exactly 70 League Matches & 14 per Team)
      if (leaguePairs.length !== 70) {
        throw new Error(`[ScheduleEngine] League fixtures assertion failed: expected 70 matches, got ${leaguePairs.length}`);
      }
      const matchCounts: Record<string, { home: number; away: number; total: number }> = {};
      for (const tId of teamIds.slice(0, 10)) {
        matchCounts[tId] = { home: 0, away: 0, total: 0 };
      }
      for (const p of leaguePairs) {
        matchCounts[p.home].home++;
        matchCounts[p.home].total++;
        matchCounts[p.away].away++;
        matchCounts[p.away].total++;
      }
      for (const [tId, c] of Object.entries(matchCounts)) {
        if (c.home !== 7 || c.away !== 7 || c.total !== 14) {
          throw new Error(`[ScheduleEngine] Team ${tId} schedule assertion failed: ${c.home}H/${c.away}A (${c.total} total), expected 7H/7A (14 total).`);
        }
      }

      // Smooth schedule shuffle with deterministic seed
      for (let i = leaguePairs.length - 1; i > 0; i--) {
        const j = (i * 37 + 13) % (i + 1);
        [leaguePairs[i], leaguePairs[j]] = [leaguePairs[j], leaguePairs[i]];
      }

      for (const pair of leaguePairs) {
        const home = room.teams[pair.home];
        const away = room.teams[pair.away];
        fixtures.push({
          matchId: `m_${matchCounter}`,
          matchNumber: matchCounter++,
          homeTeamId: home.franchiseId,
          awayTeamId: away.franchiseId,
          homeTeam: home.name,
          awayTeam: away.name,
          venueName: `${home.name} Stadium`,
          venuePitch: { spin: 0.35, pace: 0.45, power: 0.55, dew: 0.5 },
          tossWinner: '',
          tossDecision: 'BAT',
          innings1: {} as any,
          innings2: {} as any,
          winner: '',
          winnerTeamId: null,
          margin: '',
          marginText: 'Upcoming',
          playerOfTheMatch: { name: '', team: '', reason: '', impactPoints: 0 },
          matchHighlights: [],
          completed: false,
          isPlayoff: false
        });
      }
    } else {
      // Fallback for smaller testing rooms
      for (let i = 0; i < teamIds.length; i++) {
        for (let j = i + 1; j < teamIds.length; j++) {
          const home = room.teams[teamIds[i]];
          const away = room.teams[teamIds[j]];
          fixtures.push({
            matchId: `m_${matchCounter}`,
            matchNumber: matchCounter++,
            homeTeamId: home.franchiseId,
            awayTeamId: away.franchiseId,
            homeTeam: home.name,
            awayTeam: away.name,
            venueName: `${home.name} Ground`,
            venuePitch: { spin: 0.3, pace: 0.4, power: 0.5, dew: 0.5 },
            tossWinner: '',
            tossDecision: 'BAT',
            innings1: {} as any,
            innings2: {} as any,
            winner: '',
            winnerTeamId: null,
            margin: '',
            marginText: 'Upcoming',
            playerOfTheMatch: { name: '', team: '', reason: '', impactPoints: 0 },
            matchHighlights: [],
            completed: false,
            isPlayoff: false
          });
        }
      }
    }

    // 2. Playoff Matches (Matches 71 to 74)
    // Match 71: Qualifier 1 (Rank 1 vs Rank 2)
    fixtures.push({
      matchId: 'm_71',
      matchNumber: 71,
      homeTeamId: 'TBD_R1',
      awayTeamId: 'TBD_R2',
      homeTeam: 'League Rank 1',
      awayTeam: 'League Rank 2',
      venueName: 'Narendra Modi Stadium, Ahmedabad',
      venuePitch: { spin: 0.35, pace: 0.45, power: 0.6, dew: 0.5 },
      tossWinner: '',
      tossDecision: 'BAT',
      innings1: {} as any,
      innings2: {} as any,
      winner: '',
      winnerTeamId: null,
      margin: '',
      marginText: 'Qualifier 1: Rank 1 vs Rank 2 (Winner to Final, Loser to Q2)',
      playerOfTheMatch: { name: '', team: '', reason: '', impactPoints: 0 },
      matchHighlights: [],
      completed: false,
      isPlayoff: true,
      playoffStage: 'QUALIFIER_1'
    });

    // Match 72: Eliminator (Rank 3 vs Rank 4)
    fixtures.push({
      matchId: 'm_72',
      matchNumber: 72,
      homeTeamId: 'TBD_R3',
      awayTeamId: 'TBD_R4',
      homeTeam: 'League Rank 3',
      awayTeam: 'League Rank 4',
      venueName: 'MA Chidambaram Stadium, Chennai',
      venuePitch: { spin: 0.6, pace: 0.3, power: 0.4, dew: 0.4 },
      tossWinner: '',
      tossDecision: 'BAT',
      innings1: {} as any,
      innings2: {} as any,
      winner: '',
      winnerTeamId: null,
      margin: '',
      marginText: 'Eliminator: Rank 3 vs Rank 4 (Winner to Q2, Loser Eliminated)',
      playerOfTheMatch: { name: '', team: '', reason: '', impactPoints: 0 },
      matchHighlights: [],
      completed: false,
      isPlayoff: true,
      playoffStage: 'ELIMINATOR'
    });

    // Match 73: Qualifier 2 (Loser Q1 vs Winner Eliminator)
    fixtures.push({
      matchId: 'm_73',
      matchNumber: 73,
      homeTeamId: 'TBD_LOSER_Q1',
      awayTeamId: 'TBD_WINNER_ELIM',
      homeTeam: 'Loser Qualifier 1',
      awayTeam: 'Winner Eliminator',
      venueName: 'Eden Gardens, Kolkata',
      venuePitch: { spin: 0.4, pace: 0.4, power: 0.65, dew: 0.6 },
      tossWinner: '',
      tossDecision: 'BAT',
      innings1: {} as any,
      innings2: {} as any,
      winner: '',
      winnerTeamId: null,
      margin: '',
      marginText: 'Qualifier 2: Loser Q1 vs Winner Eliminator (Winner to Final)',
      playerOfTheMatch: { name: '', team: '', reason: '', impactPoints: 0 },
      matchHighlights: [],
      completed: false,
      isPlayoff: true,
      playoffStage: 'QUALIFIER_2'
    });

    // Match 74: IPL Grand Final 🏆
    fixtures.push({
      matchId: 'm_74',
      matchNumber: 74,
      homeTeamId: 'TBD_WINNER_Q1',
      awayTeamId: 'TBD_WINNER_Q2',
      homeTeam: 'Winner Qualifier 1',
      awayTeam: 'Winner Qualifier 2',
      venueName: 'Wankhede Stadium, Mumbai',
      venuePitch: { spin: 0.3, pace: 0.5, power: 0.7, dew: 0.65 },
      tossWinner: '',
      tossDecision: 'BAT',
      innings1: {} as any,
      innings2: {} as any,
      winner: '',
      winnerTeamId: null,
      margin: '',
      marginText: 'IPL 2026 Grand Final 🏆',
      playerOfTheMatch: { name: '', team: '', reason: '', impactPoints: 0 },
      matchHighlights: [],
      completed: false,
      isPlayoff: true,
      playoffStage: 'FINAL'
    });

    const firstFixture = fixtures[0];
    const isFirstHuman = Boolean(room.teams[firstFixture?.homeTeamId]?.isHuman || room.teams[firstFixture?.awayTeamId]?.isHuman);

    room.season = {
      currentMatchIndex: 0,
      totalMatches: fixtures.length,
      fixtures,
      standings,
      lineups,
      autoSkipAI: true,
      humanMatchWaitingForNext: false,
      matchLifecycle: {
        stage: 'PRE_MATCH_PREP',
        prepTimerMsRemaining: isFirstHuman ? 0 : 15000,
        resultTimerMsRemaining: 15000,
        readyTeamIds: [],
        simulateVotes: [],
        matchNumber: fixtures[0]?.matchNumber || 1,
        isHumanMatch: isFirstHuman
      }
    };

    this.startSeasonClock(room);
  }

  public ensurePlayoffTeamsAssigned(room: InternalRoomState) {
    if (!room.season || !room.season.fixtures || room.season.fixtures.length < 74) return;

    // 1. If League phase completed (>= 70 matches simulated or currentMatchIndex >= 70), setup Qualifier 1 (70) and Eliminator (71)
    const completedLeagueMatches = room.season.fixtures.slice(0, 70).filter(f => f.completed).length;
    if (completedLeagueMatches >= 70 || room.season.currentMatchIndex >= 70) {
      const q1 = room.season.fixtures[70];
      const elim = room.season.fixtures[71];
      if (q1 && elim && (q1.homeTeamId.startsWith('TBD') || elim.homeTeamId.startsWith('TBD'))) {
        const sorted = Object.values(room.season.standings).sort((a, b) => {
          if (b.points !== a.points) return b.points - a.points;
          return b.nrr - a.nrr;
        });
        const r1 = room.teams[sorted[0]?.teamId] || Object.values(room.teams)[0];
        const r2 = room.teams[sorted[1]?.teamId] || Object.values(room.teams)[1];
        const r3 = room.teams[sorted[2]?.teamId] || Object.values(room.teams)[2];
        const r4 = room.teams[sorted[3]?.teamId] || Object.values(room.teams)[3];

        q1.homeTeamId = r1.franchiseId;
        q1.awayTeamId = r2.franchiseId;
        q1.homeTeam = r1.name;
        q1.awayTeam = r2.name;
        q1.marginText = `Qualifier 1: ${r1.name} (Rank 1) vs ${r2.name} (Rank 2)`;

        elim.homeTeamId = r3.franchiseId;
        elim.awayTeamId = r4.franchiseId;
        elim.homeTeam = r3.name;
        elim.awayTeam = r4.name;
        elim.marginText = `Eliminator: ${r3.name} (Rank 3) vs ${r4.name} (Rank 4)`;
      }
    }

    // 2. If Qualifier 1 (70) is completed, setup Grand Final (73) homeTeam and Qualifier 2 (72) homeTeam
    const q1 = room.season.fixtures[70];
    if (q1 && q1.completed) {
      const winnerId = q1.winnerTeamId || q1.homeTeamId;
      const loserId = winnerId === q1.homeTeamId ? q1.awayTeamId : q1.homeTeamId;
      const winnerTeam = room.teams[winnerId];
      const loserTeam = room.teams[loserId];

      const grandFinal = room.season.fixtures[73];
      if (grandFinal && winnerTeam && (grandFinal.homeTeamId.startsWith('TBD') || grandFinal.homeTeamId !== winnerTeam.franchiseId)) {
        grandFinal.homeTeamId = winnerTeam.franchiseId;
        grandFinal.homeTeam = winnerTeam.name;
      }

      const q2 = room.season.fixtures[72];
      if (q2 && loserTeam && (q2.homeTeamId.startsWith('TBD') || q2.homeTeamId !== loserTeam.franchiseId)) {
        q2.homeTeamId = loserTeam.franchiseId;
        q2.homeTeam = loserTeam.name;
      }
    }

    // 3. If Eliminator (71) is completed, setup Qualifier 2 (72) awayTeam
    const elim = room.season.fixtures[71];
    if (elim && elim.completed) {
      const winnerId = elim.winnerTeamId || elim.homeTeamId;
      const winnerTeam = room.teams[winnerId];

      const q2 = room.season.fixtures[72];
      if (q2 && winnerTeam && (q2.awayTeamId.startsWith('TBD') || q2.awayTeamId !== winnerTeam.franchiseId)) {
        q2.awayTeamId = winnerTeam.franchiseId;
        q2.awayTeam = winnerTeam.name;
        q2.marginText = `Qualifier 2: ${q2.homeTeam} vs ${winnerTeam.name}`;
      }
    }

    // 4. If Qualifier 2 (72) is completed, setup Grand Final (73) awayTeam
    const q2 = room.season.fixtures[72];
    if (q2 && q2.completed) {
      const winnerId = q2.winnerTeamId || q2.homeTeamId;
      const winnerTeam = room.teams[winnerId];

      const grandFinal = room.season.fixtures[73];
      if (grandFinal && winnerTeam && (grandFinal.awayTeamId.startsWith('TBD') || grandFinal.awayTeamId !== winnerTeam.franchiseId)) {
        grandFinal.awayTeamId = winnerTeam.franchiseId;
        grandFinal.awayTeam = winnerTeam.name;
        grandFinal.marginText = `IPL 2026 Grand Final: ${grandFinal.homeTeam} vs ${winnerTeam.name} 🏆`;
      }
    }
  }

  public async handleSimulateVote(
    room: InternalRoomState,
    socket: Socket,
    userTeamId?: string,
    isHostOverride: boolean = false
  ): Promise<void> {
    if (!room.season || room.status !== 'SEASON') return;

    // Host God Controls (isHost: true): Host alone can instantly trigger simulation overriding all pending votes
    if (isHostOverride) {
      socket.data.isHost = true;
      this.pushCommentary(room, '[⚡ Host God Control] Force simulating match...');
      await this.advanceSeasonMatch(room);
      return;
    }

    const fixture = room.season.fixtures[room.season.currentMatchIndex];
    if (!fixture || fixture.completed) {
      await this.advanceSeasonMatch(room);
      return;
    }

    const isHomeHuman = Boolean(room.teams[fixture.homeTeamId]?.isHuman);
    const isAwayHuman = Boolean(room.teams[fixture.awayTeamId]?.isHuman);

    if (!room.season.matchLifecycle) {
      room.season.matchLifecycle = {
        stage: 'PRE_MATCH_PREP',
        prepTimerMsRemaining: (isHomeHuman || isAwayHuman) ? 0 : 15000,
        resultTimerMsRemaining: 15000,
        readyTeamIds: [],
        simulateVotes: [],
        matchNumber: fixture.matchNumber,
        isHumanMatch: isHomeHuman || isAwayHuman
      };
    }

    const ml = room.season.matchLifecycle;
    ml.simulateVotes = ml.simulateVotes || [];
    ml.readyTeamIds = ml.readyTeamIds || [];

    // CASE 1: AI vs AI (Neither team is human)
    // Rule: Room socket tracks human votes. Once > 50% of active humans in the room vote "Simulate", simulates immediately.
    if (!isHomeHuman && !isAwayHuman) {
      const voterId = userTeamId || socket.id;
      if (!ml.simulateVotes.includes(voterId)) {
        ml.simulateVotes.push(voterId);
      }
      if (userTeamId && !ml.readyTeamIds.includes(userTeamId)) {
        ml.readyTeamIds.push(userTeamId);
      }

      const activeHumans = room.seats.filter(s => s.isHuman);
      const totalHumans = Math.max(1, activeHumans.length);
      const voteRatio = ml.simulateVotes.length / totalHumans;

      if (voteRatio > 0.5) {
        this.pushCommentary(room, `Voting threshold passed (${ml.simulateVotes.length}/${totalHumans} humans voted). Simulating Match #${fixture.matchNumber}...`);
        ml.simulateVotes = [];
        ml.readyTeamIds = [];
        await this.advanceSeasonMatch(room);
      } else {
        this.pushCommentary(room, `Vote recorded (${ml.simulateVotes.length}/${totalHumans} humans voted to simulate, >50% needed).`);
        this.broadcastRoomState(room.roomCode);
      }
      return;
    }

    // CASE 2: Human vs Human (Both teams are human)
    // Rule: Only the 2 playing humans can vote. Both must submit VOTE_SIMULATE for the match to simulate without watching.
    if (isHomeHuman && isAwayHuman) {
      if (userTeamId !== fixture.homeTeamId && userTeamId !== fixture.awayTeamId) {
        socket.emit('error_message', { message: 'Only the two competing human managers can vote to simulate this match.' });
        return;
      }

      if (!ml.readyTeamIds.includes(userTeamId)) {
        ml.readyTeamIds.push(userTeamId);
      }
      if (!ml.simulateVotes.includes(userTeamId)) {
        ml.simulateVotes.push(userTeamId);
      }

      const homeVoted = ml.readyTeamIds.includes(fixture.homeTeamId);
      const awayVoted = ml.readyTeamIds.includes(fixture.awayTeamId);

      if (homeVoted && awayVoted) {
        this.pushCommentary(room, `Both human managers agreed to simulate! Simulating Match #${fixture.matchNumber}...`);
        ml.simulateVotes = [];
        ml.readyTeamIds = [];
        await this.advanceSeasonMatch(room);
      } else {
        const teamName = room.teams[userTeamId]?.name || userTeamId;
        this.pushCommentary(room, `✓ ${teamName} voted to simulate (1/2). Waiting for opponent...`);
        this.broadcastRoomState(room.roomCode);
      }
      return;
    }

    // CASE 3: Human vs AI (One team is human)
    // Rule: Only the playing human has the vote. If they click "Simulate", it simulates instantly.
    if ((isHomeHuman && !isAwayHuman) || (!isHomeHuman && isAwayHuman)) {
      const activeHumanTeamId = isHomeHuman ? fixture.homeTeamId : fixture.awayTeamId;
      if (userTeamId === activeHumanTeamId) {
        this.pushCommentary(room, `${room.teams[activeHumanTeamId]?.name} launched match simulation!`);
        ml.simulateVotes = [];
        ml.readyTeamIds = [];
        await this.advanceSeasonMatch(room);
      } else {
        socket.emit('error_message', { message: `Only ${room.teams[activeHumanTeamId]?.name || 'the active human manager'} can simulate this fixture.` });
      }
      return;
    }
  }

  public async advanceSeasonMatch(room: InternalRoomState) {
    if (!room.season) return;
    if (room.isAdvancingMatch) return;
    room.isAdvancingMatch = true;

    try {
      const matchIdx = room.season.currentMatchIndex;
      if (matchIdx >= room.season.fixtures.length) {
        this.pushCommentary(room, 'Season tournament completed! Check Final Standings and Season Stats.');
        return;
      }

      const fixture = room.season.fixtures[matchIdx];
      if (!fixture) return;

      // If already completed, skip duplicate processing
      if (fixture.completed) {
        room.season.currentMatchIndex++;
        this.ensurePlayoffTeamsAssigned(room);
        return;
      }

      this.ensurePlayoffTeamsAssigned(room);

      if (fixture.homeTeamId.startsWith('TBD') || fixture.awayTeamId.startsWith('TBD')) {
        this.pushCommentary(room, `Cannot play Match #${fixture.matchNumber}: Participating teams are not yet determined.`);
        return;
      }

      const teamA = room.teams[fixture.homeTeamId];
      const teamB = room.teams[fixture.awayTeamId];

      let lineupA = room.season.lineups[fixture.homeTeamId];
      if (!lineupA || !lineupA.playing11Ids || lineupA.playing11Ids.length !== 11 || !validate352Lineup(lineupA, teamA.squad).valid) {
        const profA = DEFAULT_IPL_FRANCHISES.find(p => p.id === teamA.franchiseId);
        lineupA = teamA.isHuman
          ? TeamMaker.selectNaiveHumanAutoFill(teamA.squad, teamA.franchiseId)
          : TeamMaker.selectEliteAILineup(teamA.squad, profA?.homePitch, undefined, teamA.franchiseId);
        room.season.lineups[fixture.homeTeamId] = lineupA;
      }

      let lineupB = room.season.lineups[fixture.awayTeamId];
      if (!lineupB || !lineupB.playing11Ids || lineupB.playing11Ids.length !== 11 || !validate352Lineup(lineupB, teamB.squad).valid) {
        const profB = DEFAULT_IPL_FRANCHISES.find(p => p.id === teamB.franchiseId);
        lineupB = teamB.isHuman
          ? TeamMaker.selectNaiveHumanAutoFill(teamB.squad, teamB.franchiseId)
          : TeamMaker.selectEliteAILineup(teamB.squad, profB?.homePitch, undefined, teamB.franchiseId);
        room.season.lineups[fixture.awayTeamId] = lineupB;
      }

      const getPlayerA = (id: string): IPLPlayer =>
        teamA.squad.find(p => p.id === id) ||
        room.allPlayers.find(p => p.id === id) ||
        teamA.squad.find(p => !p.isOverseas && TeamMaker.isBowler(p)) ||
        teamA.squad[0];

      let xiA = lineupA.playing11Ids.map(id => getPlayerA(id));

      if (xiA.length !== 11 || !validate352Lineup(lineupA, teamA.squad).valid) {
        const profA = DEFAULT_IPL_FRANCHISES.find(p => p.id === teamA.franchiseId);
        lineupA = TeamMaker.selectEliteAILineup(teamA.squad, profA?.homePitch, undefined, teamA.franchiseId);
        room.season.lineups[fixture.homeTeamId] = lineupA;
        xiA = lineupA.playing11Ids.map(id => getPlayerA(id));
      }

      const getPlayerB = (id: string): IPLPlayer =>
        teamB.squad.find(p => p.id === id) ||
        room.allPlayers.find(p => p.id === id) ||
        teamB.squad.find(p => !p.isOverseas && TeamMaker.isBowler(p)) ||
        teamB.squad[0];

      let xiB = lineupB.playing11Ids.map(id => getPlayerB(id));

      if (xiB.length !== 11 || !validate352Lineup(lineupB, teamB.squad).valid) {
        const profB = DEFAULT_IPL_FRANCHISES.find(p => p.id === teamB.franchiseId);
        lineupB = TeamMaker.selectEliteAILineup(teamB.squad, profB?.homePitch, undefined, teamB.franchiseId);
        room.season.lineups[fixture.awayTeamId] = lineupB;
        xiB = lineupB.playing11Ids.map(id => getPlayerB(id));
      }

      // Strictly order xiA and xiB by designated battingOrder
      const orderA = (lineupA.battingOrder && lineupA.battingOrder.length === 11) ? lineupA.battingOrder : lineupA.playing11Ids;
      xiA.sort((a, b) => orderA.indexOf(a.id) - orderA.indexOf(b.id));

      const orderB = (lineupB.battingOrder && lineupB.battingOrder.length === 11) ? lineupB.battingOrder : lineupB.playing11Ids;
      xiB.sort((a, b) => orderB.indexOf(a.id) - orderB.indexOf(b.id));

      const deathA = [lineupA.bowlerPool352.deathOver17_19BowlerId, lineupA.bowlerPool352.deathOver18_20BowlerId].filter(Boolean);
      const simTeamA: Team2026 = {
        id: teamA.franchiseId,
        name: teamA.name,
        playingXI: xiA,
        primaryBowlers: lineupA.bowlerPool352.middleBowlerIds,
        powerplayBowlers: lineupA.bowlerPool352.powerplayBowlerIds,
        deathBowlers: deathA.length === 2 ? deathA : (lineupA.bowlerPool352.deathBowlerIds || []),
        firstBowlerId: lineupA.bowlerPool352.firstBowlerId,
        backupBowlerId: lineupA.bowlerPool352.backupBowlerId,
        bowlerPool352: lineupA.bowlerPool352
      };

      const deathB = [lineupB.bowlerPool352.deathOver17_19BowlerId, lineupB.bowlerPool352.deathOver18_20BowlerId].filter(Boolean);
      const simTeamB: Team2026 = {
        id: teamB.franchiseId,
        name: teamB.name,
        playingXI: xiB,
        primaryBowlers: lineupB.bowlerPool352.middleBowlerIds,
        powerplayBowlers: lineupB.bowlerPool352.powerplayBowlerIds,
        deathBowlers: deathB.length === 2 ? deathB : (lineupB.bowlerPool352.deathBowlerIds || []),
        firstBowlerId: lineupB.bowlerPool352.firstBowlerId,
        backupBowlerId: lineupB.bowlerPool352.backupBowlerId,
        bowlerPool352: lineupB.bowlerPool352
      };

      if (room.determinismRatio !== undefined) {
        this.matchSimulator.setHostRandomnessScale(room.determinismRatio);
      }
      const result = await this.matchSimulator.simulateFullMatch(fixture.matchNumber, simTeamA, simTeamB);
      result.isPlayoff = fixture.isPlayoff;
      result.playoffStage = fixture.playoffStage;
      result.completed = true;
      room.season.fixtures[matchIdx] = result;

      // Update standings (only during League Stage, matches 1 to 70)
      if (matchIdx < 70) {
        const sA = room.season.standings[fixture.homeTeamId];
        const sB = room.season.standings[fixture.awayTeamId];

        if (sA && sB) {
          sA.played++;
          sB.played++;
          sA.totalRunsScored += result.innings1.totalRuns;
          sA.totalOversBatted += result.innings1.oversCompleted;
          sA.totalRunsConceded += result.innings2.totalRuns;
          sA.totalOversBowled += result.innings2.oversCompleted;

          sB.totalRunsScored += result.innings2.totalRuns;
          sB.totalOversBatted += result.innings2.oversCompleted;
          sB.totalRunsConceded += result.innings1.totalRuns;
          sB.totalOversBowled += result.innings1.oversCompleted;

          const forRateA = sA.totalOversBatted > 0 ? sA.totalRunsScored / sA.totalOversBatted : 0;
          const againstRateA = sA.totalOversBowled > 0 ? sA.totalRunsConceded / sA.totalOversBowled : 0;
          sA.nrr = Math.round((forRateA - againstRateA) * 1000) / 1000;

          const forRateB = sB.totalOversBatted > 0 ? sB.totalRunsScored / sB.totalOversBatted : 0;
          const againstRateB = sB.totalOversBowled > 0 ? sB.totalRunsConceded / sB.totalOversBowled : 0;
          sB.nrr = Math.round((forRateB - againstRateB) * 1000) / 1000;

          if (result.winnerTeamId === sA.teamId) {
            sA.won++;
            sA.points += 2;
            sA.recentForm.push('W');
            sB.lost++;
            sB.recentForm.push('L');
          } else if (result.winnerTeamId === sB.teamId) {
            sB.won++;
            sB.points += 2;
            sB.recentForm.push('W');
            sA.lost++;
            sA.recentForm.push('L');
          } else {
            sA.tied++;
            sB.tied++;
            sA.points += 1;
            sB.points += 1;
            sA.recentForm.push('T');
            sB.recentForm.push('T');
          }
        }
      }

      room.season.currentMatchIndex++;
      this.pushCommentary(room, `[MATCH ${fixture.matchNumber}] ${result.marginText} | POTM: ${result.playerOfTheMatch.name}`);

      this.ensurePlayoffTeamsAssigned(room);

      // Check Grand Final Completion (Match 74, index 73)
      if (matchIdx === 73 && room.season.fixtures.length >= 74) {
        const grandFinal = room.season.fixtures[73];
        const champId = result.winnerTeamId || grandFinal.homeTeamId;
        const champTeam = room.teams[champId];
        room.season.championTeamId = champId;
        this.pushCommentary(room, `🏆🎉 ${champTeam?.name || 'Champion'} ARE THE IPL 2026 CHAMPIONS! 🏆🎉`);
      }

      const nextFixture = room.season.fixtures[room.season.currentMatchIndex];
      const isNextHuman = nextFixture ? Boolean(room.teams[nextFixture.homeTeamId]?.isHuman || room.teams[nextFixture.awayTeamId]?.isHuman) : false;

      if (!room.season.matchLifecycle) {
        room.season.matchLifecycle = {
          stage: 'RESULT_VIEW',
          prepTimerMsRemaining: isNextHuman ? 0 : 15000,
          resultTimerMsRemaining: 15000,
          readyTeamIds: [],
          simulateVotes: [],
          matchNumber: fixture.matchNumber,
          isHumanMatch: isNextHuman
        };
      } else {
        room.season.matchLifecycle.stage = 'RESULT_VIEW';
        room.season.matchLifecycle.resultTimerMsRemaining = 15000;
        room.season.matchLifecycle.readyTeamIds = [];
        room.season.matchLifecycle.simulateVotes = [];
        room.season.matchLifecycle.matchNumber = fixture.matchNumber;
        room.season.matchLifecycle.isHumanMatch = isNextHuman;
      }

      room.isDirty = true;
      this.flushRoomToMongoDB(room);
      this.broadcastRoomState(room.roomCode);
      if (!room.seasonClockInterval) {
        this.startSeasonClock(room);
      }
    } catch (simErr) {
      console.error(`[SeasonEngine] Error simulating match:`, simErr);
      this.pushCommentary(room, `Simulation error on current fixture. Retrying with balanced parameters.`);
    } finally {
      room.isAdvancingMatch = false;
    }
  }

  public startSeasonClock(room: InternalRoomState) {
    if (room.seasonClockInterval) {
      clearInterval(room.seasonClockInterval);
      room.seasonClockInterval = null;
    }

    room.seasonClockInterval = setInterval(async () => {
      if (room.status !== 'SEASON' || !room.season) {
        if (room.seasonClockInterval) {
          clearInterval(room.seasonClockInterval);
          room.seasonClockInterval = null;
        }
        return;
      }
      if (room.isPaused) return;

      const matchIdx = room.season.currentMatchIndex;
      if (matchIdx >= room.season.fixtures.length) {
        if (room.seasonClockInterval) {
          clearInterval(room.seasonClockInterval);
          room.seasonClockInterval = null;
        }
        return;
      }

      const fixture = room.season.fixtures[matchIdx];
      if (!fixture) return;

      const isHumanMatch = Boolean(room.teams[fixture.homeTeamId]?.isHuman || room.teams[fixture.awayTeamId]?.isHuman);

      if (!room.season.matchLifecycle) {
        room.season.matchLifecycle = {
          stage: fixture.completed ? 'RESULT_VIEW' : 'PRE_MATCH_PREP',
          prepTimerMsRemaining: isHumanMatch ? 0 : 15000,
          resultTimerMsRemaining: 15000,
          readyTeamIds: [],
          simulateVotes: [],
          matchNumber: fixture.matchNumber,
          isHumanMatch
        };
      }

      const ml = room.season.matchLifecycle;
      ml.isHumanMatch = isHumanMatch;

      // Auto unfreeze if stuck in SIMULATING
      if (ml.stage === 'SIMULATING' && !room.isAdvancingMatch) {
        ml.stage = 'RESULT_VIEW';
        ml.resultTimerMsRemaining = 15000;
        this.broadcastRoomState(room.roomCode);
        return;
      }

      if (ml.stage === 'PRE_MATCH_PREP') {
        if (isHumanMatch) {
          // Remove Timer for Humans: Humans have infinite time to adjust their squad, lineup, and tactics.
          // No countdown will auto-submit or penalize them.
          ml.prepTimerMsRemaining = 0;
        } else {
          // AI vs AI: 15-second auto-start countdown
          ml.prepTimerMsRemaining = Math.max(0, ml.prepTimerMsRemaining - 1000);
          if (ml.prepTimerMsRemaining <= 0) {
            ml.prepTimerMsRemaining = 0;
            ml.stage = 'SIMULATING';
            this.broadcastRoomState(room.roomCode);
            await this.advanceSeasonMatch(room);
          } else {
            this.broadcastRoomState(room.roomCode);
          }
        }
      } else if (ml.stage === 'RESULT_VIEW') {
        // Post-match scorecard modal has a 15-second countdown before auto-advancing to the next scheduled match
        ml.resultTimerMsRemaining = Math.max(0, ml.resultTimerMsRemaining - 1000);
        if (ml.resultTimerMsRemaining <= 0) {
          ml.resultTimerMsRemaining = 0;
          const nextIdx = room.season.currentMatchIndex;
          const nextFixture = room.season.fixtures[nextIdx];
          if (nextFixture) {
            const isNextHuman = Boolean(room.teams[nextFixture.homeTeamId]?.isHuman || room.teams[nextFixture.awayTeamId]?.isHuman);
            ml.stage = 'PRE_MATCH_PREP';
            ml.prepTimerMsRemaining = isNextHuman ? 0 : 15000;
            ml.resultTimerMsRemaining = 15000;
            ml.readyTeamIds = [];
            ml.simulateVotes = [];
            ml.isHumanMatch = isNextHuman;
            ml.matchNumber = nextFixture.matchNumber;
          }
          this.broadcastRoomState(room.roomCode);
        } else {
          this.broadcastRoomState(room.roomCode);
        }
      }
    }, 1000);
  }

  // ==========================================
  // PERSISTENCE & BROADCAST (Auto-Save every 60 seconds)
  // ==========================================

  private startAutoSaveLoop() {
    this.autoSaveTimer = setInterval(async () => {
      for (const room of this.rooms.values()) {
        if (room.isDirty) {
          await this.flushRoomToMongoDB(room);
          this.io.to(room.roomCode).emit('save_status', {
            success: true,
            timestamp: Date.now(),
            message: 'Saved to Cloud ✓'
          });
        }
      }
    }, 60000); // 60-second interval (reduces DB write load and eliminates UI toast churn)
  }

  private start7SecondAutoSaveLoop() {
    this.startAutoSaveLoop();
  }

  public async flushRoomToMongoDB(room: InternalRoomState): Promise<void> {
    try {
      room.isDirty = false;
      room.lastSavedAt = Date.now();

      // Auto-reconnect to MongoDB if connection was delayed or restored
      const mongoose = await import('mongoose');
      let isDbConnected = mongoose.default.connection.readyState === 1;
      if (!isDbConnected) {
        const { connectToDatabase } = await import('../lib/mongodb');
        await connectToDatabase();
        isDbConnected = mongoose.default.connection.readyState === 1;
      }
      if (!isDbConnected) {
        return;
      }

      await GameRoom.updateOne(
        { roomCode: room.roomCode },
        {
          $set: {
            roomCode: room.roomCode,
            hostId: room.hostId,
            hostUsername: room.hostUsername || 'admin',
            status: room.status,
            phase: room.phase,
            determinismRatio: room.determinismRatio,
            humanTaxEnabled: room.humanTaxEnabled,
            acceleratedRoundMode: room.acceleratedRoundMode,
            isPaused: room.isPaused,
            seats: room.seats,
            teams: room.teams,
            completedLots: room.completedLots,
            seasonStats: room.season?.standings || {},
            season: room.season || null,
            specVersion: 'V1.7',
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    } catch (e) {
      console.warn(`[AutoSave] Could not save room ${room.roomCode} to DB:`, (e as Error).message);
    }
  }

  public broadcastRoomState(roomCode: string) {
    if (!this.io) return;
    const room = this.getRoom(roomCode);
    if (!room) return;

    const dto = this.bidderAI.sanitizeRoomDTO(room);
    const upper = room.roomCode.toUpperCase().trim();
    const lower = room.roomCode.toLowerCase().trim();
    this.io.to(upper).emit('room_update', dto);
    if (upper !== lower) {
      this.io.to(lower).emit('room_update', dto);
    }
  }

  public pushCommentary(room: InternalRoomState, text: string) {
    room.commentaryTicker.unshift(`[${new Date().toLocaleTimeString()}] ${text}`);
    if (room.commentaryTicker.length > 30) room.commentaryTicker.pop();
  }
}

import mongoose, { Schema, Document, Model } from 'mongoose';
import { env } from './env';

export interface IHostUser extends Document {
  email: string;
  name: string;
  passwordHash: string;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const HostUserSchema = new Schema<IHostUser>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  isVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export interface IEmailOtp extends Document {
  email: string;
  otpHash: string;
  expiresAt: Date;
  purpose: 'REGISTER' | 'LOGIN_OTP';
  createdAt: Date;
}

const EmailOtpSchema = new Schema<IEmailOtp>({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  otpHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  purpose: { type: String, enum: ['REGISTER', 'LOGIN_OTP'], default: 'REGISTER' },
  createdAt: { type: Date, default: Date.now }
});

export interface IGameRoom extends Document {
  roomCode: string;
  hostId: string;
  hostUsername: string;
  status: string;
  phase: string;
  determinismRatio: number;
  humanTaxEnabled: boolean;
  acceleratedRoundMode: string;
  isPaused: boolean;
  seats: any[];
  teams: Record<string, any>;
  currentLot: any;
  completedLots: any[];
  wishlistTimer: any;
  matchSchedule: any[];
  seasonStats: any;
  season?: any;
  rawState: any;
  specVersion: string;
  updatedAt: Date;
}

const GameRoomSchema = new Schema<IGameRoom>({
  roomCode: { type: String, required: true, unique: true, index: true },
  hostId: { type: String, required: true, index: true },
  hostUsername: { type: String, default: 'admin' },
  status: { type: String, default: 'LOBBY' },
  phase: { type: String, default: 'MAIN' },
  determinismRatio: { type: Number, default: 0.45 },
  humanTaxEnabled: { type: Boolean, default: true },
  acceleratedRoundMode: { type: String, default: '1-ACC' },
  isPaused: { type: Boolean, default: false },
  seats: [Schema.Types.Mixed],
  teams: { type: Schema.Types.Mixed, default: {} },
  currentLot: { type: Schema.Types.Mixed, default: null },
  completedLots: [Schema.Types.Mixed],
  wishlistTimer: { type: Schema.Types.Mixed, default: {} },
  matchSchedule: [Schema.Types.Mixed],
  seasonStats: { type: Schema.Types.Mixed, default: {} },
  season: { type: Schema.Types.Mixed, default: null },
  rawState: { type: Schema.Types.Mixed, default: {} },
  specVersion: { type: String, default: 'V1.7' },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

GameRoomSchema.index({ hostId: 1, updatedAt: -1 });

export const HostUser: Model<IHostUser> = mongoose.models.HostUser || mongoose.model<IHostUser>('HostUser', HostUserSchema);
export const EmailOtp: Model<IEmailOtp> = mongoose.models.EmailOtp || mongoose.model<IEmailOtp>('EmailOtp', EmailOtpSchema);
export const GameRoom: Model<IGameRoom> = mongoose.models.GameRoom || mongoose.model<IGameRoom>('GameRoom', GameRoomSchema);

// Prevent unhandled rejection / uncaught error from Mongoose EventEmitter
if (mongoose.connection && typeof mongoose.connection.on === 'function') {
  mongoose.connection.on('error', (err) => {
    console.warn('[MongoDB Driver SSL/Socket Warning - Ignored]:', (err as Error)?.message || err);
  });
}

// Singleton MongoDB Connection Helper
let isConnected = false;
let connectionPromise: Promise<typeof mongoose | null> | null = null;
let lastFailureTime = 0;

export async function connectToDatabase(): Promise<typeof mongoose | null> {
  try {
    mongoose.set('bufferCommands', false);
    if (isConnected && mongoose.connection.readyState === 1) {
      return mongoose;
    }

    // Throttle reconnection attempts when Atlas has TLS/IP block, so requests don't hang
    const now = Date.now();
    if (lastFailureTime && (now - lastFailureTime < 25000)) {
      return null;
    }

    if (connectionPromise) {
      return await connectionPromise;
    }

    connectionPromise = (async () => {
      try {
        mongoose.set('sanitizeFilter', true);
        const conn = await mongoose.connect(env.MONGODB_URI, {
          serverSelectionTimeoutMS: 3000,
          connectTimeoutMS: 3000,
          family: 4, // Force IPv4 on Windows to prevent dual-stack DNS TLS alerts
        });
        isConnected = true;
        lastFailureTime = 0;
        console.log('[MongoDB] Connected successfully to database');
        return conn;
      } catch (err) {
        lastFailureTime = Date.now();
        isConnected = false;
        console.warn('[MongoDB Atlas Handshake Warning - Safe RAM fallback active]:', (err as Error)?.message || err);
        return null;
      } finally {
        connectionPromise = null;
      }
    })();

    return await connectionPromise;
  } catch (outerErr) {
    lastFailureTime = Date.now();
    connectionPromise = null;
    console.warn('[MongoDB Connection Guard]:', (outerErr as Error)?.message || outerErr);
    return null;
  }
}

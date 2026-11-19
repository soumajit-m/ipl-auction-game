/**
 * server.ts - Unified Next.js Custom Server + Socket.io Monorepo Entry Point
 * Stateful RAM Map<roomCode, RoomState> + 7s Debounced MongoDB Persistence Loop
 */

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';
import { connectToDatabase } from './src/lib/mongodb';
import { SocketHub } from './src/server/socketHub';
import { env } from './src/lib/env';
import { IPLPlayer } from './src/types/player.types';

const dev = env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function bootstrap() {
  try {
    await app.prepare();

    // 1. Connect to MongoDB
    await connectToDatabase();

    // 2. Load Active Players Dataset (prioritizing cleaned & verified players_active_fixed.json)
    const fixedPath = path.resolve(process.cwd(), 'public/data/players_active_fixed.json');
    const fallbackPath = path.resolve(process.cwd(), 'public/data/players_active.json');
    const playersPath = fs.existsSync(fixedPath) ? fixedPath : fallbackPath;
    let allPlayers: IPLPlayer[] = [];
    if (fs.existsSync(playersPath)) {
      allPlayers = JSON.parse(fs.readFileSync(playersPath, 'utf-8'));
      console.log(`[Boot] Loaded ${allPlayers.length} verified players from ${playersPath}`);
    } else {
      console.warn(`[Boot] Warning: ${playersPath} not found!`);
    }

    // 3. Create HTTP & Socket.io Server
    const server = createServer(async (req, res) => {
      try {
        const parsedUrl = parse(req.url!, true);
        await handle(req, res, parsedUrl);
      } catch (err) {
        console.error('[HTTP] Error handling request:', err);
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    });

    const io = new SocketIOServer(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      },
      pingTimeout: 10000,
      pingInterval: 5000
    });

    // 4. Initialize Authoritative SocketHub
    const socketHub = new SocketHub(io, allPlayers);

    // Attach socket connection listener
    io.on('connection', (socket) => {
      socketHub.handleConnection(socket);
    });

    // Make socketHub available globally on server for API route mutations if needed
    (global as any).socketHub = socketHub;

    server.listen(port, '0.0.0.0', () => {
      console.log(`> Server ready on http://localhost:${port}`);
      console.log(`> Network access (Same Wi-Fi): http://10.32.29.44:${port}`);
      console.log(`> Mode: ${env.NODE_ENV} | Fast Clock: ${env.DEV_FAST_CLOCK}`);
    });
  } catch (error) {
    console.error('[Fatal] Error starting custom server:', error);
    process.exit(1);
  }
}

bootstrap();

import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { getHostFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const host = getHostFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { determinismRatio = 0.45, aiAggression = 0.45, humanTaxEnabled = true, minOvr } = body;

    const hostId = host?.hostId || body.hostId || 'admin_host_1';
    const hostUsername = host?.username || body.hostUsername || 'admin';

    const socketHub = (global as any).socketHub;
    if (!socketHub) {
      return NextResponse.json({ error: 'Server initializing' }, { status: 503 });
    }

    // Generate random 6-character room PIN like IPL-8X9K
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let pin = 'IPL-';
    for (let i = 0; i < 4; i++) {
      pin += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const fixedPath = path.resolve(process.cwd(), 'public/data/players_active_fixed.json');
    const fallbackPath = path.resolve(process.cwd(), 'public/data/players_active.json');
    const playersPath = fs.existsSync(fixedPath) ? fixedPath : fallbackPath;
    let players = JSON.parse(fs.readFileSync(playersPath, 'utf-8'));

    // Filter lot pool by minimum OVR if host configured slider (60 to 75)
    if (typeof minOvr === 'number' && minOvr >= 60 && minOvr <= 75) {
      players = players.filter((p: any) => (p.stats?.ovr || 0) >= minOvr);
    }

    const room = socketHub.createRoom(
      pin,
      hostId,
      players,
      determinismRatio,
      humanTaxEnabled,
      hostUsername,
      aiAggression
    );

    return NextResponse.json({
      success: true,
      roomCode: room.roomCode,
      hostId: room.hostId,
      hostUsername: room.hostUsername,
      status: room.status
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { GameRoom, connectToDatabase } from '@/lib/mongodb';
import { getHostFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const host = getHostFromRequest(req);
    const url = new URL(req.url);
    const queryHostId = url.searchParams.get('hostId');

    const effectiveHostId = host?.hostId || queryHostId;
    if (!effectiveHostId) {
      return NextResponse.json({ success: true, rooms: [] });
    }

    let rooms: any[] = [];
    try {
      await connectToDatabase();
      const isDbConnected = (await import('mongoose')).default.connection.readyState === 1;

      if (isDbConnected) {
        rooms = await GameRoom.find({ hostId: effectiveHostId })
          .sort({ updatedAt: -1 })
          .limit(15)
          .select('roomCode hostId hostUsername status phase determinismRatio updatedAt completedLots')
          .lean();
      }
    } catch (dbErr) {
      console.warn('[host-history] MongoDB query warning, falling back to active RAM rooms:', (dbErr as Error).message);
    }

    if (rooms.length === 0) {
      // In-memory fallback lookup from active roomsMap
      const socketHub = (global as any).socketHub;
      if (socketHub && socketHub.rooms) {
        for (const r of socketHub.rooms.values()) {
          if (r.hostId === effectiveHostId) {
            rooms.push({
              roomCode: r.roomCode,
              hostId: r.hostId,
              hostUsername: r.hostUsername || 'admin',
              status: r.status,
              phase: r.phase,
              determinismRatio: r.determinismRatio,
              completedLots: r.completedLots || [],
              updatedAt: new Date(r.lastSavedAt || Date.now())
            });
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      rooms: rooms.map(r => ({
        roomCode: r.roomCode,
        hostId: r.hostId,
        hostUsername: r.hostUsername,
        status: r.status,
        phase: r.phase,
        determinismRatio: r.determinismRatio,
        completedLotsCount: Array.isArray(r.completedLots) ? r.completedLots.length : 0,
        updatedAt: r.updatedAt
      }))
    });
  } catch (error) {
    return NextResponse.json({ success: true, rooms: [] });
  }
}

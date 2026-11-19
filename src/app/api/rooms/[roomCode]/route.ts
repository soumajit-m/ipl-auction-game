import { NextResponse } from 'next/server';
import { GameRoom, connectToDatabase } from '@/lib/mongodb';
import { getHostFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  { params }: { params: { roomCode: string } }
) {
  try {
    const roomCode = params.roomCode.toUpperCase().trim();
    const host = getHostFromRequest(req);
    const url = new URL(req.url);
    const queryHostId = url.searchParams.get('hostId');
    const effectiveHostId = host?.hostId || queryHostId;

    if (!effectiveHostId) {
      return NextResponse.json({ error: 'Unauthorized: Host credentials required' }, { status: 401 });
    }

    await connectToDatabase();
    const isDbConnected = (await import('mongoose')).default.connection.readyState === 1;

    // 1. Verify and delete from MongoDB
    if (isDbConnected) {
      const existing = await GameRoom.findOne({ roomCode });
      if (existing) {
        if (existing.hostId !== effectiveHostId) {
          return NextResponse.json({ error: 'Forbidden: You do not own this room save' }, { status: 403 });
        }
        await GameRoom.deleteOne({ roomCode });
      }
    }

    // 2. Evict from socketHub RAM if active
    const socketHub = (global as any).socketHub;
    if (socketHub && socketHub.rooms.has(roomCode)) {
      const activeRoom = socketHub.rooms.get(roomCode);
      if (activeRoom.hostId === effectiveHostId) {
        if (activeRoom.lotClockInterval) clearInterval(activeRoom.lotClockInterval);
        if (activeRoom.wishlistClockInterval) clearInterval(activeRoom.wishlistClockInterval);
        if (activeRoom.seasonClockInterval) clearInterval(activeRoom.seasonClockInterval);
        activeRoom.aiBidTimeouts.forEach((t: any) => clearTimeout(t));
        socketHub.rooms.delete(roomCode);
      }
    }

    return NextResponse.json({ success: true, deletedRoomCode: roomCode });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

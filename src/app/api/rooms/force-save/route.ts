import { NextResponse } from 'next/server';
import { getHostFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { roomCode, hostId: bodyHostId, deviceUUID } = body;
    if (!roomCode) {
      return NextResponse.json({ error: 'Missing roomCode' }, { status: 400 });
    }

    const cleanCode = String(roomCode).toUpperCase().trim();
    const socketHub = (global as any).socketHub;
    if (!socketHub) {
      return NextResponse.json({ error: 'SocketHub server not initialized' }, { status: 503 });
    }

    let room = socketHub.rooms.get(cleanCode);
    if (!room) {
      room = await socketHub.restoreRoomFromDB(cleanCode);
    }
    if (!room) {
      return NextResponse.json({ error: `Room ${cleanCode} not found` }, { status: 404 });
    }

    // Host Authorization check
    const hostPayload = getHostFromRequest(req);
    const isAuthorizedHost = Boolean(
      (hostPayload && (hostPayload.hostId === room.hostId || !room.seats?.some((s: any) => s.isHuman))) ||
      (bodyHostId && room.hostId && bodyHostId === room.hostId) ||
      (deviceUUID && room.hostDeviceUUID && deviceUUID === room.hostDeviceUUID)
    );

    if (!isAuthorizedHost) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED_HOST_ONLY', message: 'Unauthorized: Host privileges required to force save room.' },
        { status: 403 }
      );
    }

    // Flush room state to MongoDB
    await socketHub.flushRoomToMongoDB(room);

    if (socketHub.io) {
      socketHub.io.to(cleanCode).emit('save_status', {
        success: true,
        timestamp: Date.now(),
        message: 'Saved to Cloud ✓'
      });
    }

    return NextResponse.json({
      success: true,
      roomCode: cleanCode,
      savedAt: Date.now()
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

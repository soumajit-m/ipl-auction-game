import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const fixedPath = path.resolve(process.cwd(), 'public/data/players_active_fixed.json');
    const fallbackPath = path.resolve(process.cwd(), 'public/data/players_active.json');
    const playersPath = fs.existsSync(fixedPath) ? fixedPath : fallbackPath;

    const dataDir = path.resolve(process.cwd(), 'public/data');
    const players = JSON.parse(fs.readFileSync(playersPath, 'utf-8'));
    const stadiums = JSON.parse(fs.readFileSync(path.join(dataDir, 'stadiums_10.json'), 'utf-8'));

    return NextResponse.json(
      { success: true, count: players.length, players, stadiums },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      }
    );
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

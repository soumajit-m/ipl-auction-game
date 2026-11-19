import { NextResponse } from 'next/server';
import { POST as loginPost } from '../login/route';
import { POST as registerPost } from '../verify-and-register/route';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const cloned = req.clone();
    const body = await req.json().catch(() => ({}));
    const { action = 'login' } = body;

    if (action === 'register') {
      return registerPost(cloned);
    }
    return loginPost(cloned);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

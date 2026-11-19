import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { HostUser, connectToDatabase } from '@/lib/mongodb';
import { verifyOtp } from '@/lib/emailOtp';
import { signHostToken } from '@/lib/auth';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { email, name, password, otp } = body;

    const normalizedEmail = (email || '').toLowerCase().trim();
    const trimmedName = (name || '').trim();
    const trimmedPass = (password || '').trim();
    const cleanOtp = (otp || '').trim();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!normalizedEmail || !emailRegex.test(normalizedEmail)) {
      return NextResponse.json({ error: 'Please provide a valid email address.' }, { status: 400 });
    }

    if (!trimmedName || trimmedName.length < 2) {
      return NextResponse.json({ error: 'Please enter your name (at least 2 characters).' }, { status: 400 });
    }

    if (!trimmedPass || trimmedPass.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
    }

    if (!cleanOtp || cleanOtp.length !== 6) {
      return NextResponse.json({ error: 'Please enter the 6-digit verification code sent to your email.' }, { status: 400 });
    }

    // Verify OTP (accepts code sent to this email regardless of whether tab was switched)
    const verification = await verifyOtp(normalizedEmail, cleanOtp);
    if (!verification.valid) {
      return NextResponse.json({ error: verification.reason || 'Invalid OTP code.' }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(trimmedPass, 10);
    let hostId = '';

    try {
      await connectToDatabase();
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection.readyState === 1) {
        // Upsert HostUser in MongoDB
        const user = await HostUser.findOneAndUpdate(
          { email: normalizedEmail },
          {
            name: trimmedName,
            passwordHash,
            isVerified: true,
            updatedAt: new Date()
          },
          { upsert: true, new: true }
        );
        if (user && user._id) {
          hostId = user._id.toString();
        }
      }
    } catch (dbErr) {
      console.warn('[verify-and-register] DB save error, falling back to RAM hostId:', (dbErr as Error).message);
    }

    if (!hostId) {
      hostId = 'host_' + Buffer.from(normalizedEmail).toString('hex').slice(0, 16);
    }

    const token = signHostToken(hostId, normalizedEmail, trimmedName);
    const res = NextResponse.json({
      success: true,
      hostId,
      email: normalizedEmail,
      name: trimmedName,
      username: normalizedEmail,
      token
    });

    res.cookies.set('host_token', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: '/'
    });

    return res;
  } catch (error) {
    console.error('[verify-and-register] Error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

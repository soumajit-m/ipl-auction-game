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
    const { email, username, password, otp } = body;

    const identifier = (email || username || '').toLowerCase().trim();
    const trimmedPass = (password || '').trim();
    const cleanOtp = (otp || '').trim();

    if (!identifier) {
      return NextResponse.json({ error: 'Please enter your email address.' }, { status: 400 });
    }

    let user = null;
    try {
      await connectToDatabase();
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection.readyState === 1) {
        if (identifier.includes('@')) {
          user = await HostUser.findOne({ email: identifier });
        } else {
          user = await HostUser.findOne({
            $or: [{ username: identifier }, { email: identifier }]
          });
        }
      }
    } catch (dbErr) {
      console.warn('[login] DB lookup skipped due to network/SSL issue:', (dbErr as Error).message);
    }

    // Path 1: 6-Digit OTP Login
    if (cleanOtp) {
      if (cleanOtp.length !== 6) {
        return NextResponse.json({ error: 'OTP code must be 6 digits.' }, { status: 400 });
      }

      // Verify OTP (accepts code sent to this email regardless of whether tab was switched)
      const verification = await verifyOtp(identifier, cleanOtp);
      if (!verification.valid) {
        return NextResponse.json({ error: verification.reason || 'Invalid OTP code.' }, { status: 400 });
      }

      if (!user) {
        // Dev fallback if user was created in offline RAM
        const hostId = 'host_' + Buffer.from(identifier).toString('hex').slice(0, 16);
        const token = signHostToken(hostId, identifier);
        const res = NextResponse.json({
          success: true,
          hostId,
          email: identifier,
          name: identifier.split('@')[0],
          username: identifier,
          token
        });
        res.cookies.set('host_token', token, {
          httpOnly: true,
          secure: env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 7 * 24 * 60 * 60,
          path: '/'
        });
        return res;
      }

      const hostId = user._id.toString();
      const token = signHostToken(hostId, user.email, user.name);
      const res = NextResponse.json({
        success: true,
        hostId,
        email: user.email,
        name: user.name,
        username: user.email,
        token
      });

      res.cookies.set('host_token', token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60,
        path: '/'
      });
      return res;
    }

    // Path 2: Password Login
    if (!trimmedPass) {
      return NextResponse.json({ error: 'Please enter your password or request an OTP code.' }, { status: 400 });
    }

    // Bootstrap fallback for default admin password
    if (!user && trimmedPass === env.HOST_ADMIN_PASS) {
      const bootstrapId = 'admin_host_1';
      const token = signHostToken(bootstrapId, identifier);
      const res = NextResponse.json({
        success: true,
        hostId: bootstrapId,
        email: identifier,
        name: 'Admin Host',
        username: identifier,
        token
      });
      res.cookies.set('host_token', token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60,
        path: '/'
      });
      return res;
    }

    if (!user) {
      return NextResponse.json({ error: 'No account found with this email. Please register.' }, { status: 404 });
    }

    const matches = await bcrypt.compare(trimmedPass, user.passwordHash);
    if (!matches) {
      return NextResponse.json({ error: 'Invalid password. Please check and try again.' }, { status: 401 });
    }

    const hostId = user._id.toString();
    const token = signHostToken(hostId, user.email, user.name);
    const res = NextResponse.json({
      success: true,
      hostId,
      email: user.email,
      name: user.name,
      username: user.email,
      token
    });

    res.cookies.set('host_token', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60,
      path: '/'
    });
    return res;
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { HostUser, connectToDatabase } from '@/lib/mongodb';
import { storeAndSendOtp } from '@/lib/emailOtp';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { email, purpose = 'REGISTER' } = body;

    const normalizedEmail = (email || '').toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!normalizedEmail || !emailRegex.test(normalizedEmail)) {
      return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
    }

    if (purpose !== 'REGISTER' && purpose !== 'LOGIN_OTP') {
      return NextResponse.json({ error: 'Invalid OTP purpose specified.' }, { status: 400 });
    }

    // Attempt DB pre-check safely without blocking on network/SSL errors
    try {
      await connectToDatabase();
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection.readyState === 1) {
        const existing = await HostUser.findOne({ email: normalizedEmail }).catch(() => null);
        if (purpose === 'REGISTER' && existing && existing.isVerified) {
          return NextResponse.json({
            error: 'An account with this email already exists. Please switch to Sign In.'
          }, { status: 409 });
        }
        if (purpose === 'LOGIN_OTP' && (!existing || !existing.isVerified)) {
          return NextResponse.json({
            error: 'No verified Host account found with this email. Please register first.'
          }, { status: 404 });
        }
      }
    } catch (dbErr) {
      console.warn('[send-otp] MongoDB check bypassed, operating in RAM mode:', (dbErr as Error).message);
    }

    const result = await storeAndSendOtp(normalizedEmail, purpose);
    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to send OTP' }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: `A 6-digit code has been sent to ${normalizedEmail}`,
      devOtpPreview: result.devOtpPreview
    });
  } catch (error) {
    console.error('[send-otp] Unexpected error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

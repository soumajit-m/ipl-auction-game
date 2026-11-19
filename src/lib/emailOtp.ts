import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { EmailOtp, connectToDatabase } from './mongodb';
import { env } from './env';

// In-memory fallback on globalThis so all Next.js route chunks share the same store
interface InMemOtp {
  email: string;
  otpHash: string;
  expiresAt: number;
  purpose?: 'REGISTER' | 'LOGIN_OTP' | string;
  createdAt: number;
}

declare global {
  var _ipl_inMemoryOtps: Map<string, InMemOtp> | undefined;
}

const inMemoryOtps: Map<string, InMemOtp> =
  globalThis._ipl_inMemoryOtps || new Map<string, InMemOtp>();
globalThis._ipl_inMemoryOtps = inMemoryOtps;

export function generate6DigitOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export async function sendOtpEmail(email: string, code: string, purpose: 'REGISTER' | 'LOGIN_OTP'): Promise<boolean> {
  // Log to console in non-production environments
  if (process.env.NODE_ENV !== 'production') {
    console.log(`\n======================================================`);
    console.log(`[EMAIL OTP for ${email}] (${purpose}): ${code}`);
    console.log(`======================================================\n`);
  }

  if (env.SMTP_EMAIL && env.SMTP_APP_PASSWORD) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        connectionTimeout: 4000,
        greetingTimeout: 4000,
        socketTimeout: 5000,
        auth: {
          user: env.SMTP_EMAIL,
          pass: env.SMTP_APP_PASSWORD.replace(/\s+/g, '')
        }
      });

      const subject = purpose === 'REGISTER'
        ? `IPL Manager 2026 - Your Registration Code is ${code}`
        : `IPL Manager 2026 - Your Sign-In Code is ${code}`;

      const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #090B10; color: #F1F5F9; padding: 40px 20px; border-radius: 16px; max-width: 500px; margin: 0 auto; border: 1px solid rgba(255, 255, 255, 0.1);">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #E5A93C; font-size: 22px; margin: 0 0 6px 0; letter-spacing: 1px;">IPL AUCTION & MANAGER 2026</h1>
            <p style="color: #94A3B8; font-size: 13px; margin: 0;">Host Verification Security Code</p>
          </div>
          <div style="background-color: #12151E; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 24px;">
            <p style="color: #94A3B8; font-size: 13px; margin: 0 0 16px 0;">Use the 6-digit code below to complete your Host verification. This code expires in 5 minutes.</p>
            <div style="background-color: #1C202E; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 14px 24px; display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #E5A93C; font-family: monospace;">
              ${code}
            </div>
          </div>
          <p style="color: #64748B; font-size: 11px; text-align: center; margin: 0;">
            If you did not request this verification code, you can safely ignore this email.
          </p>
        </div>
      `;

      await transporter.sendMail({
        from: `"IPL Franchise Manager 2026" <${env.SMTP_EMAIL}>`,
        to: email,
        subject,
        html
      });
      return true;
    } catch (err) {
      console.warn('[EmailOtp] Failed to send email via SMTP, fallback to console log:', (err as Error).message);
      return false;
    }
  }

  return true;
}

export async function storeAndSendOtp(
  email: string,
  purpose: 'REGISTER' | 'LOGIN_OTP'
): Promise<{ success: boolean; devOtpPreview?: string; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return { success: false, error: 'Please provide a valid email address' };
  }

  const code = generate6DigitOtp();
  const otpHash = await bcrypt.hash(code, 10);
  const now = Date.now();
  const expiresAt = new Date(now + 5 * 60 * 1000); // 5 minutes

  // 1. ALWAYS store in global memory (shared across all Next.js API route chunks)
  const entry: InMemOtp = {
    email: normalizedEmail,
    otpHash,
    expiresAt: expiresAt.getTime(),
    purpose,
    createdAt: now
  };
  inMemoryOtps.set(normalizedEmail, entry);
  inMemoryOtps.set(`${normalizedEmail}:${purpose}`, entry);

  // 2. Also persist to MongoDB for cross-server resilience
  try {
    await connectToDatabase();
    const mongoose = (await import('mongoose')).default;
    if (mongoose.connection.readyState === 1) {
      // Clear previous pending OTPs for this email
      await EmailOtp.deleteMany({ email: normalizedEmail }).catch(() => {});
      await EmailOtp.create({
        email: normalizedEmail,
        otpHash,
        expiresAt,
        purpose
      });
    }
  } catch (e) {
    console.warn('[EmailOtp] MongoDB save warning, in-memory store active:', (e as Error).message);
  }

  // 3. Send email via SMTP (or log to console in dev mode)
  await sendOtpEmail(normalizedEmail, code, purpose);

  const isDev = env.NODE_ENV !== 'production';
  return {
    success: true,
    devOtpPreview: isDev ? code : undefined
  };
}

export async function verifyOtp(
  email: string,
  code: string,
  purpose?: 'REGISTER' | 'LOGIN_OTP'
): Promise<{ valid: boolean; reason?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const cleanCode = (code || '').trim();

  if (!cleanCode || cleanCode.length !== 6) {
    return { valid: false, reason: 'OTP must be exactly 6 digits.' };
  }

  let otpRecord: { otpHash: string; expiresAt: Date | number } | null = null;
  const now = Date.now();

  // 1. Check in-memory store (keyed by email, fallback to email:purpose)
  const memRecord = inMemoryOtps.get(normalizedEmail) ||
    (purpose ? inMemoryOtps.get(`${normalizedEmail}:${purpose}`) : null);

  if (memRecord) {
    const expTime = typeof memRecord.expiresAt === 'number'
      ? memRecord.expiresAt
      : new Date(memRecord.expiresAt).getTime();

    if (expTime > now) {
      otpRecord = memRecord;
    } else {
      inMemoryOtps.delete(normalizedEmail);
      if (purpose) inMemoryOtps.delete(`${normalizedEmail}:${purpose}`);
      return { valid: false, reason: 'Verification code has expired. Please request a new code.' };
    }
  }

  // 2. If not found in memory, check MongoDB
  if (!otpRecord) {
    try {
      await connectToDatabase();
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection.readyState === 1) {
        // Query newest OTP for this email
        const dbRecord = await EmailOtp.findOne({ email: normalizedEmail }).sort({ createdAt: -1 });
        if (dbRecord) {
          const expTime = new Date(dbRecord.expiresAt).getTime();
          if (expTime > now) {
            otpRecord = dbRecord;
          } else {
            return { valid: false, reason: 'Verification code has expired. Please request a new code.' };
          }
        }
      }
    } catch (e) {
      console.warn('[EmailOtp] DB lookup error:', (e as Error).message);
    }
  }

  if (!otpRecord) {
    return { valid: false, reason: 'Verification code not found or expired. Please click "Send Code" to get a fresh code.' };
  }

  // 3. Verify bcrypt hash
  const matches = await bcrypt.compare(cleanCode, otpRecord.otpHash);
  if (!matches) {
    return { valid: false, reason: 'Incorrect verification code. Please check the 6 digits and try again.' };
  }

  // 4. Code is valid: delete so it cannot be replayed
  inMemoryOtps.delete(normalizedEmail);
  if (purpose) inMemoryOtps.delete(`${normalizedEmail}:${purpose}`);
  try {
    const mongoose = (await import('mongoose')).default;
    if (mongoose.connection.readyState === 1) {
      await EmailOtp.deleteMany({ email: normalizedEmail }).catch(() => {});
    }
  } catch (e) {}

  return { valid: true };
}

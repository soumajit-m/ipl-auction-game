import { z } from 'zod';

const envSchema = z.object({
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/ipl_manager'),
  JWT_SECRET: z.string().min(16).default('ipl-auction-secret-key-production-32-chars-long'),
  HOST_ADMIN_PASS: z.string().default('ipl_host_admin_2026'),
  NEXT_PUBLIC_WS_URL: z.string().optional().default(''),
  DEV_FAST_CLOCK: z.preprocess((val) => {
    if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
    return Boolean(val);
  }, z.boolean()).default(false),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SMTP_EMAIL: z.string().optional(),
  SMTP_APP_PASSWORD: z.string().optional()
});

export const env = envSchema.parse({
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_SECRET: process.env.JWT_SECRET,
  HOST_ADMIN_PASS: process.env.HOST_ADMIN_PASS,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  DEV_FAST_CLOCK: process.env.DEV_FAST_CLOCK,
  NODE_ENV: process.env.NODE_ENV,
  SMTP_EMAIL: process.env.SMTP_EMAIL,
  SMTP_APP_PASSWORD: process.env.SMTP_APP_PASSWORD
});

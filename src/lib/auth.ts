import jwt from 'jsonwebtoken';
import { env } from './env';

export interface HostJwtPayload {
  hostId: string;
  email?: string;
  name?: string;
  username: string;
  isHost: boolean;
}

export function signHostToken(hostId: string, emailOrUser: string, name?: string): string {
  const isEmail = emailOrUser.includes('@');
  return jwt.sign(
    {
      hostId,
      email: isEmail ? emailOrUser.toLowerCase() : undefined,
      username: emailOrUser,
      name: name || (isEmail ? emailOrUser.split('@')[0] : emailOrUser),
      isHost: true
    },
    env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function verifyHostToken(token: string): HostJwtPayload | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as HostJwtPayload;
    if (payload && payload.isHost && payload.hostId) {
      return payload;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function getHostFromRequest(req: Request): HostJwtPayload | null {
  // 1. Check Authorization header
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const payload = verifyHostToken(token);
    if (payload) return payload;
  }

  // 2. Check Cookie header
  const cookieHeader = req.headers.get('cookie');
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map(c => {
        const [k, ...v] = c.trim().split('=');
        return [k, decodeURIComponent(v.join('='))];
      })
    );
    if (cookies.host_token) {
      const payload = verifyHostToken(cookies.host_token);
      if (payload) return payload;
    }
  }

  return null;
}

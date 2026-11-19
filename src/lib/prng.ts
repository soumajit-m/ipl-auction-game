/**
 * Mulberry32 32-bit seeded pseudo-random number generator
 * Strictly deterministic across runs for identical roomPin + teamId + context seeds.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * String hash helper producing a 32-bit integer for Mulberry32 seeding.
 */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash | 0; // Convert to 32bit integer
  }
  return hash >>> 0;
}

/**
 * Creates a deterministic uniform PRNG for a given composite key.
 */
export function createDeterministicUniform(roomCode: string, teamId: string, context: string): () => number {
  const seed = hashString(`${roomCode}:${teamId}:${context}`);
  return mulberry32(seed);
}

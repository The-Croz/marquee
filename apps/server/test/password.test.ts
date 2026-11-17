import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { RateLimiter } from '../src/auth/rateLimit.js';

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('popcorn and a movie');
    expect(hash.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('popcorn and a movie', hash)).toBe(true);
    expect(await verifyPassword('popcorn and a movie!', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('blocks after the limit and resets after the window', () => {
    let t = 0;
    const rl = new RateLimiter(3, 1000, () => t);
    expect([rl.hit('a'), rl.hit('a'), rl.hit('a')]).toEqual([0, 0, 0]);
    expect(rl.hit('a')).toBe(1);
    expect(rl.hit('b')).toBe(0);
    t = 1001;
    expect(rl.hit('a')).toBe(0);
  });
});

// The TLS path to ElastiCache (Phase 6, G7): a rediss:// URL turns TLS on for every connection the
// app opens, and the connections it derives from them (Socket.IO adapter, worker events).
import { describe, expect, it } from 'vitest';
import { createBullConnection, createRedisClient } from './redis.ts';

// Port 1 refuses connections at once; the clients are only inspected and then dropped.
const UNREACHABLE = '127.0.0.1:1';

describe('Redis connections', () => {
  it('rediss:// enables TLS (with the ElastiCache auth token and user from the URL)', () => {
    const client = createRedisClient(`rediss://app-user:s3cret-token@${UNREACHABLE}`);
    try {
      expect(client.options.tls).toBeDefined();
      expect(client.options.username).toBe('app-user');
      expect(client.options.password).toBe('s3cret-token');
      // Derived connections (Socket.IO adapter pub/sub, worker events) keep TLS.
      const sub = client.duplicate();
      try {
        expect(sub.options.tls).toBeDefined();
      } finally {
        sub.disconnect();
      }
    } finally {
      client.disconnect();
    }
  });

  it('the BullMQ connection uses TLS too, and never gives up on a command', () => {
    const client = createBullConnection(`rediss://${UNREACHABLE}`);
    try {
      expect(client.options.tls).toBeDefined();
      expect(client.options.maxRetriesPerRequest).toBeNull();
    } finally {
      client.disconnect();
    }
  });

  it('redis:// stays plain TCP (local development, the rehearsal)', () => {
    const client = createRedisClient(`redis://${UNREACHABLE}`);
    try {
      expect(client.options.tls).toBeUndefined();
    } finally {
      client.disconnect();
    }
  });
});

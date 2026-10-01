// What DATABASE_URL's TLS settings turn into at the driver (Phase 6, G6/G7). The Prisma client uses
// `@prisma/adapter-pg`, which hands the connection string to node-postgres as it is; so the URL
// documented for RDS has to produce a verifying TLS configuration there. Nothing connects.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'loons-db-tls-'));
const caFile = join(dir, 'rds-global-bundle.pem');
const caText = '-----BEGIN CERTIFICATE-----\nZmFrZSBjZXJ0aWZpY2F0ZQ==\n-----END CERTIFICATE-----\n';
writeFileSync(caFile, caText);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function sslOf(query: string): unknown {
  const url = `postgresql://loons:secret@loons.example.me-central-1.rds.amazonaws.com:5432/loons${query}`;
  const client = new pg.Client({ connectionString: url });
  return (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
}

describe('DATABASE_URL TLS', () => {
  it('sslmode=verify-full with sslrootcert verifies the server against the RDS CA bundle', () => {
    const ssl = sslOf(`?sslmode=verify-full&sslrootcert=${encodeURIComponent(caFile)}`) as {
      ca?: string;
      rejectUnauthorized?: boolean;
    };
    expect(ssl).toBeTruthy();
    expect(ssl.ca).toBe(caText);
    expect(ssl.rejectUnauthorized).not.toBe(false);
  });

  it('sslmode=require also verifies the certificate (node-postgres maps it to verify-full)', () => {
    const ssl = sslOf('?sslmode=require') as { rejectUnauthorized?: boolean };
    expect(ssl).toBeTruthy();
    expect(ssl.rejectUnauthorized).not.toBe(false);
  });

  it('without sslmode the connection is plain (which production configuration refuses)', () => {
    expect(sslOf('')).toBeFalsy();
    expect(sslOf('?sslmode=disable')).toBeFalsy();
  });

  it('an unreadable sslrootcert fails loudly instead of connecting unverified', () => {
    expect(() =>
      sslOf(`?sslmode=verify-full&sslrootcert=${encodeURIComponent(join(dir, 'nope'))}`),
    ).toThrow();
  });
});

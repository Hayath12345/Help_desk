import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { attachmentObjectTargets, deleteObjects, s3FromEnv } from './e2e-objects.ts';

describe('attachmentObjectTargets', () => {
  it('each row’s key plus its files/<id>/ copies and attachments/<id>/ uploads, without duplicates', () => {
    expect(
      attachmentObjectTargets([
        { id: 'a1', storageKey: 'files/a1/u1/vpn-drops.log' },
        { id: 'a2', storageKey: 'attachments/a2/notes.txt' },
        { id: 'a2', storageKey: 'attachments/a2/notes.txt' },
        { id: 'a3', storageKey: '' },
      ]),
    ).toEqual({
      keys: ['files/a1/u1/vpn-drops.log', 'attachments/a2/notes.txt'],
      prefixes: [
        'files/a1/',
        'files/a2/',
        'files/a3/',
        // A POST with the still-valid policy after `complete` recreates the upload (RR-SEC-4).
        'attachments/a1/',
        'attachments/a2/',
        'attachments/a3/',
      ],
    });
  });
});

describe('s3FromEnv', () => {
  it('reads the API’s S3 variables (MinIO: endpoint + path style + static keys)', () => {
    expect(
      s3FromEnv({
        S3_REGION: 'me-central-1',
        S3_BUCKET: 'bucket',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_FORCE_PATH_STYLE: 'true',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toEqual({
      bucket: 'bucket',
      config: {
        region: 'me-central-1',
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      },
    });
  });

  it('AWS: region only (default credential chain); nothing without a bucket', () => {
    expect(s3FromEnv({ S3_REGION: 'me-central-1', S3_BUCKET: 'b' })?.config).toEqual({
      region: 'me-central-1',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    expect(s3FromEnv({ S3_REGION: 'me-central-1' })).toBeNull();
  });
});

// Against the local MinIO when the repo .env configures it (docker compose).
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile) && !process.env.S3_BUCKET) process.loadEnvFile(envFile);
const s3 = s3FromEnv();

describe.runIf(s3 !== null && Boolean(process.env.S3_ENDPOINT))('deleteObjects (MinIO)', () => {
  const client = new S3Client(s3?.config ?? {});
  const bucket = s3?.bucket ?? '';
  const id = randomUUID();
  const upload = `attachments/${randomUUID()}/cleanup-probe.log`;
  const copies = [`files/${id}/${randomUUID()}/cleanup-probe.log`, `files/${id}/x/other.log`];
  const bystander = `files/${randomUUID()}/keep-me.log`;

  afterAll(async () => {
    for (const key of [upload, ...copies, bystander]) {
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        .catch(() => undefined);
    }
    client.destroy();
  });

  const exists = async (key: string) =>
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(
      () => true,
      () => false,
    );

  it('removes the keys and every object under the prefixes, and nothing else', async () => {
    for (const key of [upload, ...copies, bystander]) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'e2e', ContentType: 'text/plain' }),
      );
    }
    const deleted = await deleteObjects(client, bucket, {
      keys: [upload, 'attachments/missing/never-there.txt'],
      prefixes: [`files/${id}/`],
    });
    expect(deleted).toBe(4);
    for (const key of [upload, ...copies]) expect(await exists(key), key).toBe(false);
    expect(await exists(bystander)).toBe(true);
  });
});

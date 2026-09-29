import { randomUUID } from 'node:crypto';
import { GetBucketLifecycleConfigurationCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  attachmentDownloadSchema,
  completeAttachmentResponseSchema,
  presignAttachmentResponseSchema,
  toWellFormed,
} from '@loons/shared';
import { createStorage, rfc5987, type ScanHook, type Storage } from '../src/lib/storage.ts';
import { PRESIGN_LIMIT } from '../src/routes/attachments.ts';
import {
  CONFIRM_IN_PROGRESS_MESSAGE,
  CONFIRM_LOCK_WAIT_MS,
} from '../src/services/attachments.service.ts';
import { createTestContext, testConfig, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona as personaFor,
  postMessage,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

// Real MinIO (docker compose): pre-signed POST uploads from the browser origin, confirmation with
// the scan hook, and signed downloads.

const WEB_ORIGIN = 'http://localhost:3000';
/** 11 bytes that start like a PDF (complete() checks the magic number). */
const PDF = '%PDF-1.4 ok';

type Presigned = ReturnType<typeof presignAttachmentResponseSchema.parse>;

/** Keys the scan hook was asked to scan. */
const scannedKeys: string[] = [];
/** Runs before the service copies a checked upload (tests replace the upload in between). */
let beforeCopy: (() => Promise<void>) | null = null;

/** Scan verdict from the file name: "eicar" → INFECTED, "scanfail" → ERROR, else CLEAN. */
const scanHook: ScanHook = {
  async scan({ key }) {
    scannedKeys.push(key);
    if (key.includes('eicar')) return { verdict: 'INFECTED' };
    if (key.includes('scanfail')) return { verdict: 'ERROR' };
    return { verdict: 'CLEAN' };
  },
};

/** Sources of every server-side copy the service asked for. */
const copiedFrom: string[] = [];
/** When set, the next HEAD fails with this storage status (e.g. MinIO's 400 for a refused key). */
let headFailure: number | null = null;

/** The real MinIO storage, with hooks around the service's check and its copy. */
function withCopyHook(storage: Storage): Storage {
  return {
    ...storage,
    async headObject(key) {
      const status = headFailure;
      headFailure = null;
      if (status !== null) {
        throw Object.assign(new Error('storage refused the request'), {
          $metadata: { httpStatusCode: status },
        });
      }
      return storage.headObject(key);
    },
    async copyObject(from, to, options) {
      copiedFrom.push(from);
      const hook = beforeCopy;
      beforeCopy = null;
      if (hook) await hook();
      return storage.copyObject(from, to, options);
    },
  };
}

describe('attachments (MinIO)', () => {
  let ctx: TestContext;
  let w: World;
  let uploader: Persona;
  const storageKeys = new Set<string>();
  const uploaderIds = new Set<string>();

  beforeAll(async () => {
    const config = testConfig();
    ctx = await createTestContext({
      config,
      deps: { storage: withCopyHook(createStorage(config.s3, { scanHook })) },
    });
    w = await createWorld(ctx);
    uploader = await w.newClientX('Uma Uploader');
    for (const p of [uploader, w.clientX, w.agentA]) uploaderIds.add(p.id);
  });
  afterAll(async () => {
    const rows = await ctx.prisma.attachment.findMany({
      where: { uploaderId: { in: [...uploaderIds] } },
      select: { id: true, storageKey: true },
    });
    const copies = (await Promise.all(rows.map((r) => storedObjects(r.id)))).flat();
    for (const key of [...storageKeys, ...rows.map((r) => r.storageKey), ...copies]) {
      await ctx.app.storage.deleteObject(key).catch(() => undefined);
    }
    await ctx.close();
  });

  async function presign(
    as: Persona,
    body: { fileName?: string; mimeType?: string; sizeBytes?: number; ticketId?: string } = {},
  ): Promise<Presigned> {
    const res = await apiAs(ctx, as).post('/attachments/presign', {
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 11,
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    const presigned = presignAttachmentResponseSchema.parse(res.json());
    const key = presigned.upload.fields.key;
    if (key) storageKeys.add(key);
    return presigned;
  }

  /** The browser's multipart POST (fields first, file last), from the web origin. */
  function upload(p: Presigned, content: string | Buffer, contentType: string) {
    const form = new FormData();
    for (const [k, v] of Object.entries(p.upload.fields)) form.append(k, v);
    form.append('file', new Blob([content], { type: contentType }), 'file');
    return fetch(p.upload.url, { method: 'POST', body: form, headers: { origin: WEB_ORIGIN } });
  }

  const complete = (as: Persona, id: string) => apiAs(ctx, as).post(`/attachments/${id}/complete`);

  async function objectsUnder(prefix: string): Promise<string[]> {
    const res = await ctx.app.storage.client.send(
      new ListObjectsV2Command({ Bucket: ctx.app.storage.bucket, Prefix: prefix }),
    );
    return (res.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
  }

  /** Keys of the server-only copies of an attachment (files/<id>/…). */
  const storedObjects = (attachmentId: string) => objectsUnder(`files/${attachmentId}/`);
  /** Keys under an attachment's transient upload prefix (attachments/<id>/…). */
  const uploadObjects = (attachmentId: string) => objectsUnder(`attachments/${attachmentId}/`);

  /** What a signed download link serves. */
  async function downloaded(as: Persona, id: string) {
    const res = await apiAs(ctx, as).get(`/attachments/${id}/download`);
    expect(res.statusCode, res.body).toBe(200);
    const file = await fetch(attachmentDownloadSchema.parse(res.json()).url);
    return {
      status: file.status,
      body: await file.text(),
      disposition: file.headers.get('content-disposition'),
      type: file.headers.get('content-type'),
    };
  }

  async function uploaded(as: Persona, fileName = 'report.pdf', content = PDF) {
    const p = await presign(as, { fileName, sizeBytes: Buffer.byteLength(content) });
    const res = await upload(p, content, 'application/pdf');
    expect(res.status).toBe(204);
    const done = await complete(as, p.attachmentId);
    expect(done.statusCode, done.body).toBe(200);
    return p.attachmentId;
  }

  describe('POST /attachments/presign', () => {
    it('reserves a PENDING upload and returns a 15-minute pre-signed POST', async () => {
      const before = Date.now();
      const p = await presign(uploader, { fileName: '../../Évidence <1>.PDF', sizeBytes: 1234 });
      expect(p.upload.url).toMatch(/^http:\/\/localhost:9000\/loons-helpdesk-attachments\/?$/);
      expect(p.upload.fields).toMatchObject({ 'Content-Type': 'application/pdf' });
      // Under the attachment's id: what a POST leaves there can be found from the row (RR-SEC-4).
      expect(p.upload.fields.key).toBe(`attachments/${p.attachmentId}/Évidence _1_.pdf`);
      const expires = Date.parse(p.expiresAt) - before;
      expect(expires).toBeGreaterThan(14 * 60_000);
      expect(expires).toBeLessThanOrEqual(15 * 60_000 + 1000);
      const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: p.attachmentId } });
      expect(row).toMatchObject({
        status: 'PENDING',
        uploaderId: uploader.id,
        fileName: 'Évidence _1_.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        ticketId: null,
        messageId: null,
      });
    });

    it('MIME types outside the allow-list → 400; > 25 MB → 400', async () => {
      for (const mimeType of ['text/html', 'image/svg+xml', 'application/x-msdownload']) {
        const res = await apiAs(ctx, uploader).post('/attachments/presign', {
          fileName: 'x.html',
          mimeType,
          sizeBytes: 10,
        });
        expect(res.statusCode, mimeType).toBe(400);
        expect(res.json().error.details).toContainEqual(
          expect.objectContaining({ path: ['mimeType'], code: 'file_type' }),
        );
      }
      const big = await apiAs(ctx, uploader).post('/attachments/presign', {
        fileName: 'x.zip',
        mimeType: 'application/zip',
        sizeBytes: 25 * 1024 * 1024 + 1,
      });
      expect(big.statusCode).toBe(400);
    });

    it('for a ticket: it must be visible (else 404) and not closed (409)', async () => {
      const t = await createTicket(ctx, w.clientY, ticketBody(w, { siteId: w.siteY1.id }));
      const hidden = await apiAs(ctx, uploader).post('/attachments/presign', {
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 5,
        ticketId: t.id,
      });
      expect(hidden.statusCode).toBe(404);
      const own = await createTicket(ctx, uploader, ticketBody(w));
      expect((await presign(uploader, { ticketId: own.id })).attachmentId).toEqual(
        expect.any(String),
      );
      await ctx.prisma.ticket.update({ where: { id: own.id }, data: { status: 'CLOSED' } });
      const closed = await apiAs(ctx, uploader).post('/attachments/presign', {
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 5,
        ticketId: own.id,
      });
      expect(closed.statusCode).toBe(409);
    });

    it('per-user rate limit', async () => {
      const heavy = await w.newClientX();
      const bad = { fileName: 'x', mimeType: 'text/html', sizeBytes: 1 };
      for (let i = 0; i < PRESIGN_LIMIT.max; i++) {
        expect((await apiAs(ctx, heavy).post('/attachments/presign', bad)).statusCode).toBe(400);
      }
      expect((await apiAs(ctx, heavy).post('/attachments/presign', bad)).statusCode).toBe(429);
    });
  });

  describe('browser upload straight to MinIO', () => {
    it('answers the CORS preflight and the POST for the web origin', async () => {
      const p = await presign(uploader);
      const preflight = await fetch(p.upload.url, {
        method: 'OPTIONS',
        headers: {
          origin: WEB_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(preflight.status).toBeLessThan(300);
      expect(preflight.headers.get('access-control-allow-origin')).toMatch(
        new RegExp(`^(\\*|${WEB_ORIGIN})$`),
      );
      expect(preflight.headers.get('access-control-allow-methods') ?? '').toContain('POST');

      const res = await upload(p, PDF, 'application/pdf');
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toMatch(
        new RegExp(`^(\\*|${WEB_ORIGIN})$`),
      );
    });

    it('storage enforces the declared size and type', async () => {
      const p = await presign(uploader, { sizeBytes: 5 });
      const tooBig = await upload(p, 'more than five bytes', 'application/pdf');
      expect(tooBig.status).toBeGreaterThanOrEqual(400);
      // The stored Content-Type is the signed form field; changing it breaks the policy.
      const tampered = {
        ...p,
        upload: { ...p.upload, fields: { ...p.upload.fields, 'Content-Type': 'text/html' } },
      };
      const wrongType = await upload(tampered, 'abc', 'text/html');
      expect(wrongType.status).toBeGreaterThanOrEqual(400);
      expect(await ctx.app.storage.headObject(p.upload.fields.key!)).toBeNull();
    });
  });

  describe('POST /attachments/:id/complete', () => {
    it('before the upload → 409; after → CLEAN (idempotent); other users → 404', async () => {
      const p = await presign(uploader, { sizeBytes: 11 });
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(409);
      await upload(p, PDF, 'application/pdf');
      expect((await complete(w.clientX, p.attachmentId)).statusCode).toBe(404);
      const res = await complete(uploader, p.attachmentId);
      expect(res.statusCode).toBe(200);
      const { attachment } = completeAttachmentResponseSchema.parse(res.json());
      expect(attachment).toMatchObject({
        id: p.attachmentId,
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 11,
      });
      expect(
        (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: p.attachmentId } })).status,
      ).toBe('CLEAN');
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
      expect((await complete(uploader, randomUUID())).statusCode).toBe(404);
    });

    it('storage refusing the upload key (400) → 409 "not uploaded"; a 401 / 403 stays a 500', async () => {
      const p = await presign(uploader, { sizeBytes: 11 });
      await upload(p, PDF, 'application/pdf');
      // MinIO's answer for a key it refuses (a name segment over 255 bytes on older rows).
      headFailure = 400;
      const res = await complete(uploader, p.attachmentId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('The file has not been uploaded yet');
      // A credential or permission fault of the API (HEAD needs s3:GetObject) is not the user's
      // bad upload: it stays an error (round-2 verify), and so does a server error.
      for (const status of [401, 403, 503]) {
        headFailure = status;
        expect((await complete(uploader, p.attachmentId)).statusCode, `${status}`).toBe(500);
      }
      expect(
        (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: p.attachmentId } })).status,
      ).toBe('PENDING');
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
    });

    it('a smaller object than declared → 400, REJECTED, object deleted', async () => {
      const p = await presign(uploader, { sizeBytes: 100 });
      expect((await upload(p, 'tiny', 'application/pdf')).status).toBe(204);
      const res = await complete(uploader, p.attachmentId);
      expect(res.statusCode).toBe(400);
      // Clients tell the reasons apart (the web shows a different message for each).
      expect(res.json().error).toMatchObject({
        code: 'BAD_REQUEST',
        details: { reason: 'mismatch' },
      });
      expect(
        (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: p.attachmentId } })).status,
      ).toBe('REJECTED');
      expect(await ctx.app.storage.headObject(p.upload.fields.key!)).toBeNull();
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(409);
    });

    it('the scan hook: INFECTED → 400 and deleted; ERROR → 503, retry later', async () => {
      const infected = await presign(uploader, { fileName: 'eicar.pdf', sizeBytes: 5 });
      await upload(infected, '%PDF-', 'application/pdf');
      const refused = await complete(uploader, infected.attachmentId);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.details).toEqual({ reason: 'infected' });
      const row = await ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: infected.attachmentId },
      });
      expect(row.status).toBe('INFECTED');
      expect(await ctx.app.storage.headObject(row.storageKey)).toBeNull();

      const flaky = await presign(uploader, { fileName: 'scanfail.pdf', sizeBytes: 5 });
      await upload(flaky, '%PDF-', 'application/pdf');
      expect((await complete(uploader, flaky.attachmentId)).statusCode).toBe(503);
      const kept = await ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: flaky.attachmentId },
      });
      expect(kept.status).toBe('UPLOADED');
      // The retry scans the same server-side copy again.
      expect(kept.storageKey).toMatch(new RegExp(`^files/${flaky.attachmentId}/`));
      expect((await complete(uploader, flaky.attachmentId)).statusCode).toBe(503);
      expect(scannedKeys.filter((k) => k === kept.storageKey)).toHaveLength(2);
    });
  });

  describe('the checked bytes are the served bytes (review SEC-ATT-1)', () => {
    it('complete copies the upload to a server-only key and deletes the upload', async () => {
      const p = await presign(uploader, { fileName: 'notes.pdf', sizeBytes: 11 });
      expect(p.upload.fields.key).toMatch(/^attachments\//);
      await upload(p, PDF, 'application/pdf');
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
      const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: p.attachmentId } });
      expect(row.status).toBe('CLEAN');
      expect(row.storageKey).toMatch(
        new RegExp(`^files/${p.attachmentId}/[0-9a-f-]{36}/notes\\.pdf$`),
      );
      expect(scannedKeys).toContain(row.storageKey);
      expect(await ctx.app.storage.headObject(p.upload.fields.key!)).toBeNull();
      expect(await storedObjects(p.attachmentId)).toEqual([row.storageKey]);
    });

    it('re-posting with the still-valid policy after complete (and after linking) changes nothing that is served', async () => {
      const clean = 'clean text, 20 bytes';
      const p = await presign(uploader, {
        fileName: 'swap.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(clean),
      });
      expect((await upload(p, clean, 'text/plain')).status).toBe(204);
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
      // Same presigned fields: storage still accepts it (the policy is valid for 15 minutes)…
      expect((await upload(p, 'EVIL-UNSCANNED', 'text/plain')).status).toBe(204);
      expect(await downloaded(uploader, p.attachmentId)).toMatchObject({
        status: 200,
        body: clean,
      });
      const t = await createTicket(
        ctx,
        uploader,
        ticketBody(w, { attachmentIds: [p.attachmentId] }),
      );
      expect((await upload(p, 'EVIL-AFTER-LINK', 'text/plain')).status).toBe(204);
      // …but staff download exactly the bytes that were checked.
      expect(await downloaded(w.agentA, p.attachmentId)).toMatchObject({
        status: 200,
        body: clean,
      });
      const detail = (await apiAs(ctx, w.agentA).get(`/tickets/${t.id}`)).json().ticket;
      expect(detail.attachments).toEqual([
        expect.objectContaining({ id: p.attachmentId, sizeBytes: 20, fileName: 'swap.txt' }),
      ]);
      // Completing again (the row is CLEAN) never picks the re-posted object up either.
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
      expect(await downloaded(w.agentA, p.attachmentId)).toMatchObject({ body: clean });
      // The re-posted object is an orphan under the transient prefix (re-review RR-SEC-4): it
      // sits under attachments/<attachmentId>/, where the bucket's lifecycle rule expires it and
      // the e2e cleanup sweeps it with the row; no row points at it.
      const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: p.attachmentId } });
      expect(row.storageKey).toMatch(/^files\//);
      expect(await uploadObjects(p.attachmentId)).toEqual([p.upload.fields.key]);
      await ctx.app.storage.deleteObject(p.upload.fields.key!);
    });

    it('the bucket expires browser uploads: a lifecycle rule on attachments/ (re-review RR-SEC-4)', async () => {
      // Set up by docker-compose's minio-init (`docker compose up minio-init` after pulling this
      // change); the production bucket needs the same rule.
      const config = await ctx.app.storage.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: ctx.app.storage.bucket }),
      );
      // Exactly the rule minio-init imports: current and noncurrent versions of browser uploads
      // expire after a day (a versioned bucket would otherwise keep every noncurrent version).
      const rule = (config.Rules ?? []).find((r) => r.ID === 'expire-browser-uploads');
      expect(rule, 'run `docker compose up minio-init`').toBeDefined();
      expect(rule).toMatchObject({
        Status: 'Enabled',
        Filter: { Prefix: 'attachments/' },
        Expiration: { Days: 1 },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      });
    });

    it('an upload replaced between the check and the copy is not taken (409, then checked again)', async () => {
      const p = await presign(uploader, {
        fileName: 'race.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
      });
      await upload(p, 'first bytes!', 'text/plain');
      beforeCopy = async () => {
        expect((await upload(p, 'other bytes!', 'text/plain')).status).toBe(204);
      };
      const raced = await complete(uploader, p.attachmentId);
      expect(raced.statusCode, raced.body).toBe(409);
      expect(await storedObjects(p.attachmentId)).toEqual([]);
      expect(
        (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: p.attachmentId } })).status,
      ).toBe('PENDING');
      // The retry checks (and copies) what is there now.
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
      expect(await downloaded(uploader, p.attachmentId)).toMatchObject({ body: 'other bytes!' });
    });

    it('concurrent confirmations make exactly one copy (one at a time; the others 409, retryable)', async () => {
      const p = await presign(uploader, { fileName: 'twice.pdf', sizeBytes: 11 });
      await upload(p, PDF, 'application/pdf');
      const uploadKey = p.upload.fields.key!;
      const results = await Promise.all(
        Array.from({ length: 30 }, () => complete(uploader, p.attachmentId)),
      );
      // Sweep: each concurrent call used to copy the whole object (30 copies of one upload).
      expect(copiedFrom.filter((key) => key === uploadKey)).toHaveLength(1);
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 200).length).toBeGreaterThan(0);
      expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
      for (const r of results.filter((x) => x.statusCode === 409)) {
        expect(r.json().error.message).toBe(CONFIRM_IN_PROGRESS_MESSAGE);
      }
      const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: p.attachmentId } });
      expect(row.status).toBe('CLEAN');
      expect(await storedObjects(p.attachmentId)).toEqual([row.storageKey]);
      expect(await downloaded(uploader, p.attachmentId)).toMatchObject({ body: PDF });
      // A retry after the winner finished answers 200 without copying again; the lock is gone.
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
      expect(copiedFrom.filter((key) => key === uploadKey)).toHaveLength(1);
      expect(
        await ctx.redis.exists(`${ctx.config.redisPrefix}attachment-confirm:${p.attachmentId}`),
      ).toBe(0);
    });

    it('a confirmation that fails releases the lock: the retry is checked again', async () => {
      const p = await presign(uploader, { fileName: 'later.pdf', sizeBytes: 11 });
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(409); // not uploaded yet
      await upload(p, PDF, 'application/pdf');
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
    });

    it('a lock granted only after its wait timed out is given back (round-2 verify)', async () => {
      const p = await presign(uploader, { fileName: 'slowlock.pdf', sizeBytes: 11 });
      const key = `${ctx.config.redisPrefix}attachment-confirm:${p.attachmentId}`;
      const set = ctx.redis.set.bind(ctx.redis) as (...args: unknown[]) => Promise<unknown>;
      let landed: Promise<unknown> = Promise.resolve();
      // The lock's SET reaches Redis only after the confirmation stopped waiting for it (a latency
      // spike, or ioredis replaying its offline queue after a reconnect).
      const spy = vi.spyOn(ctx.redis, 'set').mockImplementation(((...args: unknown[]) => {
        if (!String(args[0]).includes('attachment-confirm:')) return set(...args);
        spy.mockRestore();
        landed = new Promise((resolve) => setTimeout(resolve, CONFIRM_LOCK_WAIT_MS + 300)).then(
          () => set(...args),
        );
        return landed;
      }) as never);
      try {
        // Not uploaded yet: the unlocked confirmation answers 409 while its SET is still queued.
        const first = await complete(uploader, p.attachmentId);
        expect(first.statusCode).toBe(409);
        expect(first.json().error.message).toBe('The file has not been uploaded yet');
        expect(await landed).toBe('OK');
      } finally {
        spy.mockRestore();
      }
      // Nobody holds that lock: it is released, and the retry is checked (it used to get 409
      // "already being checked" for 2 minutes).
      await expect.poll(() => ctx.redis.exists(key)).toBe(0);
      await upload(p, PDF, 'application/pdf');
      expect((await complete(uploader, p.attachmentId)).statusCode).toBe(200);
    });

    it('a confirmation that gets the lock after another finished reads the upload again', async () => {
      const p = await presign(uploader, { fileName: 'second.pdf', sizeBytes: 11 });
      await upload(p, PDF, 'application/pdf');
      // The second caller has read the row (PENDING) but takes the lock only once the first
      // confirmation is done: it must answer from the finished row, not confirm again (the upload
      // key is gone by then).
      let firstDone: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        firstDone = resolve;
      });
      const set = ctx.redis.set.bind(ctx.redis) as (...args: unknown[]) => Promise<unknown>;
      let lockCalls = 0;
      const spy = vi.spyOn(ctx.redis, 'set').mockImplementation((async (...args: unknown[]) => {
        if (String(args[0]).includes('attachment-confirm:')) {
          lockCalls += 1;
          if (lockCalls === 2) await done;
        }
        return set(...args);
      }) as never);
      try {
        const first = complete(uploader, p.attachmentId).then((res) => {
          firstDone();
          return res;
        });
        const results = await Promise.all([first, complete(uploader, p.attachmentId)]);
        expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      } finally {
        spy.mockRestore();
      }
      expect(lockCalls).toBe(2);
      expect(copiedFrom.filter((key) => key === p.upload.fields.key)).toHaveLength(1);
    });
  });

  describe('file names and content follow the declared type (review SEC-ATT-2)', () => {
    it('a name whose extension does not belong to the MIME type gets the canonical one', async () => {
      const cases = [
        ['Invoice.pdf.exe', 'application/pdf', 'Invoice.pdf.exe.pdf'],
        ['run-me.EXE', 'application/pdf', 'run-me.exe.pdf'],
        ['help.hta', 'text/plain', 'help.hta.txt'],
        ['page.html', 'text/plain', 'page.html.txt'],
        ['photo.png.scr', 'image/png', 'photo.png.scr.png'],
        ['notes', 'text/plain', 'notes.txt'],
        ['firewall.LOG', 'text/plain', 'firewall.log'],
        ['IMG_0001.JPEG', 'image/jpeg', 'IMG_0001.jpeg'],
        ['clip.m4v', 'video/mp4', 'clip.m4v'],
        ['logs.zip', 'application/x-zip-compressed', 'logs.zip'],
      ] as const;
      for (const [fileName, mimeType, stored] of cases) {
        const p = await presign(uploader, { fileName, mimeType, sizeBytes: 10 });
        expect(p.upload.fields.key!.split('/').pop(), fileName).toBe(stored);
        const row = await ctx.prisma.attachment.findUniqueOrThrow({
          where: { id: p.attachmentId },
        });
        expect(row.fileName, fileName).toBe(stored);
      }
    });

    it('lone surrogates and long Unicode names: upload, confirm and download work (≤ 200 bytes, extension kept)', async () => {
      const namer = await w.newClientX('Nora Names');
      uploaderIds.add(namer.id);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
      const cases = [
        // Two lone surrogates: MinIO refused the policy (the signed key and the posted one differed).
        { fileName: 'r\udc00\ud800.txt', mimeType: 'text/plain', content: Buffer.from('hi there') },
        // 280 / 400 UTF-8 bytes: over MinIO's 255-byte key segment.
        { fileName: `${'ت'.repeat(140)}.txt`, mimeType: 'text/plain', content: Buffer.from('نص') },
        { fileName: `${'😀'.repeat(100)}.png`, mimeType: 'image/png', content: png },
        // Marks between letters and their accents (RLM, ALM): stripped before composing, so the
        // stored name, the key and the download name agree (round-2 verify).
        {
          fileName: 'e\u200f\u0301 cafe\u061c\u0301.txt',
          mimeType: 'text/plain',
          content: Buffer.from('hi there'),
        },
      ];
      for (const { fileName, mimeType, content } of cases) {
        const p = await presign(namer, { fileName, mimeType, sizeBytes: content.length });
        const stored = p.upload.fields.key!.split('/').pop()!;
        const ext = fileName.slice(fileName.lastIndexOf('.'));
        expect(Buffer.byteLength(stored), fileName).toBeLessThanOrEqual(200);
        expect(stored.endsWith(ext), stored).toBe(true);
        expect(toWellFormed(stored), stored).toBe(stored);
        expect((await upload(p, content, mimeType)).status, stored).toBe(204);
        const done = await complete(namer, p.attachmentId);
        expect(done.statusCode, done.body).toBe(200);
        expect(done.json().attachment.fileName).toBe(stored);
        const row = await ctx.prisma.attachment.findUniqueOrThrow({
          where: { id: p.attachmentId },
        });
        expect(row.fileName).toBe(stored);
        expect(row.storageKey.endsWith(`/${stored}`)).toBe(true);
        const file = await downloaded(namer, p.attachmentId);
        expect(file.status).toBe(200);
        expect(file.disposition).toBe(`attachment; filename*=UTF-8''${rfc5987(stored)}`);
      }
      // The lone surrogates became U+FFFD; the long names were cut to whole characters.
      const rows = await ctx.prisma.attachment.findMany({
        where: { uploaderId: namer.id },
        orderBy: { createdAt: 'asc' },
        select: { fileName: true },
      });
      expect(rows[0]?.fileName).toBe('r��.txt');
      expect(rows[1]?.fileName).toBe(`${'ت'.repeat(98)}.txt`);
      expect(rows[2]?.fileName).toBe(`${'😀'.repeat(49)}.png`);
      expect(rows[3]?.fileName).toBe('\u00e9 caf\u00e9.txt');
    });

    it('the download is offered under the corrected name', async () => {
      const p = await presign(uploader, { fileName: 'Invoice.pdf.exe', sizeBytes: 11 });
      await upload(p, PDF, 'application/pdf');
      const done = await complete(uploader, p.attachmentId);
      expect(done.json().attachment.fileName).toBe('Invoice.pdf.exe.pdf');
      expect(await downloaded(uploader, p.attachmentId)).toMatchObject({
        type: 'application/pdf',
        disposition: "attachment; filename*=UTF-8''Invoice.pdf.exe.pdf",
      });
    });

    it('content that does not start like its type is REJECTED and deleted (magic numbers)', async () => {
      const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
      for (const mimeType of ['application/pdf', 'image/png', 'image/jpeg', 'application/zip']) {
        const p = await presign(uploader, { fileName: 'x', mimeType, sizeBytes: exe.length });
        expect((await upload(p, exe, mimeType)).status).toBe(204);
        const res = await complete(uploader, p.attachmentId);
        expect(res.statusCode, mimeType).toBe(400);
        expect(res.json().error.details, mimeType).toEqual({ reason: 'content' });
        const row = await ctx.prisma.attachment.findUniqueOrThrow({
          where: { id: p.attachmentId },
        });
        expect(row.status).toBe('REJECTED');
        expect(await ctx.app.storage.headObject(row.storageKey)).toBeNull();
        expect(await storedObjects(p.attachmentId)).toEqual([]);
      }
      // A real PNG header passes.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
      const ok = await presign(uploader, {
        fileName: 'pixel.png',
        mimeType: 'image/png',
        sizeBytes: 10,
      });
      await upload(ok, png, 'image/png');
      expect((await complete(uploader, ok.attachmentId)).statusCode).toBe(200);
    });
  });

  it('clients of a deactivated organisation cannot reserve uploads (review SEC-API-3)', async () => {
    const other = await ctx.fixtures.client();
    const persona = await personaFor(ctx, other.user);
    uploaderIds.add(persona.id);
    const body = { fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 5 };
    const before = await apiAs(ctx, persona).post('/attachments/presign', body);
    expect(before.statusCode).toBe(201);
    storageKeys.add(before.json().upload.fields.key);
    await ctx.prisma.organization.update({
      where: { id: other.org.id },
      data: { isActive: false },
    });
    expect((await apiAs(ctx, persona).post('/attachments/presign', body)).statusCode).toBe(403);
    // Staff are not affected.
    const staff = await apiAs(ctx, w.agentA).post('/attachments/presign', body);
    expect(staff.statusCode).toBe(201);
    storageKeys.add(staff.json().upload.fields.key);
  });

  describe('GET /attachments/:id/download', () => {
    it('viewers get a 5-minute signed link served as an attachment download', async () => {
      const id = await uploaded(uploader, 'تقرير الحادث.pdf');
      const t = await createTicket(ctx, uploader, ticketBody(w, { attachmentIds: [id] }));
      expect((t.attachments as Array<{ id: string }>).map((a) => a.id)).toEqual([id]);

      for (const viewer of [uploader, w.clientX, w.agentA, w.admin]) {
        const res = await apiAs(ctx, viewer).get(`/attachments/${id}/download`);
        expect(res.statusCode, viewer.email).toBe(200);
      }
      const res = await apiAs(ctx, w.clientX).get(`/attachments/${id}/download`);
      const link = attachmentDownloadSchema.parse(res.json());
      expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
      const file = await fetch(link.url);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe(PDF);
      expect(file.headers.get('content-disposition')).toBe(
        `attachment; filename*=UTF-8''${encodeURIComponent('تقرير الحادث.pdf')}`,
      );
      // Not a viewer of the ticket → 404.
      for (const outsider of [w.clientY, w.agentB]) {
        expect((await apiAs(ctx, outsider).get(`/attachments/${id}/download`)).statusCode).toBe(
          404,
        );
      }
    });

    it('an upload not posted yet: only its uploader', async () => {
      const id = await uploaded(uploader);
      expect((await apiAs(ctx, uploader).get(`/attachments/${id}/download`)).statusCode).toBe(200);
      expect((await apiAs(ctx, w.clientX).get(`/attachments/${id}/download`)).statusCode).toBe(404);
      expect((await apiAs(ctx, w.admin).get(`/attachments/${id}/download`)).statusCode).toBe(404);
    });

    it('files of an internal note: staff only (clients 404, never listed for them)', async () => {
      const t = await createTicket(ctx, uploader, ticketBody(w));
      const id = await uploaded(w.agentA, 'internal-findings.pdf');
      const note = await postMessage(ctx, w.agentA, t.id, {
        type: 'INTERNAL',
        body: 'Logs attached',
        attachmentIds: [id],
      });
      expect(note.statusCode).toBe(201);
      expect((await apiAs(ctx, w.agentA2).get(`/attachments/${id}/download`)).statusCode).toBe(200);
      expect((await apiAs(ctx, uploader).get(`/attachments/${id}/download`)).statusCode).toBe(404);
      const clientView = (await apiAs(ctx, uploader).get(`/tickets/${t.id}`)).json().ticket;
      expect(clientView.attachments).toEqual([]);
      const staffView = (await apiAs(ctx, w.agentA).get(`/tickets/${t.id}`)).json().ticket;
      expect(staffView.attachments.map((a: { id: string }) => a.id)).toEqual([id]);
    });

    it('unknown or not yet confirmed → 404', async () => {
      expect(
        (await apiAs(ctx, uploader).get(`/attachments/${randomUUID()}/download`)).statusCode,
      ).toBe(404);
      const p = await presign(uploader);
      expect(
        (await apiAs(ctx, uploader).get(`/attachments/${p.attachmentId}/download`)).statusCode,
      ).toBe(404);
    });
  });
});

// AWS providers without AWS (Phase 6, decisions G7 / G8): the real SES, SNS and S3 SDK clients run
// against a fake request handler, so what is checked is what would go over the wire - the
// endpoint (region), the signature scope, the default credential chain, the request body, the
// SDK's retries and the error a failed call raises. Nothing leaves the process.
import { Readable } from 'node:stream';
import type * as SesModule from '@aws-sdk/client-sesv2';
import type * as SnsModule from '@aws-sdk/client-sns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWS_REQUEST_HANDLER } from './aws.ts';
import { createSesEmailProvider } from './email/ses.ts';
import { createSnsSmsProvider } from './sms/sns.ts';
import { createS3Client, createStorage } from './storage.ts';

// The constructor input of every client the providers create (timeouts, region, credentials).
const constructed = vi.hoisted(() => ({ ses: [] as unknown[], sns: [] as unknown[] }));
vi.mock('@aws-sdk/client-sesv2', async (importOriginal) => {
  const mod = await importOriginal<typeof SesModule>();
  class Spy extends mod.SESv2Client {
    constructor(config: ConstructorParameters<typeof mod.SESv2Client>[0] = {}) {
      super(config);
      constructed.ses.push(config);
    }
  }
  return { ...mod, SESv2Client: Spy };
});
vi.mock('@aws-sdk/client-sns', async (importOriginal) => {
  const mod = await importOriginal<typeof SnsModule>();
  class Spy extends mod.SNSClient {
    constructor(config: ConstructorParameters<typeof mod.SNSClient>[0] = {}) {
      super(config);
      constructed.sns.push(config);
    }
  }
  return { ...mod, SNSClient: Spy };
});

interface SeenRequest {
  hostname: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
interface FakeResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

/** The request body as text (the SDK hands over a string or bytes). */
function bodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  return '';
}

/** An SDK request handler that records requests and answers from a script (the last one repeats). */
function fakeAws(script: FakeResponse[]) {
  const seen: SeenRequest[] = [];
  const handler = {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(request: {
      hostname: string;
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: unknown;
    }) {
      seen.push({
        hostname: request.hostname,
        method: request.method,
        path: request.path,
        headers: request.headers,
        body: bodyText(request.body),
      });
      const answer = script[Math.min(seen.length - 1, script.length - 1)]!;
      return {
        response: {
          statusCode: answer.statusCode,
          reason: '',
          headers: answer.headers ?? {},
          body: Readable.from([Buffer.from(answer.body ?? '')]),
        },
      };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {};
    },
    destroy() {},
  };
  return { handler, seen };
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const XML_HEADERS = { 'content-type': 'text/xml' };

const ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // What an ECS task / EKS pod role looks like to the SDK's default provider chain.
  process.env.AWS_ACCESS_KEY_ID = 'ASIAROLEKEYFORTESTS';
  process.env.AWS_SECRET_ACCESS_KEY = 'role-secret-for-tests';
  process.env.AWS_SESSION_TOKEN = 'role-session-token-for-tests';
  // A region in the environment must never replace the configured one.
  process.env.AWS_REGION = 'us-east-1';
  delete process.env.AWS_DEFAULT_REGION;
  constructed.ses.length = 0;
  constructed.sns.length = 0;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const email = {
  provider: 'ses' as const,
  from: 'Loons Support <support@example.com>',
  smtp: { host: 'x', port: 1, secure: false, user: undefined, password: undefined },
};

describe('SES email provider', () => {
  const message = {
    to: 'client@example.com',
    subject: 'Ticket LG-1',
    html: '<p>Hi</p>',
    text: 'Hi',
    headers: { 'X-Loons-Ticket': 'LG-1' },
  };

  it('sends through the configured region with the role credentials', async () => {
    const { handler, seen } = fakeAws([
      { statusCode: 200, headers: JSON_HEADERS, body: '{"MessageId":"ses-id-1"}' },
    ]);
    const provider = createSesEmailProvider(
      { email: { ...email, sesRegion: 'me-central-1' } },
      { clientConfig: { requestHandler: handler } },
    );
    await expect(provider.send(message)).resolves.toEqual({ messageId: 'ses-id-1' });

    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.hostname).toBe('email.me-central-1.amazonaws.com');
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v2/email/outbound-emails');
    // SigV4 scope: the configured region and service, signed with the credentials chain.
    const auth = request.headers.authorization ?? request.headers.Authorization ?? '';
    expect(auth).toMatch(/Credential=ASIAROLEKEYFORTESTS\/\d{8}\/me-central-1\/ses\/aws4_request/);
    expect(request.headers['x-amz-security-token']).toBe('role-session-token-for-tests');
    expect(JSON.parse(request.body)).toEqual({
      FromEmailAddress: 'Loons Support <support@example.com>',
      Destination: { ToAddresses: ['client@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'Ticket LG-1', Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Hi</p>', Charset: 'UTF-8' },
            Text: { Data: 'Hi', Charset: 'UTF-8' },
          },
          Headers: [{ Name: 'X-Loons-Ticket', Value: 'LG-1' }],
        },
      },
    });
    await provider.close();
  });

  it('SES_REGION is the only region used, whatever the process environment says', async () => {
    const { handler, seen } = fakeAws([
      { statusCode: 200, headers: JSON_HEADERS, body: '{"MessageId":"x"}' },
    ]);
    const provider = createSesEmailProvider(
      { email: { ...email, sesRegion: 'eu-central-1' } },
      { clientConfig: { requestHandler: handler, region: 'us-west-2' } },
    );
    await provider.send(message);
    expect(seen[0]!.hostname).toBe('email.eu-central-1.amazonaws.com');
  });

  it('never gets static credentials from configuration and has request timeouts', () => {
    createSesEmailProvider({ email: { ...email, sesRegion: 'me-central-1' } });
    const input = constructed.ses[0] as Record<string, unknown>;
    expect(input.region).toBe('me-central-1');
    expect(input).not.toHaveProperty('credentials');
    expect(input.requestHandler).toEqual(AWS_REQUEST_HANDLER);
    expect(AWS_REQUEST_HANDLER.connectionTimeout).toBeLessThanOrEqual(10_000);
    expect(AWS_REQUEST_HANDLER.requestTimeout).toBeLessThanOrEqual(30_000);
  });

  it('retries a throttled or unavailable service and then succeeds', async () => {
    const { handler, seen } = fakeAws([
      {
        statusCode: 503,
        headers: { ...JSON_HEADERS, 'x-amzn-errortype': 'ServiceUnavailableException' },
        body: '{"message":"try again"}',
      },
      { statusCode: 200, headers: JSON_HEADERS, body: '{"MessageId":"after-retry"}' },
    ]);
    const provider = createSesEmailProvider(
      { email: { ...email, sesRegion: 'me-central-1' } },
      { clientConfig: { requestHandler: handler } },
    );
    await expect(provider.send(message)).resolves.toEqual({ messageId: 'after-retry' });
    expect(seen).toHaveLength(2);
  });

  it('a rejected message (unverified identity) fails at once with the SES error', async () => {
    const { handler, seen } = fakeAws([
      {
        statusCode: 400,
        headers: { ...JSON_HEADERS, 'x-amzn-errortype': 'MessageRejected' },
        body: '{"message":"Email address is not verified."}',
      },
    ]);
    const provider = createSesEmailProvider(
      { email: { ...email, sesRegion: 'me-central-1' } },
      { clientConfig: { requestHandler: handler } },
    );
    await expect(provider.send(message)).rejects.toMatchObject({
      name: 'MessageRejected',
      message: 'Email address is not verified.',
    });
    expect(seen).toHaveLength(1); // a permanent error is not retried by the SDK
  });

  it('returns an empty id when SES answers without one', async () => {
    const { handler } = fakeAws([{ statusCode: 200, headers: JSON_HEADERS, body: '{}' }]);
    const provider = createSesEmailProvider(
      { email: { ...email, sesRegion: 'me-central-1' } },
      { clientConfig: { requestHandler: handler } },
    );
    await expect(provider.send({ ...message, headers: undefined })).resolves.toEqual({
      messageId: '',
    });
  });
});

describe('SNS SMS provider', () => {
  const sms = { provider: 'sns' as const, maxPerRecipientPerHour: 20 };
  const response = `<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishResult><MessageId>sns-id-1</MessageId></PublishResult><ResponseMetadata><RequestId>r-1</RequestId></ResponseMetadata></PublishResponse>`;

  it('publishes a transactional SMS through SNS_REGION with the role credentials', async () => {
    const { handler, seen } = fakeAws([{ statusCode: 200, headers: XML_HEADERS, body: response }]);
    const provider = createSnsSmsProvider(
      { sms: { ...sms, snsRegion: 'eu-west-1', senderId: 'LOONS' } },
      { clientConfig: { requestHandler: handler } },
    );
    await expect(provider.send({ to: '+97455501234', body: 'P1 on LG-1' })).resolves.toEqual({
      messageId: 'sns-id-1',
    });

    const request = seen[0]!;
    expect(request.hostname).toBe('sns.eu-west-1.amazonaws.com');
    const auth = request.headers.authorization ?? request.headers.Authorization ?? '';
    expect(auth).toMatch(/Credential=ASIAROLEKEYFORTESTS\/\d{8}\/eu-west-1\/sns\/aws4_request/);
    expect(request.headers['x-amz-security-token']).toBe('role-session-token-for-tests');
    const form = Object.fromEntries(new URLSearchParams(request.body));
    expect(form).toMatchObject({
      Action: 'Publish',
      PhoneNumber: '+97455501234',
      Message: 'P1 on LG-1',
    });
    const attributes = [...new URLSearchParams(request.body)].filter(([name]) =>
      name.startsWith('MessageAttributes.'),
    );
    expect(Object.fromEntries(attributes)).toMatchObject({
      'MessageAttributes.entry.1.Name': 'AWS.SNS.SMS.SMSType',
      'MessageAttributes.entry.1.Value.StringValue': 'Transactional',
      'MessageAttributes.entry.2.Name': 'AWS.SNS.SMS.SenderID',
      'MessageAttributes.entry.2.Value.StringValue': 'LOONS',
    });
    await provider.close();
  });

  it('omits the sender id when none is configured (not every country allows one)', async () => {
    const { handler, seen } = fakeAws([{ statusCode: 200, headers: XML_HEADERS, body: response }]);
    const provider = createSnsSmsProvider(
      { sms: { ...sms, snsRegion: 'me-central-1', senderId: undefined } },
      { clientConfig: { requestHandler: handler } },
    );
    await provider.send({ to: '+97455501234', body: 'hello' });
    expect(seen[0]!.body).not.toContain('SenderID');
    expect(seen[0]!.hostname).toBe('sns.me-central-1.amazonaws.com');
  });

  it('never gets static credentials from configuration and has request timeouts', () => {
    createSnsSmsProvider({ sms: { ...sms, snsRegion: 'me-central-1', senderId: undefined } });
    const input = constructed.sns[0] as Record<string, unknown>;
    expect(input.region).toBe('me-central-1');
    expect(input).not.toHaveProperty('credentials');
    expect(input.requestHandler).toEqual(AWS_REQUEST_HANDLER);
  });

  it('retries a 5xx and surfaces a permanent error as it is', async () => {
    const unavailable = `<ErrorResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><Error><Type>Receiver</Type><Code>ServiceUnavailable</Code><Message>busy</Message></Error><RequestId>r</RequestId></ErrorResponse>`;
    const first = fakeAws([
      { statusCode: 503, headers: XML_HEADERS, body: unavailable },
      { statusCode: 200, headers: XML_HEADERS, body: response },
    ]);
    const provider = createSnsSmsProvider(
      { sms: { ...sms, snsRegion: 'me-central-1', senderId: undefined } },
      { clientConfig: { requestHandler: first.handler } },
    );
    await expect(provider.send({ to: '+97455501234', body: 'x' })).resolves.toEqual({
      messageId: 'sns-id-1',
    });
    expect(first.seen).toHaveLength(2);

    const invalid = `<ErrorResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><Error><Type>Sender</Type><Code>InvalidParameter</Code><Message>Invalid parameter: PhoneNumber Reason: not valid</Message></Error><RequestId>r</RequestId></ErrorResponse>`;
    const second = fakeAws([{ statusCode: 400, headers: XML_HEADERS, body: invalid }]);
    const strict = createSnsSmsProvider(
      { sms: { ...sms, snsRegion: 'me-central-1', senderId: undefined } },
      { clientConfig: { requestHandler: second.handler } },
    );
    await expect(strict.send({ to: '12', body: 'x' })).rejects.toMatchObject({
      name: 'InvalidParameterException',
    });
    expect(second.seen).toHaveLength(1);
  });
});

describe('S3 storage client', () => {
  const aws = {
    region: 'me-central-1',
    bucket: 'loons-helpdesk-attachments',
    endpoint: undefined,
    forcePathStyle: false,
    accessKeyId: undefined,
    secretAccessKey: undefined,
    uploadMaxBytes: 25 * 1024 * 1024,
  };

  it('on AWS: the regional virtual-hosted endpoint, signed with the credentials chain', async () => {
    const { handler, seen } = fakeAws([
      { statusCode: 200, headers: { 'content-length': '12', 'content-type': 'image/png' } },
    ]);
    const client = createS3Client(aws, { requestHandler: handler });
    const storage = createStorage(aws, { client });
    await storage.headObject('files/a/b/pic.png');

    const request = seen[0]!;
    expect(request.hostname).toBe('loons-helpdesk-attachments.s3.me-central-1.amazonaws.com');
    expect(request.method).toBe('HEAD');
    const auth = request.headers.authorization ?? request.headers.Authorization ?? '';
    expect(auth).toMatch(/Credential=ASIAROLEKEYFORTESTS\/\d{8}\/me-central-1\/s3\/aws4_request/);
    expect(request.headers['x-amz-security-token']).toBe('role-session-token-for-tests');
  });

  it('presigned downloads and uploads point at the regional bucket and carry the role scope', async () => {
    const client = createS3Client(aws);
    const storage = createStorage(aws, { client });
    const download = new URL(
      await storage.getDownloadUrl('files/a/b/pic.png', {
        fileName: 'pic.png',
        contentType: 'image/png',
      }),
    );
    expect(download.hostname).toBe('loons-helpdesk-attachments.s3.me-central-1.amazonaws.com');
    expect(download.searchParams.get('X-Amz-Credential')).toMatch(
      /^ASIAROLEKEYFORTESTS\/\d{8}\/me-central-1\/s3\/aws4_request$/,
    );
    expect(download.searchParams.get('X-Amz-Security-Token')).toBe('role-session-token-for-tests');

    const post = await storage.createUploadPost({
      key: 'attachments/a/pic.png',
      contentType: 'image/png',
      maxBytes: 1024,
    });
    expect(new URL(post.url).hostname).toBe(
      'loons-helpdesk-attachments.s3.me-central-1.amazonaws.com',
    );
    expect(post.fields['X-Amz-Credential']).toMatch(/\/me-central-1\/s3\/aws4_request$/);
  });

  it('on AWS no custom endpoint or path-style flag reaches the client', () => {
    const client = createS3Client(aws);
    expect(client.config.forcePathStyle).toBeFalsy();
    expect(client.config.isCustomEndpoint).toBeFalsy();
  });

  it('locally (MinIO): the endpoint, path-style addressing and the static keys are used', async () => {
    const minio = {
      ...aws,
      region: 'us-east-1',
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
      accessKeyId: 'minio-key',
      secretAccessKey: 'minio-secret',
    };
    const { handler, seen } = fakeAws([{ statusCode: 200, headers: { 'content-length': '1' } }]);
    const storage = createStorage(minio, {
      client: createS3Client(minio, { requestHandler: handler }),
    });
    await storage.headObject('files/a/b/pic.png');
    expect(seen[0]!.hostname).toBe('minio');
    expect(seen[0]!.path).toBe('/loons-helpdesk-attachments/files/a/b/pic.png');
    const auth = seen[0]!.headers.authorization ?? seen[0]!.headers.Authorization ?? '';
    expect(auth).toMatch(/Credential=minio-key\//);
  });

  it('a missing object is a 404 -> null; a 403 (no s3:ListBucket on AWS) is an error, not "missing"', async () => {
    // S3 answers 404 for a missing key only to a caller that may list the bucket, and 403
    // otherwise; the policy in docs/DEPLOYMENT.md therefore grants s3:ListBucket.
    const missing = fakeAws([{ statusCode: 404 }]);
    const storage404 = createStorage(aws, {
      client: createS3Client(aws, { requestHandler: missing.handler }),
    });
    await expect(storage404.headObject('files/a/b/none.png')).resolves.toBeNull();
    await expect(storage404.readObjectStart('files/a/b/none.png', 16)).resolves.toBeNull();

    const denied = fakeAws([{ statusCode: 403 }]);
    const storage403 = createStorage(aws, {
      client: createS3Client(aws, { requestHandler: denied.handler }),
    });
    await expect(storage403.headObject('files/a/b/none.png')).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
  });

  it('the pre-signed POST carries the role session token the browser must send back', async () => {
    const storage = createStorage(aws, { client: createS3Client(aws) });
    const post = await storage.createUploadPost({
      key: 'attachments/a/pic.png',
      contentType: 'image/png',
      maxBytes: 1024,
    });
    expect(post.fields['X-Amz-Security-Token']).toBe('role-session-token-for-tests');
  });

  it('has connection and idle timeouts', async () => {
    const client = createS3Client(aws);
    const handler = client.config.requestHandler as unknown as {
      configProvider: Promise<{ connectionTimeout?: number; requestTimeout?: number }>;
    };
    await expect(handler.configProvider).resolves.toMatchObject({
      connectionTimeout: 5_000,
      requestTimeout: 120_000,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { buildTeamsCard } from '@loons/emails';
import { createConsoleTeamsProvider } from './console.ts';
import { TeamsPermanentError } from './provider.ts';
import { createWebhookTeamsProvider, hostAllowed, webhookUrlProblem } from './webhook.ts';

// Decision D12: TEAMS_PROVIDER=console logs one redacted line; webhook POSTs over HTTPS to an
// allow-listed host with a timeout. The webhook URL (a secret) never appears in a log, an error
// or a delivery record.

const HOSTS = ['*.webhook.office.com', 'prod.example.org'];
const SECRET_URL = 'https://tenant.webhook.office.com/webhookb2/abc@def/IncomingWebhook/SECRET/xyz';
const message = buildTeamsCard({
  kind: 'P1_CREATED',
  ticketNumber: 4821,
  subject: 'Camera offline',
  priority: 'P1',
  teamName: 'SOC',
  orgName: 'HMC',
  categoryName: 'Cybersecurity',
  step: 1,
  ticketUrl: 'https://help.example.com/console/inbox?ticket=LG-4821',
  ackUrl: 'https://help.example.com/console/inbox?ticket=LG-4821',
});
const config = (timeoutMs = 1000) => ({
  teams: { provider: 'webhook' as const, webhookHosts: HOSTS, timeoutMs },
});

describe('Teams webhook provider', () => {
  it('allow-list: exact hosts, and *.domain for sub-domains only', () => {
    expect(hostAllowed('tenant.webhook.office.com', HOSTS)).toBe(true);
    expect(hostAllowed('a.b.webhook.office.com', HOSTS)).toBe(true);
    expect(hostAllowed('webhook.office.com', HOSTS)).toBe(false);
    expect(hostAllowed('evilwebhook.office.com', HOSTS)).toBe(false);
    expect(hostAllowed('prod.example.org', HOSTS)).toBe(true);
    expect(hostAllowed('x.prod.example.org', HOSTS)).toBe(false);
    expect(hostAllowed('PROD.EXAMPLE.ORG.', HOSTS)).toBe(true);
  });

  it('refuses anything but HTTPS to an allowed host on the default port, without credentials', () => {
    expect(webhookUrlProblem(SECRET_URL, HOSTS)).toBeNull();
    expect(webhookUrlProblem('http://tenant.webhook.office.com/x', HOSTS)).toMatch(/https/);
    expect(webhookUrlProblem('https://169.254.169.254/latest', HOSTS)).toMatch(/not in/);
    expect(webhookUrlProblem('https://user:pw@tenant.webhook.office.com/x', HOSTS)).toMatch(
      /credentials/,
    );
    expect(webhookUrlProblem('https://tenant.webhook.office.com:8443/x', HOSTS)).toMatch(/port/);
    expect(webhookUrlProblem('not a url', HOSTS)).toMatch(/valid/);
  });

  it('posts the card as JSON, refuses redirects, and records the host only', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = createWebhookTeamsProvider(config(), async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response('1', { status: 200 });
    });
    expect(provider.describe(SECRET_URL)).toBe('tenant.webhook.office.com');
    expect(provider.describe(null)).toBe('none');
    const result = await provider.post({ webhookUrl: SECRET_URL, message });
    expect(result.status).toBe('sent');
    expect(calls[0]!.url).toBe(SECRET_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(message);
    expect(await provider.post({ webhookUrl: null, message })).toEqual({
      status: 'skipped',
      reason: 'the team has no Teams webhook',
    });
  });

  it('errors never contain the URL: 5xx / 429 / 408 / timeouts retry, other 4xx and refused URLs do not', async () => {
    const answer = (status: number) =>
      createWebhookTeamsProvider(config(), async () => new Response('no', { status }));
    for (const status of [500, 503, 429, 408]) {
      const err = await answer(status)
        .post({ webhookUrl: SECRET_URL, message })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TeamsPermanentError);
      expect((err as Error).message).not.toContain('SECRET');
      expect((err as Error).message).toContain('tenant.webhook.office.com');
    }
    for (const status of [400, 403, 404]) {
      await expect(answer(status).post({ webhookUrl: SECRET_URL, message })).rejects.toBeInstanceOf(
        TeamsPermanentError,
      );
    }
    await expect(
      answer(200).post({ webhookUrl: 'https://evil.example.net/SECRET', message }),
    ).rejects.toBeInstanceOf(TeamsPermanentError);

    const failing = createWebhookTeamsProvider(config(), async () => {
      throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${SECRET_URL}`);
    });
    const network = (await failing
      .post({ webhookUrl: SECRET_URL, message })
      .catch((e: unknown) => e)) as Error;
    expect(network.message).toBe(
      'Teams webhook request to tenant.webhook.office.com failed: network error',
    );

    const slow = createWebhookTeamsProvider(
      config(50),
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const timeout = (await slow
      .post({ webhookUrl: SECRET_URL, message })
      .catch((e: unknown) => e)) as Error;
    expect(timeout.message).toMatch(/timed out after 50 ms/);
    expect(timeout.message).not.toContain('SECRET');
  });

  it('console provider: one log line with the card title and the host, never the URL', async () => {
    const lines: unknown[] = [];
    const logger = { info: (obj: unknown, msg: string) => lines.push({ obj, msg }) } as never;
    const provider = createConsoleTeamsProvider(logger);
    expect(provider.describe(SECRET_URL)).toBe('console');
    expect(await provider.post({ webhookUrl: SECRET_URL, message })).toMatchObject({
      status: 'sent',
    });
    expect(await provider.post({ webhookUrl: null, message })).toMatchObject({ status: 'sent' });
    const text = JSON.stringify(lines);
    expect(text).toContain('P1 critical ticket · LG-4821');
    expect(text).toContain('tenant.webhook.office.com');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('webhookb2');
  });
});

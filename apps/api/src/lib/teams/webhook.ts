import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.ts';
import { urlHost } from '../pii.ts';
import { TeamsPermanentError, type TeamsProvider } from './provider.ts';

/** Whether `host` matches one of the patterns (`example.com`, or `*.example.com` = sub-domains). */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((pattern) =>
    pattern.startsWith('*.')
      ? h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1
      : h === pattern,
  );
}

/**
 * Why a webhook URL may not be used, or null when it may: HTTPS only, no credentials, the default
 * port, and a host on the allow-list (a Phase 4 admin edit must not turn the worker into a proxy
 * to internal addresses).
 */
export function webhookUrlProblem(raw: string, allowedHosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'the Teams webhook URL is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'the Teams webhook URL must use https';
  if (url.username || url.password) return 'the Teams webhook URL must not contain credentials';
  if (url.port && url.port !== '443') return 'the Teams webhook URL must use the default port';
  if (!hostAllowed(url.hostname, allowedHosts)) {
    return `the Teams webhook host ${url.hostname} is not in TEAMS_WEBHOOK_HOSTS`;
  }
  return null;
}

/** POSTs the card to the team's incoming webhook / Power Automate workflow URL. */
export function createWebhookTeamsProvider(
  config: Pick<AppConfig, 'teams'>,
  fetchImpl: typeof fetch = fetch,
): TeamsProvider {
  const { webhookHosts, timeoutMs } = config.teams;
  return {
    name: 'webhook',
    describe: (webhookUrl) => (webhookUrl ? urlHost(webhookUrl) : 'none'),
    async post({ webhookUrl, message }) {
      if (!webhookUrl) return { status: 'skipped', reason: 'the team has no Teams webhook' };
      const problem = webhookUrlProblem(webhookUrl, webhookHosts);
      if (problem) throw new TeamsPermanentError(problem);
      let res: Response;
      try {
        res = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          // A redirect could lead anywhere (the allow-list checked this URL only).
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Never the error itself: undici puts the URL (with its secret) in some messages.
        const name = err instanceof Error ? err.name : 'Error';
        const reason =
          name === 'TimeoutError' || name === 'AbortError'
            ? `timed out after ${timeoutMs} ms`
            : 'network error';
        throw new Error(`Teams webhook request to ${urlHost(webhookUrl)} failed: ${reason}`);
      }
      // The body is not needed (legacy connectors answer "1", workflows 202 with nothing).
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return { status: 'sent', messageId: `teams-${randomUUID()}` };
      const text = `Teams webhook ${urlHost(webhookUrl)} answered ${res.status}`;
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw new Error(text);
      throw new TeamsPermanentError(text);
    },
  };
}

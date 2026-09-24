// Reads emails the API sent to Mailpit (local SMTP catcher, docker-compose.yml).
import { expect, type APIRequestContext } from '@playwright/test';

const MAILPIT_API_URL = (process.env.MAILPIT_API_URL || 'http://localhost:8025/api/v1').replace(
  /\/+$/,
  '',
);

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
}

/** Messages to `address`, newest first. */
async function messagesTo(request: APIRequestContext, address: string): Promise<MailpitSummary[]> {
  const url = `${MAILPIT_API_URL}/search?query=${encodeURIComponent(`to:"${address}"`)}`;
  const response = await request.get(url);
  expect(response.ok(), `Mailpit search failed (${response.status()}): is Mailpit running?`).toBe(
    true,
  );
  const body = (await response.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
}

/**
 * Waits for the first email to `address` whose text contains a link matching `pattern` and
 * returns that link's path + query (relative, so it works whatever APP_URL's host is).
 * The API sends mail through the BullMQ worker, so this can take a few seconds.
 */
export async function waitForEmailLink(
  request: APIRequestContext,
  address: string,
  pattern: RegExp,
  timeout = 45_000,
): Promise<string> {
  let link: string | null = null;
  await expect
    .poll(
      async () => {
        for (const summary of await messagesTo(request, address)) {
          const response = await request.get(`${MAILPIT_API_URL}/message/${summary.ID}`);
          if (!response.ok()) continue;
          const message = (await response.json()) as { Text?: string; HTML?: string };
          const match = pattern.exec(`${message.Text ?? ''}\n${message.HTML ?? ''}`);
          if (match) {
            const url = new URL(match[0].replace(/&amp;/g, '&'));
            link = `${url.pathname}${url.search}`;
            return true;
          }
        }
        return false;
      },
      {
        message: `No email with a matching link reached ${address} (is the API worker running?)`,
        timeout,
        intervals: [500, 1_000, 2_000],
      },
    )
    .toBe(true);
  return link ?? '';
}

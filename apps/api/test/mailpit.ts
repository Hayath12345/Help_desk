// Mailpit (docker-compose, SMTP :1025) search helpers for tests that send real email.

export const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025/api/v1';

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

/** Messages matching a Mailpit search query, e.g. `to:"a@b.example"`. */
export async function mailpitSearch(query: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}&limit=200`);
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages;
}

export const mailpitTo = (address: string) => mailpitSearch(`to:"${address}"`);

/** The HTML and text of one message. */
export async function mailpitMessage(id: string): Promise<{ HTML: string; Text: string }> {
  const res = await fetch(`${MAILPIT_API}/message/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Mailpit message failed: ${res.status}`);
  return (await res.json()) as { HTML: string; Text: string };
}

/** Deletes every message sent to one of `addresses`. */
export async function mailpitDeleteTo(addresses: readonly string[]): Promise<void> {
  const ids: string[] = [];
  for (const address of addresses) ids.push(...(await mailpitTo(address)).map((m) => m.ID));
  if (ids.length === 0) return;
  await fetch(`${MAILPIT_API}/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: ids }),
  });
}

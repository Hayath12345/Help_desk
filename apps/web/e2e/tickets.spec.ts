// Phase 2 "done when" flow (docs/PHASE2_CONTRACT.md → Tests → E2E), with two browser contexts:
// the client raises a ticket in the portal (with an attachment) → it appears in the agent's inbox
// without a reload → the agent replies publicly → the client sees the reply without a reload → the
// agent adds an internal note with a file → the client never receives it (page, HTTP responses and
// socket frames) → the agent solves the ticket → the client's page shows Solved without a reload.
// Uploads cross both halves here: a JPEG named .png is stored and downloaded as .jpg, and a note's
// file is presigned `internal`, never shows on the Public reply tab and is linked to the note only.
//
// Needs the API (Socket.IO) + web app with the seeded demo data (the Playwright config starts or
// reuses them) and MinIO for the attachment. Tickets are created with an `[e2e:<timestamp>]` subject
// prefix; the global teardown deletes them (packages/db/scripts/e2e-users.ts → e2eTicketWhere).
import { readFileSync } from 'node:fs';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';
import { ENGLISH_STORAGE_STATE } from './fixtures';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'LoonsDemo2026';
const CLIENT_EMAIL = 'aisha.alkuwari@hamad.qa'; // Hamad Medical Corporation
// SOC agent: "Cybersecurity / SOC" tickets are routed to the SOC team.
const AGENT_EMAIL = 'maya.ruiz@loonsgroup.com';
const CATEGORY = 'Cybersecurity / SOC';
const SUBTYPE = 'Firewall / VPN issue';
const SITE = 'HMC – Building 3, Level 2';

/** Must match E2E_TICKET_SUBJECT_PREFIX in packages/db/scripts/e2e-users.ts. */
const E2E_SUBJECT_PREFIX = '[e2e:';

async function signIn(
  browser: Browser,
  baseURL: string | undefined,
  kind: 'client' | 'staff',
  options: { viewport?: { width: number; height: number } } = {},
) {
  const context = await browser.newContext({
    baseURL,
    storageState: ENGLISH_STORAGE_STATE,
    ...(options.viewport ? { viewport: options.viewport } : {}),
  });
  const page = await context.newPage();
  await page.goto(kind === 'client' ? '/login' : '/staff/login');
  const email = page.getByLabel('Email', { exact: true });
  if (kind === 'staff') {
    test.skip(
      (await email.count()) === 0,
      'Dev staff sign-in is disabled (Entra ID configured or AUTH_DEV_STAFF_LOGIN off)',
    );
  }
  await email.fill(kind === 'client' ? CLIENT_EMAIL : AGENT_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(kind === 'client' ? /\/tickets(?:[/?#]|$)/ : /\/console\/inbox/);
  return { context, page };
}

/** Everything the client's browser receives: HTTP bodies and Socket.IO frames (both transports). */
function recordTraffic(page: Page) {
  const bodies: Promise<string>[] = [];
  const frames: string[] = [];
  page.on('response', (response: Response) => {
    const type = response.request().resourceType();
    if (type !== 'fetch' && type !== 'xhr' && type !== 'document') return;
    bodies.push(response.text().catch(() => ''));
  });
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      frames.push(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString());
    });
  });
  return {
    frames,
    async received(): Promise<string> {
      return [...(await Promise.all(bodies)), ...frames].join('\n');
    },
  };
}

/** Console errors and CSP violations (the pages must render and talk to the API/storage cleanly). */
function recordProblems(page: Page, who: string, sink: string[]) {
  page.on('console', (message) => {
    if (message.type() === 'error') sink.push(`[${who}] ${message.text()}`);
  });
  page.on('pageerror', (error) => sink.push(`[${who}] ${error.message}`));
}

/** A marker that only survives as long as the document isn't reloaded. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload = true;
  });
}
async function expectNotReloaded(page: Page) {
  expect(
    await page.evaluate(() => (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload),
    'the page was reloaded',
  ).toBe(true);
}

/** Clicks `button` and waits until the API has stored the message it sends (201). */
async function sendAndWaitStored(page: Page, button: string) {
  const stored = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/tickets\/[0-9a-f-]{36}\/messages$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: button, exact: true }).click();
  expect((await stored).status()).toBe(201);
}

/** Radix Select: open the trigger labelled `label`, pick the option whose name starts with `option`. */
async function chooseOption(scope: Page, label: string, option: string) {
  await scope.getByRole('combobox', { name: label }).click();
  await scope.getByRole('option', { name: option }).first().click();
}

const PHONE = { width: 390, height: 844 };

/** The first bytes of a JPEG (what the API sniffs): a photo whose name says .png. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);

/** Resolves with the JSON body of the next POST /attachments/presign the page sends. */
function nextPresignBody(page: Page): Promise<Record<string, unknown>> {
  return page
    .waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/attachments/presign'),
    )
    .then((request) => request.postDataJSON() as Record<string, unknown>);
}

/** UI text the phone checks look for, from the app's own message files. */
function uiText(locale: 'en' | 'ar') {
  const read = (file: string) =>
    JSON.parse(
      readFileSync(new URL(`../messages/${locale}/${file}.json`, import.meta.url), 'utf8'),
    );
  const common = read('common') as { newTicket: string };
  const tickets = read('tickets') as {
    newTicket: { title: string };
    attachments: { label: string; retry: string; remove: string };
  };
  const portal = read('portal') as { reply: { label: string; attach: string } };
  return {
    newTicket: common.newTicket,
    newTicketTitle: tickets.newTicket.title,
    attachments: tickets.attachments.label,
    retry: (name: string) => tickets.attachments.retry.replace('{name}', name),
    remove: (name: string) => tickets.attachments.remove.replace('{name}', name),
    replyLabel: portal.reply.label,
    attach: portal.reply.attach,
  };
}

/** Switches the UI language (the cookie wins over the profile) and reloads the page. */
async function switchLocale(page: Page, locale: 'en' | 'ar') {
  await page.context().addCookies([{ ...ENGLISH_STORAGE_STATE.cookies[0]!, value: locale }]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
}

/**
 * The failed upload `name` inside `scope`: Retry / Remove are visible, described by the reason
 * under the chip, and lie inside the chip; the chip lies inside the attachments list on both
 * inline edges; the list fits the phone; the name keeps a readable width.
 */
async function expectFailedChipFits(scope: Locator, name: string, text: ReturnType<typeof uiText>) {
  const retry = scope.getByRole('button', { name: text.retry(name), exact: true });
  const remove = scope.getByRole('button', { name: text.remove(name), exact: true });
  await expect(retry).toBeVisible();
  await expect(remove).toBeVisible();
  // The reason sits under the chip and describes both buttons (found by aria-describedby, so we
  // don't collide with the sr-only status region that embeds the same phrase).
  const reasonId = await remove.getAttribute('aria-describedby');
  expect(reasonId).toBeTruthy();
  await expect(retry).toHaveAttribute('aria-describedby', reasonId!);
  const reason = scope.locator(`[id="${reasonId}"]`);
  await expect(reason).toBeVisible();
  expect((await reason.textContent())?.trim().length ?? 0).toBeGreaterThan(0);

  const list = scope.getByRole('list', { name: text.attachments, exact: true });
  const chip = remove.locator('xpath=..');
  // Measure once the chip's entry animation (fade / layout) has settled: two reads in a row agree.
  let settled = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await chip.boundingBox());
      const same = box === settled;
      settled = box;
      return same;
    })
    .toBe(true);
  const listBox = (await list.boundingBox())!;
  const chipBox = (await chip.boundingBox())!;
  expect(chipBox.x, 'chip starts inside the list (left edge)').toBeGreaterThanOrEqual(
    listBox.x - 1,
  );
  expect(chipBox.x + chipBox.width, 'chip ends inside the list (right edge)').toBeLessThanOrEqual(
    listBox.x + listBox.width + 1,
  );
  expect(listBox.x, 'list starts on the screen').toBeGreaterThanOrEqual(0);
  expect(listBox.x + listBox.width, 'list fits the phone width').toBeLessThanOrEqual(PHONE.width);
  for (const button of [retry, remove]) {
    const box = (await button.boundingBox())!;
    expect(box.x, 'button starts inside the chip').toBeGreaterThanOrEqual(chipBox.x - 1);
    expect(box.x + box.width, 'button ends inside the chip').toBeLessThanOrEqual(
      chipBox.x + chipBox.width + 1,
    );
  }
  const nameBox = (await chip.locator(`[title="${name}"]`).boundingBox())!;
  expect(nameBox.width, 'file name is readable').toBeGreaterThan(40);
}

test.describe('tickets & realtime chat', () => {
  let contexts: BrowserContext[] = [];

  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  test('client ticket → agent reply in realtime; internal notes never reach the client', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const subject = `${E2E_SUBJECT_PREFIX}${stamp}] VPN tunnel drops every few minutes`;
    const description = `Site-to-site VPN to Building 3 drops every 5–10 minutes since this morning (${stamp}).`;
    const reply = `We are checking the VPN concentrator logs now (${stamp}).`;
    const note = `INTERNAL-ONLY-${stamp}: suspect the ISP link flapping on tunnel 2`;
    const noteFile = `isp-trace-${stamp}.log`;

    const agent = await signIn(browser, baseURL, 'staff');
    const client = await signIn(browser, baseURL, 'client');
    contexts = [agent.context, client.context];
    const traffic = recordTraffic(client.page);
    const problems: string[] = [];
    recordProblems(agent.page, 'agent', problems);
    recordProblems(client.page, 'client', problems);

    // The agent watches the SOC team's unassigned queue (live over the team room).
    await agent.page.goto('/console/inbox?view=unassigned');
    await expect(agent.page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    await markDocument(agent.page);

    // ── The client raises the ticket with an attachment.
    await client.page.getByRole('button', { name: 'New ticket' }).first().click();
    const dialog = client.page.getByRole('dialog', { name: 'New ticket' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Subject/).fill(subject);
    await chooseOption(client.page, 'Category', CATEGORY);
    await chooseOption(client.page, 'Sub-type', SUBTYPE);
    await chooseOption(client.page, 'Site / location', SITE);
    await dialog.getByLabel(/^Description/).fill(description);
    await dialog.locator('input[type="file"]').setInputFiles([
      {
        name: 'vpn-drops.log',
        mimeType: 'text/plain',
        buffer: Buffer.from(`${new Date(stamp).toISOString()} tunnel 2 down\n`),
      },
      // A JPEG named .png: the API stores it as what it really is.
      { name: 'camera-14.png', mimeType: 'image/png', buffer: JPEG_BYTES },
    ]);
    // Uploaded (presign → storage → complete): the chip offers "Remove" and no progress.
    await expect(dialog.getByRole('button', { name: 'Remove vpn-drops.log' })).toBeVisible();
    await expect(dialog.getByLabel('Uploading vpn-drops.log')).toHaveCount(0);
    // The photo's chip takes the stored name once complete answered.
    await expect(dialog.getByRole('button', { name: 'Remove camera-14.jpg' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Remove camera-14.png' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Create ticket' }).click();

    await expect(client.page).toHaveURL(/\/tickets\/LG-\d+$/);
    const ref = /\/tickets\/(LG-\d+)$/.exec(client.page.url())?.[1];
    expect(ref).toBeTruthy();
    await expect(client.page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
    // The attachment downloads through a short-lived signed URL, under its own name.
    const [download] = await Promise.all([
      client.page.waitForEvent('download'),
      client.page.getByRole('button', { name: 'Download vpn-drops.log' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('vpn-drops.log');
    expect(await download.failure()).toBeNull();
    const [photo] = await Promise.all([
      client.page.waitForEvent('download'),
      client.page.getByRole('button', { name: 'Download camera-14.jpg' }).click(),
    ]);
    expect(photo.suggestedFilename()).toBe('camera-14.jpg');
    expect(await photo.failure()).toBeNull();
    await markDocument(client.page);

    // ── It shows up in the agent's inbox without a reload.
    const row = agent.page.locator(`a[data-ticket-ref="${ref}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(subject);
    await expectNotReloaded(agent.page);
    await row.click();
    await expect(agent.page.getByRole('heading', { name: subject })).toBeVisible();
    await expect(agent.page.getByText(description)).toBeVisible();
    await expect(agent.page.getByRole('button', { name: 'Download vpn-drops.log' })).toBeVisible();

    // ── Public reply → the client sees it without a reload.
    await agent.page.getByRole('textbox', { name: /^Public reply to/ }).fill(reply);
    await sendAndWaitStored(agent.page, 'Send reply');
    await expect(client.page.getByText(reply)).toBeVisible({ timeout: 20_000 });
    await expectNotReloaded(client.page);

    // ── Internal note with a file: visible to staff, never to the client.
    await agent.page.getByRole('tab', { name: 'Internal note' }).click();
    const composer = agent.page.locator('[data-mode="internal"]');
    const presigned = nextPresignBody(agent.page);
    await composer.locator('input[type="file"]').setInputFiles({
      name: noteFile,
      mimeType: 'text/plain',
      buffer: Buffer.from(`${new Date(stamp).toISOString()} tunnel 2 flaps at ISP hop 3
`),
    });
    // Uploaded for the note only (the API links it to nothing else).
    expect(await presigned).toMatchObject({ fileName: noteFile, visibility: 'internal' });
    await expect(composer.getByRole('button', { name: `Remove ${noteFile}` })).toBeVisible();
    await expect(composer.getByLabel(`Uploading ${noteFile}`)).toHaveCount(0);
    // The Public reply tab neither shows the note's file nor would send it.
    await agent.page.getByRole('tab', { name: 'Public reply' }).click();
    await expect(agent.page.locator('[data-mode="public"]')).toBeVisible();
    await expect(agent.page.getByRole('button', { name: `Remove ${noteFile}` })).toHaveCount(0);
    await agent.page.getByRole('tab', { name: 'Internal note' }).click();
    await expect(composer.getByRole('button', { name: `Remove ${noteFile}` })).toBeVisible();
    await agent.page.getByRole('textbox', { name: /^Internal note/ }).fill(note);
    await sendAndWaitStored(agent.page, 'Add note');
    await expect(agent.page.getByText(note)).toBeVisible();
    await expect(agent.page.getByRole('button', { name: `Download ${noteFile}` })).toBeVisible();

    // ── Status → Solved; the client's page follows without a reload.
    await agent.page.getByRole('radio', { name: 'Solved', exact: true }).click();
    const clientStatus = client.page.locator('h1 + [data-status]');
    await expect(clientStatus).toHaveAttribute('data-status', 'SOLVED', { timeout: 20_000 });
    await expect(clientStatus).toHaveText('Solved');
    await expect(client.page.getByRole('button', { name: 'Reopen ticket' })).toBeVisible();
    await expectNotReloaded(client.page);

    // The note was posted before the status change, so anything the client could have received
    // about it has arrived by now. Check the page, a fresh load, and everything on the wire.
    await expect(client.page.getByText(note)).toHaveCount(0);
    await client.page.reload();
    await expect(client.page.getByText(reply)).toBeVisible();
    await expect(client.page.getByText(note)).toHaveCount(0);
    await expect(client.page.getByText(noteFile)).toHaveCount(0);
    expect(traffic.frames.length, 'the client received socket frames').toBeGreaterThan(0);
    const received = await traffic.received();
    expect(received).toContain(reply); // sanity: the capture does see the conversation
    expect(received).not.toContain(note);
    expect(received).not.toContain(`INTERNAL-ONLY-${stamp}`);
    expect(received).not.toContain(noteFile);
    expect(problems, 'console errors / CSP violations').toEqual([]);
  });

  // A failed upload on a phone (UI-RR-1): the failure reason used to sit inside the chip,
  // squeezing the name to 0 px and pushing Retry / Remove out of the clipped chip. Checked in both
  // UI languages (in Arabic an overflow would run past the inline-start, i.e. the left, edge) and
  // in both places the shared chip is used by clients: the New ticket modal and the reply box.
  for (const locale of ['en', 'ar'] as const) {
    test(`a failed upload keeps its name and buttons inside the chip on a phone: New ticket (${locale}; UI-RR-1)`, async ({
      browser,
      baseURL,
    }) => {
      const client = await signIn(browser, baseURL, 'client', { viewport: PHONE });
      contexts = [client.context];
      await switchLocale(client.page, locale);
      const text = uiText(locale);
      // The presign never reaches the API, so the upload fails as a network error and nothing is
      // stored (no attachment row, no object) — no cleanup needed.
      await client.page.route('**/attachments/presign', (route) => route.abort());

      await client.page.getByRole('button', { name: text.newTicket }).first().click();
      const dialog = client.page.getByRole('dialog', { name: text.newTicketTitle });
      await expect(dialog).toBeVisible();
      const name = 'camera-12-lobby-entrance.png';
      await dialog.locator('input[type="file"]').setInputFiles({
        name,
        mimeType: 'image/png',
        buffer: Buffer.from('not a png'),
      });

      await expectFailedChipFits(dialog, name, text);
      // The buttons work: Remove clears the chip.
      await dialog.getByRole('button', { name: text.remove(name), exact: true }).click();
      await expect(dialog.getByText(name, { exact: true })).toHaveCount(0);
    });
  }

  test('a failed upload keeps its name and buttons inside the chip on a phone: reply box (en, ar; UI-RR-1)', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    // `[e2e:<stamp>]`: the global teardown deletes the ticket (e2eTicketWhere).
    const subject = `${E2E_SUBJECT_PREFIX}${stamp}] Reply box chip layout on a phone`;
    const client = await signIn(browser, baseURL, 'client');
    contexts = [client.context];

    // A ticket of our own to reply on (no attachment: nothing is stored in MinIO).
    await client.page.getByRole('button', { name: 'New ticket', exact: true }).first().click();
    const dialog = client.page.getByRole('dialog', { name: 'New ticket' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Subject/).fill(subject);
    await chooseOption(client.page, 'Category', CATEGORY);
    await chooseOption(client.page, 'Sub-type', SUBTYPE);
    await chooseOption(client.page, 'Site / location', SITE);
    await dialog
      .getByLabel(/^Description/)
      .fill(`Checking the reply box on a phone (${stamp}); please ignore.`);
    await dialog.getByRole('button', { name: 'Create ticket' }).click();
    await expect(client.page).toHaveURL(/\/tickets\/LG-\d+$/);
    await expect(client.page.getByRole('heading', { level: 1, name: subject })).toBeVisible();

    await client.page.setViewportSize(PHONE);
    // Reply uploads fail before reaching storage (see above).
    await client.page.route('**/attachments/presign', (route) => route.abort());
    const name = '2026-09-24 firewall-cluster-b.log';
    for (const locale of ['en', 'ar'] as const) {
      await switchLocale(client.page, locale);
      const text = uiText(locale);
      await expect(client.page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
      const form = client.page.getByRole('form', { name: text.replyLabel });
      await expect(form).toBeVisible();
      // "Attach files" opens the attachment zone and the file picker within the same click.
      const chooser = client.page.waitForEvent('filechooser');
      await form.getByRole('button', { name: text.attach, exact: true }).click();
      await (
        await chooser
      ).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`${stamp}\n`) });

      await expectFailedChipFits(form, name, text);
      await form.getByRole('button', { name: text.remove(name), exact: true }).click();
      await expect(form.getByText(name, { exact: true })).toHaveCount(0);
    }
  });
});

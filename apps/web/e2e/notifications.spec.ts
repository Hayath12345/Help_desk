// Phase 3 "done when" flow (docs/PHASE3_CONTRACT.md → Tests → E2E, spec §12 "P1 creation
// triggers notifications"): a client raises a P1 in the portal ⇒ Mailpit receives the SOC team's
// distribution-list email and the on-call agent's P1 alert; NotificationDelivery holds the TEAMS
// card and the SMS for the ticket (read through @loons/db, like the global teardown); the on-call
// agent sees the P1 banner in the console and the ticket in the notification bell, acknowledges,
// and the banner switches to "Acknowledged by …" (and stays so after a reload).
//
// Needs the API + worker + web app with the seeded demo data (the Playwright config starts or
// reuses them), Mailpit, and the local providers (TEAMS_PROVIDER / SMS_PROVIDER = console record
// the deliveries). The ticket gets an `[e2e:<timestamp>]` subject prefix; the global teardown
// deletes it (and, with it, its notifications and deliveries).
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { DELIVERIES_MARKER, type DeliveryRow } from './db/deliveries';
import { ENGLISH_STORAGE_STATE } from './fixtures';
import { waitForEmail } from './mailpit';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'LoonsDemo2026';
const CLIENT_EMAIL = 'aisha.alkuwari@hamad.qa'; // Hamad Medical Corporation
// SOC's on-call agent (seed: teams → onCallEmail): escalation step 1 emails and texts her.
const AGENT_EMAIL = 'maya.ruiz@loonsgroup.com';
// The name is first-strong isolated inside the sentence (FSI … PDI, lib/format isolate()).
const ACKNOWLEDGED_BY = /Acknowledged by .?Maya Ruiz/;
const TEAM_LIST = 'soc@loonsgroup.com';
const CATEGORY = 'Cybersecurity / SOC';
const SUBTYPE = 'Security alert / suspected incident'; // seeded default priority: P1
const SITE = 'HMC – Building 3, Level 2';

/** Must match E2E_TICKET_SUBJECT_PREFIX in packages/db/scripts/e2e-users.ts. */
const E2E_SUBJECT_PREFIX = '[e2e:';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const deliveriesScript = fileURLToPath(new URL('./db/deliveries.ts', import.meta.url));

/** The ticket's NotificationDelivery rows, through the db package (see e2e/db/deliveries.ts). */
function readDeliveries(ticketNumber: number): DeliveryRow[] {
  if (!Number.isSafeInteger(ticketNumber)) throw new Error('bad ticket number');
  // Through a shell on purpose (pnpm is a .cmd shim on Windows); the arguments are a path we
  // built and a number, quoted.
  const out = execSync(
    `pnpm --filter @loons/db exec dotenv -e ../../.env -- tsx "${deliveriesScript}" ${ticketNumber}`,
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const line = out.split(/\r?\n/).find((l) => l.startsWith(DELIVERIES_MARKER));
  if (!line) throw new Error(`no deliveries line in: ${out}`);
  return JSON.parse(line.slice(DELIVERIES_MARKER.length)) as DeliveryRow[];
}

async function signIn(
  browser: Browser,
  baseURL: string | undefined,
  kind: 'client' | 'staff',
  contexts: BrowserContext[],
) {
  const context = await browser.newContext({ baseURL, storageState: ENGLISH_STORAGE_STATE });
  // Registered before a possible skip, so afterEach closes it either way.
  contexts.push(context);
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

test.describe('P1 notifications', () => {
  let contexts: BrowserContext[] = [];

  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  test('a client P1 emails the team and on-call, logs Teams + SMS, and the agent acknowledges it', async ({
    browser,
    baseURL,
    request,
  }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const subject = `${E2E_SUBJECT_PREFIX}${stamp}] Suspected intrusion on the core firewall`;

    const agent = await signIn(browser, baseURL, 'staff', contexts);
    const client = await signIn(browser, baseURL, 'client', contexts);

    // ── The client raises a P1 (the sub-type's default priority).
    await client.page.getByRole('button', { name: 'New ticket' }).first().click();
    const dialog = client.page.getByRole('dialog', { name: 'New ticket' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Subject/).fill(subject);
    await client.page.getByRole('combobox', { name: 'Category' }).click();
    await client.page.getByRole('option', { name: CATEGORY }).first().click();
    await client.page.getByRole('combobox', { name: 'Sub-type' }).click();
    await client.page.getByRole('option', { name: SUBTYPE }).first().click();
    await client.page.getByRole('combobox', { name: 'Site / location' }).click();
    await client.page.getByRole('option', { name: SITE }).first().click();
    await dialog
      .getByLabel(/^Description/)
      .fill(`Repeated admin logins from an unknown address since 06:40 (${stamp}).`);
    // The form's own P1 warning (Phase 2) shows for a P1.
    await expect(dialog.getByRole('alert').filter({ hasText: 'Critical' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Create ticket' }).click();

    await expect(client.page).toHaveURL(/\/tickets\/LG-\d+$/);
    const ref = /\/tickets\/(LG-\d+)$/.exec(client.page.url())?.[1] ?? '';
    expect(ref).toMatch(/^LG-\d+$/);
    const ticketNumber = Number(ref.slice('LG-'.length));

    // ── Mailpit: the SOC distribution list and the on-call agent's P1 alert.
    const teamMail = await waitForEmail(request, TEAM_LIST, ref);
    expect(teamMail.Subject).toContain(ref);
    const onCallMail = await waitForEmail(request, AGENT_EMAIL, ref);
    expect(onCallMail.Subject).toContain('P1');

    // ── The delivery log: the Teams card and the on-call SMS for this ticket were SENT (the
    // console providers record them; D4, D12, D11). QUEUED or SKIPPED would mean nothing went out.
    let deliveries: DeliveryRow[] = [];
    await expect
      .poll(
        () => {
          deliveries = readDeliveries(ticketNumber);
          return ['TEAMS', 'SMS']
            .filter((c) => deliveries.some((d) => d.channel === c && d.status === 'SENT'))
            .sort();
        },
        {
          message: `SENT TEAMS and SMS deliveries for ${ref} (is the API worker running?)`,
          timeout: 45_000,
          intervals: [1_000, 2_000],
        },
      )
      .toEqual(['SMS', 'TEAMS']);
    // Exactly one Teams card for "P1 created" (step 1's TEAMS channel is that same card, D4).
    expect(deliveries.filter((d) => d.channel === 'TEAMS')).toHaveLength(1);
    // The on-call number, masked (E.164: "+974******00"), not "—" (no usable number).
    const sms = deliveries.find((d) => d.channel === 'SMS' && d.status === 'SENT');
    expect(sms?.templateKey).toBe('P1_ALERT');
    expect(sms?.recipientMasked).toMatch(/^\+\d{3}\*+\d{2}$/);

    // ── The agent opens the ticket: P1 banner, not acknowledged yet.
    await agent.page.goto(`/console/inbox?ticket=${ref}`);
    await expect(agent.page.getByRole('heading', { name: subject, level: 2 })).toBeVisible();
    const unacknowledged = agent.page.locator('[data-p1="unacknowledged"]');
    await expect(unacknowledged).toBeVisible();
    await expect(unacknowledged).toContainText('P1 not acknowledged');

    // ── The bell: unread notifications, one of them about this ticket (links to it).
    const bell = agent.page.getByRole('button', { name: /^Notifications, \d+ unread$/ });
    await expect(bell).toBeVisible({ timeout: 20_000 });
    await bell.click();
    const panel = agent.page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    const item = panel.locator(`a[href="/console/inbox?ticket=${ref}"]`).first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText(ref);
    await agent.page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(bell).toBeFocused();

    // ── Acknowledge (server-confirmed) → "Acknowledged by Maya Ruiz · <time>".
    const acknowledged = agent.page.locator('[data-p1="acknowledged"]');
    const stored = agent.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/acknowledge'),
    );
    await unacknowledged.getByRole('button', { name: 'Acknowledge', exact: true }).click();
    expect((await stored).status()).toBe(200);
    await expect(acknowledged).toContainText(ACKNOWLEDGED_BY);
    await expect(unacknowledged).toHaveCount(0);

    // The server kept it: still acknowledged after a reload.
    await agent.page.reload();
    await expect(agent.page.locator('[data-p1="acknowledged"]')).toContainText(ACKNOWLEDGED_BY);
  });
});

// Phase 5 "done when" flows (docs/PHASE5_CONTRACT.md → Tests → E2E):
// (a) Team queue — a filter + tab narrows the list, and a bulk "Assign to me" updates the rows
//     live (the agent's page and a Super Admin's open queue, without a reload);
// (b) Reports — the tiles show numbers and each snapshot tile opens the matching list;
// (c) Customers — a customer row opens that company's tickets in the Inbox (titled with it);
// (d) Help center — with several browser contexts, a client has /help open (English and
//     Arabic) while the Super Admin writes an article in admin: a draft never reaches the client,
//     the published article appears without a reload in both languages (the Arabic title and
//     text in the Arabic UI), and it goes away again when it is unpublished.
//
// Data: tickets are raised through the API as the seeded client with the `[e2e:<timestamp>]`
// subject prefix, and the help article gets the key `e2e-<Date.now()>` (13 digits); the global
// teardown (`db:cleanup-e2e`) removes exactly those. The dev database may hold the owner's own
// tickets: every assertion is scoped to this run's rows (a search on the stamp) or compares two
// views of the same data, never a global count. Sign-in is rate limited per IP + email, so each
// person signs in once for the file and the tests open contexts with that session.
import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { ENGLISH_STORAGE_STATE } from './fixtures';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'LoonsDemo2026';
const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
const CLIENT_EMAIL = 'aisha.alkuwari@hamad.qa'; // Hamad Medical Corporation
const CLIENT_NAME = 'Dr. Aisha Al-Kuwari';
const COMPANY = 'Hamad Medical Corporation';
// SOC agent: "Cybersecurity / SOC" tickets are routed to the SOC team.
const AGENT_EMAIL = 'maya.ruiz@loonsgroup.com';
const AGENT_NAME = 'Maya Ruiz';
const ADMIN_EMAIL = 'noor.alkaabi@loonsgroup.com'; // the demo Super Admin
const CATEGORY = 'Cybersecurity / SOC';
/** Must match E2E_TICKET_SUBJECT_PREFIX in packages/db/scripts/e2e-users.ts. */
const E2E_SUBJECT_PREFIX = '[e2e:';

type Locale = 'en' | 'ar';
type Session = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Signs in once and returns the session (cookies) for new contexts. */
async function signIn(
  browser: Browser,
  baseURL: string | undefined,
  kind: 'client' | 'staff',
  email: string,
): Promise<Session | null> {
  const context = await browser.newContext({ baseURL, storageState: ENGLISH_STORAGE_STATE });
  try {
    const page = await context.newPage();
    await page.goto(kind === 'client' ? '/login' : '/staff/login');
    const emailField = page.getByLabel('Email', { exact: true });
    // Dev staff sign-in is off when Entra ID is configured (or AUTH_DEV_STAFF_LOGIN is off).
    if (kind === 'staff' && (await emailField.count()) === 0) return null;
    await emailField.fill(email);
    await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(kind === 'client' ? /\/tickets(?:[/?#]|$)/ : /\/console|\/admin/);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/** The session with the UI language cookie set to `locale` (the cookie wins over the profile). */
function inLocale(session: Session, locale: Locale): Session {
  return {
    ...session,
    cookies: [
      ...session.cookies.filter((cookie) => cookie.name !== 'NEXT_LOCALE'),
      ...ENGLISH_STORAGE_STATE.cookies.map((cookie) => ({ ...cookie, value: locale })),
    ],
  };
}

/** A call to the API with the signed-in user's bearer token (from the web app's /api/token). */
async function api(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown) {
  const token = await page.request.get('/api/token');
  expect(token.ok(), 'GET /api/token').toBe(true);
  const { token: bearer } = (await token.json()) as { token: string };
  return page.request.fetch(`${API_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}` },
    ...(data === undefined ? {} : { data }),
  });
}

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), `${response.url()}: ${await response.text()}`).toBe(status);
  return (await response.json()) as T;
}

interface Raised {
  id: string;
  ref: string;
  subject: string;
}

/** Raises SOC tickets as the signed-in client (sub-types by English label). */
async function raiseSocTickets(
  client: Page,
  tickets: Array<{ subtype: string; subject: string }>,
): Promise<Raised[]> {
  const config = await json<{
    categories: Array<{
      id: string;
      labelEn: string;
      subtypes: Array<{ id: string; labelEn: string }>;
    }>;
  }>(await api(client, 'GET', '/config/ticket-form'));
  const category = config.categories.find((c) => c.labelEn === CATEGORY);
  expect(category, `the seeded "${CATEGORY}" category`).toBeTruthy();
  const context = await json<{ sites: Array<{ id: string }> }>(
    await api(client, 'GET', '/tickets/form-context'),
  );
  const raised: Raised[] = [];
  for (const { subtype, subject } of tickets) {
    const sub = category!.subtypes.find((s) => s.labelEn === subtype);
    expect(sub, `the seeded "${subtype}" sub-type`).toBeTruthy();
    const { ticket } = await json<{ ticket: { id: string; ref: string } }>(
      await api(client, 'POST', '/tickets', {
        type: 'INCIDENT',
        categoryId: category!.id,
        subtypeId: sub!.id,
        impact: 'SINGLE_USER',
        siteId: context.sites[0]!.id,
        subject,
        description: `Raised by the Phase 5 end-to-end test: ${subject}.`,
      }),
      201,
    );
    raised.push({ id: ticket.id, ref: ticket.ref, subject });
  }
  return raised;
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

/** Filters the Team queue in place from the top-bar search. */
async function searchQueue(page: Page, term: string) {
  const box = page.getByRole('searchbox', { name: 'Search tickets' });
  await box.fill(term);
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(term)}(&|$)`));
}

const queueTable = (page: Page) => page.getByRole('table', { name: 'Team queue tickets' });
/** One row of the queue, by its subject (the row's link). */
const queueRow = (page: Page, subject: string) =>
  queueTable(page)
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: subject }) });
/** A queue tab; its name is the label followed by the count ("All open3"). */
const tab = (page: Page, label: string) =>
  page.getByRole('tab', { name: new RegExp(`^${label}\\s*\\d+$`) });
/** The tab's count is exactly `n`. */
const counts = (n: number) => new RegExp(`\\D${n}$`);

async function expectRows(page: Page, subjects: string[]) {
  await expect(queueTable(page).locator('[data-row-open]')).toHaveText(subjects);
}

test.describe('Phase 5: views and reports', () => {
  const sessions: { client: Session | null; agent: Session | null; admin: Session | null } = {
    client: null,
    agent: null,
    admin: null,
  };
  let contexts: BrowserContext[] = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    sessions.client = await signIn(browser, baseURL, 'client', CLIENT_EMAIL);
    sessions.agent = await signIn(browser, baseURL, 'staff', AGENT_EMAIL);
    sessions.admin = sessions.agent && (await signIn(browser, baseURL, 'staff', ADMIN_EMAIL));
  });

  test.beforeEach(() => {
    test.skip(
      !sessions.agent,
      'Dev staff sign-in is disabled (Entra ID configured or AUTH_DEV_STAFF_LOGIN off)',
    );
  });

  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  /** A new browser (context) signed in as `who`, in `locale`. */
  async function open(
    browser: Browser,
    baseURL: string | undefined,
    who: keyof typeof sessions,
    locale: Locale = 'en',
  ): Promise<Page> {
    const context = await browser.newContext({
      baseURL,
      storageState: inLocale(sessions[who]!, locale),
    });
    contexts.push(context);
    return context.newPage();
  }

  test('team queue: filter + tab narrow the list; bulk "Assign to me" updates the rows live', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const term = `e2e:${stamp}`;
    const subject = (text: string) => `${E2E_SUBJECT_PREFIX}${stamp}] ${text}`;

    // P2, P3, P3 (the sub-types' default priorities), all routed to the SOC team.
    const client = await open(browser, baseURL, 'client');
    const [phishing, patch, logs] = await raiseSocTickets(client, [
      { subtype: 'Phishing report', subject: subject('Queue phishing mail from a supplier') },
      {
        subtype: 'Vulnerability / patch request',
        subject: subject('Queue patch the VPN appliance'),
      },
      { subtype: 'Log source not reporting', subject: subject('Queue firewall logs stopped') },
    ]);

    const agent = await open(browser, baseURL, 'agent');
    const admin = await open(browser, baseURL, 'admin');
    // The agent already owns the log-source ticket (so the Unassigned tab differs from All open).
    const me = await json<{ user: { id: string } }>(await api(agent, 'GET', '/me'));
    await json(await api(agent, 'PATCH', `/tickets/${logs!.id}`, { assigneeId: me.user.id }));

    // ── The Super Admin keeps the queue open on this run's tickets (all teams).
    await admin.goto('/console/queue');
    await expect(admin.getByRole('heading', { level: 1, name: 'Team queue' })).toBeVisible();
    await expect(admin.getByText(/^All teams · /)).toBeVisible();
    await searchQueue(admin, term);
    await expectRows(admin, [phishing!.subject, patch!.subject, logs!.subject]);
    await expect(queueRow(admin, patch!.subject)).toContainText('Unassigned');
    await expect(queueRow(admin, logs!.subject)).toContainText(AGENT_NAME);
    await markDocument(admin);

    // ── The agent: this run's tickets in "All open", P1 → P4.
    await agent.goto('/console/queue');
    await expect(agent.getByText(/^Your teams · /)).toBeVisible();
    await searchQueue(agent, term);
    await expectRows(agent, [phishing!.subject, patch!.subject, logs!.subject]);
    await expect(tab(agent, 'All open')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(agent, 'All open')).toHaveText(counts(3));
    await expect(tab(agent, 'Unassigned')).toHaveText(counts(2));

    // A filter narrows the list (and the tab counts follow it)…
    await agent.getByRole('combobox', { name: 'Priority filter' }).click();
    await agent.getByRole('option', { name: 'P3 Medium' }).click();
    await expect(agent).toHaveURL(/[?&]priority=P3(&|$)/);
    await expect(agent.getByRole('combobox', { name: 'Priority filter' })).toHaveText(
      'Priority: P3 Medium',
    );
    await expectRows(agent, [patch!.subject, logs!.subject]);
    await expect(tab(agent, 'All open')).toHaveText(counts(2));
    await expect(tab(agent, 'Unassigned')).toHaveText(counts(1));

    // … and so does a tab.
    await tab(agent, 'Unassigned').click();
    await expect(agent).toHaveURL(/[?&]tab=unassigned(&|$)/);
    await expect(tab(agent, 'Unassigned')).toHaveAttribute('aria-selected', 'true');
    await expectRows(agent, [patch!.subject]);
    await markDocument(agent);

    // ── Select the row, "Assign to me".
    await queueRow(agent, patch!.subject)
      .getByRole('checkbox', { name: `Select ${patch!.ref}` })
      .check();
    const bar = agent.getByRole('group', { name: 'Bulk actions' });
    await expect(bar).toContainText('1 selected');
    const bulk = agent.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/tickets/bulk',
    );
    await bar.getByRole('button', { name: 'Assign to me' }).click();
    expect((await bulk).status()).toBe(200);
    await expect(agent.getByText('1 ticket assigned to you')).toBeVisible();

    // The agent's list updates in place: nothing unassigned is left for P3.
    await expect(bar).toBeHidden();
    await expect(agent.getByText('No tickets match these filters.')).toBeVisible();
    await expect(tab(agent, 'Unassigned')).toHaveText(counts(0));
    await tab(agent, 'All open').click();
    await expect(queueRow(agent, patch!.subject)).toContainText(AGENT_NAME);
    await expectNotReloaded(agent);

    // The Super Admin's open queue follows without a reload (queue:updated).
    await expect(queueRow(admin, patch!.subject)).toContainText(AGENT_NAME);
    await expect(queueRow(admin, phishing!.subject)).toContainText('Unassigned');
    await expectNotReloaded(admin);
  });

  test('reports: the tiles show numbers and each snapshot tile opens the matching list', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const page = await open(browser, baseURL, 'agent');
    type Tile = 'open' | 'p1Open' | 'breached' | 'unassigned' | 'solved' | 'firstReply';
    const tile = (key: Tile) => page.locator(`[data-tile="${key}"]`);
    const valueOf = async (key: Tile) =>
      Number((await tile(key).locator('[data-value]').textContent())?.trim());
    /** Back on the Reports page, its tiles loaded. */
    const reports = async () => {
      await page.goto('/console/reports');
      await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
      await expect(tile('open').locator('[data-value]')).toHaveText(/^\d+$/);
    };

    await reports();
    // The snapshot tiles and "Solved" are links named by their label and number.
    const labels: Array<[Tile, string]> = [
      ['open', 'Open tickets'],
      ['p1Open', 'P1 open'],
      ['breached', 'SLA breached'],
      ['unassigned', 'Unassigned'],
      ['solved', 'Solved'],
    ];
    for (const [key, label] of labels) {
      await expect(tile(key)).toHaveRole('link');
      await expect(tile(key)).toHaveAccessibleName(new RegExp(`^${label} \\d+`, 'i'));
      await expect(tile(key).locator('[data-value]')).toHaveText(/^\d+$/);
    }
    // The average first reply: a duration, or "—" when nothing was answered in the period.
    await expect(tile('firstReply').locator('[data-value]')).toHaveText(/\d|—/);
    // The period picker (7 / 30 / 90 days) re-reads the period tiles.
    await page.getByRole('radio', { name: 'Last 7 days' }).click();
    await expect(page).toHaveURL(/[?&]period=7d(&|$)/);
    await expect(tile('solved')).toContainText('Last 7 days');

    // Open tickets → the Team queue's "All open", with the same count.
    await reports();
    const open_ = await valueOf('open');
    await tile('open').click();
    await expect(page).toHaveURL(/\/console\/queue$/);
    await expect(tab(page, 'All open')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'All open')).toHaveText(counts(open_));

    // Unassigned → the queue's Unassigned tab, with the same count.
    await reports();
    const unassigned = await valueOf('unassigned');
    await tile('unassigned').click();
    await expect(page).toHaveURL(/\/console\/queue\?tab=unassigned$/);
    await expect(tab(page, 'Unassigned')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Unassigned')).toHaveText(counts(unassigned));

    // P1 open → the Inbox "P1 critical" view, with the same count.
    await reports();
    const p1 = await valueOf('p1Open');
    await tile('p1Open').click();
    await expect(page).toHaveURL(/\/console\/inbox\?view=p1(&|$)/);
    await expect(page.locator('#inbox-list-title')).toHaveText(`P1 critical${p1}`);

    // SLA breached → the Inbox "SLA at risk" view (breached tickets first).
    await reports();
    await tile('breached').click();
    await expect(page).toHaveURL(/\/console\/inbox\?view=risk(&|$)/);
    await expect(page.locator('#inbox-list-title')).toHaveText(/^SLA at risk\d*$/);

    // Solved → the Inbox "Solved" view.
    await reports();
    await tile('solved').click();
    await expect(page).toHaveURL(/\/console\/inbox\?view=solved(&|$)/);
    await expect(page.locator('#inbox-list-title')).toHaveText(/^Solved\d*$/);
  });

  test('customers: a row opens that company’s tickets in the Inbox, titled with its name', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const client = await open(browser, baseURL, 'client');
    const [raised] = await raiseSocTickets(client, [
      {
        subtype: 'SIEM / SOAR alert or tuning',
        subject: `${E2E_SUBJECT_PREFIX}${stamp}] Customers SIEM rule too noisy`,
      },
    ]);

    const page = await open(browser, baseURL, 'agent');
    await page.goto('/console/customers');
    await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search customers' }).fill('aisha.alkuwari');
    await expect(page).toHaveURL(/[?&]q=aisha\.alkuwari(&|$)/);
    // The name and company are bidi-isolated in the row's name ("⁨Dr. Aisha…⁩: view ⁨…⁩ tickets").
    const isolated = (text: string) => `\\u2068?${text.replace(/\./g, '\\.')}\\u2069?`;
    const row = page.getByRole('link', {
      name: new RegExp(`^${isolated(CLIENT_NAME)}: view ${isolated(COMPANY)} tickets$`),
    });
    await expect(row).toBeVisible();
    await row.click();

    // (The Inbox may also open the first ticket of the list: `&ticket=…`.)
    await expect(page).toHaveURL(/\/console\/inbox\?org=[0-9a-f-]{36}(&|$)/);
    await expect(page.locator('#inbox-list-title')).toHaveText(new RegExp(`^${COMPANY}\\d*$`));
    await expect(page.getByText('All of this company’s tickets, in any status')).toBeVisible();
    const list = page.getByRole('list', { name: 'Tickets in this view' });
    await expect(list.locator(`[data-ticket-ref="${raised!.ref}"]`)).toBeVisible();

    // Clear goes back to the view underneath.
    await page.getByRole('link', { name: 'Clear the company filter' }).click();
    await expect(page).not.toHaveURL(/org=/);
    await expect(page.locator('#inbox-list-title')).not.toContainText(COMPANY);
  });

  test('help center: a published article reaches open pages in English and Arabic; a draft never does', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const key = `e2e-${stamp}`;
    expect(key).toMatch(/^e2e-\d{13}$/);
    const titleEn = `Resetting a door badge ${stamp}`;
    const bodyEn = `Ask your site security desk for a new badge. Reference ${stamp}.`;
    const titleAr = `إعادة ضبط بطاقة الباب ${stamp}`;
    const bodyAr = `اطلب بطاقة جديدة من مكتب الأمن في موقعك. المرجع ${stamp}.`;

    // ── The client has the Help center open, in English and (another browser) in Arabic.
    const clientEn = await open(browser, baseURL, 'client');
    const clientAr = await open(browser, baseURL, 'client', 'ar');
    await clientEn.goto('/help');
    await expect(clientEn.getByRole('heading', { level: 1, name: 'Help center' })).toBeVisible();
    await clientAr.goto('/help');
    await expect(clientAr.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(clientAr.getByRole('heading', { level: 1, name: 'مركز المساعدة' })).toBeVisible();
    await markDocument(clientEn);
    await markDocument(clientAr);
    const articleOf = (page: Page) => page.locator(`[data-article="${key}"]`);
    /** The next GET /help/articles the page sends from now on (after a config:updated push). */
    const nextArticles = (page: Page) => {
      const since = Date.now();
      return page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/help/articles' &&
          response.request().timing().startTime >= since,
      );
    };

    // ── The Super Admin writes the article as a draft, in both languages.
    const admin = await open(browser, baseURL, 'admin');
    await admin.goto('/admin/help-center');
    await expect(admin.getByRole('heading', { level: 1, name: 'Help center' })).toBeVisible();
    await admin.getByRole('button', { name: 'Create new', exact: true }).click();
    const sheet = admin.getByRole('dialog', { name: 'New article' });
    await sheet.getByRole('textbox', { name: /^Title/ }).fill(titleEn);
    await sheet.getByRole('textbox', { name: 'Key', exact: true }).fill(key);
    await sheet.getByRole('textbox', { name: /^Article text/ }).fill(bodyEn);
    await sheet.getByRole('radio', { name: 'العربية' }).click();
    await sheet.getByRole('textbox', { name: /^Title/ }).fill(titleAr);
    await sheet.getByRole('textbox', { name: /^Article text/ }).fill(bodyAr);
    await expect(sheet.getByRole('switch', { name: 'Published' })).not.toBeChecked();
    const refetchedEn = nextArticles(clientEn);
    const refetchedAr = nextArticles(clientAr);
    const created = admin.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/admin/help-center',
    );
    await sheet.getByRole('button', { name: 'Create', exact: true }).click();
    expect((await created).status()).toBe(201);
    await expect(sheet).toBeHidden();

    // The open pages refetch (config:updated) and the draft isn't there: neither in what the
    // API sent nor on the page.
    for (const [page, refetched] of [
      [clientEn, refetchedEn],
      [clientAr, refetchedAr],
    ] as const) {
      expect(await (await refetched).text()).not.toContain(key);
      await expect(articleOf(page)).toHaveCount(0);
    }
    const draft = await json<{ items: Array<{ key: string }> }>(
      await api(clientEn, 'GET', '/help/articles?locale=en'),
    );
    expect(draft.items.map((a) => a.key)).not.toContain(key);

    /** Opens the article in admin, flips Published and saves. */
    const setPublished = async (published: boolean) => {
      await admin.getByRole('button', { name: new RegExp(`^${titleEn}`) }).click();
      const edit = admin.getByRole('dialog', { name: titleEn });
      const toggle = edit.getByRole('switch', { name: 'Published' });
      await expect(toggle).toBeChecked({ checked: !published });
      await toggle.click();
      const saved = admin.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname.startsWith('/admin/help-center/'),
      );
      await edit.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await saved).status()).toBe(200);
      await expect(edit).toBeHidden();
    };

    // ── The Super Admin publishes it.
    await setPublished(true);

    // English page: the English article, without a reload.
    const en = articleOf(clientEn);
    await expect(en.getByRole('button', { name: titleEn })).toBeVisible();
    await en.getByRole('button', { name: titleEn }).click();
    await expect(en.getByText(bodyEn)).toBeVisible();
    await expect(en.getByText(bodyEn).locator('xpath=ancestor::*[@lang][1]')).toHaveAttribute(
      'lang',
      'en',
    );
    await expectNotReloaded(clientEn);

    // Arabic page: the Arabic title and text, marked as Arabic (right to left), without a reload.
    const ar = articleOf(clientAr);
    await expect(ar.getByRole('button', { name: titleAr })).toBeVisible();
    await ar.getByRole('button', { name: titleAr }).click();
    await expect(ar.getByText(bodyAr)).toBeVisible();
    const arPanel = ar.getByText(bodyAr).locator('xpath=ancestor::*[@lang][1]');
    await expect(arPanel).toHaveAttribute('lang', 'ar');
    await expect(arPanel).toHaveAttribute('dir', 'rtl');
    await expectNotReloaded(clientAr);

    // ── Unpublished again: it leaves both open pages.
    await setPublished(false);
    await expect(en).toHaveCount(0);
    await expect(ar).toHaveCount(0);
    await expectNotReloaded(clientEn);
    await expectNotReloaded(clientAr);
  });
});

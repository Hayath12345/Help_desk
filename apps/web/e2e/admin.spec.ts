// Phase 4 "done when" flow (docs/PHASE4_CONTRACT.md → Tests → E2E), with two browser contexts:
// a client has the New Ticket form open → the Super Admin creates a category (with its first
// sub-type) and a custom field linked to it → the open form shows them without a reload
// (config:updated, E18) → the client raises a ticket with them → the admin archives the field and
// the category → the ticket still renders them with an "archived" marker (portal header, console
// panel; E6).
//
// Config rows get the keys `e2e-<Date.now()>` (the category) and `e2e-<Date.now()>-panel` (the
// field); the global teardown (`db:cleanup-e2e`) removes exactly that key shape — categories with
// their sub-types and field links, and custom fields; never macros, and never an admin-made row
// whose key merely starts with `e2e-` — and bumps the config version so no cache keeps them. A
// new config row this spec creates must use the same shape. The ticket uses the
// `[e2e:<timestamp>]` subject prefix of the ticket spec, so the same teardown deletes it.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ENGLISH_STORAGE_STATE } from './fixtures';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'LoonsDemo2026';
const CLIENT_EMAIL = 'aisha.alkuwari@hamad.qa'; // Hamad Medical Corporation
const ADMIN_EMAIL = 'noor.alkaabi@loonsgroup.com'; // the demo Super Admin
const TEAM = 'ELV Field';
const SITE = 'HMC – Building 3, Level 2';
/** Must match E2E_TICKET_SUBJECT_PREFIX in packages/db/scripts/e2e-users.ts. */
const E2E_SUBJECT_PREFIX = '[e2e:';

async function signIn(browser: Browser, baseURL: string | undefined, kind: 'client' | 'staff') {
  const context = await browser.newContext({ baseURL, storageState: ENGLISH_STORAGE_STATE });
  const page = await context.newPage();
  await page.goto(kind === 'client' ? '/login' : '/staff/login');
  const email = page.getByLabel('Email', { exact: true });
  if (kind === 'staff') {
    test.skip(
      (await email.count()) === 0,
      'Dev staff sign-in is disabled (Entra ID configured or AUTH_DEV_STAFF_LOGIN off)',
    );
  }
  await email.fill(kind === 'client' ? CLIENT_EMAIL : ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(kind === 'client' ? /\/tickets(?:[/?#]|$)/ : /\/console|\/admin/);
  return { context, page };
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

/** Radix Select: open the trigger labelled `label` inside `scope`, pick the option `option`. */
async function chooseOption(
  page: Page,
  scope: ReturnType<Page['getByRole']>,
  label: RegExp | string,
  option: string,
) {
  await scope.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).first().click();
}

/** Waits for the admin write matching `method` + `path` and expects `status`. */
function adminWrite(page: Page, method: string, path: RegExp, status = 200) {
  return page
    .waitForResponse(
      (response) =>
        response.request().method() === method && path.test(new URL(response.url()).pathname),
    )
    .then((response) => expect(response.status()).toBe(status));
}

test.describe('admin: live config on an open New Ticket form', () => {
  let contexts: BrowserContext[] = [];

  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  test('a new category and custom field reach an open form; archived ones still render on the ticket', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const categoryKey = `e2e-${stamp}`;
    const categoryName = `E2E Door Access ${stamp}`;
    const subtypeName = `Card reader ${stamp}`;
    const fieldKey = `e2e-${stamp}-panel`;
    const fieldName = `E2E Panel ID ${stamp}`;
    const subject = `${E2E_SUBJECT_PREFIX}${stamp}] Door panel does not read badges`;

    const admin = await signIn(browser, baseURL, 'staff');
    const client = await signIn(browser, baseURL, 'client');
    contexts = [admin.context, client.context];

    // ── The client opens the New Ticket form and leaves it open.
    await client.page.getByRole('button', { name: 'New ticket' }).first().click();
    const form = client.page.getByRole('dialog', { name: 'New ticket' });
    await expect(form).toBeVisible();
    await form.getByLabel(/^Subject/).fill(subject);
    await markDocument(client.page);

    // ── The Super Admin creates the category with its first sub-type.
    await admin.page.goto('/admin/categories');
    await expect(admin.page.getByRole('heading', { name: 'Categories & sub-types' })).toBeVisible();
    await admin.page.getByRole('button', { name: 'Create new', exact: true }).click();
    const categorySheet = admin.page.getByRole('dialog', { name: 'New category' });
    await categorySheet
      .getByRole('textbox', { name: 'Name English', exact: true })
      .fill(categoryName);
    await categorySheet.getByRole('textbox', { name: 'Key', exact: true }).fill(categoryKey);
    await chooseOption(admin.page, categorySheet, /Routed to team/, TEAM);
    await categorySheet.getByRole('textbox', { name: 'Sub-type name English' }).fill(subtypeName);
    const categoryCreated = adminWrite(admin.page, 'POST', /\/admin\/categories$/, 201);
    await categorySheet.getByRole('button', { name: 'Create', exact: true }).click();
    await categoryCreated;
    await expect(categorySheet).toBeHidden();

    // ── … and a required custom field linked to it.
    await admin.page.goto('/admin/custom-fields');
    await admin.page.getByRole('button', { name: 'Create new', exact: true }).click();
    const fieldSheet = admin.page.getByRole('dialog', { name: 'New custom field' });
    await fieldSheet.getByRole('textbox', { name: 'Name English', exact: true }).fill(fieldName);
    await fieldSheet.getByRole('textbox', { name: 'Key', exact: true }).fill(fieldKey);
    await fieldSheet.getByRole('switch', { name: 'Required', exact: true }).click();
    await fieldSheet.getByRole('checkbox', { name: categoryName }).click();
    const fieldCreated = adminWrite(admin.page, 'POST', /\/admin\/custom-fields$/, 201);
    await fieldSheet.getByRole('button', { name: 'Create', exact: true }).click();
    await fieldCreated;

    // ── The open form shows both without a reload; the subject typed earlier is kept.
    await chooseOption(client.page, form, /^Category/, categoryName);
    await chooseOption(client.page, form, /Sub-type/, subtypeName);
    const fieldInput = form.getByRole('textbox', { name: new RegExp(`^${fieldName}`) });
    await expect(fieldInput).toBeVisible({ timeout: 20_000 });
    await expect(form.getByLabel(/^Subject/)).toHaveValue(subject);
    await expectNotReloaded(client.page);

    // ── The client raises the ticket with them.
    await fieldInput.fill('PNL-204');
    await chooseOption(client.page, form, 'Site / location', SITE);
    await form
      .getByLabel(/^Description/)
      .fill(`The badge panel at the east door stopped reading badges (${stamp}).`);
    await form.getByRole('button', { name: 'Create ticket' }).click();
    await expect(client.page).toHaveURL(/\/tickets\/LG-\d+$/);
    const ref = /\/tickets\/(LG-\d+)$/.exec(client.page.url())?.[1];
    expect(ref).toBeTruthy();

    // ── The admin archives the field and the category.
    await admin.page.goto('/admin/custom-fields');
    await admin.page.getByRole('button', { name: new RegExp(`^${fieldName}`) }).click();
    const fieldEdit = admin.page.getByRole('dialog', { name: fieldName });
    await fieldEdit.getByRole('button', { name: 'Archive', exact: true }).click();
    const fieldArchived = adminWrite(admin.page, 'POST', /\/admin\/custom-fields\/[^/]+\/archive$/);
    await admin.page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    await fieldArchived;

    await admin.page.goto('/admin/categories');
    await admin.page.getByRole('button', { name: new RegExp(`^${categoryName}`) }).click();
    const categoryEdit = admin.page.getByRole('dialog', { name: categoryName });
    // exact: each sub-type row has its own 'Archive <sub-type>' button.
    await categoryEdit.getByRole('button', { name: 'Archive', exact: true }).click();
    const categoryArchived = adminWrite(admin.page, 'POST', /\/admin\/categories\/[^/]+\/archive$/);
    await admin.page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    await categoryArchived;

    // ── The ticket still renders them, marked archived: the portal header…
    await client.page.reload();
    await expect(client.page.getByText(`${categoryName} (archived)`)).toBeVisible();

    // … and the console panel (the custom-field value with its archived field).
    await admin.page.goto(`/console/inbox?ticket=${ref}`);
    const details = admin.page.getByRole('region', { name: 'Custom fields' });
    await expect(details.getByRole('term')).toHaveText(`${fieldName} (archived)`);
    await expect(details.getByRole('definition')).toHaveText('PNL-204');
    await expect(admin.page.getByRole('combobox', { name: /Category/ }).first()).toContainText(
      `${categoryName} (archived)`,
    );
  });
});

test.describe('admin: unsaved changes in a sheet', () => {
  test('browser Back asks first; Keep editing keeps the draft, Discard goes back', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await signIn(browser, baseURL, 'staff');
    try {
      // Nothing is saved: the draft is thrown away at the end.
      await page.goto('/admin');
      await page.goto('/admin/categories');
      await expect(page.getByRole('heading', { name: 'Categories & sub-types' })).toBeVisible();
      await page.getByRole('button', { name: 'Create new', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'New category' });
      const name = sheet.getByRole('textbox', { name: 'Name English', exact: true });
      await name.fill('Unsaved draft');

      const confirm = page.getByRole('alertdialog', { name: 'Discard your changes?' });
      await page.evaluate(() => history.back());
      await expect(confirm).toBeVisible();
      await expect(page).toHaveURL(/\/admin\/categories$/);
      await confirm.getByRole('button', { name: 'Keep editing' }).click();
      await expect(confirm).toBeHidden();
      await expect(name).toHaveValue('Unsaved draft');

      await page.evaluate(() => history.back());
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Discard changes' }).click();
      await expect(page).toHaveURL(/\/admin$/);
    } finally {
      await context.close();
    }
  });
});

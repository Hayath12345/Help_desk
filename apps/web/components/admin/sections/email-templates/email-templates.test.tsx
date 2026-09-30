// @vitest-environment jsdom
import type { EmailTemplateAdminDto } from '@loons/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { clone, renderComms, stubBrowserApis } from './comms-test-utils';
import {
  insertAt,
  malformedPlaceholders,
  placeholderError,
  placeholderNames,
} from './placeholders';
import { TemplatePreview } from './template-preview';
import { useCommsValidationMessage } from './use-comms-messages';
import { TemplateSheet } from './template-sheet';
import EmailTemplatesSection from '.';

// Email templates (E14): the fixed list, the editor with the English | العربية switch, variables,
// placeholder checks, the live preview, Save with expectedUpdatedAt (E19), the stale 409 reload and
// Reset to default — against an in-memory stand-in for /admin/email-templates.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const api = vi.hoisted(() => ({
  calls: [] as Call[],
  templates: [] as EmailTemplateAdminDto[],
  /** Next write answers this error once. */
  failNext: null as ApiRequestError | null,
  listFails: false,
}));

vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push({ method: 'GET', path });
      if (path === '/admin/email-templates') {
        if (api.listFails) throw new ApiRequestError(500, 'INTERNAL', 'boom');
        return { items: clone(api.templates) };
      }
      const key = path.split('/').pop();
      const item = api.templates.find((t) => t.key === key);
      if (!item) throw new ApiRequestError(404, 'NOT_FOUND', 'nope');
      return { item: clone(item) };
    }),
    request: vi.fn(
      async (path: string, init: { method: string; json?: Record<string, unknown> }) => {
        api.calls.push({ method: init.method, path, body: init.json });
        const [, , , key, action] = path.split('/');
        if (action === 'preview') {
          const body = init.json as { locale: string; subject: string; body: string };
          return {
            subject: `[${body.locale}] ${body.subject}`,
            html: `<html dir="${body.locale === 'ar' ? 'rtl' : 'ltr'}"><body>${body.body}</body></html>`,
            text: body.body,
          };
        }
        if (api.failNext) {
          const error = api.failNext;
          api.failNext = null;
          throw error;
        }
        const index = api.templates.findIndex((t) => t.key === key);
        const current = api.templates[index]!;
        const updatedAt = new Date(
          Date.parse('2026-09-29T12:00:00.000Z') + api.calls.length * 1000,
        ).toISOString();
        const next =
          action === 'reset'
            ? { ...current, ...DEFAULTS, isCustomized: false, updatedAt }
            : {
                ...current,
                subjectEn: init.json!.subjectEn as string,
                bodyEn: init.json!.bodyEn as string,
                subjectAr: init.json!.subjectAr as string,
                bodyAr: init.json!.bodyAr as string,
                isCustomized: true,
                updatedAt,
                updatedBy: { id: '00000000-0000-4000-8000-000000000001', name: 'Sam Admin' },
              };
        api.templates[index] = next;
        return { item: clone(next) };
      },
    ),
  },
}));

const DEFAULTS = {
  subjectEn: 'Reset your password',
  bodyEn: 'Hi {{name}},\n\nUse the button below. The link expires in {{expiresMinutes}} minutes.',
  subjectAr: 'إعادة تعيين كلمة المرور',
  bodyAr: 'مرحباً {{name}}،\n\nاستخدم الزر أدناه.',
};

function template(
  key: string,
  overrides: Partial<EmailTemplateAdminDto> = {},
): EmailTemplateAdminDto {
  return {
    key,
    ...DEFAULTS,
    isCustomized: false,
    variables: ['name', 'resetUrl', 'expiresMinutes'],
    blockVariables: [],
    legacyVariables: [],
    audience: 'user',
    updatedBy: null,
    updatedAt: '2026-09-23T12:54:22.580Z',
    ...overrides,
  };
}

const KEYS = [
  'PASSWORD_RESET',
  'EMAIL_VERIFICATION',
  'GOOGLE_LINKED',
  'TICKET_CREATED_CLIENT',
  'TICKET_CREATED_TEAM',
  'AGENT_REPLY_CLIENT',
  'CLIENT_REPLY_ASSIGNEE',
  'SLA_AT_RISK',
  'SLA_BREACHED',
  'P1_ALERT',
  'P1_ESCALATION',
  'P4_DAILY_DIGEST',
];

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  api.calls = [];
  api.failNext = null;
  api.listFails = false;
  api.templates = KEYS.map((key) =>
    key === 'AGENT_REPLY_CLIENT'
      ? template(key, {
          variables: ['name', 'agentName', 'ticketNumber', 'messageBody', 'portalUrl'],
          blockVariables: ['messageBody'],
          isCustomized: true,
          updatedBy: { id: '00000000-0000-4000-8000-000000000002', name: 'Olga Admin' },
          updatedAt: '2026-09-28T09:00:00.000Z',
        })
      : key === 'P4_DAILY_DIGEST'
        ? template(key, { audience: 'list' })
        : template(key),
  );
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

const writes = () => api.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/preview'));
const previews = () => api.calls.filter((c) => c.path.endsWith('/preview'));

async function openTemplate(name: RegExp | string) {
  const table = await screen.findByRole('table', { name: /Email templates|قوالب البريد/ });
  const row = await within(table).findByRole('button', { name });
  act(() => row.focus());
  fireEvent.click(row);
  return screen.findByRole('dialog');
}

function renderSection(locale: 'en' | 'ar' = 'en') {
  return renderComms(<EmailTemplatesSection role="SUPER_ADMIN" userId="u1" />, { locale });
}

describe('placeholder rules', () => {
  const rules = { variables: ['name', 'messageBody'], blockVariables: ['messageBody'] };
  it('finds placeholders and reports unknown ones and block variables in a subject', () => {
    expect(placeholderNames('Hi {{ name }} {{name}} {{x.y}}')).toEqual(['name', 'x.y']);
    expect(placeholderError('Hi {{name}}', 'subject', rules)).toBeNull();
    expect(placeholderError('{{messageBody}}', 'body', rules)).toBeNull();
    expect(placeholderError('{{messageBody}}', 'subject', rules)).toBe(
      'validation.blockInSubject|{{messageBody}}',
    );
    expect(placeholderError('{{secret}} {{nope}} {{messageBody}}', 'subject', rules)).toBe(
      'validation.unknownVariable|{{secret}}, {{nope}}',
    );
  });
  // Review api-comms-3 (the API refuses the same text with 400 `malformed_placeholder`).
  it('reports brace text that is not a placeholder', () => {
    expect(malformedPlaceholders('[{{ticket-number}}] {{ticketSubject}')).toEqual([
      '{{ticket-number}}',
      '{{ticketSubject}',
    ]);
    expect(malformedPlaceholders('{{name}}} {{{name}} {name}} {{name')).toEqual([
      '{{name}}}',
      '{{{name}}',
      '{name}}',
      '{{name',
    ]);
    expect(malformedPlaceholders('Hi {{ name }}, {braces} are fine')).toEqual([]);
    expect(placeholderError('Hi {{name}} {{ticket number}}', 'body', rules)).toBe(
      'validation.malformedPlaceholder|{{ticket number}}',
    );
    // Unknown names first.
    expect(placeholderError('{{nope}} {{x-y}}', 'body', rules)).toBe(
      'validation.unknownVariable|{{nope}}',
    );
  });

  it('names the whole refused fragment, even one with a "|" in it', () => {
    const message = placeholderError('Hi {{ticket|number}}', 'body', rules);
    expect(message).toBe('validation.malformedPlaceholder|{{ticket|number}}');
    function Shown() {
      return <p data-testid="msg">{useCommsValidationMessage()(message ?? undefined)}</p>;
    }
    renderComms(<Shown />);
    expect(screen.getByTestId('msg').textContent).toBe(
      '{{ticket|number}} isn’t a variable: check its braces and name, or insert one from the list.',
    );
  });

  // Review api-comms-1: pre-rename names the sender still fills are accepted, not offered.
  it('accepts the legacy names of a template', () => {
    const p1 = { variables: ['name'], blockVariables: [], legacyVariables: ['consoleUrl'] };
    expect(placeholderError('Open {{consoleUrl}}', 'body', p1)).toBeNull();
    expect(placeholderError('Open {{consoleUrl}}', 'body', rules)).toBe(
      'validation.unknownVariable|{{consoleUrl}}',
    );
  });

  it('inserts at the selection', () => {
    expect(insertAt('Hello world', '{{name}}', { start: 6, end: 11 })).toEqual({
      value: 'Hello {{name}}',
      caret: 14,
    });
    expect(insertAt('Hi', '!', null)).toEqual({ value: 'Hi!', caret: 3 });
  });
});

describe('EmailTemplatesSection', () => {
  it('lists the twelve fixed emails with who can see it, and no Create new', async () => {
    renderSection();
    const table = await screen.findByRole('table', { name: 'Email templates' });
    expect(await within(table).findByRole('button', { name: /Password reset/ })).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(13); // header + 12
    const reply = within(table)
      .getByRole('button', { name: /Reply from support/ })
      .closest('[role="row"]') as HTMLElement;
    expect(within(reply).getByText('Edited')).toBeTruthy();
    expect(within(reply).getByText('Sep 28, 2026 by Olga Admin')).toBeTruthy();
    const digest = within(table)
      .getByRole('button', { name: /P4 daily digest/ })
      .closest('[role="row"]') as HTMLElement;
    expect(within(digest).getByText('Team email list')).toBeTruthy();
    expect(within(digest).getByText('Built-in')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create new' })).toBeNull();
    expect(screen.getByText('Only Super Admins can open this section.')).toBeTruthy();
  });

  it('shows the load error with a retry', async () => {
    api.listFails = true;
    renderSection();
    expect(
      await screen.findByText('This list couldn’t be loaded.', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    api.listFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Password reset/ })).toBeTruthy();
  });

  it('edits English and Arabic with the language switch, previews, and saves with expectedUpdatedAt', async () => {
    renderSection();
    const sheet = await openTemplate(/Password reset/);
    expect(within(sheet).getByRole('heading', { name: 'Password reset' })).toBeTruthy();
    const subject = within(sheet).getByRole('textbox', { name: /Subject/ });
    expect(subject.getAttribute('dir')).toBe('ltr');
    expect((subject as HTMLInputElement).value).toBe(DEFAULTS.subjectEn);

    // Live preview of the English draft, in a sandboxed frame.
    const frame = (await within(sheet).findByTitle(
      'Preview of the English email',
    )) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('The link expires');
    expect(previews()[0]?.body).toMatchObject({ locale: 'en', subject: DEFAULTS.subjectEn });

    fireEvent.change(subject, { target: { value: 'Choose a new password' } });
    await waitFor(() =>
      expect(within(sheet).getByTestId('template-preview-subject').textContent).toBe(
        '[en] Choose a new password',
      ),
    );

    fireEvent.click(within(sheet).getByRole('radio', { name: 'العربية' }));
    const arabicBody = within(sheet).getByRole('textbox', { name: /Body/ });
    expect(arabicBody.getAttribute('dir')).toBe('rtl');
    expect(arabicBody.getAttribute('lang')).toBe('ar');
    fireEvent.change(arabicBody, { target: { value: 'مرحباً {{name}}،\n\nنص جديد.' } });
    await within(sheet).findByTitle('Preview of the Arabic email');

    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'PUT',
      path: '/admin/email-templates/PASSWORD_RESET',
      body: {
        subjectEn: 'Choose a new password',
        bodyEn: DEFAULTS.bodyEn,
        subjectAr: DEFAULTS.subjectAr,
        bodyAr: 'مرحباً {{name}}،\n\nنص جديد.',
        expectedUpdatedAt: '2026-09-23T12:54:22.580Z',
      },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('“Password reset” saved');
    // Focus goes back to the row.
    expect(document.activeElement?.textContent).toContain('Password reset');
  });

  it('refuses unknown placeholders and block variables in the subject before sending', async () => {
    renderSection();
    const sheet = await openTemplate(/Reply from support/);
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Subject/ }), {
      target: { value: 'New reply {{messageBody}}' },
    });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Body/ }), {
      target: { value: 'Hi {{name}}, {{secret}}' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(
      await within(sheet).findByText(
        '{{messageBody}} can only be used in the body, not in the subject.',
      ),
    ).toBeTruthy();
    expect(
      within(sheet).getByText('Use only the variables listed for this email: {{secret}}.'),
    ).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('refuses malformed placeholders before sending', async () => {
    renderSection();
    const sheet = await openTemplate(/Password reset/);
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Subject/ }), {
      target: { value: '[{{ticket-number}}] Reset {{name}' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(
      await within(sheet).findByText(
        '{{ticket-number}}, {{name} isn’t a variable: check its braces and name, or insert one from the list.',
      ),
    ).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('saves a stored P1 text that still uses the pre-rename names after a one-word edit', async () => {
    const index = KEYS.indexOf('P1_ESCALATION');
    api.templates[index] = template('P1_ESCALATION', {
      subjectEn: 'ESCALATION — [{{ticketNumber}}] unacknowledged for {{minutesUnacknowledged}} min',
      bodyEn: 'Hi {{name}},\n\nOpen in the console: {{consoleUrl}}',
      subjectAr: 'تصعيد — [{{ticketNumber}}] منذ {{minutesUnacknowledged}} دقيقة',
      bodyAr: 'مرحبًا {{name}}،\n\nفتح في وحدة التحكم: {{consoleUrl}}',
      variables: ['name', 'ticketNumber', 'unacknowledgedFor', 'ackUrl'],
      legacyVariables: ['minutesUnacknowledged', 'consoleUrl'],
      isCustomized: true,
    });
    renderSection();
    const sheet = await openTemplate(/P1 escalation/);
    // Offered: the current names only.
    expect(within(sheet).queryByRole('button', { name: 'Insert {{consoleUrl}}' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'العربية' }));
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Body/ }), {
      target: { value: 'أهلًا {{name}}،\n\nفتح في وحدة التحكم: {{consoleUrl}}' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({
      subjectEn: 'ESCALATION — [{{ticketNumber}}] unacknowledged for {{minutesUnacknowledged}} min',
      bodyAr: 'أهلًا {{name}}،\n\nفتح في وحدة التحكم: {{consoleUrl}}',
    });
  });

  it('switches to the language that has the error', async () => {
    renderSection();
    const sheet = await openTemplate(/Password reset/);
    fireEvent.click(within(sheet).getByRole('radio', { name: 'العربية' }));
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Body/ }), {
      target: { value: 'مرحباً {{ticketNumber}}' },
    });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'English' }));
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Subject/ }), {
      target: { value: 'Changed' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(sheet).getByRole('textbox', { name: /Body/ }).getAttribute('lang')).toBe('ar'),
    );
    const body = within(sheet).getByRole('textbox', { name: /Body/ });
    expect(body.getAttribute('aria-invalid')).toBe('true');
    expect(within(sheet).getByRole('radio', { name: 'العربية' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await waitFor(() => expect(document.activeElement).toBe(body));
    expect(writes()).toEqual([]);
  });

  it('puts server validation issues on the fields', async () => {
    api.failNext = new ApiRequestError(400, 'VALIDATION_FAILED', 'bad', undefined, [
      { path: ['bodyEn'], message: 'validation.unknownVariable', code: 'unknown_variable' },
    ]);
    renderSection();
    const sheet = await openTemplate(/Password reset/);
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Subject/ }), {
      target: { value: 'Changed' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(
      await within(sheet).findByText('This text uses a variable this email doesn’t have.'),
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('inserts a variable at the cursor', async () => {
    renderSection();
    const sheet = await openTemplate(/Password reset/);
    const body = within(sheet).getByRole('textbox', { name: /Body/ }) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'Hello !' } });
    act(() => {
      body.focus();
      body.setSelectionRange(6, 6);
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Insert {{name}}' }));
    await waitFor(() => expect(body.value).toBe('Hello {{name}}!'));
  });

  it('marks block variables as body only', async () => {
    renderSection();
    const sheet = await openTemplate(/Reply from support/);
    const block = within(sheet).getByRole('button', { name: 'Insert {{messageBody}}' });
    expect(within(block).getByText('body only')).toBeTruthy();
  });

  it('on a stale save shows "Someone else changed this — reload", and reload starts from the latest text', async () => {
    renderSection();
    const sheet = await openTemplate(/Password reset/);
    // Someone else saved meanwhile.
    api.templates[0] = template('PASSWORD_RESET', {
      subjectEn: 'Their subject',
      isCustomized: true,
      updatedAt: '2026-09-29T08:00:00.000Z',
    });
    api.failNext = new ApiRequestError(409, 'CONFLICT', 'stale', undefined, {
      reason: 'stale',
      currentUpdatedAt: '2026-09-29T08:00:00.000Z',
    });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Subject/ }), {
      target: { value: 'Mine' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        (within(sheet).getByRole('textbox', { name: /Subject/ }) as HTMLInputElement).value,
      ).toBe('Their subject'),
    );
    expect(within(sheet).queryByText('Someone else changed this — reload')).toBeNull();
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Subject/ }), {
      target: { value: 'Mine again' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(writes().at(-1)?.body?.expectedUpdatedAt).toBe('2026-09-29T08:00:00.000Z'),
    );
  });

  it('resets an edited template to the built-in text after confirming', async () => {
    renderSection();
    const sheet = await openTemplate(/Reply from support/);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Reset to default' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByText('Reset “Reply from support” to the built-in text?'),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'POST',
      path: '/admin/email-templates/AGENT_REPLY_CLIENT/reset',
      body: { expectedUpdatedAt: '2026-09-28T09:00:00.000Z' },
    });
    expect(toast.success).toHaveBeenCalledWith('“Reply from support” reset to the built-in text');
    // The sheet stays open with the built-in text; nothing left to reset.
    await waitFor(() =>
      expect(within(sheet).queryByRole('button', { name: 'Reset to default' })).toBeNull(),
    );
  });

  it('previews English when the Arabic text is empty, and says so', async () => {
    api.templates[0] = template('PASSWORD_RESET', { subjectAr: '', bodyAr: '' });
    renderSection();
    const sheet = await openTemplate(/Password reset/);
    fireEvent.click(within(sheet).getByRole('radio', { name: 'العربية' }));
    expect(
      await within(sheet).findByText(
        'The Arabic subject or body is empty, so this email goes out in English. The preview shows the English text.',
      ),
    ).toBeTruthy();
    expect(within(sheet).getByTitle('Preview of the English email')).toBeTruthy();
  });

  it('works in Arabic (right-to-left)', async () => {
    renderSection('ar');
    const table = await screen.findByRole('table', { name: 'قوالب البريد الإلكتروني' });
    expect(
      await within(table).findByRole('button', { name: /إعادة تعيين كلمة المرور/ }),
    ).toBeTruthy();
    expect(within(table).getAllByText('قائمة بريد الفريق')).toHaveLength(1);
    const sheet = await openTemplate(/إعادة تعيين كلمة المرور/);
    expect(within(sheet).getByRole('textbox', { name: /الموضوع/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'حفظ' })).toBeTruthy();
  });
});

describe('TemplateSheet', () => {
  it('asks before discarding unsaved changes', async () => {
    const onOpenChange = vi.fn();
    renderComms(
      <TemplateSheet template={template('PASSWORD_RESET')} open onOpenChange={onOpenChange} />,
    );
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Subject/ }), {
      target: { value: 'Unsaved' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Discard your changes?')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

// Review web-comms-2: the debounced draft must settle — no re-render loop once typing stops.
describe('TemplatePreview', () => {
  it('stops re-rendering once the debounced draft has caught up', async () => {
    let renders = 0;
    const onRender = () => {
      renders += 1;
    };
    const preview = (subject: string) => (
      <Profiler id="preview" onRender={onRender}>
        <TemplatePreview
          templateKey="PASSWORD_RESET"
          language="en"
          subject={subject}
          body="Hi {{name}}"
          debounceMs={20}
        />
      </Profiler>
    );
    const { rerender } = renderComms(preview('One'));
    await screen.findByTestId('template-preview-subject');
    rerender(preview('Two'));
    await waitFor(() =>
      expect(screen.getByTestId('template-preview-subject').textContent).toBe('[en] Two'),
    );
    const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await act(() => idle(100));
    const settled = renders;
    // Ten debounce intervals with no input: nothing to render. (Not inside act(), which would
    // hold back the updates until the end and hide a loop.)
    await idle(200);
    expect(renders - settled).toBe(0);
  });
});

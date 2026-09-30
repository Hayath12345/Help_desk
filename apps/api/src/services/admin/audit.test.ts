import { describe, expect, it } from 'vitest';
import { auditDiff, auditRow, redactFields } from './audit.ts';

const context = { actorId: '00000000-0000-4000-8000-000000000001', requestId: 'req-12345678' };
const WEBHOOK = 'https://contoso.webhook.office.com/webhookb2/SECRET-PATH@tenant/IncomingWebhook/x';

describe('audit redaction (E17)', () => {
  it('never stores password hashes, MFA secrets or session versions', () => {
    const out = redactFields({
      name: 'Sam',
      passwordHash: '$argon2id$v=19$…',
      mfaSecret: 'JBSWY3DPEHPK3PXP',
      sessionVersion: 4,
      tokenHash: 'abc',
    });
    expect(out).toEqual({ name: 'Sam' });
  });

  it('keeps only the host of a Teams webhook URL', () => {
    expect(redactFields({ teamsWebhookUrl: WEBHOOK })).toEqual({
      teamsWebhookHost: 'contoso.webhook.office.com',
    });
    expect(redactFields({ teamsWebhookUrl: null })).toEqual({ teamsWebhookHost: null });
    expect(JSON.stringify(redactFields({ nested: { teamsWebhookUrl: WEBHOOK } }))).not.toContain(
      'SECRET',
    );
  });

  it('masks phone numbers, also inside nested values', () => {
    expect(redactFields({ phone: '+97455501234', socPhone: '+97444440000' })).toEqual({
      phone: '+974******34',
      socPhone: '+974******00',
    });
    expect(redactFields({ onCallUser: { id: 'u', phone: '+97455501234' } })).toEqual({
      onCallUser: { id: 'u', phone: '+974******34' },
    });
  });

  it('stores dates as ISO strings and drops ids / timestamps', () => {
    const at = new Date('2026-09-29T10:00:00.000Z');
    expect(
      redactFields({ id: 'x', createdAt: at, updatedAt: at, amcExpiry: at, list: [at] }),
    ).toEqual({ amcExpiry: '2026-09-29T10:00:00.000Z', list: ['2026-09-29T10:00:00.000Z'] });
  });
});

describe('audit diff', () => {
  it('records the changed fields only', () => {
    const before = { labelEn: 'Printers', labelAr: '', isActive: true, updatedAt: new Date(1) };
    const after = { labelEn: 'Printing', labelAr: '', isActive: true, updatedAt: new Date(2) };
    expect(auditDiff(before, after)).toEqual({
      before: { labelEn: 'Printers' },
      after: { labelEn: 'Printing' },
    });
  });

  it('nothing changed → null (no row)', () => {
    const row = { labelEn: 'A', options: [{ value: 'a', labelEn: 'A' }], at: new Date(5) };
    expect(
      auditDiff(row, { ...row, options: [{ labelEn: 'A', value: 'a' }], at: new Date(5) }),
    ).toBe(null);
    expect(
      auditRow(
        { action: 'UPDATE', entity: 'Category', entityId: 'c', before: row, after: row },
        context,
      ),
    ).toBe(null);
  });

  it('a new webhook URL on the same host is still a change (host only on both sides)', () => {
    const diff = auditDiff(
      { teamsWebhookUrl: `${WEBHOOK}/1` },
      { teamsWebhookUrl: `${WEBHOOK}/2` },
    );
    expect(diff).toEqual({
      before: { teamsWebhookHost: 'contoso.webhook.office.com' },
      after: { teamsWebhookHost: 'contoso.webhook.office.com' },
    });
  });

  it('a phone change is recorded masked', () => {
    expect(auditDiff({ phone: '+97455501234' }, { phone: '+97455509999' })).toEqual({
      before: { phone: '+974******34' },
      after: { phone: '+974******99' },
    });
  });

  it('a password or session change alone is not an audited change', () => {
    expect(auditDiff({ sessionVersion: 1 }, { sessionVersion: 2 })).toBe(null);
  });
});

describe('audit rows', () => {
  it('CREATE stores the redacted row; DELETE the row before', () => {
    const created = auditRow(
      {
        action: 'CREATE',
        entity: 'Team',
        entityId: 't1',
        entityLabel: '  Security Operations  ',
        after: { id: 't1', key: 'soc', teamsWebhookUrl: WEBHOOK, emails: ['soc@x.qa'] },
      },
      context,
    );
    expect(created).toEqual({
      actorId: context.actorId,
      action: 'CREATE',
      entity: 'Team',
      entityId: 't1',
      entityLabel: 'Security Operations',
      requestId: 'req-12345678',
      after: { key: 'soc', teamsWebhookHost: 'contoso.webhook.office.com', emails: ['soc@x.qa'] },
    });
    const deleted = auditRow(
      { action: 'DELETE', entity: 'TeamMember', entityId: 't1:u1', before: { role: 'LEAD' } },
      context,
    );
    expect(deleted).toMatchObject({ action: 'DELETE', before: { role: 'LEAD' } });
    expect(deleted).not.toHaveProperty('after');
  });

  it('labels are capped at 200 characters', () => {
    const row = auditRow(
      {
        action: 'CREATE',
        entity: 'HelpArticle',
        entityId: 'h',
        entityLabel: 'x'.repeat(500),
        after: {},
      },
      context,
    );
    expect(row?.entityLabel).toHaveLength(200);
  });
});

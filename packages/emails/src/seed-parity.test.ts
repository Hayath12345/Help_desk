import { describe, expect, it } from 'vitest';
// The seeded rows (packages/db) are the admin-editable copies of these defaults. Imported by path:
// the seed file has no imports, and @loons/emails must not depend on @loons/db.
import { EMAIL_TEMPLATES } from '../../db/prisma/seed-data/email-templates.ts';
import { DEFAULT_EMAIL_TEMPLATES, TICKET_EMAIL_TEMPLATE_KEYS } from './defaults.ts';

describe('ticket template defaults match the seeded EmailTemplate rows', () => {
  it('the seed defines exactly the nine ticket keys (plus the auth ones)', () => {
    const seeded = EMAIL_TEMPLATES.map((t) => t.key);
    for (const key of TICKET_EMAIL_TEMPLATE_KEYS) expect(seeded, key).toContain(key);
    expect(seeded.filter((k) => !(k in DEFAULT_EMAIL_TEMPLATES))).toEqual([]);
  });

  for (const key of TICKET_EMAIL_TEMPLATE_KEYS) {
    it(`${key}: same subject, body (EN + AR) and variables`, () => {
      const seed = EMAIL_TEMPLATES.find((t) => t.key === key);
      const builtIn = DEFAULT_EMAIL_TEMPLATES[key];
      expect(seed).toBeDefined();
      expect({
        subjectEn: builtIn.subjectEn,
        bodyEn: builtIn.bodyEn,
        subjectAr: builtIn.subjectAr,
        bodyAr: builtIn.bodyAr,
        variables: builtIn.variables,
      }).toEqual({
        subjectEn: seed?.subjectEn,
        bodyEn: seed?.bodyEn,
        subjectAr: seed?.subjectAr,
        bodyAr: seed?.bodyAr,
        variables: seed?.variables,
      });
    });
  }
});

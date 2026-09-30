import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ticketResponseSchema } from '@loons/shared';
import { createTestContext, type TestContext } from './helpers.ts';
import { apiAs, createTicket, createWorld, ticketBody, type World } from './ticket-world.ts';

// Decision E6 (API side): old tickets keep rendering archived config. The ticket detail marks the
// team and site with `isActive`, and custom-field values carry the field's `isActive` and, for
// dropdowns, their option labels — archived options and fields included.

describe('ticket detail with archived config (E6)', () => {
  let ctx: TestContext;
  let w: World;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('keeps labels and marks archived team, site, field and options', async () => {
    const team = await ctx.fixtures.team();
    const { category, subtypes, fields } = await ctx.fixtures.category({
      teamId: team.id,
      fields: [
        { type: 'DROPDOWN', options: ['red', 'green'] },
        { type: 'MULTI_SELECT', options: ['a', 'b', 'c'] },
        { type: 'TEXT' },
      ],
    });
    const [dropdown, multi, text] = fields as [
      (typeof fields)[number],
      (typeof fields)[number],
      (typeof fields)[number],
    ];
    await ctx.app.services.ticketConfig.invalidate();
    const created = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, {
        categoryId: category.id,
        subtypeId: subtypes[0]!.id,
        siteId: w.siteX2.id,
        customFields: { [dropdown.key]: 'green', [multi.key]: ['c', 'a'], [text.key]: 'hello' },
      }),
    );

    // The admin archives the option "green", the whole multi-select field, the team and the site.
    await ctx.prisma.customField.update({
      where: { id: dropdown.id },
      data: {
        options: [
          { value: 'red', labelEn: 'red', labelAr: 'red' },
          { value: 'green', labelEn: 'Green', labelAr: 'أخضر', isActive: false },
        ],
      },
    });
    await ctx.prisma.customField.update({ where: { id: multi.id }, data: { isActive: false } });
    await ctx.prisma.team.update({ where: { id: team.id }, data: { isActive: false } });
    await ctx.prisma.site.update({ where: { id: w.siteX2.id }, data: { isActive: false } });
    await ctx.app.services.ticketConfig.invalidate();

    const res = await apiAs(ctx, w.admin).get(`/tickets/${created.id}`);
    expect(res.statusCode).toBe(200);
    const { ticket } = ticketResponseSchema.parse(res.json());
    expect(ticket.team).toMatchObject({ id: team.id, isActive: false });
    expect(ticket.site).toMatchObject({ id: w.siteX2.id, isActive: false });
    const byKey = Object.fromEntries(ticket.customFields.map((f) => [f.key, f]));
    expect(byKey[dropdown.key]).toMatchObject({
      isActive: true,
      value: 'green',
      options: [{ value: 'green', labelEn: 'Green', labelAr: 'أخضر', isActive: false }],
    });
    expect(byKey[multi.key]).toMatchObject({
      isActive: false,
      value: ['c', 'a'],
      options: [
        { value: 'c', labelEn: 'c', isActive: true },
        { value: 'a', labelEn: 'a', isActive: true },
      ],
    });
    expect(byKey[text.key]).toMatchObject({ isActive: true, value: 'hello', options: null });

    // Summaries (lists, realtime) carry the markers too.
    const list = await apiAs(ctx, w.admin).get(`/tickets?search=${created.ref}`);
    const row = list.json().items.find((t: { id: string }) => t.id === created.id);
    expect(row.team.isActive).toBe(false);
    expect(row.site.isActive).toBe(false);
  });
});

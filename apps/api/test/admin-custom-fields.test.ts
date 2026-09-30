import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CATEGORY_FIELDS_MAX,
  customFieldListSchema,
  customFieldResponseSchema,
  ticketFormConfigSchema,
  ticketResponseSchema,
  type CustomFieldAdminDto,
} from '@loons/shared';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

// Admin — Custom fields (spec §10.2; decisions E4, E5, E6, E17, E18, E19): routes × roles,
// validation (options per type), immutable key, type changes only while unused, option archive
// instead of removal, category links, stale 409, audit rows and the `ticket-form` scope.

describe('admin custom fields', () => {
  let ctx: TestContext;
  let w: World;
  let admin: Persona;
  const sent: Array<[string, unknown]> = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    admin = w.admin;
    const broadcast = ctx.app.realtime.broadcast.bind(ctx.app.realtime);
    vi.spyOn(ctx.app.realtime, 'broadcast').mockImplementation((event, payload) => {
      sent.push([event, payload]);
      broadcast(event, payload);
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const api = () => apiAs(ctx, admin);
  const scopesSince = (mark: number) =>
    sent
      .slice(mark)
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });
  const opt = (value: string, isActive = true) => ({
    value,
    labelEn: value.toUpperCase(),
    labelAr: `خيار ${value}`,
    isActive,
  });

  async function createField(body: Record<string, unknown>): Promise<CustomFieldAdminDto> {
    const res = await api().post('/admin/custom-fields', {
      labelEn: `Test Field ${rand()}`,
      type: 'TEXT',
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    const { item } = customFieldResponseSchema.parse(res.json());
    ctx.fixtures.trackField(item.id);
    return item;
  }

  /** A category of its own (tickets raised in one test don't meet another test's required fields). */
  async function freshCategory() {
    const { category, subtypes } = await ctx.fixtures.category({ teamId: w.teamA.id });
    const body = (customFields: Record<string, unknown>) =>
      ticketBody(w, { categoryId: category.id, subtypeId: subtypes[0]!.id, customFields });
    return { id: category.id, body };
  }

  async function formFields(categoryId: string) {
    const res = await apiAs(ctx, w.clientX).get('/config/ticket-form');
    return ticketFormConfigSchema.parse(res.json()).categories.find((c) => c.id === categoryId)
      ?.fields;
  }

  it('401 anonymous; 403 for clients, agents and team leads', async () => {
    const field = await createField({});
    const body = { expectedUpdatedAt: field.updatedAt };
    const calls: Array<[string, (p?: Persona) => ReturnType<ReturnType<typeof apiAs>['get']>]> = [
      ['list', (p) => apiAs(ctx, p).get('/admin/custom-fields')],
      ['create', (p) => apiAs(ctx, p).post('/admin/custom-fields', {})],
      ['update', (p) => apiAs(ctx, p).patch(`/admin/custom-fields/${field.id}`, body)],
      ['archive', (p) => apiAs(ctx, p).post(`/admin/custom-fields/${field.id}/archive`, body)],
      ['restore', (p) => apiAs(ctx, p).post(`/admin/custom-fields/${field.id}/restore`, body)],
    ];
    for (const [name, call] of calls) {
      expect((await call(undefined)).statusCode, `anonymous ${name}`).toBe(401);
      for (const p of [w.clientX, w.agentA, w.leadA]) {
        expect((await call(p)).statusCode, `${p.role} ${name}`).toBe(403);
      }
    }
  });

  it('creates a dropdown linked to categories (last in each); key from the label with _', async () => {
    const cat = await freshCategory();
    const mark = sent.length;
    const labelEn = `Test Door Side ${rand()}`;
    const field = await createField({
      labelEn,
      labelAr: 'جهة الباب',
      type: 'DROPDOWN',
      options: [opt('left'), opt('right')],
      placeholderEn: 'Pick a side',
      required: true,
      categoryIds: [cat.id],
    });
    expect(field.key).toBe(labelEn.toLowerCase().replaceAll(' ', '_'));
    expect(field.options).toEqual([opt('left'), opt('right')]);
    expect(field.categories).toEqual([
      expect.objectContaining({ id: cat.id, sortOrder: 0, isActive: true }),
    ]);
    expect(scopesSince(mark)).toEqual(['ticket-form']);
    expect(await auditRows(field.id)).toMatchObject([
      {
        action: 'CREATE',
        entity: 'CustomField',
        after: expect.objectContaining({ key: field.key, categoryIds: [cat.id] }),
      },
    ]);
    const onForm = await formFields(cat.id);
    expect(onForm?.at(-1)).toMatchObject({
      id: field.id,
      required: true,
      options: [
        { value: 'left', labelEn: 'LEFT', labelAr: 'خيار left' },
        { value: 'right', labelEn: 'RIGHT', labelAr: 'خيار right' },
      ],
    });
    // A second field goes after it.
    const next = await createField({ categoryIds: [cat.id] });
    expect(next.categories[0]?.sortOrder).toBe(1);
  });

  it('validation: options per type, unique values, a known category, key format, duplicate key', async () => {
    const labelEn = `Test x ${rand()}`;
    // Whatever a broken rule lets through is removed even if the test stops early.
    ctx.fixtures.onCleanup(() => ctx.prisma.customField.deleteMany({ where: { labelEn } }));
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'DROPDOWN', options: [] }, 'validation.optionsRequired'],
      [{ type: 'MULTI_SELECT', options: [opt('a', false)] }, 'validation.optionsRequired'],
      [{ type: 'TEXT', options: [opt('a')] }, 'validation.optionsNotAllowed'],
      [{ type: 'DROPDOWN', options: [opt('a'), opt('a')] }, 'validation.duplicateValue'],
      [{ type: 'DROPDOWN', options: [opt('Not OK')] }, 'validation.keyFormat'],
      [{ type: 'TEXT', categoryIds: [crypto.randomUUID()] }, 'validation.notFound'],
      [{ type: 'TEXT', key: 'Bad-Key' }, 'validation.keyFormat'],
      [{ type: 'NOPE' }, ''],
    ];
    for (const [body, message] of cases) {
      const res = await api().post('/admin/custom-fields', { labelEn, ...body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      if (message) expect(JSON.stringify(res.json().error.details)).toContain(message);
    }
    expect(await ctx.prisma.customField.count({ where: { labelEn } })).toBe(0);
    const taken = await createField({ key: `tf_${rand()}` });
    const dup = await api().post('/admin/custom-fields', {
      key: taken.key,
      labelEn: 'Test y',
      type: 'TEXT',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details).toMatchObject({
      reason: 'duplicate',
      fields: ['key'],
      existingId: taken.id,
    });
  });

  describe('update', () => {
    it('edits labels, placeholders and required; the key never changes; 409 stale; audits changes', async () => {
      const field = await createField({});
      const res = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: field.updatedAt,
        key: 'other_key',
        labelAr: 'حقل',
        placeholderAr: 'اكتب هنا',
        required: true,
      });
      expect(res.statusCode, res.body).toBe(200);
      const { item } = customFieldResponseSchema.parse(res.json());
      expect(item).toMatchObject({ key: field.key, labelAr: 'حقل', required: true });
      const update = (await auditRows(field.id)).find((r) => r.action === 'UPDATE');
      expect(update?.before).toEqual({ labelAr: '', placeholderAr: null, required: false });
      expect(update?.after).toEqual({ labelAr: 'حقل', placeholderAr: 'اكتب هنا', required: true });

      const mark = sent.length;
      const stale = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: field.updatedAt,
        labelEn: 'Lost update',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');
      expect(scopesSince(mark)).toEqual([]);
    });

    it('options: archive one instead of removing it; an option a ticket holds can’t be removed', async () => {
      const cat = await freshCategory();
      const field = await createField({
        type: 'DROPDOWN',
        options: [opt('red'), opt('green'), opt('blue')],
        categoryIds: [cat.id],
      });
      const ticket = await createTicket(ctx, w.clientX, cat.body({ [field.key]: 'green' }));

      // Removing an unused option is fine; removing the one the ticket holds is refused.
      const removeBlue = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: field.updatedAt,
        options: [opt('red'), opt('green')],
      });
      expect(removeBlue.statusCode, removeBlue.body).toBe(200);
      const current = removeBlue.json().item as CustomFieldAdminDto;
      const removeGreen = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: current.updatedAt,
        options: [opt('red')],
      });
      expect(removeGreen.statusCode).toBe(409);
      expect(removeGreen.json().error.details).toEqual({ reason: 'guard', guard: 'option_in_use' });

      // Archive it instead: it leaves the form, the ticket keeps its label (E6).
      const archive = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: current.updatedAt,
        options: [opt('red'), { ...opt('green', false), labelEn: 'Green (old)' }],
      });
      expect(archive.statusCode, archive.body).toBe(200);
      expect(archive.json().item.options[1]).toMatchObject({ value: 'green', isActive: false });
      expect((await formFields(cat.id))?.find((f) => f.id === field.id)?.options).toEqual([
        { value: 'red', labelEn: 'RED', labelAr: 'خيار red' },
      ]);
      const detail = ticketResponseSchema.parse(
        (await apiAs(ctx, w.admin).get(`/tickets/${ticket.id}`)).json(),
      ).ticket;
      expect(detail.customFields.find((f) => f.key === field.key)).toMatchObject({
        value: 'green',
        options: [{ value: 'green', labelEn: 'Green (old)', isActive: false }],
      });
    });

    it('multi-select values count as in use too', async () => {
      const cat = await freshCategory();
      const field = await createField({
        type: 'MULTI_SELECT',
        options: [opt('a'), opt('b'), opt('c')],
        categoryIds: [cat.id],
      });
      await createTicket(ctx, w.clientX, cat.body({ [field.key]: ['c', 'a'] }));
      const res = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: field.updatedAt,
        options: [opt('a'), opt('b')],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.guard).toBe('option_in_use');
      const ok = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: field.updatedAt,
        options: [opt('a'), opt('c')],
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it('the type changes only while no ticket holds a value', async () => {
      const cat = await freshCategory();
      const field = await createField({
        type: 'DROPDOWN',
        options: [opt('x')],
        categoryIds: [cat.id],
      });
      // Unused: DROPDOWN → TEXT drops the options.
      const toText = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: field.updatedAt,
        type: 'TEXT',
      });
      expect(toText.statusCode, toText.body).toBe(200);
      expect(toText.json().item).toMatchObject({ type: 'TEXT', options: [] });
      // TEXT → DROPDOWN needs options.
      const noOptions = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: toText.json().item.updatedAt,
        type: 'DROPDOWN',
      });
      expect(noOptions.statusCode).toBe(400);
      expect(JSON.stringify(noOptions.json())).toContain('validation.optionsRequired');

      await createTicket(ctx, w.clientX, cat.body({ [field.key]: 'hello' }));
      const used = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: toText.json().item.updatedAt,
        type: 'NUMBER',
      });
      expect(used.statusCode).toBe(409);
      expect(used.json().error.details).toEqual({ reason: 'guard', guard: 'field_type_in_use' });
      expect(
        (await ctx.prisma.customField.findUniqueOrThrow({ where: { id: field.id } })).type,
      ).toBe('TEXT');
    });

    it('categoryIds replaces the links: kept ones keep their place, new ones go last', async () => {
      const cat = await freshCategory();
      const field = await createField({ categoryIds: [cat.id] });
      const before = await ctx.prisma.category.findUniqueOrThrow({
        where: { id: w.catB.category.id },
      });
      const res = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: field.updatedAt,
        categoryIds: [w.catB.category.id],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().item.categories.map((c: { id: string }) => c.id)).toEqual([
        w.catB.category.id,
      ]);
      expect((await formFields(cat.id))?.some((f) => f.id === field.id)).toBe(false);
      expect((await formFields(w.catB.category.id))?.at(-1)?.id).toBe(field.id);
      // The categories whose links changed moved on (an open category sheet reloads first).
      const after = await ctx.prisma.category.findUniqueOrThrow({
        where: { id: w.catB.category.id },
      });
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      const update = (await auditRows(field.id)).find((r) => r.action === 'UPDATE');
      expect(update).toMatchObject({
        before: { categoryIds: [cat.id] },
        after: { categoryIds: [w.catB.category.id] },
      });
    });

    it('a link changed from the category side makes an older field edit stale (E19)', async () => {
      // categoryIds replaces the whole set, so a sheet opened before the category side linked or
      // unlinked the field would silently undo that change (review shared-db-1).
      const [x, y, z] = [await freshCategory(), await freshCategory(), await freshCategory()];
      const field = await createField({ categoryIds: [x.id] });
      const linksOf = async () =>
        (
          await ctx.prisma.categoryField.findMany({
            where: { fieldId: field.id },
            select: { categoryId: true },
          })
        )
          .map((l) => l.categoryId)
          .sort();
      const categoryUpdatedAt = async (id: string) =>
        (await ctx.prisma.category.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();

      // Linked from category Y's sheet: the field moved on.
      const linked = await api().put(`/admin/categories/${y.id}/fields`, {
        expectedUpdatedAt: await categoryUpdatedAt(y.id),
        fieldIds: [field.id],
      });
      expect(linked.statusCode, linked.body).toBe(200);
      const stale = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: field.updatedAt,
        categoryIds: [x.id, z.id],
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');
      expect(await linksOf()).toEqual([x.id, y.id].sort());

      // Unlinked from Y's sheet: an edit started before can't bring the link back.
      const fresh = await ctx.prisma.customField.findUniqueOrThrow({ where: { id: field.id } });
      const unlinked = await api().put(`/admin/categories/${y.id}/fields`, {
        expectedUpdatedAt: await categoryUpdatedAt(y.id),
        fieldIds: [],
      });
      expect(unlinked.statusCode, unlinked.body).toBe(200);
      const resurrect = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: fresh.updatedAt.toISOString(),
        categoryIds: [x.id, y.id, z.id],
      });
      expect(resurrect.statusCode, resurrect.body).toBe(409);
      expect(await linksOf()).toEqual([x.id]);

      // Linked by a new category (POST /admin/categories with fieldIds): stale as well.
      const before = await ctx.prisma.customField.findUniqueOrThrow({ where: { id: field.id } });
      const created = await api().post('/admin/categories', {
        labelEn: `Test Cat ${rand()}`,
        teamId: w.teamA.id,
        firstSubtype: { labelEn: 'First kind', defaultPriority: 'P3' },
        fieldIds: [field.id],
      });
      expect(created.statusCode, created.body).toBe(201);
      const newCategory = created.json().item.id as string;
      ctx.fixtures.trackCategory(newCategory);
      const lost = await api().patch(`/admin/custom-fields/${field.id}`, {
        expectedUpdatedAt: before.updatedAt.toISOString(),
        categoryIds: [x.id],
      });
      expect(lost.statusCode, lost.body).toBe(409);
      expect(await linksOf()).toEqual([x.id, newCategory].sort());
    });
  });

  it('a category that already has CATEGORY_FIELDS_MAX fields can’t get another from this side', async () => {
    // The category side caps its links (PUT /admin/categories/:id/fields); linking from the field
    // side must not push a category past it (review api-setup-3 / shared-db-2).
    const cat = await freshCategory();
    const stamp = rand(3);
    const rows = await ctx.prisma.customField.createManyAndReturn({
      data: Array.from({ length: CATEGORY_FIELDS_MAX }, (_, i) => ({
        key: `tf_cap_${stamp}_${i}`,
        labelEn: `Cap ${stamp} ${i}`,
        type: 'TEXT' as const,
      })),
      select: { id: true },
    });
    rows.forEach((r) => ctx.fixtures.trackField(r.id));
    await ctx.prisma.categoryField.createMany({
      data: rows.map((r, i) => ({ categoryId: cat.id, fieldId: r.id, sortOrder: i })),
    });
    const links = () => ctx.prisma.categoryField.count({ where: { categoryId: cat.id } });

    const labelEn = `Test Over Cap ${rand()}`;
    ctx.fixtures.onCleanup(() => ctx.prisma.customField.deleteMany({ where: { labelEn } }));
    const created = await api().post('/admin/custom-fields', {
      labelEn,
      type: 'TEXT',
      categoryIds: [w.catB.category.id, cat.id],
    });
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json().error.details).toEqual([
      expect.objectContaining({
        path: ['categoryIds', 1],
        message: 'validation.categoryFieldsFull',
      }),
    ]);
    expect(await ctx.prisma.customField.count({ where: { labelEn } })).toBe(0);
    expect(await links()).toBe(CATEGORY_FIELDS_MAX);

    const other = await createField({});
    const patched = await api().patch(`/admin/custom-fields/${other.id}`, {
      expectedUpdatedAt: other.updatedAt,
      categoryIds: [cat.id],
    });
    expect(patched.statusCode, patched.body).toBe(400);
    expect(patched.json().error.details).toEqual([
      expect.objectContaining({
        path: ['categoryIds', 0],
        message: 'validation.categoryFieldsFull',
      }),
    ]);
    expect(await links()).toBe(CATEGORY_FIELDS_MAX);

    // A field already linked keeps its link when its other categories change.
    const linked = await ctx.prisma.customField.findUniqueOrThrow({ where: { id: rows[0]!.id } });
    const kept = await api().patch(`/admin/custom-fields/${linked.id}`, {
      expectedUpdatedAt: linked.updatedAt.toISOString(),
      categoryIds: [cat.id, w.catB.category.id],
    });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(await links()).toBe(CATEGORY_FIELDS_MAX);
  });

  it('archive / restore: off the form, still on old tickets (E6); list filters by status', async () => {
    const cat = await freshCategory();
    const field = await createField({ categoryIds: [cat.id] });
    const ticket = await createTicket(ctx, w.clientX, cat.body({ [field.key]: 'kept' }));
    const archived = await api().post(`/admin/custom-fields/${field.id}/archive`, {
      expectedUpdatedAt: field.updatedAt,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().item.isActive).toBe(false);
    expect((await formFields(cat.id))?.some((f) => f.id === field.id)).toBe(false);
    const detail = ticketResponseSchema.parse(
      (await apiAs(ctx, w.agentA).get(`/tickets/${ticket.id}`)).json(),
    ).ticket;
    expect(detail.customFields.find((f) => f.key === field.key)).toMatchObject({
      value: 'kept',
      isActive: false,
    });
    const ids = async (status: string) =>
      customFieldListSchema
        .parse((await api().get(`/admin/custom-fields?status=${status}`)).json())
        .items.map((f) => f.id);
    expect(await ids('active')).not.toContain(field.id);
    expect(await ids('archived')).toContain(field.id);
    const restored = await api().post(`/admin/custom-fields/${field.id}/restore`, {
      expectedUpdatedAt: archived.json().item.updatedAt,
    });
    expect(restored.json().item.isActive).toBe(true);
    expect((await auditRows(field.id)).map((r) => r.action)).toEqual([
      'CREATE',
      'ARCHIVE',
      'RESTORE',
    ]);
  });
});

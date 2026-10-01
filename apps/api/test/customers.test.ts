import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  customerListSchema,
  customerOrgResponseSchema,
  type CustomerList,
  type CustomerRow,
} from '@loons/shared';
import { createTestContext, rand, testEmail, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

// Phase 5 Customers (decisions F8, F9): one row per active client requester (the requester search's
// people: active, verified clients of active organisations), sorted by name and keyset-paged,
// searchable by name, email or company, with open / total ticket counts over the tickets the caller
// can see; header totals for the whole search; the organisation look-up for the Inbox company view.

describe('GET /customers', () => {
  let ctx: TestContext;
  let w: World;
  const tag = rand(4);
  let orgP: { id: string; name: string };
  let orgQ: { id: string; name: string };
  let people: Record<'ann' | 'bob' | 'cai' | 'dee', Persona>;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    const f = ctx.fixtures;
    // Org P: AMC that expired years ago; org Q: billable with an old date (never "expired").
    const p = await f.client({ name: `Ann ${tag}` });
    const q = await f.client({ name: `Cai ${tag}` });
    orgP = await ctx.prisma.organization.update({
      where: { id: p.org.id },
      data: { name: `Pelican ${tag}`, nameAr: `بيليكان ${tag}`, amcExpiry: new Date('2020-01-31') },
    });
    orgQ = await ctx.prisma.organization.update({
      where: { id: q.org.id },
      data: { name: `Quokka ${tag}`, contractType: 'BILLABLE', amcExpiry: new Date('2020-01-31') },
    });
    const bob = await f.user({ email: testEmail(p.domain), orgId: p.org.id, name: `Bob ${tag}` });
    const dee = await f.user({ email: testEmail(q.domain), orgId: q.org.id, name: `Dee ${tag}` });
    // Not requesters: unverified, disabled, pending, a client of an archived organisation, staff.
    await f.user({
      email: testEmail(p.domain),
      orgId: p.org.id,
      name: `Eve ${tag}`,
      emailVerified: false,
    });
    await f.user({
      email: testEmail(p.domain),
      orgId: p.org.id,
      name: `Fay ${tag}`,
      status: 'DISABLED',
    });
    await f.user({
      email: testEmail(p.domain),
      orgId: p.org.id,
      name: `Gus ${tag}`,
      status: 'PENDING_APPROVAL',
    });
    const archived = await f.client({ name: `Hal ${tag}` });
    await ctx.prisma.organization.update({
      where: { id: archived.org.id },
      data: { isActive: false },
    });
    await f.staff({ staffDomain: ctx.config.staffEmailDomain, name: `Ian ${tag}` });
    people = {
      ann: await persona(ctx, p.user),
      bob: await persona(ctx, bob),
      cai: await persona(ctx, q.user),
      dee: await persona(ctx, dee),
    };

    // Tickets: Ann 2 on team A (1 open, 1 solved) + 1 on team B; Bob 1 on team B; Cai 1 on team
    // A (open); Dee none.
    const siteP = await f.site(p.org.id);
    const siteQ = await f.site(q.org.id);
    const raise = async (who: Persona, siteId: string, team: 'A' | 'B', status?: string) => {
      const c = team === 'A' ? w.catA : w.catB;
      const t = await createTicket(
        ctx,
        who,
        ticketBody(w, { siteId, categoryId: c.category.id, subtypeId: c.subtypes[0]!.id }),
      );
      if (status) {
        await ctx.prisma.ticket.update({ where: { id: t.id }, data: { status: status as never } });
      }
    };
    await raise(people.ann, siteP.id, 'A');
    await raise(people.ann, siteP.id, 'A', 'SOLVED');
    await raise(people.ann, siteP.id, 'B');
    await raise(people.bob, siteP.id, 'B', 'CLOSED');
    await raise(people.cai, siteQ.id, 'A', 'PENDING');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function list(as: Persona, query: string): Promise<CustomerList> {
    const res = await apiAs(ctx, as).get(`/customers?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return customerListSchema.parse(res.json());
  }
  const search = (term: string, extra = '') =>
    `search=${encodeURIComponent(term)}${extra ? `&${extra}` : ''}`;
  const brief = (r: CustomerRow) => [r.name, r.org.name, r.open, r.total];

  it('one row per active requester, sorted by name, with the organisation and contract', async () => {
    const body = await list(w.admin, search(tag));
    expect(body.items.map((r) => r.name)).toEqual([
      `Ann ${tag}`,
      `Bob ${tag}`,
      `Cai ${tag}`,
      `Dee ${tag}`,
    ]);
    expect(body.totals).toEqual({ requesters: 4, companies: 2 });
    expect(body.nextCursor).toBeNull();
    const ann = body.items[0]!;
    expect(ann).toMatchObject({
      id: people.ann.id,
      email: people.ann.email,
      org: {
        id: orgP.id,
        name: `Pelican ${tag}`,
        nameAr: `بيليكان ${tag}`,
        contractType: 'AMC',
        amcExpiry: '2020-01-31',
        amcExpired: true,
        isActive: true,
      },
    });
    // Billable contracts never "expire".
    expect(body.items[2]!.org).toMatchObject({
      id: orgQ.id,
      contractType: 'BILLABLE',
      amcExpiry: '2020-01-31',
      amcExpired: false,
    });
  });

  it('open and total count only the tickets the caller can see', async () => {
    // Super admin: everything.
    expect((await list(w.admin, search(tag))).items.map(brief)).toEqual([
      [`Ann ${tag}`, `Pelican ${tag}`, 2, 3],
      [`Bob ${tag}`, `Pelican ${tag}`, 0, 1],
      [`Cai ${tag}`, `Quokka ${tag}`, 1, 1],
      [`Dee ${tag}`, `Quokka ${tag}`, 0, 0],
    ]);
    // Agent A (team A): the team B tickets don't count — but every requester is still listed.
    expect((await list(w.agentA, search(tag))).items.map(brief)).toEqual([
      [`Ann ${tag}`, `Pelican ${tag}`, 1, 2],
      [`Bob ${tag}`, `Pelican ${tag}`, 0, 0],
      [`Cai ${tag}`, `Quokka ${tag}`, 1, 1],
      [`Dee ${tag}`, `Quokka ${tag}`, 0, 0],
    ]);
    // Agent B (team B).
    expect((await list(w.agentB, search(tag))).items.map(brief)).toEqual([
      [`Ann ${tag}`, `Pelican ${tag}`, 1, 1],
      [`Bob ${tag}`, `Pelican ${tag}`, 0, 1],
      [`Cai ${tag}`, `Quokka ${tag}`, 0, 0],
      [`Dee ${tag}`, `Quokka ${tag}`, 0, 0],
    ]);
  });

  it('searches name, email and company (English or Arabic); totals follow the search', async () => {
    expect((await list(w.agentA, search(`bob ${tag}`))).items.map((r) => r.name)).toEqual([
      `Bob ${tag}`,
    ]);
    expect(
      (await list(w.agentA, search(people.dee.email.toUpperCase()))).items.map((r) => r.id),
    ).toEqual([people.dee.id]);
    const company = await list(w.agentA, search(`quokka ${tag}`));
    expect(company.items.map((r) => r.name)).toEqual([`Cai ${tag}`, `Dee ${tag}`]);
    expect(company.totals).toEqual({ requesters: 2, companies: 1 });
    expect((await list(w.agentA, search(`بيليكان ${tag}`))).totals).toEqual({
      requesters: 2,
      companies: 1,
    });
    // Wildcards are literal; control characters are dropped.
    expect((await list(w.agentA, search(`${tag}%`))).items).toEqual([]);
    expect((await list(w.agentA, search(`\u0000Ann ${tag}`))).items.map((r) => r.name)).toEqual([
      `Ann ${tag}`,
    ]);
  });

  it.each([1, 3])('keyset paging by name (page size %i) covers every row once', async (limit) => {
    const names: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await list(
        w.agentA,
        search(tag, `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
      );
      expect(body.totals).toEqual({ requesters: 4, companies: 2 });
      names.push(...body.items.map((r) => r.name));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(names).toEqual([`Ann ${tag}`, `Bob ${tag}`, `Cai ${tag}`, `Dee ${tag}`]);
    expect(pages).toBe(Math.ceil(4 / limit));
  });

  it('sorts names in the Unicode root collation (case and accents next to the letter), paged', async () => {
    const tag2 = rand(4);
    const org = await ctx.fixtures.client({ name: `Zz ${tag2}` });
    for (const name of ['zeta', 'ZETA', 'Zéta', 'z-eta', 'Zeta', 'عمر', 'Äbc', 'abd']) {
      await ctx.fixtures.user({
        email: testEmail(org.domain),
        orgId: org.org.id,
        name: `${name} ${tag2}`,
      });
    }
    const expected = ['Äbc', 'abd', 'z-eta', 'zeta', 'Zeta', 'ZETA', 'Zéta', 'Zz', 'عمر'].map(
      (n) => `${n} ${tag2}`,
    );
    expect((await list(w.agentA, search(tag2, 'limit=100'))).items.map((r) => r.name)).toEqual(
      expected,
    );
    for (const limit of [1, 2, 4]) {
      const names: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const body = await list(
          w.agentA,
          search(tag2, `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
        );
        names.push(...body.items.map((r) => r.name));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      expect(names, `page size ${limit}`).toEqual(expected);
    }
  });

  it('400 for a malformed cursor or limit', async () => {
    for (const query of [
      'cursor=garbage',
      `cursor=${Buffer.from(JSON.stringify({ n: 'x', i: 'nope' })).toString('base64url')}`,
      // Postgres text can't hold U+0000: 400, never a 500.
      `cursor=${Buffer.from(JSON.stringify({ n: 'a\u0000b', i: randomUUID() })).toString('base64url')}`,
      'limit=0',
      'limit=101',
    ]) {
      expect((await apiAs(ctx, w.agentA).get(`/customers?${query}`)).statusCode, query).toBe(400);
    }
  });

  it('staff only: clients 403, no token 401', async () => {
    expect((await apiAs(ctx, w.clientX).get('/customers')).statusCode).toBe(403);
    expect((await apiAs(ctx).get('/customers')).statusCode).toBe(401);
  });

  describe('GET /customers/orgs/:id', () => {
    it('the organisation’s name and contract; 404 unknown; 403 clients', async () => {
      const res = await apiAs(ctx, w.agentB).get(`/customers/orgs/${orgP.id}`);
      expect(res.statusCode).toBe(200);
      expect(customerOrgResponseSchema.parse(res.json()).org).toEqual({
        id: orgP.id,
        name: `Pelican ${tag}`,
        nameAr: `بيليكان ${tag}`,
        contractType: 'AMC',
        amcExpiry: '2020-01-31',
        amcExpired: true,
        isActive: true,
      });
      expect((await apiAs(ctx, w.agentB).get(`/customers/orgs/${randomUUID()}`)).statusCode).toBe(
        404,
      );
      expect((await apiAs(ctx, w.agentB).get('/customers/orgs/nope')).statusCode).toBe(400);
      expect((await apiAs(ctx, people.ann).get(`/customers/orgs/${orgP.id}`)).statusCode).toBe(403);
    });

    it('the company view: GET /tickets?orgId= lists the organisation’s visible tickets, any status', async () => {
      const res = await apiAs(ctx, w.agentA).get(`/tickets?orgId=${orgP.id}&limit=100`);
      const items = (res.json() as { items: Array<{ requester: { id: string }; status: string }> })
        .items;
      // Team A: Ann's two tickets (one solved); the team B ones are not visible.
      expect(items.map((t) => t.status).sort()).toEqual(['NEW', 'SOLVED']);
      expect(items.every((t) => t.requester.id === people.ann.id)).toBe(true);
    });
  });
});

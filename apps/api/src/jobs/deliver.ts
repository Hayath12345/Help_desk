import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import {
  EMPTY_VALUE,
  buildSmsText,
  buildTeamsCard,
  buildTicketList,
  formatDurationMinutes,
  formatEmailDate,
  formatEmailDateTime,
  formatTargetDuration,
  slaTargetLabel,
  ticketLinks,
  ticketTemplateVariables,
  type EmailTemplateKey,
  type RenderedEmail,
  type TemplateAudience,
} from '@loons/emails';
import type { Locale } from '@loons/shared';
import type { DeliveryJob } from '../lib/job-data.ts';
import { normalizeE164 } from '../lib/phone.ts';
import { redactPii } from '../lib/pii.ts';
import { TeamsPermanentError } from '../lib/teams/index.ts';
import { renderStoredTemplate } from '../services/email-templates.ts';
import type { WorkerContext } from './context.ts';
import {
  factsOf,
  loadTicketFacts,
  recipientSelect,
  slaAlertStillValid,
  type Recipient,
  type TicketFactsRow,
} from './recipients.ts';

// One delivery = one email / Teams post / SMS (decision D15: a retry never re-sends another
// channel). The `NotificationDelivery` row is the log (spec §9 "dead-letter logging", the
// done-when evidence): QUEUED → SENT, or SKIPPED (nobody / nothing to send to, SMS cap, P1 already
// acknowledged), or FAILED with a redacted error (BullMQ retries with backoff; the last failure
// also lands in the dead-letter list). A delivery already SENT or SKIPPED is never sent again, and
// a per-delivery Redis lock keeps two workers from sending the same one at the same time. A job
// that finds the lock taken FAILS (retryable, BullMQ backoff) instead of completing: the holder may
// be a worker that died mid-send, whose lock only expires after LOCK_TTL_MS; the retries (5
// attempts, exponential from 10 s: about 150 s) outlast it and then find the row SENT (the holder
// finished) or send it themselves. Completing here would drop the message for good.

export type DeliverResult = { skipped: string } | { status: 'SENT' | 'SKIPPED'; reason?: string };

/** Another run of this delivery holds its lock: retry later (never "done"). */
export class DeliveryBusyError extends Error {
  constructor() {
    super('delivery in progress elsewhere; retrying later');
    this.name = 'DeliveryBusyError';
  }
}

const LOCK_TTL_MS = 120_000;
const ERROR_MAX = 500;
const P1_TEMPLATES = new Set(['P1_ALERT', 'P1_ESCALATION', 'P1_CREATED', 'P1_ESCALATED']);

/** Outcome of building a message: something to send, or a reason not to. */
type Prepared<T> = { send: T } | { skip: string };

class Skip extends Error {}

async function acquire(ctx: WorkerContext, key: string): Promise<(() => Promise<void>) | null> {
  const lockKey = `${ctx.redisPrefix}delivery-lock:${key}`;
  const token = randomUUID();
  const ok = await ctx.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');
  if (ok !== 'OK') return null;
  return async () => {
    try {
      await ctx.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        lockKey,
        token,
      );
    } catch {
      // Expires on its own.
    }
  };
}

async function recipientOf(ctx: WorkerContext, job: DeliveryJob): Promise<Recipient | null> {
  if (!job.userId) return null;
  const user = await ctx.prisma.user.findUnique({
    where: { id: job.userId },
    select: recipientSelect,
  });
  if (!user || user.status !== 'ACTIVE') throw new Skip('the recipient is not an active user');
  return user;
}

function requireTicket(t: TicketFactsRow | null): TicketFactsRow {
  if (!t) throw new Skip('the ticket is gone');
  return t;
}

/** A P1 message is only worth sending while its P1 period is still open and unacknowledged. */
function assertP1Open(t: TicketFactsRow, job: DeliveryJob): void {
  if (!P1_TEMPLATES.has(job.template)) return;
  const since = job.context.p1Since ? new Date(job.context.p1Since).getTime() : null;
  if (
    t.priority !== 'P1' ||
    t.p1AckedAt ||
    !t.p1Since ||
    (since !== null && t.p1Since.getTime() !== since)
  ) {
    throw new Skip('the P1 was acknowledged or is no longer P1');
  }
  if (t.status === 'SOLVED' || t.status === 'CLOSED') throw new Skip('the ticket is solved');
}

async function renderEmail(
  ctx: WorkerContext,
  key: EmailTemplateKey,
  locale: Locale,
  variables: Record<string, string>,
  audience?: TemplateAudience,
): Promise<RenderedEmail> {
  return renderStoredTemplate(ctx.prisma, key, {
    locale,
    variables,
    ...(audience ? { audience } : {}),
  });
}

const minutesBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 60_000;

/** The rendered email and its address for an EMAIL delivery. */
async function prepareEmail(
  ctx: WorkerContext,
  job: DeliveryJob,
): Promise<Prepared<{ to: string; email: RenderedEmail }>> {
  const user = await recipientOf(ctx, job);
  const to = user?.email ?? job.address;
  if (!to) return { skip: 'no email address' };
  // Distribution lists are English and greeting-less (D7); people get their own language.
  const locale: Locale = user?.locale ?? 'en';
  const audience: TemplateAudience | undefined = user ? undefined : 'list';
  const calendar = await ctx.ticketConfig.getCalendar();
  const timeZone = calendar.timeZone;
  const now = ctx.now();
  const name = user?.name ?? '';

  if (job.template === 'P4_DAILY_DIGEST') {
    const { windowStart, windowEnd, digestDate } = job.context;
    if (!job.teamId || !windowStart || !windowEnd || !digestDate)
      return { skip: 'incomplete digest' };
    const team = await ctx.prisma.team.findUnique({
      where: { id: job.teamId },
      select: { id: true, nameEn: true, nameAr: true },
    });
    if (!team) return { skip: 'the team is gone' };
    const tickets = await ctx.prisma.ticket.findMany({
      where: {
        teamId: team.id,
        priority: 'P4',
        createdAt: { gte: new Date(windowStart), lt: new Date(windowEnd) },
      },
      orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
      select: {
        number: true,
        subject: true,
        createdAt: true,
        org: { select: { name: true, nameAr: true } },
      },
    });
    if (tickets.length === 0) return { skip: 'no P4 tickets in the window' };
    const variables = {
      teamName: team.nameEn,
      ticketCount: String(tickets.length),
      digestDate: formatEmailDate(new Date(windowEnd), locale, timeZone),
      ticketList: buildTicketList(
        tickets.map((t) => ({
          number: t.number,
          subject: t.subject,
          orgName: { en: t.org.name, ar: t.org.nameAr },
          createdAt: t.createdAt,
        })),
        { locale, timeZone },
      ),
      queueUrl: `${ctx.appUrl}/console/inbox?team=${encodeURIComponent(team.id)}`,
    };
    return {
      send: { to, email: await renderEmail(ctx, job.template, locale, variables, audience) },
    };
  }

  if (!job.ticketId) return { skip: 'no ticket' };
  const t = requireTicket(await loadTicketFacts(ctx.prisma, job.ticketId));
  assertP1Open(t, job);
  const variables: Record<string, string> = {
    ...ticketTemplateVariables(factsOf(t), { locale, timeZone }),
    ...ticketLinks(ctx.appUrl, t.number),
    name,
  };

  switch (job.template) {
    case 'TICKET_CREATED_CLIENT': {
      const config = await ctx.ticketConfig.getFormConfig();
      const policy = config.slaPolicies.find((p) => p.priority === t.priority);
      variables.targetResponse = policy
        ? formatTargetDuration(policy.firstReplyMins, policy.businessHoursOnly, locale)
        : EMPTY_VALUE;
      variables.socPhone = config.socPhone ?? EMPTY_VALUE;
      break;
    }
    case 'AGENT_REPLY_CLIENT':
    case 'CLIENT_REPLY_ASSIGNEE': {
      const message = job.context.messageId
        ? await ctx.prisma.message.findUnique({
            where: { id: job.context.messageId },
            select: { ticketId: true, type: true, body: true, author: { select: { name: true } } },
          })
        : null;
      // Never anything but a PUBLIC message of this ticket (internal notes stay in the console).
      if (!message || message.ticketId !== t.id || message.type !== 'PUBLIC') {
        return { skip: 'the message is not a public message of this ticket' };
      }
      variables.messageBody = message.body;
      if (job.template === 'AGENT_REPLY_CLIENT')
        variables.agentName = message.author?.name ?? EMPTY_VALUE;
      else variables.requesterName = message.author?.name ?? variables.requesterName ?? EMPTY_VALUE;
      break;
    }
    case 'SLA_AT_RISK':
    case 'SLA_BREACHED': {
      const { target, dueAt } = job.context;
      if (!target || !dueAt) return { skip: 'incomplete SLA alert' };
      const due = new Date(dueAt);
      if (!slaAlertStillValid(t, target, due)) {
        return { skip: 'the SLA target was met, paused or moved since the alert' };
      }
      variables.slaTarget = slaTargetLabel(target, locale);
      variables.dueAt = formatEmailDateTime(due, locale, timeZone);
      variables.timeRemaining = formatDurationMinutes(
        Math.max(0, minutesBetween(now, due)),
        locale,
      );
      variables.overdueBy = formatDurationMinutes(Math.max(0, minutesBetween(due, now)), locale);
      break;
    }
    case 'P1_ALERT': {
      const mins = job.context.escalationMins;
      // Formatted in the reader's language ("5 minutes", "5 دقائق"); the bare number is kept
      // for templates stored before the wording change.
      variables.escalationDelay =
        mins !== undefined ? formatDurationMinutes(mins, locale) : EMPTY_VALUE;
      variables.escalationMins = mins !== undefined ? String(mins) : EMPTY_VALUE;
      break;
    }
    case 'P1_ESCALATION': {
      const mins = Math.max(0, Math.round(minutesBetween(t.p1Since ?? t.createdAt, now)));
      variables.step = String(job.context.step ?? 1);
      variables.unacknowledgedFor = formatDurationMinutes(mins, locale);
      variables.minutesUnacknowledged = String(mins);
      break;
    }
    default:
      break;
  }
  return {
    send: {
      to,
      email: await renderEmail(ctx, job.template as EmailTemplateKey, locale, variables, audience),
    },
  };
}

export async function processDelivery(
  ctx: WorkerContext,
  job: DeliveryJob,
): Promise<DeliverResult> {
  const where = { dedupeKey: job.dedupeKey };
  const row = await ctx.prisma.notificationDelivery.findUnique({ where, select: { status: true } });
  // Gone: its ticket / user / team was deleted (cascade) or the retention job removed it.
  if (!row) return { skipped: 'delivery-gone' };
  if (row.status === 'SENT' || row.status === 'SKIPPED') return { skipped: 'already-done' };

  const release = await acquire(ctx, job.dedupeKey);
  if (!release) throw new DeliveryBusyError();
  try {
    const current = await ctx.prisma.notificationDelivery.findUnique({
      where,
      select: { status: true },
    });
    if (!current) return { skipped: 'delivery-gone' };
    if (current.status === 'SENT' || current.status === 'SKIPPED')
      return { skipped: 'already-done' };

    const skip = async (reason: string): Promise<DeliverResult> => {
      await ctx.prisma.notificationDelivery.updateMany({
        where,
        data: { status: 'SKIPPED', error: reason.slice(0, ERROR_MAX) },
      });
      ctx.logger.info(
        { delivery: job.dedupeKey, channel: job.channel, reason },
        'delivery skipped',
      );
      return { status: 'SKIPPED', reason };
    };

    let send: () => Promise<string>;
    try {
      const prepared = await prepare(ctx, job);
      if ('skip' in prepared) return await skip(prepared.skip);
      send = prepared.send;
    } catch (err) {
      if (err instanceof Skip) return await skip(err.message);
      throw err;
    }

    await ctx.prisma.notificationDelivery.updateMany({
      where,
      data: { attempts: { increment: 1 } },
    });
    let messageId: string;
    try {
      messageId = await send();
    } catch (err) {
      if (err instanceof Skip) return await skip(err.message);
      const message = redactPii(err instanceof Error ? err.message : String(err)).slice(
        0,
        ERROR_MAX,
      );
      await ctx.prisma.notificationDelivery.updateMany({
        where,
        data: { status: 'FAILED', error: message },
      });
      if (err instanceof TeamsPermanentError) throw new UnrecoverableError(message);
      throw new Error(message);
    }
    await ctx.prisma.notificationDelivery.updateMany({
      where,
      data: {
        status: 'SENT',
        sentAt: ctx.now(),
        providerMessageId: messageId.slice(0, 200),
        error: null,
      },
    });
    ctx.logger.info(
      { delivery: job.dedupeKey, channel: job.channel, template: job.template },
      'delivery sent',
    );
    return { status: 'SENT' };
  } finally {
    await release();
  }
}

/** Builds the channel's message; resolves to the send function, or a reason to skip. */
async function prepare(
  ctx: WorkerContext,
  job: DeliveryJob,
): Promise<Prepared<() => Promise<string>>> {
  switch (job.channel) {
    case 'EMAIL': {
      const prepared = await prepareEmail(ctx, job);
      if ('skip' in prepared) return prepared;
      const { to, email } = prepared.send;
      return {
        send: async () =>
          (await ctx.email.send({ to, subject: email.subject, html: email.html, text: email.text }))
            .messageId,
      };
    }

    case 'SMS': {
      const user = await recipientOf(ctx, job);
      if (!user) return { skip: 'no recipient' };
      if (!job.ticketId) return { skip: 'no ticket' };
      const t = requireTicket(await loadTicketFacts(ctx.prisma, job.ticketId));
      assertP1Open(t, job);
      const to = normalizeE164(user.phone);
      if (!to) return { skip: 'the recipient has no international (E.164) phone number' };
      // D11: at most N texts per number per rolling hour, of which one organisation's P1s may
      // use a quarter; email / in-app still go.
      const cap = await ctx.smsCap.reserve(to, job.dedupeKey, t.orgId);
      if (cap === 'number-cap') {
        return { skip: 'SMS cap reached for this number (SMS_MAX_PER_RECIPIENT_PER_HOUR)' };
      }
      if (cap === 'scope-cap') {
        return { skip: "SMS cap reached for this organisation's P1s to this number" };
      }
      const body = buildSmsText({
        locale: user.locale,
        ticketNumber: t.number,
        priority: t.priority,
        teamName: { en: t.team.nameEn, ar: t.team.nameAr },
        categoryName: { en: t.category.labelEn, ar: t.category.labelAr },
        url: ticketLinks(ctx.appUrl, t.number).consoleUrl,
      });
      return { send: async () => (await ctx.sms.send({ to, body })).messageId };
    }

    case 'TEAMS': {
      if (!job.ticketId) return { skip: 'no ticket' };
      const t = requireTicket(await loadTicketFacts(ctx.prisma, job.ticketId));
      assertP1Open(t, job);
      const links = ticketLinks(ctx.appUrl, t.number);
      const calendar = await ctx.ticketConfig.getCalendar();
      const escalated = job.template === 'P1_ESCALATED';
      const message = buildTeamsCard({
        kind: escalated ? 'P1_ESCALATED' : 'P1_CREATED',
        ticketNumber: t.number,
        subject: t.subject,
        priority: t.priority,
        teamName: { en: t.team.nameEn, ar: t.team.nameAr },
        orgName: { en: t.org.name, ar: t.org.nameAr },
        categoryName: { en: t.category.labelEn, ar: t.category.labelAr },
        subtypeName: t.subtype ? { en: t.subtype.labelEn, ar: t.subtype.labelAr } : null,
        step: job.context.step ?? 1,
        stepCount: job.context.stepCount ?? null,
        minutesUnacknowledged: escalated
          ? Math.round(minutesBetween(t.p1Since ?? t.createdAt, ctx.now()))
          : null,
        raisedAt: t.createdAt,
        timeZone: calendar.timeZone,
        ticketUrl: links.consoleUrl,
        ackUrl: links.ackUrl,
      });
      return {
        send: async () => {
          const result = await ctx.teams.post({ webhookUrl: t.team.teamsWebhookUrl, message });
          if (result.status === 'skipped') throw new Skip(result.reason);
          return result.messageId;
        },
      };
    }
  }
}

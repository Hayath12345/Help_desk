import type { Locale } from '@loons/shared';

// Built-in text for each transactional email. Arabic text never uses the Latin product name: it
// says مكتب دعم لونز (Loons Help Desk) or دعم لونز (Loons Support), as the seed and the app do; the
// Latin wordmark only appears in the layout (theme.ts brand/footer). The admin panel edits the
// `EmailTemplate` rows (subject/body, EN + AR); these defaults are used when a row is missing or
// inactive. CTA labels, the CTA target, the audience and the surface are part of the layout and
// stay in code.
//
// The ticket templates are copies of the seeded rows (packages/db/prisma/seed-data/
// email-templates.ts): `seed-parity.test.ts` fails when the two drift apart.

export const AUTH_EMAIL_TEMPLATE_KEYS = [
  'PASSWORD_RESET',
  'EMAIL_VERIFICATION',
  'GOOGLE_LINKED',
] as const;

/** Ticket notification templates (Phase 3), in the seed's order. */
export const TICKET_EMAIL_TEMPLATE_KEYS = [
  'TICKET_CREATED_CLIENT',
  'TICKET_CREATED_TEAM',
  'AGENT_REPLY_CLIENT',
  'CLIENT_REPLY_ASSIGNEE',
  'SLA_AT_RISK',
  'SLA_BREACHED',
  'P1_ALERT',
  'P1_ESCALATION',
  'P4_DAILY_DIGEST',
] as const;

export const EMAIL_TEMPLATE_KEYS = [
  ...AUTH_EMAIL_TEMPLATE_KEYS,
  ...TICKET_EMAIL_TEMPLATE_KEYS,
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];
export type TicketEmailTemplateKey = (typeof TICKET_EMAIL_TEMPLATE_KEYS)[number];

/** Variables whose value is the CTA button target (app-built links, see LINK_VARIABLES). */
export type CtaUrlVariable =
  'resetUrl' | 'verifyUrl' | 'signInUrl' | 'portalUrl' | 'consoleUrl' | 'ackUrl' | 'queueUrl';

/**
 * Who reads the email: one `user` (greeted by `{{name}}`, in their `User.locale`) or a team
 * distribution `list` (no personal greeting, English per D7).
 */
export type TemplateAudience = 'user' | 'list';

/** Where the recipient reads the full ticket: clients in the portal, staff in the console. */
export type TemplateSurface = 'portal' | 'console';

export interface EmailTemplateText {
  subjectEn: string;
  bodyEn: string;
  subjectAr: string;
  bodyAr: string;
}

export interface DefaultEmailTemplate extends EmailTemplateText {
  key: EmailTemplateKey;
  /** Placeholders the sender provides (shown to admins in the template editor). */
  variables: readonly string[];
  ctaEn?: string;
  ctaAr?: string;
  /** The variable that holds the CTA button's URL. */
  ctaUrlVariable: CtaUrlVariable;
  audience: TemplateAudience;
  /** Ticket templates only: the app named by the "view the full message in …" line. */
  surface?: TemplateSurface;
}

const lines = (...parts: string[]): string => parts.join('\n');

export const DEFAULT_EMAIL_TEMPLATES: Readonly<Record<EmailTemplateKey, DefaultEmailTemplate>> = {
  PASSWORD_RESET: {
    key: 'PASSWORD_RESET',
    variables: ['name', 'resetUrl', 'expiresMinutes'],
    subjectEn: 'Reset your Loons Help Desk password',
    bodyEn: [
      'Hi {{name}},',
      'We received a request to reset the password for your Loons Help Desk account. Use the button below to choose a new password. The link expires in {{expiresMinutes}} minutes and can only be used once.',
      "If you didn't ask for this, you can safely ignore this email — your password won't change.",
    ].join('\n\n'),
    subjectAr: 'إعادة تعيين كلمة المرور لحسابك في مكتب دعم لونز',
    bodyAr: [
      'مرحباً {{name}}،',
      'تلقّينا طلباً لإعادة تعيين كلمة المرور لحسابك في مكتب دعم لونز. استخدم الزر أدناه لاختيار كلمة مرور جديدة. تنتهي صلاحية الرابط خلال {{expiresMinutes}} دقيقة ويمكن استخدامه مرة واحدة فقط.',
      'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان ولن تتغير كلمة المرور.',
    ].join('\n\n'),
    ctaEn: 'Reset password',
    ctaAr: 'إعادة تعيين كلمة المرور',
    ctaUrlVariable: 'resetUrl',
    audience: 'user',
  },
  EMAIL_VERIFICATION: {
    key: 'EMAIL_VERIFICATION',
    variables: ['name', 'verifyUrl', 'expiresHours'],
    subjectEn: 'Confirm your email address for Loons Help Desk',
    bodyEn: [
      'Hi {{name}},',
      'Thanks for signing up for Loons Help Desk. Use the button below to confirm your email address and finish setting up your account. The link expires in {{expiresHours}} hours and can only be used once.',
      "If you didn't create an account, you can safely ignore this email.",
    ].join('\n\n'),
    subjectAr: 'تأكيد بريدك الإلكتروني في مكتب دعم لونز',
    bodyAr: [
      'مرحباً {{name}}،',
      'شكراً لتسجيلك في مكتب دعم لونز. استخدم الزر أدناه لتأكيد بريدك الإلكتروني وإكمال إعداد حسابك. تنتهي صلاحية الرابط خلال {{expiresHours}} ساعة ويمكن استخدامه مرة واحدة فقط.',
      'إذا لم تنشئ حساباً، يمكنك تجاهل هذه الرسالة بأمان.',
    ].join('\n\n'),
    ctaEn: 'Confirm email address',
    ctaAr: 'تأكيد البريد الإلكتروني',
    ctaUrlVariable: 'verifyUrl',
    audience: 'user',
  },
  // Sent when Google is first linked to an account that had a password: the password is removed
  // and every other session signed out (whoever chose that password may not own the mailbox).
  GOOGLE_LINKED: {
    key: 'GOOGLE_LINKED',
    variables: ['name', 'signInUrl'],
    subjectEn: 'Google sign-in was added to your Loons Help Desk account',
    bodyEn: [
      'Hi {{name}},',
      'Google sign-in was just added to your Loons Help Desk account. To keep your account safe, we removed its password and signed out all other sessions.',
      'From now on, sign in with “Continue with Google”. To use a password again, choose “Forgot password?” on the sign-in page and set a new one.',
      "If you didn't add Google sign-in, contact Loons Support right away.",
    ].join('\n\n'),
    subjectAr: 'تمت إضافة تسجيل الدخول عبر Google إلى حسابك في مكتب دعم لونز',
    bodyAr: [
      'مرحباً {{name}}،',
      'تمت للتو إضافة تسجيل الدخول عبر Google إلى حسابك في مكتب دعم لونز. وحفاظاً على أمان حسابك، أزلنا كلمة مروره وسجّلنا الخروج من جميع الجلسات الأخرى.',
      'من الآن فصاعداً، سجّل الدخول باستخدام «المتابعة باستخدام Google». ولاستخدام كلمة مرور مجدداً، اختر «نسيت كلمة المرور؟» في صفحة تسجيل الدخول وعيّن كلمة مرور جديدة.',
      'إذا لم تُضِف تسجيل الدخول عبر Google بنفسك، فتواصل مع دعم لونز فوراً.',
    ].join('\n\n'),
    ctaEn: 'Sign in',
    ctaAr: 'تسجيل الدخول',
    ctaUrlVariable: 'signInUrl',
    audience: 'user',
  },

  // ---- Ticket notifications (Phase 3). Text = the seeded rows, verbatim. ----

  TICKET_CREATED_CLIENT: {
    key: 'TICKET_CREATED_CLIENT',
    variables: [
      'name',
      'ticketNumber',
      'ticketSubject',
      'priority',
      'teamName',
      'targetResponse',
      'portalUrl',
      'socPhone',
    ],
    subjectEn: '[{{ticketNumber}}] We’ve received your request — {{ticketSubject}}',
    bodyEn: lines(
      'Hi {{name}},',
      '',
      'Thank you for contacting Loons Support. We’ve logged your request as {{ticketNumber}} — “{{ticketSubject}}” — with priority {{priority}} and routed it to our {{teamName}} team.',
      '',
      'Target first response: {{targetResponse}}.',
      '',
      'You can follow progress, add details or attachments and reply at any time from the portal:',
      '{{portalUrl}}',
      '',
      'For a critical security incident, please also call our 24/7 SOC line on {{socPhone}}.',
      '',
      'Loons Support',
    ),
    subjectAr: '[{{ticketNumber}}] تم استلام طلبك — {{ticketSubject}}',
    bodyAr: lines(
      'مرحبًا {{name}}،',
      '',
      'شكرًا لتواصلك مع دعم لونز. سجّلنا طلبك برقم {{ticketNumber}} — «{{ticketSubject}}» — بأولوية {{priority}}، وتم توجيهه إلى فريق {{teamName}}.',
      '',
      'هدف الرد الأول: {{targetResponse}}.',
      '',
      'يمكنك متابعة التقدم وإضافة التفاصيل أو المرفقات والرد في أي وقت عبر البوابة:',
      '{{portalUrl}}',
      '',
      'في حالة الحوادث الأمنية الحرجة، يُرجى أيضًا الاتصال بخط مركز العمليات الأمنية (SOC) المتاح على مدار الساعة على الرقم {{socPhone}}.',
      '',
      'دعم لونز',
    ),
    ctaEn: 'View your request',
    ctaAr: 'عرض طلبك',
    ctaUrlVariable: 'portalUrl',
    audience: 'user',
    surface: 'portal',
  },
  TICKET_CREATED_TEAM: {
    key: 'TICKET_CREATED_TEAM',
    variables: [
      'teamName',
      'ticketNumber',
      'ticketSubject',
      'ticketType',
      'priority',
      'categoryName',
      'subtypeName',
      'orgName',
      'requesterName',
      'siteName',
      'assetId',
      'firstReplyDueAt',
      'description',
      'consoleUrl',
    ],
    subjectEn: '[{{ticketNumber}}] New {{priority}} ticket for {{teamName}} — {{ticketSubject}}',
    bodyEn: lines(
      'A new ticket has been routed to {{teamName}}.',
      '',
      'Ticket: {{ticketNumber}} — {{ticketSubject}}',
      'Type: {{ticketType}}',
      'Priority: {{priority}}',
      'Category: {{categoryName}} › {{subtypeName}}',
      'Client: {{orgName}} ({{requesterName}})',
      'Site: {{siteName}}',
      'Asset: {{assetId}}',
      'First reply due: {{firstReplyDueAt}}',
      '',
      '{{description}}',
      '',
      'Open it in the console:',
      '{{consoleUrl}}',
    ),
    subjectAr: '[{{ticketNumber}}] تذكرة {{priority}} جديدة لفريق {{teamName}} — {{ticketSubject}}',
    bodyAr: lines(
      'تم توجيه تذكرة جديدة إلى فريق {{teamName}}.',
      '',
      'التذكرة: {{ticketNumber}} — {{ticketSubject}}',
      'النوع: {{ticketType}}',
      'الأولوية: {{priority}}',
      'الفئة: {{categoryName}} › {{subtypeName}}',
      'العميل: {{orgName}} ({{requesterName}})',
      'الموقع: {{siteName}}',
      'رقم الأصل: {{assetId}}',
      'موعد الرد الأول: {{firstReplyDueAt}}',
      '',
      '{{description}}',
      '',
      'افتحها في وحدة التحكم:',
      '{{consoleUrl}}',
    ),
    ctaEn: 'Open in the console',
    ctaAr: 'فتح في وحدة التحكم',
    ctaUrlVariable: 'consoleUrl',
    audience: 'list',
    surface: 'console',
  },
  AGENT_REPLY_CLIENT: {
    key: 'AGENT_REPLY_CLIENT',
    variables: ['name', 'agentName', 'ticketNumber', 'ticketSubject', 'messageBody', 'portalUrl'],
    subjectEn: '[{{ticketNumber}}] New reply from Loons Support — {{ticketSubject}}',
    bodyEn: lines(
      'Hi {{name}},',
      '',
      '{{agentName}} replied to your ticket {{ticketNumber}}:',
      '',
      '{{messageBody}}',
      '',
      'To reply, open the ticket in the portal:',
      '{{portalUrl}}',
      '',
      'Loons Support',
    ),
    subjectAr: '[{{ticketNumber}}] رد جديد من دعم لونز — {{ticketSubject}}',
    bodyAr: lines(
      'مرحبًا {{name}}،',
      '',
      'ردّ {{agentName}} على تذكرتك {{ticketNumber}}:',
      '',
      '{{messageBody}}',
      '',
      'للرد، افتح التذكرة في البوابة:',
      '{{portalUrl}}',
      '',
      'دعم لونز',
    ),
    ctaEn: 'Reply in the portal',
    ctaAr: 'الرد عبر البوابة',
    ctaUrlVariable: 'portalUrl',
    audience: 'user',
    surface: 'portal',
  },
  CLIENT_REPLY_ASSIGNEE: {
    key: 'CLIENT_REPLY_ASSIGNEE',
    variables: [
      'name',
      'requesterName',
      'orgName',
      'ticketNumber',
      'ticketSubject',
      'messageBody',
      'ticketStatus',
      'consoleUrl',
    ],
    subjectEn: '[{{ticketNumber}}] {{requesterName}} replied — {{ticketSubject}}',
    bodyEn: lines(
      'Hi {{name}},',
      '',
      '{{requesterName}} ({{orgName}}) replied on {{ticketNumber}}:',
      '',
      '{{messageBody}}',
      '',
      'Status: {{ticketStatus}}',
      '',
      'Open it in the console:',
      '{{consoleUrl}}',
    ),
    subjectAr: '[{{ticketNumber}}] ردّ {{requesterName}} — {{ticketSubject}}',
    bodyAr: lines(
      'مرحبًا {{name}}،',
      '',
      'ردّ {{requesterName}} ({{orgName}}) على التذكرة {{ticketNumber}}:',
      '',
      '{{messageBody}}',
      '',
      'الحالة: {{ticketStatus}}',
      '',
      'افتحها في وحدة التحكم:',
      '{{consoleUrl}}',
    ),
    ctaEn: 'Open ticket',
    ctaAr: 'فتح التذكرة',
    ctaUrlVariable: 'consoleUrl',
    // To the assignee; an unassigned ticket goes to the team list instead (D6): render with
    // `audience: 'list'` then, which drops the "Hi {{name}}," line.
    audience: 'user',
    surface: 'console',
  },
  SLA_AT_RISK: {
    key: 'SLA_AT_RISK',
    variables: [
      'name',
      'ticketNumber',
      'ticketSubject',
      'priority',
      'teamName',
      'assigneeName',
      'slaTarget',
      'dueAt',
      'timeRemaining',
      'consoleUrl',
    ],
    subjectEn: '[{{ticketNumber}}] SLA at risk — {{slaTarget}} due {{dueAt}}',
    bodyEn: lines(
      'Hi {{name}},',
      '',
      'The {{slaTarget}} target for {{ticketNumber}} — {{ticketSubject}} — is at risk.',
      '',
      'Priority: {{priority}}',
      'Team: {{teamName}}',
      'Assignee: {{assigneeName}}',
      'Due: {{dueAt}} ({{timeRemaining}} left)',
      '',
      'Open it in the console:',
      '{{consoleUrl}}',
    ),
    subjectAr: '[{{ticketNumber}}] مهلة الخدمة معرضة للخطر — {{slaTarget}} مستحق في {{dueAt}}',
    bodyAr: lines(
      'مرحبًا {{name}}،',
      '',
      'هدف {{slaTarget}} للتذكرة {{ticketNumber}} — {{ticketSubject}} — معرّض للخطر.',
      '',
      'الأولوية: {{priority}}',
      'الفريق: {{teamName}}',
      'المسؤول: {{assigneeName}}',
      'الموعد: {{dueAt}} (متبقٍ {{timeRemaining}})',
      '',
      'افتحها في وحدة التحكم:',
      '{{consoleUrl}}',
    ),
    ctaEn: 'Open ticket',
    ctaAr: 'فتح التذكرة',
    ctaUrlVariable: 'consoleUrl',
    audience: 'user',
    surface: 'console',
  },
  SLA_BREACHED: {
    key: 'SLA_BREACHED',
    variables: [
      'name',
      'ticketNumber',
      'ticketSubject',
      'priority',
      'teamName',
      'assigneeName',
      'slaTarget',
      'dueAt',
      'overdueBy',
      'consoleUrl',
    ],
    subjectEn: '[{{ticketNumber}}] SLA breached — {{slaTarget}} overdue',
    bodyEn: lines(
      'Hi {{name}},',
      '',
      'The {{slaTarget}} target for {{ticketNumber}} — {{ticketSubject}} — has been breached.',
      '',
      'Priority: {{priority}}',
      'Team: {{teamName}}',
      'Assignee: {{assigneeName}}',
      'Was due: {{dueAt}} (overdue by {{overdueBy}})',
      '',
      'Please act on it now:',
      '{{consoleUrl}}',
    ),
    subjectAr: '[{{ticketNumber}}] تجاوز مهلة الخدمة — {{slaTarget}} متأخر',
    bodyAr: lines(
      'مرحبًا {{name}}،',
      '',
      'تم تجاوز هدف {{slaTarget}} للتذكرة {{ticketNumber}} — {{ticketSubject}}.',
      '',
      'الأولوية: {{priority}}',
      'الفريق: {{teamName}}',
      'المسؤول: {{assigneeName}}',
      'كان مستحقًا في: {{dueAt}} (متأخر بمقدار {{overdueBy}})',
      '',
      'يُرجى اتخاذ إجراء الآن:',
      '{{consoleUrl}}',
    ),
    ctaEn: 'Open ticket',
    ctaAr: 'فتح التذكرة',
    ctaUrlVariable: 'consoleUrl',
    audience: 'user',
    surface: 'console',
  },
  P1_ALERT: {
    key: 'P1_ALERT',
    variables: [
      'name',
      'ticketNumber',
      'ticketSubject',
      'teamName',
      'orgName',
      'requesterName',
      'siteName',
      'assetId',
      'categoryName',
      'subtypeName',
      'createdAt',
      'description',
      'ackUrl',
      'escalationDelay',
    ],
    subjectEn: 'P1 CRITICAL [{{ticketNumber}}] {{ticketSubject}} — {{orgName}}',
    bodyEn: lines(
      'Hi {{name}},',
      '',
      'A P1 critical ticket has been raised for {{teamName}} and needs acknowledgement now.',
      '',
      'Ticket: {{ticketNumber}} — {{ticketSubject}}',
      'Client: {{orgName}} ({{requesterName}})',
      'Site: {{siteName}}',
      'Asset: {{assetId}}',
      'Category: {{categoryName}} › {{subtypeName}}',
      'Raised: {{createdAt}}',
      '',
      '{{description}}',
      '',
      'Acknowledge in the console: {{ackUrl}}',
      '',
      'If nobody acknowledges within {{escalationDelay}}, the ticket escalates automatically to the next contact.',
    ),
    subjectAr: 'P1 حرجة [{{ticketNumber}}] {{ticketSubject}} — {{orgName}}',
    bodyAr: lines(
      'مرحبًا {{name}}،',
      '',
      'تم فتح تذكرة حرجة (P1) لفريق {{teamName}} وتحتاج إلى تأكيد الاستلام الآن.',
      '',
      'التذكرة: {{ticketNumber}} — {{ticketSubject}}',
      'العميل: {{orgName}} ({{requesterName}})',
      'الموقع: {{siteName}}',
      'رقم الأصل: {{assetId}}',
      'الفئة: {{categoryName}} › {{subtypeName}}',
      'وقت الفتح: {{createdAt}}',
      '',
      '{{description}}',
      '',
      'تأكيد الاستلام في وحدة التحكم: {{ackUrl}}',
      '',
      'إذا لم يؤكد أحد الاستلام خلال {{escalationDelay}}، تُصعَّد التذكرة تلقائيًا إلى جهة الاتصال التالية.',
    ),
    // ackUrl opens the console (D5): the button never acknowledges by itself.
    ctaEn: 'Acknowledge',
    ctaAr: 'تأكيد الاستلام',
    ctaUrlVariable: 'ackUrl',
    audience: 'user',
    surface: 'console',
  },
  P1_ESCALATION: {
    key: 'P1_ESCALATION',
    variables: [
      'name',
      'step',
      'ticketNumber',
      'ticketSubject',
      'unacknowledgedFor',
      'orgName',
      'siteName',
      'teamName',
      'assigneeName',
      'ackUrl',
    ],
    subjectEn:
      'ESCALATION (step {{step}}) — P1 [{{ticketNumber}}] unacknowledged for {{unacknowledgedFor}}',
    bodyEn: lines(
      'Hi {{name}},',
      '',
      'P1 ticket {{ticketNumber}} — {{ticketSubject}} — has not been acknowledged after {{unacknowledgedFor}} and has been escalated to you (step {{step}}).',
      '',
      'Client: {{orgName}}',
      'Site: {{siteName}}',
      'Team: {{teamName}}',
      'Assignee: {{assigneeName}}',
      '',
      'Acknowledge in the console: {{ackUrl}}',
    ),
    subjectAr:
      'تصعيد (الخطوة {{step}}) — P1 [{{ticketNumber}}] دون تأكيد استلام منذ {{unacknowledgedFor}}',
    bodyAr: lines(
      'مرحبًا {{name}}،',
      '',
      'لم يتم تأكيد استلام التذكرة الحرجة {{ticketNumber}} — {{ticketSubject}} — بعد مرور {{unacknowledgedFor}}، وتم تصعيدها إليك (الخطوة {{step}}).',
      '',
      'العميل: {{orgName}}',
      'الموقع: {{siteName}}',
      'الفريق: {{teamName}}',
      'المسؤول: {{assigneeName}}',
      '',
      'تأكيد الاستلام في وحدة التحكم: {{ackUrl}}',
    ),
    ctaEn: 'Acknowledge',
    ctaAr: 'تأكيد الاستلام',
    ctaUrlVariable: 'ackUrl',
    audience: 'user',
    surface: 'console',
  },
  P4_DAILY_DIGEST: {
    key: 'P4_DAILY_DIGEST',
    variables: ['teamName', 'ticketCount', 'digestDate', 'ticketList', 'queueUrl'],
    subjectEn: '{{teamName}} daily digest — {{ticketCount}} new P4 tickets ({{digestDate}})',
    bodyEn: lines(
      'Hello {{teamName}} team,',
      '',
      '{{ticketCount}} new low-priority (P4) tickets were routed to you since the last digest:',
      '',
      '{{ticketList}}',
      '',
      'Open the team queue:',
      '{{queueUrl}}',
    ),
    subjectAr:
      'الملخص اليومي لفريق {{teamName}} — تذاكر P4 جديدة: {{ticketCount}} ({{digestDate}})',
    bodyAr: lines(
      'مرحبًا فريق {{teamName}}،',
      '',
      'عدد التذاكر الجديدة منخفضة الأولوية (P4) التي وُجّهت إليكم منذ الملخص السابق: {{ticketCount}}',
      '',
      '{{ticketList}}',
      '',
      'افتح قائمة الفريق:',
      '{{queueUrl}}',
    ),
    ctaEn: 'Open the team queue',
    ctaAr: 'فتح قائمة الفريق',
    ctaUrlVariable: 'queueUrl',
    audience: 'list',
    surface: 'console',
  },
};

export function isEmailTemplateKey(value: string): value is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export interface LocalizedTemplateText {
  /** The language actually used (Arabic falls back to English when its text is empty). */
  locale: Locale;
  subject: string;
  body: string;
}

/** Picks the subject/body for `locale`, falling back to English when the Arabic text is empty. */
export function pickTemplateText(
  template: EmailTemplateText,
  locale: Locale,
): LocalizedTemplateText {
  if (locale === 'ar' && template.subjectAr.trim() !== '' && template.bodyAr.trim() !== '') {
    return { locale: 'ar', subject: template.subjectAr, body: template.bodyAr };
  }
  return { locale: 'en', subject: template.subjectEn, body: template.bodyEn };
}

/** CTA label of a built-in template in the given language. */
export function defaultCtaLabel(key: EmailTemplateKey, locale: Locale): string | undefined {
  const template = DEFAULT_EMAIL_TEMPLATES[key];
  return locale === 'ar' ? (template.ctaAr ?? template.ctaEn) : template.ctaEn;
}

// An in-memory stand-in for the ticket API, used by the console tests (and handy for local
// previews): tickets, threads, counts, macros, teams and config shaped exactly like the shared
// contract DTOs, with the list filters / SLA sort / status rules of docs/PHASE2_CONTRACT.md.
// Not imported by application code.

import {
  formatTicketNumber,
  isActiveStatus,
  isSlaAtRiskOrBreached,
  parseTicketNumber,
  statusAfterMessage,
  type AcknowledgeTicketResponse,
  type CreateMessageInput,
  type FormContext,
  type MacroDto,
  type MessageDto,
  type Priority,
  type StaffView,
  type TeamWithMembers,
  type TicketCounts,
  type TicketDetailDto,
  type TicketFormConfig,
  type TicketList,
  type TicketStatus,
  type TicketSummaryDto,
  type UpdateTicketInput,
} from '@loons/shared';
import { ApiRequestError } from '@/lib/api/errors';
import { toSummary } from '@/lib/tickets/cache';
import type { TicketListFilters } from '@/lib/tickets/keys';
import { FORM_CONFIG, fixtureId } from '@/lib/tickets/test-fixtures';
import type { Viewer } from '@/lib/tickets/types';

const MIN = 60_000;

const team = (n: number, key: string, nameEn: string, nameAr: string) => ({
  id: fixtureId(100 + n),
  key,
  nameEn,
  nameAr,
});

export const WORLD_TEAMS = {
  soc: team(1, 'soc', 'SOC', 'مركز العمليات الأمنية'),
  elv: team(2, 'elv', 'ELV Field', 'الأنظمة منخفضة الجهد'),
  triage: team(3, 'triage', 'Triage', 'الفرز'),
  noc: team(4, 'noc', 'NOC', 'مركز عمليات الشبكة'),
  av: team(5, 'av', 'AV', 'الصوت والصورة'),
  am: team(6, 'am', 'Account Management', 'إدارة الحسابات'),
};

export const WORLD_PEOPLE = {
  maya: { id: fixtureId(801), name: 'Maya Ruiz', role: 'AGENT' as const },
  theo: { id: fixtureId(802), name: 'Theo Kim', role: 'AGENT' as const },
  priya: { id: fixtureId(803), name: 'Priya Shah', role: 'AGENT' as const },
  rashid: { id: fixtureId(804), name: 'Rashid Hamdan', role: 'AGENT' as const },
  lina: { id: fixtureId(805), name: 'Lina Haddad', role: 'AGENT' as const },
};

const ORGS = {
  hmc: {
    id: fixtureId(601),
    name: 'Hamad Medical Corporation',
    nameAr: 'مؤسسة حمد الطبية',
    contractType: 'AMC' as const,
    amcExpiry: '2026-12-31',
    manager: WORLD_PEOPLE.rashid,
    sites: [
      { id: fixtureId(701), name: 'HMC – Building 3, Level 2', nameAr: null },
      { id: fixtureId(702), name: 'HMC – Heart Hospital, Ground Floor', nameAr: null },
      { id: fixtureId(703), name: 'HMC – All sites', nameAr: null },
    ],
  },
  qnb: {
    id: fixtureId(602),
    name: 'QNB',
    nameAr: null,
    contractType: 'AMC' as const,
    amcExpiry: '2027-06-30',
    manager: WORLD_PEOPLE.lina,
    sites: [
      { id: fixtureId(711), name: 'QNB – Head Office, West Bay', nameAr: null },
      { id: fixtureId(712), name: 'QNB West Bay Branch', nameAr: null },
      { id: fixtureId(713), name: 'QNB – Data Centre, Lusail', nameAr: null },
    ],
  },
  ooredoo: {
    id: fixtureId(603),
    name: 'Ooredoo',
    nameAr: 'أريدُ',
    contractType: 'BILLABLE' as const,
    amcExpiry: null,
    manager: WORLD_PEOPLE.rashid,
    sites: [
      { id: fixtureId(721), name: 'Ooredoo Tower – Main Lobby', nameAr: null },
      { id: fixtureId(722), name: 'Ooredoo Tower – Level 12', nameAr: null },
    ],
  },
  moi: {
    id: fixtureId(604),
    name: 'Ministry of Interior',
    nameAr: 'وزارة الداخلية',
    contractType: 'AMC' as const,
    amcExpiry: '2027-03-31',
    manager: WORLD_PEOPLE.lina,
    sites: [
      { id: fixtureId(731), name: 'MOI – HQ, Al Dafna', nameAr: null },
      { id: fixtureId(732), name: 'MOI – Conference Wing, Level 1', nameAr: null },
    ],
  },
};
type OrgKey = keyof typeof ORGS;

const REQUESTERS = {
  aisha: {
    id: fixtureId(501),
    name: 'Dr. Aisha Al-Kuwari',
    email: 'aisha.alkuwari@hamad.qa',
    org: 'hmc',
  },
  khalid: {
    id: fixtureId(502),
    name: 'Khalid Al-Mansouri',
    email: 'khalid.mansouri@qnb.com',
    org: 'qnb',
  },
  fatima: {
    id: fixtureId(503),
    name: 'Fatima Al-Sulaiti',
    email: 'f.alsulaiti@ooredoo.qa',
    org: 'ooredoo',
  },
  omar: {
    id: fixtureId(504),
    name: 'Capt. Omar Al-Naimi',
    email: 'o.alnaimi@moi.gov.qa',
    org: 'moi',
  },
} as const satisfies Record<string, { id: string; name: string; email: string; org: OrgKey }>;
type RequesterKey = keyof typeof REQUESTERS;

const sub = (
  n: number,
  key: string,
  labelEn: string,
  labelAr: string,
  defaultPriority: Priority,
) => ({
  id: fixtureId(n),
  key,
  labelEn,
  labelAr,
  defaultPriority,
});

/** FORM_CONFIG plus the categories the demo tickets use. */
export const WORLD_CONFIG: TicketFormConfig = {
  ...FORM_CONFIG,
  categories: [
    ...FORM_CONFIG.categories.filter((c) => c.key !== 'lab'),
    {
      id: fixtureId(205),
      key: 'network',
      labelEn: 'Network & Connectivity',
      labelAr: 'الشبكات والاتصال',
      icon: 'network',
      assetPlaceholder: 'e.g. SW-CORE-02',
      team: WORLD_TEAMS.noc,
      subtypes: [
        sub(341, 'link-down', 'Site / link down', 'انقطاع الموقع / الرابط', 'P1'),
        sub(342, 'slow', 'Slow network / packet loss', 'بطء الشبكة / فقدان الحزم', 'P2'),
      ],
      fields: [],
    },
    {
      id: fixtureId(206),
      key: 'access',
      labelEn: 'Access Control & Intrusion',
      labelAr: 'التحكم في الدخول وكشف التسلل',
      icon: 'door-closed',
      assetPlaceholder: 'e.g. RDR-203',
      team: WORLD_TEAMS.elv,
      subtypes: [
        sub(
          351,
          'turnstile',
          'Turnstile / barrier / gate fault',
          'عطل البوابة الدوارة / الحاجز',
          'P2',
        ),
        sub(352, 'rights', 'Access rights change', 'تغيير صلاحيات الدخول', 'P4'),
      ],
      fields: [],
    },
    {
      id: fixtureId(207),
      key: 'av',
      labelEn: 'Audio Visual',
      labelAr: 'الأنظمة السمعية والبصرية',
      icon: 'projector',
      assetPlaceholder: 'e.g. MR-2.14',
      team: WORLD_TEAMS.av,
      subtypes: [sub(361, 'meeting-room', 'Meeting room AV', 'أنظمة قاعة الاجتماعات', 'P2')],
      fields: [],
    },
    {
      id: fixtureId(208),
      key: 'service',
      labelEn: 'Service Requests & Commercial',
      labelAr: 'طلبات الخدمة والشؤون التجارية',
      icon: 'clipboard-list',
      assetPlaceholder: 'e.g. AMC-2026-018',
      team: WORLD_TEAMS.am,
      subtypes: [
        sub(371, 'ppm', 'Preventive maintenance scheduling', 'جدولة الصيانة الوقائية', 'P4'),
      ],
      fields: [],
    },
  ],
};

export const WORLD_MACROS: MacroDto[] = [
  {
    id: fixtureId(1201),
    key: 'request-photos-video',
    teamId: null,
    titleEn: 'Request photos/video',
    titleAr: 'طلب صور/فيديو',
    bodyEn:
      'Hi {{requesterFirstName}}, could you send a photo or short video of the fault? It helps our engineer bring the right parts.',
    bodyAr:
      'هل يمكنك إرسال صورة أو مقطع فيديو قصير للعطل؟ سيساعد ذلك مهندسنا على إحضار القطع المناسبة.',
    setStatus: null,
  },
  {
    id: fixtureId(1202),
    key: 'engineer-dispatched',
    teamId: null,
    titleEn: 'Engineer dispatched',
    titleAr: 'تم إرسال مهندس',
    bodyEn:
      'Hi {{requesterFirstName}}, an engineer has been dispatched to {{siteName}}. We’ll update you on arrival.',
    bodyAr: 'تم إرسال مهندس إلى {{siteName}}، وسنوافيك بالتحديثات عند وصوله.',
    setStatus: null,
  },
  {
    id: fixtureId(1203),
    key: 'awaiting-client-access',
    teamId: null,
    titleEn: 'Awaiting client access',
    titleAr: 'بانتظار تصريح الدخول',
    bodyEn:
      'Our engineer is on site but waiting for access to {{siteName}}. Could you arrange an escort or access permit?',
    bodyAr:
      'مهندسنا في الموقع بانتظار تصريح الدخول إلى {{siteName}}. هل يمكنك ترتيب مرافق أو تصريح دخول؟',
    setStatus: 'PENDING',
  },
  {
    id: fixtureId(1204),
    key: 'escalate-soc',
    teamId: null,
    titleEn: 'Escalate to SOC',
    titleAr: 'تصعيد إلى SOC',
    bodyEn:
      'Escalating to the Loons SOC for investigation. An analyst will contact you shortly — please don’t power off affected devices.',
    bodyAr:
      'تم تصعيد الطلب إلى مركز العمليات الأمنية لدى لونز. سيتواصل معك أحد المحللين قريبًا — يُرجى عدم إيقاف تشغيل الأجهزة المتأثرة.',
    setStatus: null,
  },
];

export const WORLD_TEAM_LIST: TeamWithMembers[] = [
  { ...WORLD_TEAMS.soc, members: [WORLD_PEOPLE.maya] },
  { ...WORLD_TEAMS.noc, members: [WORLD_PEOPLE.theo] },
  { ...WORLD_TEAMS.elv, members: [WORLD_PEOPLE.priya] },
  { ...WORLD_TEAMS.av, members: [WORLD_PEOPLE.priya] },
  { ...WORLD_TEAMS.am, members: [WORLD_PEOPLE.lina, WORLD_PEOPLE.rashid] },
  { ...WORLD_TEAMS.triage, members: [WORLD_PEOPLE.maya, WORLD_PEOPLE.theo] },
];

interface Seed {
  number: number;
  subject: string;
  requester: RequesterKey;
  category: string;
  subtype: number;
  priority: Priority;
  status: TicketStatus;
  impact: TicketDetailDto['impact'];
  site: number;
  asset: string | null;
  assignee: keyof typeof WORLD_PEOPLE | null;
  /** Minutes until the first reply is due (negative = overdue); null = already replied. */
  firstDueIn: number | null;
  ageMin: number;
  tags: string[];
  type?: TicketDetailDto['type'];
  thread: {
    who: 'client' | keyof typeof WORLD_PEOPLE;
    type?: 'INTERNAL';
    body: string;
    agoMin: number;
  }[];
}

const SEEDS: Seed[] = [
  {
    number: 4817,
    subject: 'Security alert – multiple failed admin logins on firewall',
    requester: 'khalid',
    category: 'cyber',
    subtype: 301,
    priority: 'P1',
    status: 'OPEN',
    impact: 'ENTIRE_SITE',
    site: 711,
    asset: 'FW-01',
    assignee: 'maya',
    firstDueIn: 9,
    ageMin: 6,
    tags: ['firewall', 'brute-force'],
    type: 'SECURITY_INCIDENT',
    thread: [
      {
        who: 'client',
        body: 'Our head-office firewall logged 340 failed admin logins from 3 external IPs in the last 20 minutes. No successful logins so far.',
        agoMin: 6,
      },
      {
        who: 'maya',
        type: 'INTERNAL',
        body: 'Blocked the 3 source IPs at the edge. Pulling SIEM correlation — looks like credential stuffing against the management interface.',
        agoMin: 2,
      },
    ],
  },
  {
    number: 4771,
    subject: 'NVR recording failure – Building 3 cameras not recording',
    requester: 'aisha',
    category: 'cctv',
    subtype: 312,
    priority: 'P1',
    status: 'OPEN',
    impact: 'DEPARTMENT',
    site: 701,
    asset: 'NVR-03',
    assignee: 'priya',
    firstDueIn: -6,
    ageMin: 21,
    tags: ['nvr'],
    thread: [
      {
        who: 'client',
        body: 'Cameras on Building 3, Level 2 show live view but nothing has been recorded since 06:40. Our security team needs footage for an incident this morning.',
        agoMin: 21,
      },
    ],
  },
  {
    number: 4821,
    subject: 'Card reader fault – main lobby turnstile',
    requester: 'fatima',
    category: 'access',
    subtype: 351,
    priority: 'P2',
    status: 'OPEN',
    impact: 'ENTIRE_SITE',
    site: 721,
    asset: 'RDR-203',
    assignee: 'priya',
    firstDueIn: 38,
    ageMin: 22,
    tags: ['turnstile'],
    thread: [
      {
        who: 'client',
        body: 'Turnstile 2 in the main lobby rejects every card. Staff are queueing and security is letting people through manually.',
        agoMin: 22,
      },
    ],
  },
  {
    number: 4809,
    subject: 'Site link down – branch office',
    requester: 'khalid',
    category: 'network',
    subtype: 341,
    priority: 'P1',
    status: 'PENDING',
    impact: 'ENTIRE_SITE',
    site: 712,
    asset: 'RTR-WB-01',
    assignee: 'theo',
    firstDueIn: null,
    ageMin: 70,
    tags: ['fibre'],
    thread: [
      {
        who: 'client',
        body: 'West Bay branch has lost its primary link. Tellers can’t reach core banking.',
        agoMin: 70,
      },
      {
        who: 'theo',
        body: 'Carrier confirms a fibre cut near the branch. Failover to the 4G backup is active and an engineer is on the way — ETA 45 min.',
        agoMin: 58,
      },
    ],
  },
  {
    number: 4790,
    subject: 'Meeting room AV not working',
    requester: 'omar',
    category: 'av',
    subtype: 361,
    priority: 'P3',
    status: 'NEW',
    impact: 'SINGLE_USER',
    site: 732,
    asset: 'MR-1.04',
    assignee: null,
    firstDueIn: 190,
    ageMin: 50,
    tags: [],
    thread: [
      {
        who: 'client',
        body: 'The display in meeting room 1.04 shows “No signal” from both HDMI and wireless casting. Needed for a briefing tomorrow at 09:00.',
        agoMin: 50,
      },
    ],
  },
  {
    number: 4829,
    subject: 'Preventive maintenance scheduling – Q4 CCTV PPM',
    requester: 'aisha',
    category: 'service',
    subtype: 371,
    priority: 'P4',
    status: 'OPEN',
    impact: 'MULTIPLE_SITES',
    site: 703,
    asset: 'AMC-2026-018',
    assignee: null,
    firstDueIn: 20 * 60,
    ageMin: 240,
    tags: ['ppm'],
    type: 'SERVICE_REQUEST',
    thread: [
      {
        who: 'client',
        body: 'Please propose dates for the Q4 CCTV PPM across all HMC sites. Weekends preferred for the Heart Hospital.',
        agoMin: 240,
      },
    ],
  },
  {
    number: 4752,
    subject: 'Access rights change – new ward staff',
    requester: 'aisha',
    category: 'access',
    subtype: 352,
    priority: 'P4',
    status: 'SOLVED',
    impact: 'DEPARTMENT',
    site: 702,
    asset: null,
    assignee: 'priya',
    firstDueIn: null,
    ageMin: 4000,
    tags: [],
    type: 'SERVICE_REQUEST',
    thread: [
      {
        who: 'client',
        body: 'Please grant ward 4 access to the 6 new nurses listed in the attached form.',
        agoMin: 4000,
      },
      {
        who: 'priya',
        body: 'Done — all six cards now open ward 4 and the medication room. Let us know if anyone has trouble.',
        agoMin: 3900,
      },
    ],
  },
];

export interface WorldOptions {
  viewer?: Viewer;
  now?: number;
  /** Extra filler tickets in the NOC queue (pagination tests / previews). */
  extraTickets?: number;
  /** List page size (the API default is 50). */
  pageSize?: number;
}

export interface InboxWorld {
  viewer: Viewer;
  tickets: TicketDetailDto[];
  messages: Map<string, MessageDto[]>;
  listTickets: (filters: TicketListFilters, cursor: string | null) => TicketList;
  counts: () => TicketCounts;
  getTicket: (ref: string) => TicketDetailDto;
  listMessages: (ticketId: string, after?: string | null) => MessageDto[];
  postMessage: (
    ticketId: string,
    input: CreateMessageInput,
  ) => { message: MessageDto; ticket: TicketSummaryDto };
  updateTicket: (ticketId: string, patch: UpdateTicketInput) => TicketDetailDto;
  /** POST /tickets/:id/acknowledge, like the API: idempotent, P1 only (409 otherwise). */
  acknowledge: (ticketId: string) => AcknowledgeTicketResponse;
  formContext: (requesterId: string) => FormContext;
  macros: MacroDto[];
  teams: TeamWithMembers[];
  config: TicketFormConfig;
}

const iso = (ms: number) => new Date(ms).toISOString();

function notFound(): never {
  throw new ApiRequestError(404, 'NOT_FOUND', 'Ticket not found');
}

export function createInboxWorld(options: WorldOptions = {}): InboxWorld {
  const viewer = options.viewer ?? WORLD_PEOPLE.maya;
  const baseNow = options.now ?? Date.now();
  const pageSize = options.pageSize ?? 50;
  const clock = () => options.now ?? Date.now();
  const config = WORLD_CONFIG;
  let messageSeq = 5000;
  const messages = new Map<string, MessageDto[]>();
  const policies = new Map(config.slaPolicies.map((p) => [p.priority, p]));

  const person = (key: keyof typeof WORLD_PEOPLE) => WORLD_PEOPLE[key];

  const build = (seed: Seed, index: number): TicketDetailDto => {
    const id = fixtureId(900 + index);
    const requester = REQUESTERS[seed.requester];
    const org = ORGS[requester.org];
    const category = config.categories.find((c) => c.key === seed.category)!;
    const subtype = category.subtypes.find((s) => s.id === fixtureId(seed.subtype))!;
    const site = org.sites.find((s) => s.id === fixtureId(seed.site)) ?? org.sites[0]!;
    const created = baseNow - seed.ageMin * MIN;
    const policy = policies.get(seed.priority)!;
    const firstReplyDueAt =
      seed.firstDueIn === null
        ? created + policy.firstReplyMins * MIN
        : baseNow + seed.firstDueIn * MIN;
    const replied = seed.firstDueIn === null;
    const resolveDueAt = created + policy.resolveMins * MIN;
    // The API stores the instant at which atRiskPercent of each window has elapsed in SLA time
    // (business minutes for P3/P4); this fake world approximates it in wall-clock time.
    const atRisk = (due: number, windowMins: number) =>
      iso(due - (windowMins * MIN * (100 - policy.atRiskPercent)) / 100);
    const thread = seed.thread.map<MessageDto>((m, i) => {
      const author =
        m.who === 'client'
          ? { id: requester.id, name: requester.name, role: 'CLIENT' as const }
          : person(m.who);
      return {
        id: fixtureId(3000 + index * 20 + i),
        ticketId: id,
        type: m.type ?? 'PUBLIC',
        body: m.body,
        author,
        clientTempId: null,
        attachments: [],
        createdAt: iso(baseNow - m.agoMin * MIN),
      };
    });
    messages.set(id, thread);
    const lastPublic = [...thread].reverse().find((m) => m.type === 'PUBLIC');
    const assignee = seed.assignee ? person(seed.assignee) : null;
    const updated = baseNow - Math.min(seed.ageMin, 30) * MIN;
    return {
      id,
      number: seed.number,
      ref: formatTicketNumber(seed.number),
      subject: seed.subject,
      type: seed.type ?? 'INCIDENT',
      status: seed.status,
      priority: seed.priority,
      impact: seed.impact,
      channel: 'PORTAL',
      category: {
        id: category.id,
        key: category.key,
        labelEn: category.labelEn,
        labelAr: category.labelAr,
        icon: category.icon,
        isActive: true,
      },
      subtype: { ...subtype, isActive: true },
      team: category.team,
      org: { id: org.id, name: org.name, nameAr: org.nameAr },
      site,
      requester: { id: requester.id, name: requester.name, email: requester.email },
      assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
      tags: seed.tags,
      preview: (lastPublic?.body ?? '').replace(/\s+/g, ' ').slice(0, 140),
      firstReplyDueAt: iso(firstReplyDueAt),
      resolveDueAt: iso(resolveDueAt),
      firstReplyAtRiskAt: atRisk(firstReplyDueAt, policy.firstReplyMins),
      resolveAtRiskAt: atRisk(resolveDueAt, policy.resolveMins),
      firstRepliedAt: replied ? iso(created + 10 * MIN) : null,
      solvedAt: seed.status === 'SOLVED' ? iso(baseNow - 3900 * MIN) : null,
      closedAt: null,
      slaBreached: false,
      slaPausedAt: seed.status === 'PENDING' ? iso(baseNow - 58 * MIN) : null,
      p1Since: seed.priority === 'P1' ? iso(created) : null,
      p1EscalationStep: 0,
      p1AckedAt: null,
      p1AckedBy: null,
      lastMessageAt: thread.at(-1)?.createdAt ?? iso(created),
      createdAt: iso(created),
      updatedAt: iso(updated),
      description: seed.thread[0]?.body ?? '',
      assetId: seed.asset,
      customFields: [],
      attachments: [],
      requesterCard: {
        org: {
          id: org.id,
          name: org.name,
          nameAr: org.nameAr,
          contractType: org.contractType,
          amcExpiry: org.amcExpiry,
        },
        accountManager: { id: org.manager.id, name: org.manager.name },
        sitesCount: org.sites.length,
        otherTicketsCount: 0,
      },
      sla: policy,
      // The seeded global chain (D3): on-call at 0, team leads at 5, operations manager at 15.
      p1Chain: [
        { step: 1, afterMins: 0 },
        { step: 2, afterMins: 5 },
        { step: 3, afterMins: 15 },
      ],
    };
  };

  const tickets = SEEDS.map(build);
  for (let i = 0; i < (options.extraTickets ?? 0); i += 1) {
    tickets.push(
      build(
        {
          number: 5000 + i,
          subject: `Switch port flapping on floor ${i + 1}`,
          requester: 'fatima',
          category: 'network',
          subtype: 342,
          priority: 'P3',
          status: 'OPEN',
          impact: 'DEPARTMENT',
          site: 722,
          asset: `SW-${i + 1}`,
          assignee: null,
          firstDueIn: 300 + i * 5,
          ageMin: 30 + i,
          tags: [],
          thread: [{ who: 'client', body: `Port ${i + 1} keeps flapping.`, agoMin: 30 + i }],
        },
        SEEDS.length + i,
      ),
    );
  }
  // Other tickets of the same organisation (requester card).
  for (const ticket of tickets) {
    ticket.requesterCard.otherTicketsCount = tickets.filter(
      (other) => other.id !== ticket.id && other.org.id === ticket.org.id,
    ).length;
  }

  const inView = (ticket: TicketDetailDto, view: StaffView, now: number) => {
    const active = isActiveStatus(ticket.status);
    switch (view) {
      case 'mine':
        return active && ticket.assignee?.id === viewer.id;
      case 'unassigned':
        return active && !ticket.assignee;
      case 'risk':
        return isSlaAtRiskOrBreached(ticket, now);
      case 'p1':
        return active && ticket.priority === 'P1';
      case 'open':
        return active;
      case 'solved':
        return !active;
    }
  };

  const matches = (ticket: TicketDetailDto, search: string) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    const number = parseTicketNumber(term);
    return (
      ticket.subject.toLowerCase().includes(term) ||
      (number !== null && ticket.number === number) ||
      ticket.requester.name.toLowerCase().includes(term) ||
      ticket.requester.email.toLowerCase().includes(term)
    );
  };

  // Mirrors the API's `sla` sort (ticket-query.ts SLA_KEYS): an unanswered PENDING ticket keeps
  // its first-reply clock, so it only counts as paused once the first reply is sent.
  const firstReplyRunning = (t: TicketDetailDto) =>
    t.firstRepliedAt === null && t.firstReplyDueAt !== null;
  const due = (t: TicketDetailDto) =>
    Date.parse((t.firstRepliedAt === null ? t.firstReplyDueAt : null) ?? t.resolveDueAt ?? '') ||
    Infinity;
  const slaKey = (t: TicketDetailDto): [number, number, number, number, number] => [
    isActiveStatus(t.status) ? 0 : 1,
    t.firstRepliedAt === null ? 0 : 1,
    t.status === 'PENDING' && !firstReplyRunning(t) ? 1 : 0,
    due(t),
    Date.parse(t.createdAt),
  ];
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i += 1) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };

  const find = (ref: string) => {
    const number = parseTicketNumber(ref);
    return tickets.find(
      (t) => t.id === ref.toLowerCase() || (number !== null && t.number === number),
    );
  };

  const touch = (ticket: TicketDetailDto) => {
    ticket.updatedAt = iso(Math.max(clock(), Date.parse(ticket.updatedAt) + 1));
  };

  return {
    viewer,
    tickets,
    messages,
    macros: WORLD_MACROS,
    teams: WORLD_TEAM_LIST,
    config,
    listTickets(filters, cursor) {
      const now = clock();
      const rows = tickets
        .filter((t) => !filters.view || inView(t, filters.view, now))
        .filter((t) => !filters.teamId || t.team.id === filters.teamId)
        .filter((t) => matches(t, filters.search ?? ''))
        .sort((a, b) =>
          (filters.sort ?? 'sla') === 'sla'
            ? compare(slaKey(a), slaKey(b))
            : Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        );
      const start = cursor ? Number(cursor) : 0;
      const page = rows.slice(start, start + pageSize);
      const next = start + pageSize < rows.length ? String(start + pageSize) : null;
      return { items: page.map(toSummary), nextCursor: next };
    },
    counts() {
      const now = clock();
      const views = Object.fromEntries(
        (['mine', 'unassigned', 'risk', 'p1', 'open', 'solved'] as const).map((view) => [
          view,
          tickets.filter((t) => inView(t, view, now)).length,
        ]),
      ) as Extract<TicketCounts, { kind: 'staff' }>['views'];
      const teams = Object.values(WORLD_TEAMS)
        .filter((t) => t.key !== 'triage')
        .map((t) => ({
          ...t,
          count: tickets.filter((x) => x.team.id === t.id && isActiveStatus(x.status)).length,
        }));
      return { kind: 'staff', views, teams };
    },
    getTicket(ref) {
      return find(ref) ?? notFound();
    },
    listMessages(ticketId, after) {
      const list = messages.get(ticketId);
      if (!list) notFound();
      if (!after) return [...list];
      const index = list.findIndex((m) => m.id === after);
      return index < 0 ? [...list] : list.slice(index + 1);
    },
    postMessage(ticketId, input) {
      const ticket = find(ticketId) ?? notFound();
      if (ticket.status === 'CLOSED') throw new ApiRequestError(409, 'CONFLICT', 'Closed');
      const list = messages.get(ticket.id) ?? [];
      const existing = list.find((m) => m.clientTempId === input.clientTempId);
      if (existing) return { message: existing, ticket: toSummary(ticket) };
      messageSeq += 1;
      const now = clock();
      const message: MessageDto = {
        id: fixtureId(messageSeq),
        ticketId: ticket.id,
        type: input.type,
        body: input.body.trim(),
        author: { id: viewer.id, name: viewer.name, role: viewer.role },
        clientTempId: input.clientTempId,
        attachments: [],
        createdAt: iso(now),
      };
      list.push(message);
      messages.set(ticket.id, list);
      const next = statusAfterMessage({
        current: ticket.status,
        author: 'staff',
        type: input.type,
        andSolve: input.andSolve,
      });
      if (next) {
        ticket.status = next;
        ticket.solvedAt = next === 'SOLVED' ? iso(now) : null;
        ticket.slaPausedAt = next === 'PENDING' ? iso(now) : null;
      }
      if (input.type === 'PUBLIC') {
        if (!ticket.firstRepliedAt) ticket.firstRepliedAt = iso(now);
        if (!ticket.assignee) ticket.assignee = { id: viewer.id, name: viewer.name };
        ticket.preview = message.body.replace(/\s+/g, ' ').slice(0, 140);
      }
      ticket.lastMessageAt = iso(now);
      touch(ticket);
      return { message, ticket: toSummary(ticket) };
    },
    acknowledge(ticketId) {
      const ticket = find(ticketId) ?? notFound();
      if (ticket.priority !== 'P1') throw new ApiRequestError(409, 'CONFLICT', 'Not a P1');
      if (ticket.p1AckedAt) return { ticket: structuredClone(ticket), alreadyAcknowledged: true };
      ticket.p1AckedAt = iso(clock());
      ticket.p1AckedBy = { id: viewer.id, name: viewer.name };
      touch(ticket);
      return { ticket: structuredClone(ticket), alreadyAcknowledged: false };
    },
    updateTicket(ticketId, patch) {
      const ticket = find(ticketId) ?? notFound();
      if (patch.tags?.includes('fail')) {
        throw new ApiRequestError(422, 'VALIDATION_FAILED', 'Rejected by the test world');
      }
      if (patch.status) {
        ticket.status = patch.status;
        ticket.solvedAt = patch.status === 'SOLVED' ? iso(clock()) : null;
      }
      if (patch.priority) {
        // Like the API: becoming P1 starts a P1 period, leaving P1 ends it.
        if ((patch.priority === 'P1') !== (ticket.priority === 'P1')) {
          ticket.p1Since = patch.priority === 'P1' ? iso(clock()) : null;
          ticket.p1EscalationStep = 0;
          ticket.p1AckedAt = null;
          ticket.p1AckedBy = null;
        }
        ticket.priority = patch.priority;
        ticket.sla = policies.get(patch.priority)!;
      }
      if (patch.impact) ticket.impact = patch.impact;
      if (patch.tags) ticket.tags = [...new Set(patch.tags)];
      if (patch.assigneeId !== undefined) {
        const member = Object.values(WORLD_PEOPLE).find((p) => p.id === patch.assigneeId);
        ticket.assignee = member ? { id: member.id, name: member.name } : null;
      }
      if (patch.categoryId) {
        const category = config.categories.find((c) => c.id === patch.categoryId)!;
        const { id, key, labelEn, labelAr, icon } = category;
        ticket.category = { id, key, labelEn, labelAr, icon, isActive: true };
        ticket.team = category.team;
      }
      if (patch.subtypeId) {
        const subtype = config.categories
          .flatMap((c) => c.subtypes)
          .find((s) => s.id === patch.subtypeId)!;
        ticket.subtype = { ...subtype, isActive: true };
      }
      if (patch.siteId) {
        const site = Object.values(ORGS)
          .flatMap((o) => o.sites)
          .find((s) => s.id === patch.siteId);
        if (site) ticket.site = site;
      }
      if (patch.assetId !== undefined) ticket.assetId = patch.assetId || null;
      touch(ticket);
      return structuredClone(ticket);
    },
    formContext(requesterId) {
      const requester = Object.values(REQUESTERS).find((r) => r.id === requesterId);
      if (!requester) notFound();
      const org = ORGS[requester.org];
      return {
        requester: { id: requester.id, name: requester.name, email: requester.email },
        org: { id: org.id, name: org.name, nameAr: org.nameAr, contractType: org.contractType },
        sites: org.sites,
      };
    },
  };
}

/** Routes an `apiClient` call (method + path with query string) to the world. */
export function worldRequest(
  world: InboxWorld,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): unknown {
  const url = new URL(path, 'http://world.local');
  const q = url.searchParams;
  const parts = url.pathname.split('/').filter(Boolean);
  const clone = <T>(value: T): T => structuredClone(value);
  if (method === 'GET') {
    if (url.pathname === '/config/ticket-form') return clone(world.config);
    if (url.pathname === '/macros') return { items: clone(world.macros) };
    if (url.pathname === '/teams') return { items: clone(world.teams) };
    if (url.pathname === '/tickets/counts') return world.counts();
    if (url.pathname === '/tickets/form-context') {
      return world.formContext(q.get('requesterId') ?? '');
    }
    if (url.pathname === '/tickets') {
      const filters: TicketListFilters = {
        view: (q.get('view') as StaffView | null) ?? undefined,
        teamId: q.get('teamId') ?? undefined,
        search: q.get('search') ?? undefined,
        sort: (q.get('sort') as 'sla' | 'recent' | null) ?? undefined,
      };
      return clone(world.listTickets(filters, q.get('cursor')));
    }
    if (parts[0] === 'tickets' && parts[2] === 'messages') {
      return { items: clone(world.listMessages(parts[1] ?? '', q.get('after'))) };
    }
    if (parts[0] === 'tickets' && parts.length === 2) {
      return { ticket: clone(world.getTicket(decodeURIComponent(parts[1] ?? ''))) };
    }
  }
  if (method === 'POST' && parts[0] === 'tickets' && parts[2] === 'acknowledge') {
    return world.acknowledge(parts[1] ?? '');
  }
  if (method === 'POST' && parts[0] === 'tickets' && parts[2] === 'messages') {
    return clone(world.postMessage(parts[1] ?? '', body as CreateMessageInput));
  }
  if (method === 'PATCH' && parts[0] === 'tickets' && parts.length === 2) {
    return { ticket: world.updateTicket(parts[1] ?? '', body as UpdateTicketInput) };
  }
  throw new ApiRequestError(404, 'NOT_FOUND', `No world route for ${method} ${path}`);
}

// Demo organisations, users and tickets matching the design prototype's seed(). Only seeded outside
// production (see prisma/seed.ts). Timestamps are relative to the moment the seed runs.

import type {
  ContractType,
  Impact,
  Locale,
  Priority,
  Role,
  TeamMemberRole,
  TicketStatus,
  TicketType,
} from '../../src/generated/prisma/enums.ts';
import { utcDate } from './util.ts';

// ───────────────────────────── Staff ─────────────────────────────

export const STAFF_EMAILS = {
  noor: 'noor.alkaabi@loonsgroup.com',
  maya: 'maya.ruiz@loonsgroup.com',
  theo: 'theo.kim@loonsgroup.com',
  priya: 'priya.shah@loonsgroup.com',
  sam: 'sam.okafor@loonsgroup.com',
  rashid: 'rashid.hamdan@loonsgroup.com',
  lina: 'lina.haddad@loonsgroup.com',
  karim: 'karim.nasser@loonsgroup.com',
  hana: 'hana.yousef@loonsgroup.com',
} as const;

/** The SUPER_ADMIN targeted by the last step of the P1 escalation chain. */
export const OPERATIONS_MANAGER_EMAIL = STAFF_EMAILS.noor;

export interface DemoUserSeed {
  email: string;
  name: string;
  role: Role;
  jobTitle: string;
  phone: string;
  locale: Locale;
}

export const DEMO_STAFF: readonly DemoUserSeed[] = [
  {
    email: STAFF_EMAILS.noor,
    name: 'Noor Al-Kaabi',
    role: 'SUPER_ADMIN',
    jobTitle: 'Operations Manager',
    phone: '+974 5550 1000',
    locale: 'en',
  },
  {
    email: STAFF_EMAILS.maya,
    name: 'Maya Ruiz',
    role: 'AGENT',
    jobTitle: 'SOC Analyst',
    phone: '+974 5550 1001',
    locale: 'en',
  },
  {
    email: STAFF_EMAILS.theo,
    name: 'Theo Kim',
    role: 'AGENT',
    jobTitle: 'Network & Data Centre Engineer',
    phone: '+974 5550 1002',
    locale: 'en',
  },
  {
    email: STAFF_EMAILS.priya,
    name: 'Priya Shah',
    role: 'AGENT',
    jobTitle: 'ELV Field Engineer',
    phone: '+974 5550 1003',
    locale: 'en',
  },
  {
    email: STAFF_EMAILS.sam,
    name: 'Sam Okafor',
    role: 'AGENT',
    jobTitle: 'IT Service Desk Engineer',
    phone: '+974 5550 1004',
    locale: 'en',
  },
  {
    email: STAFF_EMAILS.rashid,
    name: 'Rashid Hamdan',
    role: 'AGENT',
    jobTitle: 'Account Manager',
    phone: '+974 5550 1005',
    locale: 'en',
  },
  {
    email: STAFF_EMAILS.lina,
    name: 'Lina Haddad',
    role: 'AGENT',
    jobTitle: 'Account Manager',
    phone: '+974 5550 1006',
    locale: 'en',
  },
  {
    email: STAFF_EMAILS.karim,
    name: 'Karim Nasser',
    role: 'TEAM_LEAD',
    jobTitle: 'Team Lead – SOC & Infrastructure',
    phone: '+974 5550 1007',
    locale: 'en',
  },
  {
    email: STAFF_EMAILS.hana,
    name: 'Hana Yousef',
    role: 'TEAM_LEAD',
    jobTitle: 'Team Lead – Field & Service Operations',
    phone: '+974 5550 1008',
    locale: 'en',
  },
];

export interface DemoTeamStaffing {
  teamKey: string;
  members: ReadonlyArray<{ email: string; role: TeamMemberRole }>;
  onCallEmail: string;
}

const lead = (email: string) => ({ email, role: 'LEAD' as const });
const member = (email: string) => ({ email, role: 'MEMBER' as const });

export const DEMO_TEAM_STAFFING: readonly DemoTeamStaffing[] = [
  {
    teamKey: 'soc',
    members: [member(STAFF_EMAILS.maya), lead(STAFF_EMAILS.karim)],
    onCallEmail: STAFF_EMAILS.maya,
  },
  {
    teamKey: 'noc',
    members: [member(STAFF_EMAILS.theo), lead(STAFF_EMAILS.karim)],
    onCallEmail: STAFF_EMAILS.theo,
  },
  {
    teamKey: 'dcops',
    members: [member(STAFF_EMAILS.theo), lead(STAFF_EMAILS.karim)],
    onCallEmail: STAFF_EMAILS.theo,
  },
  {
    teamKey: 'elv',
    members: [member(STAFF_EMAILS.priya), lead(STAFF_EMAILS.hana)],
    onCallEmail: STAFF_EMAILS.priya,
  },
  {
    teamKey: 'bms',
    members: [member(STAFF_EMAILS.priya), lead(STAFF_EMAILS.hana)],
    onCallEmail: STAFF_EMAILS.priya,
  },
  {
    teamKey: 'av',
    members: [member(STAFF_EMAILS.priya), lead(STAFF_EMAILS.hana)],
    onCallEmail: STAFF_EMAILS.priya,
  },
  {
    teamKey: 'itsd',
    members: [member(STAFF_EMAILS.sam), lead(STAFF_EMAILS.hana)],
    onCallEmail: STAFF_EMAILS.sam,
  },
  {
    teamKey: 'sw',
    members: [member(STAFF_EMAILS.sam), lead(STAFF_EMAILS.hana)],
    onCallEmail: STAFF_EMAILS.sam,
  },
  {
    teamKey: 'triage',
    members: [member(STAFF_EMAILS.sam), lead(STAFF_EMAILS.hana)],
    onCallEmail: STAFF_EMAILS.sam,
  },
  {
    teamKey: 'am',
    members: [member(STAFF_EMAILS.rashid), member(STAFF_EMAILS.lina), lead(STAFF_EMAILS.hana)],
    onCallEmail: STAFF_EMAILS.rashid,
  },
];

// ───────────────────────────── Organisations ─────────────────────────────

export interface DemoSiteSeed {
  key: string;
  name: string;
  nameAr: string;
}

export interface DemoOrgSeed {
  key: string;
  name: string;
  nameAr: string;
  contractType: ContractType;
  /** UTC-midnight date, or null when the contract has no AMC expiry. */
  amcExpiry: Date | null;
  accountManagerEmail: string;
  emailDomains: string[];
  sites: readonly DemoSiteSeed[];
}

export const DEMO_ORGS: readonly DemoOrgSeed[] = [
  {
    key: 'hmc',
    name: 'Hamad Medical Corporation',
    nameAr: 'مؤسسة حمد الطبية',
    contractType: 'AMC',
    amcExpiry: utcDate(2026, 12, 31),
    accountManagerEmail: STAFF_EMAILS.rashid,
    emailDomains: ['hamad.qa'],
    sites: [
      {
        key: 'building-3-level-2',
        name: 'HMC – Building 3, Level 2',
        nameAr: 'حمد الطبية – المبنى 3، الطابق 2',
      },
      {
        key: 'heart-hospital-ground-floor',
        name: 'HMC – Heart Hospital, Ground Floor',
        nameAr: 'حمد الطبية – مستشفى القلب، الطابق الأرضي',
      },
      {
        key: 'womens-wellness-centre',
        name: 'HMC – Women’s Wellness Centre',
        nameAr: 'حمد الطبية – مركز صحة المرأة',
      },
      { key: 'all-sites', name: 'HMC – All sites', nameAr: 'حمد الطبية – جميع المواقع' },
    ],
  },
  {
    key: 'qnb',
    name: 'QNB',
    nameAr: 'بنك قطر الوطني (QNB)',
    contractType: 'AMC',
    amcExpiry: utcDate(2027, 6, 30),
    accountManagerEmail: STAFF_EMAILS.lina,
    emailDomains: ['qnb.com'],
    sites: [
      {
        key: 'head-office-west-bay',
        name: 'QNB – Head Office, West Bay',
        nameAr: 'QNB – المقر الرئيسي، الخليج الغربي',
      },
      { key: 'west-bay-branch', name: 'QNB West Bay Branch', nameAr: 'QNB – فرع الخليج الغربي' },
      {
        key: 'data-centre-lusail',
        name: 'QNB – Data Centre, Lusail',
        nameAr: 'QNB – مركز البيانات، لوسيل',
      },
    ],
  },
  {
    key: 'ooredoo',
    name: 'Ooredoo',
    nameAr: 'أوريدو',
    contractType: 'BILLABLE',
    amcExpiry: null,
    accountManagerEmail: STAFF_EMAILS.rashid,
    emailDomains: ['ooredoo.qa'],
    sites: [
      {
        key: 'tower-main-lobby',
        name: 'Ooredoo Tower – Main Lobby',
        nameAr: 'برج أوريدو – الردهة الرئيسية',
      },
      { key: 'tower-level-12', name: 'Ooredoo Tower – Level 12', nameAr: 'برج أوريدو – الطابق 12' },
      {
        key: 'al-sadd-exchange',
        name: 'Ooredoo – Al Sadd Exchange',
        nameAr: 'أوريدو – مقسم السد',
      },
    ],
  },
  {
    key: 'moi',
    name: 'Ministry of Interior',
    nameAr: 'وزارة الداخلية',
    contractType: 'AMC',
    amcExpiry: utcDate(2027, 3, 31),
    accountManagerEmail: STAFF_EMAILS.lina,
    emailDomains: ['moi.gov.qa'],
    sites: [
      {
        key: 'hq-al-dafna',
        name: 'MOI – HQ, Al Dafna',
        nameAr: 'وزارة الداخلية – المقر الرئيسي، الدفنة',
      },
      {
        key: 'conference-wing-level-1',
        name: 'MOI – Conference Wing, Level 1',
        nameAr: 'وزارة الداخلية – جناح المؤتمرات، الطابق 1',
      },
    ],
  },
];

// ───────────────────────────── Client contacts ─────────────────────────────

export const CLIENT_EMAILS = {
  aisha: 'aisha.alkuwari@hamad.qa',
  khalid: 'khalid.mansouri@qnb.com',
  fatima: 'f.alsulaiti@ooredoo.qa',
  omar: 'o.alnaimi@moi.gov.qa',
} as const;

export interface DemoClientSeed extends DemoUserSeed {
  orgKey: string;
}

export const DEMO_CLIENTS: readonly DemoClientSeed[] = [
  {
    email: CLIENT_EMAILS.aisha,
    name: 'Dr. Aisha Al-Kuwari',
    role: 'CLIENT',
    orgKey: 'hmc',
    jobTitle: 'Head of Security Systems',
    phone: '+974 5551 2001',
    locale: 'en',
  },
  {
    email: CLIENT_EMAILS.khalid,
    name: 'Khalid Al-Mansouri',
    role: 'CLIENT',
    orgKey: 'qnb',
    jobTitle: 'IT Security Manager',
    phone: '+974 5551 2002',
    locale: 'en',
  },
  {
    email: CLIENT_EMAILS.fatima,
    name: 'Fatima Al-Sulaiti',
    role: 'CLIENT',
    orgKey: 'ooredoo',
    jobTitle: 'Facilities Manager',
    phone: '+974 5551 2003',
    locale: 'en',
  },
  {
    email: CLIENT_EMAILS.omar,
    name: 'Capt. Omar Al-Naimi',
    role: 'CLIENT',
    orgKey: 'moi',
    jobTitle: 'Security Systems Officer',
    phone: '+974 5551 2004',
    locale: 'ar',
  },
];

// ───────────────────────────── Tickets ─────────────────────────────

/** Design message kinds: customer → PUBLIC by the requester, agent → PUBLIC by staff, note → INTERNAL. */
export type DemoMessageKind = 'customer' | 'agent' | 'note';

export interface DemoMessageSeed {
  kind: DemoMessageKind;
  /** Staff author for `agent` / `note`; ignored for `customer` (always the requester). */
  authorEmail?: string;
  body: string;
  /** Minutes before the seed ran. */
  agoMin: number;
}

export type DemoActivitySeed =
  | { type: 'P1_ACKNOWLEDGED'; byEmail: string; agoMin: number }
  | { type: 'ASSIGNEE_CHANGED'; byEmail: string; toEmail: string; agoMin: number }
  | {
      type: 'STATUS_CHANGED';
      byEmail: string;
      from: TicketStatus;
      to: TicketStatus;
      agoMin: number;
    }
  | { type: 'TAGS_CHANGED'; byEmail: string; agoMin: number };

export interface DemoTicketSeed {
  number: number;
  subject: string;
  requesterEmail: string;
  type: TicketType;
  categoryKey: string;
  subtypeKey: string;
  priority: Priority;
  impact: Impact;
  orgKey: string;
  siteKey: string;
  assetId: string | null;
  status: TicketStatus;
  assigneeEmail: string | null;
  createdAgoMin: number;
  /**
   * Design `dueIn` for tickets still waiting for a first reply: firstReplyDueAt = now + this.
   * Null for replied tickets (then createdAt + the priority's first-reply minutes).
   */
  firstReplyDueInMin: number | null;
  tags: readonly string[];
  /** Values keyed by CustomField.key; only fields linked to the ticket's category. */
  customFields: Readonly<Record<string, string>>;
  /** Chronological; the first message is the requester's description. */
  messages: readonly DemoMessageSeed[];
  /** Staff actions, turned into TicketEvents (CREATED, FIRST_REPLY and SLA events are derived). */
  activity: readonly DemoActivitySeed[];
}

const { maya, theo, priya, rashid } = STAFF_EMAILS;

export const DEMO_TICKETS: readonly DemoTicketSeed[] = [
  {
    number: 4817,
    subject: 'Security alert – multiple failed admin logins on firewall',
    requesterEmail: CLIENT_EMAILS.khalid,
    type: 'SECURITY_INCIDENT',
    categoryKey: 'cyber',
    subtypeKey: 'security-alert-suspected-incident',
    priority: 'P1',
    impact: 'ENTIRE_SITE',
    orgKey: 'qnb',
    siteKey: 'head-office-west-bay',
    assetId: 'FW-01',
    status: 'OPEN',
    assigneeEmail: maya,
    createdAgoMin: 6,
    firstReplyDueInMin: 9,
    tags: ['firewall', 'brute-force'],
    customFields: {},
    messages: [
      {
        kind: 'customer',
        body: 'Our head-office firewall logged 340 failed admin logins from 3 external IPs in the last 20 minutes. No successful logins so far.',
        agoMin: 6,
      },
      {
        kind: 'note',
        authorEmail: maya,
        body: 'Blocked the 3 source IPs at the edge. Pulling SIEM correlation — looks like credential stuffing against the management interface.',
        agoMin: 2,
      },
    ],
    activity: [
      { type: 'P1_ACKNOWLEDGED', byEmail: maya, agoMin: 5 },
      { type: 'ASSIGNEE_CHANGED', byEmail: maya, toEmail: maya, agoMin: 5 },
      { type: 'STATUS_CHANGED', byEmail: maya, from: 'NEW', to: 'OPEN', agoMin: 5 },
      { type: 'TAGS_CHANGED', byEmail: maya, agoMin: 3 },
    ],
  },
  {
    number: 4771,
    subject: 'NVR recording failure – Building 3 cameras not recording',
    requesterEmail: CLIENT_EMAILS.aisha,
    type: 'INCIDENT',
    categoryKey: 'cctv',
    subtypeKey: 'nvr-vms-recording-failure',
    priority: 'P1',
    impact: 'DEPARTMENT',
    orgKey: 'hmc',
    siteKey: 'building-3-level-2',
    assetId: 'NVR-03',
    status: 'OPEN',
    assigneeEmail: priya,
    createdAgoMin: 21,
    // Overdue: the first-reply target passed 6 minutes ago.
    firstReplyDueInMin: -6,
    tags: ['nvr'],
    // The fault is the recorder (asset NVR-03), not a single camera, so camera_id stays empty.
    customFields: {},
    messages: [
      {
        kind: 'customer',
        body: 'Cameras on Building 3, Level 2 show live view but nothing has been recorded since 06:40. Our security team needs footage for an incident this morning.',
        agoMin: 21,
      },
    ],
    activity: [
      { type: 'ASSIGNEE_CHANGED', byEmail: priya, toEmail: priya, agoMin: 18 },
      { type: 'STATUS_CHANGED', byEmail: priya, from: 'NEW', to: 'OPEN', agoMin: 18 },
      { type: 'TAGS_CHANGED', byEmail: priya, agoMin: 17 },
    ],
  },
  {
    number: 4821,
    subject: 'Card reader fault – main lobby turnstile',
    requesterEmail: CLIENT_EMAILS.fatima,
    type: 'INCIDENT',
    categoryKey: 'access',
    subtypeKey: 'turnstile-barrier-gate-fault',
    priority: 'P2',
    impact: 'ENTIRE_SITE',
    orgKey: 'ooredoo',
    siteKey: 'tower-main-lobby',
    assetId: 'RDR-203',
    status: 'OPEN',
    assigneeEmail: priya,
    createdAgoMin: 22,
    firstReplyDueInMin: 38,
    tags: ['turnstile'],
    customFields: { door_reader: 'Turnstile 2' },
    messages: [
      {
        kind: 'customer',
        body: 'Turnstile 2 in the main lobby rejects every card. Staff are queueing and security is letting people through manually.',
        agoMin: 22,
      },
    ],
    activity: [
      { type: 'ASSIGNEE_CHANGED', byEmail: priya, toEmail: priya, agoMin: 15 },
      { type: 'STATUS_CHANGED', byEmail: priya, from: 'NEW', to: 'OPEN', agoMin: 15 },
      { type: 'TAGS_CHANGED', byEmail: priya, agoMin: 14 },
    ],
  },
  {
    number: 4809,
    subject: 'Site link down – branch office',
    requesterEmail: CLIENT_EMAILS.khalid,
    type: 'INCIDENT',
    categoryKey: 'network',
    subtypeKey: 'site-link-down',
    priority: 'P1',
    impact: 'ENTIRE_SITE',
    orgKey: 'qnb',
    siteKey: 'west-bay-branch',
    assetId: 'RTR-WB-01',
    status: 'PENDING',
    assigneeEmail: theo,
    createdAgoMin: 70,
    firstReplyDueInMin: null,
    tags: ['fibre'],
    customFields: {},
    messages: [
      {
        kind: 'customer',
        body: 'West Bay branch has lost its primary link. Tellers can’t reach core banking.',
        agoMin: 70,
      },
      {
        kind: 'agent',
        authorEmail: theo,
        body: 'Carrier confirms a fibre cut near the branch. Failover to the 4G backup is active and an engineer is on the way — ETA 45 min.',
        agoMin: 58,
      },
    ],
    activity: [
      { type: 'P1_ACKNOWLEDGED', byEmail: theo, agoMin: 67 },
      { type: 'ASSIGNEE_CHANGED', byEmail: theo, toEmail: theo, agoMin: 67 },
      { type: 'STATUS_CHANGED', byEmail: theo, from: 'NEW', to: 'OPEN', agoMin: 67 },
      { type: 'STATUS_CHANGED', byEmail: theo, from: 'OPEN', to: 'PENDING', agoMin: 58 },
      { type: 'TAGS_CHANGED', byEmail: theo, agoMin: 57 },
    ],
  },
  {
    number: 4790,
    subject: 'Meeting room AV not working',
    requesterEmail: CLIENT_EMAILS.omar,
    type: 'INCIDENT',
    categoryKey: 'av',
    subtypeKey: 'meeting-room-av',
    priority: 'P3',
    impact: 'SINGLE_USER',
    orgKey: 'moi',
    siteKey: 'conference-wing-level-1',
    assetId: 'MR-1.04',
    status: 'NEW',
    assigneeEmail: null,
    createdAgoMin: 50,
    firstReplyDueInMin: 190,
    tags: [],
    customFields: { room_name: 'Meeting room 1.04' },
    messages: [
      {
        kind: 'customer',
        body: 'The display in meeting room 1.04 shows “No signal” from both HDMI and wireless casting. Needed for a briefing tomorrow at 09:00.',
        agoMin: 50,
      },
    ],
    activity: [],
  },
  {
    number: 4829,
    subject: 'Preventive maintenance scheduling – Q4 CCTV PPM',
    requesterEmail: CLIENT_EMAILS.aisha,
    type: 'SERVICE_REQUEST',
    categoryKey: 'service',
    subtypeKey: 'preventive-maintenance-scheduling',
    priority: 'P4',
    impact: 'MULTIPLE_SITES',
    orgKey: 'hmc',
    siteKey: 'all-sites',
    assetId: 'AMC-2026-018',
    status: 'OPEN',
    assigneeEmail: null,
    createdAgoMin: 240,
    firstReplyDueInMin: 20 * 60,
    tags: ['ppm'],
    customFields: {},
    messages: [
      {
        kind: 'customer',
        body: 'Please propose dates for the Q4 CCTV PPM across all HMC sites. Weekends preferred for the Heart Hospital.',
        agoMin: 240,
      },
    ],
    activity: [
      { type: 'STATUS_CHANGED', byEmail: rashid, from: 'NEW', to: 'OPEN', agoMin: 200 },
      { type: 'TAGS_CHANGED', byEmail: rashid, agoMin: 200 },
    ],
  },
  {
    number: 4752,
    subject: 'Access rights change – new ward staff',
    requesterEmail: CLIENT_EMAILS.aisha,
    type: 'SERVICE_REQUEST',
    categoryKey: 'access',
    subtypeKey: 'access-rights-change',
    priority: 'P4',
    impact: 'DEPARTMENT',
    orgKey: 'hmc',
    siteKey: 'heart-hospital-ground-floor',
    assetId: null,
    status: 'SOLVED',
    assigneeEmail: priya,
    createdAgoMin: 4000,
    firstReplyDueInMin: null,
    tags: [],
    customFields: {},
    messages: [
      {
        kind: 'customer',
        body: 'Please grant ward 4 access to the 6 new nurses listed in the attached form.',
        agoMin: 4000,
      },
      {
        kind: 'agent',
        authorEmail: priya,
        body: 'Done — all six cards now open ward 4 and the medication room. Let us know if anyone has trouble.',
        agoMin: 3900,
      },
    ],
    activity: [
      { type: 'ASSIGNEE_CHANGED', byEmail: priya, toEmail: priya, agoMin: 3950 },
      { type: 'STATUS_CHANGED', byEmail: priya, from: 'NEW', to: 'OPEN', agoMin: 3950 },
      { type: 'STATUS_CHANGED', byEmail: priya, from: 'OPEN', to: 'SOLVED', agoMin: 3900 },
    ],
  },
];

/** The next ticket created after seeding gets this number (design nextId). */
export const NEXT_TICKET_NUMBER = 4834;

// ───────────────────────────── Skills ─────────────────────────────

export interface DemoSkillSeed {
  key: string;
  labelEn: string;
  labelAr: string;
  /** Staff who have the skill (demo accounts). */
  staffEmails: readonly string[];
}

/**
 * A starter catalog for the demo (docs/AUTO_ASSIGN.md). Categories are NOT linked to any skill, so
 * nothing is assigned automatically until an admin picks the skills a category needs under
 * Admin → Categories; the staff already have theirs, so that is one click per category.
 */
export const DEMO_SKILLS: readonly DemoSkillSeed[] = [
  {
    key: 'network',
    labelEn: 'Network',
    labelAr: 'الشبكات',
    staffEmails: [STAFF_EMAILS.theo],
  },
  {
    key: 'security',
    labelEn: 'Security',
    labelAr: 'الأمن السيبراني',
    staffEmails: [STAFF_EMAILS.maya],
  },
  {
    key: 'data-centre',
    labelEn: 'Data centre',
    labelAr: 'مركز البيانات',
    staffEmails: [STAFF_EMAILS.theo],
  },
  {
    key: 'cctv-access',
    labelEn: 'CCTV & access control',
    labelAr: 'المراقبة والتحكم في الدخول',
    staffEmails: [STAFF_EMAILS.priya],
  },
  {
    key: 'building-av',
    labelEn: 'Building systems & AV',
    labelAr: 'أنظمة المباني والسمعيات والبصريات',
    staffEmails: [STAFF_EMAILS.priya],
  },
  {
    key: 'desktop-support',
    labelEn: 'Desktop support',
    labelAr: 'دعم أجهزة المستخدمين',
    staffEmails: [STAFF_EMAILS.sam],
  },
  {
    key: 'software',
    labelEn: 'Software',
    labelAr: 'البرمجيات',
    staffEmails: [STAFF_EMAILS.sam],
  },
];

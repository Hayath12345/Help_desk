// Contract-valid sample data for unit tests (mirrors the seed: categories, SLA policies, a client
// organisation). Not imported by application code.

import type {
  FormContext,
  MessageDto,
  TicketDetailDto,
  TicketFormConfig,
  TicketSummaryDto,
} from '@loons/shared';

/** Deterministic RFC 9562 v4 uuids: fixtureId(1) → 00000000-0000-4000-8000-000000000001. */
export const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const team = (n: number, key: string, nameEn: string, nameAr: string) => ({
  id: fixtureId(100 + n),
  key,
  nameEn,
  nameAr,
});

export const TEAMS = {
  soc: team(1, 'soc', 'SOC', 'مركز العمليات الأمنية'),
  elv: team(2, 'elv', 'ELV Field', 'فريق الأنظمة الميدانية'),
  triage: team(3, 'triage', 'Triage', 'الفرز'),
};

export const IDS = {
  cyber: fixtureId(201),
  cctv: fixtureId(202),
  other: fixtureId(203),
  lab: fixtureId(204),
  secAlert: fixtureId(301),
  phishing: fixtureId(302),
  siemTuning: fixtureId(303),
  cameraOffline: fixtureId(311),
  nvrFailure: fixtureId(312),
  describe: fixtureId(321),
  labSub: fixtureId(331),
  cameraField: fixtureId(401),
  requester: fixtureId(501),
  org: fixtureId(601),
  siteA: fixtureId(701),
  siteB: fixtureId(702),
  siteC: fixtureId(703),
  staff: fixtureId(801),
  ticket: fixtureId(901),
};

export const FORM_CONFIG: TicketFormConfig = {
  categories: [
    {
      id: IDS.cyber,
      key: 'cyber',
      labelEn: 'Cybersecurity / SOC',
      labelAr: 'الأمن السيبراني / SOC',
      icon: 'shield',
      assetPlaceholder: 'e.g. FW-01',
      assetPlaceholderAr: null,
      team: TEAMS.soc,
      subtypes: [
        {
          id: IDS.secAlert,
          key: 'security-alert',
          labelEn: 'Security alert / suspected incident',
          labelAr: 'تنبيه أمني / حادث مشتبه به',
          defaultPriority: 'P1',
        },
        {
          id: IDS.phishing,
          key: 'phishing',
          labelEn: 'Phishing report',
          labelAr: 'بلاغ تصيد احتيالي',
          defaultPriority: 'P2',
        },
        {
          id: IDS.siemTuning,
          key: 'siem',
          labelEn: 'SIEM / SOAR alert or tuning',
          labelAr: 'تنبيه أو ضبط SIEM / SOAR',
          defaultPriority: 'P3',
        },
      ],
      fields: [],
    },
    {
      id: IDS.cctv,
      key: 'cctv',
      labelEn: 'CCTV & Video Surveillance',
      labelAr: 'الدوائر التلفزيونية والمراقبة بالفيديو',
      icon: 'cctv',
      assetPlaceholder: 'e.g. CAM-014',
      assetPlaceholderAr: null,
      team: TEAMS.elv,
      subtypes: [
        {
          id: IDS.cameraOffline,
          key: 'camera-offline',
          labelEn: 'Camera offline',
          labelAr: 'الكاميرا غير متصلة',
          defaultPriority: 'P2',
        },
        {
          id: IDS.nvrFailure,
          key: 'nvr-failure',
          labelEn: 'NVR / VMS recording failure',
          labelAr: 'فشل التسجيل في NVR / VMS',
          defaultPriority: 'P1',
        },
      ],
      fields: [
        {
          id: IDS.cameraField,
          key: 'camera_id',
          labelEn: 'Camera ID',
          labelAr: 'رقم الكاميرا',
          type: 'ASSET_ID',
          options: [],
          placeholderEn: 'e.g. CAM-014',
          placeholderAr: 'مثال: CAM-014',
          required: false,
        },
      ],
    },
    {
      id: IDS.lab,
      key: 'lab',
      labelEn: 'Lab (every field type)',
      labelAr: '',
      icon: 'flask-conical',
      assetPlaceholder: null,
      assetPlaceholderAr: null,
      team: TEAMS.triage,
      subtypes: [
        {
          id: IDS.labSub,
          key: 'lab-sub',
          labelEn: 'Lab sub-type',
          labelAr: '',
          defaultPriority: 'P4',
        },
      ],
      fields: [
        {
          id: fixtureId(411),
          key: 'room',
          labelEn: 'Room',
          labelAr: 'القاعة',
          type: 'TEXT',
          options: [],
          placeholderEn: null,
          placeholderAr: null,
          required: true,
        },
        {
          id: fixtureId(412),
          key: 'floors',
          labelEn: 'Floors affected',
          labelAr: 'الطوابق المتأثرة',
          type: 'NUMBER',
          options: [],
          placeholderEn: null,
          placeholderAr: null,
          required: false,
        },
        {
          id: fixtureId(413),
          key: 'vendor',
          labelEn: 'Vendor',
          labelAr: 'المورّد',
          type: 'DROPDOWN',
          options: [
            { value: 'axis', labelEn: 'Axis', labelAr: 'أكسيس' },
            { value: 'hik', labelEn: 'Hikvision', labelAr: 'هيكفيجن' },
          ],
          placeholderEn: null,
          placeholderAr: null,
          required: true,
        },
        {
          id: fixtureId(414),
          key: 'zones',
          labelEn: 'Zones',
          labelAr: 'المناطق',
          type: 'MULTI_SELECT',
          options: [
            { value: 'a', labelEn: 'Zone A', labelAr: 'المنطقة أ' },
            { value: 'b', labelEn: 'Zone B', labelAr: 'المنطقة ب' },
          ],
          placeholderEn: null,
          placeholderAr: null,
          required: false,
        },
        {
          id: fixtureId(415),
          key: 'since',
          labelEn: 'Failing since',
          labelAr: 'متعطل منذ',
          type: 'DATE',
          options: [],
          placeholderEn: null,
          placeholderAr: null,
          required: false,
        },
        {
          id: fixtureId(416),
          key: 'on_site',
          labelEn: 'Engineer on site?',
          labelAr: 'هل المهندس في الموقع؟',
          type: 'YES_NO',
          options: [],
          placeholderEn: null,
          placeholderAr: null,
          required: true,
        },
      ],
    },
    {
      id: IDS.other,
      key: 'other',
      labelEn: 'Other',
      labelAr: 'أخرى',
      icon: 'circle-question-mark',
      assetPlaceholder: 'Optional',
      assetPlaceholderAr: null,
      team: TEAMS.triage,
      subtypes: [
        {
          id: IDS.describe,
          key: 'describe-below',
          labelEn: 'Describe below',
          labelAr: 'صف المشكلة أدناه',
          defaultPriority: 'P3',
        },
      ],
      fields: [],
    },
  ],
  slaPolicies: [
    {
      priority: 'P1',
      firstReplyMins: 15,
      resolveMins: 240,
      businessHoursOnly: false,
      atRiskPercent: 75,
    },
    {
      priority: 'P2',
      firstReplyMins: 60,
      resolveMins: 480,
      businessHoursOnly: false,
      atRiskPercent: 75,
    },
    {
      priority: 'P3',
      firstReplyMins: 240,
      resolveMins: 1080,
      businessHoursOnly: true,
      atRiskPercent: 75,
    },
    {
      priority: 'P4',
      firstReplyMins: 540,
      resolveMins: 2700,
      businessHoursOnly: true,
      atRiskPercent: 75,
    },
  ],
  securityCategoryKey: 'cyber',
  socPhone: '+974 4000 0000',
  businessDayMinutes: 540,
  version: 1,
};

export const FORM_CONTEXT: FormContext = {
  requester: { id: IDS.requester, name: 'Dr. Aisha Al-Kuwari', email: 'aisha.alkuwari@hamad.qa' },
  org: {
    id: IDS.org,
    name: 'Hamad Medical Corporation',
    nameAr: 'مؤسسة حمد الطبية',
    contractType: 'AMC',
  },
  sites: [
    { id: IDS.siteA, name: 'HMC – Building 3, Level 2', nameAr: null },
    { id: IDS.siteB, name: 'HMC – Main Data Center', nameAr: 'مؤسسة حمد – مركز البيانات' },
    { id: IDS.siteC, name: 'HMC – Women’s Wellness Hospital', nameAr: null },
  ],
};

const ISO = '2026-09-23T12:00:00.000Z';

export function makeSummary(overrides: Partial<TicketSummaryDto> = {}): TicketSummaryDto {
  return {
    id: IDS.ticket,
    number: 4771,
    ref: 'LG-4771',
    subject: 'NVR recording failure – Building 3 cameras not recording',
    type: 'INCIDENT',
    status: 'OPEN',
    priority: 'P1',
    impact: 'ENTIRE_SITE',
    channel: 'PORTAL',
    category: {
      id: IDS.cctv,
      key: 'cctv',
      labelEn: 'CCTV & Video Surveillance',
      labelAr: '',
      icon: 'cctv',
      isActive: true,
    },
    subtype: {
      id: IDS.nvrFailure,
      key: 'nvr-failure',
      labelEn: 'NVR / VMS recording failure',
      labelAr: '',
      isActive: true,
    },
    team: { ...TEAMS.elv, isActive: true },
    org: { id: IDS.org, name: 'Hamad Medical Corporation', nameAr: null },
    site: { id: IDS.siteA, name: 'HMC – Building 3, Level 2', nameAr: null, isActive: true },
    requester: { id: IDS.requester, name: 'Dr. Aisha Al-Kuwari', email: 'aisha.alkuwari@hamad.qa' },
    assignee: null,
    tags: [],
    preview: 'Cameras on Building 3 show live view but nothing has been recorded.',
    firstReplyDueAt: '2026-09-23T12:15:00.000Z',
    resolveDueAt: '2026-09-23T16:00:00.000Z',
    // Stored by the API (75 % of 15 min / 4 h): the SLA turns "at risk" at these instants.
    firstReplyAtRiskAt: '2026-09-23T12:11:15.000Z',
    resolveAtRiskAt: '2026-09-23T15:00:00.000Z',
    firstRepliedAt: null,
    solvedAt: null,
    closedAt: null,
    slaBreached: false,
    slaPausedAt: null,
    // A P1 since creation, not escalated or acknowledged yet.
    p1Since: (overrides.priority ?? 'P1') === 'P1' ? ISO : null,
    p1EscalationStep: 0,
    p1AckedAt: null,
    p1AckedBy: null,
    lastMessageAt: ISO,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

export function makeDetail(overrides: Partial<TicketDetailDto> = {}): TicketDetailDto {
  return {
    ...makeSummary(),
    description: 'Cameras on Building 3 show live view but nothing has been recorded.',
    assetId: 'NVR-02',
    customFields: [],
    attachments: [],
    requesterCard: {
      org: {
        id: IDS.org,
        name: 'Hamad Medical Corporation',
        nameAr: null,
        contractType: 'AMC',
        amcExpiry: '2027-03-31',
      },
      accountManager: null,
      sitesCount: 3,
      otherTicketsCount: 0,
    },
    sla: {
      priority: 'P1',
      firstReplyMins: 15,
      resolveMins: 240,
      businessHoursOnly: false,
      atRiskPercent: 75,
    },
    // The seeded global P1 chain (D3): on-call at 0, team leads at 5, operations manager at 15.
    p1Chain: [
      { step: 1, afterMins: 0 },
      { step: 2, afterMins: 5 },
      { step: 3, afterMins: 15 },
    ],
    // Server-computed next escalation step (Phase 5 F15); none by default.
    p1NextStep: null,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: fixtureId(1001),
    ticketId: IDS.ticket,
    type: 'PUBLIC',
    body: 'Cameras on Building 3 show live view but nothing has been recorded since 06:40.',
    author: { id: IDS.requester, name: 'Dr. Aisha Al-Kuwari', role: 'CLIENT' },
    clientTempId: null,
    attachments: [],
    createdAt: ISO,
    ...overrides,
  };
}

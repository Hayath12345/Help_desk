// Support teams (design TEAMS). Arabic names come from the design's AR table where it has one;
// SOC, NOC and BMS are not in that table and were translated for the seed.

export interface TeamSeed {
  key: string;
  nameEn: string;
  nameAr: string;
  /** Distribution list notified when a ticket is routed to the team. */
  emails: string[];
}

export const TEAMS: readonly TeamSeed[] = [
  {
    key: 'soc',
    nameEn: 'SOC',
    nameAr: 'مركز العمليات الأمنية (SOC)',
    emails: ['soc@loonsgroup.com'],
  },
  {
    key: 'noc',
    nameEn: 'NOC',
    nameAr: 'مركز عمليات الشبكة (NOC)',
    emails: ['noc@loonsgroup.com'],
  },
  {
    key: 'elv',
    nameEn: 'ELV Field',
    nameAr: 'الأنظمة منخفضة الجهد',
    emails: ['elv@loonsgroup.com'],
  },
  {
    key: 'dcops',
    nameEn: 'DC Ops',
    nameAr: 'عمليات مركز البيانات',
    emails: ['dcops@loonsgroup.com'],
  },
  {
    key: 'itsd',
    nameEn: 'IT Service Desk',
    nameAr: 'مكتب خدمات تقنية المعلومات',
    emails: ['servicedesk@loonsgroup.com'],
  },
  {
    key: 'bms',
    nameEn: 'BMS',
    nameAr: 'أنظمة إدارة المباني (BMS)',
    emails: ['bms@loonsgroup.com'],
  },
  {
    key: 'av',
    nameEn: 'AV',
    nameAr: 'الصوت والصورة',
    emails: ['av@loonsgroup.com'],
  },
  {
    key: 'sw',
    nameEn: 'Software',
    nameAr: 'البرمجيات',
    emails: ['software@loonsgroup.com'],
  },
  {
    key: 'am',
    nameEn: 'Account Management',
    nameAr: 'إدارة الحسابات',
    emails: ['accounts@loonsgroup.com'],
  },
  {
    key: 'triage',
    nameEn: 'Triage',
    nameAr: 'الفرز',
    emails: ['triage@loonsgroup.com'],
  },
];

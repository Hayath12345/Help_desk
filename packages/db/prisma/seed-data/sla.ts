// SLA policies, business hours, app settings and the P1 escalation chain (spec §7, §9, §13).

import type {
  EscalationChannel,
  EscalationTargetType,
  Priority,
  Role,
} from '../../src/generated/prisma/enums.ts';

export interface SlaPolicySeed {
  priority: Priority;
  /** Minutes (calendar when 24/7, business minutes otherwise) until the first public agent reply. */
  firstReplyMins: number;
  /** Minutes until SOLVED; PENDING pauses this clock. */
  resolveMins: number;
  businessHoursOnly: boolean;
  atRiskPercent: number;
}

/** One business day = 07:30–16:30 = 9 hours. */
export const BUSINESS_DAY_MINS = 9 * 60;

export const SLA_POLICIES: readonly SlaPolicySeed[] = [
  // P1 Critical: 15 min / 4 h, 24/7.
  {
    priority: 'P1',
    firstReplyMins: 15,
    resolveMins: 4 * 60,
    businessHoursOnly: false,
    atRiskPercent: 75,
  },
  // P2 High: 1 h / 8 h, 24/7.
  {
    priority: 'P2',
    firstReplyMins: 60,
    resolveMins: 8 * 60,
    businessHoursOnly: false,
    atRiskPercent: 75,
  },
  // P3 Medium: 4 business hours / 2 business days.
  {
    priority: 'P3',
    firstReplyMins: 4 * 60,
    resolveMins: 2 * BUSINESS_DAY_MINS,
    businessHoursOnly: true,
    atRiskPercent: 75,
  },
  // P4 Low: 1 business day / 5 business days.
  {
    priority: 'P4',
    firstReplyMins: BUSINESS_DAY_MINS,
    resolveMins: 5 * BUSINESS_DAY_MINS,
    businessHoursOnly: true,
    atRiskPercent: 75,
  },
];

export interface BusinessHoursSeed {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  isOpen: boolean;
  open: string;
  close: string;
}

/** Qatar working week: Sunday–Thursday 07:30–16:30; Friday and Saturday closed. */
export const BUSINESS_HOURS: readonly BusinessHoursSeed[] = [0, 1, 2, 3, 4, 5, 6].map(
  (weekday) => ({
    weekday,
    isOpen: weekday <= 4,
    open: '07:30',
    close: '16:30',
  }),
);

export interface AppSettingSeed {
  key: string;
  value: string | number | boolean;
}

export const APP_SETTINGS: readonly AppSettingSeed[] = [
  { key: 'business.timezone', value: 'Asia/Qatar' },
  { key: 'tickets.autoCloseDays', value: 5 },
  { key: 'support.socPhone', value: '+974 4000 0000' },
  // Local time (business.timezone) of the daily P4 digest, sent on business days only (D9).
  { key: 'notifications.p4DigestTime', value: '07:30' },
  // Category forced for SECURITY_INCIDENT tickets (spec §7); the API falls back to 'cyber' too.
  { key: 'tickets.securityCategoryKey', value: 'cyber' },
];

export interface EscalationStepSeed {
  priority: Priority;
  step: number;
  targetType: EscalationTargetType;
  targetRole: Role | null;
  /**
   * For USER targets: the step targets the operations manager (a SUPER_ADMIN). The user is resolved
   * at seed time (demo manager, SEED_ADMIN_EMAIL, or the first active super admin).
   */
  targetsOperationsManager: boolean;
  afterMins: number;
  channels: readonly EscalationChannel[];
}

/** Global (teamId = null) P1 chain: on-call engineer → team lead → operations manager. */
export const P1_ESCALATION_STEPS: readonly EscalationStepSeed[] = [
  {
    priority: 'P1',
    step: 1,
    targetType: 'ON_CALL',
    targetRole: null,
    targetsOperationsManager: false,
    afterMins: 0,
    channels: ['EMAIL', 'TEAMS', 'SMS'],
  },
  {
    priority: 'P1',
    step: 2,
    targetType: 'ROLE',
    targetRole: 'TEAM_LEAD',
    targetsOperationsManager: false,
    afterMins: 5,
    channels: ['EMAIL', 'TEAMS', 'SMS'],
  },
  {
    priority: 'P1',
    step: 3,
    targetType: 'USER',
    targetRole: null,
    targetsOperationsManager: true,
    afterMins: 15,
    channels: ['EMAIL', 'SMS'],
  },
];

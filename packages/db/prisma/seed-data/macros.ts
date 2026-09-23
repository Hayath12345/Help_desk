// Global reply macros (design console composer; Arabic bodies from MACRO_AR).
// Bodies may use {{requesterFirstName}} and {{siteName}}; the console fills them from the ticket.

import type { TicketStatus } from '../../src/generated/prisma/enums.ts';

export interface MacroSeed {
  key: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  /** Status applied when the macro is sent (null = unchanged). */
  setStatus: TicketStatus | null;
}

/** Placeholders a macro body may contain. */
export const MACRO_VARIABLES = ['requesterFirstName', 'siteName'] as const;

export const MACROS: readonly MacroSeed[] = [
  {
    key: 'request-photos-video',
    titleEn: 'Request photos/video',
    titleAr: 'طلب صور/فيديو',
    bodyEn:
      'Hi {{requesterFirstName}}, could you send a photo or short video of the fault? It helps our engineer bring the right parts.',
    bodyAr:
      'هل يمكنك إرسال صورة أو مقطع فيديو قصير للعطل؟ سيساعد ذلك مهندسنا على إحضار القطع المناسبة.',
    setStatus: null,
  },
  {
    key: 'engineer-dispatched',
    titleEn: 'Engineer dispatched',
    titleAr: 'تم إرسال مهندس',
    bodyEn:
      'Hi {{requesterFirstName}}, an engineer has been dispatched to {{siteName}}. We’ll update you on arrival.',
    bodyAr: 'تم إرسال مهندس إلى الموقع، وسنوافيك بالتحديثات عند وصوله.',
    setStatus: null,
  },
  {
    key: 'awaiting-client-access',
    titleEn: 'Awaiting client access',
    titleAr: 'بانتظار تصريح الدخول',
    bodyEn:
      'Our engineer is on site but waiting for access to {{siteName}}. Could you arrange an escort or access permit?',
    bodyAr: 'مهندسنا في الموقع بانتظار تصريح الدخول. هل يمكنك ترتيب مرافق أو تصريح دخول؟',
    setStatus: 'PENDING',
  },
  {
    key: 'escalate-to-soc',
    titleEn: 'Escalate to SOC',
    titleAr: 'تصعيد إلى SOC',
    bodyEn:
      'Escalating to the Loons SOC for investigation. An analyst will contact you shortly — please don’t power off affected devices.',
    bodyAr:
      'تم تصعيد الطلب إلى مركز العمليات الأمنية لدى لونز. سيتواصل معك أحد المحللين قريبًا — يُرجى عدم إيقاف تشغيل الأجهزة المتأثرة.',
    setStatus: null,
  },
];

// Help-center FAQ articles (design ARTICLES / ARTICLES_AR).

export interface HelpArticleSeed {
  key: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}

export const HELP_ARTICLES: readonly HelpArticleSeed[] = [
  {
    key: 'report-critical-security-incident',
    titleEn: 'How do I report a critical security incident?',
    titleAr: 'كيف أبلغ عن حادث أمني حرج؟',
    bodyEn:
      'Raise a ticket with type “Security Incident” — it is set to P1 and routed to our SOC, who are alerted immediately. Then call the 24/7 SOC line on +974 4000 0000. Do not power off affected devices, and only disconnect them from the network if our analysts ask you to.',
    bodyAr:
      'افتح تذكرة من نوع «حادث أمني» — تُضبط تلقائيًا على P1 وتُوجَّه إلى مركز العمليات الأمنية (SOC) الذي يتم تنبيهه فورًا. ثم اتصل بخط SOC على مدار الساعة \u200e+974 4000 0000. لا تقم بإيقاف تشغيل الأجهزة المتأثرة، وافصلها عن الشبكة فقط إذا طلب منك المحللون ذلك.',
  },
  {
    key: 'support-hours-and-slas',
    titleEn: 'What are your support hours and SLAs?',
    titleAr: 'ما هي ساعات الدعم ومهل الخدمة؟',
    bodyEn:
      'The SOC and on-call engineers are available 24/7 for P1 tickets. First-response targets: P1 Critical 15 min, P2 High 1 hour, P3 Medium 4 hours, P4 Low 1 business day. Resolution targets are 4 h, 8 h, 2 and 5 business days respectively.',
    bodyAr:
      'يعمل مركز SOC ومهندسو المناوبة على مدار الساعة لتذاكر P1. أهداف الرد الأول: P1 حرجة 15 دقيقة، P2 عالية ساعة واحدة، P3 متوسطة 4 ساعات، P4 منخفضة يوم عمل واحد. وأهداف الحل هي 4 ساعات و8 ساعات ويوما عمل و5 أيام عمل على التوالي.',
  },
  {
    key: 'request-cctv-footage',
    titleEn: 'How do I request CCTV footage?',
    titleAr: 'كيف أطلب تسجيلات كاميرات المراقبة؟',
    bodyEn:
      'Open a ticket under CCTV & Video Surveillance → Footage retrieval. Include the camera ID (e.g. CAM-014), date and time window. Footage is released only to authorised contacts on your contract.',
    bodyAr:
      'افتح تذكرة ضمن كاميرات المراقبة ← استرجاع التسجيلات. أرفق رقم الكاميرا (مثل CAM-014) والتاريخ والفترة الزمنية. تُسلَّم التسجيلات فقط لجهات الاتصال المخوّلة في عقدك.',
  },
  {
    key: 'request-access-card-changes',
    titleEn: 'How do I request access card changes?',
    titleAr: 'كيف أطلب تغييرات على بطاقات الدخول؟',
    bodyEn:
      'Choose Access Control & Intrusion → Access rights change or Card issue / cancellation. Attach the approved access form; changes are usually applied within one business day.',
    bodyAr:
      'اختر التحكم في الدخول وكشف التسلل ← تغيير صلاحيات الدخول أو إصدار / إلغاء بطاقة. أرفق نموذج الدخول المعتمد؛ تُطبَّق التغييرات عادةً خلال يوم عمل واحد.',
  },
  {
    key: 'schedule-preventive-maintenance',
    titleEn: 'How do I schedule preventive maintenance?',
    titleAr: 'كيف أجدول الصيانة الوقائية؟',
    bodyEn:
      'Choose Service Requests & Commercial → Preventive maintenance scheduling and propose dates. Your account manager will confirm the PPM visit plan and engineer allocation.',
    bodyAr:
      'اختر طلبات الخدمة والشؤون التجارية ← جدولة الصيانة الوقائية واقترح المواعيد المناسبة. سيؤكد مدير حسابك خطة زيارة الصيانة وتخصيص المهندسين.',
  },
];

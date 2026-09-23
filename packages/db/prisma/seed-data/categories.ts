// Ticket categories → routed team → sub-types with default priority (spec §13, design CONFIG).
// Arabic labels come from the design's AR table. Keys are stable identifiers: a sub-type key is the
// kebab slug of its original English label and must not change when labels are edited later.

import type { Priority } from '../../src/generated/prisma/enums.ts';

export interface SubtypeSeed {
  key: string;
  labelEn: string;
  labelAr: string;
  defaultPriority: Priority;
}

export interface CategorySeed {
  key: string;
  labelEn: string;
  labelAr: string;
  /** Team.key the category routes to. */
  teamKey: string;
  /** lucide-react icon name (kebab-case). */
  icon: string;
  /** Placeholder of the "Asset / device ID" input. */
  assetPlaceholder: string;
  subtypes: readonly SubtypeSeed[];
}

type SubtypeRow = readonly [key: string, labelEn: string, labelAr: string, priority: Priority];

function subtypes(rows: readonly SubtypeRow[]): SubtypeSeed[] {
  return rows.map(([key, labelEn, labelAr, defaultPriority]) => ({
    key,
    labelEn,
    labelAr,
    defaultPriority,
  }));
}

export const CATEGORIES: readonly CategorySeed[] = [
  {
    key: 'cyber',
    labelEn: 'Cybersecurity / SOC',
    labelAr: 'الأمن السيبراني / SOC',
    teamKey: 'soc',
    icon: 'shield-alert',
    assetPlaceholder: 'e.g. FW-01',
    subtypes: subtypes([
      [
        'security-alert-suspected-incident',
        'Security alert / suspected incident',
        'تنبيه أمني / حادث مشتبه به',
        'P1',
      ],
      ['malware-ransomware', 'Malware / ransomware', 'برمجيات خبيثة / فدية', 'P1'],
      ['phishing-report', 'Phishing report', 'بلاغ تصيّد احتيالي', 'P2'],
      [
        'unauthorised-access-account-compromise',
        'Unauthorised access / account compromise',
        'وصول غير مصرح به / اختراق حساب',
        'P1',
      ],
      ['firewall-vpn-issue', 'Firewall / VPN issue', 'مشكلة في الجدار الناري / VPN', 'P2'],
      [
        'siem-soar-alert-or-tuning',
        'SIEM / SOAR alert or tuning',
        'تنبيه أو ضبط SIEM / SOAR',
        'P3',
      ],
      [
        'vulnerability-patch-request',
        'Vulnerability / patch request',
        'ثغرة / طلب تحديث أمني',
        'P3',
      ],
      ['log-source-not-reporting', 'Log source not reporting', 'مصدر سجلات لا يرسل بيانات', 'P3'],
    ]),
  },
  {
    key: 'network',
    labelEn: 'Network & Connectivity',
    labelAr: 'الشبكات والاتصال',
    teamKey: 'noc',
    icon: 'network',
    assetPlaceholder: 'e.g. SW-CORE-02',
    subtypes: subtypes([
      ['site-link-down', 'Site / link down', 'انقطاع الموقع / الرابط', 'P1'],
      ['slow-network-packet-loss', 'Slow network / packet loss', 'بطء الشبكة / فقدان الحزم', 'P2'],
      ['wi-fi-coverage-or-access', 'Wi-Fi coverage or access', 'تغطية أو وصول Wi-Fi', 'P3'],
      ['switch-router-fault', 'Switch / router fault', 'عطل في المبدّل / الموجّه', 'P2'],
      [
        'vlan-ip-dns-dhcp-change',
        'VLAN / IP / DNS / DHCP change',
        'تغيير VLAN / IP / DNS / DHCP',
        'P4',
      ],
      [
        'structured-cabling-fibre-fault',
        'Structured cabling / fibre fault',
        'عطل في الكابلات / الألياف',
        'P3',
      ],
      ['new-port-activation', 'New port activation', 'تفعيل منفذ جديد', 'P4'],
    ]),
  },
  {
    key: 'dc',
    labelEn: 'Data Center & Servers',
    labelAr: 'مركز البيانات والخوادم',
    teamKey: 'dcops',
    icon: 'server',
    assetPlaceholder: 'e.g. SRV-114',
    subtypes: subtypes([
      ['server-down-degraded', 'Server down / degraded', 'خادم متوقف / أداء متدهور', 'P1'],
      ['storage-backup-failure', 'Storage / backup failure', 'فشل التخزين / النسخ الاحتياطي', 'P2'],
      ['virtualisation-issue', 'Virtualisation issue', 'مشكلة في المحاكاة الافتراضية', 'P2'],
      ['power-ups-alarm', 'Power / UPS alarm', 'إنذار الطاقة / UPS', 'P1'],
      [
        'cooling-environmental-alarm',
        'Cooling / environmental alarm',
        'إنذار التبريد / البيئة',
        'P1',
      ],
      [
        'colocation-rack-access',
        'Colocation / rack access',
        'الاستضافة / الوصول إلى الخزائن',
        'P4',
      ],
      ['capacity-request', 'Capacity request', 'طلب سعة', 'P4'],
    ]),
  },
  {
    key: 'cloud',
    labelEn: 'Cloud & IT Infrastructure',
    labelAr: 'السحابة والبنية التحتية لتقنية المعلومات',
    teamKey: 'itsd',
    icon: 'cloud',
    assetPlaceholder: 'e.g. LT-0457',
    subtypes: subtypes([
      ['cloud-service-outage', 'Cloud service outage', 'انقطاع خدمة سحابية', 'P1'],
      ['email-m365-issue', 'Email / M365 issue', 'مشكلة في البريد / M365', 'P2'],
      [
        'account-password-mfa',
        'Account / password / MFA',
        'الحساب / كلمة المرور / المصادقة الثنائية',
        'P3',
      ],
      ['licensing', 'Licensing', 'التراخيص', 'P4'],
      [
        'endpoint-laptop-printer',
        'Endpoint / laptop / printer',
        'الأجهزة الطرفية / الحاسوب / الطابعة',
        'P3',
      ],
      ['software-installation', 'Software installation', 'تثبيت برامج', 'P4'],
    ]),
  },
  {
    key: 'cctv',
    labelEn: 'CCTV & Video Surveillance',
    labelAr: 'كاميرات المراقبة',
    teamKey: 'elv',
    icon: 'cctv',
    assetPlaceholder: 'e.g. CAM-014',
    subtypes: subtypes([
      ['camera-offline', 'Camera offline', 'كاميرا غير متصلة', 'P2'],
      ['poor-image-night-vision', 'Poor image / night vision', 'صورة ضعيفة / رؤية ليلية', 'P3'],
      ['nvr-vms-recording-failure', 'NVR / VMS recording failure', 'فشل التسجيل NVR / VMS', 'P1'],
      ['footage-retrieval', 'Footage retrieval', 'استرجاع التسجيلات', 'P3'],
      ['camera-repositioning', 'Camera repositioning', 'إعادة توجيه الكاميرا', 'P4'],
      ['video-analytics-fault', 'Video analytics fault', 'عطل في تحليلات الفيديو', 'P3'],
    ]),
  },
  {
    key: 'access',
    labelEn: 'Access Control & Intrusion',
    labelAr: 'التحكم في الدخول وكشف التسلل',
    teamKey: 'elv',
    icon: 'key-round',
    assetPlaceholder: 'e.g. RDR-203',
    subtypes: subtypes([
      ['card-reader-door-fault', 'Card reader / door fault', 'عطل قارئ البطاقات / الباب', 'P2'],
      ['card-issue-cancellation', 'Card issue / cancellation', 'إصدار / إلغاء بطاقة', 'P3'],
      ['access-rights-change', 'Access rights change', 'تغيير صلاحيات الدخول', 'P4'],
      [
        'turnstile-barrier-gate-fault',
        'Turnstile / barrier / gate fault',
        'عطل البوابة الدوارة / الحاجز',
        'P2',
      ],
      ['intrusion-alarm-fault', 'Intrusion alarm fault', 'عطل إنذار التسلل', 'P1'],
      ['visitor-management', 'Visitor management', 'إدارة الزوار', 'P4'],
    ]),
  },
  {
    key: 'life',
    labelEn: 'Life Safety Systems',
    labelAr: 'أنظمة السلامة',
    teamKey: 'elv',
    icon: 'siren',
    assetPlaceholder: 'e.g. FACP-03',
    subtypes: subtypes([
      [
        'fire-alarm-fault-false-alarm',
        'Fire alarm fault / false alarm',
        'عطل إنذار الحريق / إنذار كاذب',
        'P1',
      ],
      [
        'pa-voice-evacuation-fault',
        'PA / voice evacuation fault',
        'عطل نظام النداء / الإخلاء الصوتي',
        'P1',
      ],
      ['emergency-lighting', 'Emergency lighting', 'إنارة الطوارئ', 'P2'],
      ['nurse-call-intercom', 'Nurse call / intercom', 'نداء التمريض / الاتصال الداخلي', 'P1'],
      [
        'civil-defence-inspection-support',
        'Civil Defence inspection support',
        'دعم تفتيش الدفاع المدني',
        'P3',
      ],
    ]),
  },
  {
    key: 'bms',
    labelEn: 'Building Automation & Smart Building',
    labelAr: 'أتمتة المباني والمباني الذكية',
    teamKey: 'bms',
    icon: 'building-complex',
    assetPlaceholder: 'e.g. AHU-07',
    subtypes: subtypes([
      ['bms-alarm-point-offline', 'BMS alarm / point offline', 'إنذار BMS / نقطة غير متصلة', 'P2'],
      ['hvac-control', 'HVAC control', 'التحكم في التكييف', 'P2'],
      ['lighting-control', 'Lighting control', 'التحكم في الإنارة', 'P3'],
      ['energy-metering', 'Energy metering', 'قياس الطاقة', 'P4'],
      [
        'iot-sensor-integration-fault',
        'IoT sensor / integration fault',
        'عطل مستشعر IoT / التكامل',
        'P3',
      ],
    ]),
  },
  {
    key: 'av',
    labelEn: 'Audio Visual',
    labelAr: 'الأنظمة السمعية والبصرية',
    teamKey: 'av',
    icon: 'monitor-speaker',
    assetPlaceholder: 'e.g. MR-2.14',
    subtypes: subtypes([
      ['meeting-room-av', 'Meeting room AV', 'أنظمة قاعة الاجتماعات', 'P2'],
      ['video-conferencing-room', 'Video conferencing room', 'قاعة المؤتمرات المرئية', 'P2'],
      ['display-video-wall', 'Display / video wall', 'الشاشة / جدار الفيديو', 'P3'],
      ['sound-system', 'Sound system', 'نظام الصوت', 'P3'],
      ['digital-signage', 'Digital signage', 'اللافتات الرقمية', 'P4'],
    ]),
  },
  {
    key: 'software',
    labelEn: 'Software & Applications',
    labelAr: 'البرمجيات والتطبيقات',
    teamKey: 'sw',
    icon: 'app-window',
    assetPlaceholder: 'e.g. APP-HIS-01',
    subtypes: subtypes([
      ['bug-error', 'Bug / error', 'خلل / خطأ', 'P3'],
      ['feature-change-request', 'Feature / change request', 'طلب ميزة / تغيير', 'P4'],
      ['integration-api-failure', 'Integration / API failure', 'فشل التكامل / API', 'P2'],
      ['performance-issue', 'Performance issue', 'مشكلة في الأداء', 'P3'],
      ['application-access', 'Application access', 'الوصول إلى التطبيق', 'P3'],
    ]),
  },
  {
    key: 'service',
    labelEn: 'Service Requests & Commercial',
    labelAr: 'طلبات الخدمة والشؤون التجارية',
    teamKey: 'am',
    icon: 'briefcase-business',
    assetPlaceholder: 'e.g. AMC-2026-018',
    subtypes: subtypes([
      ['new-installation-expansion', 'New installation / expansion', 'تركيب جديد / توسعة', 'P4'],
      ['site-survey', 'Site survey', 'مسح الموقع', 'P4'],
      ['quotation-rfq', 'Quotation / RFQ', 'عرض سعر / طلب تسعير', 'P4'],
      ['amc-warranty-query', 'AMC / warranty query', 'استفسار عقد الصيانة / الضمان', 'P4'],
      [
        'preventive-maintenance-scheduling',
        'Preventive maintenance scheduling',
        'جدولة الصيانة الوقائية',
        'P4',
      ],
      ['training-request', 'Training request', 'طلب تدريب', 'P4'],
      ['documentation-as-builts', 'Documentation / as-builts', 'الوثائق / المخططات النهائية', 'P4'],
    ]),
  },
  {
    key: 'other',
    labelEn: 'Other',
    labelAr: 'أخرى',
    teamKey: 'triage',
    icon: 'circle-question-mark',
    assetPlaceholder: 'Optional',
    subtypes: subtypes([['describe-below', 'Describe below', 'صف المشكلة أدناه', 'P3']]),
  },
];

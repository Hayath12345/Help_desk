// Category-specific custom fields (spec §13). All optional; each linked to exactly one category.

import type { CustomFieldType } from '../../src/generated/prisma/enums.ts';

export interface CustomFieldSeed {
  key: string;
  labelEn: string;
  labelAr: string;
  type: CustomFieldType;
  placeholderEn: string;
  placeholderAr: string;
  required: boolean;
  /** Category.key values the field is shown for (CategoryField links). */
  categoryKeys: readonly string[];
}

export const CUSTOM_FIELDS: readonly CustomFieldSeed[] = [
  {
    key: 'camera_id',
    labelEn: 'Camera ID',
    labelAr: 'رقم الكاميرا',
    type: 'ASSET_ID',
    placeholderEn: 'e.g. CAM-014',
    placeholderAr: 'مثال: CAM-014',
    required: false,
    categoryKeys: ['cctv'],
  },
  {
    key: 'door_reader',
    labelEn: 'Door / reader number',
    labelAr: 'رقم الباب / القارئ',
    type: 'TEXT',
    placeholderEn: 'e.g. Turnstile 2 or RDR-203',
    placeholderAr: 'مثال: البوابة الدوارة 2 أو RDR-203',
    required: false,
    categoryKeys: ['access'],
  },
  {
    key: 'panel_zone',
    labelEn: 'Panel / zone',
    labelAr: 'اللوحة / المنطقة',
    type: 'TEXT',
    placeholderEn: 'e.g. FACP-03 / Zone 12',
    placeholderAr: 'مثال: FACP-03 / المنطقة 12',
    required: false,
    categoryKeys: ['life'],
  },
  {
    key: 'server_hostname',
    labelEn: 'Server hostname',
    labelAr: 'اسم الخادم',
    type: 'TEXT',
    placeholderEn: 'e.g. srv-114.corp.local',
    placeholderAr: 'مثال: srv-114.corp.local',
    required: false,
    categoryKeys: ['dc'],
  },
  {
    key: 'room_name',
    labelEn: 'Room name',
    labelAr: 'اسم القاعة',
    type: 'TEXT',
    placeholderEn: 'e.g. Meeting room 2.14',
    placeholderAr: 'مثال: قاعة الاجتماعات 2.14',
    required: false,
    categoryKeys: ['av'],
  },
];

import type { AppLocale } from '@/i18n/config';
import type admin from './messages/en/admin.json';
import type adminComms from './messages/en/admin-comms.json';
import type adminPeople from './messages/en/admin-people.json';
import type adminSetup from './messages/en/admin-setup.json';
import type adminSla from './messages/en/admin-sla.json';
import type auth from './messages/en/auth.json';
import type common from './messages/en/common.json';
import type consoleMessages from './messages/en/console.json';
import type errors from './messages/en/errors.json';
import type portal from './messages/en/portal.json';
import type tickets from './messages/en/tickets.json';
import type validation from './messages/en/validation.json';

declare module 'next-intl' {
  interface AppConfig {
    Locale: AppLocale;
    Messages: {
      common: typeof common;
      auth: typeof auth;
      validation: typeof validation;
      errors: typeof errors;
      portal: typeof portal;
      tickets: typeof tickets;
      console: typeof consoleMessages;
      admin: typeof admin;
      'admin-setup': typeof adminSetup;
      'admin-sla': typeof adminSla;
      'admin-people': typeof adminPeople;
      'admin-comms': typeof adminComms;
    };
  }
}

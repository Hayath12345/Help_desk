export {
  escapeHtml,
  interpolate,
  templateVariables,
  type InterpolateOptions,
  type TemplateValue,
  type TemplateVariables,
} from './interpolate.ts';
export {
  directionFor,
  emailColors,
  emailFontStacks,
  layoutStrings,
  type TextDirection,
} from './theme.ts';
export { EmailLayout, type EmailLayoutProps } from './layout.tsx';
export {
  renderTemplateEmail,
  type EmailCta,
  type RenderTemplateEmailInput,
  type RenderedEmail,
} from './render.tsx';
export {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KEYS,
  defaultCtaLabel,
  pickTemplateText,
  type DefaultEmailTemplate,
  type EmailTemplateKey,
  type EmailTemplateText,
  type LocalizedTemplateText,
} from './defaults.ts';

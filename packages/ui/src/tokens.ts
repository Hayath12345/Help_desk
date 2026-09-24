// Loons Help Desk design tokens — extracted from design/Loons Help Desk_final.html.
//
// This is the single source of truth for colour values. `tokens.css` exposes the same values
// as CSS variables + Tailwind theme tokens for the web app; email templates (which cannot use
// CSS variables) import the values from here. Keep the two files in sync
// (apps/web/components/common/design-tokens.test.ts checks it).
//
// Contrast: every pair used for text reaches WCAG AA (4.5:1), so a few foregrounds are a shade
// darker than the design file (success, Closed / Away, P2, note ink — see tokens.css).

export const palette = {
  // Neutrals
  page: '#f7f7f8', // app background
  surface: '#ffffff', // cards, top bar, inputs
  surfaceMuted: '#fafafa', // thread background, row hover
  surfaceSunken: '#f4f4f5', // segmented controls, secondary button hover
  ink: '#18181b', // primary text, inverse surfaces (toast, bulk bar)
  inkSecondary: '#52525b', // secondary text
  inkMuted: '#71717a', // labels, meta text
  inkSubtle: '#a1a1aa', // on light surfaces decoration only (icons, dots, dividers): 2.4–2.6:1
  inkMutedOnSunken: '#6e6e77', // muted text on surfaceSunken (Away pill, Closed status)
  inkInverseMuted: '#3f3f46', // buttons on inverse surfaces
  border: '#e7e7ea', // card / layout borders
  borderInput: '#e0e0e4', // input + secondary button borders
  divider: '#f0f0f2', // list row separators
  track: '#ececee', // progress tracks, neutral avatars
  borderDashed: '#d4d4d8', // dashed drop zones

  // Primary (royal blue)
  primary: '#4063d8',
  primaryHover: '#3553c2',
  primaryInk: '#2f4fb8', // links, text on primary tints
  primaryTint: '#eaf0ff', // focus ring, OPEN status, agent tag
  primarySoft: '#e3ebff', // avatars
  primaryBorder: '#c7d2fe', // card hover border
  primaryWash: '#eef3ff', // selected list row, active drop zone
  primaryWashSubtle: '#f5f8ff', // checked table row
  selection: '#dbe4ff',

  // Feedback
  danger: '#c43232', // error text, P1 text
  dangerTint: '#fdecec',
  dangerStrong: '#e04444', // invalid input border, overdue bar, P1 dot
  dangerAlert: '#c42b2b', // P1 banner background
  dangerAlertInk: '#a11d1d', // text on the white button inside the P1 banner
  overdue: '#d93b3b', // overdue / breached figures
  success: '#1a7d4a', // design #1a7f4b (4.49:1 on successTint)
  successTint: '#e6f6ec',
  successStrong: '#1f9d5c', // on-track SLA, online dot
  warning: '#d9722b', // SLA at-risk text
  warningStrong: '#e0892b', // SLA at-risk bar

  // Internal notes (yellow)
  noteBg: '#fdf6dc',
  noteBorder: '#f1dc9b',
  noteTag: '#fcefc2',
  noteInk: '#87670a', // design #8a6a0a (4.41:1 on noteTag)
  noteInkStrong: '#6b5206', // security checklist text
  noteComposer: '#fffbeb',

  // Google brand (sign-in button only)
  googleBlue: '#4285f4',
} as const;

export const statusColors = {
  NEW: { bg: palette.surfaceSunken, fg: palette.inkSecondary },
  OPEN: { bg: palette.primaryTint, fg: palette.primaryInk },
  PENDING: { bg: '#fdf3d1', fg: palette.noteInk },
  SOLVED: { bg: palette.successTint, fg: palette.success },
  CLOSED: { bg: palette.surfaceSunken, fg: palette.inkMutedOnSunken },
} as const;

export const priorityColors = {
  P1: { bg: palette.dangerTint, fg: palette.danger, dot: palette.dangerStrong },
  P2: { bg: '#fdf1e3', fg: '#a95913', dot: palette.warningStrong }, // fg: design #b45f14 (4.11:1)
  P3: { bg: palette.primaryTint, fg: palette.primaryInk, dot: '#6f8fe6' },
  P4: { bg: palette.surfaceSunken, fg: palette.inkSecondary, dot: palette.inkSubtle },
} as const;

export const fonts = {
  sans: "Geist, 'IBM Plex Sans Arabic', system-ui, sans-serif",
  mono: "'Geist Mono', ui-monospace, monospace",
} as const;

export const radii = {
  sm: '6px', // pills, tags
  md: '8px', // buttons, inputs
  lg: '10px', // segmented controls, menus, bubbles
  xl: '12px', // cards
  '2xl': '14px', // auth card, modals
} as const;

export const motion = {
  /** 150–250 ms, ease-out (spec §1). */
  durationFast: 0.15,
  duration: 0.2,
  durationSlow: 0.25,
  /** Toast enter / exit (tokens.css `--duration-toast`). */
  durationToast: 0.2,
  /** tokens.css `--ease-out-soft`. */
  ease: [0.16, 1, 0.3, 1] as const,
} as const;

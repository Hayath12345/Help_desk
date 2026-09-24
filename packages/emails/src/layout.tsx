/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Pragmas: consumers compile this package with their own tsconfig (tsx only applies a
// tsconfig to its own `include`), so the JSX runtime is pinned per file.
import type { CSSProperties, ReactNode } from 'react';
import { Body, Container, Head, Hr, Html, Preview, Section, Text } from '@react-email/components';
import type { Locale } from '@loons/shared';
import {
  directionFor,
  emailColors,
  emailFontStacks,
  emailRadii,
  layoutStrings,
  type TextDirection,
} from './theme.ts';

export interface EmailLayoutProps {
  locale: Locale;
  /** Inbox preview line (hidden in the body). */
  preview?: string;
  children: ReactNode;
}

/** Physical side for the current direction — mail clients ignore logical CSS properties. */
function startSide(dir: TextDirection): 'left' | 'right' {
  return dir === 'rtl' ? 'right' : 'left';
}

export function textStyle(dir: TextDirection, overrides: CSSProperties = {}): CSSProperties {
  return {
    margin: '0 0 16px',
    fontSize: '15px',
    lineHeight: '1.6',
    color: emailColors.ink,
    textAlign: startSide(dir),
    ...overrides,
  };
}

/** The brand mark from the design: a black rounded square followed by "Loons Help Desk". */
function Brand({ dir, label }: { dir: TextDirection; label: string }) {
  const gap = dir === 'rtl' ? { paddingRight: '10px' } : { paddingLeft: '10px' };
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0} dir={dir}>
      <tbody>
        <tr>
          <td style={{ verticalAlign: 'middle' }}>
            <div
              style={{
                width: '24px',
                height: '24px',
                borderRadius: emailRadii.logo,
                backgroundColor: emailColors.ink,
              }}
            />
          </td>
          <td
            style={{
              ...gap,
              verticalAlign: 'middle',
              fontSize: '18px',
              fontWeight: 600,
              color: emailColors.ink,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Branded shell shared by every transactional email: page background, brand mark, white card,
 * automated-message footer. `dir="rtl"` and an Arabic font stack are applied for `ar`.
 */
export function EmailLayout({ locale, preview, children }: EmailLayoutProps) {
  const dir = directionFor(locale);
  const strings = layoutStrings[locale];
  const fontFamily = emailFontStacks[locale];

  return (
    <Html lang={locale} dir={dir}>
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      {preview ? <Preview>{preview}</Preview> : null}
      <Body
        dir={dir}
        style={{
          margin: 0,
          padding: '32px 12px',
          backgroundColor: emailColors.page,
          fontFamily,
          color: emailColors.ink,
        }}
      >
        <Container dir={dir} style={{ maxWidth: '560px', width: '100%', margin: '0 auto' }}>
          <Section style={{ padding: '0 4px 20px' }}>
            <Brand dir={dir} label={strings.brand} />
          </Section>
          <Section
            dir={dir}
            style={{
              backgroundColor: emailColors.surface,
              border: `1px solid ${emailColors.border}`,
              borderRadius: emailRadii.card,
              padding: '28px',
            }}
          >
            {children}
          </Section>
          <Section style={{ padding: '20px 4px 0' }}>
            <Hr style={{ borderColor: emailColors.border, margin: '0 0 16px' }} />
            <Text
              style={textStyle(dir, {
                fontSize: '12px',
                color: emailColors.inkSubtle,
                margin: '0 0 4px',
              })}
            >
              {strings.automated}
            </Text>
            <Text
              style={textStyle(dir, { fontSize: '12px', color: emailColors.inkSubtle, margin: 0 })}
            >
              {strings.footer}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

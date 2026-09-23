/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Pragmas: consumers compile this package with their own tsconfig (tsx only applies a
// tsconfig to its own `include`), so the JSX runtime is pinned per file.
import { Fragment, type ReactNode } from 'react';
import { Button, Heading, Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import type { Locale } from '@loons/shared';
import { interpolate, type TemplateVariables } from './interpolate.ts';
import { EmailLayout, textStyle } from './layout.tsx';
import { directionFor, emailColors, emailRadii, layoutStrings, type TextDirection } from './theme.ts';

export interface EmailCta {
  /** Button label; may contain `{{variables}}`. */
  label: string;
  /** Button target; may contain `{{variables}}`. Only absolute http(s) URLs are rendered. */
  url: string;
}

export interface RenderTemplateEmailInput {
  locale: Locale;
  /** Subject template (plain text with `{{variables}}`). */
  subject: string;
  /** Body template: plain text, paragraphs separated by blank lines, `{{variables}}` allowed. */
  body: string;
  variables?: TemplateVariables;
  cta?: EmailCta;
  /** Inbox preview line; defaults to the first paragraph of the body. */
  preview?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface ResolvedCta {
  label: string;
  url: string;
  /** False when the body already shows the URL (e.g. an admin template with {{resetUrl}}). */
  showLinkFallback: boolean;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Blank-line separated paragraphs, each split into lines. */
function toParagraphs(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.split('\n').map((line) => line.trimEnd()));
}

/** Text with bare URLs turned into links. React escapes every text node. */
function linkify(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of line.matchAll(URL_IN_TEXT)) {
    const href = safeHttpUrl(match[0]);
    if (!href) continue;
    if (match.index > last) nodes.push(line.slice(last, match.index));
    nodes.push(
      <Link
        key={`${keyPrefix}-${i++}`}
        href={href}
        style={{ color: emailColors.primaryInk, textDecoration: 'underline', wordBreak: 'break-all' }}
      >
        {match[0]}
      </Link>,
    );
    last = match.index + match[0].length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
}

function Paragraph({ lines, dir, index }: { lines: string[]; dir: TextDirection; index: number }) {
  return (
    <Text style={textStyle(dir)}>
      {lines.map((line, li) => (
        <Fragment key={li}>
          {li > 0 ? <br /> : null}
          {linkify(line, `p${index}-l${li}`)}
        </Fragment>
      ))}
    </Text>
  );
}

function TemplateEmail({
  locale,
  subject,
  paragraphs,
  cta,
  preview,
}: {
  locale: Locale;
  subject: string;
  paragraphs: string[][];
  cta: ResolvedCta | null;
  preview: string;
}) {
  const dir = directionFor(locale);
  const strings = layoutStrings[locale];
  const align = dir === 'rtl' ? 'right' : 'left';
  return (
    <EmailLayout locale={locale} preview={preview}>
      <Heading
        as="h1"
        style={{
          margin: '0 0 20px',
          fontSize: '20px',
          lineHeight: '1.35',
          fontWeight: 600,
          color: emailColors.ink,
          textAlign: align,
        }}
      >
        {subject}
      </Heading>
      {paragraphs.map((lines, index) => (
        <Paragraph key={index} lines={lines} dir={dir} index={index} />
      ))}
      {cta ? (
        <>
          <Section style={{ padding: '8px 0 20px', textAlign: align }}>
            <Button
              href={cta.url}
              style={{
                display: 'inline-block',
                backgroundColor: emailColors.primary,
                color: emailColors.onPrimary,
                borderRadius: emailRadii.button,
                padding: '11px 20px',
                fontSize: '14px',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              {cta.label}
            </Button>
          </Section>
          {cta.showLinkFallback ? (
            <>
              <Text style={textStyle(dir, { fontSize: '13px', color: emailColors.inkMuted, margin: '0 0 4px' })}>
                {strings.linkFallback}
              </Text>
              <Text style={textStyle(dir, { fontSize: '13px', margin: 0 })}>
                <Link href={cta.url} dir="ltr" style={{ color: emailColors.primaryInk, wordBreak: 'break-all' }}>
                  {cta.url}
                </Link>
              </Text>
            </>
          ) : null}
        </>
      ) : null}
    </EmailLayout>
  );
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Renders an admin-editable template (subject + plain-text body with `{{variables}}`) inside the
 * branded layout. Returns the final subject, the HTML part and a plain-text alternative.
 * Variable values are HTML-escaped in the HTML part (React escapes every text node) and
 * newlines are stripped from the subject.
 */
export async function renderTemplateEmail(input: RenderTemplateEmailInput): Promise<RenderedEmail> {
  const vars = input.variables ?? {};
  const subject = oneLine(interpolate(input.subject, vars));
  const bodyText = interpolate(input.body, vars);
  const paragraphs = toParagraphs(bodyText);

  let cta: ResolvedCta | null = null;
  if (input.cta) {
    const url = safeHttpUrl(interpolate(input.cta.url, vars));
    const label = oneLine(interpolate(input.cta.label, vars));
    if (url && label) {
      const shown = bodyText.includes(url) || bodyText.includes(interpolate(input.cta.url, vars).trim());
      cta = { url, label, showLinkFallback: !shown };
    }
  }

  const preview = oneLine(
    input.preview !== undefined ? interpolate(input.preview, vars) : (paragraphs[0]?.join(' ') ?? ''),
  ).slice(0, 140);

  const html = await render(
    <TemplateEmail
      locale={input.locale}
      subject={subject}
      paragraphs={paragraphs}
      cta={cta}
      preview={preview}
    />,
  );

  const strings = layoutStrings[input.locale];
  const textParts = [
    subject,
    ...paragraphs.map((lines) => lines.join('\n')),
    ...(cta?.showLinkFallback ? [`${cta.label}: ${cta.url}`] : []),
    '—',
    `${strings.automated}\n${strings.footer}`,
  ];

  return { subject, html, text: textParts.join('\n\n') };
}

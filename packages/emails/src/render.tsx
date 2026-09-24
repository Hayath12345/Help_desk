/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Pragmas: consumers compile this package with their own tsconfig (tsx only applies a
// tsconfig to its own `include`), so the JSX runtime is pinned per file.
import { Fragment, type ReactNode } from 'react';
import { Button, Heading, Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import type { Locale } from '@loons/shared';
import { interpolate, parseTemplate, variableText, type TemplateVariables } from './interpolate.ts';
import { EmailLayout, textStyle } from './layout.tsx';
import { directionFor, emailColors, emailRadii, layoutStrings, type TextDirection } from './theme.ts';

export interface EmailCta {
  /** Button label; may contain `{{variables}}`. */
  label: string;
  /** Button target; may contain `{{variables}}`. Only absolute http(s) URLs are rendered. */
  url: string;
}

/**
 * Variables that carry links the app builds itself (never user input). In the body, only these
 * values and the template's own text are turned into clickable links; every other value (names,
 * subjects, message text…) is shown as plain text on one line, so a URL typed into a name can't
 * become a link in an official email.
 */
export const LINK_VARIABLES = [
  'resetUrl',
  'verifyUrl',
  'signInUrl',
  'portalUrl',
  'ticketUrl',
  'ackUrl',
  'consoleUrl',
  'queueUrl',
] as const;
const LINK_VARIABLE_NAMES: ReadonlySet<string> = new Set(LINK_VARIABLES);

export interface RenderTemplateEmailInput {
  locale: Locale;
  /** Subject template (plain text with `{{variables}}`). */
  subject: string;
  /**
   * Body template: plain text, paragraphs separated by blank lines, `{{variables}}` allowed.
   * Bare URLs in the template text and in `LINK_VARIABLES` values become links.
   */
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

/** A piece of one body line: template text / link variables (linkified) or a plain value. */
interface Run {
  text: string;
  linkify: boolean;
}
type Line = Run[];

function lineText(line: Line): string {
  return line.map((run) => run.text).join('');
}

function trimLine(line: Line, { start }: { start: boolean }): Line {
  const runs = line.map((run) => ({ ...run }));
  while (start && runs[0]) {
    runs[0].text = runs[0].text.trimStart();
    if (runs[0].text !== '') break;
    runs.shift();
  }
  for (let last = runs.at(-1); last; last = runs.at(-1)) {
    last.text = last.text.trimEnd();
    if (last.text !== '') break;
    runs.pop();
  }
  return runs;
}

/**
 * The body as blank-line separated paragraphs of lines. Only the template's own text can break
 * lines or paragraphs: substituted values are collapsed onto one line.
 */
function toParagraphs(body: string, vars: TemplateVariables): Line[][] {
  const lines: Line[] = [[]];
  for (const part of parseTemplate(body.replace(/\r\n?/g, '\n'))) {
    if (part.type === 'variable') {
      const text = oneLine(variableText(vars, part.name));
      if (text) lines.at(-1)?.push({ text, linkify: LINK_VARIABLE_NAMES.has(part.name) });
      continue;
    }
    part.text.split('\n').forEach((text, i) => {
      if (i > 0) lines.push([]);
      if (text) lines.at(-1)?.push({ text, linkify: true });
    });
  }

  // Whitespace-only lines separate paragraphs; each paragraph is trimmed, each line right-trimmed.
  const paragraphs: Line[][] = [];
  let current: Line[] = [];
  for (const line of [...lines, []]) {
    if (lineText(line).trim() !== '') {
      current.push(trimLine(line, { start: current.length === 0 }));
    } else if (current.length > 0) {
      paragraphs.push(current);
      current = [];
    }
  }
  return paragraphs;
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

function Paragraph({ lines, dir, index }: { lines: Line[]; dir: TextDirection; index: number }) {
  return (
    <Text style={textStyle(dir)}>
      {lines.map((line, li) => (
        <Fragment key={li}>
          {li > 0 ? <br /> : null}
          {line.map((run, ri) =>
            run.linkify ? (
              <Fragment key={ri}>{linkify(run.text, `p${index}-l${li}-r${ri}`)}</Fragment>
            ) : (
              run.text
            ),
          )}
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
  paragraphs: Line[][];
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
 * Variable values are HTML-escaped in the HTML part (React escapes every text node), kept on one
 * line, and only linkified for `LINK_VARIABLES`; newlines are stripped from the subject.
 */
export async function renderTemplateEmail(input: RenderTemplateEmailInput): Promise<RenderedEmail> {
  const vars = input.variables ?? {};
  const subject = oneLine(interpolate(input.subject, vars));
  const paragraphs = toParagraphs(input.body, vars);
  const paragraphTexts = paragraphs.map((lines) => lines.map(lineText).join('\n'));
  const bodyText = paragraphTexts.join('\n\n');

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
    input.preview !== undefined ? interpolate(input.preview, vars) : (paragraphTexts[0] ?? ''),
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
    ...paragraphTexts,
    ...(cta?.showLinkFallback ? [`${cta.label}: ${cta.url}`] : []),
    '—',
    `${strings.automated}\n${strings.footer}`,
  ];

  return { subject, html, text: textParts.join('\n\n') };
}

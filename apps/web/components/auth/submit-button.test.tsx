// @vitest-environment jsdom
// UI-RR-1: a pending submit button must keep keyboard focus (so it is never `disabled` while
// pending) and must not submit twice. The invalid-link card that replaces the Confirm form moves
// focus to "Request a new link" instead of leaving it on <body>.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import enAuth from '@/messages/en/auth.json';
import { InvalidEmailLinkCard } from './confirm-email';
import { SubmitButton } from './submit-button';

// The cards file imports server actions and the browser token cache, which can't load outside Next.
vi.mock('@/app/actions/auth', () => ({
  confirmEmailAction: vi.fn(),
  signOutToConfirmEmailAction: vi.fn(),
}));
vi.mock('@/lib/api/browser', () => ({ clearApiToken: vi.fn() }));

afterEach(cleanup);

function withIntl(ui: React.ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={{ auth: enAuth }} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function Form({ pending, onSubmit }: { pending: boolean; onSubmit: () => void }) {
  return withIntl(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input aria-label="Email" name="email" />
      <SubmitButton pending={pending}>Resend email</SubmitButton>
    </form>,
  );
}

describe('SubmitButton (UI-RR-1)', () => {
  it('keeps keyboard focus while pending: aria-disabled + aria-busy, never disabled', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<Form pending={false} onSubmit={onSubmit} />);
    const button = screen.getByRole('button', { name: 'Resend email' });
    act(() => button.focus());
    expect(document.activeElement).toBe(button);

    rerender(<Form pending onSubmit={onSubmit} />);
    const pending = screen.getByRole('button', { name: /Resend email/ });
    expect(pending).toBe(button); // same element: nothing was re-mounted
    expect(document.activeElement).toBe(button);
    expect(button).toHaveProperty('disabled', false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Please wait…');

    rerender(<Form pending={false} onSubmit={onSubmit} />);
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('blocks a second submit while pending, and submits normally otherwise', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<Form pending={false} onSubmit={onSubmit} />);
    const button = screen.getByRole('button', { name: 'Resend email' });
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(<Form pending onSubmit={onSubmit} />);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(<Form pending={false} onSubmit={onSubmit} />);
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('still honours an explicit disabled prop and its own onClick', () => {
    const onClick = vi.fn();
    render(
      withIntl(
        <>
          <SubmitButton disabled>Off</SubmitButton>
          <SubmitButton onClick={onClick}>On</SubmitButton>
        </>,
      ),
    );
    expect(screen.getByRole('button', { name: 'Off' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'On' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('InvalidEmailLinkCard focus', () => {
  it('moves focus to "Request a new link" when it replaces the Confirm form', () => {
    render(withIntl(<InvalidEmailLinkCard requestNewHref="/verify-email" signedIn focusLink />));
    const link = screen.getByRole('link', { name: 'Request a new link' });
    expect(document.activeElement).toBe(link);
    expect(link.getAttribute('href')).toBe('/verify-email');
    expect(
      screen.getByRole('heading', { name: 'This link is invalid or has expired' }),
    ).toBeTruthy();
  });

  it('leaves focus alone when rendered as the page itself', () => {
    render(withIntl(<InvalidEmailLinkCard requestNewHref="/login" signedIn={false} />));
    expect(document.activeElement).toBe(document.body);
  });
});

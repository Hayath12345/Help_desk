'use client';

import { useTranslations } from 'next-intl';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react';

// Design toast: inverse ink surface, white 14px text, 10px radius, soft drop shadow.
// Motion (200 ms ease-out, off under reduced motion) is set in app/globals.css.
const Toaster = ({ ...props }: ToasterProps) => {
  const t = useTranslations('common');
  return (
    <Sonner
      theme="light"
      className="toaster group"
      // The landmark is announced as "<label> alt+T"; sonner's default label is English-only.
      containerAriaLabel={t('notifications')}
      icons={{
        success: <CircleCheckIcon className="size-4 text-success-strong" />,
        info: <InfoIcon className="size-4 text-ink-subtle" />,
        warning: <TriangleAlertIcon className="size-4 text-warning-strong" />,
        error: <OctagonXIcon className="size-4 text-danger-strong" />,
        loading: <Loader2Icon className="size-4 animate-spin text-ink-subtle" />,
      }}
      style={
        {
          '--normal-bg': 'var(--color-ink)',
          '--normal-text': 'var(--color-surface)',
          '--normal-border': 'var(--color-ink)',
          '--border-radius': 'var(--radius-lg)',
          '--width': 'min(360px, calc(100vw - 32px))',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast font-sans text-sm shadow-toast! px-4! py-2.5!',
          description: 'text-ink-subtle!',
          actionButton: 'bg-brand! text-primary-foreground!',
          cancelButton: 'bg-ink-inverse-muted! text-primary-foreground!',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };

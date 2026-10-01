'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Tabs as TabsPrimitive } from 'radix-ui';

// Two looks from the design:
//  - "line"    → underline tabs (My tickets, Team queue, composer modes): 2px ink underline on the active tab.
//  - "default" → segmented control (status / ticket type): sunken track, white active segment.

function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('group/tabs flex gap-2 data-horizontal:flex-col', className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit items-center text-ink-muted group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:items-stretch',
  {
    variants: {
      variant: {
        default:
          'justify-center gap-0.5 rounded-lg bg-surface-sunken p-[3px] group-data-horizontal/tabs:h-9',
        line: 'gap-5 border-b border-line bg-transparent group-data-vertical/tabs:gap-1 group-data-vertical/tabs:border-e group-data-vertical/tabs:border-b-0',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function TabsList({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex cursor-pointer items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap text-ink-muted transition-[color,background-color,border-color,box-shadow] duration-150 ease-out hover:text-ink disabled:pointer-events-none disabled:opacity-50 data-active:text-ink [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // segmented
        'group-data-[variant=default]/tabs-list:h-full group-data-[variant=default]/tabs-list:flex-1 group-data-[variant=default]/tabs-list:rounded-md group-data-[variant=default]/tabs-list:px-2.5 group-data-[variant=default]/tabs-list:text-[13px] group-data-[variant=default]/tabs-list:text-ink-secondary group-data-[variant=default]/tabs-list:data-active:bg-surface group-data-[variant=default]/tabs-list:data-active:text-ink group-data-[variant=default]/tabs-list:data-active:shadow-segment',
        // underline; forced colours paint a transparent border in the text colour, so there the
        // inactive tabs' line takes the background colour and the active one Highlight
        'forced-colors:border-[Canvas]! forced-colors:data-active:border-[Highlight]!',
        'group-data-[variant=line]/tabs-list:border-transparent group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:-mb-px group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:border-b-2 group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:pb-2 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:-me-px group-data-vertical/tabs:group-data-[variant=line]/tabs-list:justify-start group-data-vertical/tabs:group-data-[variant=line]/tabs-list:border-e-2 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:py-1.5 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:pe-3 group-data-[variant=line]/tabs-list:data-active:border-ink',
        className,
      )}
      {...props}
    />
  );
}

// Radix always makes the panel a tab stop (tabIndex 0), so it keeps the visible focus outline
// (the global 2px brand ring). Round it (e.g. `rounded-xl`) when the panel wraps a card.
function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        'flex-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };

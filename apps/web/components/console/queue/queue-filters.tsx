'use client';

import {
  PRIORITIES,
  UNASSIGNED_FILTER,
  type Priority,
  type QueueFilterOptions,
  type TicketSummaryDto,
  type WorkloadAgent,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { intlLocale, isolate } from '@/lib/format';
import type { QueueState } from '@/lib/queue/url';
import { localizedLabel } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';

/** Radix Select can't hold an empty value: "any" stands for "no filter". */
const ANY = '__any__';

/**
 * Design 921–931: quiet selects (transparent border, 3px 4px padding, border on hover). The
 * trigger keeps the filter's name ("Priority: P1 Critical") so a chosen value still says what it
 * filters (F4).
 */
const QUIET_TRIGGER =
  'max-w-[min(18rem,100%)] min-w-0 rounded-sm border-transparent bg-transparent text-sm text-ink-secondary shadow-none hover:border-line data-[size=sm]:h-7 data-[size=sm]:py-[3px] data-[size=sm]:ps-1 data-[size=sm]:pe-1';

interface Option {
  value: string;
  label: string;
}

function FilterSelect({
  name,
  label,
  value,
  anyLabel,
  valueLabel,
  options,
  onValueChange,
}: {
  /** Identifies the select in styles (`data-filter`). */
  name: string;
  /**
   * The select's accessible name ("Priority filter"): a combobox is not named by its text, which
   * screen readers announce as its value ("Priority: P1 Critical").
   */
  label: string;
  value: string | null;
  /** "Priority: any" — the trigger and the first option. */
  anyLabel: string;
  /** "Priority: {value}" for the chosen option's label. */
  valueLabel: (label: string) => string;
  options: readonly Option[];
  onValueChange: (value: string | null) => void;
}) {
  const selected = value ? options.find((o) => o.value === value) : undefined;
  return (
    <Select
      value={value ?? ANY}
      onValueChange={(next) => {
        const normalized = next === ANY ? null : next;
        if (normalized !== value) onValueChange(normalized);
      }}
    >
      <SelectTrigger
        size="sm"
        data-filter={name}
        aria-label={label}
        className={cn(QUIET_TRIGGER, value && 'text-ink')}
      >
        <SelectValue>{selected ? valueLabel(selected.label) : anyLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="max-h-80 max-w-[min(360px,90vw)]">
        <SelectItem value={ANY}>{anyLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface QueueFiltersProps {
  state: Pick<QueueState, 'priority' | 'categoryId' | 'assigneeId'>;
  /** GET /tickets/filter-options (active categories, then archived ones in use). */
  categories: QueueFilterOptions['categories'] | undefined;
  /** GET /tickets/workload agents (the Assignee options besides "Unassigned"). */
  agents: readonly WorkloadAgent[] | undefined;
  /** Loaded rows: they name a filter value the options don't list (e.g. from a shared link). */
  rows: readonly TicketSummaryDto[];
  onChange: (patch: {
    priority?: Priority | null;
    categoryId?: string | null;
    assigneeId?: string | null;
  }) => void;
  className?: string;
}

/**
 * Priority / Category / Assignee filters (F4). Changes apply at once; the page writes them to
 * the URL. Category lists archived categories that still have tickets, marked "(archived)";
 * Assignee lists "Unassigned" and the people of the agent cards.
 */
export function QueueFilters({
  state,
  categories,
  agents,
  rows,
  onChange,
  className,
}: QueueFiltersProps) {
  const t = useTranslations('console.queue.filters');
  const tQueue = useTranslations('console.queue');
  const tPriority = useTranslations('common.priority');
  const locale = useLocale();

  const priorityOptions: Option[] = PRIORITIES.map((p) => ({ value: p, label: tPriority(p) }));

  const categoryOptions: Option[] = (categories ?? []).map((category) => {
    const label = localizedLabel(category, locale);
    return { value: category.id, label: category.isActive ? label : t('archived', { label }) };
  });
  if (state.categoryId && !categoryOptions.some((o) => o.value === state.categoryId)) {
    const fromRow = rows.find((row) => row.category.id === state.categoryId)?.category;
    categoryOptions.push({
      value: state.categoryId,
      label: fromRow ? localizedLabel(fromRow, locale) : t('unknownCategory'),
    });
  }

  const collator = new Intl.Collator(intlLocale(locale));
  const assigneeOptions: Option[] = [
    { value: UNASSIGNED_FILTER, label: t('unassigned') },
    ...[...(agents ?? [])]
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((agent) => ({ value: agent.id, label: agent.name })),
  ];
  if (state.assigneeId && !assigneeOptions.some((o) => o.value === state.assigneeId)) {
    const fromRow = rows.find((row) => row.assignee?.id === state.assigneeId)?.assignee;
    assigneeOptions.push({
      value: state.assigneeId,
      label: fromRow?.name ?? t('unknownAssignee'),
    });
  }

  return (
    <div
      role="group"
      aria-label={tQueue('filtersLabel')}
      className={cn('flex min-w-0 flex-wrap gap-1.5', className)}
    >
      <FilterSelect
        name="priority"
        label={t('priorityLabel')}
        value={state.priority}
        anyLabel={t('priorityAny')}
        valueLabel={(value) => t('priority', { value })}
        options={priorityOptions}
        onValueChange={(value) => onChange({ priority: value as Priority | null })}
      />
      <FilterSelect
        name="category"
        label={t('categoryLabel')}
        value={state.categoryId}
        anyLabel={t('categoryAny')}
        valueLabel={(value) => t('category', { value: isolate(value) })}
        options={categoryOptions}
        onValueChange={(value) => onChange({ categoryId: value })}
      />
      <FilterSelect
        name="assignee"
        label={t('assigneeLabel')}
        value={state.assigneeId}
        anyLabel={t('assigneeAny')}
        valueLabel={(value) => t('assignee', { value: isolate(value) })}
        options={assigneeOptions}
        onValueChange={(value) => onChange({ assigneeId: value })}
      />
    </div>
  );
}

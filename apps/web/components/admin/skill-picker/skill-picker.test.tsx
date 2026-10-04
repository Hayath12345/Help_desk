// @vitest-environment jsdom
import { SKILLS_PER_LINK_MAX, type SkillAdminDto, type SkillRef } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminKeys } from '@/lib/admin';
import { ApiRequestError } from '@/lib/api/errors';
import arAdmin from '@/messages/ar/admin.json';
import arTickets from '@/messages/ar/tickets.json';
import enAdmin from '@/messages/en/admin.json';
import enTickets from '@/messages/en/tickets.json';
import { stubBrowserApis } from '../sections/teams/people-test-utils';
import { ACTIVE_SKILLS_PARAMS, sameSkillIds, sortedSkillIds } from './data';
import { SkillChips, SkillPicker } from './skill-picker';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/browser', () => ({
  apiClient: { get: api.get, request: vi.fn() },
  getApiToken: vi.fn(async () => 'token'),
  clearApiToken: vi.fn(),
}));

const STAMP = '2026-09-29T10:00:00.000Z';
const MESSAGES = {
  en: { admin: enAdmin, tickets: enTickets },
  ar: { admin: arAdmin, tickets: arTickets },
};

function skill(n: number, labelEn: string, overrides: Partial<SkillAdminDto> = {}): SkillAdminDto {
  return {
    id: `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`,
    key: `skill_${n}`,
    labelEn,
    labelAr: '',
    isActive: true,
    staffCount: 0,
    categoryCount: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}
const ref = ({ id, key, labelEn, labelAr, isActive }: SkillAdminDto): SkillRef => ({
  id,
  key,
  labelEn,
  labelAr,
  isActive,
});

beforeAll(stubBrowserApis);
beforeEach(() => api.get.mockReset());
afterEach(cleanup);

/** The picker with its own state, over a catalog already in the cache (no request). */
function Harness({
  initial = [],
  linked,
  onChange,
}: {
  initial?: string[];
  linked?: readonly SkillRef[];
  onChange?: (ids: string[]) => void;
}) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <SkillPicker
      id="picker"
      label="Skills"
      hint="Pick some."
      value={value}
      linked={linked}
      onChange={(ids) => {
        setValue(ids);
        onChange?.(ids);
      }}
      empty="Nothing to pick."
      limitNote="At most 30."
    />
  );
}

function renderPicker(
  ui: React.ReactElement,
  options: { catalog?: SkillAdminDto[]; locale?: 'en' | 'ar' } = {},
) {
  const locale = options.locale ?? 'en';
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.catalog) {
    queryClient.setQueryData(adminKeys.list('skills', ACTIVE_SKILLS_PARAMS), {
      items: options.catalog,
    });
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>{ui}</div>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('SkillPicker', () => {
  it('lists the catalog by name, ticks like a checklist and hands back sorted ids', () => {
    const net = skill(2, 'Network');
    const cctv = skill(1, 'CCTV');
    const onChange = vi.fn();
    renderPicker(<Harness onChange={onChange} />, { catalog: [net, cctv] });
    const group = screen.getByRole('group', { name: 'Skills' });
    expect(group.getAttribute('aria-describedby')).toContain('picker-hint');
    expect(
      within(group)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(['CCTV', 'Network']);

    fireEvent.click(within(group).getByRole('checkbox', { name: 'Network' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'CCTV' }));
    expect(onChange).toHaveBeenLastCalledWith([cctv.id, net.id].sort());
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Network' }));
    expect(onChange).toHaveBeenLastCalledWith([cctv.id]);
  });

  it('keeps an archived skill the row has listed and flagged, and lets it go', () => {
    const old = skill(3, 'Legacy PBX', { isActive: false });
    const onChange = vi.fn();
    renderPicker(<Harness initial={[old.id]} linked={[ref(old)]} onChange={onChange} />, {
      catalog: [skill(1, 'CCTV')],
    });
    const legacy = screen.getByRole('checkbox', { name: /Legacy PBX/ });
    expect(legacy.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Archived')).toBeTruthy();
    fireEvent.click(legacy);
    expect(onChange).toHaveBeenLastCalledWith([]);
    // Still listed (the choice can be undone before saving), now unticked.
    expect(screen.getByRole('checkbox', { name: /Legacy PBX/ }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('stops at the most a row may have: the rest are disabled and the note says so', () => {
    const catalog = Array.from({ length: SKILLS_PER_LINK_MAX + 1 }, (_, i) =>
      skill(i + 1, `Skill ${String(i + 1).padStart(2, '0')}`),
    );
    const initial = catalog.slice(0, SKILLS_PER_LINK_MAX).map((s) => s.id);
    renderPicker(<Harness initial={initial} />, { catalog });
    expect(screen.getByText('At most 30.')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.filter((box) => box.hasAttribute('disabled'))).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: 'Skill 31' }).hasAttribute('disabled')).toBe(true);
    // A ticked one can always be unticked, which lifts the limit.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Skill 01' }));
    expect(screen.queryByText('At most 30.')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Skill 31' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows the empty text when there is nothing to pick', () => {
    renderPicker(<Harness />, { catalog: [] });
    expect(screen.getByText('Nothing to pick.')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('shows the Arabic names in the Arabic UI, falling back to English when there is none', () => {
    renderPicker(<Harness />, {
      locale: 'ar',
      catalog: [skill(1, 'CCTV', { labelAr: 'كاميرات المراقبة' }), skill(2, 'VPN')],
    });
    expect(screen.getByRole('checkbox', { name: 'كاميرات المراقبة' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'VPN' })).toBeTruthy();
  });

  it('says when the catalog can’t be loaded and retries on request', async () => {
    api.get.mockRejectedValueOnce(new ApiRequestError(403, 'FORBIDDEN', 'no access'));
    api.get.mockResolvedValueOnce({ items: [skill(1, 'CCTV')] });
    renderPicker(<Harness />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(await screen.findByText('This list couldn’t be loaded.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('checkbox', { name: 'CCTV' })).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/admin/skills?status=active', expect.anything());
    await waitFor(() => expect(screen.queryByText('This list couldn’t be loaded.')).toBeNull());
  });
});

describe('SkillChips', () => {
  it('shows the first three active skills and counts the rest (named in the tooltip)', () => {
    const skills = [
      ref(skill(1, 'CCTV')),
      ref(skill(2, 'Network')),
      ref(skill(3, 'Old', { isActive: false })),
      ref(skill(4, 'VPN')),
      ref(skill(5, 'Wi-Fi')),
      ref(skill(6, 'Radio')),
    ];
    renderPicker(<SkillChips skills={skills} />);
    for (const name of ['CCTV', 'Network', 'VPN']) expect(screen.getByText(name)).toBeTruthy();
    expect(screen.queryByText('Old')).toBeNull();
    const more = screen.getByText('+2');
    expect(more.closest('[data-slot="badge"]')?.getAttribute('title')).toBe('Wi-Fi, Radio');
    expect(more.textContent).toContain('Wi-Fi, Radio');
  });

  it('shows a dash for none (archived ones don’t count)', () => {
    renderPicker(<SkillChips skills={[ref(skill(1, 'Old', { isActive: false }))]} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('skill id helpers', () => {
  it('compares selections whatever the order', () => {
    expect(sortedSkillIds([{ id: 'b' }, { id: 'a' }, { id: 'b' }])).toEqual(['a', 'b']);
    expect(sortedSkillIds(undefined)).toEqual([]);
    expect(sameSkillIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSkillIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameSkillIds([], [])).toBe(true);
  });
});

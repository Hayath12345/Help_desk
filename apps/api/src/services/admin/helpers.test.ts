import { describe, expect, it } from 'vitest';
import type { Actor } from '@loons/shared';
import { constraintFields } from '../../lib/prisma-errors.ts';
import {
  requireMacroAccess,
  requireMacroMove,
  requireMemberChange,
  requireMemberRoleChange,
  requireOnCallChange,
  requireSuperAdmin,
  requireTeamAccess,
  requireTeamSettings,
  teamScopeFilter,
} from './authz.ts';
import { generateKey } from './keys.ts';
import { macroReorderLabel } from './macros.ts';

const SOC = '00000000-0000-4000-8000-0000000000c1';
const NOC = '00000000-0000-4000-8000-0000000000c2';
const actor = (over: Partial<Actor>): Actor => ({
  id: 'u',
  role: 'AGENT',
  status: 'ACTIVE',
  orgId: null,
  teamIds: [],
  leadTeamIds: [],
  emailVerified: true,
  ...over,
});
const superAdmin = actor({ role: 'SUPER_ADMIN' });
const lead = actor({ role: 'TEAM_LEAD', teamIds: [SOC, NOC], leadTeamIds: [SOC] });

const status = (fn: () => void): number | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { statusCode: number }).statusCode;
  }
};

describe('admin authorisation helpers (E7)', () => {
  it('team leads: their teams only, MEMBER rows only, on-call yes, settings no', () => {
    expect(status(() => requireTeamAccess(lead, SOC))).toBe(null);
    expect(status(() => requireTeamAccess(lead, NOC))).toBe(403);
    expect(status(() => requireMemberChange(lead, SOC, 'MEMBER'))).toBe(null);
    expect(status(() => requireMemberChange(lead, SOC, 'LEAD'))).toBe(403);
    expect(status(() => requireMemberChange(lead, NOC, 'MEMBER'))).toBe(403);
    expect(status(() => requireMemberRoleChange(lead))).toBe(403);
    expect(status(() => requireOnCallChange(lead, SOC))).toBe(null);
    expect(status(() => requireOnCallChange(lead, NOC))).toBe(403);
    expect(status(() => requireTeamSettings(lead))).toBe(403);
    expect(status(() => requireSuperAdmin(lead))).toBe(403);
  });

  it('macros: team leads keep them in their team; global ones are super admin only', () => {
    expect(status(() => requireMacroAccess(lead, SOC))).toBe(null);
    expect(status(() => requireMacroAccess(lead, null))).toBe(403);
    expect(status(() => requireMacroMove(lead, SOC, SOC))).toBe(null);
    expect(status(() => requireMacroMove(lead, SOC, NOC))).toBe(403);
    expect(status(() => requireMacroMove(lead, SOC, null))).toBe(403);
    expect(status(() => requireMacroMove(lead, NOC, SOC))).toBe(403);
    expect(status(() => requireMacroMove(superAdmin, null, NOC))).toBe(null);
  });

  it('super admins pass everything', () => {
    for (const check of [
      () => requireSuperAdmin(superAdmin),
      () => requireTeamSettings(superAdmin),
      () => requireMemberChange(superAdmin, NOC, 'LEAD'),
      () => requireMemberRoleChange(superAdmin),
    ]) {
      expect(status(check)).toBe(null);
    }
  });

  it('list filters: none for super admins, lead teams for team leads, nothing for others', () => {
    expect(teamScopeFilter(superAdmin)).toBeUndefined();
    expect(teamScopeFilter(lead)).toEqual({ in: [SOC] });
    expect(teamScopeFilter(actor({ role: 'AGENT', leadTeamIds: [SOC] }))).toEqual({ in: [] });
  });
});

describe('generated keys (E4)', () => {
  const takenFrom = (taken: string[]) => async (candidates: string[]) =>
    candidates.filter((c) => taken.includes(c));

  it('uses the label slug, then -2, -3… (archived rows count as taken)', async () => {
    expect(
      await generateKey({ label: 'Door access', fallbackPrefix: 'category', taken: takenFrom([]) }),
    ).toBe('door-access');
    expect(
      await generateKey({
        label: 'Door access',
        fallbackPrefix: 'category',
        taken: takenFrom(['door-access', 'door-access-2']),
      }),
    ).toBe('door-access-3');
    expect(
      await generateKey({
        label: 'Camera ID',
        separator: '_',
        fallbackPrefix: 'field',
        taken: takenFrom(['camera_id']),
      }),
    ).toBe('camera_id_2');
  });

  it('falls back to <prefix>-<random> when the label has no Latin letters', async () => {
    const key = await generateKey({
      label: 'كاميرات',
      fallbackPrefix: 'category',
      taken: takenFrom([]),
    });
    expect(key).toMatch(/^category-[0-9a-f]{6}$/);
  });

  it('never returns a taken key', async () => {
    const base = 'x-ray';
    const all = [base, ...Array.from({ length: 30 }, (_, i) => `${base}-${i + 2}`)];
    const key = await generateKey({ label: 'X ray', fallbackPrefix: 'p', taken: takenFrom(all) });
    expect(all).not.toContain(key);
    expect(key).toMatch(/^x-ray-[0-9a-f]{6}$/);
  });
});

describe('constraint fields of Prisma errors', () => {
  const meta = (index: string, table?: string) => ({
    modelName: table ?? 'Team',
    driverAdapterError: { cause: { constraint: { index }, ...(table ? { table } : {}) } },
  });

  it('reads the adapter constraint name', () => {
    expect(constraintFields(meta('Team_key_key', 'Team'))).toEqual(['key']);
    expect(constraintFields(meta('Subtype_categoryId_key_key', 'Subtype'))).toEqual([
      'categoryId',
      'key',
    ]);
    expect(constraintFields(meta('Subtype_categoryId_fkey', 'Subtype'))).toEqual(['categoryId']);
    expect(
      constraintFields({ driverAdapterError: { cause: { constraint: { fields: ['date'] } } } }),
    ).toEqual(['date']);
    expect(constraintFields({ target: ['priority', 'teamId', 'step'] })).toEqual([
      'priority',
      'teamId',
      'step',
    ]);
    expect(constraintFields(undefined)).toEqual([]);
  });
});

describe('macroReorderLabel (REORDER audit label, contract-5)', () => {
  it('names the global list and a team list', () => {
    expect(macroReorderLabel(null)).toBe('Global macros');
    expect(macroReorderLabel(null, 'ignored')).toBe('Global macros');
    expect(macroReorderLabel(SOC, 'Security SOC')).toBe('Security SOC macros');
    // A team that could not be read falls back to its id.
    expect(macroReorderLabel(SOC, null)).toBe(`${SOC} macros`);
  });
});

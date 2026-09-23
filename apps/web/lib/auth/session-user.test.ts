import type { AuthUser } from '@loons/shared';
import type { JWT } from 'next-auth/jwt';
import { describe, expect, it, vi } from 'vitest';
import {
  USER_REFRESH_INTERVAL_MS,
  applyUserToToken,
  isRefreshDue,
  parseUserResponse,
  refreshSessionToken,
  sessionUserFromAuthJsUser,
  sessionUserFromToken,
  toSessionUser,
  type UserLookup,
} from './session-user';

const apiUser: AuthUser = {
  id: '6f1c2a0e-4b6d-4c1e-9a7f-2d3b4c5d6e7f',
  email: 'aisha.alkuwari@hamad.qa',
  name: 'Aisha Al-Kuwari',
  role: 'CLIENT',
  status: 'ACTIVE',
  orgId: '0b8f0a52-8c0e-4b7a-9d55-7c2f7e3c1a11',
  locale: 'en',
  teamIds: [],
  sessionVersion: 2,
};

const NOW = 1_800_000_000_000;

function signedInToken(overrides: Partial<JWT> = {}): JWT {
  return { ...applyUserToToken({}, toSessionUser(apiUser), NOW), ...overrides };
}

describe('parseUserResponse', () => {
  it('accepts the API { user } shape', () => {
    expect(parseUserResponse({ user: apiUser })).toEqual(apiUser);
  });
  it('rejects anything else', () => {
    expect(parseUserResponse(null)).toBeNull();
    expect(parseUserResponse({ user: { ...apiUser, role: 'ROOT' } })).toBeNull();
    expect(parseUserResponse({ user: { ...apiUser, id: 'not-a-uuid' } })).toBeNull();
  });
});

describe('token <-> session user', () => {
  it('stores every session field and the refresh time, and drops the picture', () => {
    const token = applyUserToToken(
      { picture: 'data:image/png;base64,…' },
      toSessionUser(apiUser),
      NOW,
    );
    expect(token).toMatchObject({
      uid: apiUser.id,
      sub: apiUser.id,
      name: apiUser.name,
      email: apiUser.email,
      role: 'CLIENT',
      status: 'ACTIVE',
      orgId: apiUser.orgId,
      locale: 'en',
      sv: 2,
      refreshedAt: NOW,
    });
    expect(token.picture).toBeUndefined();
    expect(sessionUserFromToken(token)).toEqual(toSessionUser(apiUser));
    expect(sessionUserFromToken(token)?.sessionVersion).toBe(2);
  });

  it('reads sessions issued before session versions existed as version 0', () => {
    const { sv: _omit, ...legacy } = signedInToken();
    expect(sessionUserFromToken(legacy)?.sessionVersion).toBe(0);
    expect(sessionUserFromToken({ ...signedInToken(), sv: -1 })).toBeNull();
    expect(sessionUserFromToken({ ...signedInToken(), sv: 'x' as never })).toBeNull();
  });

  it('rejects incomplete or foreign tokens', () => {
    expect(sessionUserFromToken({})).toBeNull();
    expect(sessionUserFromToken({ ...signedInToken(), role: undefined })).toBeNull();
    expect(sessionUserFromToken({ ...signedInToken(), status: 'WEIRD' as never })).toBeNull();
  });

  it('reads the Auth.js user produced at sign-in, including its session version', () => {
    expect(sessionUserFromAuthJsUser(toSessionUser(apiUser))).toEqual(toSessionUser(apiUser));
    expect(sessionUserFromAuthJsUser(toSessionUser(apiUser))?.sessionVersion).toBe(2);
    expect(sessionUserFromAuthJsUser({ id: 'x', email: 'a@b.co' })).toBeNull();
    const { sessionVersion: _omit, ...withoutVersion } = toSessionUser(apiUser);
    expect(sessionUserFromAuthJsUser(withoutVersion)).toBeNull();
  });

  it('stores the sign-in user’s session version in the JWT (sv)', () => {
    const signedIn = sessionUserFromAuthJsUser(toSessionUser({ ...apiUser, sessionVersion: 5 }));
    expect(signedIn).not.toBeNull();
    expect(applyUserToToken({}, signedIn!, NOW).sv).toBe(5);
  });
});

describe('isRefreshDue', () => {
  it('refreshes after five minutes or when never refreshed', () => {
    expect(isRefreshDue(undefined, NOW)).toBe(true);
    expect(isRefreshDue(NOW, NOW + USER_REFRESH_INTERVAL_MS - 1)).toBe(false);
    expect(isRefreshDue(NOW, NOW + USER_REFRESH_INTERVAL_MS)).toBe(true);
  });
});

describe('refreshSessionToken', () => {
  const found = (user: AuthUser): UserLookup => ({ kind: 'found', user });

  it('does not call the API before the interval elapses', async () => {
    const lookup = vi.fn();
    const token = signedInToken();
    await expect(refreshSessionToken(token, { now: NOW + 60_000, lookup })).resolves.toBe(token);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reloads the user after the interval and applies changes', async () => {
    const lookup = vi.fn(async () => found({ ...apiUser, name: 'Aisha K.', locale: 'ar' }));
    const later = NOW + USER_REFRESH_INTERVAL_MS + 1;
    const token = await refreshSessionToken(signedInToken(), { now: later, lookup });
    expect(lookup).toHaveBeenCalledWith(apiUser.id);
    expect(token).toMatchObject({ name: 'Aisha K.', locale: 'ar', refreshedAt: later });
  });

  it('refreshes immediately when forced (session update)', async () => {
    const lookup = vi.fn(async () => found({ ...apiUser, status: 'ACTIVE', role: 'CLIENT' }));
    const token = signedInToken({ status: 'PENDING_APPROVAL' });
    const result = await refreshSessionToken(token, { now: NOW + 1, force: true, lookup });
    expect(result?.status).toBe('ACTIVE');
  });

  it('ends the session when the user is gone (404) or disabled', async () => {
    const later = NOW + USER_REFRESH_INTERVAL_MS;
    await expect(
      refreshSessionToken(signedInToken(), { now: later, lookup: async () => ({ kind: 'gone' }) }),
    ).resolves.toBeNull();
    await expect(
      refreshSessionToken(signedInToken(), {
        now: later,
        lookup: async () => found({ ...apiUser, status: 'DISABLED' }),
      }),
    ).resolves.toBeNull();
  });

  it('ends the session when the sessionVersion changed (sessions revoked, e.g. password reset)', async () => {
    const later = NOW + USER_REFRESH_INTERVAL_MS;
    await expect(
      refreshSessionToken(signedInToken(), {
        now: later,
        lookup: async () => found({ ...apiUser, sessionVersion: 3 }),
      }),
    ).resolves.toBeNull();
    // Also on a forced refresh (session update) before the interval elapses.
    await expect(
      refreshSessionToken(signedInToken(), {
        now: NOW + 1,
        force: true,
        lookup: async () => found({ ...apiUser, sessionVersion: 3 }),
      }),
    ).resolves.toBeNull();
    // A session from before session versions existed (no sv) ends once the user has moved on…
    const { sv: _omit, ...legacy } = signedInToken();
    await expect(
      refreshSessionToken(legacy, {
        now: later,
        lookup: async () => found({ ...apiUser, sessionVersion: 1 }),
      }),
    ).resolves.toBeNull();
    // …and is kept (and upgraded) while the user is still on version 0.
    const kept = await refreshSessionToken(
      { ...legacy },
      { now: later, lookup: async () => found({ ...apiUser, sessionVersion: 0 }) },
    );
    expect(kept).toMatchObject({ sv: 0, refreshedAt: later });
  });

  it('keeps the session while the sessionVersion is unchanged', async () => {
    const later = NOW + USER_REFRESH_INTERVAL_MS;
    const result = await refreshSessionToken(signedInToken(), {
      now: later,
      lookup: async () => found({ ...apiUser, sessionVersion: 2, name: 'Aisha K.' }),
    });
    expect(result).toMatchObject({ sv: 2, name: 'Aisha K.', refreshedAt: later });
  });

  it('keeps the session when the API is unavailable', async () => {
    const token = signedInToken();
    const result = await refreshSessionToken(token, {
      now: NOW + USER_REFRESH_INTERVAL_MS,
      lookup: async () => ({ kind: 'unavailable' }),
    });
    expect(result).toBe(token);
    expect(result?.refreshedAt).toBe(NOW);
  });

  it('rejects tokens without a user and a lookup returning someone else', async () => {
    await expect(refreshSessionToken({}, { lookup: vi.fn() })).resolves.toBeNull();
    await expect(
      refreshSessionToken(signedInToken(), {
        now: NOW + USER_REFRESH_INTERVAL_MS,
        lookup: async () => found({ ...apiUser, id: '11111111-1111-4111-8111-111111111111' }),
      }),
    ).resolves.toBeNull();
  });
});

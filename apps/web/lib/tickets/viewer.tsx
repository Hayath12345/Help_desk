'use client';

import { isStaffRole } from '@loons/shared';
import { createContext, useContext } from 'react';
import type { Viewer } from './types';

const ViewerContext = createContext<Viewer | null>(null);

/**
 * Makes the signed-in user available to the ticket UI (optimistic message authors, role-specific
 * behaviour of the New ticket modal, "is typing" filtering). Mount it once per signed-in area
 * (portal / console layouts) with the user from `requireUser()`.
 */
export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: React.ReactNode;
}) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

/** The signed-in user, or null outside a `ViewerProvider`. */
export function useViewer(): Viewer | null {
  return useContext(ViewerContext);
}

/** True for agents, team leads and super admins. */
export function isStaffViewer(viewer: Viewer | null | undefined): boolean {
  return !!viewer && isStaffRole(viewer.role);
}

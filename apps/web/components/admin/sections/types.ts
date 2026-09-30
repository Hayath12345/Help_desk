import type { Role } from '@loons/shared';

/**
 * What `/admin/[section]` passes to a section's `index.tsx` (default export). The route has
 * already checked that `role` may open the section (team leads: Teams and Macros only); the API
 * enforces the per-team scope. The viewer is also available from `useViewer()`.
 */
export interface AdminSectionProps {
  role: Role;
  userId: string;
}

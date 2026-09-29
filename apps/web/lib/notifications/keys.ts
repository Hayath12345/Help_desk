// TanStack Query keys of the in-app notifications (Phase 3, decision D13). Every key starts with
// 'notifications', so one prefix covers the feature (reconnect refetch, sign-out).

export const notificationKeys = {
  all: ['notifications'] as const,
  /** The caller's notifications, newest first (infinite, cursor-paginated). */
  list: () => ['notifications', 'list'] as const,
};

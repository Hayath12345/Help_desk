// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/notifications — in-app notifications of the console bell (docs/PHASE3_CONTRACT.md → Web,
// decision D13). Staff only; the portal has no bell in Phase 3.
//
// Hooks
//   useNotifications()            GET /me/notifications, infinite (cursor), newest first. The unread
//                                 count of the badge is `unreadCountOf(query.data)` (first page).
//   useMarkNotificationsRead()    mutate({ ids }) | mutate({ all: true }) — optimistic; the answer's
//                                 unread count wins; on error the list reloads and a toast explains.
//   useNotificationText()         (dto) => { rich, plain }: the item's sentence in the UI language.
// Realtime
//   `notification:new` → applyNewNotification(queryClient, payload) (wired in lib/realtime/provider):
//   inserted newest first, deduplicated by id, unread count from the payload. A reconnect refetches.
// Pure helpers: notificationItems, unreadCountOf, badgeText ('9+'), insertNotification,
//   markReadInPages, setUnreadCount, notificationHref (/console/inbox?ticket=LG-n).
// Keys: notificationKeys (every key starts with 'notifications').
// ─────────────────────────────────────────────────────────────────────────────────────────────

export * from './api';
export * from './cache';
export * from './hooks';
export * from './keys';
export * from './text';

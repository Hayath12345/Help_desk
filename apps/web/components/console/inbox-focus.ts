// Where the focus goes when the focused control leaves with an Inbox list change.

/** The list's heading (an h2 with tabIndex −1, ticket-list.tsx). */
export const INBOX_LIST_TITLE_ID = 'inbox-list-title';

/** Marks the view picker that stands in for the Views column below 1180 px (views-sidebar.tsx). */
export const INBOX_VIEW_SELECT_ATTR = 'data-inbox-view-select';

/** Where the three-column layout shows the heading; below it the heading is sr-only. */
const WIDE_LAYOUT = '(min-width: 1180px)';

/**
 * After the control that had the focus goes away with a list change (the company "Clear" chip,
 * the requester card's "N from this client" link), the focus moves to the list's heading — or,
 * below 1180 px where the heading is only for screen readers, to the view picker in its place —
 * so it is never lost to the page and always visible.
 */
export function focusInboxList(): void {
  requestAnimationFrame(() => {
    const title = document.getElementById(INBOX_LIST_TITLE_ID);
    const picker = document.querySelector<HTMLElement>(`[${INBOX_VIEW_SELECT_ATTR}]`);
    const target = window.matchMedia(WIDE_LAYOUT).matches ? title : (picker ?? title);
    target?.focus();
  });
}

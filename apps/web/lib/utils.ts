export { cn } from 'cn';

/**
 * A single truncated line of text in either script (subjects, names, companies): use with
 * `dir="auto"`. The element takes its text's own direction, so the ellipsis falls at the text's
 * end (an English subject in the Arabic UI keeps its start and loses its end, and the other way
 * round); `match-parent` keeps it aligned to the UI's start side, like the text around it.
 */
export const TRUNCATE_ANY_DIRECTION = 'truncate [text-align:match-parent]';

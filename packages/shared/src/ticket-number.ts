export const TICKET_NUMBER_PREFIX = 'LG-';

/** 4817 → "LG-4817" */
export function formatTicketNumber(n: number): string {
  return `${TICKET_NUMBER_PREFIX}${n}`;
}

/** "LG-4817" / "lg-4817" / "4817" → 4817; anything else → null. */
export function parseTicketNumber(input: string): number | null {
  const m = /^(?:lg-)?(\d{1,9})$/i.exec(input.trim());
  return m ? Number(m[1]) : null;
}

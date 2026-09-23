// Ticket tags used by the demo tickets (design seed()). Agents create more from the console.

export interface TagSeed {
  key: string;
  label: string;
}

export const TAGS: readonly TagSeed[] = [
  { key: 'firewall', label: 'firewall' },
  { key: 'brute-force', label: 'brute-force' },
  { key: 'nvr', label: 'nvr' },
  { key: 'turnstile', label: 'turnstile' },
  { key: 'fibre', label: 'fibre' },
  { key: 'ppm', label: 'ppm' },
];

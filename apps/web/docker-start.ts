// Entry point of the web container (apps/web/Dockerfile): `node docker-start.ts`.
//
// Starts Next.js's standalone server (apps/web/server.js) and gives it a graceful stop. The
// standalone server has no SIGTERM handler, so a rolling deployment would cut the requests that are
// still in flight the moment the orchestrator stops the old container. On SIGTERM / SIGINT this
// entry point keeps the server running for a short drain period (the load balancer has stopped
// sending new requests by then), then exits 0; a second signal exits at once.
//
// Run with Node's built-in TypeScript support (no tsx, no build step); imports only Node built-ins.

/** How long the server keeps answering after SIGTERM. Shorter than ECS's default 30 s stop timeout. */
export const DRAIN_MS = 5_000;

export interface SignalSource {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): never;
}

/** Exits 0 after `drainMs` once a stop signal arrives (or at once on a second one). */
export function exitAfterDrain(
  proc: SignalSource,
  log: (line: string) => void,
  drainMs: number = DRAIN_MS,
): void {
  let draining = false;
  const onSignal = (): void => {
    if (draining) {
      log('[web] second stop signal: exiting now');
      return proc.exit(0);
    }
    draining = true;
    log(`[web] stop signal: draining for ${drainMs} ms`);
    setTimeout(() => proc.exit(0), drainMs).unref();
    proc.once('SIGTERM', onSignal);
    proc.once('SIGINT', onSignal);
  };
  proc.once('SIGTERM', onSignal);
  proc.once('SIGINT', onSignal);
}

if (import.meta.main) {
  exitAfterDrain(process as unknown as SignalSource, (line) => console.log(line));
  // A variable specifier: server.js only exists in the built image, not in the repository.
  const server = './apps/web/server.js';
  await import(server);
}

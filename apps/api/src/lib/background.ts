import type { AppLogger as Logger } from './logger.ts';

/**
 * Work started by a request but finished after the response is sent (e.g. rendering and
 * enqueueing a password-reset email, so response timing never reveals whether an account
 * exists). Tracked so shutdown and tests can wait for it.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly logger: Logger) {}

  run(name: string, task: () => Promise<void>): void {
    const promise = Promise.resolve()
      .then(task)
      .catch((err: unknown) => {
        this.logger.error({ err, task: name }, 'background task failed');
      })
      .finally(() => {
        this.pending.delete(promise);
      });
    this.pending.add(promise);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Resolves once every task started so far (and any they start) has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }
}

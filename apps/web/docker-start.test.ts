import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAIN_MS, exitAfterDrain, type SignalSource } from './docker-start';

type Handler = () => void;

function fakeProcess() {
  const handlers: Record<string, Handler[]> = {};
  const exits: number[] = [];
  const proc: SignalSource = {
    once(event, listener) {
      (handlers[event] ??= []).push(listener);
    },
    exit(code) {
      exits.push(code);
      return undefined as never;
    },
  };
  const send = (event: string) => {
    const listeners = handlers[event] ?? [];
    handlers[event] = [];
    for (const listener of listeners) listener();
  };
  return { proc, send, exits };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('exitAfterDrain', () => {
  it('keeps running for the drain period after SIGTERM, then exits 0', () => {
    const { proc, send, exits } = fakeProcess();
    const log = vi.fn();
    exitAfterDrain(proc, log);
    send('SIGTERM');
    expect(log).toHaveBeenCalledWith(`[web] stop signal: draining for ${DRAIN_MS} ms`);
    vi.advanceTimersByTime(DRAIN_MS - 1);
    expect(exits).toEqual([]); // still answering requests
    vi.advanceTimersByTime(1);
    expect(exits).toEqual([0]);
  });

  it('SIGINT drains the same way', () => {
    const { proc, send, exits } = fakeProcess();
    exitAfterDrain(proc, () => undefined, 1_000);
    send('SIGINT');
    vi.advanceTimersByTime(1_000);
    expect(exits).toEqual([0]);
  });

  it('a second signal exits immediately', () => {
    const { proc, send, exits } = fakeProcess();
    exitAfterDrain(proc, () => undefined);
    send('SIGTERM');
    send('SIGTERM');
    expect(exits).toEqual([0]);
  });

  it('does nothing until a signal arrives', () => {
    const { proc, exits } = fakeProcess();
    exitAfterDrain(proc, () => undefined);
    vi.advanceTimersByTime(60_000);
    expect(exits).toEqual([]);
  });

  it('drains for less than the default ECS stop timeout (30 s)', () => {
    expect(DRAIN_MS).toBeLessThan(30_000);
  });
});

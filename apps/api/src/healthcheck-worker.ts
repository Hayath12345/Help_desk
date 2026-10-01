// Container health check of the worker: `node src/healthcheck-worker.ts`.
// Exit 0 = the worker's heartbeat file is fresh; exit 1 = it is missing or stale (see
// lib/worker-heartbeat.ts). Imports only Node built-ins, so it starts in a few milliseconds.
import { checkHeartbeat } from './lib/worker-heartbeat.ts';

const file = process.env.WORKER_HEARTBEAT_FILE?.trim();
if (!file) {
  console.error('WORKER_HEARTBEAT_FILE is not set');
  process.exit(1);
}
const verdict = checkHeartbeat(file);
if (!verdict.ok) {
  console.error(`worker heartbeat ${verdict.reason}`);
  process.exit(1);
}

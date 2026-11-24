// Background sender for queued captures. Hooks start it as a detached process with no stdio,
// so it can finish after the hook exits and never writes to a host's hook output.
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCacheProtection } from './cache-protection.mjs';
import { flushCaptures, launchFlushProcess } from './capture-queue.mjs';
import { createClient } from './client.mjs';
import { loadConfig } from './config.mjs';
import { flushTelemetry } from './telemetry.mjs';

const DEADLINE_MS = 5 * 60 * 1000;

/** `force` (session start and end) retries every conversation, even one whose retry wait is not over. */
export async function runFlushProcess({ pluginRoot = dirname(dirname(fileURLToPath(import.meta.url))), env = process.env, force = false } = {}) {
  try {
    const configured = loadConfig({ env, pluginRoot });
    const config = {
      ...configured, timeoutMs: Math.min(configured.timeoutMs, 20_000),
      authTimeoutMs: Math.min(configured.authTimeoutMs, 10_000),
      lockTimeoutMs: Math.min(configured.lockTimeoutMs, 10_000),
    };
    const client = createClient({ config, env });
    // TODO(dogfood-feedback): Review the internal telemetry sender integration before
    // external customer release; it may change or be removed independently of capture delivery.
    const [capture] = await Promise.all([flushCaptures({
      client,
      protectionFor: identity => createCacheProtection({ ...config, tenantId: identity.tenantId }, { env, purpose: 'capture-queue' }),
      relaunch: () => launchFlushProcess({ env, force }),
      force,
    }), flushTelemetry({ client, log: message => process.stderr.write(`memory-house:${message}\n`) })]);
    return capture;
  } catch {
    return null;
  }
}

const invoked = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) {
  // Every request and lock is bounded; this only guards against a stalled platform call.
  setTimeout(() => process.exit(0), DEADLINE_MS).unref();
  await runFlushProcess({ force: process.argv.includes('--force') });
}

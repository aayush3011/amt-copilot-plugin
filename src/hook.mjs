import { realpathSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { createClient } from './client.mjs';
import { runHook, normalizeEvent } from './hooks.mjs';

const EVENTS = {
  claude: ['session-start', 'user-prompt', 'assistant-stop'],
  codex: ['session-start', 'user-prompt', 'assistant-stop'],
  cursor: ['session-start', 'user-prompt', 'assistant-response', 'post-tool', 'session-end'],
  copilot: ['session-start', 'user-prompt', 'prompt-transform', 'assistant-stop', 'post-tool', 'session-end'],
};

export async function runHookProcess(harness, { pluginRoot, rootVariable, env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let output = {};
  try {
    if (!env[rootVariable] || realpathSync(env[rootVariable]) !== realpathSync(pluginRoot)) {
      throw new Error('not-plugin-invocation');
    }
    const [event, ...extra] = process.argv.slice(2);
    if (extra.length || !EVENTS[harness]?.includes(normalizeEvent(event))) throw new Error('unsupported-event');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 512 * 1024) throw new Error('oversize-input');
      chunks.push(Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const configured = loadConfig({ env, pluginRoot });
    const config = {
      ...configured, timeoutMs: Math.min(configured.timeoutMs, 5000),
      lockTimeoutMs: Math.min(configured.lockTimeoutMs, 3000),
    };
    output = await runHook({
      harness, event, payload, env, client: createClient({ config }),
      logger: message => stderr.write(`${message}\n`),
    });
  } catch {
    stderr.write('memory-house: hook skipped; verify the installed plugin, sign-in and event input. No request content is logged.\n');
  }
  stdout.write(`${JSON.stringify(output)}\n`);
}

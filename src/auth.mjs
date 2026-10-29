import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from './client.mjs';
import { loadConfig } from './config.mjs';
import { safeError } from './errors.mjs';

export async function runAuthCommand(command, {
  env = process.env, pluginRoot, stdout = process.stdout, stderr = process.stderr, acquireToken,
} = {}) {
  let result;
  let configured;
  try {
    configured = loadConfig({ env, ...(pluginRoot ? { pluginRoot } : {}) });
    if (command === 'headers') {
      const config = { ...configured, authTimeoutMs: Math.min(configured.authTimeoutMs, 7000) };
      result = { Authorization: `Bearer ${await createClient({ config, env, acquireToken }).getAccessToken()}` };
    } else if (command === 'login') {
      stderr.write('Opening Microsoft sign-in in your browser. Complete sign-in there; never enter credentials in chat.\n');
      result = await createClient({ config: configured, env, acquireToken }).login();
    } else if (command === 'status') {
      result = await createClient({ config: configured, env, acquireToken }).status();
    } else if (command === 'logout') {
      result = await createClient({ config: configured, env, acquireToken }).logout();
    } else {
      result = { error: { code: 'USAGE', message: 'Usage: node runtime/auth.mjs login|status|logout|headers' } };
    }
  } catch (error) {
    if (command === 'headers') {
      const safe = safeError(error);
      stderr.write(`memory-house: ${safe.code}: ${safe.message}\n`);
    }
    result = command === 'headers' ? {} : { error: safeError(error) };
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const invoked = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) {
  const result = await runAuthCommand(process.argv[2]);
  if (result.error) process.exitCode = 1;
}

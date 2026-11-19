import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from './client.mjs';
import { loadConfig } from './config.mjs';
import { safeError } from './errors.mjs';
import { TELEMETRY_NOTICE, TELEMETRY_OPT_OUT, telemetryCommand } from './telemetry.mjs';

export async function runAuthCommand(command, {
  env = process.env, pluginRoot, stdout = process.stdout, stderr = process.stderr, acquireToken, fetch, acceptedNoticeVersion,
} = {}) {
  let result;
  let configured;
  try {
    configured = loadConfig({ env, ...(pluginRoot ? { pluginRoot } : {}) });
    if (command === 'headers') {
      const config = { ...configured, authTimeoutMs: Math.min(configured.authTimeoutMs, 7000) };
      result = { Authorization: `Bearer ${await createClient({ config, env, acquireToken }).getAccessToken('mcp')}` };
    } else if (command === 'login') {
      stderr.write(`<memory-house-telemetry>\n${TELEMETRY_NOTICE}\n${TELEMETRY_OPT_OUT}\n</memory-house-telemetry>\n`);
      stderr.write('Opening Microsoft sign-in in your browser. Complete sign-in there, and approve Memory House tool access if Microsoft asks; never enter credentials in chat.\n');
      result = await createClient({ config: configured, env, acquireToken }).login();
    } else if (command === 'status') {
      result = await createClient({ config: configured, env, acquireToken }).status();
    } else if (command === 'logout') {
      result = await createClient({ config: configured, env, acquireToken }).logout();
    } else if (['telemetry-notice', 'telemetry-status', 'telemetry-enable', 'telemetry-disable'].includes(command)) {
      // TODO(dogfood-feedback): Review these internal feedback participation commands
      // before external customer release; they may be revised or removed.
      result = await telemetryCommand(createClient({ config: configured, env, acquireToken, fetch }),
        command.slice('telemetry-'.length), acceptedNoticeVersion);
    } else {
      result = { error: { code: 'USAGE', message: 'Usage: node runtime/auth.mjs login|status|logout|headers|telemetry-notice|telemetry-status|telemetry-enable|telemetry-disable' } };
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
  const acceptedNoticeVersion = process.argv[3]?.startsWith('--accept-notice=') && process.argv.length === 4
    ? process.argv[3].slice('--accept-notice='.length) : undefined;
  const result = await runAuthCommand(process.argv[2], { acceptedNoticeVersion });
  if (result.error) process.exitCode = 1;
}

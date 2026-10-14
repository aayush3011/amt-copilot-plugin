import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from './client.mjs';
import { loadConfig } from './config.mjs';
import { loginWithEntra } from './entra.mjs';
import { safeError } from './errors.mjs';

const status = value => ({
  signedIn: value.signedIn, needsLogin: value.needsLogin, canRefresh: value.canRefresh,
  accessExpiresAt: value.accessExpiresAt, refreshExpiresAt: value.refreshExpiresAt,
  ...(value.reason ? { reason: value.reason } : {}),
});

// The plugin's local sign-in helper: `node runtime/auth.mjs login|status|logout|headers`.
// `login` is the Microsoft browser sign-in that Claude Code and Codex use, `headers` is the
// Authorization header they send to the remote MCP server, and `status`/`logout` back the skills.
// `login` options (pca, msal, fetch, openBrowser, timeoutMs) are for tests.
export async function runAuthCommand(command, { env = process.env, pluginRoot, stdout = process.stdout, login = {} } = {}) {
  let result;
  try {
    const configured = loadConfig({ env, ...(pluginRoot ? { pluginRoot } : {}) });
    if (command === 'headers') {
      // Claude Code gives up on a header helper after 10 seconds; a refresh must finish sooner.
      const config = { ...configured, timeoutMs: Math.min(configured.timeoutMs, 7000), lockTimeoutMs: Math.min(configured.lockTimeoutMs, 2000) };
      result = { Authorization: `HookToken ${await createClient({ config }).getAccessToken()}` };
    } else if (command === 'login') {
      result = status(await loginWithEntra({ client: createClient({ config: configured }), onMessage: () => {}, ...login }));
    } else if (command === 'status') {
      result = status(await createClient({ config: configured }).status());
    } else if (command === 'logout') {
      result = await createClient({ config: configured }).logout();
    } else {
      result = { error: { code: 'USAGE', message: 'Usage: node runtime/auth.mjs login|status|logout|headers' } };
    }
  } catch (error) {
    // A header helper must print only string headers; without a sign-in it sends none.
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

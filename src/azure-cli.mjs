import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { MemoryHouseError } from './errors.mjs';

const fail = (code, message) => new MemoryHouseError(code, message);

export function loginCommand(config) {
  return `az login --tenant ${config.tenantId} --scope ${config.scope} --allow-no-subscriptions --output none`;
}

export function validateAzureCliConfig({ tenantId, scope }) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(tenantId ?? '')
    || typeof scope !== 'string' || !/^(?:https:\/\/|api:\/\/)[a-z\d._:/-]+\/[a-z\d._-]+$/i.test(scope)) {
    throw fail('INVALID_ENTRA_CONFIG', 'Configure a tenant GUID and a fully qualified gateway scope in deployment.json.');
  }
}

async function executable(env) {
  const path = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  const names = process.platform === 'win32' ? ['az.exe', 'az.cmd', 'az.bat'] : ['az'];
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const name of names) {
      const file = join(directory, name);
      try {
        await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return file;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) {
          throw fail('AZURE_CLI_UNAVAILABLE', 'Unable to locate Azure CLI on PATH.');
        }
      }
    }
  }
  throw fail('AZURE_CLI_NOT_FOUND', 'Install Azure CLI 2.54 or later and make az available on the plugin host PATH.');
}

export async function runAzureCli(args, { timeoutMs = 10_000, env = process.env } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw fail('INVALID_CONFIG', 'Azure CLI timeout must be between 1 and 30000 milliseconds.');
  }
  const file = await executable(env);
  const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file);
  // Windows batch launchers require cmd.exe. Neither arguments nor the launcher path may expand shell syntax.
  if (args.some(value => typeof value !== 'string' || !/^[a-z\d:/._-]+$/i.test(value))
    || (batch && /["%\r\n]/.test(file))) {
    throw fail('INVALID_ENTRA_CONFIG', 'Azure CLI arguments and launcher path must not contain shell expansion syntax.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(batch ? (env.ComSpec ?? process.env.ComSpec ?? 'cmd.exe') : file,
      batch ? ['/d', '/v:off', '/s', '/c', `""${file}" ${args.join(' ')}"`] : args,
      { env, windowsHide: true, windowsVerbatimArguments: batch, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (batch && child.pid) {
          // Killing only cmd.exe leaves its Python child running with inherited pipes.
          const stop = spawn(join(env.SystemRoot ?? process.env.SystemRoot, 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
          stop.once('error', () => child.kill());
        } else child.kill();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(fail('AZURE_CLI_TIMEOUT',
      'Azure CLI token acquisition timed out. Check CLI connectivity and sign-in; hooks never prompt or retry.')), timeoutMs);
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 128 * 1024) finish(fail('AZURE_CLI_OUTPUT_INVALID', 'Azure CLI returned an oversized authentication response.'));
      else output += chunk.toString('utf8');
    });
    // Drain but never forward provider diagnostics: they can contain account details or credentials.
    child.stderr.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 128 * 1024) finish(fail('AZURE_CLI_OUTPUT_INVALID', 'Azure CLI returned oversized authentication diagnostics.'));
    });
    child.once('error', () => finish(fail('AZURE_CLI_UNAVAILABLE', 'Unable to start Azure CLI. Check the plugin host PATH.')));
    child.once('close', code => finish(code === 0 ? null : fail('AZURE_CLI_AUTH_REQUIRED',
      'Azure CLI could not obtain a gateway token. Sign in from a terminal using the deployment tenant and scope, then run mh-login.'), output));
  });
}

export async function acquireAzureCliToken(config, { run = runAzureCli, env = process.env, clock = Date.now } = {}) {
  validateAzureCliConfig(config);
  const raw = await run(['account', 'get-access-token', '--tenant', config.tenantId,
    '--scope', config.scope, '--output', 'json', '--only-show-errors'], { timeoutMs: config.authTimeoutMs, env });
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw fail('AZURE_CLI_OUTPUT_INVALID', 'Azure CLI did not return valid token JSON.');
  }
  const expiresAt = typeof value?.expires_on === 'string' && /^\d+$/.test(value.expires_on)
    ? Number(value.expires_on) : value?.expires_on;
  if (typeof value?.accessToken !== 'string' || !/^[A-Za-z\d._~+/-]+=*$/.test(value.accessToken)
    || value.accessToken.length > 32 * 1024 || typeof value.tokenType !== 'string' || value.tokenType.toLowerCase() !== 'bearer'
    || typeof value.tenant !== 'string' || value.tenant.toLowerCase() !== config.tenantId.toLowerCase()
    || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(clock() / 1000) + config.tokenSkewSeconds) {
    throw fail('AZURE_CLI_TOKEN_INVALID',
      'Azure CLI returned an invalid, expired or wrong-tenant token. Use CLI 2.54 or later and sign in for the configured gateway scope.');
  }
  return { accessToken: value.accessToken, expiresAt };
}

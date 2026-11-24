import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { MemoryHouseError } from './errors.mjs';

const fail = () => new MemoryHouseError('SECURE_CACHE_UNAVAILABLE',
  'Unable to access the protected sign-in cache. Windows requires PowerShell/DPAPI; macOS requires an unlocked Keychain; Linux requires secret-tool and an unlocked Secret Service. No plaintext fallback is used.');

export async function runSecretTool(file, args, input = '', timeoutMs = 10_000, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    let stdout = '', stderr = '', bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(fail()), timeoutMs);
    const collect = name => chunk => {
      bytes += chunk.length;
      if (bytes > 3 * 1024 * 1024) return finish(fail());
      if (name === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => finish(fail()));
    child.once('error', () => finish(fail()));
    child.once('close', code => finish(null, { code, stdout: stdout.trim(), hasError: Boolean(stderr.trim()) }));
    child.stdin.end(input);
  });
}

/**
 * `purpose` separates what one device key protects: the MSAL cache (`msal`) and queued captures
 * (`capture-queue`) share the OS-protected key but use different DPAPI entropy and AES-GCM data, so
 * neither ciphertext can be read as the other.
 */
export function createCacheProtection(config, { platform = process.platform, env = process.env,
  run = (file, args, input, timeout) => runSecretTool(file, args, input, timeout, env), purpose = 'msal' } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !/^[a-z][a-z-]{0,31}$/.test(purpose)) throw fail();
  const identity = createHash('sha256').update(JSON.stringify([
    config.stateDir, config.tenantId, config.clientId, config.scope,
  ])).digest('hex');
  const associated = purpose === 'msal' ? identity : `${identity}:${purpose}`;
  const timeout = config.authTimeoutMs;
  const dpapi = async (value, protect) => {
    const script = `$ErrorActionPreference='Stop'; `
      + `[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'); `
      + `$data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); `
      + `$result=[Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}(`
      + `$data,[Text.Encoding]::UTF8.GetBytes('memory-house-${purpose}-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser); `
      + `[Console]::Out.Write([Convert]::ToBase64String($result))`;
    const result = await run(join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], value, timeout);
    if (result.code !== 0 || !/^[a-z\d+/]+=*$/i.test(result.stdout)) throw fail();
    return result.stdout;
  };
  const keychain = async create => {
    const service = `memory-house-msal-${identity}`;
    const file = platform === 'darwin' ? 'security' : 'secret-tool';
    const args = platform === 'darwin'
      ? ['find-generic-password', '-s', service, '-a', 'cache-key', '-w']
      : ['lookup', 'service', service, 'account', 'cache-key'];
    const result = await run(file, args, '', timeout);
    if (result.code === 0 && /^[a-f\d]{64}$/.test(result.stdout)) return Buffer.from(result.stdout, 'hex');
    const missing = platform === 'darwin' ? result.code === 44 : result.code === 1 && !result.hasError;
    if (!create || !missing) throw fail();
    const key = randomBytes(32);
    // Secrets travel over stdin, never process arguments or diagnostics.
    const stored = platform === 'darwin'
      ? await run(file, ['-i'], `add-generic-password -s ${service} -a cache-key -w ${key.toString('hex')}\n`, timeout)
      : await run(file, ['store', '--label=Memory House sign-in cache', 'service', service, 'account', 'cache-key'],
        key.toString('hex'), timeout);
    if (stored.code !== 0 || (platform !== 'darwin' && stored.hasError)) throw fail();
    const verified = await run(file, args, '', timeout);
    if (verified.code !== 0 || verified.stdout !== key.toString('hex')) throw fail();
    return key;
  };
  // One lookup per instance, shared by concurrent calls: the parts of a long message are sealed
  // together, and a sender opens many queued turns, with one request to the credential store.
  let deviceKey;
  const cachedKey = create => (deviceKey ??= keychain(create).catch(error => {
    deviceKey = undefined;
    throw error;
  }));
  return {
    async protect(text) {
      if (platform === 'win32') return { version: 1, scheme: 'dpapi', data: await dpapi(Buffer.from(text).toString('base64'), true) };
      const key = await cachedKey(true);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(associated));
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return { version: 1, scheme: 'keychain', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    async unprotect(value) {
      try {
        if (value?.version !== 1 || typeof value.data !== 'string') throw fail();
        if (platform === 'win32') {
          if (value.scheme !== 'dpapi') throw fail();
          return Buffer.from(await dpapi(value.data, false), 'base64').toString('utf8');
        }
        if (value.scheme !== 'keychain' || typeof value.iv !== 'string' || typeof value.tag !== 'string') throw fail();
        const key = await cachedKey(false);
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
        decipher.setAAD(Buffer.from(associated));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
      } catch { throw fail(); }
    },
  };
}

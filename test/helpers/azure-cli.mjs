import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const fixtureTenant = '33333333-3333-3333-3333-333333333333';
export const fixtureToken = (extra = {}) => ({
  accessToken: 'fixture-access-1', tokenType: 'Bearer', tenant: fixtureTenant,
  expires_on: Math.floor(Date.now() / 1000) + 3600, ...extra,
});

export async function installFakeAzureCli(home) {
  const bin = join(home, 'bin');
  const config = join(home, '.azure-fixture');
  await mkdir(bin, { recursive: true });
  await mkdir(config, { recursive: true });
  const script = join(bin, 'fake-az.cjs');
  await writeFile(script, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.MH_FAKE_AZ_HANG === '1') {
  fs.writeFileSync(path.join(process.env.AZURE_CONFIG_DIR, 'hung-pid'), String(process.pid));
  setInterval(() => {}, 1000); return;
}
fs.appendFileSync(path.join(process.env.AZURE_CONFIG_DIR, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args.join(' ') !== 'account get-access-token --tenant 33333333-3333-3333-3333-333333333333 --scope https://dbinference.azure.com/.default --output json --only-show-errors') {
  process.stderr.write('unexpected CLI command'); process.exit(4);
}
try { process.stdout.write(fs.readFileSync(path.join(process.env.AZURE_CONFIG_DIR, 'token.json'))); }
catch { process.stderr.write('fixture-provider-secret: sign in'); process.exit(1); }
`);
  const launcher = join(bin, process.platform === 'win32' ? 'az.cmd' : 'az');
  await writeFile(launcher, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(launcher, 0o700);
  return { bin, config };
}

export async function signInAzureCli(env, extra = {}) {
  await writeFile(join(env.AZURE_CONFIG_DIR, 'token.json'), JSON.stringify(fixtureToken(extra)));
}

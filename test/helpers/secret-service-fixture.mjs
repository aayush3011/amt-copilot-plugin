#!/usr/bin/env node
// Isolated fake OS credential service; never reads the user's real keychain.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const file = join(process.env.HOME, 'fixture-secret-service.json');
let keys = {};
try { keys = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const args = process.argv.slice(2);
const mac = !['lookup', 'store'].includes(args[0]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
let service, secret;
if (args[0] === '-i') {
  [, service, secret] = input.match(/-s (\S+) -a cache-key -w ([a-f\d]{64})/) ?? [];
} else {
  service = args[args.indexOf(mac ? '-s' : 'service') + 1];
  if (args[0] === 'store') secret = input.trim();
}
if (!service) throw new Error('Invalid fixture credential-service request');
if (secret) {
  keys[service] = secret;
  await writeFile(file, JSON.stringify(keys), { mode: 0o600 });
} else if (keys[service]) process.stdout.write(keys[service]);
else process.exitCode = mac ? 44 : 1;

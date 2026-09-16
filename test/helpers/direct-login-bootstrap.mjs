import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { syntheticEntra } from './entra-auth.mjs';

const deployment = JSON.parse(readFileSync(join(dirname(dirname(process.argv[1])), 'deployment.json'), 'utf8'));
const fixture = syntheticEntra({ gatewayBase: deployment.gatewayBase, ...deployment.entra }, {
  behavior: process.env.MH_FIXTURE_BROWSER_BEHAVIOR ?? 'success',
});
globalThis.fetch = fixture.fetch;
childProcess.spawn = (command, args, options) => {
  assert.ok(['open', 'xdg-open', 'rundll32.exe'].includes(command));
  assert.equal(options.shell, false);
  const child = new EventEmitter();
  queueMicrotask(async () => {
    try {
      await fixture.openBrowser(args.at(-1));
      child.emit('exit', 0);
    } catch (error) {
      child.emit('error', error);
    }
  });
  return child;
};
syncBuiltinESMExports();

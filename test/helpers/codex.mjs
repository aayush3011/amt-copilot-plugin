import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function connectCodexAppServer(t, { env, cwd }) {
  const child = spawn('codex', ['app-server', '--stdio'], {
    env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map();
  let nextId = 0;
  let failure;
  let complete;
  const closed = new Promise(resolve => { complete = resolve; });
  const fail = error => {
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
  };
  child.on('error', error => { fail(error); complete(); });
  child.on('close', () => { fail(new Error('Codex app server closed.')); complete(); });
  child.stdin.on('error', fail);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch (error) { fail(error); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.error) entry.reject(new Error(`Codex ${entry.method} failed: ${JSON.stringify(message.error)}`));
    else entry.resolve(message.result);
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    await closed;
    clearTimeout(timer);
    lines.close();
  });
  const request = async (method, params) => {
    if (failure) throw failure;
    const id = ++nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        timer = setTimeout(() => reject(new Error(`Codex ${method} timed out.`)), 30_000);
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  await request('initialize', {
    clientInfo: { name: 'memory-house-fixture', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  return { request };
}

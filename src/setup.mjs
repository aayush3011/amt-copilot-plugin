import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createClient } from './client.mjs';
import { loadConfig, requirePublisherConfig, MemoryHouseError } from './config.mjs';
import { loginWithEntra } from './entra.mjs';
import { openBrowserUrl } from './browser.mjs';

const emptySchema = z.object({}).strict();

export function safeError(error) {
  return error instanceof MemoryHouseError
    ? { code: error.code, message: error.message }
    : { code: 'OPERATION_FAILED', message: 'Memory House could not complete this operation. Check local configuration and sign-in, then retry.' };
}

function matchesToken(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string'
    && Buffer.byteLength(actual) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new MemoryHouseError('INVALID_INPUT', 'Setup requests must be smaller than 16 KiB.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MemoryHouseError('INVALID_INPUT', 'Setup requests must contain valid JSON.');
  }
}

export function createSetupService({
  env = process.env, clientOptions = {}, clientFactory,
  login = loginWithEntra, openBrowser = openBrowserUrl, lifetimeMs = 10 * 60 * 1000,
} = {}) {
  const options = { ...clientOptions, env };
  const client = clientFactory ?? (() => createClient(options));
  let server;
  let origin;
  let csrf;
  let timer;
  let opening;
  let loginState = { state: 'idle' };
  let loginWork;
  let loginAbort;
  let changing = false;

  async function state() {
    const config = loadConfig(options);
    return {
      gatewayBase: config.gatewayBase,
      publisherConfigReady: config.publisherMissing.length === 0,
      publisherMissing: config.publisherMissing,
      status: await client().status(),
      login: loginState,
    };
  }

  async function close() {
    clearTimeout(timer);
    loginAbort?.abort();
    const current = server;
    server = undefined;
    origin = undefined;
    csrf = undefined;
    if (current?.listening) {
      await new Promise((resolve, reject) => {
        current.close(error => error ? reject(error) : resolve());
        current.closeAllConnections();
      });
    }
    if (loginWork) await loginWork;
  }

  async function start() {
    csrf = randomBytes(32).toString('hex');
    server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      const send = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(body));
      };
      try {
        if (!origin || request.headers.host !== new URL(origin).host) return send(403, { error: 'forbidden' });
        const url = new URL(request.url, origin);
        if (url.origin !== origin) return send(403, { error: 'forbidden' });
        if (request.method === 'GET' && url.pathname === '/') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(renderSetup(csrf));
          return;
        }
        if ((request.headers.origin && request.headers.origin !== origin)
          || ![undefined, 'none', 'same-origin'].includes(request.headers['sec-fetch-site'])
          || !matchesToken(request.headers['x-memory-house-setup'], csrf)) {
          return send(403, { error: 'forbidden' });
        }
        if (request.method === 'GET' && url.pathname === '/api/state') return send(200, await state());
        if (request.method !== 'POST' || !['/api/login', '/api/logout'].includes(url.pathname)) {
          return send(404, { error: 'not_found' });
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
          return send(415, { error: 'application_json_required' });
        }
        if (changing || loginState.state === 'running') return send(409, { error: 'operation_in_progress' });
        const input = await readBody(request);
        const parsed = emptySchema.safeParse(input);
        if (!parsed.success) return send(400, { error: 'invalid_input', message: 'Sign-in accepts no configuration, identity or credential arguments.' });
        if (changing || loginState.state === 'running') return send(409, { error: 'operation_in_progress' });
        if (url.pathname === '/api/login') {
          const selected = client();
          requirePublisherConfig(selected.config);
          loginAbort = new AbortController();
          loginState = { state: 'running' };
          // Credentials and provider messages remain inside the auth helper, never in HTTP or MCP output.
          loginWork = Promise.resolve().then(() => login({
            client: selected, env, mode: 'browser', signal: loginAbort.signal,
            onMessage: () => {}, openBrowser: value => openBrowser(value, { signal: loginAbort.signal }),
          })).then(() => { loginState = { state: 'complete' }; }, error => {
            loginState = { state: 'error', ...safeError(error) };
          });
          return send(202, { login: loginState });
        }
        changing = true;
        try {
          const result = await client().logout();
          loginState = { state: 'idle' };
          return send(200, result);
        } finally {
          changing = false;
        }
      } catch (error) {
        send(error instanceof MemoryHouseError ? 400 : 500, safeError(error));
      }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    }).catch(error => { server = undefined; csrf = undefined; throw error; });
    origin = `http://127.0.0.1:${server.address().port}`;
    timer = setTimeout(() => { void close().catch(() => process.stderr.write('memory-house: setup cleanup failed.\n')); }, lifetimeMs);
    timer.unref();
  }

  async function open() {
    if (!server) {
      opening ??= start().finally(() => { opening = undefined; });
      await opening;
    } else if (opening) {
      await opening;
    }
    const url = `${origin}/`;
    if (env.MEMORY_HOUSE_NO_BROWSER === '1') {
      return { url, browserOpened: false, message: 'Open this local page and select Sign in with Microsoft. Automatic browser opening is disabled; credentials stay out of chat.' };
    }
    const signal = AbortSignal.timeout(5000);
    try {
      await openBrowser(url, { allowLoopback: true, signal });
      return { url, browserOpened: true, message: 'Select Sign in with Microsoft in the local page. Deployment settings are already supplied by the publisher; do not send credentials to chat.' };
    } catch {
      return { url, browserOpened: false, message: 'The browser could not be opened. Open this local sign-in link yourself. Do not send credentials to chat.' };
    }
  }
  return { open, close, status: () => ({ ...loginState }) };
}

function renderSetup(csrf) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Memory House sign-in</title>
<style>
body{font:16px system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#192735;background:#f5f7fa}
h1{margin-bottom:8px}p{line-height:1.5}section{background:white;border:1px solid #ced7e0;border-radius:10px;padding:20px;margin:20px 0}
button{font:inherit;padding:9px 16px;margin:14px 8px 0 0;cursor:pointer}button:disabled{cursor:wait;opacity:.6}
#status{white-space:pre-wrap;overflow-wrap:anywhere}#error{color:#b42318;white-space:pre-wrap}small{display:block;line-height:1.5;color:#465768}
</style></head><body>
<h1>Memory House</h1><p>One local sign-in for Claude Code, Codex, Cursor, and Copilot. The apps share your private Memory House state on this device.</p>
<p>Your plugin publisher supplies the deployment settings. Select Sign in with Microsoft to connect your account; never paste tokens or passwords here or in chat.</p>
<section><h2>Sign-in and status</h2><p id="status" aria-live="polite">Loading local status...</p>
<button id="login">Sign in with Microsoft</button><button id="refresh">Refresh status</button><button id="logout">Sign out</button>
<p id="error" role="alert"></p></section>
<p>Search uses existing memories. Explicit insertion submits conversational text for asynchronous extraction, not immediate fact publication. This page expires after ten minutes or when the app disconnects its MCP server.</p>
<script>
const csrf=${JSON.stringify(csrf)};
const el=id=>document.getElementById(id);
let busy=false, ready=false;
function controls(value){busy=value;document.querySelectorAll('button').forEach(button=>{button.disabled=value;});el('login').disabled=value||!ready;}
async function api(path,body){
 const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'x-memory-house-setup':csrf,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json(); if(!response.ok)throw new Error(data.message||data.error||'Operation failed');return data;
}
async function refresh(){
 const data=await api('/api/state');
 ready=data.publisherConfigReady;
 el('status').textContent='Gateway: '+data.gatewayBase+'\\n'+(data.status.signedIn?'Signed in. Search and insertion are available.':'Not signed in to this gateway.')+'\\nSign-in: '+data.login.state;
 if(data.login.state==='error')el('error').textContent=data.login.message;
 if(!ready)el('error').textContent='This plugin has not been configured for Microsoft sign-in by its publisher. Missing: '+data.publisherMissing.join(', ')+'. Ask the publisher to complete deployment.json; you do not need to supply registration details.';
 controls(data.login.state==='running');
}
async function action(work){if(busy)return;controls(true);el('error').textContent='';try{await work();await refresh();}catch(error){el('error').textContent=error.message;controls(false);}}
el('login').onclick=()=>action(()=>api('/api/login',{}));
el('logout').onclick=()=>{if(confirm('Revoke the current Memory House refresh token and clear local credentials for all apps on this device?'))action(()=>api('/api/logout',{}));};
el('refresh').onclick=()=>action(async()=>{});
refresh().catch(error=>{el('error').textContent=error.message;});
setInterval(()=>{refresh().catch(error=>{el('error').textContent='Setup is unavailable or expired. Reopen memory_setup in your app. '+error.message;});},2000);
</script></body></html>`;
}

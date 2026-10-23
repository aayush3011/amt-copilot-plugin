// Loopback server for the Memory House canvas in the GitHub Copilot app. The page and its JSON
// routes are bound to 127.0.0.1. API routes require the per-server capability token, a loopback
// Host header (DNS-rebinding defence) and a same-origin fetch.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MemoryHouseError, safeError } from '../errors.mjs';
import { createGateway, loadCanvasData, summarizeCanvasData } from './data.mjs';
import { defaultRoots, importMemories, importSessions, importSource, listSessions, IMPORT_LIMITS } from './importers.mjs';
import { renderPanel } from './panel.mjs';

export { createGateway, loadCanvasData, summarizeCanvasData };

const SIGN_IN_CODES = new Set([
  'NOT_SIGNED_IN', 'AZURE_CLI_AUTH_REQUIRED', 'AZURE_CLI_NOT_FOUND', 'AZURE_CLI_TOKEN_INVALID',
  'INVALID_AUTH_STATE', 'PUBLISHER_CONFIG_MISSING',
]);
const BAD_REQUEST_CODES = new Set(['INVALID_PAYLOAD']);
const BODY_LIMIT = 64 * 1024;
const TOKEN_HEADER = 'x-mh-canvas-token';

/** A safe { code, message } for canvas action failures; never includes server text or credentials. */
export function canvasActionError(error) {
  const safe = safeError(error);
  return { code: SIGN_IN_CODES.has(safe.code) ? 'not_signed_in' : safe.code.toLowerCase(), message: safe.message };
}

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}

// The page itself must stay embeddable by the app, so only the JSON routes are same-origin resources.
function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8', 'Cross-Origin-Resource-Policy': 'same-origin',
  });
}

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameToken(provided, expected) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type') ?? '')) {
    throw new RequestError(415, 'unsupported_media_type', 'Send a JSON request body.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new RequestError(413, 'payload_too_large', 'The request body is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch {
    throw new RequestError(400, 'invalid_json', 'The request body must be a JSON object.');
  }
}

function failure(res, error) {
  if (error instanceof RequestError) return sendJson(res, error.status, { error: error.code, message: error.message });
  if (error instanceof MemoryHouseError) {
    const safe = safeError(error);
    if (SIGN_IN_CODES.has(safe.code)) return sendJson(res, 401, { error: 'not_signed_in', code: safe.code, message: safe.message });
    return sendJson(res, BAD_REQUEST_CODES.has(safe.code) ? 400 : 502, { error: safe.code, message: safe.message });
  }
  return sendJson(res, 500, { error: 'internal_error', message: 'The Memory House canvas hit an unexpected error.' });
}

/**
 * Start one canvas server on an ephemeral loopback port.
 * `gateway` options are passed to createGateway (tests inject a client configuration);
 * `roots` overrides the Copilot and Claude history locations.
 */
export async function startCanvasServer({ gateway: gatewayOptions = {}, roots = defaultRoots() } = {}) {
  const token = randomBytes(32).toString('base64url');
  let gateway;
  const getGateway = () => (gateway ??= createGateway(gatewayOptions));
  let port = 0;
  let importing = false;

  const loopbackHost = value => value === `127.0.0.1:${port}` || value === `localhost:${port}`;
  const guardApi = req => {
    if (!loopbackHost(header(req, 'host'))) throw new RequestError(403, 'forbidden', 'Forbidden.');
    const site = header(req, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new RequestError(403, 'forbidden', 'Forbidden.');
    if (!sameToken(header(req, TOKEN_HEADER), token)) throw new RequestError(403, 'forbidden', 'Forbidden.');
  };
  const exclusive = async work => {
    if (importing) throw new RequestError(409, 'import_in_progress', 'Another import is still running. Wait for it to finish.');
    importing = true;
    try { return await work(); } finally { importing = false; }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      if (url.pathname === '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new RequestError(405, 'method_not_allowed', 'Method not allowed.');
        if (!loopbackHost(header(req, 'host'))) throw new RequestError(403, 'forbidden', 'Forbidden.');
        const nonce = randomBytes(18).toString('base64');
        return send(res, 200, req.method === 'HEAD' ? undefined : renderPanel({ token, nonce }), {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self'`,
        });
      }
      if (!url.pathname.startsWith('/api/')) throw new RequestError(404, 'not_found', 'Not found.');
      guardApi(req);
      switch (route) {
        case 'GET /api/memory': {
          const data = await loadCanvasData(getGateway(), {
            search: url.searchParams.get('search') ?? '',
            memoryTypes: url.searchParams.getAll('memory_types'),
            includeSuperseded: url.searchParams.get('include_superseded') === 'true',
            limit: url.searchParams.get('limit'),
          });
          return sendJson(res, 200, data);
        }
        case 'GET /api/import/sessions': {
          const source = importSource(url.searchParams.get('source'));
          return sendJson(res, 200, { source, limit: IMPORT_LIMITS.sessions, sessions: await listSessions(source, roots) });
        }
        case 'POST /api/import/sessions': {
          const body = await readJson(req);
          const source = importSource(body.source);
          return sendJson(res, 200, await exclusive(() => importSessions({ gateway: getGateway(), source, ids: body.ids, roots })));
        }
        case 'POST /api/import/memories': {
          const body = await readJson(req);
          const source = importSource(body.source);
          return sendJson(res, 200, await exclusive(() => importMemories({ gateway: getGateway(), source, roots })));
        }
        default:
          throw new RequestError(404, 'not_found', 'Not found.');
      }
    } catch (error) {
      if (!res.headersSent) failure(res, error);
      else res.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

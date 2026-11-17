// The forge's HTTP surface: router + auth + request-id. main.ts drives the lifecycle; this file is
// the server we grow.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { gitHandler } from './gitserver.ts';
import { USER_LOGIN } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const MAX_BODY = 256 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): Record<string, string> {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const out: Record<string, string> = {};
    for (const [k, v] of url.searchParams) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (TOKEN === '') return false;
  if (!auth) return false;
  const expected = `Bearer ${TOKEN}`;
  if (auth === expected || auth === TOKEN) return true;
  return auth === `bearer ${TOKEN}`;
}

interface GitMatch {
  owner: string;
  repo: string;
  suffix: string;
}

function matchGit(path: string): GitMatch | null {
  const m = /^\/([^/]+)\/([^/]+?)\.git(?:\/(.*))?$/.exec(path);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, suffix: m[3] ?? '' };
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const requestId = randomUUID();
    const common = { 'x-github-request-id': requestId };

    try {
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, common);
        return;
      }

      const git = matchGit(path);
      if (git) {
        // auth required
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, common);
          return;
        }
        if (git.suffix === 'info/refs') {
          const service = req.url ? new URL(req.url, 'http://entry').searchParams.get('service') ?? '' : '';
          try {
            const out = gitHandler.handleInfoRefs(git.owner, git.repo, service, { headers: req.headers as Record<string, string | undefined> });
            sendBuffer(res, out.status, out.contentType, out.body);
          } catch (e) {
            if (isNotFound(e)) sendJson(res, 404, { message: 'Not Found' }, common);
            else { console.error(e); sendJson(res, 500, { message: 'Internal Server Error' }, common); }
          }
          return;
        }
        if (git.suffix === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          try {
            const out = gitHandler.handleUploadPack(git.owner, git.repo, body, { headers: req.headers as Record<string, string | undefined> });
            sendBuffer(res, out.status, out.contentType, out.body);
          } catch (e) {
            if (isNotFound(e)) sendJson(res, 404, { message: 'Not Found' }, common);
            else { console.error(e); sendJson(res, 500, { message: 'Internal Server Error' }, common); }
          }
          return;
        }
        if (git.suffix === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          try {
            const out = gitHandler.handleReceivePack(git.owner, git.repo, body);
            sendBuffer(res, out.status, out.contentType, out.body);
          } catch (e) {
            if (isNotFound(e)) sendJson(res, 404, { message: 'Not Found' }, common);
            else { console.error(e); sendJson(res, 500, { message: 'Internal Server Error' }, common); }
          }
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, common);
        return;
      }

      if (path === '/api/graphql') {
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, common); return; }
        if (!isAuthorized(req)) { sendJson(res, 401, { message: 'Requires authentication' }, common); return; }
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req)).toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Bad request' }, common);
          return;
        }
        const out = handleGraphql(body, USER_LOGIN);
        sendJson(res, out.status, out.json, common);
        return;
      }

      if (path === '/mcp') {
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, common); return; }
        const bodyText = (await readBody(req)).toString('utf8');
        const out = handleMcp(bodyText, req.headers as Record<string, string | undefined>, isAuthorized(req) ? USER_LOGIN : '', `${req.headers.host ?? ''}`);
        if (out.json === null) {
          res.writeHead(out.status, { ...common });
          res.end();
          return;
        }
        sendJson(res, out.status, out.json, common);
        return;
      }

      if (path.startsWith('/api/v3')) {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, common);
          return;
        }
        let body: unknown;
        const raw = await readBody(req);
        if (raw.length === 0) {
          body = undefined;
        } else {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Bad request' }, common);
            return;
          }
        }
        let restPath = path.slice('/api/v3'.length);
        if (restPath === '') restPath = '/';
        const origin = `http://${req.headers.host ?? ''}`;
        const out = handleRest({ method, path: restPath, query: queryOf(req), body, origin, login: USER_LOGIN });
        if (out.body === null) {
          res.writeHead(out.status, { ...common, ...out.headers });
          res.end();
          return;
        }
        sendJson(res, out.status, out.body, { ...common, ...out.headers });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, common);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, common);
      else res.end();
    }
  });
}

function isNotFound(e: unknown): boolean {
  return e instanceof Error && e.name === 'NotFound';
}

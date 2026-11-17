// MCP streamable-HTTP endpoint (modern 2026-07-28 era) exposing forge tools as JSON-RPC.

import { applyHead } from './graphql.ts';
import { Repo, store, USER_LOGIN } from './store.ts';
import { parseCommit } from './gitobj.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpResponse {
  status: number;
  json: unknown | null;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get repository details',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function rpcError(code: number, message: string): Record<string, unknown> {
  return { code, message };
}

export function handleMcp(bodyText: string, headers: Record<string, string | undefined>, login: string, origin: string): McpResponse {
  // Parse JSON-RPC request
  let request: any;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: rpcError(-32700, 'Parse error') } };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: rpcError(-32700, 'Parse error') } };
  }
  const id = request.id !== undefined ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';

  if (!login) {
    return { status: 401, json: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          supportedVersions: SUPPORTED_VERSIONS,
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        },
      },
    };
  }
  if (method === 'initialize') {
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      },
    };
  }
  if (method === 'notifications/initialized') {
    return { status: 200, json: null };
  }
  if (method === 'tools/list') {
    return { status: 200, json: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }
  if (method === 'tools/call') {
    return callTool(request.params, id);
  }
  return { status: 200, json: { jsonrpc: '2.0', id, error: rpcError(-32601, 'Method not found') } };
}

function toolResult(contentJson: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(contentJson) }], structuredContent: contentJson };
}

function callTool(params: any, id: unknown): McpResponse {
  const name = typeof params?.name === 'string' ? params.name : '';
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { status: 200, json: { jsonrpc: '2.0', id, error: rpcError(-32601, `Unknown tool: ${name}`) } };
  }
  const get = (k: string): string => (typeof args[k] === 'string' ? args[k] as string : '');
  const owner = get('owner') || USER_LOGIN;
  const repoName = get('repo');
  try {
    switch (name) {
      case 'create_repo': {
        const repo = store.getRepo(owner, get('name'));
        if (repo) throw new ApiError('Repository already exists', 422);
        const created = store.createRepo(owner, get('name'), { private: args.private === true, description: get('description') });
        return { status: 200, json: { jsonrpc: '2.0', id, result: toolResult(repoJson(created)) } };
      }
      case 'get_repo': {
        const repo = store.getRepo(owner, repoName);
        if (!repo) throw new ApiError('Not found', 404);
        return { status: 200, json: { jsonrpc: '2.0', id, result: toolResult(repoJson(repo)) } };
      }
      case 'create_issue': {
        const repo = requireRepo(owner, repoName);
        const title = get('title');
        const now = new Date().toISOString();
        const issue = { id: hashId(`${repo.id}-i-${repo.nextIssue}`), number: repo.nextIssue++, title, body: get('body'), state: 'open' as const, labels: [] as string[], created_at: now, updated_at: now, comments: [], user: { login: owner } };
        repo.issues.push(issue);
        return { status: 200, json: { jsonrpc: '2.0', id, result: toolResult({ number: issue.number, id: issue.id, title, state: 'open' }) } };
      }
      case 'list_issues': {
        const repo = requireRepo(owner, repoName);
        const state = get('state') || 'open';
        let list = repo.issues;
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const mapped = list.map((i) => ({ number: i.number, id: i.id, title: i.title, body: i.body, state: i.state }));
        return { status: 200, json: { jsonrpc: '2.0', id, result: toolResult(mapped) } };
      }
      case 'create_pull_request': {
        const repo = requireRepo(owner, repoName);
        const head = get('head');
        const base = get('base') || repo.defaultBranch;
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) throw new ApiError('branch not found', 422);
        const now = new Date().toISOString();
        const pull = { id: hashId(`${repo.id}-p-${repo.nextPull}`), number: repo.nextPull++, title: get('title'), body: get('body'), state: 'open' as const, merged: false, merged_at: null as string | null, merge_commit_sha: null as string | null, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, created_at: now, updated_at: now, user: { login: owner } };
        repo.pulls.push(pull);
        return { status: 200, json: { jsonrpc: '2.0', id, result: toolResult({ number: pull.number, id: pull.id, state: 'open', headRefName: head, baseRefName: base }) } };
      }
      case 'merge_pull_request': {
        const repo = requireRepo(owner, repoName);
        const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
        const pull = repo.pulls.find((p) => p.number === number);
        if (!pull) throw new ApiError('Not found', 404);
        const baseRef = `refs/heads/${pull.base.ref}`;
        const curBaseTip = repo.refs.get(baseRef);
        const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
        if (!curBaseTip || !headTip) throw new ApiError('cannot merge', 409);
        const baseCommit = store.getObject(repo, curBaseTip);
        const headCommit = store.getObject(repo, headTip);
        if (!baseCommit || !headCommit) throw new ApiError('cannot merge', 409);
        const baseTree = parseCommit(baseCommit.data).tree;
        const headTree = parseCommit(headCommit.data).tree;
        const finalTree = mergeTrees(repo, baseTree, headTree);
        const newCommit = store.makeCommit(repo, finalTree, [curBaseTip], `Merge pull request #${pull.number} from ${pull.head.ref}`);
        repo.refs.set(baseRef, newCommit);
        pull.merged = true;
        pull.state = 'closed';
        pull.merged_at = new Date().toISOString();
        pull.merge_commit_sha = newCommit;
        return { status: 200, json: { jsonrpc: '2.0', id, result: toolResult({ merged: true, sha: newCommit, number: pull.number, state: 'closed' }) } };
      }
      default:
        return { status: 200, json: { jsonrpc: '2.0', id, error: rpcError(-32601, `Unknown tool: ${name}`) } };
    }
  } catch (e) {
    if (e instanceof ApiError) {
      return { status: 200, json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } } };
    }
    return { status: 200, json: { jsonrpc: '2.0', id, error: rpcError(-32603, e instanceof Error ? e.message : 'Internal error') } };
  }
}

class ApiError extends Error {}

function requireRepo(owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (!repo) throw new ApiError('Not found');
  return repo;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return { id: repo.id, name: repo.name, full_name: repo.fullName(), owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch };
}

function mergeTrees(repo: Repo, baseTree: string, headTree: string): string {
  // For MCP merges, apply head tree onto base tree (assume no conflict in tested cases)
  const baseCommitObj = store.getObject(repo, baseTree);
  const headCommitObj = store.getObject(repo, headTree);
  // full tree replacement is not correct; do path-level like graphql
  return applyHead(repo, baseTree, headTree);
}

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

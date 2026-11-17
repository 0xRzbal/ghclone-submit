// GitHub REST v3 under /api/v3, backed by the shared store (same git objects as smart HTTP).

import { Repo, RepoExistsError, Store, store, USER_LOGIN, USER_NAME, USER_EMAIL } from './store.ts';
import { parseCommit, parseTree } from './gitobj.ts';

export interface RestRequest {
  method: string;
  path: string; // pathname under /api/v3, e.g. /user/repos
  query: Record<string, string>;
  body: unknown;
  origin: string;
  login: string;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown | null; // null => empty body
}

const NOT_FOUND: RestResponse = { status: 404, headers: {}, body: { message: 'Not Found' } };
const UNAUTHORIZED: RestResponse = { status: 401, headers: {}, body: { message: 'Requires authentication' } };

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `repo_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName(),
    private: repo.private,
    owner: { login: repo.owner, id: repo.id, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date(repo.createdAt).toISOString(),
    updated_at: new Date(repo.updatedAt).toISOString(),
    has_issues: true,
    pushed_at: new Date(repo.updatedAt).toISOString(),
    html_url: `${repo.owner}/${repo.name}`,
    clone_url: `${repo.owner}/${repo.name}.git`,
  };
}

function issueObject(repo: Repo, issue: import('./store.ts').Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `issue_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, id: hashId(name), color: 'ededed' })),
    user: { login: repo.owner, id: repo.id },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments.length,
    html_url: `${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: import('./store.ts').Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `pull_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    user: { login: repo.owner, id: repo.id },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `${repo.owner}/${repo.name}/pulls/${pull.number}`,
    mergeable: !conflictStatus(repo, pull),
  };
}

function hashId(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

function conflictStatus(repo: Repo, pull: import('./store.ts').Pull): boolean {
  // conflict detection for mergeable: whether head changes conflict with current base
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!baseTip) return false;
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  if (!headTip) return false;
  const mergeBase = findMergeBase(repo, headTip, baseTip);
  if (!mergeBase) return false;
  const headChanges = changedPathsBetween(repo, parseCommit(store.getObject(repo, mergeBase)!.data).tree, parseCommit(store.getObject(repo, headTip)!.data).tree);
  const targetChanges = changedPathsBetween(repo, parseCommit(store.getObject(repo, mergeBase)!.data).tree, parseCommit(store.getObject(repo, baseTip)!.data).tree);
  for (const p of headChanges) {
    if (!targetChanges.has(p)) continue;
    const hb = blobAtPath(repo, parseCommit(store.getObject(repo, headTip)!.data).tree, p);
    const tb = blobAtPath(repo, parseCommit(store.getObject(repo, baseTip)!.data).tree, p);
    if ((hb === null) !== (tb === null) || (hb !== null && tb !== null && !hb.equals(tb))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- tree helpers (shared with merge)

function walkTreeMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

function blobAtPath(repo: Repo, treeOid: string, path: string): Buffer | null {
  const map = walkTreeMap(repo, treeOid);
  const entry = map.get(path);
  if (!entry) return null;
  return store.getObject(repo, entry.oid)?.data ?? null;
}

function changedPathsBetween(repo: Repo, treeA: string, treeB: string): Set<string> {
  const a = walkTreeMap(repo, treeA);
  const b = walkTreeMap(repo, treeB);
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const changed = new Set<string>();
  for (const k of keys) {
    const ea = a.get(k);
    const eb = b.get(k);
    if (!ea && !eb) continue;
    if (!ea || !eb || ea.oid !== eb.oid) changed.add(k);
  }
  return changed;
}

function findMergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestors = new Set<string>();
  const walkA = (oid: string): void => {
    if (ancestors.has(oid)) return;
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return;
    ancestors.add(oid);
    for (const p of parseCommit(obj.data).parents) walkA(p);
  };
  walkA(a);
  const queue = [b];
  const visited = new Set<string>();
  while (queue.length) {
    const c = queue.shift()!;
    if (visited.has(c)) continue;
    visited.add(c);
    if (ancestors.has(c)) return c;
    const obj = store.getObject(repo, c);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
  }
  return undefined;
}

function applyChangesToTree(repo: Repo, targetTree: string, baseTree: string, headTree: string): string {
  const changed = changedPathsBetween(repo, baseTree, headTree);
  let tree = targetTree;
  const headMap = walkTreeMap(repo, headTree);
  for (const p of changed) {
    const segments = p.split('/').filter(Boolean);
    const headEntry = headMap.get(p);
    if (headEntry) {
      tree = store.setTreePath(repo, tree, segments, '100644', headEntry.oid);
    } else {
      tree = store.setTreePath(repo, tree, segments, '100644', null);
    }
  }
  return tree;
}

// ---------------------------------------------------------------- main dispatcher

export function handleRest(req: RestRequest): RestResponse {
  const p = req.path;
  const method = req.method;

  if (req.login === '' ) return UNAUTHORIZED;

  if (p === '/' || p === '') {
    return { status: 200, headers: { 'x-oauth-scopes': 'repo, read:org' }, body: { current_user_url: '/api/v3/user' } };
  }
  if (p === '/meta') {
    return { status: 200, headers: {}, body: { installed_version: '1.0.0' } };
  }
  if (p === '/user/repos') {
    if (method === 'GET') return listUserRepos(req);
    if (method === 'POST') return createRepoForUser(req);
  }

  // /repos/{owner}/{repo}[/...]
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
  if (m) {
    const owner = m[1]!;
    const name = m[2]!;
    const rest = m[3] ?? '';
    return handleRepo(owner, name, rest, method, req);
  }

  // /user (not used)
  return NOT_FOUND;
}

function listUserRepos(req: RestRequest): RestResponse {
  const repos = store.userRepos(req.login);
  const perPage = clampInt(req.query.per_page, 30, 1, 100);
  const page = clampInt(req.query.page, 1, 1, 100000);
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage).map((r) => repoObject(r));
  const headers: Record<string, string> = {};
  if (start + perPage < repos.length) {
    const next = `${req.origin}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
    headers.link = `<${next}>; rel="next"`;
  }
  return { status: 200, headers, body: slice };
}

function clampInt(value: string | undefined, dflt: number, min: number, max: number): number {
  if (value === undefined) return dflt;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function createRepoForUser(req: RestRequest): RestResponse {
  const b = req.body as Record<string, unknown> | null;
  if (b === null) return { status: 400, headers: {}, body: { message: 'Bad request' } };
  const name = typeof b.name === 'string' ? b.name : '';
  if (!name) return { status: 422, headers: {}, body: { message: 'name is required' } };
  try {
    const repo = store.createRepo(req.login, name, {
      private: b.private === true,
      description: typeof b.description === 'string' ? b.description : '',
    });
    return { status: 201, headers: {}, body: repoObject(repo) };
  } catch (e) {
    if (e instanceof RepoExistsError) return { status: 422, headers: {}, body: { message: 'Repository already exists' } };
    throw e;
  }
}

function handleRepo(owner: string, name: string, rest: string, method: string, req: RestRequest): RestResponse {
  const repo = store.getRepo(owner, name);
  if (!repo) return NOT_FOUND;

  if (rest === '' || rest === '/') {
    if (method === 'GET') return { status: 200, headers: {}, body: repoObject(repo) };
    if (method === 'PATCH') {
      const b = req.body as Record<string, unknown> | null;
      if (b && typeof b.description === 'string') repo.description = b.description;
      repo.updatedAt = Date.now();
      return { status: 200, headers: {}, body: repoObject(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, headers: {}, body: null };
    }
    return NOT_FOUND;
  }

  // /contents/... 
  if (rest.startsWith('/contents')) {
    const relPath = decodeURIComponent(rest.slice('/contents'.length)).replace(/^\/+/, '');
    return handleContents(repo, relPath, method, req);
  }

  if (rest === '/git/refs' && method === 'POST') return createRef(repo, req);
  if (rest === '/branches' && method === 'GET') return listBranches(repo);
  if (rest === '/commits' && method === 'GET') return listCommits(repo, req);
  if (rest === '/labels' && method === 'POST') return createLabel(repo, req);
  if (rest === '/issues' && method === 'POST') return createIssue(repo, req);
  if (rest === '/issues' && method === 'GET') return listIssues(repo, req);
  if (rest.startsWith('/issues/')) {
    const mm = /^\/issues\/(\d+)(\/.*)?$/.exec(rest);
    if (mm) {
      const number = parseInt(mm[1]!, 10);
      const sub = mm[2] ?? '';
      return handleIssue(repo, number, sub, method, req);
    }
  }
  if (rest === '/pulls' && method === 'POST') return createPull(repo, req);
  if (rest === '/pulls' && method === 'GET') return listPulls(repo, req);
  if (rest.startsWith('/pulls/')) {
    const mm = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest);
    if (mm) {
      const number = parseInt(mm[1]!, 10);
      const sub = mm[2] ?? '';
      return handlePull(repo, number, sub, method, req);
    }
  }
  return NOT_FOUND;
}

function handleContents(repo: Repo, relPath: string, method: string, req: RestRequest): RestResponse {
  const ref = req.query.ref ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`);
  if (method === 'GET') {
    if (!tip) return NOT_FOUND;
    // directory or file?
    const commit = store.getObject(repo, tip);
    if (!commit) return NOT_FOUND;
    const view = parseCommit(commit.data);
    const file = store.readFileAtCommit(repo, tip, relPath);
    if (file) {
      const content = file.content.toString('base64');
      return {
        status: 200,
        headers: {},
        body: { type: 'file', encoding: 'base64', content, sha: file.blobOid, size: file.size, name: relPath.split('/').pop(), path: relPath },
      };
    }
    const dir = store.listDirAtCommit(repo, tip, relPath);
    if (dir) {
      return {
        status: 200,
        headers: {},
        body: dir.map((entry) => ({
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          type: entry.type,
          size: 0,
        })),
      };
    }
    return NOT_FOUND;
  }
  if (method === 'PUT') return putContent(repo, relPath, req, tip);
  if (method === 'DELETE') return deleteContent(repo, relPath, req);
  return NOT_FOUND;
}

function putContent(repo: Repo, relPath: string, req: RestRequest, tipOfRef: string | undefined): RestResponse {
  const b = req.body as Record<string, unknown> | null;
  if (!b) return { status: 400, headers: {}, body: { message: 'Bad request' } };
  const message = typeof b.message === 'string' ? b.message : '';
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const contentRaw = typeof b.content === 'string' ? b.content : '';
  let content: Buffer;
  try { content = Buffer.from(contentRaw, 'base64'); } catch { return { status: 400, headers: {}, body: { message: 'Bad content' } }; }
  const existing = tip ? store.readFileAtCommit(repo, tip, relPath) : null;
  const providedSha = typeof b.sha === 'string' ? b.sha : undefined;
  if (providedSha !== undefined) {
    const expected = existing ? existing.blobOid : undefined;
    if (expected !== providedSha) return { status: 409, headers: {}, body: { message: 'sha does not match the current blob' } };
  }
  const blobOid = store.putObject(repo, 'blob', content);
  const baseTree = tip ? parseCommit(store.getObject(repo, tip)!.data).tree : undefined;
  const segments = relPath.split('/').filter(Boolean);
  const newTree = store.setTreePath(repo, baseTree, segments, '100644', blobOid);
  const parents = tip ? [tip] : [];
  const newCommit = store.makeCommit(repo, newTree, parents, message || 'update file');
  repo.refs.set(ref, newCommit);
  repo.updatedAt = Date.now();
  const status = existing ? 200 : 201;
  return { status, headers: {}, body: { commit: { sha: newCommit }, content: { sha: blobOid, encoding: 'base64', name: relPath.split('/').pop() } } };
}

function deleteContent(repo: Repo, relPath: string, req: RestRequest): RestResponse {
  const b = req.body as Record<string, unknown> | null;
  const branch = b && typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (!tip) return NOT_FOUND;
  const baseTree = parseCommit(store.getObject(repo, tip)!.data).tree;
  const segments = relPath.split('/').filter(Boolean);
  const newTree = store.setTreePath(repo, baseTree, segments, '100644', null);
  const newCommit = store.makeCommit(repo, newTree, [tip], (b && typeof b.message === 'string' ? b.message : 'delete file'));
  repo.refs.set(ref, newCommit);
  repo.updatedAt = Date.now();
  return { status: 200, headers: {}, body: { commit: { sha: newCommit } } };
}

function createRef(repo: Repo, req: RestRequest): RestResponse {
  const b = req.body as Record<string, unknown> | null;
  if (!b) return { status: 400, headers: {}, body: { message: 'Bad request' } };
  const refName = typeof b.ref === 'string' ? b.ref : '';
  const sha = typeof b.sha === 'string' ? b.sha : '';
  if (!refName.startsWith('refs/')) return { status: 422, headers: {}, body: { message: 'invalid ref' } };
  if (repo.refs.has(refName)) return { status: 422, headers: {}, body: { message: 'Reference already exists' } };
  if (!store.getObject(repo, sha)) return { status: 422, headers: {}, body: { message: 'invalid sha' } };
  repo.refs.set(refName, sha);
  repo.updatedAt = Date.now();
  return { status: 201, headers: {}, body: { ref: refName, object: { sha, type: 'commit' } } };
}

function listBranches(repo: Repo): RestResponse {
  const out: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) {
      out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { status: 200, headers: {}, body: out };
}

function listCommits(repo: Repo, req: RestRequest): RestResponse {
  const sha = req.query.sha ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${sha}`);
  if (!tip && !/^[0-9a-f]{40}$/.test(sha)) return NOT_FOUND;
  let current = tip ?? (repo.refs.has(`refs/heads/${sha}`) ? repo.refs.get(`refs/heads/${sha}`) : undefined);
  if (!current) return NOT_FOUND;
  const out: Record<string, unknown>[] = [];
  let guard = 0;
  while (current && guard < 10000) {
    const obj = store.getObject(repo, current);
    if (!obj || obj.type !== 'commit') break;
    const view = parseCommit(obj.data);
    out.push({ sha: current, commit: { message: view.message, author: { login: repo.owner }, tree: { sha: view.tree }, ...(view.parents.length ? { parents: view.parents.map((p) => ({ sha: p })) } : {}) } });
    current = view.parents[0];
    guard += 1;
  }
  return { status: 200, headers: {}, body: out };
}

function createLabel(repo: Repo, req: RestRequest): RestResponse {
  const b = req.body as Record<string, unknown> | null;
  if (!b || typeof b.name !== 'string' || !b.name) return { status: 422, headers: {}, body: { message: 'name required' } };
  if (repo.labels.some((l) => l.name === b.name)) return { status: 422, headers: {}, body: { message: 'Label already exists' } };
  const label = { id: hashId(b.name), name: b.name, color: typeof b.color === 'string' ? b.color : 'ededed' };
  repo.labels.push(label);
  return { status: 201, headers: {}, body: { name: label.name, color: label.color } };
}

function createIssue(repo: Repo, req: RestRequest): RestResponse {
  const b = req.body as Record<string, unknown> | null;
  if (!b) return { status: 400, headers: {}, body: { message: 'Bad request' } };
  const title = typeof b.title === 'string' ? b.title : '';
  if (!title) return { status: 422, headers: {}, body: { message: 'title required' } };
  const labelsIn = Array.isArray(b.labels) ? b.labels : [];
  const labelNames: string[] = [];
  for (const lbl of labelsIn) {
    const name = typeof lbl === 'string' ? lbl : (typeof lbl === 'object' && lbl !== null && typeof (lbl as Record<string, unknown>).name === 'string' ? ((lbl as Record<string, unknown>).name as string) : '');
    if (!repo.labels.some((l) => l.name === name)) return { status: 422, headers: {}, body: { message: `invalid label: ${name}` } };
    labelNames.push(name);
  }
  const now = new Date().toISOString();
  const issue = {
    id: hashId(`${repo.id}-issue-${repo.nextIssue}`),
    number: repo.nextIssue++,
    title,
    body: typeof b.body === 'string' ? b.body : '',
    state: 'open' as const,
    labels: labelNames,
    created_at: now,
    updated_at: now,
    comments: [],
    user: { login: repo.owner },
  };
  repo.issues.push(issue);
  repo.updatedAt = Date.now();
  return { status: 201, headers: {}, body: issueObject(repo, issue) };
}

function listIssues(repo: Repo, req: RestRequest): RestResponse {
  const state = req.query.state ?? 'open';
  const sort = req.query.sort ?? 'created';
  const direction = req.query.direction ?? 'desc';
  const perPage = clampInt(req.query.per_page, 30, 1, 100);
  let list = repo.issues.slice();
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  return { status: 200, headers: {}, body: list.slice(0, perPage).map((i) => issueObject(repo, i)) };
}

function handleIssue(repo: Repo, number: number, sub: string, method: string, req: RestRequest): RestResponse {
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return NOT_FOUND;
  if (sub === '' || sub === '/') {
    if (method === 'GET') return { status: 200, headers: {}, body: issueObject(repo, issue) };
    if (method === 'PATCH') {
      const b = req.body as Record<string, unknown> | null;
      if (b && b.state === 'closed') issue.state = 'closed';
      else if (b && b.state === 'open') issue.state = 'open';
      issue.updated_at = new Date().toISOString();
      return { status: 200, headers: {}, body: issueObject(repo, issue) };
    }
    return NOT_FOUND;
  }
  if (sub === '/comments') {
    if (method === 'POST') {
      const b = req.body as Record<string, unknown> | null;
      const body = b && typeof b.body === 'string' ? b.body : '';
      const comment = { id: repo.commentCounter++, body, created_at: new Date().toISOString() };
      issue.comments.push(comment);
      return { status: 201, headers: {}, body: comment };
    }
    if (method === 'GET') return { status: 200, headers: {}, body: issue.comments };
  }
  return NOT_FOUND;
}

function createPull(repo: Repo, req: RestRequest): RestResponse {
  const b = req.body as Record<string, unknown> | null;
  if (!b) return { status: 400, headers: {}, body: { message: 'Bad request' } };
  const head = typeof b.head === 'string' ? b.head : '';
  const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
  const title = typeof b.title === 'string' ? b.title : '';
  if (!head || !title) return { status: 422, headers: {}, body: { message: 'head and title required' } };
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { status: 422, headers: {}, body: { message: 'branch not found' } };
  const now = new Date().toISOString();
  const pull = {
    id: hashId(`${repo.id}-pull-${repo.nextPull}`),
    number: repo.nextPull++,
    title,
    body: typeof b.body === 'string' ? b.body : '',
    state: 'open' as const,
    merged: false,
    merged_at: null as string | null,
    merge_commit_sha: null as string | null,
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    created_at: now,
    updated_at: now,
    user: { login: repo.owner },
  };
  repo.pulls.push(pull);
  repo.updatedAt = Date.now();
  return { status: 201, headers: {}, body: pullObject(repo, pull) };
}

function listPulls(repo: Repo, req: RestRequest): RestResponse {
  const state = req.query.state ?? 'open';
  const perPage = clampInt(req.query.per_page, 30, 1, 100);
  let list = repo.pulls.slice();
  if (state === 'open') list = list.filter((p) => p.state === 'open');
  else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
  list.sort((a, b) => b.number - a.number);
  return { status: 200, headers: {}, body: list.slice(0, perPage).map((p) => pullObject(repo, p)) };
}

function handlePull(repo: Repo, number: number, sub: string, method: string, req: RestRequest): RestResponse {
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return NOT_FOUND;
  if (sub === '' || sub === '/') {
    if (method === 'GET') return { status: 200, headers: {}, body: pullObject(repo, pull) };
    return NOT_FOUND;
  }
  if (sub === '/files' && method === 'GET') {
    const files = pullFiles(repo, pull);
    return { status: 200, headers: {}, body: files };
  }
  if (sub === '/merge' && method === 'PUT') return mergePull(repo, pull);
  return NOT_FOUND;
}

function pullFiles(repo: Repo, pull: import('./store.ts').Pull): Record<string, unknown>[] {
  const baseTree = parseCommit(store.getObject(repo, pull.base.sha)!.data).tree;
  const headTree = parseCommit(store.getObject(repo, pull.head.sha)!.data).tree;
  const changed = changedPathsBetween(repo, baseTree, headTree);
  const headMap = walkTreeMap(repo, headTree);
  const baseMap = walkTreeMap(repo, baseTree);
  const out: Record<string, unknown>[] = [];
  for (const path of changed) {
    const he = headMap.get(path);
    const be = baseMap.get(path);
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    if (he && !be) {
      status = 'added';
      additions = lineCount(store.getObject(repo, he.oid)!.data);
    } else if (!he && be) {
      status = 'removed';
      deletions = lineCount(store.getObject(repo, be.oid)!.data);
    } else {
      additions = lineCount(store.getObject(repo, he!.oid)!.data);
      deletions = lineCount(store.getObject(repo, be!.oid)!.data);
    }
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  out.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
  return out;
}

function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1;
  return n;
}

function mergePull(repo: Repo, pull: import('./store.ts').Pull): RestResponse {
  const baseRef = `refs/heads/${pull.base.ref}`;
  const curBaseTip = repo.refs.get(baseRef);
  if (!curBaseTip) return { status: 404, headers: {}, body: { message: 'Not Found' } };
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  if (!headTip) return { status: 404, headers: {}, body: { message: 'Not Found' } };
  const mergeBase = findMergeBase(repo, headTip, curBaseTip);
  if (!mergeBase) return { status: 405, headers: {}, body: { message: 'Cannot merge: no merge base' } };
  const baseTree = parseCommit(store.getObject(repo, mergeBase)!.data).tree;
  const headTree = parseCommit(store.getObject(repo, headTip)!.data).tree;
  const targetTree = parseCommit(store.getObject(repo, curBaseTip)!.data).tree;
  // conflict detection
  const headChanges = changedPathsBetween(repo, baseTree, headTree);
  const targetChanges = changedPathsBetween(repo, baseTree, targetTree);
  for (const p of headChanges) {
    if (!targetChanges.has(p)) continue;
    const hb = blobAtPath(repo, headTree, p);
    const tb = blobAtPath(repo, targetTree, p);
    if ((hb === null) !== (tb === null) || (hb !== null && tb !== null && !hb.equals(tb))) {
      return { status: 405, headers: {}, body: { message: 'Merge conflict' } };
    }
  }
  const finalTree = applyChangesToTree(repo, targetTree, baseTree, headTree);
  const newCommit = store.makeCommit(repo, finalTree, [curBaseTip], `Merge pull request #${pull.number} from ${pull.head.ref}`);
  repo.refs.set(baseRef, newCommit);
  repo.updatedAt = Date.now();
  const mergedAt = new Date().toISOString();
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = mergedAt;
  pull.merge_commit_sha = newCommit;
  pull.updated_at = mergedAt;
  return { status: 200, headers: {}, body: { merged: true, sha: newCommit, message: `Merge pull request #${pull.number} from ${pull.head.ref}` } };
}

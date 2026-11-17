// Minimal GraphQL v4 server: a small parser + executor matching the gh/github-mcp-server documents.

import { Repo, Store, store, USER_LOGIN } from './store.ts';
import { parseCommit, parseTree } from './gitobj.ts';

export interface GqlRequest {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
  login: string;
}

// ---------------------------------------------------------------- tokenizer/parser

type Token =
  | { t: 'ident'; v: string }
  | { t: 'number'; v: number }
  | { t: 'string'; v: string }
  | { t: 'punct'; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      tokens.push({ t: 'number', v: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; }
        else { s += src[j]; j += 1; }
      }
      tokens.push({ t: 'string', v: s });
      i = j + 1;
      continue;
    }
    if (c === '.') {
      let j = i;
      while (j < src.length && src[j] === '.') j += 1;
      tokens.push({ t: 'punct', v: '...' });
      i = j;
      continue;
    }
    if ('{}():,!$@[]'.includes(c)) {
      tokens.push({ t: 'punct', v: c });
      i += 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

interface FieldNode {
  name: string;
  alias?: string;
  args: Array<{ key: string; value: ArgValue }>;
  selectionSet?: FieldNode[];
}
type ArgValue = { kind: 'var'; name: string } | { kind: 'enum'; value: string } | { kind: 'int'; value: number } | { kind: 'string'; value: string } | { kind: 'bool'; value: boolean } | { kind: 'list'; items: ArgValue[] } | { kind: 'obj'; fields: Array<{ key: string; value: ArgValue }> };

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  peek(): Token | undefined { return this.tokens[this.pos]; }
  next(): Token { return this.tokens[this.pos++]!; }
  expectPunct(v: string): void {
    const t = this.peek();
    if (!t || t.t !== 'punct' || t.v !== v) throw new Error(`expected ${v}`);
    this.pos += 1;
  }
  parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.t === 'punct' && t.v === '}') { this.pos += 1; break; }
      if (t.t === 'punct' && t.v === '...') {
        // fragment spread: ... on Type { ... } -> merge inner fields
        this.pos += 1;
        while (this.peek() && this.peek()!.t === 'ident') this.pos += 1;
        if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === '{') {
          const inner = this.parseSelectionSet();
          for (const f of inner) fields.push(f);
        }
        continue;
      }
      fields.push(this.parseField());
    }
    return fields;
  }
  skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.t === 'punct') {
        if (t.v === open) depth += 1;
        else if (t.v === close) { depth -= 1; this.pos += 1; if (depth === 0) break; continue; }
      }
      this.pos += 1;
    }
  }
  parseField(): FieldNode {
    let name = this.next().v;
    let alias: string | undefined;
    if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === ':') {
      this.pos += 1;
      alias = name;
      name = this.next().v;
    }
    const args: Array<{ key: string; value: ArgValue }> = [];
    if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === '(') {
      this.pos += 1;
      for (;;) {
        const t = this.peek();
        if (!t) break;
        if (t.t === 'punct' && t.v === ')') { this.pos += 1; break; }
        const key = this.next().v;
        this.expectPunct(':');
        const value = this.parseValue();
        args.push({ key, value });
        if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === ',') this.pos += 1;
      }
    }
    let selectionSet: FieldNode[] | undefined;
    if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { name, alias, args, selectionSet };
  }
  parseValue(): ArgValue {
    const t = this.next();
    if (t.t === 'punct') {
      if (t.v === '$') {
        const n = this.next();
        return { kind: 'var', name: n.v };
      }
      if (t.v === '[') {
        const items: ArgValue[] = [];
        for (;;) {
          const p = this.peek();
          if (!p) break;
          if (p.t === 'punct' && p.v === ']') { this.pos += 1; break; }
          items.push(this.parseValue());
          if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === ',') this.pos += 1;
        }
        return { kind: 'list', items };
      }
      if (t.v === '{') {
        const fields: Array<{ key: string; value: ArgValue }> = [];
        for (;;) {
          const p = this.peek();
          if (!p) break;
          if (p.t === 'punct' && p.v === '}') { this.pos += 1; break; }
          const key = this.next().v;
          this.expectPunct(':');
          fields.push({ key, value: this.parseValue() });
          if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === ',') this.pos += 1;
        }
        return { kind: 'obj', fields };
      }
      throw new Error('bad value');
    }
    if (t.t === 'number') return { kind: 'int', value: t.v };
    if (t.t === 'string') return { kind: 'string', value: t.v };
    if (t.v === 'true') return { kind: 'bool', value: true };
    if (t.v === 'false') return { kind: 'bool', value: false };
    return { kind: 'enum', value: t.v };
  }
}

interface Operation {
  op: 'query' | 'mutation';
  name: string;
  selectionSet: FieldNode[];
}

function parseOperation(src: string): Operation {
  const tokens = tokenize(src);
  const p = new Parser(tokens);
  let op: 'query' | 'mutation' = 'query';
  const first = p.peek();
  if (first && first.t === 'ident' && (first.v === 'query' || first.v === 'mutation')) {
    op = p.next().v as 'query' | 'mutation';
  }
  let name = '';
  if (p.peek() && p.peek()!.t === 'ident' && !(p.peek()!.v === 'query' || p.peek()!.v === 'mutation' || p.peek()!.v === 'mutation')) {
    name = p.next().v;
  }
  // skip variable definitions
  if (p.peek() && p.peek()!.t === 'punct' && p.peek()!.v === '(') p.skipBalanced('(', ')');
  const selectionSet = p.parseSelectionSet();
  return { op, name, selectionSet };
}

// ---------------------------------------------------------------- argument evaluation

function evalArg(arg: ArgValue, variables: Record<string, unknown>): unknown {
  switch (arg.kind) {
    case 'var': return variables[arg.name];
    case 'enum': return arg.value;
    case 'int': return arg.value;
    case 'string': return arg.value;
    case 'bool': return arg.value;
    case 'list': return arg.items.map((i) => evalArg(i, variables));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const f of arg.fields) out[f.key] = evalArg(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.key] = evalArg(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- store helpers

function findIssueById(id: number): { repo: Repo; issue: import('./store.ts').Issue } | null {
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((i) => i.id === id);
    if (issue) return { repo, issue };
  }
  return null;
}
function findPullById(id: number): { repo: Repo; pull: import('./store.ts').Pull } | null {
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((p) => p.id === id);
    if (pull) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------- executor

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'createdAt', 'mergedAt', 'files', 'url'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'description', 'url'];
const SEARCH_TYPE_ENUMS = ['ISSUE', 'REPOSITORY', 'USER'];

interface ExecCtx {
  variables: Record<string, unknown>;
  errors: string[];
}

type Resolver = (field: FieldNode, parent: unknown, ctx: ExecCtx) => unknown;

function resolveSelection(selectionSet: FieldNode[], value: unknown, resolver: Resolver, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selectionSet) {
    const key = field.alias ?? field.name;
    try {
      out[key] = resolver(field, value, ctx);
    } catch (e) {
      ctx.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

class Executor {
  private login: string;
  constructor(login: string) { this.login = login; }

  execute(op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: string[] } {
    const ctx: ExecCtx = { variables, errors: [] };
    const data: Record<string, unknown> = {};
    for (const field of op.selectionSet) {
      const key = field.alias ?? field.name;
      try {
        data[key] = this.rootField(field, ctx);
      } catch (e) {
        ctx.errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { data, errors: ctx.errors };
  }

  private rootField(field: FieldNode, ctx: ExecCtx): unknown {
    const name = field.name;
    if (name === '__type') return this.introspectType(field, ctx);
    if (name === '__schema') return undefined;
    if (name === 'viewer') {
      const user = { login: this.login };
      return this.resolveObject(field, user, USER_RESOLVER, ctx);
    }
    if (name === 'repository') {
      const args = argsOf(field, ctx.variables);
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return null;
      return this.resolveObject(field, repo, REPO_RESOLVER, ctx);
    }
    if (name === 'node') {
      const args = argsOf(field, ctx.variables);
      const id = String(args.id ?? '');
      const parsed = parseGlobalId(id);
      if (parsed && parsed.type === 'repo') {
        const repo = store.repoById.get(parsed.id);
        if (!repo) return null;
        return this.resolveObject(field, repo, REPO_RESOLVER, ctx);
      }
      if (parsed && parsed.type === 'issue') {
        const found = findIssueById(parsed.id);
        if (!found) return null;
        return this.resolveObject(field, found.issue, ISSUE_RESOLVER, ctx);
      }
      if (parsed && parsed.type === 'pull') {
        const found = findPullById(parsed.id);
        if (!found) return null;
        return this.resolveObject(field, found.pull, PULL_RESOLVER, ctx);
      }
      return null;
    }
    if (name === 'search') {
      return null;
    }
    throw new Error(`unknown root field ${name}`);
  }

  private resolveObject(field: FieldNode, value: unknown, resolver: Resolver, ctx: ExecCtx): Record<string, unknown> {
    if (!field.selectionSet) throw new Error('no selection');
    return resolveSelection(field.selectionSet, value, resolver, ctx);
  }

  private introspectType(field: FieldNode, ctx: ExecCtx): unknown {
    const args = argsOf(field, ctx.variables);
    const name = String(args.name ?? '');
    const kind = name === 'SearchType' ? 'enum' : 'object';
    const fields = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PULL_FIELDS : name === 'Repository' ? REPO_FIELDS : [];
    if (!field.selectionSet) return undefined;
    const out: Record<string, unknown> = {};
    for (const sub of field.selectionSet) {
      if (sub.name === 'name') out.name = name;
      else if (sub.name === 'kind') out.kind = kind === 'enum' ? 'ENUM' : 'OBJECT';
      else if (sub.name === 'fields') {
        const includeDeprecated = argsOf(sub, ctx.variables).includeDeprecated === true;
        out.fields = fields.map((f) => ({ name: f }));
      } else if (sub.name === 'enumValues') {
        const vals = kind === 'enum' ? SEARCH_TYPE_ENUMS : [];
        out.enumValues = vals.map((v) => ({ name: v }));
      } else if (sub.name === 'description') {
        out.description = null;
      }
    }
    return out;
  }
}

function parseGlobalId(id: string): { type: 'repo' | 'issue' | 'pull'; id: number } | null {
  const m = /^(repo|issue|pull)_(\d+)$/.exec(id);
  if (!m) return null;
  return { type: m[1] as 'repo' | 'issue' | 'pull', id: parseInt(m[2]!, 10) };
}

const USER_RESOLVER: Resolver = (field, user, ctx) => {
  switch (field.name) {
    case 'login': return (user as { login: string }).login;
    case 'name': return USER_LOGIN;
    case 'id': return `user_1`;
    case 'databaseId': return 1;
    default: throw new Error(`unknown field on viewer: ${field.name}`);
  }
};

const REPO_RESOLVER: Resolver = (field, parent, ctx) => {
  const repo = parent as Repo;
  switch (field.name) {
    case 'id': return `repo_${repo.id}`;
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return repo.fullName();
    case 'description': return repo.description;
    case 'createdAt': return new Date(repo.createdAt).toISOString();
    case 'updatedAt': return new Date(repo.updatedAt).toISOString();
    case 'url': return `https://example.com/${repo.fullName()}`;
    case 'owner': return { login: repo.owner, id: repo.id };
    case 'defaultBranchRef': {
      const oid = store.defaultTip(repo);
      return { name: repo.defaultBranch, target: oid ? { oid } : null };
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'issue': {
      const args = argsOf(field, ctx.variables);
      const number = typeof args.number === 'number' ? args.number : parseInt(String(args.number ?? ''), 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return null;
      return resolveSelection(field.selectionSet!, issue, ISSUE_RESOLVER, ctx);
    }
    case 'issues': {
      const args = argsOf(field, ctx.variables);
      return connectionIssues(repo, args, field, ctx);
    }
    case 'pullRequest': {
      const args = argsOf(field, ctx.variables);
      const number = typeof args.number === 'number' ? args.number : parseInt(String(args.number ?? ''), 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return null;
      return resolveSelection(field.selectionSet!, pull, PULL_RESOLVER, ctx);
    }
    case 'pullRequests': {
      const args = argsOf(field, ctx.variables);
      return connectionPulls(repo, args, field, ctx);
    }
    default: throw new Error(`unknown field on Repository: ${field.name}`);
  }
};

function connectionIssues(repo: Repo, args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 100;
  const states = Array.isArray(args.states) ? (args.states as unknown[]) : [];
  const after = typeof args.after === 'string' ? args.after : undefined;
  let list = repo.issues.slice();
  if (states.includes('OPEN')) list = list.filter((i) => i.state === 'open');
  else if (states.includes('CLOSED')) list = list.filter((i) => i.state === 'closed');
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && orderBy.direction === 'DESC') list = list.slice().sort((a, b) => b.number - a.number);
  else list = list.slice().sort((a, b) => a.number - b.number);
  let start = 0;
  if (after !== undefined) {
    const idx = list.findIndex((i) => cursorForIssue(i) === after);
    if (idx >= 0) start = idx + 1;
  }
  const slice = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  const nodes = slice.map((i) => resolveSelection(field.selectionSet!.find((f) => f.name === 'nodes')!.selectionSet!, i, ISSUE_RESOLVER, ctx));
  const endCursor = slice.length ? cursorForIssue(slice[slice.length - 1]!) : null;
  const out: Record<string, unknown> = {};
  for (const sub of field.selectionSet!) {
    if (sub.name === 'nodes') out.nodes = nodes;
    else if (sub.name === 'pageInfo') out.pageInfo = { hasNextPage, endCursor, startCursor: slice.length ? cursorForIssue(slice[0]!) : null };
    else if (sub.name === 'totalCount') out.totalCount = list.length;
  }
  return out;
}

function cursorForIssue(issue: import('./store.ts').Issue): string {
  return `issue:${issue.number}`;
}

function connectionPulls(repo: Repo, args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 100;
  const states = Array.isArray(args.states) ? (args.states as unknown[]) : [];
  let list = repo.pulls.slice().sort((a, b) => b.number - a.number);
  if (states.includes('OPEN')) list = list.filter((p) => p.state === 'open');
  else if (states.includes('MERGED')) list = list.filter((p) => p.merged);
  else if (states.includes('CLOSED')) list = list.filter((p) => p.state === 'closed');
  const slice = list.slice(0, first);
  const nodes = slice.map((p) => resolveSelection(field.selectionSet!.find((f) => f.name === 'nodes')!.selectionSet!, p, PULL_RESOLVER, ctx));
  const out: Record<string, unknown> = {};
  for (const sub of field.selectionSet!) {
    if (sub.name === 'nodes') out.nodes = nodes;
    else if (sub.name === 'pageInfo') out.pageInfo = { hasNextPage: slice.length < list.length, endCursor: null };
  }
  return out;
}

const ISSUE_RESOLVER: Resolver = (field, parent, ctx) => {
  const issue = parent as import('./store.ts').Issue;
  switch (field.name) {
    case 'id': return `issue_${issue.id}`;
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': return issue.body;
    case 'state': return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
    case 'createdAt': return issue.created_at;
    case 'updatedAt': return issue.updated_at;
    case 'author': return { login: USER_LOGIN };
    case 'labels': return { nodes: issue.labels.map((name) => ({ name })) };
    case 'comments': return { nodes: issue.comments.map((c) => ({ id: `comment_${c.id}`, body: c.body })) };
    case 'url': return `https://example.com/issues/${issue.number}`;
    default: throw new Error(`unknown field on Issue: ${field.name}`);
  }
};

const PULL_RESOLVER: Resolver = (field, parent, ctx) => {
  const pull = parent as import('./store.ts').Pull;
  switch (field.name) {
    case 'id': return `pull_${pull.id}`;
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'state': return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
    case 'merged': return pull.merged;
    case 'mergeable': return 'MERGEABLE';
    case 'headRefName': return pull.head.ref;
    case 'baseRefName': return pull.base.ref;
    case 'headRefOid': return pull.head.sha;
    case 'baseRefOid': return pull.base.sha;
    case 'createdAt': return pull.created_at;
    case 'mergedAt': return pull.merged_at;
    case 'url': return `https://example.com/pulls/${pull.number}`;
    case 'files': {
      const sub = field.selectionSet!.find((f) => f.name === 'nodes');
      const repo = store.getRepo(USER_LOGIN, '') ?? findRepoForPull(pull.id);
      const files = pullFilesForPull(pull);
      const nodes = files.map((f) => {
        if (sub) return { path: f.path };
        return { path: f.path };
      });
      const out: Record<string, unknown> = {};
      for (const s of field.selectionSet!) if (s.name === 'nodes') out.nodes = nodes;
      return out;
    }
    default: throw new Error(`unknown field on PullRequest: ${field.name}`);
  }
};

function findRepoForPull(pullId: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.pulls.some((p) => p.id === pullId)) return repo;
  return null;
}

function pullFilesForPull(pull: import('./store.ts').Pull): Array<{ path: string }> {
  const repo = findRepoForPull(pull.id);
  if (!repo) return [];
  const baseCommit = store.getObject(repo, pull.base.sha);
  const headCommit = store.getObject(repo, pull.head.sha);
  if (!baseCommit || !headCommit) return [];
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const a = walkMap(repo, baseTree);
  const b = walkMap(repo, headTree);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out: Array<{ path: string }> = [];
  for (const k of keys) {
    const ea = a.get(k);
    const eb = b.get(k);
    if ((!ea && eb) || (ea && !eb) || (ea && eb && ea !== eb)) out.push({ path: k });
  }
  return out;
}

function walkMap(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.getObject(repo, oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

// ---------------------------------------------------------------- mutations

function executeMutation(executor: Executor, op: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: string[] } {
  const ctx: ExecCtx = { variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const field of op.selectionSet) {
    const key = field.alias ?? field.name;
    try {
      data[key] = mutationField(executor, field, ctx);
    } catch (e) {
      ctx.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { data, errors: ctx.errors };
}

function mutationField(executor: Executor, field: FieldNode, ctx: ExecCtx): unknown {
  const name = field.name;
  const args = argsOf(field, ctx.variables);
  if (name === 'createIssue') return createIssueMutation(args, field, ctx);
  if (name === 'closeIssue') return closeIssueMutation(args, field, ctx);
  if (name === 'createPullRequest') return createPullRequestMutation(args, field, ctx);
  if (name === 'mergePullRequest') return mergePullRequestMutation(args, field, ctx);
  if (name === 'addComment') return addCommentMutation(args, field, ctx);
  throw new Error(`unknown mutation ${name}`);
}

function repoByGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'repo') return null;
  return store.repoById.get(parsed.id) ?? null;
}

function createIssueMutation(args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): unknown {
  const input = args.input as Record<string, unknown> | undefined;
  if (!input) throw new Error('input required');
  const repositoryId = String(input.repositoryId ?? '');
  const repo = repoByGlobalId(repositoryId);
  if (!repo) throw new Error('repository not found');
  const title = String(input.title ?? '');
  const body = typeof input.body === 'string' ? input.body : '';
  const now = new Date().toISOString();
  const issue = { id: nowHash(repo, repo.nextIssue), number: repo.nextIssue++, title, body, state: 'open' as const, labels: [] as string[], created_at: now, updated_at: now, comments: [], user: { login: repo.owner } };
  repo.issues.push(issue);
  const issueObj = resolveSelection(field.selectionSet!.find((f) => f.name === 'issue')!.selectionSet!, issue, ISSUE_RESOLVER, ctx);
  return { issue: issueObj };
}

function nowHash(repo: Repo, n: number): number {
  let h = 0;
  const s = `${repo.id}-iss-${n}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function closeIssueMutation(args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): unknown {
  const input = args.input as Record<string, unknown> | undefined;
  const issueId = String(input?.issueId ?? '');
  const parsed = parseGlobalId(issueId);
  const found = parsed ? findIssueById(parsed.id) : null;
  if (!found) throw new Error('issue not found');
  found.issue.state = 'closed';
  found.issue.updated_at = new Date().toISOString();
  const issueObj = resolveSelection(field.selectionSet!.find((f) => f.name === 'issue')!.selectionSet!, found.issue, ISSUE_RESOLVER, ctx);
  return { issue: issueObj };
}

function createPullRequestMutation(args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): unknown {
  const input = args.input as Record<string, unknown> | undefined;
  if (!input) throw new Error('input required');
  const repo = repoByGlobalId(String(input.repositoryId ?? ''));
  if (!repo) throw new Error('repository not found');
  const baseRefName = String(input.baseRefName ?? '');
  const headRefName = String(input.headRefName ?? '');
  const title = String(input.title ?? '');
  const headSha = repo.refs.get(`refs/heads/${headRefName}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
  if (!headSha || !baseSha) throw new Error('branch not found');
  const now = new Date().toISOString();
  const pull = { id: nowHash(repo, repo.nextPull), number: repo.nextPull++, title, body: typeof input.body === 'string' ? input.body : '', state: 'open' as const, merged: false, merged_at: null as string | null, merge_commit_sha: null as string | null, head: { ref: headRefName, sha: headSha }, base: { ref: baseRefName, sha: baseSha }, created_at: now, updated_at: now, user: { login: repo.owner } };
  repo.pulls.push(pull);
  const prObj = resolveSelection(field.selectionSet!.find((f) => f.name === 'pullRequest')!.selectionSet!, pull, PULL_RESOLVER, ctx);
  return { pullRequest: prObj };
}

function mergePullRequestMutation(args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): unknown {
  const input = args.input as Record<string, unknown> | undefined;
  const pullId = String(input?.pullRequestId ?? '');
  const parsed = parseGlobalId(pullId);
  const found = parsed ? findPullById(parsed.id) : null;
  if (!found) throw new Error('pull request not found');
  const repo = found.repo;
  const pull = found.pull;
  const baseRef = `refs/heads/${pull.base.ref}`;
  const curBaseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  if (!curBaseTip || !headTip) throw new Error('cannot merge');
  // simple squash: apply head tree onto base tree
  const baseCommit = store.getObject(repo, curBaseTip);
  const headCommit = store.getObject(repo, headTip);
  if (!baseCommit || !headCommit) throw new Error('cannot merge');
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const finalTree = applyHead(repo, baseTree, headTree);
  const newCommit = store.makeCommit(repo, finalTree, [curBaseTip], `Merge pull request #${pull.number} from ${pull.head.ref}`);
  repo.refs.set(baseRef, newCommit);
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = new Date().toISOString();
  pull.merge_commit_sha = newCommit;
  const prObj = resolveSelection(field.selectionSet!.find((f) => f.name === 'pullRequest')!.selectionSet!, pull, PULL_RESOLVER, ctx);
  return { pullRequest: prObj };
}

export function applyHead(repo: Repo, baseTree: string, headTree: string): string {
  const b = walkMap(repo, baseTree);
  const h = walkMap(repo, headTree);
  const keys = new Set([...b.keys(), ...h.keys()]);
  let tree = baseTree;
  for (const k of keys) {
    const eb = b.get(k);
    const eh = h.get(k);
    const segments = k.split('/').filter(Boolean);
    if (eh && (!eb || eb !== eh)) {
      tree = store.setTreePath(repo, tree, segments, '100644', eh);
    } else if (!eh && eb) {
      tree = store.setTreePath(repo, tree, segments, '100644', null);
    }
  }
  return tree;
}

function addCommentMutation(args: Record<string, unknown>, field: FieldNode, ctx: ExecCtx): unknown {
  const input = args.input as Record<string, unknown> | undefined;
  const subjectId = String(input?.subjectId ?? '');
  const body = typeof input?.body === 'string' ? input.body : '';
  const parsed = parseGlobalId(subjectId);
  const found = parsed ? findIssueById(parsed.id) : null;
  if (!found) throw new Error('subject not found');
  const comment = { id: found.repo.commentCounter++, body, created_at: new Date().toISOString() };
  found.issue.comments.push(comment);
  const node = { id: `comment_${comment.id}`, body };
  return { commentEdge: { node } };
}

// ---------------------------------------------------------------- public entry

export function handleGraphql(body: unknown, login: string): { status: number; json: unknown } {
  // body is either one operation object or an array of operations
  if (Array.isArray(body)) {
    const responses = body.map((entry) => runOne(entry as Record<string, unknown>, login));
    return { status: 200, json: responses };
  }
  const rec = body as Record<string, unknown> | null;
  if (!rec || typeof rec.query !== 'string') return { status: 400, json: { errors: [{ message: 'query required' }] } };
  return { status: 200, json: runOne(rec, login) };
}

function runOne(rec: Record<string, unknown>, login: string): unknown {
  const query = rec.query as string;
  const variables = (rec.variables as Record<string, unknown>) ?? {};
  const operationName = typeof rec.operationName === 'string' ? rec.operationName : undefined;
  const op = parseOperation(query);
  const executor = new Executor(login);
  let result: { data: Record<string, unknown>; errors: string[] };
  if (op.op === 'query') result = executor.execute(op, variables);
  else result = executeMutation(executor, op, variables);
  const json: Record<string, unknown> = {};
  if (result.data) json.data = result.data;
  if (result.errors.length) json.errors = result.errors.map((message) => ({ message }));
  return json;
}

// export helper used by MCP merge

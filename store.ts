// The forge's in-memory store: repositories (refs + loose objects) plus issues, pulls and labels.
// REST and git smart HTTP operate on the same object store so a push is visible to REST and vice versa.

import type { GitObject, GitObjectType, TreeEntry } from './gitobj.ts';
import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  parseTag,
  collectReachable,
  ZERO_OID,
} from './gitobj.ts';

export const USER_LOGIN = 'adaiversen';
export const USER_NAME = 'ada iversen';
export const USER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  created_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
  user: { login: string };
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
  user: { login: string };
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  description: string;
  private: boolean;
  defaultBranch: string = DEFAULT_BRANCH;
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  labels: Label[] = [];
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextIssue = 1;
  nextPull = 1;
  commentCounter = 1;

  constructor(owner: string, name: string, id: number, opts: { private?: boolean; description?: string } = {}) {
    this.owner = owner;
    this.name = name;
    this.id = id;
    const now = Date.now();
    this.createdAt = now;
    this.updatedAt = now;
    this.private = opts.private ?? false;
    this.description = opts.description ?? '';
  }

  fullName(): string {
    return `${this.owner}/${this.name}`;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  repoById = new Map<number, Repo>();
  private nextRepoId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string } = {}): Repo {
    const existing = this.repos.get(this.key(owner, name));
    if (existing) throw new RepoExistsError();
    const repo = new Repo(owner, name, this.nextRepoId++, opts);
    this.repos.set(this.key(owner, name), repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    this.repoById.delete(repo.id);
  }

  userRepos(login: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === login) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // ---- object store helpers
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Resolve a ref name or 'HEAD' to an oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD' || ref === '') return this.defaultTip(repo);
    return repo.refs.get(ref);
  }

  /** Peel a tag ref to the commit/tag object oid it points at. */
  peel(repo: Repo, oid: string): string {
    let current = oid;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      const obj = repo.objects.get(current);
      if (!obj) break;
      if (obj.type === 'tag') {
        seen.add(current);
        current = parseTag(obj.data).object;
      } else break;
    }
    return current;
  }

  /** All refs as [{ref, oid}] in stable order. */
  listRefs(repo: Repo): Array<{ ref: string; oid: string }> {
    const out: Array<{ ref: string; oid: string }> = [];
    for (const [ref, oid] of repo.refs) out.push({ ref, oid });
    out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return out;
  }

  // ---- tree helpers
  /** Get a tree entry (blob or subtree) by path from a given tree oid. */
  treeEntryByPath(repo: Repo, treeOid: string, path: string): { entry: TreeEntry; blob?: GitObject } | null {
    const segments = path.split('/').filter((s) => s.length > 0);
    let currentTree = treeOid;
    let treeObj = repo.objects.get(currentTree);
    if (!treeObj || treeObj.type !== 'tree') return null;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const entries = parseTree(treeObj.data);
      const entry = entries.find((e) => e.name === seg);
      if (!entry) return null;
      const last = i === segments.length - 1;
      if (last) {
        const blob = entry.mode === '100644' || entry.mode === '100755' ? repo.objects.get(entry.oid) : undefined;
        return { entry, blob };
      }
      const child = repo.objects.get(entry.oid);
      if (!child || child.type !== 'tree') return null;
      currentTree = entry.oid;
      treeObj = child;
    }
    return null;
  }

  /** Read a file blob at a given commit oid + slash path. */
  readFileAtCommit(repo: Repo, commitOid: string, path: string): { blobOid: string; content: Buffer; size: number } | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const view = parseCommit(commit.data);
    const found = this.treeEntryByPath(repo, view.tree, path);
    if (!found || !found.blob) return null;
    return { blobOid: found.entry.oid, content: found.blob.data, size: found.blob.data.length };
  }

  /** List a directory's entries at a commit oid. */
  listDirAtCommit(repo: Repo, commitOid: string, path: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const view = parseCommit(commit.data);
    let treeOid = view.tree;
    if (path) {
      const found = this.treeEntryByPath(repo, view.tree, path);
      if (!found) return null;
      const child = repo.objects.get(found.entry.oid);
      if (!child || child.type !== 'tree') return null;
      treeOid = found.entry.oid;
    }
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj) return null;
    const entries = parseTree(treeObj.data);
    return entries.map((e) => ({
      name: e.name,
      path: path ? `${path}/${e.name}` : e.name,
      sha: e.oid,
      type: e.mode === '40000' ? 'dir' as const : 'file' as const,
    }));
  }

  private putTreeFromEntries(repo: Repo, entries: TreeEntry[]): string {
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  /** Set or remove a file path within a tree oid, returning the new tree oid. */
  setTreePath(repo: Repo, treeOid: string | undefined, segments: string[], mode: string, oid: string | null): string {
    if (segments.length === 0) throw new Error('empty path');
    const [head, ...rest] = segments;
    if (rest.length === 0) {
      const entries = treeOid ? parseTree(repo.objects.get(treeOid)!.data) : [];
      const filtered = entries.filter((e) => e.name !== head);
      if (oid !== null) filtered.push({ mode, name: head, oid });
      return this.putTreeFromEntries(repo, filtered);
    }
    const entries = treeOid ? parseTree(repo.objects.get(treeOid)!.data) : [];
    const existing = entries.find((e) => e.name === head);
    let childTreeOid: string | undefined;
    if (existing && existing.mode === '40000') {
      childTreeOid = existing.oid;
    } else if (existing) {
      // replace file with dir
    }
    const newChild = this.setTreePath(repo, childTreeOid, rest, mode, oid);
    const newEntries = entries.filter((e) => e.name !== head);
    newEntries.push({ mode: '40000', name: head, oid: newChild });
    return this.putTreeFromEntries(repo, newEntries);
  }

  // ---- commit creation
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const author = `${USER_NAME} <${USER_EMAIL}>`;
    const data = buildCommit({ tree, parents, message, author, timestamp });
    return this.putObject(repo, 'commit', data);
  }
}

export class RepoExistsError extends Error {
  constructor() {
    super('Repository creation failed.');
    this.name = 'RepoExistsError';
  }
}

export const store = new Store();

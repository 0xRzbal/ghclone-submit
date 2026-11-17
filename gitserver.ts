// git smart-HTTP server: protocol v2 upload-pack and v0 receive-pack over the shared store.

import type { GitObject } from './gitobj.ts';
import {
  PktLineDecoder,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
} from './gitobj.ts';
import { Repo, Store, store } from './store.ts';

const AGENT = 'inception-forge/1.0';
const ADV_UPLOAD = 'application/x-git-upload-pack-advertisement';
const ADV_RECEIVE = 'application/x-git-receive-pack-advertisement';
const RESULT_UPLOAD = 'application/x-git-upload-pack-result';
const RESULT_RECEIVE = 'application/x-git-receive-pack-result';

export class NotFound extends Error {
  constructor() {
    super('Not Found');
    this.name = 'NotFound';
  }
}

function isV2(req: { headers: Record<string, string | undefined> }): boolean {
  const gp = req.headers['git-protocol'];
  return typeof gp === 'string' && gp.includes('version=2');
}

function parseRepoPath(path: string): { owner: string; repo: string; suffix: string } | null {
  // /{owner}/{repo}.git/{suffix}
  const m = /^\/([^/]+)\/([^/]+?)\.git(?:\/(.*))?$/.exec(path);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, suffix: m[3] ?? '' };
}

// ---------------------------------------------------------------- v0 advertisement

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`]
      : ['multi_ack_detailed', 'side-band-64k', 'ofs-delta', `agent=${AGENT}`, 'shallow'];
  const refs = store.listRefs(repo);
  const headTip = store.defaultTip(repo);
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  const firstRef = {
    oid: headTip ?? ZERO_OID,
    name: 'HEAD',
    caps,
    symref: `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  };
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
    return Buffer.concat(parts);
  }
  // HEAD line first
  parts.push(encodePktLine(`${firstRef.oid} HEAD\0${caps.join(' ')} ${firstRef.symref}\n`));
  for (const { ref, oid } of refs) {
    parts.push(encodePktLine(`${oid} ${ref}\n`));
    const obj = store.getObject(repo, oid);
    if (obj && obj.type === 'tag') {
      const peeled = store.peel(repo, oid);
      if (peeled !== oid) parts.push(encodePktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repo): Buffer {
  const capLines = [
    `version 2\n`,
    `agent=${AGENT}\n`,
    `ls-refs\n`,
    `fetch=shallow wait-for-done filter\n`,
    `server-option\n`,
    `object-format=sha1\n`,
    `session-id=${repo.fullName()}@${Date.now()}\n`,
  ];
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n')];
  for (const line of capLines) parts.push(encodePktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs

function lsRefsResponse(repo: Repo, reqLines: string[]): Buffer {
  const prefixes: string[] = [];
  for (const line of reqLines) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headTip = store.defaultTip(repo);
  if (headTip) {
    if (keep('HEAD')) parts.push(encodePktLine(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  } else {
    if (keep('HEAD')) parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const { ref, oid } of store.listRefs(repo)) {
    if (!keep(ref)) continue;
    const obj = store.getObject(repo, oid);
    let line = `${oid} ${ref}`;
    if (obj && obj.type === 'tag') {
      const peeled = store.peel(repo, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  filter?: string;
  done: boolean;
}

function parseFetchRequest(decoded: Buffer[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepenNot: [], done: false };
  for (const raw of decoded) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (!line) continue;
    if (line.startsWith('want ')) req.wants.push(line.slice(5));
    else if (line.startsWith('have ')) req.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) req.deepenSince = parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) req.deepenNot.push(line.slice(11));
    else if (line.startsWith('filter ')) req.filter = line.slice(7);
    else if (line === 'done') req.done = true;
  }
  return req;
}

function computeFetch(repo: Repo, req: FetchRequest): { send: GitObject[]; shallow: string[] } {
  const wantOids = req.wants.filter(isObjectId);
  const depth = req.depth;
  // object commits (and their depth distance) from wants
  const includedCommits = new Set<string>();
  const boundaryCommits = new Set<string>();
  const tagRoots: string[] = [];

  const walk = (oid: string, d: number): void => {
    const obj = store.getObject(repo, oid);
    if (!obj) return;
    if (obj.type === 'tag') {
      tagRoots.push(oid);
      const peeled = store.peel(repo, oid);
      if (peeled === oid) return;
      walk(peeled, d);
      return;
    }
    if (obj.type !== 'commit') return;
    if (includedCommits.has(oid)) return;
    includedCommits.add(oid);
    if (depth !== undefined && d >= depth - 1) {
      boundaryCommits.add(oid);
      return;
    }
    const view = parseCommit(obj.data);
    for (const p of view.parents) walk(p, d + 1);
  };

  for (const want of wantOids) walk(want, 0);

  // Build desired object set
  const desired = new Set<string>();
  const add = (oid: string): void => {
    if (desired.has(oid)) return;
    const obj = store.getObject(repo, oid);
    if (!obj) return;
    desired.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      add(view.tree);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        add(entry.oid);
      }
    } else if (obj.type === 'tag') {
      add(parseTag(obj.data).object);
    }
  };

  for (const cid of includedCommits) add(cid);
  for (const tag of tagRoots) desired.add(tag);

  // subtract objects the client already holds, honoring shallow boundaries: the client holds
  // each have and everything reachable from it, except it does NOT hold ancestors beyond any
  // shallow boundary it declares.
  const held = new Set<string>();
  const markedShallow = new Set<string>(req.shallow);
  const addTree = (treeOid: string): void => {
    if (held.has(treeOid)) return;
    const treeObj = store.getObject(repo, treeOid);
    if (!treeObj) return;
    held.add(treeOid);
    if (treeObj.type === 'tree') {
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '160000') continue;
        addTree(entry.oid);
      }
    }
  };
  const visit = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = store.getObject(repo, oid);
    if (!obj) return;
    held.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      addTree(view.tree);
      if (!markedShallow.has(oid)) {
        for (const p of view.parents) visit(p);
      }
    }
  };
  for (const have of req.haves) visit(have);
  for (const s of req.shallow) held.add(s);
  const toSendOids: string[] = [];
  for (const oid of desired) if (!held.has(oid)) toSendOids.push(oid);

  const send: GitObject[] = [];
  for (const oid of toSendOids) {
    const obj = store.getObject(repo, oid);
    if (obj) send.push(obj);
  }
  const shallowBoundary = [...boundaryCommits];
  return { send, shallow: shallowBoundary };
}

function sideband1(payload: Buffer): Buffer {
  return encodePktLine(Buffer.concat([Buffer.from([1]), payload]));
}

// ---------------------------------------------------------------- shared request body reader

function readBodyChunks(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks);
}

export class GitHttpHandler {
  private readonly st: Store;
  constructor(st: Store = store) { this.st = st; }

  private getRepo(owner: string, repo: string): Repo {
    const r = this.st.getRepo(owner, repo);
    if (!r) throw new NotFound();
    return r;
  }

  /** info/refs GET */
  handleInfoRefs(owner: string, repo: string, service: string, req: { headers: Record<string, string | undefined> }): { status: number; contentType: string; body: Buffer } {
    const r = this.getRepo(owner, repo);
    if (service === 'git-upload-pack') {
      if (isV2(req)) {
        return { status: 200, contentType: ADV_UPLOAD, body: v2Advertisement(r) };
      }
      return { status: 200, contentType: ADV_UPLOAD, body: v0Advertisement(r, 'git-upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: ADV_RECEIVE, body: v0Advertisement(r, 'git-receive-pack') };
    }
    return { status: 404, contentType: 'text/plain', body: Buffer.from('service not found') };
  }

  /** POST git-upload-pack */
  handleUploadPack(owner: string, repo: string, body: Buffer, req: { headers: Record<string, string | undefined> }): { status: number; contentType: string; body: Buffer } {
    const r = this.getRepo(owner, repo);
    const packetDecoded: Buffer[] = [];
    let sawDelim = false;
    const decoder = new PktLineDecoder();
    decoder.push(body);
    decoder.finish();
    for (;;) {
      const pkt = decoder.next();
      if (pkt === null) break;
      if (pkt.kind === 'data') {
        if (sawDelim) packetDecoded.push(pkt.payload!);
        else {
          const line = pkt.payload!.toString('utf8');
          if (line.startsWith('command=')) {
            // skip command/agent/object-format lines
          }
        }
      } else if (pkt.kind === 'delim') {
        sawDelim = true;
      } else if (pkt.kind === 'flush') {
        break;
      }
    }

    // Determine the command
    const isV2Req = isV2(req);
    // Find command from raw body
    const rawText = body.toString('utf8');
    let command = '';
    if (rawText.includes('command=ls-refs')) command = 'ls-refs';
    else if (rawText.includes('command=fetch')) command = 'fetch';

    if (command === 'ls-refs') {
      return { status: 200, contentType: RESULT_UPLOAD, body: lsRefsResponse(r, packetDecoded.map((b) => b.toString('utf8'))) };
    }
    if (command === 'fetch') {
      const fetchReq = parseFetchRequest(packetDecoded);
      const { send, shallow } = computeFetch(r, fetchReq);
      const parts: Buffer[] = [];
      // acknowledgments
      parts.push(encodePktLine('acknowledgments\n'));
      parts.push(encodePktLine('NAK\n'));
      parts.push(PKT_FLUSH);
      if (shallow.length > 0) {
        parts.push(encodePktLine('shallow-info\n'));
        for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
        parts.push(PKT_FLUSH);
      }
      if (send.length > 0) {
        const pack = writePack(send);
        parts.push(encodePktLine('packfile\n'));
        // split pack into sideband chunks
        const CHUNK = 8192;
        for (let i = 0; i < pack.length; i += CHUNK) {
          parts.push(sideband1(pack.subarray(i, Math.min(i + CHUNK, pack.length))));
        }
        parts.push(PKT_FLUSH);
      } else {
        // no objects: still send packfile section? send empty - client handles null pack
        parts.push(encodePktLine('packfile\n'));
        parts.push(PKT_FLUSH);
      }
      return { status: 200, contentType: RESULT_UPLOAD, body: Buffer.concat(parts) };
    }
    if (!isV2Req) {
      // v0 fetch fallback: minimal support
      return this.handleUploadPackV0(r, body);
    }
    return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command') };
  }

  private handleUploadPackV0(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
    // Parse want/have/done/... pkt-lines then pack
    const packets = decodePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    for (const pkt of packets) {
      if (pkt.kind !== 'data') continue;
      const line = pkt.payload!.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5));
      else if (line.startsWith('have ')) haves.push(line.slice(5));
    }
    const req: FetchRequest = { wants, haves, shallow: [], deepenNot: [], done: true };
    const { send } = computeFetch(repo, req);
    const parts: Buffer[] = [];
    const pack = send.length ? writePack(send) : Buffer.alloc(0);
    // v0 response: NAK then sideband pack
    parts.push(encodePktLine('NAK\n'));
    if (pack.length) {
      const CHUNK = 8192;
      for (let i = 0; i < pack.length; i += CHUNK) {
        parts.push(sideband1(pack.subarray(i, Math.min(i + CHUNK, pack.length))));
      }
    }
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: RESULT_UPLOAD, body: Buffer.concat(parts) };
  }

  /** POST git-receive-pack */
  handleReceivePack(owner: string, repo: string, body: Buffer): { status: number; contentType: string; body: Buffer } {
    const r = this.getRepo(owner, repo);
    // parse command list
    const decoder = new PktLineDecoder();
    decoder.push(body);
    interface Command {
      oldOid: string;
      newOid: string;
      ref: string;
    }
    const commands: Command[] = [];
    const decoderBuf: Buffer[] = [];
    // We must read pkt-lines until flush, then rest is pack
    let stopAt = -1;
    let offset = 0;
    const packetBuf = body;
    let idx = 0;
    let sawFlush = false;
    let commandBytesEnd = 0;
    // manual pkt parse on the body to find where commands end (after first flush)
    while (idx + 4 <= body.length) {
      const header = body.subarray(idx, idx + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
      const length = parseInt(header, 16);
      if (length === 0) {
        sawFlush = true;
        commandBytesEnd = idx + 4;
        break;
      }
      if (length < 4 || idx + length > body.length) break;
      const payload = body.subarray(idx + 4, idx + length);
      const line = payload.toString('utf8').replace(/\n$/, '');
      if (line) {
        let cmdLine = line;
        // strip capabilities after NUL on first line
        const nul = cmdLine.indexOf('\u0000');
        if (nul >= 0) cmdLine = cmdLine.slice(0, nul);
        const partsA = cmdLine.split(' ');
        if (partsA.length >= 3 && isObjectId(partsA[0]) && isObjectId(partsA[1])) {
          commands.push({ oldOid: partsA[0], newOid: partsA[1], ref: partsA.slice(2).join(' ') });
        }
      }
      idx += length;
    }
    const packBytes = sawFlush ? body.subarray(commandBytesEnd) : Buffer.alloc(0);

    // read pack if present
    let unpackOk = true;
    let unpackDetail = 'ok';
    const newObjects = new Map<string, GitObject>();
    if (packBytes.length >= 12) {
      try {
        const read = readPack(packBytes);
        for (const [oid, obj] of read.objects) {
          newObjects.set(oid, obj);
          r.objects.set(oid, obj);
        }
        if (!read.checksumOk) {
          unpackOk = false;
          unpackDetail = 'pack checksum mismatch';
        }
      } catch {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      }
    }

    // Capability discovery: receive-pack caps (not used for semantics, but we parse)
    // Apply commands
    const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
    const applyOnly = new Set<number>();
    for (let i = 0; i < commands.length; i += 1) {
      const cmd = commands[i];
      const current = r.refs.get(cmd.ref);
      let ok = false;
      let reason = '';
      if (cmd.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) {
          reason = 'already exists';
        } else if (cmd.newOid !== ZERO_OID && !newObjects.has(cmd.newOid) && !store.getObject(r, cmd.newOid)) {
          reason = 'missing object';
        } else {
          ok = true;
        }
      } else if (cmd.newOid === ZERO_OID) {
        // delete
        if (current !== cmd.oldOid) {
          reason = 'stale info';
        } else {
          ok = true;
        }
      } else {
        // update
        if (current !== cmd.oldOid) {
          reason = 'stale info';
        } else if (!newObjects.has(cmd.newOid) && !store.getObject(r, cmd.newOid)) {
          reason = 'missing object';
        } else {
          // fast-forward check: old must be reachable from new
          try {
            const reachable = collectReachable([cmd.newOid], (oid) => store.getObject(r, oid));
            const ff = reachable.has(cmd.oldOid);
            if (!ff) reason = 'non-fast-forward';
            else ok = true;
          } catch {
            reason = 'missing object';
          }
        }
      }
      if (ok) applyOnly.add(i);
      report.push({ ref: cmd.ref, ok, reason });
    }

    for (const i of applyOnly) {
      const cmd = commands[i];
      if (cmd.newOid === ZERO_OID) r.refs.delete(cmd.ref);
      else r.refs.set(cmd.ref, cmd.newOid);
      r.updatedAt = Date.now();
    }

    // Build report-status inside sideband
    const inner: Buffer[] = [];
    inner.push(encodePktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`));
    for (const rep of report) {
      if (rep.ok) inner.push(encodePktLine(`ok ${rep.ref}\n`));
      else inner.push(encodePktLine(`ng ${rep.ref} ${rep.reason}\n`));
    }
    const parts: Buffer[] = [];
    for (const line of inner) parts.push(sideband1(line));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: RESULT_RECEIVE, body: Buffer.concat(parts) };
  }
}

export const gitHandler = new GitHttpHandler();

export function matchGitPath(path: string): { owner: string; repo: string; raw: string } | null {
  return parseRepoPath(path);
}

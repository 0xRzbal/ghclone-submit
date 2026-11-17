// git object model + smart-HTTP pkt-line + packfile codec, server side.
// Mirror of the suite's git-client.ts so the forge speaks byte-identical wire.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX_PAYLOAD = 65520 - 4;
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(v: string): boolean {
  return HEX40.test(v);
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(objectHeader(type, body.length));
  h.update(body);
  return h.digest('hex');
}

export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    if (!isObjectId(e.oid)) throw new Error('tree entry has bad object id');
    parts.push(Buffer.from(`${e.mode} ${e.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${fields.committer ?? fields.author} ${timestamp} ${timezone}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? 'forge'} ${timestamp} ${timezone}`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`, 'utf8');
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const c = parseCommit(object.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------- pkt-line (server side)

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : (Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0')), data]);
}

export const PKT_FLUSH = Buffer.from('0000');
export const PKT_DELIM = Buffer.from('0001');
export const PKT_RESPONSE_END = Buffer.from('0002');

export interface GitPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload?: Buffer;
}

/** Decode a full buffer of pkt-lines. Throws on malformed input. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3) {
      throw new Error('invalid pkt-line length 0003');
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Decode a stream incrementally from chunks. */
export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  push(chunk: Uint8Array): void {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!b.length) return;
    this.chunks.push(b);
    this.buffered += b.length;
  }
  finish(): void {
    this.ended = true;
  }
  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const chunks = this.chunks;
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    let ci = 0;
    while (filled < n) {
      const chunk = chunks[ci];
      const take = Math.min(n - filled, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
      ci += 1;
    }
    return out;
  }
  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }
  next(): GitPacket | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) throw new Error(`truncated pkt-line: ${this.buffered} trailing bytes`);
      return null;
    }
    const header = this.peek(4)!.toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) { this.take(4); return { kind: 'flush' }; }
    if (length === 1) { this.take(4); return { kind: 'delim' }; }
    if (length === 2) { this.take(4); return { kind: 'response-end' }; }
    if (this.buffered < length) {
      if (this.ended) throw new Error('truncated pkt-line payload');
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4) };
  }
}

// ---------------------------------------------------------------- packfile

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number } {
  let byte = buffer[start];
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = Buffer.isBuffer(buffer) ? buffer.subarray(offset) : Buffer.from(buffer).subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 invalid');
    }
  }
  return out;
}

export interface PackReadResult {
  version: number;
  objects: Map<string, GitObject>;
  checksumOk: boolean;
  deltaCount: number;
}

/** Read a packfile, resolving deltas; no external bases (pushes are non-thin). */
export function readPack(pack: Uint8Array): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  const count = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computed;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  interface Resolved { type: GitObjectType; data: Buffer; }

  const entries: RawEntry[] = [];
  let offset = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset >= trailerStart) throw new Error('pack entry header truncated');
    let byte = buffer[offset];
    const typeCode = (byte >> 4) & 0x07;
    const sizeHeader = readVarintSize(buffer, offset);
    offset = sizeHeader.next;
    let data: Buffer;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      baseOffset = base.baseOffset;
      offset = base.next;
      const infl = inflateAt(buffer, offset);
      data = infl.data;
      offset = infl.next;
      deltaCount += 1;
    } else if (typeCode === 7) {
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const infl = inflateAt(buffer, offset);
      data = infl.data;
      offset = infl.next;
      deltaCount += 1;
    } else {
      const infl = inflateAt(buffer, offset);
      data = infl.data;
      offset = infl.next;
    }
    entries.push({ offset: i, typeCode, size: sizeHeader.size, data, baseOffset, baseOid });
  }
  if (offset !== trailerStart && offset !== buffer.length) {
    // trailing padding allowed
  }
  const resolved = new Map<number, Resolved>();
  const objects = new Map<string, GitObject>();
  for (const entry of entries) {
    const res = resolveEntry(entry, resolved);
    if (res) {
      const oid = hashObject(res.type, res.data);
      objects.set(oid, { type: res.type, data: res.data });
    }
  }
  return { version, objects, checksumOk, deltaCount };

  function resolveEntry(entry: RawEntry, memo: Map<number, Resolved>): Resolved | null {
    const existing = memo.get(entry.offset);
    if (existing) return existing;
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = entries.find((e) => e.offset === entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base not found');
      const baseRes = resolveEntry(baseEntry, memo);
      data = applyDelta(baseRes.data, entry.data);
      type = baseRes.type;
    } else if (entry.typeCode === 7) {
      const baseOidVal = entry.baseOid!;
      const baseObj = objects.get(baseOidVal);
      // thin-pack base from already-parsed objects (pushes may reference earlier objects)
      if (baseObj) {
        data = applyDelta(baseObj.data, entry.data);
        type = baseObj.type;
      } else {
        throw new Error(`ref-delta base ${baseOidVal} not present`);
      }
    } else if (entry.typeCode === 1 || entry.typeCode === 2 || entry.typeCode === 3 || entry.typeCode === 4) {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    } else {
      throw new Error(`bad type code ${entry.typeCode}`);
    }
    const result = { type, data };
    memo.set(entry.offset, result);
    return result;
  }
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const code = TYPE_CODE[object.type];
    const size = object.data.length;
    const bytes: number[] = [];
    let remaining = size;
    let first = (code << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

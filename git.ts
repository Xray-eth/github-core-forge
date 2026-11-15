import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type GitObject, type Repo } from './store.ts';

const ZERO = '0'.repeat(40);
const sha1 = (data: Buffer) => createHash('sha1').update(data).digest();
const pkt = (data: string | Buffer): Buffer => {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  if (bytes.length > 65516) throw new Error('packet too large');
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
};
const FLUSH = Buffer.from('0000'), DELIM = Buffer.from('0001');
function packets(data: Buffer): { lines: string[]; offset: number } {
  const lines: string[] = []; let offset = 0;
  while (offset + 4 <= data.length) {
    const header = data.subarray(offset, offset + 4).toString();
    if (!/^[0-9a-f]{4}$/i.test(header)) throw new Error('invalid packet');
    const size = parseInt(header, 16); offset += 4;
    if (size === 0) break;
    if (size === 1 || size === 2) continue;
    if (size < 4 || offset + size - 4 > data.length) throw new Error('truncated packet');
    lines.push(data.subarray(offset, offset + size - 4).toString().replace(/\n$/, ''));
    offset += size - 4;
  }
  return { lines, offset };
}
export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries = []; let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset), nul = data.indexOf(0, space);
    if (space < offset || nul < space || nul + 21 > data.length) throw new Error('invalid tree');
    entries.push({ mode: data.subarray(offset, space).toString(), name: data.subarray(space + 1, nul).toString(), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}
export function parseCommit(data: Buffer) {
  const text = data.toString(), split = text.indexOf('\n\n');
  const headers = text.slice(0, split).split('\n');
  return { tree: headers.find(x => x.startsWith('tree '))?.slice(5) ?? '', parents: headers.filter(x => x.startsWith('parent ')).map(x => x.slice(7)), author: headers.find(x => x.startsWith('author '))?.slice(7) ?? '', committer: headers.find(x => x.startsWith('committer '))?.slice(10) ?? '', message: text.slice(split + 2) };
}
function links(object: GitObject): string[] {
  if (object.type === 'commit') { const c = parseCommit(object.data); return [c.tree, ...c.parents]; }
  if (object.type === 'tree') return parseTree(object.data).filter(e => e.mode !== '160000').map(e => e.oid);
  if (object.type === 'tag') return [object.data.toString().match(/^object ([0-9a-f]{40})/m)?.[1] ?? ''];
  return [];
}
function reachable(repo: Repo, tips: string[], stops = new Set<string>()): Set<string> {
  const found = new Set<string>(), stack = [...tips];
  while (stack.length) { const oid = stack.pop()!; if (found.has(oid) || stops.has(oid)) continue; const obj = repo.objects.get(oid); if (!obj) continue; found.add(oid); stack.push(...links(obj)); }
  return found;
}
function delta(base: Buffer, patch: Buffer): Buffer {
  let p = 0;
  const variable = () => { let value = 0, shift = 0, b: number; do { if (p >= patch.length || shift > 49) throw new Error('invalid delta size'); b = patch[p++]; value += (b & 127) * 2 ** shift; shift += 7; } while (b & 128); return value; };
  if (variable() !== base.length) throw new Error('delta base size');
  const size = variable(); if (size > 64 * 1024 * 1024) throw new Error('delta too large');
  const result = Buffer.alloc(size); let out = 0;
  while (p < patch.length) {
    const op = patch[p++];
    if (op & 128) {
      let offset = 0, length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) { if (p >= patch.length) throw new Error('truncated delta'); offset += patch[p++] * 2 ** (8 * i); }
      for (let i = 0; i < 3; i++) if (op & (16 << i)) { if (p >= patch.length) throw new Error('truncated delta'); length += patch[p++] * 2 ** (8 * i); }
      if (!length) length = 65536;
      if (offset + length > base.length || out + length > size) throw new Error('delta copy bounds');
      base.copy(result, out, offset, offset + length); out += length;
    } else {
      if (!op || p + op > patch.length || out + op > size) throw new Error('delta literal bounds');
      patch.copy(result, out, p, p + op); p += op; out += op;
    }
  }
  if (out !== size) throw new Error('delta result size'); return result;
}
/** Parse into a staging map; no objects are published before checksum and deltas verify. */
export function readPack(data: Buffer, existing: Map<string, GitObject>): Map<string, GitObject> {
  if (data.length < 32 || data.subarray(0, 4).toString() !== 'PACK' || ![2, 3].includes(data.readUInt32BE(4))) throw new Error('invalid pack header');
  if (!sha1(data.subarray(0, -20)).equals(data.subarray(-20))) throw new Error('pack checksum mismatch');
  const count = data.readUInt32BE(8); if (count > 1000000) throw new Error('pack count');
  type Entry = { offset: number; type: number; data: Buffer; base?: number | string; object?: GitObject };
  const entries: Entry[] = [], offsets = new Map<number, Entry>(), objects = new Map<string, GitObject>(); let p = 12;
  const names = ['', 'commit', 'tree', 'blob', 'tag'] as const;
  const publish = (entry: Entry, object: GitObject) => { entry.object = object; const oid = sha1(Buffer.concat([Buffer.from(`${object.type} ${object.data.length}\0`), object.data])).toString('hex'); objects.set(oid, object); };
  for (let i = 0; i < count; i++) {
    const offset = p; let b = data[p++], size = b & 15, shift = 4; const type = (b >> 4) & 7;
    while (b & 128) { if (p >= data.length - 20 || shift > 49) throw new Error('pack size'); b = data[p++]; size += (b & 127) * 2 ** shift; shift += 7; }
    if (size > 64 * 1024 * 1024) throw new Error('object too large');
    let base: number | string | undefined;
    if (type === 6) { b = data[p++]; let distance = b & 127; while (b & 128) { b = data[p++]; distance = (distance + 1) * 128 + (b & 127); if (p >= data.length - 20) throw new Error('delta offset'); } base = offset - distance; }
    else if (type === 7) { base = data.subarray(p, p + 20).toString('hex'); p += 20; }
    else if (type < 1 || type > 4) throw new Error('pack object type');
    const inflated = inflateSync(data.subarray(p, -20), { info: true, maxOutputLength: 64 * 1024 * 1024 });
    p += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('pack object size');
    const entry: Entry = { offset, type, data: inflated.buffer, base }; entries.push(entry); offsets.set(offset, entry);
    if (type <= 4) publish(entry, { type: names[type] as GitObject['type'], data: entry.data });
  }
  if (p !== data.length - 20) throw new Error('pack trailing bytes');
  let pending = entries.filter(e => !e.object);
  while (pending.length) {
    let progress = false;
    for (const entry of pending) {
      const base = typeof entry.base === 'number' ? offsets.get(entry.base)?.object : objects.get(entry.base!) ?? existing.get(entry.base!);
      if (base) { publish(entry, { type: base.type, data: delta(base.data, entry.data) }); progress = true; }
    }
    if (!progress) throw new Error('unresolved delta'); pending = pending.filter(e => !e.object);
  }
  return objects;
}
const encoded = new WeakMap<GitObject, Buffer>();
function encodeObject(object: GitObject): Buffer {
  let cached = encoded.get(object); if (cached) return cached;
  let size = object.data.length; const bytes = [(['', 'commit', 'tree', 'blob', 'tag'].indexOf(object.type) << 4) | (size & 15)]; size = Math.floor(size / 16);
  while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size & 127); size = Math.floor(size / 128); }
  cached = Buffer.concat([Buffer.from(bytes), deflateSync(object.data)]); encoded.set(object, cached); return cached;
}
function pack(repo: Repo, ids: Set<string>): Buffer {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(ids.size, 8);
  const body = Buffer.concat([header, ...[...ids].map(id => encodeObject(repo.objects.get(id)!))]); return Buffer.concat([body, sha1(body)]);
}
function sideband(data: Buffer): Buffer[] {
  const chunks: Buffer[] = []; for (let i = 0; i < data.length; i += 65515) chunks.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(i, i + 65515)]))); return chunks;
}
function refList(repo: Repo): [string, string][] {
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return [...(head ? [['HEAD', head] as [string, string]] : []), ...[...repo.refs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)];
}
function peel(repo: Repo, oid: string): string {
  const seen = new Set<string>(); while (repo.objects.get(oid)?.type === 'tag' && !seen.has(oid)) { seen.add(oid); oid = links(repo.objects.get(oid)!)[0]; } return oid;
}
/** Keep REST's derived indexes in sync with the canonical immutable objects. */
function indexObjects(repo: Repo): void {
  const flatten = (tree: string, prefix = '', files = new Map<string, string>(), active = new Set<string>()): Map<string, string> => {
    if (active.has(tree)) throw new Error('tree cycle'); active.add(tree);
    const object = repo.objects.get(tree);
    if (object?.type === 'tree') for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000' || entry.mode === '040000') flatten(entry.oid, prefix + entry.name + '/', files, active);
      else if (entry.mode !== '160000') files.set(prefix + entry.name, entry.oid);
    }
    active.delete(tree); return files;
  };
  for (const [id, object] of repo.objects) if (object.type === 'commit' && !repo.commits.has(id)) { const c = parseCommit(object.data); repo.commits.set(id, { parent: c.parents[0] ?? null, message: c.message.replace(/\n$/, ''), tree: flatten(c.tree) }); }
  for (const branch of repo.files.keys()) if (!repo.refs.has(`refs/heads/${branch}`)) repo.files.delete(branch);
  for (const [ref, id] of repo.refs) if (ref.startsWith('refs/heads/')) repo.files.set(ref.slice(11), new Map(repo.commits.get(id)?.tree ?? []));
}
function ancestor(repo: Repo, old: string, tip: string): boolean {
  const seen = new Set<string>(), stack = [tip];
  while (stack.length) { const id = stack.pop()!; if (id === old) return true; if (seen.has(id)) continue; seen.add(id); const o = repo.objects.get(id); if (o?.type === 'commit') stack.push(...parseCommit(o.data).parents); } return false;
}
function upload(repo: Repo, data: Buffer, v2: boolean): Buffer {
  // v0 may contain multiple flush-separated negotiation rounds in one HTTP body.
  let { lines, offset } = packets(data);
  if (!v2) while (offset < data.length) { const next = packets(data.subarray(offset)); lines.push(...next.lines); offset += next.offset; }
  if (v2 && lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11));
    const result = refList(repo).filter(([name]) => !prefixes.length || prefixes.some(p => name.startsWith(p))).map(([name, id]) => {
      const attrs = []; if (name === 'HEAD' && lines.includes('symrefs')) attrs.push(`symref-target:refs/heads/${repo.defaultBranch}`);
      if (lines.includes('peel') && repo.objects.get(id)?.type === 'tag') attrs.push(`peeled:${peel(repo, id)}`);
      return pkt(`${id} ${name}${attrs.length ? ' ' + attrs.join(' ') : ''}\n`);
    }); return Buffer.concat([...result, FLUSH]);
  }
  if (v2 && !lines.includes('command=fetch')) throw new Error('unsupported command');
  const wants = lines.filter(x => x.startsWith('want ')).map(x => x.split(' ')[1]);
  if (!wants.length || wants.some(x => !repo.objects.has(x))) throw new Error('invalid want');
  const haves = lines.filter(x => x.startsWith('have ')).map(x => x.slice(5));
  const shallows = new Set(lines.filter(x => x.startsWith('shallow ')).map(x => x.slice(8)));
  const depthText = lines.find(x => x.startsWith('deepen ')); const depth = depthText ? Number(depthText.slice(7)) : Infinity;
  if (depth < 1 || Number.isNaN(depth)) throw new Error('invalid depth');
  const excluded = reachable(repo, haves, shallows); for (const id of haves) excluded.add(id);
  const ids = new Set<string>(), boundaries = new Set<string>();
  const queue: [string, number][] = wants.map(id => [id, 1]); const visited = new Map<string, number>();
  while (queue.length) {
    const [id, level] = queue.pop()!; if ((visited.get(id) ?? Infinity) <= level) continue; visited.set(id, level);
    const object = repo.objects.get(id); if (!object) continue;
    if (!excluded.has(id)) ids.add(id);
    if (object.type === 'commit') {
      const c = parseCommit(object.data); queue.push([c.tree, level]);
      if (level >= depth) { if (c.parents.length) boundaries.add(id); }
      else if (!excluded.has(id) || shallows.has(id)) for (const parent of c.parents) queue.push([parent, level + 1]);
    } else for (const child of links(object)) queue.push([child, level]);
  }
  const shallowLines = [...boundaries].map(id => pkt(`shallow ${id}\n`));
  for (const id of shallows) if (visited.has(id) && !boundaries.has(id)) shallowLines.push(pkt(`unshallow ${id}\n`));
  const packed = pack(repo, ids);
  if (v2) return Buffer.concat([...(shallowLines.length ? [pkt('shallow-info\n'), ...shallowLines, DELIM] : []), pkt('packfile\n'), ...sideband(packed), FLUSH]);
  const band = lines.some(x => x.includes('side-band-64k') || x.includes('side-band'));
  return Buffer.concat([...(depthText || shallows.size ? [...shallowLines, FLUSH] : []), pkt('NAK\n'), ...(band ? [...sideband(packed), FLUSH] : [packed])]);
}
function receive(repo: Repo, data: Buffer): Buffer {
  const { lines, offset } = packets(data); if (!lines.length) throw new Error('missing commands');
  const caps = lines[0].split('\0')[1] ?? ''; const commands = lines.map(line => {
    const [old, next, ref] = line.split('\0')[0].split(' ');
    if (!/^[0-9a-f]{40}$/.test(old) || !/^[0-9a-f]{40}$/.test(next) || !ref?.startsWith('refs/') || /[\s~^:?*\[\\]|\.\.|@\{|\/\//.test(ref) || ref.endsWith('/') || ref.endsWith('.lock')) throw new Error('invalid ref command');
    return { old, next, ref };
  });
  let unpack = 'ok';
  try { if (offset < data.length) { const objects = readPack(data.subarray(offset), repo.objects); for (const [id, obj] of objects) if (!repo.objects.has(id)) repo.objects.set(id, obj); } }
  catch (error) { unpack = error instanceof Error ? error.message : 'invalid pack'; }
  const report = [pkt(`unpack ${unpack}\n`)];
  for (const { old, next, ref } of commands) {
    let reason = unpack !== 'ok' ? 'unpacker error' : '';
    if (!reason && (repo.refs.get(ref) ?? ZERO) !== old) reason = 'stale old oid';
    if (!reason && next !== ZERO && !repo.objects.has(next)) reason = 'missing object';
    if (!reason && old !== ZERO && next !== ZERO && !ancestor(repo, old, next)) reason = 'non-fast-forward';
    if (!reason) { if (next === ZERO) repo.refs.delete(ref); else repo.refs.set(ref, next); }
    report.push(pkt(reason ? `ng ${ref} ${reason}\n` : `ok ${ref}\n`));
  }
  indexObjects(repo); report.push(FLUSH);
  const result = Buffer.concat(report); return caps.includes('side-band-64k') ? Buffer.concat([...sideband(result), FLUSH]) : result;
}
function advertisement(repo: Repo, service: string, v2: boolean): Buffer {
  const preamble = [pkt(`# service=${service}\n`), FLUSH];
  if (v2 && service === 'git-upload-pack') return Buffer.concat([...['version 2\n', 'agent=forge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt), FLUSH]);
  const capabilities = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta' : `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = refList(repo); if (!refs.length) refs.push(['capabilities^{}', ZERO]);
  const result = refs.map(([name, id], i) => pkt(`${id} ${name}${i === 0 ? '\0' + capabilities : ''}\n`));
  if (service === 'git-upload-pack') for (const [name, id] of refs) if (name.startsWith('refs/tags/') && repo.objects.get(id)?.type === 'tag') result.push(pkt(`${peel(repo, id)} ${name}^{}\n`));
  return Buffer.concat([...preamble, ...result, FLUSH]);
}
export function gitRouter(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/); if (!match) return false;
  void (async () => {
    const jsonError = (status: number, message: string) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ message }) + '\n'); };
    try {
      const repo = store.getRepo(decodeURIComponent(match[1]), decodeURIComponent(match[2])); if (!repo) { jsonError(404, 'Not Found'); return; }
      const url = new URL(req.url!, 'http://forge.local'), v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
      let service: string, result: Buffer, kind: string;
      if (req.method === 'GET' && match[3] === 'info/refs') {
        service = url.searchParams.get('service') ?? ''; if (!['git-upload-pack', 'git-receive-pack'].includes(service)) { jsonError(400, 'Invalid service'); return; }
        kind = 'advertisement'; result = advertisement(repo, service, v2);
      } else if (req.method === 'POST' && ['git-upload-pack', 'git-receive-pack'].includes(match[3])) {
        service = match[3]; kind = 'result'; const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024 * 1024) throw new Error('request too large'); chunks.push(Buffer.from(chunk)); }
        const data = Buffer.concat(chunks); result = service === 'git-upload-pack' ? upload(repo, data, v2) : receive(repo, data);
      } else { jsonError(404, 'Not Found'); return; }
      res.writeHead(200, { 'content-type': `application/x-${service}-${kind}`, 'content-length': result.length, 'cache-control': 'no-cache' }); res.end(result);
    } catch (error) { jsonError(400, error instanceof Error ? error.message : 'Malformed git request'); }
  })(); return true;
}

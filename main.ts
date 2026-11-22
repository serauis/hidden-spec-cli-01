// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 5: matching lines ----------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinParts(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

function occAt(file: string[], o: string[], tier: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? stripTrail : stripBoth;
  const oo = o.map(norm);
  const out: number[] = [];
  for (let i = 0; i + oo.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oo.length; j += 1) {
      if (norm(file[i + j]!) !== oo[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(file: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occAt(file, o, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** O and N of one hunk, chunk or block, with N's context lines mapped back to O. */
interface Split {
  o: string[];
  n: string[];
  nToO: number[];
}

function splitBody(body: string[]): Split {
  const o: string[] = [];
  const n: string[] = [];
  const nToO: number[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '') {
      nToO.push(o.length);
      o.push('');
      n.push('');
    } else if (l.startsWith(' ')) {
      nToO.push(o.length);
      o.push(l.slice(1));
      n.push(l.slice(1));
    } else if (l.startsWith('-')) o.push(l.slice(1));
    else if (l.startsWith('+')) {
      nToO.push(-1);
      n.push(l.slice(1));
    }
  }
  return { o, n, nToO };
}

function renderN(file: string[], pos: number, s: Split, tier: number): string[] {
  const f = tier === 2 && s.o.length > 0 ? leadWs(file[pos]!) : '';
  const p = tier === 2 && s.o.length > 0 ? leadWs(s.o[0]!) : '';
  return s.n.map((line, i) => {
    const oi = s.nToO[i]!;
    if (oi >= 0) return file[pos + oi]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  pair: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const headerPath = (l: string): string => l.slice(4).split('\t')[0]!.trim();
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

const hunkNoEol = (body: string[]): boolean => {
  let last = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (body[k]![0] === ' ' || body[k]![0] === '+') last = k;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.startsWith('\\');
};

const createdNoEol = (hunks: Hunk[]): boolean => {
  for (let h = hunks.length - 1; h >= 0; h -= 1) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k -= 1) {
      if (body[k]![0] === '+') return body[k + 1] !== undefined && body[k + 1]!.startsWith('\\');
    }
  }
  return false;
};

function applyHunks(lines: string[], hunks: Hunk[], strict: boolean, path: string, finalIn: boolean): { lines: string[]; final: boolean } {
  let cur = lines;
  let fin = finalIn;
  let d = 0;
  for (const h of hunks) {
    const s = splitBody(h.body);
    const noEol = hunkNoEol(h.body);
    if (s.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, cur.length));
      const atEnd = pos === cur.length;
      cur = [...cur.slice(0, pos), ...s.n, ...cur.slice(pos)];
      if (atEnd) fin = !noEol;
    } else {
      const found = findTier(cur, s.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const q of found.occ) {
        const dist = Math.abs(q - target);
        if (dist < best) {
          pos = q;
          best = dist;
        }
      }
      const runsToEnd = pos + s.o.length === cur.length;
      const rep = renderN(cur, pos, s, found.tier);
      cur = [...cur.slice(0, pos), ...rep, ...cur.slice(pos + s.o.length)];
      if (runsToEnd) fin = !noEol;
    }
    d += s.n.length - s.o.length;
  }
  return { lines: cur, final: fin };
}

function sectionEdit(s: Section, strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    const isCreate = s.oldPath === null || s.create;
    const isDelete = s.newPath === null || s.del;
    if (isCreate) {
      const np = s.newPath ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const l of h.body) if (l[0] === '+') plus.push(l.slice(1));
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (createdNoEol(s.hunks) ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = s.oldPath ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = s.oldPath ?? '';
    const np = s.newPath ?? '';
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
    const parts = fileParts(before);
    const res = applyHunks(parts.lines, s.hunks, strict, op, parts.final);
    const out = joinParts(res.lines, parts.br, res.final);
    if (op === np) {
      tree.now.set(op, out);
    } else {
      tree.now.set(op, null);
      tree.now.set(np, out);
      moves.push([op, np]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: Section[] = [];
  const parseErr = (ln: number): never => {
    throw new Exit2(`error: parse ${ln}`);
  };
  let cur: Section | null = null;
  let inHead = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) parseErr(i + 1);
      cur = { oldPath: m[1]!, newPath: m[2]!, pair: false, create: false, del: false, hunks: [] };
      sections.push(cur);
      inHead = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) parseErr(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) parseErr(i + 1);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      inHead = false;
      continue;
    }
    if (cur !== null && inHead) {
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) parseErr(i + 2);
        const oldRaw = headerPath(l);
        const newRaw = headerPath(lines[i + 1]!);
        cur.oldPath = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
        cur.newPath = newRaw === '/dev/null' ? null : stripAB(newRaw);
        cur.pair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        if (!cur.pair) {
          const raw = headerPath(l);
          cur.newPath = raw === '/dev/null' ? null : stripAB(raw);
        }
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!cur.pair) cur.oldPath = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.pair) cur.newPath = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldRaw = headerPath(l);
      const newRaw = headerPath(lines[i + 1]!);
      cur = {
        oldPath: oldRaw === '/dev/null' ? null : stripAB(oldRaw),
        newPath: newRaw === '/dev/null' ? null : stripAB(newRaw),
        pair: true,
        create: false,
        del: false,
        hunks: [],
      };
      sections.push(cur);
      inHead = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict, moves));
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= n) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let q = i - 1; q >= prevEnd; q -= 1) {
      const l = lines[q]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = fileParts(before);
      const found = findTier(parts.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const s: Split = { o: oldLines, n: newLines, nToO: newLines.map(() => -1) };
      const rep = renderN(parts.lines, pos, s, found.tier);
      const out = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinParts(out, parts.br, parts.final));
    });
    prevPath = p;
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aUpdateEdit(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = fileParts(before);
    let cur = parts.lines;
    let cursor = 0;
    for (const ch of chunks) {
      const s = splitBody(ch.body);
      if (ch.anchor !== null && ch.anchor !== '') {
        const af = findTier(cur, [ch.anchor], strict, cursor);
        if (af === null) throw new Fail('no-match', p);
        cursor = af.occ[0]! + 1;
      }
      if (s.o.length === 0) {
        const pos = ch.eof ? cur.length : cursor;
        cur = [...cur.slice(0, pos), ...s.n, ...cur.slice(pos)];
        cursor = pos + s.n.length;
        continue;
      }
      const found = findTier(cur, s.o, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let pos = -1;
      for (const q of found.occ) {
        if (ch.eof && q + s.o.length !== cur.length) continue;
        pos = q;
        break;
      }
      if (pos < 0) throw new Fail('no-match', p);
      const rep = renderN(cur, pos, s, found.tier);
      cur = [...cur.slice(0, pos), ...rep, ...cur.slice(pos + s.o.length)];
      cursor = pos + rep.length;
    }
    const out = joinParts(cur, parts.br, parts.final);
    if (moveTo === null) {
      tree.now.set(p, out);
    } else {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      moves.push([p, moveTo]);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i += 1;
      const body: string[] = [];
      while (i < end && !isSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b === '') {
          body.push('');
          i += 1;
          continue;
        }
        if (b.startsWith('+')) {
          body.push(b.slice(1));
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, body.length === 0 ? '' : body.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updLine = i + 1;
      const p = l.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const open = (anchor: string | null): void => {
        cur = { anchor, eof: false, body: [] };
        chunks.push(cur);
      };
      while (i < end && !isSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b === '*** End of File') {
          if (cur === null) open(null);
          cur!.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        if (b.startsWith('@@')) {
          open(b.slice(2).trim());
          i += 1;
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) {
            if (b === '' && chunks.length > 0) {
              i += 1;
              continue;
            }
            open(null);
          }
          cur!.body.push(b);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        if (!lastChunk.eof) {
          // SPEC section 8: blank lines (empty or only whitespace) at the end of a section are not part of it.
          const lb = lastChunk.body;
          while (lb.length > 0 && lb[lb.length - 1]!.trim() === '') lb.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  const seenMove = new Set<string>();
  for (const [o, n] of moves) {
    const k = `${o}\0${n}`;
    if (seenMove.has(k)) continue;
    seenMove.add(k);
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rOld.add(o);
      rNew.add(n);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!rOld.has(p) && !rNew.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

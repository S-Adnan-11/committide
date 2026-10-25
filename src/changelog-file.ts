import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { START_MARKER, END_MARKER } from './changelog.js';
import { OperationalError } from './errors.js';

type FileSystem = typeof fs;
function layoutError(): OperationalError {
  return new OperationalError('changelog-layout', `Existing file was not changed. Keep exactly one ## Unreleased (or ## [Unreleased]) section with standalone ${START_MARKER} and ${END_MARKER} lines before the next release heading, outside code/HTML examples. Obtain a block with changelog preview and insert/repair it manually after reviewing the document. No force overwrite is available.`);
}

/** A conservative Markdown boundary reader, not a general Markdown renderer. */
export function replaceManagedContent(bytes: Buffer, content: string): Buffer {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new OperationalError('changelog-encoding', 'The existing changelog must be valid UTF-8 (an optional UTF-8 BOM is supported). It was not changed.');
  }
  const lines: { text: string; start: number; after: number; eol: string }[] = [];
  for (let start = 0; start < bytes.length;) {
    const lf = bytes.indexOf(10, start);
    const end = lf < 0 ? bytes.length : lf;
    const crlf = lf >= 0 && end > start && bytes[end - 1] === 13;
    const text = bytes.subarray(start, crlf ? end - 1 : end).toString('utf8');
    lines.push({ text: lines.length ? text : text.replace(/^\uFEFF/, ''), start, after: lf < 0 ? end : end + 1, eol: lf < 0 ? '' : crlf ? '\r\n' : '\n' });
    start = lf < 0 ? end : end + 1;
  }
  const headings: { index: number; level: number }[] = [];
  const unreleased: { index: number; supported: boolean }[] = [];
  const markers: { index: number; kind: 'start' | 'end' }[] = [];
  let fence: { char: string; length: number } | null = null;
  let html: string | null = null;
  const heading = (index: number, level: number, title: string, atx: boolean) => {
    headings.push({ index, level });
    if (/\bunreleased\b/i.test(title)) {
      const supported = /^(?:Unreleased|\[Unreleased\](?:\([^\n]*\)|\[[^\n]*\])?)$/i.test(title);
      unreleased.push({ index, supported: atx && level === 2 && supported });
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]!.text;
    if (html) {
      if (html === 'block' && /<\/?h[1-6](?=[\s>])/i.test(text)) throw layoutError();
      if (html === 'comment' ? text.includes('-->') : html === 'block' ? !text.trim() : text.toLowerCase().includes(`</${html}>`)) html = null;
      continue;
    }
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(text);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (/^(?: {4}|\t)/.test(text)) continue;
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (opening) { fence = { char: opening[1]![0]!, length: opening[1]!.length }; continue; }
    if (text === START_MARKER || text === END_MARKER) {
      markers.push({ index, kind: text === START_MARKER ? 'start' : 'end' });
      continue;
    }
    if (text.includes(START_MARKER) || text.includes(END_MARKER)) throw layoutError();
    const visible = text.replace(/<!--.*?-->/g, '');
    const openComment = visible.indexOf('<!--');
    if (/<\/?h[1-6](?=[\s>])/i.test(openComment < 0 ? visible : visible.slice(0, openComment))) throw layoutError();
    const comment = text.indexOf('<!--');
    if (comment >= 0) {
      if (/^ {0,3}#{1,6}[ \t]+.*\bunreleased\b/i.test(text)) throw layoutError();
      if (!text.slice(comment + 4).includes('-->')) html = 'comment';
      continue;
    }
    const raw = /^ {0,3}<(pre|script|style|textarea)(?=[ >])/i.exec(text);
    if (raw) { if (!text.toLowerCase().includes(`</${raw[1]!.toLowerCase()}>`)) html = raw[1]!.toLowerCase(); continue; }
    if (/^ {0,3}<[/!?A-Za-z]/.test(text)) { html = 'block'; continue; }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(text);
    if (atx) {
      heading(index, atx[1]!.length, (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim(), true);
    } else if (text.trim() && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1]?.text ?? '')) {
      heading(index, lines[index + 1]!.text.trim()[0] === '=' ? 1 : 2, text.trim(), false);
      index++;
    }
  }
  if (unreleased.length !== 1 || !unreleased[0]!.supported || markers.length !== 2
    || markers[0]!.kind !== 'start' || markers[1]!.kind !== 'end') throw layoutError();
  const section = unreleased[0]!.index;
  const sectionEnd = headings.find(item => item.index > section && item.level <= 2)?.index ?? lines.length;
  const first = lines[markers[0]!.index]!;
  const last = lines[markers[1]!.index]!;
  if (markers[0]!.index <= section || markers[1]!.index >= sectionEnd || !first.eol) throw layoutError();
  const generated = Buffer.from(content.replace(/\n/g, first.eol) + first.eol, 'utf8');
  return Buffer.concat([bytes.subarray(0, first.after), generated, bytes.subarray(last.start)]);
}

async function statOrMissing(io: FileSystem, path: string) {
  try { return await io.lstat(path, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new OperationalError('changelog-file', 'Cannot inspect the changelog path. Check directory access and permissions.');
  }
}

async function safePath(io: FileSystem, path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of relative(current, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if ((await statOrMissing(io, current))?.isSymbolicLink()) {
      throw new OperationalError('changelog-path', 'Symlinked changelog paths or parent junctions are refused. Use a real local working-tree path.');
    }
  }
}

async function snapshot(io: FileSystem, target: string) {
  await safePath(io, target);
  const before = await statOrMissing(io, target);
  if (!before) return null;
  if (!before.isFile() || before.nlink !== 1n) {
    throw new OperationalError('changelog-path', 'The changelog must be an unshared regular file, not a directory, symlink, or hard-linked file.');
  }
  const file = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const handle = await file.stat({ bigint: true });
    const bytes = await file.readFile();
    const after = await statOrMissing(io, target);
    if (!after || before.ino !== handle.ino || after.ino !== before.ino || after.dev !== before.dev
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.size !== before.size
      || after.mode !== before.mode || after.nlink !== 1n || handle.nlink !== 1n) {
      throw new OperationalError('changelog-changed', 'The changelog changed while being read. Review the file and retry.');
    }
    return { bytes, stat: after, mode: Number(handle.mode & 0o777n) };
  } finally { await file.close(); }
}

/** Capture before history generation; inject only filesystem operations for failure tests. */
export async function prepareChangelogFile(path: string, io: FileSystem = fs) {
  const target = resolve(path);
  const original = await snapshot(io, target).catch((error: unknown) => {
    if (error instanceof OperationalError) throw error;
    throw new OperationalError('changelog-file', 'Cannot read the changelog snapshot. Check access permissions and retry after other edits finish.');
  });
  return {
    target,
    async write(content: string): Promise<'created' | 'updated' | 'unchanged'> {
      const candidate = original ? replaceManagedContent(original.bytes, content)
        : Buffer.from(`# Changelog\n\n## Unreleased\n\n${START_MARKER}\n${content}\n${END_MARKER}\n`);
      const guard = `${target}.committide-lock`;
      await safePath(io, target);
      try { await io.mkdir(guard); } catch {
        throw new OperationalError('changelog-busy', 'Another changelog writer is active or the directory is inaccessible. Retry after it finishes; inspect a stale CHANGELOG.md.committide-lock manually.');
      }
      const temporary = join(dirname(target), `.committide-changelog-${randomUUID()}.tmp`);
      let prepared = false;
      const verifyOriginal = async () => {
        const current = await snapshot(io, target);
        if ((!original) !== (!current) || (original && current && (
          !original.bytes.equals(current.bytes) || original.stat.ino !== current.stat.ino
          || original.stat.dev !== current.stat.dev || original.stat.mtimeNs !== current.stat.mtimeNs
          || original.stat.ctimeNs !== current.stat.ctimeNs || original.stat.mode !== current.stat.mode))) {
          throw new OperationalError('changelog-changed', 'The changelog changed during generation. It was not overwritten; review it and run the command again.');
        }
      };
      try {
        await verifyOriginal();
        if (original?.bytes.equals(candidate)) return 'unchanged';
        const file = await io.open(temporary, 'wx', original?.mode ?? 0o666);
        prepared = true;
        try {
          await file.writeFile(candidate);
          if (original) await file.chmod(original.mode);
          await file.sync();
        } finally { await file.close(); }
        await verifyOriginal();
        // Replacement is atomic on supported local filesystems, not compare-and-swap.
        // The lock coordinates our writers; a hostile external editor can still race.
        if (original) await io.rename(temporary, target);
        else await io.link(temporary, target); // Exclusive new-file publication.
        return original ? 'updated' : 'created';
      } catch (error) {
        if (error instanceof OperationalError) throw error;
        throw new OperationalError('changelog-write', 'The changelog write or replacement failed. The destination was never truncated in place. Review the file and directory permissions before retrying.');
      } finally {
        if (prepared) {
          try { await io.unlink(temporary); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw new OperationalError('changelog-cleanup', `Inspect the owned temporary file ${temporary}; cleanup failed.`);
            }
          }
        }
        await io.rmdir(guard);
      }
    },
  };
}

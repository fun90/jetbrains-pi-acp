import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_DIFF_BYTES = 256 * 1024;

export function toolPath(cwd, path) {
  path = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '');
  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
  if (path.startsWith('file://')) {
    try { path = fileURLToPath(path); } catch { /* 无效 URI 留给 pi 工具报告。 */ }
  }
  return resolve(cwd, path);
}

export async function fileText(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_DIFF_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_DIFF_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_DIFF_BYTES || buffer.subarray(0, size).includes(0)) return undefined;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } catch (error) {
    return error.code === 'ENOENT' ? null : undefined;
  } finally {
    await file?.close();
  }
}

// edit 工具的统一补丁按片段转成 ACP diff，每个片段分别携带旧文本和新文本。
export function patchDiffs(patch, path) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > MAX_DIFF_BYTES) return [];
  const diffs = [];
  let hunk;
  let previous;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      if (header.slice(1).some(value => value !== undefined && !Number.isSafeInteger(Number(value)))) return [];
      if (hunk && (hunk.oldCount || hunk.newCount)) return [];
      hunk = { type: 'diff', path, oldText: '', newText: '', line: Math.max(1, Number(header[3])),
        oldCount: Number(header[2] ?? 1), newCount: Number(header[4] ?? 1) };
      diffs.push(hunk);
      previous = undefined;
    } else if (hunk && line === '\\ No newline at end of file') {
      if (!previous) return [];
      if (previous !== '+') hunk.oldText = hunk.oldText.slice(0, -1);
      if (previous !== '-') hunk.newText = hunk.newText.slice(0, -1);
      previous = undefined;
    } else if (hunk && (hunk.oldCount || hunk.newCount)) {
      const sign = line[0];
      if (![' ', '+', '-'].includes(sign)) return [];
      if (sign !== '+') { hunk.oldText += line.slice(1) + '\n'; hunk.oldCount--; }
      if (sign !== '-') { hunk.newText += line.slice(1) + '\n'; hunk.newCount--; }
      if (hunk.oldCount < 0 || hunk.newCount < 0) return [];
      previous = sign;
    } else if (hunk && line !== '') return [];
  }
  if (hunk && (hunk.oldCount || hunk.newCount)) return [];
  return diffs.map(({ oldCount, newCount, ...diff }) => diff);
}

// write 使用扩展记录的写入前后全文，edit 使用 pi 生成的补丁；结果带 line 供定位。
export function fileDiffs(name, path, result, isError = false) {
  if (isError || !path || !['edit', 'write'].includes(name)) return [];
  const snapshot = result?.details?.acpDiff;
  if (name === 'write') {
    if (!snapshot || snapshot.path !== path ||
        !(snapshot.oldText === null || typeof snapshot.oldText === 'string') ||
        typeof snapshot.newText !== 'string' ||
        Buffer.byteLength((snapshot.oldText ?? '') + snapshot.newText) > MAX_DIFF_BYTES ||
        snapshot.oldText === snapshot.newText) return [];
    return [{ type: 'diff', path, oldText: snapshot.oldText, newText: snapshot.newText, line: 1 }];
  }
  return patchDiffs(result?.details?.patch, path);
}

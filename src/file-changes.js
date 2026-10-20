import { execFile } from 'node:child_process';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileText } from './file-diff.js';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const fallbackIgnoredDirectories = new Set([
  'node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'coverage',
  '.gradle', '.next', '.nuxt', '.output', '.cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
]);

export async function fileSnapshot(cwd) {
  const files = new Map();
  const directories = [cwd];
  const deadline = Date.now() + 2000;
  let entries = 0;
  let incomplete = false;
  const ignored = new Set();
  let fallback = false;
  try {
    // Git 保留已跟踪文件，并处理嵌套 .gitignore、否定规则及仓库本地忽略规则。
    const { stdout } = await executeFile('git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd, timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
    for (const path of stdout.split('\0')) if (path) ignored.add(join(cwd, path.replace(/\/$/, '')));
  } catch { fallback = true; }
  while (directories.length) {
    if (Date.now() > deadline) return { files, incomplete: true };
    const directory = directories.pop();
    try {
      if ((await lstat(directory)).isSymbolicLink()) { incomplete = true; continue; }
      for await (const entry of await opendir(directory)) {
        if (entry.name === '.git' || entry.name === '.DS_Store' ||
            (fallback && entry.isDirectory() && fallbackIgnoredDirectories.has(entry.name))) continue;
        const path = join(directory, entry.name);
        if (ignored.has(path)) continue;
        // shortcut: 每次最多扫描 20000 项或 2 秒，大项目需要增量文件监听时再升级。
        if (++entries > 20000 || Date.now() > deadline) return { files, incomplete: true };
        try {
          const info = await lstat(path, { bigint: true });
          if (info.isDirectory()) directories.push(path);
          else files.set(path, `${info.mode}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
        } catch { incomplete = true; }
      }
    } catch { incomplete = true; }
  }
  return { files, incomplete };
}

export function changedFiles(before, after) {
  const paths = [];
  for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
    // 扫描不完整时，未出现的路径不能认定为新增或删除。
    if ((!before.files.has(path) && before.incomplete) || (!after.files.has(path) && after.incomplete)) continue;
    if (before.files.get(path) !== after.files.get(path)) paths.push(path);
  }
  return paths;
}

// shortcut: 仅缓存 ≤64 KiB 的文本文件，总量 8 MiB、耗时 2 秒，用于给 bash 改动补 diff；更大的文件只报路径。
export async function snapshotTexts(snapshot) {
  const texts = new Map();
  const deadline = Date.now() + 2000;
  let total = 0;
  for (const [path, stamp] of snapshot.files) {
    if (Date.now() > deadline || total > 8 * 1024 * 1024) break;
    if (Number(stamp.split(':')[2]) > 64 * 1024) continue;
    const text = await fileText(path);
    if (typeof text === 'string') { texts.set(path, text); total += text.length; }
  }
  return texts;
}

// 为 edit/write 之外变更的文本文件生成整文件 diff，最多 20 个。
export async function bashDiffs(before, paths, skip) {
  const diffs = [];
  for (const path of paths) {
    if (skip.has(path) || diffs.length >= 20) continue;
    const oldText = before.files.has(path) ? before.texts?.get(path) : before.incomplete ? undefined : null;
    const newText = await fileText(path);
    if (oldText === undefined || newText === undefined || oldText === newText) continue;
    diffs.push({ type: 'diff', path, oldText, newText: newText ?? '' });
  }
  return diffs;
}

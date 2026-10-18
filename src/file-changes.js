import { execFile } from 'node:child_process';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export async function fileSnapshot(cwd) {
  const files = new Map();
  const directories = [cwd];
  const deadline = Date.now() + 2000;
  let entries = 0;
  let incomplete = false;
  const ignored = new Set();
  try {
    // Git 保留已跟踪文件，并处理嵌套 .gitignore、否定规则及仓库本地忽略规则。
    const { stdout } = await executeFile('git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd, timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
    for (const path of stdout.split('\0')) if (path) ignored.add(join(cwd, path.replace(/\/$/, '')));
  } catch { /* 非 Git 项目或 Git 不可用时保留文件系统扫描。 */ }
  while (directories.length) {
    if (Date.now() > deadline) return { files, incomplete: true };
    const directory = directories.pop();
    try {
      if ((await lstat(directory)).isSymbolicLink()) { incomplete = true; continue; }
      for await (const entry of await opendir(directory)) {
        if (entry.name === '.git') continue;
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

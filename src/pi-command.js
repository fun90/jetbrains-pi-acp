import { fileURLToPath } from 'node:url';

// 未指定时使用依赖自带的 pi；.js 入口用当前 Node 启动，避免 Windows 无法直接执行 .cmd 包装脚本。
export function resolvePi(command, args = []) {
  if (!command) {
    const entry = new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
    return { command: process.execPath, args: [fileURLToPath(entry), ...args] };
  }
  if (/\.[cm]?js$/i.test(command)) return { command: process.execPath, args: [command, ...args] };
  return { command, args };
}

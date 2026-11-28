import { realpathSync } from 'node:fs';
import packageInfo from '../package.json' with { type: 'json' };

// JetBrains Air 的登录终端只运行启动配置的 command 加登录方式的 args，acp.json 中的 args 会丢失，需由登录方式补回。
const npxEntry = ['--yes', `${packageInfo.name}@${packageInfo.version}`];

export function airLoginArgs([, script, ...args], env) {
  // command 是 npx 时补包名，是 node 时补脚本路径。
  return [...(env.npm_command === 'exec' ? npxEntry : [script]), ...args];
}

const samePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

// command 本身已指向适配器时（全局安装的命令、Registry 的 npx 包），补回的入口会成为多余参数，在此去掉。
export function loginOptions([, script, ...args]) {
  if (npxEntry.every((value, index) => args[index] === value)) return args.slice(npxEntry.length);
  return args.length && samePath(args[0], script) ? args.slice(1) : args;
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolvePi } from './pi-command.js';
import { Agent } from './agent.js';
import { readJsonl, writeJsonl } from './jsonl.js';
import { t } from './i18n.js';

const options = process.argv.slice(2);
let command = process.env.PI_ACP_PI_COMMAND;
let setup = process.env.PI_ACP_SETUP === '1';
let args = [];
while (options.length) {
  const option = options.shift();
  if (option === '--') { args = options; break; }
  if (option === '--help') { process.stderr.write(`${t('usage')}\n`); process.exit(0); }
  if (option === '--setup') setup = true;
  else if (option === '--pi-command' && options.length) command = options.shift();
  else { process.stderr.write(`${t('unknownOption', { option })}\n`); process.exit(1); }
}
({ command, args } = resolvePi(command, args));

if (setup) {
  // 终端登录：前台运行 pi，由用户执行 /login；退出码沿用 pi 的结果。
  process.stderr.write(`${t('setupHint')}\n`);
  const child = spawn(command, args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => {
    process.stderr.write(`${t('piStartFailed', { error: error.message })}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 0)));
} else {
  const agent = new Agent({ command, args, send: record => writeJsonl(process.stdout, record) });
  readJsonl(process.stdin, record => { void agent.receive(record); }, () => {
    writeJsonl(process.stdout, { jsonrpc: '2.0', id: null, error: { code: -32700, message: t('jsonParseFailed') } });
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await agent.close();
    process.exit(0);
  };
  process.stdin.on('end', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.on('error', stop);
}

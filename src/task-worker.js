import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalProcesses } from './terminal-input.js';
import { t } from './i18n.js';

const directory = process.argv[2];
const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
const processes = new TerminalProcesses();
const controller = new AbortController();
const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
const state = { version: 1, owner: config.owner, taskId: config.taskId,
  state: 'running', output: '', outputEnd: 0, truncated: false, heartbeat: Date.now() };
const flushInterval = 100;
const flushRetryLimit = 2000;
let flushRetryUntil;

function flush() {
  state.heartbeat = Date.now();
  writeFileSync(join(directory, 'state.tmp'), JSON.stringify(state), { mode: 0o600 });
  renameSync(join(directory, 'state.tmp'), join(directory, 'state.json'));
}

function tryFlush() {
  try {
    flush();
    flushRetryUntil = undefined;
    return true;
  } catch (error) {
    // Windows 读取方打开 state.json 时，替换文件可能短暂失败。保留上次完整快照。
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
    flushRetryUntil ??= Date.now() + flushRetryLimit;
    if (Date.now() >= flushRetryUntil) throw error;
    return false;
  }
}

async function flushWithRetry() {
  // 首次和最终快照各有独立的重试时间，避免沿用周期写入即将用完的时间。
  flushRetryUntil = undefined;
  while (!tryFlush()) await delay(flushInterval);
}

function output(text) {
  state.outputEnd += text.length;
  const combined = state.output + text;
  state.truncated ||= combined.length > 256 * 1024;
  state.output = combined.slice(-256 * 1024);
}
await flushWithRetry();
const timer = setInterval(() => {
  try {
    try {
      if (readFileSync(join(directory, 'stop'), 'utf8') === config.token) controller.abort();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    tryFlush();
  } catch (error) {
    state.error = t('taskStoreFailed', { error: error.message });
    controller.abort();
  }
}, flushInterval);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort());
try {
  const { exitCode } = await processes.exec(config.taskId, config.shell, config.command, config.cwd, {
    env: process.env, signal: controller.signal, timeout: config.timeout, reap: true,
    onData: (data, source) => output(decoders[source].write(data)),
  }, () => processes.processes.get(config.taskId)?.stdin.end());
  state.exitCode = exitCode;
  state.state = exitCode === 0 ? 'completed' : 'failed';
} catch (error) {
  state.state = controller.signal.aborted ? 'stopped' : 'failed';
  state.error ??= error.message;
} finally {
  clearInterval(timer);
  processes.close();
  output(decoders.stdout.end() + decoders.stderr.end());
  await flushWithRetry();
}

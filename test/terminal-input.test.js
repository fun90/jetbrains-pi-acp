import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalProcesses, validateTerminalInput } from '../src/terminal-input.js';
import { t as msg } from '../src/i18n.js';

const shell = { shell: '/bin/bash', args: ['-c'] };
const cwd = process.cwd();

function start(terminals, id, command, options = {}) {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let output = '';
  const completed = terminals.exec(id, shell, command, cwd,
    { env: process.env, onData: data => { output += data.toString(); }, interactive: true, ...options }, ready);
  return { started, completed, output: () => output };
}

test('stdin 支持分次 Unicode、显式换行、EOF 并清理退出进程', async () => {
  const terminals = new TerminalProcesses();
  const run = start(terminals, 'one', 'cat');
  await run.started;
  await terminals.input({ terminalId: 'one', data: '你好\n' });
  await terminals.input({ terminalId: 'one', data: '最后一行', eof: true });
  assert.deepEqual(await run.completed, { exitCode: 0 });
  assert.equal(run.output(), '你好\n最后一行');
  assert.equal(terminals.processes.size, 0);
  await assert.rejects(terminals.input({ terminalId: 'one', data: '迟到' }), { message: msg('terminalUnavailable') });
});

test('stdin 不串进程，拒绝非法输入与超过字节上限的 Unicode', async () => {
  const terminals = new TerminalProcesses();
  const a = start(terminals, 'a', 'cat');
  const b = start(terminals, 'b', 'cat');
  await Promise.all([a.started, b.started]);
  await terminals.input({ terminalId: 'a', data: 'A', eof: true });
  await terminals.input({ terminalId: 'b', data: 'B', eof: true });
  await Promise.all([a.completed, b.completed]);
  assert.equal(a.output(), 'A');
  assert.equal(b.output(), 'B');
  for (const input of [{ terminalId: '', data: '' }, { terminalId: 'a', data: 1 },
    { terminalId: 'a', data: '你'.repeat(22000) }, { terminalId: 'a', data: '', eof: 1 }]) {
    assert.throws(() => validateTerminalInput(input), { message: msg('terminalInputInvalid') });
  }
});

test('等待 stdin 的命令可以取消、超时和关闭', async () => {
  const terminals = new TerminalProcesses();
  const controller = new AbortController();
  const cancelled = start(terminals, 'cancel', 'cat', { signal: controller.signal });
  const rejected = assert.rejects(cancelled.completed, /aborted/);
  await cancelled.started;
  controller.abort();
  await rejected;
  const timeout = start(terminals, 'timeout', 'cat', { timeout: 0.05 });
  await assert.rejects(timeout.completed, /timeout:0.05/);
  const closed = start(terminals, 'closed', 'cat');
  await closed.started;
  terminals.close();
  assert.notEqual((await closed.completed).exitCode, 0);
  assert.equal(terminals.processes.size, 0);
});

test('非交互命令的 stdin 为 /dev/null：读 stdin 不卡住、不可输入、不通知就绪', async () => {
  const terminals = new TerminalProcesses();
  let readied = false;
  const run = start(terminals, 'plain', 'cat; echo 结束', { interactive: false });
  run.started.then(() => { readied = true; });
  assert.deepEqual(await run.completed, { exitCode: 0 });
  assert.equal(run.output(), '结束\n');
  assert.equal(readied, false);
  const controller = new AbortController();
  const sleeping = start(terminals, 'sleep', 'sleep 5', { interactive: false, signal: controller.signal });
  await assert.rejects(terminals.input({ terminalId: 'sleep', data: 'x' }), { message: msg('terminalUnavailable') });
  controller.abort();
  await assert.rejects(sleeping.completed, /aborted/);
  assert.equal(terminals.processes.size, 0);
});

test('reap 在 shell 退出后清理同组残留进程，默认保留', { skip: process.platform === 'win32' }, async () => {
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const orphan = async options => {
    let output = '';
    // 子进程关闭 stdout，模拟服务器进程；shell 随即被 SIGTERM 杀掉，复现任务以 143 结束而子进程残留。
    const run = new TerminalProcesses().exec('orphan', shell, 'sleep 30 >/dev/null 2>&1 & echo $!; kill -TERM $$', cwd,
      { onData: data => { output += data.toString(); }, ...options }, () => {});
    assert.equal((await run).exitCode, 143);
    const pid = Number(output.trim());
    await new Promise(resolve => setTimeout(resolve, 100));
    return pid;
  };
  const kept = await orphan({});
  assert.equal(alive(kept), true);
  process.kill(kept, 'SIGKILL');
  assert.equal(alive(await orphan({ reap: true })), false);
});

test('无效 shell 和已取消调用均不留下进程', async () => {
  const terminals = new TerminalProcesses();
  await assert.rejects(terminals.exec('bad', { shell: '/nonexistent/pi-acp-shell', args: ['-c'] },
    'cat', cwd, { onData() {} }, () => {}), /ENOENT/);
  await assert.rejects(terminals.exec('abort', shell, 'cat', cwd,
    { onData() {}, signal: AbortSignal.abort() }, () => {}), /aborted/);
  assert.equal(terminals.processes.size, 0);
});

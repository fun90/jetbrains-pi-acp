import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../src/task-worker.js', import.meta.url));

async function waitForFile(path, signal) {
  for (;;) {
    try { return await readFile(path, { encoding: 'utf8', signal }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20, undefined, { signal });
  }
}

test('Windows 读取状态文件时，后台命令继续运行并在文件释放后保存终态',
  { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-acp-worker-lock-'));
    const statePath = join(directory, 'state.json');
    const command = `
      const fs = require('node:fs');
      fs.writeFileSync('ready', '');
      const timer = setInterval(() => {
        if (!fs.existsSync('finish')) return;
        clearInterval(timer);
        console.log('命令执行完成');
        fs.writeFileSync('done', '');
      }, 20);
    `;
    await writeFile(join(directory, 'config.json'), JSON.stringify({ owner: 'parent', taskId: 'task', token: 'stop-token',
      cwd: directory, command, shell: { shell: process.execPath, args: ['--eval'] }, timeout: 5 }));
    const worker = spawn(process.execPath, [workerPath, directory], { windowsHide: true });
    const exited = once(worker, 'close');
    let stderr = '';
    worker.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null) {
        await writeFile(join(directory, 'stop'), 'stop-token');
      }
      await exited;
      await rm(directory, { recursive: true, force: true });
    });
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(4000)]);
    await waitForFile(join(directory, 'ready'), signal);
    const reader = await open(statePath, 'r');
    try {
      const initial = JSON.parse(await reader.readFile('utf8'));
      await delay(300);
      assert.equal(worker.exitCode, null, stderr);
      await writeFile(join(directory, 'finish'), '');
      await waitForFile(join(directory, 'done'), signal);
      await delay(250);
      assert.equal(worker.exitCode, null, stderr);
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), initial);
    } finally { await reader.close(); }
    assert.deepEqual(await exited, [0, null], stderr);
    const final = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(final.state, 'completed');
    assert.equal(final.exitCode, 0);
    assert.match(final.output, /命令执行完成/);
    assert.equal(final.error, undefined);
  });

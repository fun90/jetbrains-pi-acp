import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../src/agent.js';
import { resolvePi } from '../src/pi-command.js';
import { ProtocolAgent } from '../src/protocol.js';
import { t as msg } from '../src/i18n.js';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('默认 pi 来自安装依赖，显式命令与参数保持原样', async () => {
  const bundled = resolvePi(undefined, ['--version']);
  assert.equal(bundled.command, process.execPath);
  const { stdout } = await execute(bundled.command, bundled.args);
  assert.equal(stdout.trim(), '1.5.2');
  assert.deepEqual(resolvePi('/custom/pi', ['--model', 'x']),
    { command: '/custom/pi', args: ['--model', 'x'] });
});

test('终端认证启动同一个 pi 并保留参数、交互输入与退出码', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'login.mjs');
  await writeFile(fixture, `
    if (process.env.PI_ACP_TEST_EXIT) process.exit(Number(process.env.PI_ACP_TEST_EXIT));
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    console.log(JSON.stringify({ args: process.argv.slice(2), input }));
    process.exitCode = Number(process.env.PI_ACP_TEST_EXIT || 0);
  `);
  const agent = new Agent({ send() {}, command: process.execPath, args: [fixture, '参数 含空格'] });
  const initialized = await agent.dispatch('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { 'terminal-auth': true } } });
  const method = initialized.authMethods[0];
  assert.equal(method.type, 'terminal');
  const done = Promise.withResolvers();
  const child = execFile(process.execPath, [entry, ...method._meta['terminal-auth'].args], (error, stdout, stderr) => {
    if (error) done.reject(error);
    else done.resolve({ stdout, stderr });
  });
  child.stdin.end('交互输入\n');
  const result = await done.promise;
  assert.deepEqual(JSON.parse(result.stdout), { args: ['参数 含空格'], input: '交互输入\n' });
  assert.match(result.stderr, /\/login/);
  await assert.rejects(execute(process.execPath, [entry, ...method._meta['terminal-auth'].args],
    { env: { ...process.env, PI_ACP_TEST_EXIT: '7' } }), error => error.code === 7);
});

test('终端认证启动失败时返回非零退出码并给出诊断', async () => {
  await assert.rejects(execute(process.execPath,
    [entry, '--setup', '--pi-command', '/不存在的目录/pi']), error => {
    assert.equal(error.code, 1);
    assert.ok(error.stderr.includes(msg('piStartFailed', { error: '' })));
    return true;
  });
});

test('登录入口使用环境变量指定的 pi，双横线后的参数不被解析为适配器选项', async () => {
  const { stdout } = await execute(process.execPath, [entry, '--setup', '--', '--version'],
    { env: { ...process.env, PI_ACP_PI_COMMAND: process.execPath } });
  assert.equal(stdout.trim(), process.version);
  await assert.rejects(execute(process.execPath, [entry, '--未知参数']), error => error.code === 1);
});

test('标准终端认证保留带双横线的启动参数，环境变量进入登录模式', async () => {
  const { stdout } = await execute(process.execPath,
    [entry, '--pi-command', process.execPath, '--', '--version'],
    { env: { ...process.env, PI_ACP_SETUP: '1' } });
  assert.equal(stdout.trim(), process.version);
});

test('终端认证按 v1/v2 能力协商，v2 退出关闭当前连接并要求重新认证', async () => {
  for (const version of [1, 2]) {
    for (const supported of [false, true]) {
      const records = [];
      const protocol = new ProtocolAgent({ send: record => records.push(record) });
      const auth = supported ? { terminal: version === 1 ? true : {} } : {};
      await protocol.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: version, ...(version === 1 ? { clientCapabilities: { auth } }
          : { info: { name: 'test', version: '1' }, capabilities: { auth } }),
      } });
      assert.equal(records.at(-1).result.authMethods.length, supported ? 1 : 0);
      if (version === 2 && supported) {
        const method = records.at(-1).result.authMethods[0];
        assert.equal(method.methodId, 'pi-login');
        assert.deepEqual(method.env, [{ name: 'PI_ACP_SETUP', value: '1' }]);
        await protocol.receive({ jsonrpc: '2.0', id: 2, method: 'auth/login', params: { methodId: method.methodId } });
        assert.equal(records.at(-1).error.code, -32602);
        await protocol.receive({ jsonrpc: '2.0', id: 3, method: 'auth/logout', params: {} });
        assert.deepEqual(records.at(-1).result, {});
        assert.equal(protocol.agent.closing, true);
        await protocol.receive({ jsonrpc: '2.0', id: 4, method: 'session/new', params: { cwd: tmpdir() } });
        assert.equal(records.at(-1).error.code, -32000);
      }
    }
  }
});

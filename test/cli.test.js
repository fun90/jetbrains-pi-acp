import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };
import { Agent } from '../src/agent.js';
import { resolvePi } from '../src/pi-command.js';
import { t as msg } from '../src/i18n.js';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('默认 pi 来自安装依赖，.js 入口用当前 Node 启动，其他命令保持原样', async () => {
  const bundled = resolvePi(undefined, ['--version']);
  assert.equal(bundled.command, process.execPath);
  const { stdout } = await execute(bundled.command, bundled.args);
  assert.equal(stdout.trim(), manifest.dependencies['@earendil-works/pi-coding-agent']);
  assert.deepEqual(resolvePi('/custom/pi', ['--model', 'x']), { command: '/custom/pi', args: ['--model', 'x'] });
  assert.deepEqual(resolvePi('C:\\pi\\dist\\cli.js', ['-v']), { command: process.execPath, args: ['C:\\pi\\dist\\cli.js', '-v'] });
});

test('终端登录方式只在客户端声明能力时提供，通过环境变量进入登录模式', async () => {
  const agent = new Agent({ send() {}, command: 'pi' });
  assert.deepEqual((await agent.dispatch('initialize', { protocolVersion: 1 })).authMethods, []);
  const [method] = (await agent.dispatch('initialize', { protocolVersion: 1,
    clientCapabilities: { auth: { terminal: true } } })).authMethods;
  assert.deepEqual({ id: method.id, type: method.type, args: method.args, env: method.env },
    { id: 'pi-login', type: 'terminal', args: [], env: { PI_ACP_SETUP: '1' } });
  await assert.rejects(agent.dispatch('authenticate', { methodId: 'pi-login' }), { code: -32602 });
});

test('登录模式启动同一个 pi，保留双横线后的参数、交互输入与退出码', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'login.mjs');
  await writeFile(fixture, `
    if (process.env.PI_ACP_TEST_EXIT) process.exit(Number(process.env.PI_ACP_TEST_EXIT));
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    console.log(JSON.stringify({ args: process.argv.slice(2), input }));
  `);
  const args = [entry, '--pi-command', fixture, '--', '参数 含空格', '--setup'];
  const done = Promise.withResolvers();
  const child = execFile(process.execPath, args, { env: { ...process.env, PI_ACP_SETUP: '1' } },
    (error, stdout, stderr) => error ? done.reject(error) : done.resolve({ stdout, stderr }));
  child.stdin.end('交互输入\n');
  const result = await done.promise;
  assert.deepEqual(JSON.parse(result.stdout), { args: ['参数 含空格', '--setup'], input: '交互输入\n' });
  assert.match(result.stderr, /\/login/);
  await assert.rejects(execute(process.execPath, [entry, '--setup', '--pi-command', fixture],
    { env: { ...process.env, PI_ACP_TEST_EXIT: '7' } }), error => error.code === 7);
});

test('登录模式启动失败返回非零退出码；未知参数被拒绝', async () => {
  await assert.rejects(execute(process.execPath, [entry, '--setup', '--pi-command', join(tmpdir(), '不存在', 'pi')]), error => {
    assert.equal(error.code, 1);
    assert.ok(error.stderr.includes(msg('piStartFailed', { error: '' })));
    return true;
  });
  await assert.rejects(execute(process.execPath, [entry, '--未知参数']), error => error.code === 1);
});

test('PI_ACP_PI_COMMAND 指定 pi 命令', async () => {
  const { stdout } = await execute(process.execPath, [entry, '--setup', '--', '--version'],
    { env: { ...process.env, PI_ACP_PI_COMMAND: process.execPath } });
  assert.equal(stdout.trim(), process.version);
});

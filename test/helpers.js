import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl, writeJsonl } from '../src/jsonl.js';

export const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const fixture = fileURLToPath(new URL('../fixtures/pi.js', import.meta.url));

// 启动适配器子进程。默认使用 pi 替身；piCommand 为 null 时使用依赖自带的 pi。
export async function client(t, { piCommand = fixture, args = [], env = {}, sessionDir } = {}) {
  const directory = sessionDir ?? await mkdtemp(join(tmpdir(), 'pi-acp-test-'));
  const child = spawn(process.execPath, [join(root, 'src/index.js'),
    ...(piCommand ? ['--pi-command', piCommand] : []), ...(args.length ? ['--', ...args] : [])],
  { cwd: root, env: { ...process.env, ...env, PI_CODING_AGENT_SESSION_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const records = [];
  const waiters = [];
  readJsonl(child.stdout, record => {
    records.push(record);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(record)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(record);
    }
  }, error => assert.fail(error.message));
  const wait = (predicate, from = 0) => new Promise((resolve, reject) => {
    const found = records.slice(from).find(predicate);
    if (found) return resolve(found);
    waiters.push({ predicate, resolve, timer: setTimeout(() => reject(new Error(`等待超时：${stderr}`)), 15000) });
  });
  let id = 0;
  const send = record => writeJsonl(child.stdin, record);
  const request = (method, params) => {
    const requestId = ++id;
    send({ jsonrpc: '2.0', id: requestId, method, params });
    return wait(record => record.id === requestId && record.method === undefined);
  };
  const updates = (sessionId, from = 0) => records.slice(from)
    .filter(record => record.method === 'session/update' && record.params.sessionId === sessionId)
    .map(record => record.params.update);
  t.after(async () => {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
    assert.equal(child.exitCode, 0, stderr);
    if (!sessionDir) await rm(directory, { recursive: true, force: true });
  });
  return { child, records, send, request, wait, updates, directory, stderr: () => stderr };
}

export async function initialize(c, clientCapabilities = {}) {
  const response = await c.request('initialize', { protocolVersion: 1, clientCapabilities });
  assert.equal(response.result.protocolVersion, 1);
  return response.result;
}

export async function newSession(c, params = {}) {
  const response = await c.request('session/new', { cwd: root, mcpServers: [], ...params });
  assert.ok(response.result?.sessionId, JSON.stringify(response));
  await c.wait(record => record.params?.sessionId === response.result.sessionId &&
    record.params.update?.sessionUpdate === 'available_commands_update');
  return response.result;
}

export const prompt = (c, sessionId, text) => c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

export const messageText = updates => updates.filter(update => update.sessionUpdate === 'agent_message_chunk')
  .map(update => update.content.text).join('');

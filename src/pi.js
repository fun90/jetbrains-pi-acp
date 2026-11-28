import { spawn } from 'node:child_process';
import { readJsonl, writeJsonl } from './jsonl.js';
import { t } from './i18n.js';

// 一个 pi RPC 子进程：stdin 发命令，stdout 收响应和事件，stderr 原样转给适配器的 stderr。
export class PiProcess {
  constructor({ command, args, cwd, env, onEvent, onFailure }) {
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.closing = false;
    this.onFailure = onFailure;
    this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true });
    this.child.stderr.pipe(process.stderr, { end: false });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(t('piExited', { reason: signal ?? code }))));
    readJsonl(this.child.stdout, record => {
      if (record.type === 'response') this.response(record);
      else onEvent(record);
    }, error => this.fail(new Error(t('piOutputInvalid', { error: error.message }))));
  }

  response(record) {
    const request = this.pending.get(record.id);
    if (!request) return;
    this.pending.delete(record.id);
    clearTimeout(request.timer);
    if (record.success) request.resolve(record.data);
    else request.reject(new Error(record.error || t('piCommandFailed')));
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.onFailure(error);
    this.child.kill();
  }

  send(record) {
    if (this.closed) throw new Error(t('piClosed'));
    writeJsonl(this.child.stdin, record);
  }

  // timeout 为 0 时不设超时，等到响应或进程退出。
  request(type, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = `pi-${++this.sequence}`;
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t('piCommandTimeout', { type })));
      }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ ...params, type, id }); }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  // 关闭 stdin 请求 pi 有序退出；超时后强制结束。
  async close() {
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise(resolve => this.child.once('exit', resolve));
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), 2000);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(terminate);
    clearTimeout(kill);
  }
}

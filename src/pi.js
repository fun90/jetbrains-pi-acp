import { spawn } from 'node:child_process';
import { readJsonl, writeJsonl } from './jsonl.js';
import { t } from './i18n.js';

export class PiProcess {
  constructor({ command, args, cwd, configPath, onEvent, onFailure, onControl }) {
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.child = spawn(command, args, {
      cwd, env: { ...process.env, PI_ACP_CONFIG: configPath },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.pipe(process.stderr, { end: false });
    this.child.stdin.on('error', error => this.fail(error, onFailure));
    this.child.on('error', error => this.fail(error, onFailure));
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(t('piExited', { reason: signal ?? code })), error => {
        if (!this.closing) onFailure(error);
      });
    });
    this.child.stdio[3].on('error', error => this.fail(error, onFailure));
    readJsonl(this.child.stdio[3], record => {
      if (record.type === 'acp_task_request') void onControl?.(record);
      else this.response(record);
    },
      error => this.fail(new Error(t('controlChannelInvalid', { error: error.message })), onFailure));
    readJsonl(this.child.stdout, record => {
      if (record.type === 'response') this.response(record);
      else onEvent(record);
    }, error => this.fail(new Error(t('piOutputInvalid', { error: error.message })), onFailure));
  }

  controlResponse(id, data, error) {
    if (!this.closed) writeJsonl(this.child.stdio[3], { type: 'acp_task_response', id,
      success: !error, ...(error ? { error: error.message } : { data }) });
  }

  response(record) {
    const request = this.pending.get(record.id);
    if (!request) return;
    this.pending.delete(record.id);
    clearTimeout(request.timer);
    if (record.success) request.resolve(record.data);
    else request.reject(new Error(record.error || t('piCommandFailed')));
  }

  fail(error, onFailure) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    onFailure(error);
    this.child.kill();
  }

  send(record) {
    if (this.closed) throw new Error(t('piClosed'));
    writeJsonl(this.child.stdin, record);
  }

  request(type, params = {}) {
    return new Promise((resolve, reject) => {
      const id = `pi-${++this.sequence}`;
      const timeout = type === 'compact' ? 300000 : 30000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t('piCommandTimeout', { type })));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        if (['terminal_input', 'acp_task_save', 'task_notify'].includes(type)) {
          if (this.closed) throw new Error(t('piClosed'));
          writeJsonl(this.child.stdio[3], { ...params, type, id });
        } else this.send({ ...params, type, id });
      }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async close() {
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise(resolve => this.child.once('exit', resolve));
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), 1000);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(terminate);
    clearTimeout(kill);
  }
}

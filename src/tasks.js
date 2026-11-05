import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalid, logError, restrictedModes } from './shared.js';
import { t } from './i18n.js';

const running = task => task.state === 'running';
const MAX_OUTPUT = 256 * 1024;
// pi-agents 的 AgentState 到异步任务状态的映射；未知状态按运行中处理。
const piAgentState = { working: 'running', waiting: 'running', idle: 'completed',
  failed: 'failed', interrupted: 'stopped', skipped: 'stopped' };
const piAgentDescription = { working: 'agentWorking', waiting: 'agentWaiting', idle: 'agentCompleted',
  failed: 'agentFailed', interrupted: 'agentInterrupted', skipped: 'agentSkipped' };
// IDE 任务列表行不截断长名称，会把停止链接挤出可见区域，故只发单行短名。
export const taskLabel = text => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

export class Tasks {
  constructor(agent) {
    this.agent = agent;
    this.tasks = new Map();

  }

  childUpdate(session, update) {
    const task = this.tasks.get(session.taskId);
    if (!task) return false;
    if (!task.announced) {
      (task.buffer ??= []).push(update);
      return true;
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      this.output(task, update.content.text);
    }
    if (this.agent.nativeSubagents) return false;
    const parent = this.agent.sessions.get(task.owner);
    if (parent && update.sessionUpdate === 'agent_message_chunk') this.agent.update(parent, {
      sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId,
      content: [{ type: 'content', content: { type: 'text', text: task.output } }],
    });
    return true;
  }

  // pi-agents 的子 agent 运行在 pi 进程内，不是 ACP 子会话，只能作为只读的异步任务展示。
  // 快照在同一 instanceId 内按 sequence 递增，乱序或重复的快照直接丢弃。
  agentsState(session, snapshot) {
    if (!this.agent.asyncTasks || snapshot?.protocol !== 1 || !Array.isArray(snapshot.agents) ||
        typeof snapshot.instanceId !== 'string' || !Number.isSafeInteger(snapshot.sequence) ||
        snapshot.agents.some(info => typeof info?.id !== 'string' || typeof info.name !== 'string')) return;
    const known = session.piAgents ??= { instanceId: undefined, sequence: 0, states: new Map() };
    const sameInstance = known.instanceId === snapshot.instanceId;
    if (sameInstance && snapshot.sequence <= known.sequence) return;
    known.instanceId = snapshot.instanceId;
    known.sequence = snapshot.sequence;
    // stopped 只表示发布者不再持有这些 agent，不代表它们已结束，保留现有展示。
    if (snapshot.type !== 'snapshot') return;
    // agent_stop 会从完整快照中移除节点，可能不经过 interrupted 状态。
    const present = new Set(snapshot.agents.map(info => info.id));
    if (sameInstance) for (const [id, previous] of known.states) {
      if (previous.state !== 'running' || present.has(id)) continue;
      const asyncTaskId = `pi-agents:${id}`;
      const description = t('agentClosed');
      known.states.set(id, { state: 'stopped', description });
      this.agent.update(session, { sessionUpdate: 'async_task_progress', asyncTaskId, description });
      this.agent.update(session, { sessionUpdate: 'async_task_state_update', asyncTaskId, state: 'stopped' });
    }
    for (const info of snapshot.agents) {
      const state = piAgentState[info.state] ?? 'running';
      const final = info.closed && state === 'running' ? 'stopped' : state;
      const description = t(info.closed && state === 'running' ? 'agentClosed'
        : piAgentDescription[info.state] ?? 'agentWorking');
      const asyncTaskId = `pi-agents:${info.id}`;
      const previous = known.states.get(info.id);
      if (previous?.state === final && previous.description === description) continue;
      known.states.set(info.id, { state: final, description });
      // Air 隐藏运行中的状态标签，用独立描述展示状态，避免任务列表只有名称。
      if (previous === undefined) this.agent.update(session, { sessionUpdate: 'async_task_spawned', asyncTaskId,
        name: taskLabel(info.name), description, taskType: 'agent', showInTranscript: false, canStop: false });
      else this.agent.update(session, { sessionUpdate: 'async_task_progress', asyncTaskId, description });
      if (previous?.state !== final && (previous !== undefined || final !== 'running')) this.agent.update(session, {
        sessionUpdate: 'async_task_state_update', asyncTaskId, state: final });
    }
  }

  owned(session, id) {
    const task = this.tasks.get(id);
    if (!task || task.owner !== session.id) throw invalid(t('taskNotFound'));
    return task;
  }

  snapshot(task) {
    return { taskId: task.id, state: task.state, ...(task.childId ? { sessionId: task.childId } : {}),
      output: task.output, truncated: task.truncated, ...(task.error ? { error: task.error } : {}),
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}) };
  }

  output(task, text) {
    const combined = task.output + text;
    task.output = combined.slice(-MAX_OUTPUT);
    task.truncated ||= combined.length > MAX_OUTPUT;
  }

  finish(task, state, error) {
    if (!running(task)) return;
    task.state = state;
    if (error) task.error = error.message;
    const parent = this.agent.sessions.get(task.owner);
    if (!parent) return;
    this.publishState(parent, task);
    return this.save(parent, task);
  }

  publishState(parent, task) {
    const state = task.state;
    const error = task.error ? new Error(task.error) : undefined;
    if (task.childId && task.announced && this.agent.nativeSubagents) this.agent.update(parent, {
      sessionUpdate: 'subagent_state_update', subagentSessionId: task.childId,
      state: state === 'stopped' ? 'cancelled' : state,
    });
    if (!task.childId && this.agent.asyncTasks) this.agent.update(parent, {
      sessionUpdate: 'async_task_state_update', asyncTaskId: task.id, state,
      ...(error ? { summary: error.message } : {}), toolCallId: task.toolCallId,
    });
    const { output, ...result } = this.snapshot(task);
    this.agent.update(parent, { sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId,
      status: state === 'completed' ? 'completed' : 'failed',
      ...(!task.childId ? { _meta: { terminal_exit: {
        terminal_id: task.toolCallId, exit_code: task.exitCode ?? null, signal: null,
      } } } : {}),
      rawOutput: result });
  }

  record(task) {
    return { version: 1, owner: task.owner, id: task.id, kind: task.kind, toolCallId: task.toolCallId,
      text: task.text, name: task.name, mode: task.mode,
      ...(task.customInstructions !== undefined ? { customInstructions: task.customInstructions } : {}), ...this.snapshot(task) };
  }

  save(session, task) {
    const record = this.record(task);
    const write = (session.taskWrites ?? Promise.resolve()).catch(() => {}).then(() =>
      session.pi.request('acp_task_save', { task: record }));
    session.taskWrites = write;
    task.persistence = write;
    return write;
  }

  shellDirectory(session, task) {
    if (!session.file) throw invalid(t('sessionNoPath'));
    return join(`${session.file}.tasks`, task.id);
  }

  async startShell(session, task, params) {
    task.directory = this.shellDirectory(session, task);
    const root = `${session.file}.tasks`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw invalid(t('taskDirInvalid'));
    await mkdir(task.directory, { mode: 0o700 });
    task.token = randomUUID();
    await writeFile(join(task.directory, 'config.json'), JSON.stringify({ version: 1,
      owner: session.id, taskId: task.id, token: task.token, cwd: session.cwd,
      shell: params.shell, command: params.command, timeout: params.timeout }), { mode: 0o600 });
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./task-worker.js', import.meta.url)), task.directory],
      { cwd: session.cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
    worker.unref();
    this.watchShell(session, task);
  }

  watchShell(session, task) {
    const started = Date.now();
    let outputEnd = 0;
    let busy = false;
    task.completion = new Promise((resolve, reject) => {
      const poll = async () => {
        if (busy) return;
        busy = true;
        try {
          let state;
          try { state = JSON.parse(await readFile(join(task.directory, 'state.json'), 'utf8')); }
          catch (error) { if (error.code === 'ENOENT' && Date.now() - started < 5000) return; throw error; }
          if (state.version !== 1 || state.owner !== session.id || state.taskId !== task.id ||
              !['running', 'completed', 'failed', 'stopped'].includes(state.state) ||
              typeof state.output !== 'string' || state.output.length > MAX_OUTPUT ||
              !Number.isSafeInteger(state.outputEnd) || state.outputEnd < state.output.length ||
              !Number.isFinite(state.heartbeat)) throw invalid(t('taskStateInvalid'));
          if (state.state === 'running' && Date.now() - started > 10000 && Date.now() - state.heartbeat > 10000) {
            throw new Error(t('taskWorkerLost'));
          }
          const delta = state.output.slice(Math.max(0, outputEnd - (state.outputEnd - state.output.length)));
          outputEnd = state.outputEnd;
          task.output = state.output;
          task.truncated = state.truncated === true;
          if (delta) this.agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId,
            ...(this.agent.transcript.terminalOutputKey() ? { _meta: {
              [this.agent.transcript.terminalOutputKey()]: { terminal_id: task.toolCallId, data: delta },
            } } : { content: [{ type: 'content', content: { type: 'text', text: task.output } }] }) });
          if (state.state !== 'running') {
            clearInterval(task.timer);
            task.exitCode = state.exitCode;
            await this.finish(task, task.failure ? 'failed' : state.state,
              task.failure ?? (state.error ? new Error(state.error) : undefined));
            resolve();
          }
        } catch (error) {
          clearInterval(task.timer);
          await this.stopShell(task).catch(() => {});
          try { await this.finish(task, 'failed', error); resolve(); } catch (failure) { reject(failure); }
        } finally { busy = false; }
      };
      task.timer = setInterval(poll, 100);
      void poll();
    });
    // 保留错误供 stop/close 检查，同时避免异步完成时产生未处理的拒绝。
    task.completion.catch(error => logError('saveTaskFailed')(error));
  }

  async stopShell(task) {
    if (!task.directory || !task.token) return;
    const path = join(task.directory, 'stop');
    try { await writeFile(path, task.token, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await lstat(path)).isFile() || await readFile(path, 'utf8') !== task.token) throw error;
    }
  }

  branch({ entries, leafId }) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const branch = [];
    const seen = new Set();
    for (let entry = byId.get(leafId); entry && !seen.has(entry.id); entry = byId.get(entry.parentId)) {
      seen.add(entry.id);
      branch.push(entry);
    }
    return branch.reverse();
  }

  ownedBy(sessionId) {
    return [...this.tasks.values()].filter(task => task.owner === sessionId);
  }

  relation(childId) {
    return [...this.tasks.values()].find(task => task.childId === childId);
  }

  announce(session, task) {
    if (task.childId && this.agent.nativeSubagents) this.agent.update(session, {
      sessionUpdate: 'subagent_spawned', subagentSessionId: task.childId, name: task.name,
      task: task.text, capabilities: { cancel: true, close: true },
    });
    if (!task.childId && this.agent.asyncTasks) {
      this.agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId: task.toolCallId,
        content: [{ type: 'terminal', terminalId: task.toolCallId }],
        _meta: { terminal_info: { terminal_id: task.toolCallId, cwd: session.cwd },
          jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } } } });
      this.agent.update(session, { sessionUpdate: 'async_task_spawned', asyncTaskId: task.id,
        name: taskLabel(task.name), taskType: 'shell', showInTranscript: false, canStop: running(task), toolCallId: task.toolCallId });
    }
    task.announced = true;
  }

  async restore(session, entries, context = {}) {
    const ancestors = new Set(context.ancestors ?? []);
    ancestors.add(session.id);
    const saved = new Map();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const entry of entries) {
      const data = entry.type === 'custom' && entry.customType === 'acp_task' ? entry.data : null;
      if (!data || data.version !== 1 || data.owner !== session.id || !uuid.test(data.id) ||
          !['agent', 'shell'].includes(data.kind) || typeof data.toolCallId !== 'string' ||
          typeof data.text !== 'string' || data.text.length > 100000 || typeof data.name !== 'string' ||
          (data.customInstructions !== undefined && (typeof data.customInstructions !== 'string' || data.customInstructions.length > 100000)) ||
          typeof data.output !== 'string' || data.output.length > MAX_OUTPUT ||
          !['running', 'completed', 'failed', 'stopped', 'disconnected'].includes(data.state) ||
          !['full', 'standard', 'read-only', 'plan'].includes(data.mode) ||
          (data.kind === 'agent' && !uuid.test(data.sessionId)) ||
          (data.kind === 'shell' && data.state === 'disconnected')) continue;
      saved.set(data.id, data);
    }
    for (const data of saved.values()) {
      let task = this.tasks.get(data.id);
      if (task && task.owner !== session.id) continue;
      const live = task !== undefined;
      if (!task) {
        task = { ...data, childId: data.kind === 'agent' ? data.sessionId : undefined,
          controller: new AbortController(), started: Promise.resolve() };
        this.tasks.set(task.id, task);
      }
      this.announce(session, task);
      if (task.childId) {
        try {
          if (ancestors.has(task.childId)) throw invalid(t('childCycle'));
          const existing = this.agent.sessions.get(task.childId);
          if (existing && (existing.parentId !== session.id || existing.taskId !== task.id)) throw invalid(t('childOpenedElsewhere'));
          const interrupted = !live && running(task);
          if (interrupted) { task.state = 'disconnected'; task.error = t('taskInterrupted'); }
          if (!existing?.turn) {
            if (context.replay !== false) task.output = '';
            const metadata = { parentId: session.id, taskId: task.id, mode: task.mode,
              instructions: task.customInstructions, restoreContext: { ...context, ancestors } };
            const params = { sessionId: task.childId, cwd: session.cwd, mcpServers: session.mcpServers ?? [],
              _meta: { jetbrains: { air: { customInstructions: session.customInstructions } } } };
            if (context.replay === false) await this.agent.resumeSession(params, metadata);
            else await this.agent.loadSession(params, metadata);
            if (interrupted) {
              const child = this.agent.sessions.get(task.childId);
              const branch = this.branch(await child.pi.request('get_entries'));
              const last = branch.filter(entry => entry.type === 'message').at(-1)?.message;
              if (last?.role === 'assistant' && ['stop', 'length', 'error', 'aborted'].includes(last.stopReason)) {
                task.state = last.stopReason === 'error' ? 'failed' : last.stopReason === 'aborted' ? 'stopped' : 'completed';
                task.error = last.errorMessage;
              }
            }
          }
        } catch (error) {
          if (!live) { task.state = 'disconnected'; task.error = error.message; }
        }
        if (!running(task)) {
          this.publishState(session, task);
          if (!live) await this.save(session, task);
        }
      } else if (!live && running(task)) {
        try {
          task.directory = this.shellDirectory(session, task);
          if (!(await lstat(`${session.file}.tasks`)).isDirectory() ||
              !(await lstat(task.directory)).isDirectory() ||
              !(await lstat(join(task.directory, 'config.json'))).isFile()) throw invalid(t('taskDirInvalid'));
          const config = JSON.parse(await readFile(join(task.directory, 'config.json'), 'utf8'));
          if (config.owner !== session.id || config.taskId !== task.id || !uuid.test(config.token)) {
            throw invalid(t('taskIdentityMismatch'));
          }
          task.token = config.token;
          this.watchShell(session, task);
        } catch (error) { await this.finish(task, 'failed', error); }
      } else if (!running(task)) this.publishState(session, task);
    }
  }

  async start(session, kind, params, toolCallId = randomUUID()) {
    if (session.changingConfig || session.failure || session.turn?.cancelled || this.agent.closing) {
      throw invalid(t('sessionCannotStartTask'));
    }
    if (restrictedModes.includes(session.mode)) throw invalid(t('modeForbidsTask'));
    const text = kind === 'agent' ? params.prompt : params.command;
    if (typeof text !== 'string' || !text.trim() || text.length > 100000 ||
        (params.name !== undefined && (typeof params.name !== 'string' || params.name.length > 10000))) throw invalid(t('taskContentInvalid'));
    if (kind === 'shell' && (!params.shell || typeof params.shell.shell !== 'string' ||
        !Array.isArray(params.shell.args) || params.shell.args.some(arg => typeof arg !== 'string'))) {
      throw invalid(t('shellConfigInvalid'));
    }
    const task = { id: randomUUID(), owner: session.id, toolCallId, kind, text,
      name: params.name || (kind === 'agent' ? t('subagent') : text), mode: session.mode,
      customInstructions: session.customInstructions, state: 'running',
      output: '', truncated: false, controller: new AbortController() };
    if (kind === 'agent') task.childId = randomUUID();
    let started;
    task.started = new Promise(resolve => { started = resolve; });
    this.tasks.set(task.id, task);
    try {
      await this.save(session, task);
      if (task.controller.signal.aborted || session.turn?.cancelled || this.agent.closing ||
          restrictedModes.includes(session.mode)) throw invalid(t('taskStoppedOrModeChanged'));
      if (kind === 'agent') {
        try {
          await this.agent.newSession({ cwd: session.cwd, mcpServers: session.mcpServers,
            _meta: { jetbrains: { air: { customInstructions: session.customInstructions } } } },
          { id: task.childId, parentId: session.id, taskId: task.id });
          const child = this.agent.sessions.get(task.childId);
          if (task.controller.signal.aborted) throw invalid(t('taskStopped'));
          const [provider, ...model] = session.currentModelId.split('/');
          await child.pi.request('set_model', { provider, modelId: model.join('/') });
          child.currentModelId = session.currentModelId;
          await child.pi.request('set_thinking_level', { level: session.thinkingLevel });
          await this.agent.refreshThinking(child);
          await this.agent.setMode(child, session.mode);
          if (task.controller.signal.aborted || session.turn?.cancelled || this.agent.closing || restrictedModes.includes(session.mode)) throw invalid(t('taskStoppedOrModeChanged'));
          if (this.agent.nativeSubagents) this.agent.update(session, { sessionUpdate: 'subagent_spawned',
            subagentSessionId: child.id, name: params.name || t('subagent'), task: text,
            capabilities: { cancel: true, close: true } });
          else this.agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId,
            ...(this.agent.airClient ? { _meta: { jetbrains: { air: { version: 1, subagent: true } } } } : {}),
            rawOutput: { sessionId: child.id, taskId: task.id } });
          task.announced = true;
          for (const update of task.buffer ?? []) this.agent.update(child, update);
          delete task.buffer;
          task.completion = this.agent.prompt(child, { message: text }, false).then(result => {
            return this.finish(task, result.stopReason === 'cancelled' ? 'stopped'
              : result._meta?.jetbrains?.air?.sessionFailure ? 'failed' : 'completed');
          }, error => this.finish(task, 'failed', error));
        } catch (error) {
          try { await this.finish(task, task.controller.signal.aborted ? 'stopped' : 'failed', error); }
          finally { await this.agent.closeSession({ sessionId: task.childId }).catch(() => {}); }
          throw error;
        }
      } else {
        if (this.agent.asyncTasks) {
          this.agent.update(session, { sessionUpdate: 'tool_call_update', toolCallId,
            _meta: { jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } } } });
          this.agent.update(session, { sessionUpdate: 'async_task_spawned', asyncTaskId: task.id,
            name: taskLabel(text), taskType: 'shell', showInTranscript: false, canStop: true, toolCallId });
        }
        await this.startShell(session, task, params);
      }
      task.completion?.catch(error => logError('saveTaskFailed')(error));
      return this.snapshot(task);
    } catch (error) {
      if (running(task)) await this.finish(task, task.controller.signal.aborted ? 'stopped' : 'failed', error);
      throw error;
    } finally { started(); }
  }

  async stop(session, id) {
    const task = this.owned(session, id);
    if (!running(task)) {
      const seen = new Set();
      const active = owner => {
        if (seen.has(owner)) return false;
        seen.add(owner);
        return [...this.tasks.values()].some(child => child.owner === owner &&
          (running(child) || (child.childId && active(child.childId))));
      };
      if (!task.childId || !active(task.childId)) return { stopped: false };
      await this.agent.dispatch('session/cancel', { sessionId: task.childId });
      return { stopped: true };
    }
    task.controller.abort();
    await task.started;
    if (!task.childId && running(task)) await this.stopShell(task);
    if (task.childId && this.agent.sessions.has(task.childId)) {
      await this.agent.dispatch('session/cancel', { sessionId: task.childId });
    }
    await task.completion;
    await this.finish(task, 'stopped');
    return { stopped: task.state === 'stopped' };
  }

  async close(session, error) {
    await Promise.all(this.ownedBy(session.id).map(async task => {
      try {
        if (running(task) && error) {
          task.failure = error;
          task.controller.abort();
          await task.started;
          if (!task.childId) { await this.stopShell(task); await task.completion; }
          else await this.finish(task, 'failed', error);
        } else if (running(task)) await this.stop(session, task.id);
      } finally {
        try { if (task.childId) await this.agent.closeSession({ sessionId: task.childId }); }
        finally { this.tasks.delete(task.id); }
      }
      await task.persistence;
    }));
  }
}

import packageInfo from '../package.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Session } from './session.js';
import { History } from './history.js';
import { convertMcp } from './convert.js';
import { invalid, methodNotFound, notFound } from './errors.js';
import { t } from './i18n.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = error => ({ code: Number.isInteger(error.code) ? error.code : -32603, message: error.message });

// ACP v1 Agent：处理 JSON-RPC 消息，管理会话生命周期，并代会话向客户端发起授权和表单请求。
export class Agent {
  constructor({ send, command, args = [] }) {
    this.send = send;
    this.command = command;
    this.args = args;
    this.history = new History(args);
    this.sessions = new Map();
    this.locks = new Map();
    this.pending = new Map();
    this.prompts = new Map();
    this.clientCapabilities = {};
    this.initialized = false;
    this.closing = false;
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  // 向客户端发请求并等待结果；会话取消或关闭时以 null 结束。
  request(session, method, params) {
    const id = `pi-acp-${randomUUID()}`;
    return new Promise(resolve => {
      this.pending.set(id, { session, resolve });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  cancelRequests(session) {
    for (const [id, entry] of this.pending) {
      if (entry.session !== session) continue;
      this.pending.delete(id);
      entry.resolve(null);
    }
  }

  async receive(message) {
    if (!object(message) || message.jsonrpc !== '2.0') {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: t('invalidJsonRpc') } });
      return;
    }
    if (message.method === undefined && ('result' in message || 'error' in message)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      entry?.resolve(message.result ?? null);
      return;
    }
    if (typeof message.method !== 'string') {
      if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: t('invalidJsonRpc') } });
      return;
    }
    const params = message.params ?? {};
    if (message.id === undefined) {
      // 通知：只处理取消，失败只记录日志。
      const sessionId = message.method === 'session/cancel' ? params.sessionId
        : message.method === '$/cancel_request' ? this.prompts.get(params.requestId) : undefined;
      await this.sessions.get(sessionId)?.cancel()
        .catch(error => process.stderr.write(`${t('cancelFailed', { error: error.message })}\n`));
      return;
    }
    if (message.method === 'session/prompt') this.prompts.set(message.id, params.sessionId);
    try {
      const result = await this.dispatch(message.method, params);
      this.send({ jsonrpc: '2.0', id: message.id, result });
      if (['session/new', 'session/load', 'session/resume'].includes(message.method)) {
        await this.sessions.get(result.sessionId ?? params.sessionId)?.publish();
      } else if (message.method === 'session/prompt') {
        this.sessions.get(params.sessionId)?.scheduleBackgroundRepublish();
      }
    } catch (error) {
      this.send({ jsonrpc: '2.0', id: message.id, error: failure(error) });
    } finally {
      this.prompts.delete(message.id);
    }
  }

  async dispatch(method, params) {
    if (!object(params)) throw invalid(t('paramsObject'));
    if (method === 'initialize') return this.initialize(params);
    if (!this.initialized) throw invalid(t('initializeFirst'));
    if (this.closing) throw new Error(t('adapterClosing'));
    switch (method) {
      case 'authenticate': throw invalid(t('terminalAuthOnly'));
      case 'session/new': return this.newSession(params);
      case 'session/load': return this.locked(params.sessionId, () => this.openSession(params, true));
      case 'session/resume': return this.locked(params.sessionId, () => this.openSession(params, false));
      case 'session/list': return this.history.list(params);
      case 'session/close': return this.locked(params.sessionId, () => this.closeSession(params.sessionId));
      case 'session/delete': return this.locked(params.sessionId, () => this.deleteSession(params.sessionId));
      case 'session/prompt': return this.session(params.sessionId).prompt(params.prompt);
      case 'session/cancel':
        await this.session(params.sessionId).cancel();
        return {};
      case 'session/set_config_option': {
        const session = this.session(params.sessionId);
        if (typeof params.value !== 'string') throw invalid(t('configOptionValue'));
        await session.setConfig(params.configId, params.value);
        if (params.configId === 'mode') session.update({ sessionUpdate: 'current_mode_update', currentModeId: session.mode });
        return { configOptions: session.configOptions() };
      }
      case 'session/set_mode': {
        const session = this.session(params.sessionId);
        await session.setMode(params.modeId);
        session.update({ sessionUpdate: 'config_option_update', configOptions: session.configOptions() });
        return {};
      }
      default: throw methodNotFound(t('methodUnsupported', { method }));
    }
  }

  initialize(params) {
    if (!Number.isInteger(params.protocolVersion) || params.protocolVersion < 0) throw invalid(t('missingProtocolVersion'));
    this.clientCapabilities = object(params.clientCapabilities) ? params.clientCapabilities : {};
    this.initialized = true;
    // 终端登录：客户端按原启动配置追加环境变量重新运行适配器，进入 pi 交互界面执行 /login。
    const terminalAuth = this.clientCapabilities.auth?.terminal === true;
    return {
      protocolVersion: 1,
      agentInfo: { name: packageInfo.name, title: 'pi', version: packageInfo.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true },
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
      },
      authMethods: terminalAuth ? [{ id: 'pi-login', type: 'terminal', name: t('loginMethodName'),
        description: t('loginMethodDescription'), args: [], env: { PI_ACP_SETUP: '1' } }] : [],
    };
  }

  session(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw notFound(t('sessionNotFound'));
    if (this.locks.has(sessionId)) throw invalid(t('sessionOperating'));
    if (session.failure) throw session.failure;
    return session;
  }

  // 同一会话的加载、恢复、关闭和删除依次执行。
  locked(sessionId, operation) {
    if (typeof sessionId !== 'string' || !sessionId) throw invalid(t('missingSessionId'));
    const current = (this.locks.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.locks.set(sessionId, current);
    return current.finally(() => {
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId);
    });
  }

  async checkSessionParams(params) {
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw invalid(t('cwdAbsolute'));
    if (!(await stat(params.cwd).catch(() => null))?.isDirectory()) throw invalid(t('cwdDirectory'));
    if (params.additionalDirectories?.length) throw invalid(t('additionalDirsUnsupported'));
    return convertMcp(params.mcpServers ?? []);
  }

  async start(options) {
    const session = new Session(this, options);
    this.sessions.set(session.id, session);
    try {
      await session.start();
      if (this.closing) throw new Error(t('adapterClosing'));
      return session;
    } catch (error) {
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
      await session.close().catch(() => {});
      throw error;
    }
  }

  async newSession(params) {
    const mcpServers = await this.checkSessionParams(params);
    const session = await this.start({ id: randomUUID(), cwd: params.cwd, mcpServers });
    return { sessionId: session.id, ...session.state() };
  }

  // 打开历史会话；已打开的会话重启 pi 进程，以应用新的 MCP 配置并保留权限模式。
  async openSession(params, replay) {
    const mcpServers = await this.checkSessionParams(params);
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      if (existing.busy) throw invalid(t('sessionBusy'));
      if (resolve(existing.cwd) !== resolve(params.cwd)) throw invalid(t('sessionCwdMismatch'));
      this.sessions.delete(existing.id);
      await existing.close();
    }
    const saved = await this.history.find(params.sessionId, params.cwd);
    if (!saved) throw notFound(t('savedSessionNotFound'));
    const session = await this.start({ id: saved.id, cwd: params.cwd, mcpServers, path: saved.path, mode: existing?.mode });
    if (replay) {
      try { await session.replay(); }
      catch (error) {
        this.sessions.delete(session.id);
        await session.close();
        throw error;
      }
    }
    return session.state();
  }

  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      await session.close();
    }
    return {};
  }

  async deleteSession(sessionId) {
    const live = this.sessions.get(sessionId);
    await this.closeSession(sessionId);
    const saved = await this.history.find(sessionId, live?.cwd);
    if (!saved) {
      if (live) return {};
      throw notFound(t('savedSessionNotFound'));
    }
    await unlink(saved.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return {};
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.locks.values()]);
    await Promise.allSettled([...this.sessions.values()].map(session => session.close()));
    this.sessions.clear();
  }
}

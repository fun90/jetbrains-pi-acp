import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fallbackTitle } from './convert.js';
import { invalid } from './errors.js';
import { t } from './i18n.js';

const PAGE_SIZE = 100;
let pi;
// pi 包较大，首次需要历史时再加载。
const load = async () => (pi ??= await import('@earendil-works/pi-coding-agent'));

// 历史会话直接读取 pi 原生存储；目录优先级与 pi 一致：--session-dir、环境变量、settings.json。
export class History {
  constructor(args = []) {
    const index = args.lastIndexOf('--session-dir');
    this.sessionDir = index === -1 ? undefined : args[index + 1];
  }

  async directory(cwd) {
    const configured = this.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR;
    if (configured) return resolve(configured.replace(/^~(?=$|[\\/])/, homedir()));
    const { SettingsManager } = await load();
    return SettingsManager.create(cwd).getSessionDir();
  }

  async sessions(cwd) {
    const { SessionManager } = await load();
    const directory = await this.directory(cwd ?? process.cwd());
    return cwd === undefined ? SessionManager.listAll(directory) : SessionManager.list(cwd, directory);
  }

  async find(sessionId, cwd) {
    return (await this.sessions(cwd)).find(session => session.id === sessionId);
  }

  // session/list：游标为下一页起点的序号字符串。
  async list({ cwd, cursor }) {
    const offset = cursor == null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(cursor ?? 0)) {
      throw invalid(t('listCursorInvalid'));
    }
    const all = await this.sessions(cwd ?? undefined);
    const page = all.slice(offset, offset + PAGE_SIZE).map(session => ({
      sessionId: session.id, cwd: session.cwd, title: session.name || fallbackTitle(session.firstMessage),
      updatedAt: session.modified.toISOString(),
    }));
    return { sessions: page, ...(offset + PAGE_SIZE < all.length ? { nextCursor: String(offset + PAGE_SIZE) } : {}) };
  }
}

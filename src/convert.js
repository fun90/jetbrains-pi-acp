import { invalid } from './errors.js';
import { t } from './i18n.js';

const pairs = (list, message) => {
  if (list === undefined || list === null) return {};
  if (!Array.isArray(list) || list.some(item => typeof item?.name !== 'string' || typeof item.value !== 'string')) {
    throw invalid(message);
  }
  return Object.fromEntries(list.map(item => [item.name, item.value]));
};

// ACP mcpServers 转成 pi.registerMcpServer 的配置；名称归一后不得重复。
export function convertMcp(servers = []) {
  if (!Array.isArray(servers)) throw invalid(t('mcpServersArray'));
  const result = {};
  const names = new Set();
  for (const server of servers) {
    if (typeof server?.name !== 'string' || !/^[\w-]+$/.test(server.name)) throw invalid(t('mcpNameInvalid'));
    const key = server.name.replaceAll('-', '_');
    if (names.has(key)) throw invalid(t('mcpNameDuplicate'));
    names.add(key);
    if (server.type === 'http') {
      if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url)) throw invalid(t('httpMcpInvalid'));
      result[server.name] = { url: server.url, headers: pairs(server.headers, t('httpMcpInvalid')), exposure: 'direct' };
    } else if (server.type === undefined || server.type === 'stdio') {
      if (typeof server.command !== 'string' || !server.command ||
          (server.args != null && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string')))) {
        throw invalid(t('stdioMcpInvalid'));
      }
      result[server.name] = { command: server.command, args: server.args ?? [],
        env: pairs(server.env, t('stdioMcpInvalid')), exposure: 'direct' };
    } else throw invalid(t('mcpTransportUnsupported', { type: server.type }));
  }
  return result;
}

// Air 把选中的文件、提交等附件以 "context: renderer=..." 块追加在输入之后；识别命令和生成兜底标题时需去掉。
export const stripAirContext = text => text.split(/(?:^|\r?\n\r?\n)context: renderer=/)[0];

// 用户输入的文字：只取文本块，不含资源附件和 Air 附件块。
export const typedText = blocks => stripAirContext(blocks.filter(block => block?.type === 'text')
  .map(block => block.text).join('\n\n')).trim();

// 用于识别本地命令：Air 会把附件的 @ 引用插在命令之前，需一并去掉。
export const commandText = blocks => typedText(blocks).replace(/^(?:@\S+\s+)+/, '');

// 会话尚未命名时的标题：去掉 Air 附件块和开头的附件引用后压成一行；只有附件时保留引用。
export function fallbackTitle(message) {
  const text = stripAirContext(message).trim();
  const words = text.replace(/^(?:(?:@|Referenced resource: )\S+\s*)+/, '') || text;
  return Array.from(words.replace(/\s+/g, ' ')).slice(0, 80).join('') || null;
}

// ACP 提示内容块转成 pi prompt 命令的 message 与 images。资源标签发给模型，固定使用英文。
export function convertPrompt(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw invalid(t('promptEmpty'));
  const text = [];
  const images = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block?.type === 'image' && typeof block.data === 'string' &&
             typeof block.mimeType === 'string' && block.mimeType.startsWith('image/')) {
      images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else if (block?.type === 'resource' && typeof block.resource?.text === 'string') {
      text.push(`File context (${block.resource.uri}):\n${block.resource.text}`);
    } else if (block?.type === 'resource_link' && typeof block.uri === 'string') {
      text.push(`Referenced resource: ${block.uri}`);
    } else throw invalid(t('promptContentUnsupported', { type: block?.type }));
  }
  return { message: text.join('\n\n'), ...(images.length ? { images } : {}) };
}

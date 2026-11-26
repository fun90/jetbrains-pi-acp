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

// ACP 提示内容块转成 pi prompt 命令的 message 与 images。
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
      text.push(t('fileContext', { uri: block.resource.uri, text: block.resource.text }));
    } else if (block?.type === 'resource_link' && typeof block.uri === 'string') {
      text.push(t('resourceLink', { uri: block.uri }));
    } else throw invalid(t('promptContentUnsupported', { type: block?.type }));
  }
  return { message: text.join('\n\n'), ...(images.length ? { images } : {}) };
}

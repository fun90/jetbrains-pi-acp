import { fileDiffs, toolPath } from './file-diff.js';

// 无副作用、不需要授权的 pi 内置工具。
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

const KINDS = { read: 'read', ls: 'read', grep: 'search', find: 'search', edit: 'edit', write: 'edit',
  bash: 'execute', powershell: 'execute' };

const locate = (cwd, args) => typeof args?.path === 'string' ? toolPath(cwd, args.path) : undefined;

// 工具调用开始时的 ACP tool_call 字段。
export function toolCall(cwd, toolCallId, name, args) {
  const detail = [args?.command, args?.path, args?.pattern].find(value => typeof value === 'string' && value);
  const path = locate(cwd, args);
  return { toolCallId, title: detail ? `${name} ${detail.split('\n')[0].slice(0, 120)}` : name,
    kind: KINDS[name] ?? 'other', rawInput: args, ...(path ? { locations: [{ path }] } : {}) };
}

// 工具输出（部分或最终）转成 tool_call_update 的 content；只有成功完成的 edit/write 附带 diff。
export function toolResult(cwd, name, args, result, isError, done) {
  const content = (result?.content ?? []).filter(block => block.type === 'text' || block.type === 'image')
    .map(block => ({ type: 'content', content: block.type === 'text' ? { type: 'text', text: block.text }
      : { type: 'image', data: block.data, mimeType: block.mimeType } }));
  const path = locate(cwd, args);
  const diffs = done ? fileDiffs(name, path, result, isError) : [];
  const changed = result?.details?.firstChangedLine;
  const line = Number.isSafeInteger(changed) && changed > 0 ? changed : diffs[0]?.line;
  return { content: [...content, ...diffs.map(({ line: _, ...diff }) => diff)],
    ...(done ? { rawOutput: result } : {}),
    ...(path && line !== undefined && !isError ? { locations: [{ path, line }] } : {}) };
}

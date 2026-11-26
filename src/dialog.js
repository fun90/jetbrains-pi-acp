// pi 扩展对话框转 ACP 表单时的文本整理。

// 选项依次以 "1. "、"2. "… 开头时去掉序号：ACP 表单的选项列表由客户端渲染，客户端会自行编号。
// 返回展示用选项；不满足条件或去掉后重复时返回原选项。
export function displayOptions(options) {
  const shown = options.map((option, index) => option.startsWith(`${index + 1}. `)
    ? option.slice(`${index + 1}. `.length).trimStart() : null);
  if (shown.some(option => !option) || new Set(shown).size !== shown.length) return options;
  return shown;
}

// 把 "--- 1. 标签 preview ---" 后的纯文本预览放进代码块，避免按 Markdown 渲染时丢失换行和缩进。
// 围栏比预览中最长的反引号串更长。
export function fencePreviews(title) {
  const [head, ...parts] = title.split(/\n\n--- (\d+\. .*?) preview ---\n/);
  let text = head;
  for (let index = 0; index < parts.length; index += 2) {
    const preview = parts[index + 1];
    const fence = '`'.repeat(Math.max(3, ...(preview.match(/`+/g) ?? []).map(run => run.length + 1)));
    text += `\n\n**${parts[index]}**\n\n${fence}text\n${preview}\n${fence}`;
  }
  return text;
}

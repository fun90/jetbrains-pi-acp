// 用法：node .github/release-notes.js vX.Y.Z
// 按 Conventional Commits 汇总上一个版本 tag 到指定 tag 之间的提交，输出 Markdown。
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const tag = process.argv[2];
if (!tag) throw new Error('缺少版本 tag 参数');

// 按版本号取当前提交历史中最近的上一个 tag；首次发布时没有，汇总全部历史。
const previous = git('tag', '--merged', tag, '--list', 'v[0-9]*', '--sort=-v:refname')
  .split(/\r?\n/).find(name => name && name !== tag);
const fields = git('log', '--no-merges', '-z', '--format=%h%x00%s%x00%b', previous ? `${previous}..${tag}` : tag, '--')
  .split('\0');

const sections = new Map(['破坏性变更', '新功能', '问题修复', '性能优化', '其他变更'].map(title => [title, []]));
const titles = { feat: '新功能', fix: '问题修复', perf: '性能优化' };

for (let i = 0; i + 2 < fields.length; i += 3) {
  const [hash, subject, body] = fields.slice(i, i + 3);
  const [, type, scope, bang, description = subject] = subject.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/) ?? [];
  if (type === 'chore' && scope === 'release') continue;
  const entry = `- ${scope ? `**${scope}**：` : ''}${description}（${hash}）`;
  // 破坏性说明从 BREAKING CHANGE: 起到空行为止，可跨多行。
  const breaking = body.replace(/\r\n/g, '\n').match(/^BREAKING[ -]CHANGE:\s*([\s\S]*?)(?=\n\s*\n|(?![\s\S]))/m)?.[1].trim();
  if (breaking || bang) {
    sections.get('破坏性变更').push(breaking ? `${entry}\n\n  ${breaking.replace(/\n/g, '\n  ')}` : entry);
    if (!titles[type]) continue;
  }
  sections.get(titles[type] ?? '其他变更').push(entry);
}

const output = [...sections].filter(([, entries]) => entries.length)
  .map(([title, entries]) => `## ${title}\n\n${entries.join('\n')}`);
const repository = process.env.GITHUB_REPOSITORY;
if (repository && previous) {
  output.push(`**完整对比**：https://github.com/${repository}/compare/${previous}...${tag}`);
}
console.log(output.join('\n\n'));

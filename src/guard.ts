// tenon guard：Codex 的 PreToolUse 钩子。只防 Agent 越级，不防篡改；看不懂的输入一律放行，免得把 Agent 卡死

// 命令位置上的 tenon（可带 npx / node / 路径前缀，或在 bash -c 里）后接人专属子命令。引号里的搜索词不算
const HUMAN_ONLY = /(?:^|[;&|(\n]|\b(?:ba|z|da)?sh\s+-\w*c\s+["']?)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:npx|pnpm|yarn|bunx|dlx|exec|command|env|sudo|node)\s+(?:-\S+\s+)*)*(?:\S*\/)?(?:tenon|cli\.[jt]s)\s+(approve|archive|review|evidence\s+confirm)\b/;
// apply_patch 补丁里的文件头；老模型会把补丁放进 shell heredoc，所以不看工具名，只看文本
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const PROTECTED = /(?:^|\/)\.(?:tenon|devflow)\/(?:specs\/|changes\/.*\/events\.jsonl$)/;

/** 要拒绝时返回原因，否则 null */
export function guardReason(input: unknown): string | null {
  const raw = (input as { tool_input?: { command?: unknown } } | null)?.tool_input?.command;
  // 官方文档没写 command 是脚本字符串还是参数数组，两种都接
  const command = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : '';
  const cmd = HUMAN_ONLY.exec(command);
  if (cmd) return `tenon ${cmd[1].replace(/\s+/, ' ')} 只能由人在自己的终端运行，不要代为执行；需要等人操作时运行 tenon wait <id>`;
  for (const m of command.matchAll(PATCH_FILE)) {
    if (PROTECTED.test(m[1].trim())) return `${m[1].trim()} 不能手改：specs/ 只能经 tenon archive 修改，events.jsonl 只能由 tenon 命令追加`;
  }
  return null;
}

/** 钩子入口：读标准输入的 JSON，拒绝时按 Codex 的 PreToolUse 格式输出。退出码恒为 0 */
export function guard(stdin: string): string {
  let reason: string | null = null;
  try { reason = guardReason(JSON.parse(stdin)); } catch { /* 输入损坏：放行 */ }
  return reason ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) : '';
}

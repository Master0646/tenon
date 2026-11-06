// devflow init / devflow new：只创建缺失的文件，不覆盖已有内容
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGE_ID, DF, DevflowError, changeDir, git, requireInit } from './core.ts';

const PROJECT_YAML = `schema_version: 1
# 只有这里声明的命令会被 devflow verify 执行。本文件由人维护，计入每次批准的哈希。
verify: []
#  - name: backend-test
#    run: mvn -q test
#    cwd: backend
exclude:            # 不得被知识页引用、不得出现在渲染页中
  - ".env*"
  - "**/*.pem"
  - "**/*.key"
  - "**/node_modules/**"
enforce: warn       # warn | strict：暂存了未开工变更的代码时，警告还是拒绝提交
`;

const SKELETON: Record<string, string> = {
  'project.yaml': PROJECT_YAML,
  'specs/specs.lock': '{}\n',
  'changes/archive/.gitkeep': '',
  'knowledge/index.md': '# 知识索引\n\n<!-- 每页一行：- [标题](pages/<slug>.md) — 一句话摘要 -->\n',
  'knowledge/log.md': '# 知识变更记录\n',
  'knowledge/pages/.gitkeep': '',
};

export const HOOK_MARK = '# devflow-hook';
const IGNORE_LINE = `${DF}/runtime/`;
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export interface InitResult {
  created: string[];
  hook: 'installed' | 'updated' | 'foreign';
  hookPath: string;
}

export function init(root: string): InitResult {
  const created: string[] = [];
  for (const [rel, content] of Object.entries(SKELETON)) {
    const f = join(root, DF, rel);
    if (existsSync(f)) continue;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
    created.push(`${DF}/${rel}`);
  }
  mkdirSync(join(root, DF, 'runtime'), { recursive: true });

  const gi = join(root, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!giText.split('\n').some((l) => l.trim() === IGNORE_LINE)) {
    appendFileSync(gi, `${giText && !giText.endsWith('\n') ? '\n' : ''}${IGNORE_LINE}\n`);
    created.push('.gitignore（追加 .devflow/runtime/）');
  }

  // core.hooksPath 设置时 --git-path 会返回那个目录
  const hookPath = join(resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']).trim()), 'pre-commit');
  const script = `#!/bin/sh\n${HOOK_MARK}\nexec ${shq(process.execPath)} ${shq(CLI)} check --staged\n`;
  let hook: InitResult['hook'] = 'installed';
  if (existsSync(hookPath)) {
    if (!readFileSync(hookPath, 'utf8').includes(HOOK_MARK)) return { created, hook: 'foreign', hookPath };
    hook = 'updated';
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
  return { created, hook, hookPath };
}

const CHANGE_FILES: Record<string, string> = {
  'change.yaml': `schema_version: 1
title: ""            # 一句话说明本变更
affected_paths: []   # 会改动的路径（glob），例如 backend/src/main/java/example/auth/**
`,
  'proposal.md': '# 提案\n\n## 为什么\n\n## 改什么\n\n## 影响\n',
  'design.md': '# 设计\n\n<!-- 图用 flow / sequence / tree 代码块直接写在这里 -->\n',
  'tasks.yaml': `schema_version: 1
tasks: []
# - id: T1
#   title: 定义角色与权限模型
#   acceptance: [UserRole 包含 ADMIN、USER]
#   depends_on: []
`,
  'specs/.gitkeep': '',
};

export function newChange(root: string, id: string | undefined): string[] {
  requireInit(root);
  if (!id || !CHANGE_ID.test(id) || id === 'archive') {
    throw new DevflowError(`变更 ID 无效：${id ?? '（缺失）'}`, '用小写字母、数字和连字符，例如 devflow new 2026-11-06-role-access');
  }
  const dir = changeDir(root, id);
  if (existsSync(dir)) throw new DevflowError(`变更已存在：${id}`);
  for (const [rel, content] of Object.entries(CHANGE_FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return Object.keys(CHANGE_FILES).map((f) => `${DF}/changes/${id}/${f}`);
}

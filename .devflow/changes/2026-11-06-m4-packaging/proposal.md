# 提案

## 为什么

DevFlow 目前只能在本仓库里用 `node src/cli.ts` 运行：

- 直接运行 TypeScript 依赖 Node 的类型剥离，而 Node 不会对 `node_modules` 里的 `.ts` 文件做类型剥离，所以 npm 安装后无法运行。
- 没有使用文档。新用户不知道安装步骤、命令顺序和人与 Agent 的分工。
- 没有自检命令。hook 指向的路径失效、Agent 文件是旧版本、没声明验证命令，这些问题只会在用到时才暴露。
- 随包附带的 answer-me-with-html 与依赖 yaml 的许可证没有集中列出。

## 改什么

1. **发行包**：新增 `pnpm build`，把 `src/` 编译成 `dist/`；`bin` 指向 `dist/cli.js`；`files` 只包含 `dist`、`templates`、`vendor`、`README.md`、`THIRD_PARTY_LICENSES.md`。开发时仍可直接运行 `node src/cli.ts`。
2. **`devflow --version`**：输出版本号。
3. **`devflow doctor`**：逐项检查并给出修复命令：Node 版本、git 可用、当前目录是 Git 仓库、已初始化、pre-commit hook 已安装且指向存在的 devflow、各 Agent 文件与当前版本的模板一致、`project.yaml` 声明了验证命令、`.gitignore` 忽略了 `.devflow/runtime/`。
4. **README.md**：安装、五分钟上手（init → propose → approve → apply → verify → archive）、命令表、人与 Agent 的分工、安全模型与已知限制。
5. **THIRD_PARTY_LICENSES.md**：yaml（ISC）、answer-me-with-html（MIT）、Bangers 字体（SIL OFL 1.1）。
6. **安装冒烟测试** `scripts/smoke-install.sh`：`npm pack` 后装进临时目录，在临时 Git 仓库里跑 `init`、`doctor`、`new`、`validate`、`render`、`status`。

## 影响

- `package.json` 的 `bin` 从 `src/cli.ts` 改为 `dist/cli.js`；已通过 `devflow init` 安装的 hook 写的是绝对路径，不受影响。
- 新增 `dist/` 目录，加入 `.gitignore`，不入库。
- Node 最低版本：发行包为 22（使用了 `path.matchesGlob`）；开发模式仍需 23.6 以上（类型剥离）。

## 不做什么

- 不发布到 npm registry，不推送；只保证 `npm pack` 得到的包可安装运行。
- 不做 `devflow run`（Codex SDK 无人值守执行）、Web UI、全文索引。
- 不修改 `.devflow/` 协议格式与已有命令的行为。
- 不为 devflow 本身选择开源许可证（`package.json` 保持 `private: true`），需要由你决定。

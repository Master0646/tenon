# 设计

## 构建

```flow LR
src/*.ts -> tsc -p tsconfig.build.json -> dist/*.js
dist/*.js -> npm pack -> devflow-0.1.0.tgz
templates -> npm pack
vendor -> npm pack
```

- 新增 `tsconfig.build.json`：继承 `tsconfig.json`，`noEmit: false`、`outDir: dist`、`rootDir: src`、`rewriteRelativeImportExtensions: true`，只编译 `src/`。已验证 TypeScript 7 会把 `./core.ts` 改写为 `./core.js`。
- `dist/` 与 `src/` 在同一层级，所以代码中 `new URL('../templates/', import.meta.url)`、`../vendor/...` 两种运行方式都能找到资源，无需改动。
- `package.json`：`version` 改为 `0.1.0`；`bin.devflow` 改为 `./dist/cli.js`；`files` 列出发布内容；`scripts.build`；`prepack` 先运行 build；`engines.node` 改为 `>=22`。
- 版本号：`cli.ts` 读取 `../package.json` 的 `version`，开发与发行两种方式都适用。

## doctor

```flow TB
(devflow doctor) -> 环境: Node 版本 / git
(devflow doctor) -> 仓库: Git 仓库 / 已 init
(devflow doctor) -> hook: 存在 / 带标记 / 指向的文件存在
(devflow doctor) -> Agent 文件: 与当前模板一致
(devflow doctor) -> project.yaml: 声明了 verify / runtime 已忽略
```

- 每项结果为 ok / warn / error，附修复命令，例如"运行 devflow update"。
- 有 error 时退出码为 1；只有 warn 时退出码为 0。
- 不在 Git 仓库里运行时，只检查环境项，并说明后续项被跳过，不直接报错退出。
- hook 检查：读取 pre-commit 文件，检查标记行，并解析 `exec` 行中的 CLI 路径是否存在。路径不存在时提示运行 `devflow init` 重新安装。
- Agent 文件检查：对 `detectAgents` 找到的每个 Agent，逐个比较技能文件与模板内容，以及入口文件托管段与模板内容；不一致时提示 `devflow update`。

## 冒烟测试

`scripts/smoke-install.sh`：

```sequence
脚本 -> npm: pnpm pack
脚本 -> 临时目录: npm install <tgz>
脚本 -> 临时仓库: devflow init / doctor / new / validate / render / status
临时仓库 --> 脚本: 任一步非零退出码即失败
```

- 新增的单元测试只覆盖 doctor 与 `--version`；冒烟测试需要网络安装 yaml，不放进 `pnpm test`。

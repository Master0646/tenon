#!/bin/sh
# 安装冒烟测试：打包 → 安装到临时目录 → 在临时 Git 仓库里跑主要命令。
# 需要网络（npm 安装依赖 yaml）。任一步失败即退出非零。
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
step() { printf '\n== %s\n' "$1"; }

step "打包"
cd "$ROOT"
npm pack --pack-destination "$WORK" >/dev/null
TGZ=$(ls "$WORK"/devflow-*.tgz)
echo "$TGZ"
# 包里必须有编译产物、模板、随包渲染器，不能有源码与测试
tar -tzf "$TGZ" > "$WORK/contents.txt"
for f in package/dist/cli.js package/templates/entry.md package/vendor/answer-me-with-html/am.mjs package/README.md package/THIRD_PARTY_LICENSES.md; do
  grep -qx "$f" "$WORK/contents.txt" || { echo "包中缺少 $f"; exit 1; }
done
if grep -qE '^package/(src|test|eval|examples)/' "$WORK/contents.txt"; then echo "包中不应包含源码、测试或演示项目"; exit 1; fi
echo "包内文件 $(wc -l < "$WORK/contents.txt" | tr -d ' ') 个"

step "安装到临时目录"
mkdir "$WORK/app"
cd "$WORK/app"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$TGZ" >/dev/null
BIN="$WORK/app/node_modules/.bin/devflow"
"$BIN" --version

step "在临时仓库中运行"
mkdir "$WORK/repo"
cd "$WORK/repo"
git init -q
git config user.name smoke
git config user.email smoke@example.invalid
echo hello > a.txt
git add -A
git commit -qm init --no-verify
"$BIN" init --agents claude,codex > /dev/null
grep -q "$WORK/app/node_modules/devflow/dist/cli.js" .git/hooks/pre-commit || { echo "hook 没有指向安装后的 dist/cli.js"; exit 1; }
"$BIN" doctor
"$BIN" new demo --schema 1 > /dev/null
B=.devflow/changes/demo
printf 'schema_version: 1\ntitle: 冒烟测试\naffected_paths: [a.txt]\n' > $B/change.yaml
printf '# 提案\n\n冒烟测试用的变更。\n' > $B/proposal.md
printf 'schema_version: 1\ntasks:\n  - id: T1\n    title: 改 a.txt\n' > $B/tasks.yaml
"$BIN" validate demo
"$BIN" render demo
"$BIN" status
git add -A
git commit -qm "devflow init + demo change"  # 走 hook：调用安装后的 devflow check
echo "提交成功（pre-commit hook 通过）"

step "全部通过"

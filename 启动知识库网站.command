#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1

# Finder may not inherit the PATH from an interactive terminal.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[错误] 请先安装 Node.js 22.13 或更高版本，然后重新双击此文件。"
  read -r -p "按回车键关闭窗口……"
  exit 1
fi

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'
if [ "$?" -ne 0 ]; then
  echo "[错误] Node.js 版本过低，需要 22.13 或更高版本。"
  read -r -p "按回车键关闭窗口……"
  exit 1
fi

node scripts/start-local.mjs
app_exit=$?
if [ "$app_exit" -ne 0 ]; then
  read -r -p "按回车键关闭窗口……"
fi
exit "$app_exit"

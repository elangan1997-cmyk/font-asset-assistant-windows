#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
EXTENSION_ID="com.liz.fontassetassistant.cep"
TARGET="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXTENSION_ID"
SOURCE="$SCRIPT_DIR/extension"

if [[ ! -f "$SOURCE/CSXS/manifest.xml" || ! -f "$SOURCE/scripts/ocr_macos.swift" ]]; then
  print -u2 "安装包不完整：缺少 CEP 清单或 macOS OCR 源码。"
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  print -u2 "未找到 swiftc。请先安装 Xcode Command Line Tools：xcode-select --install"
  exit 1
fi

print "正在编译 macOS Vision OCR…"
swiftc "$SOURCE/scripts/ocr_macos.swift" -framework Vision -framework ImageIO -O -o "$SOURCE/scripts/ocr_macos"
chmod 755 "$SOURCE/scripts/ocr_macos"

mkdir -p "$HOME/Library/Application Support/Adobe/CEP/extensions"
if [[ -e "$TARGET" ]]; then
  BACKUP="$HOME/Library/Application Support/Adobe/CEP/extensions/${EXTENSION_ID}.backup-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
  print "已保留旧版本备份：$BACKUP"
fi
ditto "$SOURCE" "$TARGET"
for version in {9..20}; do
  defaults write "com.adobe.CSXS.$version" PlayerDebugMode -string 1
done

print "macOS 插件安装完成：$TARGET"
print "请重启 Photoshop：窗口 → 扩展功能（旧版）→ 字体与素材助手"

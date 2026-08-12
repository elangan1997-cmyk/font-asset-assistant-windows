# `psd-image-text-rebuild` Skill / 字体与素材助手 Windows 插件

这是 Photoshop CEP 面板的 Windows 安装包。面板、JSX 和素材库逻辑与 macOS 版共用；Windows OCR 使用系统 Windows.Media.Ocr，通过 `extension/scripts/ocr.ps1` 调用。Windows 包不依赖 macOS Vision 或 Swift。

## 支持环境

- Windows 10/11
- Photoshop 2020 及以上（CEP/扩展功能〔旧版〕）
- Windows 设置中安装“中文（简体，中国）”OCR/语言包

## 安装

1. 解压本目录。
2. 双击 `install.cmd`；如果系统拦截，右键 `install.ps1` 选择 PowerShell 运行。
3. 重启 Photoshop。
4. 菜单：窗口 → 扩展功能（旧版）→ 字体与素材助手。

安装器会把面板复制到 `%APPDATA%\Adobe\CEP\extensions\com.liz.fontassetassistant.cep`，并为 CSXS.9–CSXS.20 设置未签名 CEP 所需的调试开关。已有同 ID 面板会先保留时间戳备份。

## 使用示例

打开测试图 `examples/T01_低机位斜切_内置模型.png`，优先点击“框选后识别”，只框选上半部标题和说明文字，避开下方滤材产品主体。识别后可统一选择字体，也可逐行设置字体、颜色和粗细；确认后重建，Photoshop 中会保留原图并新增可编辑文字层。

复杂背景使用“逐区域填充”；普通纯色背景可使用“一次合并填充”。包装、标签和产品本体上的字默认不要勾选重建。

## 常见问题

- OCR 失败：确认中文 OCR/语言包已安装，并允许 PowerShell 执行脚本。
- 面板不显示：确认 Photoshop 已重启，并检查 `窗口 → 扩展功能（旧版）`。
- 想恢复旧版：删除当前扩展目录，再把安装器生成的 `.backup-时间戳` 目录改回 `com.liz.fontassetassistant.cep`。

## 与 Harness Skill 联动

本包可配合 `psd-image-text-rebuild` Skill 使用。Skill 负责区域选择、包装文字排除、逐行擦除、字体/颜色参数和 PSD QA；插件负责 Photoshop 中的 OCR、文字层创建和保存。

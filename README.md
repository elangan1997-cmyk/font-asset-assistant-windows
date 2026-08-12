# 字体与素材助手 + `psd-image-text-rebuild` Skill

这是一个“Skill + Photoshop CEP 插件”的完整工作流，不是只提供一个独立脚本：

```text
psd-image-text-rebuild Skill
        ↓ 参数编排 / Agent 判断 / 缓存 / QA
字体与素材助手 CEP 插件
        ↓ Photoshop OCR / 擦除 / 可编辑文字层 / PSD 保存
Photoshop 分层 PSD
```

Skill 依赖同仓库的 `extension/` 插件。插件负责真正操作 Photoshop；Skill 负责告诉插件识别哪些区域、哪些文字不应处理、每行使用什么字体/颜色/字号，以及何时判定失败。

## 仓库内容

- `psd-image-text-rebuild/`：主 Skill（必需）
- `extension/`：Photoshop CEP 插件（Skill 的执行引擎）
- `install.cmd`、`install.ps1`：Windows 安装器
- `examples/T01_低机位斜切_内置模型.png`：测试图
- `README-Windows.md`：Windows 安装补充说明

## 一、先安装 Photoshop 插件

### Windows

1. 下载本仓库 ZIP 并解压。
2. 双击 `install.cmd`；或使用 PowerShell 运行 `install.ps1`。
3. 重启 Photoshop。
4. 菜单打开：`窗口 → 扩展功能（旧版）→ 字体与素材助手`。

安装位置：`%APPDATA%\Adobe\CEP\extensions\com.liz.fontassetassistant.cep`。安装器会设置 CSXS.9–CSXS.20 的 CEP 调试开关，并备份旧版本。

Windows OCR 使用 `extension/scripts/ocr.ps1` 调用 `Windows.Media.Ocr`，需要安装中文（简体，中国）OCR/语言包。

### macOS

本仓库的 `extension/` 与原 macOS 插件结构兼容。复制到：

```text
~/Library/Application Support/Adobe/CEP/extensions/com.liz.fontassetassistant.cep
```

macOS OCR 使用 `extension/scripts/ocr_macos`（Apple Vision）。若使用原始 Mac 安装包，运行其 `install.command` 即可。

## 二、Skill 安装

Windows 可运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-skill.ps1
```

macOS 可运行：

```bash
chmod +x install-skill.command
./install-skill.command
```

也可以手动将 `psd-image-text-rebuild/` 复制到 Codex Skills 目录：

```bash
cp -R psd-image-text-rebuild "$HOME/.codex/skills/psd-image-text-rebuild"
python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" \
  "$HOME/.codex/skills/psd-image-text-rebuild"
```

验证通过后，Skill 会在用户提出“把图片文字重建为 PSD 分层文字”“按原图字体颜色重建”等任务时触发。

## 三、完整使用流程

### 1. 打开原图并判断范围

在 Photoshop 打开 JPG/PNG/扁平 PSD。优先使用“框选后识别”，只框选画面叠加文案；产品包装、标签、瓶身和 Logo 内的字默认排除。

### 2. 运行 OCR

- 图片文字少、背景简单：可使用“直接识别”。
- 文字多、包含产品主体：使用“框选后识别”。
- 复杂背景、多行文字：每行单独处理，不使用大范围一次性填充。

### 3. Agent/人工复核分类

将识别结果分为：

- `scene_copy`：画面后期叠加的标题、正文、说明，可重建；
- `packaging_text`：包装、标签、瓶身、Logo 内文字，默认取消；
- `decorative_or_logo`：图形化字标，默认待确认；
- `uncertain`：无法判断的行，暂停处理。

### 4. 设置文字样式

先选择统一字体，再逐行调整：字体、字重、字号、颜色、基线和位置。禁止用横向拉伸代替字体匹配。颜色优先使用 OCR 的行级颜色；复杂渐变需人工校正。

### 5. 选择擦除方式

- 普通纯色/软渐变背景：可一次合并填充；
- 复杂纹理、主体附近或多行相邻：逐区域填充；
- 短文字位于描边框内：自动启用 `protectBorder`，保护边框；
- 出现产品穿插、白块、残字或边框断裂：立即停止自动扩大擦除范围，标记待人工修补。

### 6. 重建和保存

插件会保留原图，并生成：

```text
原图（保留）
OCR 清理背景（可隐藏）
OCR 可编辑文字
  ├── 每行独立文字层
  └── 每行独立颜色/字体/字号
```

## 四、macOS Harness 命令行流程

当前 Python Harness 的 Photoshop 自动化入口是 macOS AppleScript；Windows 端使用上面的 CEP 面板完成同样流程。

```bash
python3 psd-image-text-rebuild/scripts/run_rebuild_harness.py \
  --input "/path/to/image.png" \
  --output-dir "/path/to/output" \
  --mode region \
  --regions '[{"x":40,"y":35,"width":800,"height":530}]' \
  --erase-mode auto \
  --font-postscript SourceHanSansSC-Bold \
  --font-family 思源黑体 \
  --text-colors '["#081E4A","#222222","#118C92"]' \
  --line-scales '[1.0,0.92,0.92]' \
  --line-baselines '[0.92,0.80,0.78]' \
  --line-fonts '["SourceHanSansSC-Bold","SourceHanSansSC-Bold","SourceHanSansSC-Medium"]' \
  --fast \
  --preview
```

参数说明：

- `--mode region`：区域 OCR，减少计算量并避开包装；
- `--erase-mode auto`：按行数和背景风险自动选择擦除方式；
- `--fast`：缓存 OCR 和背景清理结果，重复调字体时更快；
- `--preview`：输出约 800px 的 `preview-fast.jpg`，先做快速 QA；
- `--plugin-root`：插件不在默认 CEP 目录时指定插件路径。

## 五、T01 测试示例

测试图：`examples/T01_低机位斜切_内置模型.png`

建议框选：`x=40, y=35, width=800, height=530`，包含上半部标题、说明和图标说明，避开下方滤材主体。

预期：标题和说明文字生成独立文字层；产品主体不被误擦；颜色大致保持深蓝、黑色、青绿色；PSD 可继续编辑。

## 六、验收与限制

每次都检查：内容、字体、字重、颜色、字号、基线、残字、白块、边框断裂、包装误擦和 PSD 图层结构。没有逐行视觉对比证据时，manifest 保持 `needs_review`，不得声称达到 90% 相似度。

Windows 端当前无法在 macOS 环境中启动 Windows Photoshop 做端到端验证；Windows 版需要在 Windows 10/11 + Photoshop 2020 以上实际安装测试。复杂纹理和主体遮挡背景可能仍需人工修补。

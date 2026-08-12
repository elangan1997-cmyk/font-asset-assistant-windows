# 字体与素材助手 Windows 版

Photoshop CEP 面板，支持 Windows 10/11、Photoshop 2020 及以上版本。可进行区域 OCR、逐行字体/颜色设置、复杂背景逐区域擦除、素材库管理，以及将图片文字重建为 Photoshop 可编辑文字图层。

## 下载与安装

1. 从 [Releases/仓库文件](https://github.com/elangan1997-cmyk/font-asset-assistant-windows) 下载 ZIP 并解压。
2. 双击 `install.cmd`。如果被系统拦截，可右键 `install.ps1`，选择使用 PowerShell 运行。
3. 重启 Photoshop。
4. 打开：`窗口 → 扩展功能（旧版）→ 字体与素材助手`。

安装器会复制到：

```text
%APPDATA%\Adobe\CEP\extensions\com.liz.fontassetassistant.cep
```

并设置 CSXS.9–CSXS.20 的 CEP 调试开关。已有同 ID 插件会先保留时间戳备份。

## OCR 使用方法

1. 在 Photoshop 中打开图片。
2. 需要减少计算量时，点击“框选后识别”，只框选需要识别的文案区域。
3. 需要整张扫描时，使用“直接识别”。
4. 识别后先取消包装、标签、瓶身和 Logo 内文字；这些内容默认不应被擦除或重建。
5. 可以统一选择字体，也可以逐行选择字体、粗细、颜色和大小。
6. 复杂背景选择“逐区域填充”；简单纯色背景可选择“一次合并填充”。
7. 确认后重建，PSD 会保留原图，并添加独立可编辑文字图层。

## 测试示例

仓库提供测试图：

```text
examples/T01_低机位斜切_内置模型.png
```

建议只框选图片上半部的标题、说明文字和图标说明，避开下半部滤材产品主体。预期结果是：

- 标题、说明和图标文字分别成为可编辑文字层；
- 原始背景图仍保留；
- 产品主体不被误擦；
- 每行可以单独调整字体、颜色和粗细。

## 与 PSD 重建 Skill 配合

`psd-image-text-rebuild/` 是配套 Harness Skill。它负责：

- 区域 OCR 和包装文字排除；
- 自动判断简单/复杂背景；
- 复杂背景逐行擦除和边框保护；
- 行级字体、颜色、字号、基线设置；
- 快速缓存模式和低分辨率预览；
- PSD 图层和 QA 清单输出。

重复测试同一张图时使用：

```bash
python3 psd-image-text-rebuild/scripts/run_rebuild_harness.py \
  --input /path/to/image.png \
  --output-dir /path/to/output \
  --mode region \
  --regions '[{"x":0,"y":0,"width":1000,"height":600}]' \
  --fast \
  --preview
```

`--fast` 会缓存 OCR 和局部背景清理结果；`--preview` 只生成约 800px 的快速检查图。确认预览没有残字、白块、边框断裂或产品误擦后，再检查完整 PSD。

## Windows OCR 依赖

- Windows 10/11；
- Photoshop 2020 或更高版本，并支持 CEP“扩展功能（旧版）”；
- Windows 设置中安装“中文（简体，中国）”语言/OCR 组件；
- PowerShell 可执行脚本。

Windows OCR 使用 `extension/scripts/ocr.ps1` 调用系统 `Windows.Media.Ocr`，图片不会上传到外部服务。

## 已知限制

- 当前环境为 macOS，无法在本机启动 Windows Photoshop 做端到端安装验证；Windows 端需实际安装测试。
- 图片无法可靠恢复原始字体文件、精确字距和混合模式，字体匹配属于近似重建。
- 复杂纹理、渐变、主体遮挡背景可能需要人工修补。
- 未经过逐行视觉对比时，manifest 会保留 `needs_review`，不会声称达到 90% 相似度。


---
name: psd-image-text-rebuild
description: Use when rebuilding visible image text into editable Photoshop text layers while preserving the original artwork and PSD structure. Supports plugin-driven direct or region-limited OCR, Agent classification of packaging versus scene copy, candidate font matching, per-line font/color/size/weight matching, 90% visual-similarity acceptance, iterative visual review, complex-background cleanup, and versioned PSD delivery.
---

# PSD 图片文字重建

## 目标

将用户提供的 JPG、PNG 或扁平 PSD 中的画面文字重建为可编辑 Photoshop 文字层，同时保留原图、画布尺寸、分辨率和原始 PSD。以原装 Photoshop CEP 插件为执行引擎，由 Harness 自动编排 OCR、区域分类、擦除方式、PSD 生成、预览检查和迭代；不把 OCR 结果或 Agent 推断当作事实。

## 必需依赖与平台

本 Skill 不是独立 OCR 程序，必须依赖同仓库的 Photoshop CEP 插件 `extension/`：插件负责 Photoshop 内的 OCR、文字层创建、背景处理和 PSD 保存，Skill 负责参数编排、区域/包装判断、逐行策略、缓存和 QA。

| 平台 | 插件 OCR | Skill Harness 自动编排 |
|---|---|---|
| macOS | `extension/scripts/ocr_macos`（Apple Vision） | 支持：`run_rebuild_harness.py` 通过 `osascript` 调用 Photoshop | 
| Windows | `extension/scripts/ocr.ps1`（Windows.Media.Ocr） | 面板流程支持；当前 Python Harness 的 Photoshop 自动调用仍需在 macOS 执行，Windows 上按面板手动完成同一流程 |

因此，Windows 用户必须先安装插件，再按“框选识别 → 排除包装文字 → 逐行设置 → 重建 → PSD QA”执行；不能只安装 Skill 就期待独立运行。

## Harness 执行入口

优先运行 `scripts/run_rebuild_harness.py`，它会调用原插件的 `ocr_macos` 和 `jsx/host.jsx`，生成版本化 PSD、任务清单和 manifest。示例：

```bash
python3 scripts/run_rebuild_harness.py \
  --input /path/to/input.png \
  --output-dir /path/to/output \
  --mode region \
  --regions '[{"x":0,"y":0,"width":941,"height":760}]' \
  --erase-mode auto
```

重复测试同一张图时加 `--fast`：会缓存 OCR 和局部背景清理结果，省掉重复计算；字体、颜色、字号参数变化仍会直接复用缓存并重新调用 Photoshop 生成 PSD。

快速检查时再加 `--preview`，Harness 只导出约 800px 的 `preview-fast.jpg`，先检查残字、白块、边框断裂和排版溢出；确认通过后才需要打开完整 PSD 做最终 QA。

Harness 必须：

1. 优先使用 `region` OCR，避开包装、瓶身、袋体和 Logo；无法确定时不得直接擦除。
2. 为每行保留文本、坐标、颜色、启用状态和分类结果。
3. 多行、相邻或纹理复杂区域选择原插件的 `individual`；普通背景才使用 `merged`。
4. 复杂背景逐条擦除使用窄边界（约 2–4px），禁止大范围内容识别填充吞掉边框；短文字行位于描边框/装饰线内时自动启用 `protectBorder`，扩大抗锯齿文字色域但裁掉线框边缘 mask。
5. 生成 PSD 后渲染预览，检查残字、白块、边框断裂、裁切、变形和包装误擦。
6. 发现问题时自动进入下一版本；没有通过视觉检查时保持 `needs_review`，不得交付为 final。
7. region OCR 识别到 3 行以上时，自动模式强制逐条处理，禁止合并选区。
7. 字体、字号、字重、颜色和排版综合相似度目标不得低于 90%；没有逐项对比证据时，默认视为未达标。
8. 只要预览出现主体穿插、白块、残字、边框断裂或背景纹理污染，立即判定失败；不得通过继续增加擦除范围掩盖问题。

## 必须遵守的边界

- 产品包装、标签、瓶身、袋体、Logo 内文字默认列为“待确认/排除”，不能擅自擦除或重建。
- 原图永远保留在 PSD 底层；输出新文件或新版本，不覆盖源文件。
- 不使用横向缩放拉伸字体；字体比例必须保持正常。
- 原字体名称无法从像素中可靠恢复；使用已安装字体候选、用户选择或逐行覆盖，并明确标注近似。
- 复杂背景擦除失败时标记“待人工修补”，不能声称已完全恢复。
- 每轮重建都渲染预览并进行视觉复核；至少保留初稿和最终稿。

## 工作流

### 1. 建立任务清单

先运行 `scripts/create_rebuild_job.py` 生成任务 JSON。记录源图、目标 PSD、识别模式、迭代次数、排除区域、文字行、字体/颜色设置、QA 状态和不确定性。不要直接覆盖用户文件。

### 2. 选择 OCR 范围

- `direct`：整张画布识别，适合文字少、背景简单的图片。
- `region`：先在插件预览中框选需要识别的区域，可多选；适合包装文字多或希望降低计算量的图片。

如果图片中有明显产品包装，优先使用 `region`。识别范围和包装排除范围不是同一概念：前者减少 OCR 扫描，后者用于识别后取消候选行。

### 3. OCR 与 Agent 分类

使用已安装的 Mac CEP 插件完成 OCR，获得文字内容、像素框和行级颜色估算。使用视觉 Agent（必要时调用 `luna-vision`）复核整张图和 OCR 框：

- `scene_copy`：画面后期叠加的标题、正文、说明文案，可进入重建。
- `packaging_text`：产品包装、标签、瓶身或 Logo 内文案，默认排除。
- `decorative_or_logo`：图形化字标、复杂变形字、装饰元素，默认待确认。
- `uncertain`：Agent 无法可靠判断的项目，交给用户选择。

保留每行的分类理由和置信度。低置信度项不能自动擦除。

分类还要记录背景策略：`ordinary_background`、`flat_label`、`textured_background`、`packaging_region`。`flat_label` 不得使用大范围内容识别填充；`packaging_region` 默认只保留原图，不建立替换层。

### 4. 字体、颜色和排版初稿

初始重建规则：

- 统一字体作为默认值，每行允许单独字体和字重覆盖。
- 优先使用 OCR 像素分析得到的行级颜色；颜色不可靠时回退到统一颜色，并标注 `color_estimated`。
- 字号按文字框高度和文档分辨率估算。
- 位置按 OCR 框坐标放置；保持原始分行，不自动拉伸字形。
- 复杂背景选择“逐区域填充”；简单背景才使用“一次合并填充”。

字体匹配必须采用候选搜索，而不是固定套用某个字体：

1. 根据像素结构先判断衬线/无衬线、中文黑体/宋体、字重和窄宽比例。
2. 从 Photoshop 已安装字体中筛选至少 3 个候选，分别生成低分辨率预览。
3. 按字形轮廓、笔画粗细、行宽、基线、字号和颜色逐项评分。
4. 只接受综合评分 ≥0.90 的候选；否则保留多个候选并标记 `needs_review`。
5. 严禁用横向缩放伪造相似度；字号、字重、字距和位置必须独立调整。

### 5. 生成 PSD 版本

建议图层结构：

```text
原图（保留，不修改）
OCR 清理背景（可隐藏/删除）
OCR 可编辑文字
  ├── 每行独立文字层
  └── 每行独立颜色和字体设置
```

版本命名使用 `rebuild_v01_ocr.psd`、`rebuild_v02_review.psd`、`rebuild_final.psd`。同时保存任务 JSON 和每轮 QA 结果。

### 6. 视觉反馈迭代

每轮至少检查：

1. 包装文字是否误入重建或被擦除。
2. 文字内容、分行、位置、字号、字重和颜色是否接近原图。
3. 是否出现字体横向变形、重复纹理、色块、接缝或背景采样污染。
4. PSD 是否保留原图、清理背景层和独立文字层。

根据反馈逐项调整，不要一次修改所有变量。优先顺序：分类/排除 → 文字内容 → 位置/字号 → 字体/字重 → 颜色 → 背景擦除。

### 7. Harness 自修正循环

每轮用独立版本运行：`v01_ocr` → `v02_cleanup` → `v03_typography` → `final`。自动检查失败时按错误类型修正：

- 白块、边框断裂、背景采样污染：缩小逐条选区，改为 `flat_label` 局部修补或暂停擦除。
- 文字下方存在主体、渐变或明显纹理变化：禁止使用全局内容识别填充；局部修复仍失败则停止自动擦除并输出 `needs_review`。
- 包装文字被擦除：回退到原图层，扩大排除区域，重新 region OCR。
- 标题裁切或溢出：根据实际字宽降低字号或调整位置，禁止横向压缩。
- 字体缺字或乱码：改用已安装的 PostScript 字体名，并以 Unicode 安全编码传入插件。
- 文字颜色不一致：优先使用插件返回的行级颜色，逐行覆盖统一颜色。

每轮必须保存预览和 JSON manifest；只有原图、清理背景和独立文字层都存在，且视觉检查通过，才可标记 `passed`。

### 8. 90% 相似度验收

对每一行文字分别记录以下分数（0–1）：

| 项目 | 权重 |
|---|---:|
| 字体家族/衬线结构 | 30% |
| 字重与笔画粗细 | 20% |
| 字号、行宽、基线和字距 | 25% |
| 颜色（含透明度/混合观感） | 15% |
| 位置和对齐 | 10% |

综合分数低于 0.90 时不得写入 `final`，必须继续换字体、调字号/字重/颜色或请求用户确认。相似度是视觉近似验收，不声称恢复了原始字体文件或原始设计参数。

## 可行性和不确定性

- 高可行：OCR 内容和位置、独立文字层、PSD 保存、区域限制 OCR。
- 中等可行：行级颜色估算、字号/基线/字重近似、复杂背景逐区域填充。
- 低可行：从图片恢复原始字体名称、精确字距/抗锯齿/混合模式、完全恢复复杂纹理背景。
- Agent 可以通过多轮渲染反馈逼近视觉效果，但不能恢复图片中不存在的原始设计参数。

## 交付要求

交付前必须提供：

- 最终 PSD 路径和版本号。
- 原图、清理背景、文字层是否保留的说明。
- 被排除的包装文字区域/行数。
- 仍需人工修补的背景区域。
- 字体和颜色的近似项。
- `待 QA` 或 `通过` 状态，不能把未复核结果称为完成。

## 工具与资源

- Photoshop CEP 插件：负责 OCR、字体选择、颜色、擦除和 PSD 重建。
- `luna-vision`：用于图像结构、包装区域和重建预览的视觉复核；OCR 文字本身仍需保留不确定性。
- `scripts/create_rebuild_job.py`：生成可追踪的重建任务 JSON。
- `scripts/validate_rebuild_job.py`：检查任务文件和源图是否可用。
- `scripts/run_rebuild_harness.py`：调用原插件 OCR/文字层 Host，编排区域识别、颜色覆盖、逐行参数、局部背景修复和 PSD 输出。
- `scripts/repair_text_background.py`：按 OCR 行颜色生成扩大遮罩并局部修复，避免 Photoshop 全局内容识别从主体区域采样。

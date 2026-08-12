(function () {
  "use strict";

  var MAX_FONT_OPTIONS = 180;
  var MAX_ASSETS = 120;
  var MAX_PREVIEWS = 48;
  var MAX_PREVIEW_BYTES = 6 * 1024 * 1024;
  var ROOT_KEY = "fontAssetAssistant.cep.assetRoot.v1";
  var TAB_KEY = "fontAssetAssistant.cep.activeTab.v1";
  var SUPPORTED = { png: true, jpg: true, jpeg: true, svg: true };

  var nodeRequire = null;
  var fs = null;
  var nodePath = null;
  var childProcess = null;
  try {
    nodeRequire = window.cep_node && window.cep_node.require ? window.cep_node.require : window.require;
    fs = nodeRequire("fs");
    nodePath = nodeRequire("path");
    childProcess = nodeRequire("child_process");
  } catch (nodeError) {
    console.error("CEP Node unavailable", nodeError);
  }

  var state = {
    activeTab: localStorage.getItem(TAB_KEY) || "fonts",
    busy: false,
    scan: null,
    ocr: null,
    targetFont: null,
    rootPath: localStorage.getItem(ROOT_KEY) || "",
    assets: [],
    categories: [],
    category: "全部",
    search: "",
    selectedAssetId: "",
    assetWarnings: [],
    unsupportedCount: 0,
    fontPickerLineIndex: null,
    excludeRects: [],
    excludeDrawing: null,
    pendingOCRExport: null,
    excludeMode: "exclude",
    toastTimer: null,
    previewGeneration: 0,
    lastReport: null
  };

  function byId(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function errorText(error, fallback) {
    return error && error.message ? error.message : fallback || "操作未完成";
  }

  function callHost(method, argument) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__ || !window.__adobe_cep__.evalScript) {
        reject(new Error("CEP 无法连接 Photoshop，请关闭面板后重新打开"));
        return;
      }
      var expression = "FontAssetAssistant." + method + "(";
      if (argument !== undefined) expression += JSON.stringify(argument);
      expression += ")";
      window.__adobe_cep__.evalScript(expression, function (raw) {
        if (!raw || raw === "EvalScript error.") {
          reject(new Error("Photoshop 脚本执行失败，请重新打开面板"));
          return;
        }
        try {
          var result = JSON.parse(raw);
          if (result && result.ok === false) reject(new Error(result.error || "Photoshop 未完成操作"));
          else resolve(result);
        } catch (parseError) {
          reject(new Error("Photoshop 返回了无法识别的结果"));
        }
      });
    });
  }

  function applyTheme() {
    try {
      var environment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
      var color = environment.appSkinInfo.panelBackgroundColor.color;
      var red = Math.round(color.red);
      var green = Math.round(color.green);
      var blue = Math.round(color.blue);
      var luminance = red * 0.299 + green * 0.587 + blue * 0.114;
      var dark = luminance < 150;
      var root = document.documentElement.style;
      root.setProperty("--bg", "rgb(" + red + "," + green + "," + blue + ")");
      root.setProperty("--text", dark ? "#f2f3f5" : "#202226");
      root.setProperty("--muted", dark ? "#aeb2ba" : "#5c6169");
      root.setProperty("--faint", dark ? "#777c85" : "#858a91");
      root.setProperty("--border", dark ? "#4b4f56" : "#b8bbc0");
      root.setProperty("--surface", dark ? "#34373c" : "#e5e6e8");
      root.setProperty("--hover", dark ? "#40444a" : "#d8dade");
    } catch (themeError) {
      console.error("Theme sync failed", themeError);
    }
  }

  function setRail(value) { byId("taskRail").setAttribute("data-state", value || "idle"); }

  function setBusy(value, rail) {
    state.busy = Boolean(value);
    if (rail) setRail(rail);
    var controls = document.querySelectorAll(".button, .icon-button");
    for (var index = 0; index < controls.length; index += 1) {
      controls[index].disabled = state.busy;
    }
    updateActions();
  }

  function toast(message, tone) {
    var target = byId("toast");
    target.textContent = message;
    target.className = "toast show " + (tone || "");
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { target.className = "toast"; }, 2800);
  }

  function switchTab(tab) {
    state.activeTab = tab === "assets" ? "assets" : "fonts";
    localStorage.setItem(TAB_KEY, state.activeTab);
    var tabs = document.querySelectorAll(".tab");
    for (var index = 0; index < tabs.length; index += 1) {
      tabs[index].classList.toggle("is-active", tabs[index].getAttribute("data-tab") === state.activeTab);
    }
    byId("fontPanel").classList.toggle("is-hidden", state.activeTab !== "fonts");
    byId("assetPanel").classList.toggle("is-hidden", state.activeTab !== "assets");
    updateActions();
  }

  function renderDocument() {
    var target = byId("documentStatus");
    if (!state.scan || !state.scan.document) {
      target.textContent = "未打开文档 · 操作已暂停";
      return;
    }
    target.textContent = state.scan.document.name + " · Photoshop 2020";
  }

  function normalizeOCRText(text) {
    return String(text || "")
      .replace(/[\r\n]+/g, " ")
      .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff，。！？；：、“”‘’（）《》])/g, "$1")
      .replace(/([，。！？；：、“”‘’（）《》])\s+(?=[\u3400-\u9fff])/g, "$1")
      .replace(/^\s+|\s+$/g, "");
  }

  function enabledOCRLines() {
    var lines = state.ocr ? state.ocr.lines : [];
    var enabled = [];
    for (var index = 0; index < lines.length; index += 1) {
      if (lines[index].enabled !== false && String(lines[index].text || "").replace(/^\s+|\s+$/g, "")) enabled.push(lines[index]);
    }
    return enabled;
  }

  function updateMappingText() {
    var count = enabledOCRLines().length;
    byId("mappingTitle").textContent = count ? "已选择 " + count + " 行文字" : "尚未识别文字";
    if (!count) byId("mappingMeta").textContent = "识别后选择字体并生成文字层";
    else if (!state.targetFont) byId("mappingMeta").textContent = "下一步：选择替换字体";
    else byId("mappingMeta").textContent = state.targetFont.familyName + " · " + state.targetFont.styleName;
  }

  function renderReport() {
    var target = byId("replaceReport");
    target.innerHTML = "";
    target.classList.toggle("is-hidden", !state.lastReport);
    if (!state.lastReport) return;
    var report = state.lastReport;
    target.className = "notice " + (report.failures.length ? "warning" : "success");
    target.appendChild(el("h3", "", "已生成 " + report.createdLayers + " 个可编辑文字图层"));
    var notes = el("ul");
    notes.appendChild(el("li", "", "已清理 " + report.cleanedRegions + " 处原文字区域"));
    if (report.contentAwareRegions) notes.appendChild(el("li", "", "所有文字区域合并后一次完成内容识别填充"));
    notes.appendChild(el("li", "", "原图保留在清理背景图层下方，可随时恢复"));
    if (report.eraseModeUsed) notes.appendChild(el("li", "", "背景判断：" + (report.backgroundComplexity === "complex" ? "复杂背景，逐区域填充" : report.backgroundComplexity === "ordinary" ? "普通背景，合并填充" : report.eraseModeUsed)));
    if (report.failures.length) notes.appendChild(el("li", "", report.failures.length + " 项处理未完成"));
    target.appendChild(notes);
  }

  function renderOCR() {
    var list = byId("ocrList");
    var lines = state.ocr ? state.ocr.lines : [];
    list.innerHTML = "";
    byId("ocrCount").textContent = lines.length ? String(lines.length) : "—";
    byId("ocrEmpty").classList.toggle("is-hidden", lines.length > 0);
    byId("ocrSettings").classList.toggle("is-hidden", lines.length === 0);
    if (!lines.length) {
      byId("ocrSummary").textContent = state.scan && state.scan.document ? "当前图片尚未识别" : "请先打开一张图片";
      updateActions();
      return;
    }
    byId("ocrSummary").innerHTML = "<strong>识别到 " + lines.length + " 行文字</strong> · 请先校对，再选择新字体";
    for (var index = 0; index < lines.length; index += 1) {
      (function (line, lineIndex) {
        var row = el("article", "ocr-row");
        var toggle = el("input", "ocr-toggle");
        toggle.type = "checkbox";
        toggle.checked = line.enabled !== false;
        toggle.addEventListener("change", function () { line.enabled = toggle.checked; row.classList.toggle("disabled", !toggle.checked); updateActions(); });
        row.appendChild(toggle);
        var body = el("div", "ocr-copy");
        var input = el("input", "ocr-input");
        input.type = "text";
        input.value = line.text;
        input.addEventListener("input", function () { line.text = normalizeOCRText(input.value); updateActions(); });
        body.appendChild(input);
        body.appendChild(el("span", "ocr-meta", Math.round(line.x) + ", " + Math.round(line.y) + " · " + Math.round(line.width) + "×" + Math.round(line.height) + " px"));
        var lineFont = line.targetFont || state.targetFont;
        var lineFontButton = el("button", "ocr-font-button", lineFont ? "字体：" + lineFont.familyName + " · " + lineFont.styleName : "单独选择字体");
        lineFontButton.type = "button";
        lineFontButton.addEventListener("click", function () { openFontPicker(lineIndex); });
        body.appendChild(lineFontButton);
        if (line.textColor || line.color) {
          var lineColor = line.textColor || line.color;
          var colorSwatch = el("i", "ocr-color-swatch");
          colorSwatch.style.backgroundColor = lineColor;
          colorSwatch.title = "识别颜色 " + lineColor;
          body.appendChild(colorSwatch);
        }
        row.appendChild(body);
        list.appendChild(row);
      })(lines[index], index);
    }
    var fontButton = byId("selectOcrFont");
    fontButton.textContent = state.targetFont ? state.targetFont.familyName + " · " + state.targetFont.styleName : "选择新字体";
    fontButton.classList.toggle("has-target", Boolean(state.targetFont));
    renderReport();
    updateActions();
  }

  function excludeCanvasPoint(event) {
    var canvas = byId("excludeCanvas");
    var rect = canvas.getBoundingClientRect();
    var scaleX = canvas.width / rect.width;
    var scaleY = canvas.height / rect.height;
    return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * scaleX)), y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * scaleY)) };
  }

  function drawExcludeRects() {
    var canvas = byId("excludeCanvas");
    if (!canvas.width || !canvas.height) return;
    var context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(239,106,117,.22)";
    context.strokeStyle = "#ef6a75";
    context.lineWidth = Math.max(2, canvas.width / 700);
    for (var index = 0; index < state.excludeRects.length; index += 1) {
      var rect = state.excludeRects[index];
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }
    if (state.excludeDrawing) {
      var drawing = state.excludeDrawing;
      context.fillStyle = "rgba(239,106,117,.28)";
      context.fillRect(drawing.x, drawing.y, drawing.width, drawing.height);
      context.strokeRect(drawing.x, drawing.y, drawing.width, drawing.height);
    }
  }

  function openExcludePicker(mode) {
    var imagePath = state.ocr && state.ocr.imagePath ? state.ocr.imagePath : state.pendingOCRExport && state.pendingOCRExport.imagePath;
    if (!imagePath) { toast("请先导出图片", "error"); return; }
    state.excludeMode = mode || "exclude";
    var image = byId("excludeImage");
    var canvas = byId("excludeCanvas");
    image.onload = function () {
      var maxWidth = Math.max(300, Math.min(700, byId("excludeViewport").clientWidth || 700));
      var maxHeight = Math.max(300, window.innerHeight - 190);
      var scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
      var width = Math.round(image.naturalWidth * scale);
      var height = Math.round(image.naturalHeight * scale);
      image.style.width = width + "px";
      image.style.height = height + "px";
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      byId("excludeViewport").style.width = width + "px";
      byId("excludeViewport").style.height = height + "px";
      drawExcludeRects();
    };
    byId("pickerTitle");
    byId("excludePicker").querySelector("h2").textContent = state.excludeMode === "recognize" ? "框选需要识别的区域" : "框选忽略区域";
    byId("excludePicker").querySelector(".exclude-help").textContent = state.excludeMode === "recognize" ? "只扫描框选区域，可减少 OCR 计算量；可框选多个区域。" : "拖动框选产品包装区域；框内识别文字会被取消，不参与擦除和重建。";
    byId("applyExcludeRects").textContent = state.excludeMode === "recognize" ? "开始识别选中区域" : "应用忽略区域";
    image.src = "file://" + encodeURI(imagePath);
    byId("excludePicker").classList.remove("is-hidden");
  }

  function applyExcludeRects() {
    if (state.excludeMode === "recognize") {
      var exportResult = state.pendingOCRExport;
      if (!exportResult) return;
      byId("excludePicker").classList.add("is-hidden");
      performOCR(exportResult, state.excludeRects);
      return;
    }
    if (!state.ocr) return;
    var lines = state.ocr.lines || [];
    var excluded = 0;
    for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      var line = lines[lineIndex];
      if (line.excluded) line.enabled = true;
      line.excluded = false;
      var centerX = Number(line.x) + Number(line.width) / 2;
      var centerY = Number(line.y) + Number(line.height) / 2;
      for (var rectIndex = 0; rectIndex < state.excludeRects.length; rectIndex += 1) {
        var rect = state.excludeRects[rectIndex];
        if (centerX >= rect.x && centerX <= rect.x + rect.width && centerY >= rect.y && centerY <= rect.y + rect.height) {
          line.enabled = false;
          line.excluded = true;
          excluded += 1;
          break;
        }
      }
    }
    byId("excludePicker").classList.add("is-hidden");
    renderOCR();
    toast(excluded ? "已忽略 " + excluded + " 行包装文字" : "框选区域内没有识别文字", excluded ? "success" : "");
  }

  function extensionRoot() {
    var pathValue = window.__adobe_cep__.getSystemPath("extension");
    try {
      pathValue = decodeURI(pathValue);
      pathValue = pathValue.replace(/^file:\/\/\/?/i, "");
      if (/^\/[A-Za-z]:/.test(pathValue)) pathValue = pathValue.substr(1);
      return pathValue;
    } catch (decodeError) { return pathValue; }
  }

  function runMacOCR(imagePath, regions) {
    return new Promise(function (resolve, reject) {
      if (!childProcess || !nodePath) { reject(new Error("插件无法启动 macOS Vision OCR")); return; }
      var helperPath = nodePath.join(extensionRoot(), "scripts", "ocr_macos");
      var args = [imagePath];
      if (regions && regions.length) args.push(JSON.stringify(regions));
      childProcess.execFile(helperPath, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, function (error, stdout, stderr) {
        var raw = String(stdout || "").replace(/^\uFEFF/, "").trim();
        var result = null;
        try { result = JSON.parse(raw); } catch (parseError) {}
        if (!result || result.ok === false) {
          var detail = result && result.error ? result.error : String(stderr || "").trim();
          reject(new Error(detail || errorText(error, "macOS Vision OCR 没有返回结果")));
          return;
        }
        resolve(result);
      });
    });
  }

  function runWindowsOCR(imagePath) {
    return new Promise(function (resolve, reject) {
      if (!childProcess || !nodePath) { reject(new Error("插件无法启动 Windows 离线 OCR")); return; }
      var scriptPath = nodePath.join(extensionRoot(), "scripts", "ocr.ps1");
      childProcess.execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ImagePath", imagePath, "-Language", "zh-Hans-CN"], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, function (error, stdout) {
        var raw = String(stdout || "").replace(/^\uFEFF/, "").trim();
        var result = null;
        try { result = JSON.parse(raw); } catch (parseError) {}
        if (!result || result.ok === false) { reject(new Error(result && result.error ? result.error : errorText(error, "Windows OCR 没有返回结果"))); return; }
        resolve(result);
      });
    });
  }

  function runOCR(imagePath, regions) {
    if (typeof process !== "undefined" && process.platform === "darwin") return runMacOCR(imagePath, regions);
    return runWindowsOCR(imagePath);
  }

  function refreshHost() {
    return callHost("scanDocument").then(function (result) {
      state.scan = result;
      renderDocument();
      if (!result.document) state.ocr = null;
      renderOCR();
      setRail(result.document ? "ready" : "idle");
      return result;
    });
  }

  function performOCR(exportResult, regions) {
    state.pendingOCRExport = null;
    setBusy(true, "scan");
    byId("ocrSummary").textContent = regions && regions.length ? "正在扫描框选区域并识别文字…" : "正在识别文字…";
    runOCR(exportResult.imagePath, regions).then(function (ocrResult) {
      var lines = ocrResult.lines || [];
      for (var index = 0; index < lines.length; index += 1) {
        lines[index].text = normalizeOCRText(lines[index].text);
        lines[index].textColor = lines[index].color || "";
        lines[index].enabled = true;
      }
      state.ocr = { document: exportResult.document, imagePath: exportResult.imagePath, angle: ocrResult.angle || 0, lines: lines };
      renderOCR();
      setRail(lines.length ? "success" : "ready");
      toast(lines.length ? "已识别 " + lines.length + " 行文字" : "框选区域中没有识别到文字", lines.length ? "success" : "");
    }).catch(function (error) {
      setRail("error");
      byId("ocrSummary").textContent = "识别失败，请检查图片后重试";
      toast(errorText(error, "图片文字识别失败"), "error");
    }).then(function () { setBusy(false); });
  }

  function recognizeCanvas() {
    if (!state.pendingOCRExport) {
      setBusy(true, "scan");
      state.excludeRects = [];
      state.excludeDrawing = null;
      state.lastReport = null;
      renderReport();
      byId("ocrSummary").textContent = "正在导出画布，请框选需要识别的区域…";
      callHost("exportCanvasForOCR").then(function (exportResult) {
        state.pendingOCRExport = exportResult;
        state.scan = { document: exportResult.document, fonts: exportResult.fonts || [] };
        renderDocument();
        setBusy(false);
        openExcludePicker("recognize");
      }).catch(function (error) {
        setRail("error");
        toast(errorText(error, "无法导出当前画布"), "error");
        setBusy(false);
      });
      return;
    }
    openExcludePicker("recognize");
  }

  function recognizeCanvasDirect() {
    if (state.pendingOCRExport) { performOCR(state.pendingOCRExport, []); return; }
    setBusy(true, "scan");
    state.excludeRects = [];
    state.excludeDrawing = null;
    state.lastReport = null;
    renderReport();
    byId("ocrSummary").textContent = "正在导出画布并直接识别文字…";
    callHost("exportCanvasForOCR").then(function (exportResult) {
      state.scan = { document: exportResult.document, fonts: exportResult.fonts || [] };
      renderDocument();
      performOCR(exportResult, []);
    }).catch(function (error) {
      setRail("error");
      toast(errorText(error, "无法导出当前画布"), "error");
      setBusy(false);
    });
  }

  function openFontPicker(lineIndex) {
    if (!state.scan || !state.scan.fonts || !state.scan.fonts.length) { toast("没有读取到已安装字体", "error"); return; }
    state.fontPickerLineIndex = typeof lineIndex === "number" ? lineIndex : null;
    byId("pickerTitle").textContent = state.fontPickerLineIndex === null ? "选择统一字体" : "选择这一行的字体";
    byId("fontSearch").value = "";
    renderFontOptions();
    byId("fontPicker").classList.remove("is-hidden");
    byId("fontSearch").focus();
  }

  function closeFontPicker() { byId("fontPicker").classList.add("is-hidden"); }

  function renderFontOptions() {
    var query = byId("fontSearch").value.trim().toLowerCase();
    var fonts = state.scan && state.scan.fonts ? state.scan.fonts : [];
    var filtered = [];
    for (var index = 0; index < fonts.length; index += 1) {
      var font = fonts[index];
      if ((font.familyName + " " + font.styleName + " " + font.postScriptName).toLowerCase().indexOf(query) !== -1) filtered.push(font);
    }
    var list = byId("fontOptions");
    list.innerHTML = "";
    for (index = 0; index < Math.min(filtered.length, MAX_FONT_OPTIONS); index += 1) {
      (function (font) {
        var button = el("button", "font-option");
        button.type = "button";
        var copy = el("div");
        copy.appendChild(el("strong", "", font.familyName));
        copy.appendChild(el("span", "", font.styleName));
        button.appendChild(copy);
        button.appendChild(el("code", "", font.postScriptName));
        button.addEventListener("click", function () {
          if (state.fontPickerLineIndex === null) {
            state.targetFont = font;
            for (var lineIndex = 0; state.ocr && lineIndex < state.ocr.lines.length; lineIndex += 1) state.ocr.lines[lineIndex].targetFont = null;
          } else if (state.ocr && state.ocr.lines[state.fontPickerLineIndex]) {
            state.ocr.lines[state.fontPickerLineIndex].targetFont = font;
          }
          closeFontPicker();
          renderOCR();
        });
        list.appendChild(button);
      })(filtered[index]);
    }
    if (!filtered.length) list.appendChild(el("div", "grid-message", "没有匹配的字体"));
    byId("fontOptionMeta").textContent = filtered.length > MAX_FONT_OPTIONS ? "找到 " + filtered.length + " 款，仅显示前 " + MAX_FONT_OPTIONS + " 款" : filtered.length + " 款可用字体";
  }

  function rebuildOCRText() {
    var lines = enabledOCRLines();
    if (!state.ocr || !lines.length) return;
    var missingFont = false;
    for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (!lines[lineIndex].targetFont && !state.targetFont) { missingFont = true; break; }
    }
    if (missingFont) {
      openFontPicker();
      toast("请先选择用于重建的字体", "");
      return;
    }
    setBusy(true, "working");
    var payload = JSON.stringify({
      documentId: state.ocr.document.id,
      lines: lines,
      targetFont: state.targetFont,
      eraseOriginal: byId("eraseOriginal").checked,
      // Narrow expansion for per-line complex-background cleanup; keep the
      // wider margin only for merged fills on ordinary backgrounds.
      eraseMargin: (byId("eraseMode").value || "merged") === "individual" ? 0.08 : 0.24,
      fontScale: Number(byId("fontScale").value || 1),
      textColor: byId("textColor").value || "#151515",
      eraseMode: byId("eraseMode").value || "merged"
    });
    callHost("rebuildOCRText", payload).then(function (result) {
      state.lastReport = result;
      renderReport();
      setRail(result.failures.length ? "ready" : "success");
      toast("已生成 " + result.createdLayers + " 个可编辑文字图层", result.failures.length ? "" : "success");
      return refreshHost();
    }).catch(function (error) {
      setRail("error");
      toast(errorText(error, "OCR 文字重建失败"), "error");
    }).then(function () { setBusy(false); });
  }

  function normalizeHexColor(value) {
    var text = String(value || "").replace(/\s+/g, "").toUpperCase();
    if (text.charAt(0) !== "#") text = "#" + text;
    if (/^#[0-9A-F]{3}$/.test(text)) text = "#" + text.charAt(1) + text.charAt(1) + text.charAt(2) + text.charAt(2) + text.charAt(3) + text.charAt(3);
    return /^#[0-9A-F]{6}$/.test(text) ? text : "";
  }

  function updateColorPreview(commit) {
    var input = byId("textColor");
    var color = normalizeHexColor(input.value);
    if (!color) {
      input.classList.add("invalid");
      return false;
    }
    input.classList.remove("invalid");
    if (commit) input.value = color;
    byId("textColorPreview").style.backgroundColor = color;
    return true;
  }

  function useForegroundColor() {
    callHost("getForegroundColor").then(function (result) {
      byId("textColor").value = result.hex;
      updateColorPreview(true);
      toast("已读取 Photoshop 前景色 " + result.hex, "success");
    }).catch(function (error) { toast(errorText(error, "无法读取 Photoshop 前景色"), "error"); });
  }

  function extension(name) {
    var dot = name.lastIndexOf(".");
    return dot > -1 ? name.slice(dot + 1).toLowerCase() : "";
  }

  function scanAssetDirectory(rootPath) {
    if (!fs || !nodePath) throw new Error("CEP 本地文件模块不可用，请重新安装插件");
    var assets = [];
    var warnings = [];
    var unsupported = 0;
    var visited = {};

    function walk(folder, relativeParts) {
      var real;
      try { real = fs.realpathSync(folder).toLowerCase(); } catch (realError) { real = folder.toLowerCase(); }
      if (visited[real]) return;
      visited[real] = true;
      var names;
      try { names = fs.readdirSync(folder); }
      catch (readError) { warnings.push((relativeParts.join("/") || "根目录") + "：无法读取"); return; }
      names.sort(function (a, b) { return a.localeCompare(b, "zh-CN"); });
      for (var index = 0; index < names.length; index += 1) {
        if (names[index].charAt(0) === ".") continue;
        var fullPath = nodePath.join(folder, names[index]);
        var stat;
        try { stat = fs.statSync(fullPath); } catch (statError) { warnings.push(names[index] + "：无法读取文件信息"); continue; }
        if (stat.isDirectory()) { walk(fullPath, relativeParts.concat(names[index])); continue; }
        if (!stat.isFile()) continue;
        var ext = extension(names[index]);
        if (!SUPPORTED[ext]) { unsupported += 1; continue; }
        var relative = relativeParts.concat(names[index]).join("/");
        assets.push({
          id: relative,
          name: names[index],
          extension: ext,
          category: relativeParts.length ? relativeParts.join("/") : "根目录",
          path: fullPath,
          size: stat.size,
          preview: ""
        });
      }
    }

    walk(rootPath, []);
    var categoryMap = {};
    for (var index = 0; index < assets.length; index += 1) categoryMap["cat:" + assets[index].category] = assets[index].category;
    var categories = [];
    for (var key in categoryMap) if (categoryMap.hasOwnProperty(key)) categories.push(categoryMap[key]);
    categories.sort(function (a, b) { return a.localeCompare(b, "zh-CN"); });
    return { assets: assets, categories: categories, warnings: warnings, unsupported: unsupported };
  }

  function loadAssets(announce) {
    if (!state.rootPath) { renderAssets(); return Promise.resolve(); }
    if (!fs || !fs.existsSync(state.rootPath)) {
      localStorage.removeItem(ROOT_KEY);
      state.rootPath = "";
      state.assets = [];
      renderAssets();
      toast("素材目录已经移动或删除，请重新选择", "error");
      return Promise.resolve();
    }
    setBusy(true, "scan");
    return new Promise(function (resolve) {
      setTimeout(function () {
        try {
          var result = scanAssetDirectory(state.rootPath);
          state.assets = result.assets;
          state.categories = result.categories;
          state.assetWarnings = result.warnings;
          state.unsupportedCount = result.unsupported;
          state.selectedAssetId = "";
          if (state.category !== "全部" && state.categories.indexOf(state.category) === -1) state.category = "全部";
          renderAssets();
          setRail("ready");
          if (announce) toast("已读取 " + state.assets.length + " 个素材", "success");
        } catch (error) {
          setRail("error");
          toast(errorText(error, "素材目录读取失败"), "error");
        }
        setBusy(false);
        resolve();
      }, 30);
    });
  }

  function chooseFolder() {
    setBusy(true, "working");
    callHost("selectAssetFolder").then(function (result) {
      if (result.cancelled) return;
      state.rootPath = result.path;
      localStorage.setItem(ROOT_KEY, state.rootPath);
      state.category = "全部";
      return loadAssets(true);
    }).catch(function (error) {
      setRail("error");
      toast(errorText(error, "无法选择目录"), "error");
    }).then(function () { setBusy(false); });
  }

  function filteredAssets() {
    var query = state.search.toLowerCase();
    var result = [];
    for (var index = 0; index < state.assets.length; index += 1) {
      var asset = state.assets[index];
      if (state.category !== "全部" && asset.category !== state.category) continue;
      if (query && asset.name.toLowerCase().indexOf(query) === -1) continue;
      result.push(asset);
    }
    return result;
  }

  function selectedAsset() {
    for (var index = 0; index < state.assets.length; index += 1) if (state.assets[index].id === state.selectedAssetId) return state.assets[index];
    return null;
  }

  function renderCategories() {
    var select = byId("categorySelect");
    select.innerHTML = "";
    var values = ["全部"].concat(state.categories);
    for (var index = 0; index < values.length; index += 1) {
      var option = el("option", "", values[index]);
      option.value = values[index];
      select.appendChild(option);
    }
    select.value = state.category;
  }

  function dataUrl(asset) {
    if (asset.preview) return asset.preview;
    if (!fs || asset.size > MAX_PREVIEW_BYTES) return "";
    var mime = asset.extension === "jpg" || asset.extension === "jpeg" ? "image/jpeg" : asset.extension === "svg" ? "image/svg+xml" : "image/png";
    asset.preview = "data:" + mime + ";base64," + fs.readFileSync(asset.path).toString("base64");
    return asset.preview;
  }

  function hydratePreviews(assets) {
    var generation = ++state.previewGeneration;
    var index = 0;
    function next() {
      if (generation !== state.previewGeneration || index >= assets.length) return;
      var asset = assets[index++];
      var targets = document.querySelectorAll("[data-preview]");
      var target = null;
      for (var nodeIndex = 0; nodeIndex < targets.length; nodeIndex += 1) if (targets[nodeIndex].getAttribute("data-preview") === asset.id) target = targets[nodeIndex];
      if (target) {
        try {
          var url = dataUrl(asset);
          if (url) {
            target.innerHTML = "";
            var image = el("img");
            image.src = url;
            image.alt = "";
            image.onerror = function () { target.textContent = asset.extension.toUpperCase(); };
            target.appendChild(image);
          } else if (asset.size > MAX_PREVIEW_BYTES) target.textContent = "大文件";
        } catch (previewError) { target.textContent = asset.extension.toUpperCase(); }
      }
      setTimeout(next, 0);
    }
    next();
  }

  function selectAsset(id) {
    state.selectedAssetId = id;
    var cards = document.querySelectorAll(".asset-card");
    for (var index = 0; index < cards.length; index += 1) cards[index].classList.toggle("selected", cards[index].getAttribute("data-id") === id);
    renderSelectedAsset();
  }

  function renderSelectedAsset() {
    var asset = selectedAsset();
    byId("selectedName").textContent = asset ? asset.name : "未选择素材";
    byId("selectedMeta").textContent = asset ? asset.category + " · " + asset.extension.toUpperCase() + " · 智能对象" : "单击选择，双击直接置入";
    updateActions();
  }

  function renderAssetNotice() {
    var target = byId("assetNotice");
    target.innerHTML = "";
    var notes = state.assetWarnings.slice();
    if (state.unsupportedCount) notes.unshift("已忽略 " + state.unsupportedCount + " 个不支持的文件");
    target.classList.toggle("is-hidden", !notes.length);
    if (!notes.length) return;
    target.className = "notice warning";
    target.appendChild(el("h3", "", "素材目录有部分提示"));
    var list = el("ul");
    for (var index = 0; index < Math.min(notes.length, 8); index += 1) list.appendChild(el("li", "", notes[index]));
    target.appendChild(list);
  }

  function renderAssets() {
    var hasRoot = Boolean(state.rootPath && fs && fs.existsSync(state.rootPath));
    byId("rootBar").classList.toggle("is-hidden", !hasRoot);
    byId("assetTools").classList.toggle("is-hidden", !hasRoot);
    byId("assetEmpty").classList.toggle("is-hidden", hasRoot);
    byId("assetCount").textContent = state.assets.length ? String(state.assets.length) : "—";
    if (!hasRoot) { byId("assetGrid").innerHTML = ""; updateActions(); return; }
    byId("rootName").textContent = nodePath.basename(state.rootPath);
    byId("rootMeta").textContent = state.assets.length + " 个素材 · " + state.categories.length + " 个分类";
    renderCategories();

    var filtered = filteredAssets();
    var visible = filtered.slice(0, MAX_ASSETS);
    var grid = byId("assetGrid");
    grid.innerHTML = "";
    for (var index = 0; index < visible.length; index += 1) {
      (function (asset) {
        var card = el("button", "asset-card" + (asset.id === state.selectedAssetId ? " selected" : ""));
        card.type = "button";
        card.setAttribute("data-id", asset.id);
        card.title = asset.name + "\n" + asset.category;
        var preview = el("div", "preview", asset.extension.toUpperCase());
        preview.setAttribute("data-preview", asset.id);
        card.appendChild(preview);
        var copy = el("div", "asset-copy");
        copy.appendChild(el("strong", "", asset.name));
        copy.appendChild(el("span", "", asset.extension));
        card.appendChild(copy);
        card.addEventListener("click", function () { selectAsset(asset.id); });
        card.addEventListener("dblclick", function () { selectAsset(asset.id); placeAsset(); });
        grid.appendChild(card);
      })(visible[index]);
    }
    if (!visible.length) grid.appendChild(el("div", "grid-message", "没有匹配的素材，试试其他分类或搜索词。"));
    if (filtered.length > MAX_ASSETS) grid.appendChild(el("div", "grid-message", "共 " + filtered.length + " 个结果，仅显示前 " + MAX_ASSETS + " 个"));
    hydratePreviews(visible.slice(0, MAX_PREVIEWS));
    renderSelectedAsset();
    renderAssetNotice();
  }

  function placeAsset() {
    var asset = selectedAsset();
    if (!asset) return;
    setBusy(true, "working");
    callHost("placeAsset", asset.path).then(function (result) {
      setRail("success");
      toast("已置入智能对象「" + result.layerName + "」", "success");
    }).catch(function (error) {
      setRail("error");
      toast(errorText(error, "素材置入失败"), "error");
    }).then(function () { setBusy(false); });
  }

  function updateActions() {
    var hasOCRLines = Boolean(state.ocr && enabledOCRLines().length);
    byId("replaceButton").disabled = state.busy || !hasOCRLines;
    byId("replaceButton").textContent = hasOCRLines && !state.targetFont ? "先选择字体" : "擦除并重建";
    byId("placeButton").disabled = state.busy || !state.scan || !state.scan.document || !selectedAsset();
    updateMappingText();
  }

  function refresh() {
    if (state.activeTab === "fonts") refreshHost();
    else {
      refreshHost().then(function () { loadAssets(true); });
    }
  }

  function bind() {
    var tabs = document.querySelectorAll(".tab");
    for (var index = 0; index < tabs.length; index += 1) {
      tabs[index].addEventListener("click", function () { switchTab(this.getAttribute("data-tab")); });
    }
    byId("refreshButton").addEventListener("click", refresh);
    byId("directScanButton").addEventListener("click", recognizeCanvasDirect);
    byId("scanButton").addEventListener("click", recognizeCanvas);
    byId("replaceButton").addEventListener("click", rebuildOCRText);
    byId("selectOcrFont").addEventListener("click", openFontPicker);
    byId("textColor").addEventListener("input", function () { updateColorPreview(false); });
    byId("textColor").addEventListener("blur", function () { if (!updateColorPreview(true)) { this.value = "#151515"; updateColorPreview(true); } });
    byId("useForegroundColor").addEventListener("click", useForegroundColor);
    byId("excludeRegionButton").addEventListener("click", function () { openExcludePicker("exclude"); });
    byId("closeExcludePicker").addEventListener("click", function () { byId("excludePicker").classList.add("is-hidden"); });
    byId("clearExcludeRects").addEventListener("click", function () { state.excludeRects = []; state.excludeDrawing = null; drawExcludeRects(); });
    byId("applyExcludeRects").addEventListener("click", applyExcludeRects);
    byId("excludeCanvas").addEventListener("mousedown", function (event) { var point = excludeCanvasPoint(event); state.excludeDrawing = { startX: point.x, startY: point.y, x: point.x, y: point.y, width: 0, height: 0 }; drawExcludeRects(); });
    byId("excludeCanvas").addEventListener("mousemove", function (event) { if (!state.excludeDrawing) return; var point = excludeCanvasPoint(event); var drawing = state.excludeDrawing; drawing.x = Math.min(drawing.startX, point.x); drawing.y = Math.min(drawing.startY, point.y); drawing.width = Math.abs(point.x - drawing.startX); drawing.height = Math.abs(point.y - drawing.startY); drawExcludeRects(); });
    byId("excludeCanvas").addEventListener("mouseup", function (event) { if (!state.excludeDrawing) return; var point = excludeCanvasPoint(event); var drawing = state.excludeDrawing; var left = Math.min(drawing.startX, point.x); var top = Math.min(drawing.startY, point.y); var width = Math.abs(point.x - drawing.startX); var height = Math.abs(point.y - drawing.startY); state.excludeDrawing = null; if (width > 4 && height > 4) state.excludeRects.push({ x: left, y: top, width: width, height: height }); drawExcludeRects(); });
    byId("fontSearch").addEventListener("input", renderFontOptions);
    byId("closePicker").addEventListener("click", closeFontPicker);
    byId("clearMapping").addEventListener("click", closeFontPicker);
    byId("fontPicker").addEventListener("click", function (event) { if (event.target === byId("fontPicker")) closeFontPicker(); });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeFontPicker(); });
    byId("chooseFolderButton").addEventListener("click", chooseFolder);
    byId("emptyChooseButton").addEventListener("click", chooseFolder);
    byId("refreshAssetsButton").addEventListener("click", function () { loadAssets(true); });
    byId("assetSearch").addEventListener("input", function () { state.search = this.value || ""; renderAssets(); });
    byId("categorySelect").addEventListener("change", function () { state.category = this.value || "全部"; renderAssets(); });
    byId("placeButton").addEventListener("click", placeAsset);
    try { window.__adobe_cep__.addEventListener("com.adobe.csxs.events.ThemeColorChanged", applyTheme); } catch (eventError) {}
  }

  function initialize() {
    applyTheme();
    bind();
    updateColorPreview(true);
    switchTab(state.activeTab);
    renderAssets();
    refreshHost().then(function () {
      if (state.rootPath) loadAssets(false);
    }).catch(function (error) {
      setRail("error");
      toast(errorText(error, "无法连接 Photoshop"), "error");
    });
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();

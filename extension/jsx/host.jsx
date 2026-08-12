#target photoshop

var FontAssetAssistant = FontAssetAssistant || {};

(function (api) {
    var s2t = stringIDToTypeID;
    var c2t = charIDToTypeID;

    api._pendingReplacement = null;
    api._lastReplacementResult = null;
    api._pendingAssetPath = "";
    api._lastPlacementResult = null;
    api._pendingOCRRebuild = null;
    api._lastOCRRebuildResult = null;

    // ExtendScript in Photoshop 2020 does not consistently provide the browser JSON object.
    // The panel only exchanges plain objects, arrays, strings, numbers, booleans and null.
    api._quoteJSON = function (text) {
        var value = String(text);
        var escapable = /[\\\"\x00-\x1f\x7f-\x9f]/g;
        var meta = {
            "\b": "\\b",
            "\t": "\\t",
            "\n": "\\n",
            "\f": "\\f",
            "\r": "\\r",
            "\"": "\\\"",
            "\\": "\\\\"
        };
        return "\"" + value.replace(escapable, function (character) {
            var replacement = meta[character];
            if (replacement) return replacement;
            var code = character.charCodeAt(0).toString(16);
            return "\\u" + ("0000" + code).slice(-4);
        }) + "\"";
    };

    api._stringifyJSON = function (value, depth) {
        var level = depth || 0;
        if (level > 30) throw new Error("返回数据层级过深");
        if (value === null) return "null";
        var valueType = typeof value;
        if (valueType === "string") return api._quoteJSON(value);
        if (valueType === "number") return isFinite(value) ? String(value) : "null";
        if (valueType === "boolean") return value ? "true" : "false";
        if (valueType === "undefined" || valueType === "function") return undefined;

        if (value instanceof Array) {
            var arrayParts = [];
            for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex += 1) {
                var arrayValue = api._stringifyJSON(value[arrayIndex], level + 1);
                arrayParts.push(arrayValue === undefined ? "null" : arrayValue);
            }
            return "[" + arrayParts.join(",") + "]";
        }

        var objectParts = [];
        for (var key in value) {
            if (!value.hasOwnProperty(key)) continue;
            var item = api._stringifyJSON(value[key], level + 1);
            if (item !== undefined) objectParts.push(api._quoteJSON(key) + ":" + item);
        }
        return "{" + objectParts.join(",") + "}";
    };

    api._parseJSON = function (text) {
        // Input comes only from this extension's own CEP panel.
        return eval("(" + text + ")");
    };

    api._json = function (value) {
        try {
            return api._stringifyJSON(value, 0);
        } catch (error) {
            return '{"ok":false,"error":"无法序列化返回结果"}';
        }
    };

    api._error = function (error, fallback) {
        var message = fallback || "操作未完成";
        try {
            if (error && error.message) message = error.message;
            if (error && error.line) message += "（脚本第 " + error.line + " 行）";
        } catch (ignore) {}
        return { ok: false, error: message };
    };

    api._safeName = function (layer) {
        try {
            return layer.name || ("图层 " + layer.id);
        } catch (error) {
            return "未命名图层";
        }
    };

    api._isLocked = function (layer, parentLocked) {
        if (parentLocked) return true;
        try {
            if (layer.allLocked) return true;
        } catch (error) {}
        return false;
    };

    api._walkLayers = function (layers, parentLocked, visitor) {
        for (var index = 0; index < layers.length; index += 1) {
            var layer = layers[index];
            var locked = api._isLocked(layer, parentLocked);
            if (layer.typename === "LayerSet") {
                api._walkLayers(layer.layers, locked, visitor);
            } else {
                visitor(layer, locked);
            }
        }
    };

    api._getTextKey = function (layerId) {
        var reference = new ActionReference();
        reference.putIdentifier(c2t("Lyr "), layerId);
        var layerDescriptor = executeActionGet(reference);
        var textKeyId = s2t("textKey");
        if (!layerDescriptor.hasKey(textKeyId)) return null;
        return layerDescriptor.getObjectValue(textKeyId);
    };

    api._descriptorString = function (descriptor, keyName) {
        var key = s2t(keyName);
        try {
            return descriptor.hasKey(key) ? descriptor.getString(key) : "";
        } catch (error) {
            return "";
        }
    };

    api._fontFromStyle = function (styleDescriptor) {
        var postScriptName = api._descriptorString(styleDescriptor, "fontPostScriptName");
        var familyName = api._descriptorString(styleDescriptor, "fontName");
        var styleName = api._descriptorString(styleDescriptor, "fontStyleName");
        if (!postScriptName) postScriptName = familyName;
        return {
            postScriptName: postScriptName,
            familyName: familyName || postScriptName || "未知字体",
            styleName: styleName || "Regular"
        };
    };

    api._installedFonts = function () {
        var fonts = [];
        var seen = {};
        for (var index = 0; index < app.fonts.length; index += 1) {
            var source = app.fonts[index];
            var postScriptName = "";
            var familyName = "";
            var styleName = "";
            try { postScriptName = source.postScriptName || source.name || ""; } catch (errorA) {}
            try { familyName = source.family || source.name || postScriptName; } catch (errorB) {}
            try { styleName = source.style || "Regular"; } catch (errorC) {}
            if (!postScriptName || seen["font:" + postScriptName]) continue;
            seen["font:" + postScriptName] = true;
            fonts.push({
                postScriptName: postScriptName,
                familyName: familyName || postScriptName,
                styleName: styleName || "Regular"
            });
        }
        fonts.sort(function (left, right) {
            var a = (left.familyName + " " + left.styleName).toLowerCase();
            var b = (right.familyName + " " + right.styleName).toLowerCase();
            return a < b ? -1 : a > b ? 1 : 0;
        });
        return fonts;
    };

    api.getHostInfo = function () {
        try {
            return api._json({
                ok: true,
                appName: app.name,
                version: app.version,
                documents: app.documents.length
            });
        } catch (error) {
            return api._json(api._error(error, "无法读取 Photoshop 信息"));
        }
    };

    api.getForegroundColor = function () {
        try {
            var rgb = app.foregroundColor.rgb;
            var toHex = function (value) {
                var hex = Math.max(0, Math.min(255, Math.round(value))).toString(16).toUpperCase();
                return hex.length < 2 ? "0" + hex : hex;
            };
            return api._json({ ok: true, hex: "#" + toHex(rgb.red) + toHex(rgb.green) + toHex(rgb.blue) });
        } catch (error) {
            return api._json(api._error(error, "无法读取 Photoshop 前景色"));
        }
    };

    api.scanDocument = function () {
        try {
            var fonts = api._installedFonts();
            var installed = {};
            var fontIndex;
            for (fontIndex = 0; fontIndex < fonts.length; fontIndex += 1) {
                installed["font:" + fonts[fontIndex].postScriptName] = true;
            }

            if (app.documents.length === 0) {
                return api._json({ ok: true, document: null, fonts: fonts, usages: [], textLayerCount: 0, smartObjectCount: 0 });
            }

            var documentRef = app.activeDocument;
            var usageMap = {};
            var usages = [];
            var textLayerCount = 0;
            var smartObjectCount = 0;
            var lockedTextLayerCount = 0;

            api._walkLayers(documentRef.layers, false, function (layer, locked) {
                try {
                    if (layer.kind === LayerKind.SMARTOBJECT) {
                        smartObjectCount += 1;
                        return;
                    }
                    if (layer.kind !== LayerKind.TEXT) return;
                    textLayerCount += 1;
                    if (locked) lockedTextLayerCount += 1;

                    var textKey = api._getTextKey(layer.id);
                    if (!textKey || !textKey.hasKey(s2t("textStyleRange"))) {
                        var fallbackName = layer.textItem.font;
                        if (!fallbackName) return;
                        var fallbackKey = "font:" + fallbackName;
                        if (!usageMap[fallbackKey]) {
                            usageMap[fallbackKey] = {
                                postScriptName: fallbackName,
                                familyName: fallbackName,
                                styleName: "Regular",
                                layers: {},
                                layerCount: 0,
                                rangeCount: 0,
                                missing: !installed[fallbackKey]
                            };
                            usages.push(usageMap[fallbackKey]);
                        }
                        var fallbackUsage = usageMap[fallbackKey];
                        if (!fallbackUsage.layers["layer:" + layer.id]) {
                            fallbackUsage.layers["layer:" + layer.id] = true;
                            fallbackUsage.layerCount += 1;
                        }
                        fallbackUsage.rangeCount += 1;
                        return;
                    }

                    var ranges = textKey.getList(s2t("textStyleRange"));
                    for (var rangeIndex = 0; rangeIndex < ranges.count; rangeIndex += 1) {
                        var range = ranges.getObjectValue(rangeIndex);
                        if (!range.hasKey(s2t("textStyle"))) continue;
                        var style = range.getObjectValue(s2t("textStyle"));
                        var identity = api._fontFromStyle(style);
                        if (!identity.postScriptName) continue;
                        var usageKey = "font:" + identity.postScriptName;
                        if (!usageMap[usageKey]) {
                            usageMap[usageKey] = {
                                postScriptName: identity.postScriptName,
                                familyName: identity.familyName,
                                styleName: identity.styleName,
                                layers: {},
                                layerCount: 0,
                                rangeCount: 0,
                                missing: !installed[usageKey]
                            };
                            usages.push(usageMap[usageKey]);
                        }
                        var usage = usageMap[usageKey];
                        if (!usage.layers["layer:" + layer.id]) {
                            usage.layers["layer:" + layer.id] = true;
                            usage.layerCount += 1;
                        }
                        usage.rangeCount += 1;
                    }
                } catch (layerError) {
                    // A damaged or unsupported layer should not abort the document scan.
                }
            });

            for (var usageIndex = 0; usageIndex < usages.length; usageIndex += 1) {
                delete usages[usageIndex].layers;
            }
            usages.sort(function (left, right) {
                if (left.missing !== right.missing) return left.missing ? -1 : 1;
                var a = (left.familyName + " " + left.styleName).toLowerCase();
                var b = (right.familyName + " " + right.styleName).toLowerCase();
                return a < b ? -1 : a > b ? 1 : 0;
            });

            return api._json({
                ok: true,
                document: { id: documentRef.id, name: documentRef.name },
                fonts: fonts,
                usages: usages,
                textLayerCount: textLayerCount,
                lockedTextLayerCount: lockedTextLayerCount,
                smartObjectCount: smartObjectCount
            });
        } catch (error) {
            return api._json(api._error(error, "无法扫描当前文档"));
        }
    };

    api._setTextKey = function (layerId, textKey) {
        var setDescriptor = new ActionDescriptor();
        var target = new ActionReference();
        target.putIdentifier(c2t("Lyr "), layerId);
        setDescriptor.putReference(c2t("null"), target);
        setDescriptor.putObject(c2t("T   "), s2t("textLayer"), textKey);
        executeAction(c2t("setd"), setDescriptor, DialogModes.NO);
    };

    api._replaceFontsInternal = function () {
        var payload = api._pendingReplacement;
        var mappingLookup = {};
        var mappingIndex;
        for (mappingIndex = 0; mappingIndex < payload.mappings.length; mappingIndex += 1) {
            var mapping = payload.mappings[mappingIndex];
            if (mapping.enabled === false || !mapping.target || !mapping.target.postScriptName) continue;
            mappingLookup["font:" + mapping.sourcePostScriptName] = mapping.target;
        }

        var result = {
            ok: true,
            modifiedLayers: 0,
            modifiedRanges: 0,
            skippedLocked: [],
            failures: [],
            smartObjectCount: 0
        };

        api._walkLayers(app.activeDocument.layers, false, function (layer, locked) {
            try {
                if (layer.kind === LayerKind.SMARTOBJECT) {
                    result.smartObjectCount += 1;
                    return;
                }
                if (layer.kind !== LayerKind.TEXT) return;

                var textKey = api._getTextKey(layer.id);
                if (!textKey || !textKey.hasKey(s2t("textStyleRange"))) return;
                var oldRanges = textKey.getList(s2t("textStyleRange"));
                var newRanges = new ActionList();
                var changedRanges = 0;

                for (var rangeIndex = 0; rangeIndex < oldRanges.count; rangeIndex += 1) {
                    var range = oldRanges.getObjectValue(rangeIndex);
                    if (range.hasKey(s2t("textStyle"))) {
                        var style = range.getObjectValue(s2t("textStyle"));
                        var identity = api._fontFromStyle(style);
                        var targetFont = mappingLookup["font:" + identity.postScriptName];
                        if (targetFont) {
                            style.putString(s2t("fontPostScriptName"), targetFont.postScriptName);
                            style.putString(s2t("fontName"), targetFont.familyName || targetFont.postScriptName);
                            style.putString(s2t("fontStyleName"), targetFont.styleName || "Regular");
                            range.putObject(s2t("textStyle"), s2t("textStyle"), style);
                            changedRanges += 1;
                        }
                    }
                    newRanges.putObject(s2t("textStyleRange"), range);
                }

                if (!changedRanges) return;
                if (locked) {
                    result.skippedLocked.push({ layerId: layer.id, layerName: api._safeName(layer), rangeCount: changedRanges });
                    return;
                }

                try {
                    textKey.putList(s2t("textStyleRange"), newRanges);
                    api._setTextKey(layer.id, textKey);
                    result.modifiedLayers += 1;
                    result.modifiedRanges += changedRanges;
                } catch (setError) {
                    result.failures.push({ layerId: layer.id, layerName: api._safeName(layer), message: setError.message || "无法修改图层" });
                }
            } catch (layerError) {
                result.failures.push({ layerId: layer.id, layerName: api._safeName(layer), message: layerError.message || "无法读取图层" });
            }
        });

        api._lastReplacementResult = result;
    };

    api.replaceFonts = function (payloadJson) {
        try {
            if (app.documents.length === 0) return api._json({ ok: false, error: "请先打开一个 Photoshop 文档" });
            var payload = api._parseJSON(payloadJson);
            if (!payload || !payload.mappings || !payload.mappings.length) {
                return api._json({ ok: false, error: "请至少设置一组字体映射" });
            }
            if (payload.documentId && app.activeDocument.id !== payload.documentId) {
                return api._json({ ok: false, error: "活动文档已经变化，请重新扫描" });
            }
            api._pendingReplacement = payload;
            api._lastReplacementResult = null;
            app.activeDocument.suspendHistory("批量替换字体", "FontAssetAssistant._replaceFontsInternal()");
            var result = api._lastReplacementResult || { ok: false, error: "字体替换没有返回结果" };
            api._pendingReplacement = null;
            return api._json(result);
        } catch (error) {
            api._pendingReplacement = null;
            return api._json(api._error(error, "字体替换失败"));
        }
    };

    api.exportCanvasForOCR = function () {
        var duplicateDocument = null;
        try {
            if (app.documents.length === 0) return api._json({ ok: false, error: "请先打开一张需要识别文字的图片" });
            var sourceDocument = app.activeDocument;
            var exportFolder = new Folder(Folder.temp.fsName + "/FontAssetAssistantOCR");
            if (!exportFolder.exists && !exportFolder.create()) throw new Error("无法创建 OCR 临时目录");
            var exportFile = new File(exportFolder.fsName + "/canvas-" + sourceDocument.id + "-" + new Date().getTime() + ".png");
            duplicateDocument = sourceDocument.duplicate("OCR 临时画布", false);
            duplicateDocument.flatten();
            var pngOptions = new PNGSaveOptions();
            pngOptions.compression = 6;
            pngOptions.interlaced = false;
            duplicateDocument.saveAs(exportFile, pngOptions, true, Extension.LOWERCASE);
            duplicateDocument.close(SaveOptions.DONOTSAVECHANGES);
            duplicateDocument = null;
            app.activeDocument = sourceDocument;
            return api._json({
                ok: true,
                document: {
                    id: sourceDocument.id,
                    name: sourceDocument.name,
                    width: sourceDocument.width.as("px"),
                    height: sourceDocument.height.as("px"),
                    resolution: sourceDocument.resolution
                },
                imagePath: exportFile.fsName,
                fonts: api._installedFonts()
            });
        } catch (error) {
            try { if (duplicateDocument) duplicateDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) {}
            return api._json(api._error(error, "无法导出当前画布用于文字识别"));
        }
    };

    api._hexColor = function (hex) {
        var normalized = String(hex || "#111111").replace("#", "");
        if (normalized.length === 3) normalized = normalized.charAt(0) + normalized.charAt(0) + normalized.charAt(1) + normalized.charAt(1) + normalized.charAt(2) + normalized.charAt(2);
        if (!/^[0-9a-fA-F]{6}$/.test(normalized)) normalized = "111111";
        var color = new SolidColor();
        color.rgb.red = parseInt(normalized.substr(0, 2), 16);
        color.rgb.green = parseInt(normalized.substr(2, 2), 16);
        color.rgb.blue = parseInt(normalized.substr(4, 2), 16);
        return color;
    };

    api._selectTextRegion = function (documentRef, line, margin, selectionType) {
        var left = Math.max(0, line.x - margin);
        var top = Math.max(0, line.y - margin);
        var right = Math.min(documentRef.width.as("px"), line.x + line.width + margin);
        var bottom = Math.min(documentRef.height.as("px"), line.y + line.height + margin);
        if (right <= left || bottom <= top) return false;
        documentRef.selection.select([
            [UnitValue(left, "px"), UnitValue(top, "px")],
            [UnitValue(right, "px"), UnitValue(top, "px")],
            [UnitValue(right, "px"), UnitValue(bottom, "px")],
            [UnitValue(left, "px"), UnitValue(bottom, "px")]
        ], selectionType || SelectionType.REPLACE, 0, false);
        return true;
    };

    api._eraseAllTextRegions = function (documentRef, lines, eraseMargin) {
        documentRef.selection.deselect();
        var selectedCount = 0;
        for (var index = 0; index < lines.length; index += 1) {
            var line = lines[index];
            if (line.enabled === false || !String(line.text || "").replace(/^\s+|\s+$/g, "")) continue;
            var margin = Math.max(4, Number(line.height) * Number(eraseMargin || 0.24));
            var selectionType = selectedCount ? SelectionType.EXTEND : SelectionType.REPLACE;
            if (api._selectTextRegion(documentRef, line, margin, selectionType)) selectedCount += 1;
        }
        if (!selectedCount) return 0;
        try { documentRef.selection.feather(UnitValue(1, "px")); } catch (featherError) {}
        var descriptor = new ActionDescriptor();
        descriptor.putEnumerated(c2t("Usng"), c2t("FlCn"), s2t("contentAware"));
        descriptor.putUnitDouble(c2t("Opct"), c2t("#Prc"), 100);
        descriptor.putEnumerated(c2t("Md  "), c2t("BlnM"), c2t("Nrml"));
        executeAction(c2t("Fl  "), descriptor, DialogModes.NO);
        documentRef.selection.deselect();
        return selectedCount;
    };

    api._eraseTextRegionsIndividually = function (documentRef, lines, eraseMargin) {
        var filledCount = 0;
        for (var index = 0; index < lines.length; index += 1) {
            var line = lines[index];
            if (line.enabled === false || !String(line.text || "").replace(/^\s+|\s+$/g, "")) continue;
            var margin = Math.max(4, Number(line.height) * Number(eraseMargin || 0.24));
            documentRef.selection.deselect();
            if (!api._selectTextRegion(documentRef, line, margin, SelectionType.REPLACE)) continue;
            try { documentRef.selection.feather(UnitValue(1, "px")); } catch (featherError) {}
            var descriptor = new ActionDescriptor();
            descriptor.putEnumerated(c2t("Usng"), c2t("FlCn"), s2t("contentAware"));
            descriptor.putUnitDouble(c2t("Opct"), c2t("#Prc"), 100);
            descriptor.putEnumerated(c2t("Md  "), c2t("BlnM"), c2t("Nrml"));
            executeAction(c2t("Fl  "), descriptor, DialogModes.NO);
            documentRef.selection.deselect();
            filledCount += 1;
        }
        documentRef.selection.deselect();
        return filledCount;
    };

    api._createOCRTextLayer = function (documentRef, group, line, payload, index) {
        var layer = documentRef.artLayers.add();
        layer.kind = LayerKind.TEXT;
        layer.name = "OCR " + (index + 1) + " · " + String(line.text).substr(0, 22);
        var textItem = layer.textItem;
        textItem.kind = TextType.POINTTEXT;
        textItem.contents = String(line.text).replace(/[\r\n]+/g, " ");
        var targetFont = line.targetFont || payload.targetFont;
        if (!targetFont || !targetFont.postScriptName) throw new Error("这一行没有选择替换字体");
        textItem.font = targetFont.postScriptName;
        var fontSizePixels = Math.max(8, Number(line.height) * Number(payload.fontScale || 1));
        textItem.size = UnitValue(fontSizePixels * 72 / documentRef.resolution, "pt");
        textItem.color = api._hexColor(line.textColor || line.color || payload.textColor);
        textItem.antiAliasMethod = AntiAlias.STRONG;
        textItem.justification = Justification.LEFT;
        textItem.position = [
            UnitValue(Number(line.x), "px"),
            UnitValue(Number(line.y) + Number(line.height) * 0.88, "px")
        ];
        layer.move(group, ElementPlacement.INSIDE);

        // Do not force the text into the OCR bounding-box width.
        // horizontalScale changes glyph proportions and visibly distorts the font.
        return layer;
    };

    api._rebuildOCRInternal = function () {
        var payload = api._pendingOCRRebuild;
        var documentRef = app.activeDocument;
        var result = { ok: true, createdLayers: 0, cleanedRegions: 0, contentAwareRegions: 0, failures: [] };
        var originalLayer = documentRef.activeLayer;

        if (payload.eraseOriginal) {
            try {
                var cleanupLayer = originalLayer.duplicate();
                cleanupLayer.name = "OCR 清理背景（原图保留在下方）";
                cleanupLayer.visible = true;
                documentRef.activeLayer = cleanupLayer;
                result.cleanedRegions = payload.eraseMode === "individual" ? api._eraseTextRegionsIndividually(documentRef, payload.lines, payload.eraseMargin) : api._eraseAllTextRegions(documentRef, payload.lines, payload.eraseMargin);
                result.contentAwareRegions = result.cleanedRegions;
            } catch (duplicateError) {
                result.failures.push({ index: -1, text: "", stage: "erase", message: duplicateError.message || "无法创建清理背景图层" });
            }
        }

        var group = documentRef.layerSets.add();
        group.name = "OCR 可编辑文字";
        for (var lineIndex = 0; lineIndex < payload.lines.length; lineIndex += 1) {
            var line = payload.lines[lineIndex];
            if (line.enabled === false || !String(line.text || "").replace(/^\s+|\s+$/g, "")) continue;
            try {
                api._createOCRTextLayer(documentRef, group, line, payload, lineIndex);
                result.createdLayers += 1;
            } catch (textError) {
                result.failures.push({ index: lineIndex, text: line.text, stage: "text", message: textError.message || "创建文字图层失败" });
            }
        }
        documentRef.activeLayer = group;
        api._lastOCRRebuildResult = result;
    };

    api.rebuildOCRText = function (payloadJson) {
        try {
            if (app.documents.length === 0) return api._json({ ok: false, error: "请先打开一张需要处理的图片" });
            var payload = api._parseJSON(payloadJson);
            if (!payload || !payload.lines || !payload.lines.length) return api._json({ ok: false, error: "没有可重建的识别文字" });
            if (!payload.targetFont || !payload.targetFont.postScriptName) return api._json({ ok: false, error: "请先选择替换字体" });
            if (payload.documentId && app.activeDocument.id !== payload.documentId) return api._json({ ok: false, error: "活动文档已经变化，请重新识别" });
            api._pendingOCRRebuild = payload;
            api._lastOCRRebuildResult = null;
            app.activeDocument.suspendHistory("OCR 擦除并重建文字", "FontAssetAssistant._rebuildOCRInternal()");
            var result = api._lastOCRRebuildResult || { ok: false, error: "文字重建没有返回结果" };
            api._pendingOCRRebuild = null;
            return api._json(result);
        } catch (error) {
            api._pendingOCRRebuild = null;
            return api._json(api._error(error, "OCR 文字重建失败"));
        }
    };

    api.selectAssetFolder = function () {
        try {
            var folder = Folder.selectDialog("选择 Logo / 图片素材目录");
            if (!folder) return api._json({ ok: true, cancelled: true });
            return api._json({ ok: true, cancelled: false, path: folder.fsName, name: folder.name });
        } catch (error) {
            return api._json(api._error(error, "无法选择素材目录"));
        }
    };

    api._placeAssetInternal = function () {
        var file = new File(api._pendingAssetPath);
        if (!file.exists) throw new Error("素材文件已经不存在");
        var descriptor = new ActionDescriptor();
        descriptor.putPath(c2t("null"), file);
        descriptor.putEnumerated(c2t("FTcs"), c2t("QCSt"), c2t("Qcsa"));
        executeAction(c2t("Plc "), descriptor, DialogModes.NO);
        var decodedName = file.name;
        try { decodedName = File.decode(file.name); } catch (decodeError) {}
        var layerName = decodedName.replace(/\.[^.]+$/, "");
        try { app.activeDocument.activeLayer.name = layerName; } catch (renameError) {}
        api._lastPlacementResult = { ok: true, layerName: layerName };
    };

    api.placeAsset = function (assetPath) {
        try {
            if (app.documents.length === 0) return api._json({ ok: false, error: "请先打开一个 Photoshop 文档" });
            var file = new File(assetPath);
            if (!file.exists) return api._json({ ok: false, error: "素材文件已经移动或删除，请刷新素材库" });
            api._pendingAssetPath = file.fsName;
            api._lastPlacementResult = null;
            app.activeDocument.suspendHistory("置入素材", "FontAssetAssistant._placeAssetInternal()");
            var result = api._lastPlacementResult || { ok: false, error: "素材置入没有返回结果" };
            api._pendingAssetPath = "";
            return api._json(result);
        } catch (error) {
            api._pendingAssetPath = "";
            return api._json(api._error(error, "素材置入失败"));
        }
    };
})(FontAssetAssistant);

#!/usr/bin/env python3
"""Plugin-driven OCR -> layered PSD harness.

The Photoshop automation backend is currently macOS/AppleScript. On Windows,
use the bundled CEP panel manually; the panel still uses Windows.Media.Ocr.
"""
from __future__ import annotations
import argparse, hashlib, json, subprocess, tempfile
from pathlib import Path

PLUGIN = Path.home() / "Library/Application Support/Adobe/CEP/extensions/com.liz.fontassetassistant.cep"

def call(cmd):
    return subprocess.run(cmd, check=True, text=True, capture_output=True)

def js_string(s):
    out = []
    for ch in str(s):
        code = ord(ch)
        if code > 127:
            out.append("\\u%04x" % code)
        elif ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        else:
            out.append(ch)
    return '"' + ''.join(out) + '"'

def js_value(v):
    if isinstance(v, str): return js_string(v)
    if isinstance(v, bool): return "true" if v else "false"
    if v is None: return "null"
    if isinstance(v, list): return "[" + ",".join(js_value(x) for x in v) + "]"
    if isinstance(v, dict): return "{" + ",".join(js_string(k) + ":" + js_value(x) for k, x in v.items()) + "}"
    return str(v)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--output-dir", required=True, type=Path)
    ap.add_argument("--mode", choices=["direct", "region"], default="region")
    ap.add_argument("--regions", help="JSON array of OCR regions")
    ap.add_argument("--erase-mode", choices=["auto", "merged", "individual"], default="auto")
    ap.add_argument("--font-postscript", default="STSongti-SC-Regular")
    ap.add_argument("--font-family", default="宋体-简")
    ap.add_argument("--font-scale", type=float, default=0.68)
    ap.add_argument("--text-colors", help="JSON array of per-line hex colors")
    ap.add_argument("--line-scales", help="JSON array of per-line font scale factors")
    ap.add_argument("--line-baselines", help="JSON array of per-line baseline factors")
    ap.add_argument("--line-fonts", help="JSON array of per-line Photoshop PostScript font names")
    ap.add_argument("--min-similarity", type=float, default=0.90)
    ap.add_argument("--plugin-root", type=Path, default=PLUGIN)
    ap.add_argument("--fast", action="store_true", help="reuse OCR/background caches when input and region settings are unchanged")
    ap.add_argument("--cache-dir", type=Path, default=Path.home() / ".codex/cache/psd-image-text-rebuild")
    ap.add_argument("--preview", action="store_true", help="write a small QA preview after PSD creation")
    ap.add_argument("--preview-size", type=int, default=800)
    a = ap.parse_args(); image = a.input.expanduser().resolve()
    if not image.is_file(): raise SystemExit("input not found: " + str(image))
    cache_key = hashlib.sha1((str(image)+str(image.stat().st_mtime_ns)+str(a.mode)+str(a.regions or "")).encode()).hexdigest()
    cache_dir = a.cache_dir.expanduser(); cache_dir.mkdir(parents=True, exist_ok=True)
    ocr_cache = cache_dir / (cache_key + ".ocr.json")
    if a.fast and ocr_cache.is_file():
        ocr = json.loads(ocr_cache.read_text(encoding="utf-8"))
    else:
        ocr_args = [str(a.plugin_root / "scripts/ocr_macos"), str(image)]
        if a.mode == "region" and a.regions: ocr_args.append(a.regions)
        ocr = json.loads(call(ocr_args).stdout)
        ocr_cache.write_text(json.dumps(ocr, ensure_ascii=False), encoding="utf-8")
    lines = ocr.get("lines", [])
    overrides = json.loads(a.text_colors) if a.text_colors else []
    scales = json.loads(a.line_scales) if a.line_scales else []
    baselines = json.loads(a.line_baselines) if a.line_baselines else []
    line_fonts = json.loads(a.line_fonts) if a.line_fonts else []
    for index, line in enumerate(lines):
        line["enabled"] = True
        if index < len(overrides) and overrides[index]: line["color"] = overrides[index]
        if index < len(scales) and scales[index]: line["fontScale"] = scales[index]
        if index < len(baselines) and baselines[index]: line["baseline"] = baselines[index]
        if index < len(line_fonts) and line_fonts[index]: line["targetFont"] = {"postScriptName": line_fonts[index], "familyName": line_fonts[index], "styleName": "Regular"}
        line["textColor"] = line.get("color", "")
        # Short, centered text often sits inside a decorative frame. Keep the
        # frame out of the cleanup mask; only the central glyph area is erased.
        if float(line.get("height", 0) or 0) <= 60:
            line["boxPad"] = 18
            line["protectBorder"] = True
            line["tolerance"] = 220
    active = [x for x in lines if str(x.get("text", "")).strip()]
    # Region OCR with three or more lines is treated as risky: never merge
    # selections because Photoshop content-aware fill can sample foreground
    # objects from elsewhere on the canvas.
    erase = a.erase_mode if a.erase_mode != "auto" else ("individual" if a.mode == "region" and len(active) >= 3 else "merged")
    a.output_dir.mkdir(parents=True, exist_ok=True)
    # Keep Photoshop JSX paths ASCII-safe; the manifest retains the original name.
    output = a.output_dir / "rebuild-final.psd"
    background = a.output_dir / "cleanup.png"
    repair_script = Path(__file__).with_name("repair_text_background.py")
    cleanup_cache = cache_dir / (cache_key + ".cleanup.png")
    if a.fast and cleanup_cache.is_file():
        background.write_bytes(cleanup_cache.read_bytes())
    else:
        call(["python3", str(repair_script), "--input", str(image), "--output", str(background), "--lines", json.dumps(lines, ensure_ascii=False)])
        cleanup_cache.write_bytes(background.read_bytes())
    payload = {"lines": lines, "backgroundPath": str(background), "targetFont": {"postScriptName": a.font_postscript, "familyName": a.font_family, "styleName": "Regular"}, "eraseOriginal": True, "eraseMargin": 0.08 if erase == "individual" else 0.24, "fontScale": a.font_scale, "textColor": "#151515", "eraseMode": erase}
    jsx = '#target photoshop\n#include ' + js_string(str(a.plugin_root / "jsx/host.jsx")) + '\nvar d=app.open(new File(' + js_string(str(image)) + '));var p=' + js_value(payload) + ';p.documentId=d.id;var r=eval("("+FontAssetAssistant.rebuildOCRText(FontAssetAssistant._stringifyJSON(p,0))+")");if(!r.ok)throw new Error(r.error);var o=new PhotoshopSaveOptions();o.layers=true;d.saveAs(new File(' + js_string(str(output)) + '),o,true,Extension.LOWERCASE);var s=r.createdLayers+"|"+r.cleanedRegions+"|"+r.eraseModeUsed;d.close(SaveOptions.DONOTSAVECHANGES);s;\n'
    with tempfile.NamedTemporaryFile("w", suffix=".jsx", encoding="utf-8", delete=False) as f:
        f.write(jsx); script = Path(f.name)
    try:
        try:
            raw = call(["osascript", "-e", f'tell application "Adobe Photoshop 2025" to do javascript (read POSIX file "{script}")']).stdout.strip()
        except subprocess.CalledProcessError as exc:
            raise RuntimeError((exc.stderr or exc.stdout or "Photoshop plugin rebuild failed").strip()) from exc
    finally: script.unlink(missing_ok=True)
    created, cleaned, used = raw.split("|")
    preview = None
    if a.preview:
        preview_path = a.output_dir / "preview-fast.jpg"
        subprocess.run(["sips", "-s", "format", "jpeg", "-Z", str(a.preview_size), str(output), "--out", str(preview_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        preview = str(preview_path)
    manifest = {"input": str(image), "output": str(output), "preview": preview, "mode": a.mode, "ocrLines": len(lines), "eraseModeRequested": a.erase_mode, "eraseModeUsed": used, "createdLayers": int(created), "cleanedRegions": int(cleaned), "selectedFont": a.font_postscript, "lineFonts": line_fonts, "lineScales": scales, "lineBaselines": baselines, "similarityTarget": a.min_similarity, "similarityScore": None, "qa": "needs_review", "uncertainties": ["需逐行候选字体渲染对比并达到相似度目标", "包装/标签文字需人工确认"]}
    (a.output_dir / "rebuild-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))

if __name__ == "__main__": main()

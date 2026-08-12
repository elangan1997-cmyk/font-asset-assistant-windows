#!/usr/bin/env python3
"""Safely remove high-contrast text from flat/soft backgrounds.

This is a conservative fallback for the Photoshop plugin: it only masks
pixels close to the supplied OCR colors inside OCR boxes, then uses local
inpainting. It never touches pixels outside the boxes.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path
import cv2
import numpy as np

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--lines", required=True, help="JSON list with x,y,width,height,color")
    ap.add_argument("--tolerance", type=int, default=100)
    ap.add_argument("--dilate", type=int, default=4)
    ap.add_argument("--radius", type=float, default=20.0)
    ap.add_argument("--box-pad", type=int, default=18)
    a = ap.parse_args()
    image = cv2.imread(str(a.input), cv2.IMREAD_COLOR)
    if image is None: raise SystemExit("cannot read input")
    mask = np.zeros(image.shape[:2], np.uint8)
    for line in json.loads(a.lines):
        color = str(line.get("color", "")).lstrip("#")
        if len(color) != 6: continue
        rgb = np.array([int(color[0:2],16), int(color[2:4],16), int(color[4:6],16)], dtype=np.int16)
        bgr = rgb[::-1]
        pad = int(line.get("boxPad", a.box_pad))
        x, y = max(0, int(line["x"]) - pad), max(0, int(line["y"]) - pad)
        x2 = min(image.shape[1], int(line["x"] + line["width"]) + pad)
        y2 = min(image.shape[0], int(line["y"] + line["height"]) + pad)
        if x2 <= x or y2 <= y: continue
        roi = image[y:y2, x:x2].astype(np.int16)
        distance = np.linalg.norm(roi - bgr, axis=2)
        local = (distance <= int(line.get("tolerance", a.tolerance))).astype(np.uint8) * 255
        if line.get("protectBorder", False):
            hsv = cv2.cvtColor(roi.astype(np.uint8), cv2.COLOR_BGR2HSV)
            # The accent text is much more saturated/darker than the pale
            # water background; this catches antialiased glyph edges whose
            # RGB distance is not close to the nominal OCR color.
            accent = ((hsv[:, :, 1] >= 35) & (hsv[:, :, 2] <= 235)).astype(np.uint8) * 255
            local = np.maximum(local, accent)
            # Do not erase the thin top/bottom/side strokes of a label frame.
            # OCR glyphs remain in the center of these short line boxes.
            edge = min(8, max(1, local.shape[0] // 5), max(1, local.shape[1] // 5))
            local[:edge, :] = 0
            local[-edge:, :] = 0
            local[:, :edge] = 0
            local[:, -edge:] = 0
        if a.dilate > 0:
            kernel = np.ones((a.dilate * 2 + 1, a.dilate * 2 + 1), np.uint8)
            local = cv2.dilate(local, kernel, iterations=1)
        mask[y:y2, x:x2] = np.maximum(mask[y:y2, x:x2], local)
    repaired = cv2.inpaint(image, mask, a.radius, cv2.INPAINT_TELEA)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(a.output), repaired)
    print(json.dumps({"output": str(a.output), "maskedPixels": int(np.count_nonzero(mask)), "qa": "needs_review"}))
    return 0

if __name__ == "__main__": raise SystemExit(main())

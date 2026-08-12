#!/usr/bin/env python3
"""Create a traceable PSD image-text rebuild job manifest."""
import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def image_dimensions(path: Path):
    try:
        out = subprocess.check_output(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)], text=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    values = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            key = parts[0].rstrip(":")
            if key in {"pixelWidth", "pixelHeight"}:
                values[key] = int(parts[-1])
    return values or None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--output-psd", type=Path, required=True)
    parser.add_argument("--mode", choices=["direct", "region"], default="region")
    parser.add_argument("--job", type=Path)
    args = parser.parse_args()
    source = args.image.expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"source image not found: {source}")
    output = args.output_psd.expanduser().resolve()
    job_path = (args.job or output.with_suffix(".rebuild.json")).expanduser().resolve()
    manifest = {
        "schema": "psd-image-text-rebuild/v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_image": str(source),
        "source_dimensions": image_dimensions(source),
        "output_psd": str(output),
        "mode": args.mode,
        "regions": [],
        "lines": [],
        "settings": {
            "default_font": None,
            "default_color": "#151515",
            "erase_mode": "individual",
            "preserve_original": True,
            "allow_horizontal_scaling": False,
        },
        "qa": {"status": "待分类", "iterations": [], "uncertainties": []},
    }
    job_path.parent.mkdir(parents=True, exist_ok=True)
    job_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"job": str(job_path), "source_dimensions": manifest["source_dimensions"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

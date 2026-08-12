#!/usr/bin/env python3
"""Validate a PSD image-text rebuild job manifest without mutating it."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("job", type=Path)
    args = parser.parse_args()
    job_path = args.job.expanduser().resolve()
    data = json.loads(job_path.read_text(encoding="utf-8"))
    errors = []
    required = ["schema", "source_image", "output_psd", "mode", "regions", "lines", "settings", "qa"]
    errors.extend(f"missing key: {key}" for key in required if key not in data)
    source = Path(data.get("source_image", "")).expanduser()
    if not source.is_file():
        errors.append(f"source image missing: {source}")
    if data.get("mode") not in {"direct", "region"}:
        errors.append("mode must be direct or region")
    if data.get("settings", {}).get("allow_horizontal_scaling") is not False:
        errors.append("horizontal scaling must remain disabled")
    if errors:
        print(json.dumps({"ok": False, "errors": errors}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps({"ok": True, "source_image": str(source), "line_count": len(data.get("lines", [])), "status": data["qa"].get("status")}, ensure_ascii=False))


if __name__ == "__main__":
    main()

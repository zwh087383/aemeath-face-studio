"""Download the public Windows TensorRT SDK, without global installation."""
from prepare_assets import ROOT, digest
import json
import os
from pathlib import Path
import shutil
import time
import urllib.request
import zipfile

name = "TensorRT-10.13.2.6.Windows.win10.cuda-12.9.zip"
url = "https://developer.nvidia.com/downloads/compute/machine-learning/tensorrt/10.13.2/zip/" + name
archive = ROOT / "cache" / "downloads" / name
archive.parent.mkdir(parents=True, exist_ok=True)
(ROOT / "logs").mkdir(parents=True, exist_ok=True)
expected = 1741657480
expected_sha256 = "624707c62086dbff297b48f06584ad6458ac3215e9f812e4cebb857bac25e639"
partial = archive.with_name(archive.name + ".partial")
if not archive.exists() or archive.stat().st_size != expected:
    errors = 0
    while not partial.exists() or partial.stat().st_size < expected:
        start = partial.stat().st_size if partial.exists() else 0
        end = min(start + 32 * 1024 * 1024, expected) - 1
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=90) as src:
                if src.status != 206 or src.headers.get("Content-Range") != f"bytes {start}-{end}/{expected}":
                    raise ValueError("Server did not honor exact resume range")
                with partial.open("ab") as dst:
                    remaining = end - start + 1
                    while remaining:
                        block = src.read(min(1024 * 1024, remaining))
                        if not block:
                            raise IOError("Incomplete range; will resume")
                        dst.write(block)
                        remaining -= len(block)
            print(f"TensorRT: {partial.stat().st_size/1e6:.1f} / {expected/1e6:.1f} MB", flush=True)
            errors = 0
        except Exception as exc:
            errors += 1
            print(f"Resume retry {errors}: {type(exc).__name__}: {exc}", flush=True)
            if errors >= 4:
                raise
            time.sleep(2)
    if partial.stat().st_size != expected:
        raise ValueError("Unexpected archive size")
    os.replace(partial, archive)
receipt = {"path": str(archive.relative_to(ROOT)), "bytes": archive.stat().st_size, "sha256": digest(archive)}
if receipt["sha256"] != expected_sha256:
    raise ValueError("TensorRT archive does not match the pinned, locally verified SHA256")
dest = ROOT / "runtime" / "tensorrt-10.13.2.6"
with zipfile.ZipFile(archive) as z:
    for member in z.infolist():
        parts = Path(member.filename).parts[1:]
        if not parts or member.is_dir():
            continue
        target = (dest / Path(*parts)).resolve()
        if not target.is_relative_to(dest.resolve()):
            raise ValueError("Unsafe archive member")
        target.parent.mkdir(parents=True, exist_ok=True)
        with z.open(member) as src, target.open("wb") as dst:
            shutil.copyfileobj(src, dst)
(ROOT / "logs" / "tensorrt-download-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
print("TensorRT extracted and ZIP CRC checked", flush=True)

"""Fetch pinned public model assets / CUDA redistributables inside this workspace."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def request(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Audio2Face-local-research/1.0"}), timeout=90)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fetch(url, path, size=None, sha256=None):
    path = path.resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError(f"Destination outside workspace: {path!s} (root {ROOT!s})")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and (size is None or path.stat().st_size == size):
        current = digest(path)
        if sha256 is None or current == sha256:
            print(f"Already verified: {path.name}", flush=True)
            return {"path": str(path.relative_to(ROOT)), "bytes": path.stat().st_size, "sha256": current}
    tmp = path.with_name(path.name + ".partial")
    started = last = time.monotonic()
    h, count = hashlib.sha256(), 0
    with request(url) as src, tmp.open("wb") as dst:
        while block := src.read(1024 * 1024):
            dst.write(block)
            h.update(block)
            count += len(block)
            now = time.monotonic()
            if now - last > 20:
                print(f"Downloading {path.name}: {count / 1e6:.1f} MB, {count / 1e6 / (now-started):.1f} MB/s", flush=True)
                last = now
    actual_hash = h.hexdigest()
    if size is not None and count != size:
        raise ValueError(f"Size mismatch: {path.name}: {count} != {size}")
    if sha256 and actual_hash != sha256:
        raise ValueError(f"SHA256 mismatch: {path.name}")
    os.replace(tmp, path)
    print(f"Verified {path.name}: {count / 1e6:.1f} MB", flush=True)
    return {"path": str(path.relative_to(ROOT)), "bytes": count, "sha256": actual_hash}


def cuda_component(item):
    name, data = item
    package = ROOT / "cache" / "downloads" / Path(data["relative_path"]).name
    receipt = fetch("https://developer.download.nvidia.com/compute/cuda/redist/" + data["relative_path"], package, int(data["size"]), data["sha256"])
    destination = ROOT / "runtime" / "cuda-12.9"
    with zipfile.ZipFile(package) as z:
        for member in z.infolist():
            parts = Path(member.filename).parts[1:]
            if not parts or member.is_dir():
                continue
            relative = Path(*parts)
            if relative.name.lower().startswith(("license", "eula")):
                relative = Path("licenses") / name / relative
            target = (destination / relative).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise ValueError("Unsafe archive member")
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(member) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
    receipt["component"] = name
    print(f"Extracted {name}", flush=True)
    return receipt


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("kind", choices=["model", "cuda"])
    args = p.parse_args()
    (ROOT / "logs").mkdir(parents=True, exist_ok=True)
    if args.kind == "model":
        lock = json.loads((ROOT / "manifests/claire-download.json").read_text(encoding="utf-8-sig"))
        repo, revision = lock["repo"], lock["revision"]
        model_dir = ROOT / "models" / repo.split("/")[1]
        model_dir.mkdir(parents=True, exist_ok=True)
        receipts = []
        for entry in lock["files"]:
            relative = Path(entry["path"].replace("\\", "/"))
            name = relative.relative_to(Path("models") / repo.split("/")[1]).as_posix()
            url = f"https://huggingface.co/{repo}/resolve/{revision}/{urllib.parse.quote(name)}"
            receipts.append(fetch(url, model_dir / name, entry["bytes"], entry["sha256"]))
        result = {"repo": repo, "revision": revision, "files": receipts}
    else:
        manifest = json.loads((ROOT / "manifests" / "cuda-redist-12.9.1.json").read_text(encoding="utf-8-sig"))
        (ROOT / "runtime/cuda-12.9").mkdir(parents=True, exist_ok=True)
        components = ["cuda_cccl", "cuda_cudart", "cuda_nvcc", "cuda_nvrtc", "cuda_nvtx", "libcublas", "libcurand"]
        items = [(name, manifest[name]["windows-x86_64"]) for name in components]
        print(f"CUDA selected download: {sum(int(data['size']) for _,data in items)/1e9:.2f} GB", flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            receipts = list(pool.map(cuda_component, items))
        result = {"version": "12.9.1", "files": receipts}
    (ROOT / "logs" / f"{args.kind}-download-receipt.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Completed {args.kind}", flush=True)


if __name__ == "__main__":
    main()

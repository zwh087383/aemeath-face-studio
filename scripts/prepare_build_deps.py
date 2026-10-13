"""Fetch the SDK's exact declared dependencies via stdlib TLS and unpack locally."""
from prepare_assets import ROOT, fetch
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET

(ROOT / "logs").mkdir(parents=True, exist_ok=True)
project = ET.parse(ROOT / "scripts" / "target-deps-minimal.packman.xml")
receipts = []
for dep in project.getroot().findall("dependency"):
    packages = [p for p in dep.findall("package") if not p.get("platforms") or "windows-x86_64" in p.get("platforms").split()]
    if len(packages) != 1:
        raise ValueError(f"Expected one Windows package: {dep.get('name')}")
    package = packages[0]
    version = package.get("version").replace("${platform}", "windows-x86_64").replace("${config}", "release")
    filename = package.get("name") + "@" + version
    destination = (ROOT / dep.get("linkPath").replace("${config}", "release")).resolve()
    if not destination.is_relative_to(ROOT):
        raise ValueError("Dependency outside workspace")
    receipt = None
    for extension in [".7z", ".zip"]:
        archive = ROOT / "cache" / "downloads" / (filename + extension)
        url = "https://d2iqmcaurylv9r.cloudfront.net/" + urllib.parse.quote(filename + extension)
        try:
            receipt = fetch(url, archive)
            break
        except urllib.error.HTTPError as exc:
            if exc.code not in [403,404]:
                raise
    if receipt is None:
        raise RuntimeError(f"Could not obtain official dependency: {filename}")
    listing = subprocess.run(["tar.exe", "-tf", str(archive)], capture_output=True, text=True, check=True)
    for name in listing.stdout.splitlines():
        if not (destination / name).resolve().is_relative_to(destination):
            raise ValueError("Unsafe archive member")
    destination.mkdir(parents=True, exist_ok=True)
    subprocess.run(["tar.exe", "-xf", str(archive), "-C", str(destination)], check=True)
    receipt.update({"package": filename, "destination": str(destination.relative_to(ROOT))})
    receipts.append(receipt)
    print(f"Unpacked {filename}", flush=True)
(ROOT / "logs" / "build-deps-receipt.json").write_text(json.dumps(receipts, indent=2), encoding="utf-8")
print("All declared build dependencies prepared", flush=True)

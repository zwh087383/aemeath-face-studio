"""Hash earlier evidence and protected working files; never modifies them."""
from pathlib import Path
import hashlib
import json
import sys

ROOT=Path(__file__).resolve().parents[2]
PROTECTED=["README.md","preview/expressions/index.html","preview/index.html","preview/package.json","preview/server.cjs",
 "realtime/avatar-server.mjs","realtime/avatar/viewer.mjs","realtime/performance/index.html","realtime/qwen/viewer.mjs",
 "preview/core/motion-controller.js","preview/core/full-body-controller.js","preview/core/motion-profile.js",
 "preview/core/continuous-face-controller.js","realtime/character-center/scene.mjs","realtime/character-center/protocol.py"]

def fingerprints():
    files=[ROOT/p for p in PROTECTED]
    files += [p for p in (ROOT/"outputs").glob("**/ledger.json") if "character-campaign-20261027" not in p.parts]
    return {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.is_file()}

if __name__=="__main__":
    target=ROOT/"outputs/character-campaign-20261027/protected-before.json"
    current=fingerprints()
    if len(sys.argv)>1 and sys.argv[1]=="verify":
        before=json.loads(target.read_text(encoding="utf-8"))
        changed=[p for p,h in before.items() if current.get(p)!=h]
        print(json.dumps({"checked":len(before),"changed":changed}));sys.exit(bool(changed))
    if target.exists(): raise SystemExit("preservation_snapshot_already_exists")
    target.write_text(json.dumps(current,indent=2),encoding="utf-8")
    print(json.dumps({"preservedFingerprints":len(current)}))

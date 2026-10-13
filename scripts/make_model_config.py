"""Reference pinned source assets and the locally built TensorRT engine."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / "models/Audio2Face-3D-v2.3.1-Claire"
destination = root / "outputs/engines/claire"
destination.mkdir(parents=True, exist_ok=True)
config = json.loads((source / "model.json").read_text(encoding="utf-8"))
for key in ("networkInfoPath", "emotionDatabasePath", "modelConfigPath", "modelDataPath"):
    config[key] = (source / config[key]).as_posix()
config["networkPath"] = (destination / "network.trt").as_posix()
for part in config["blendshapePaths"].values():
    for key in ("config", "data"):
        part[key] = (source / part[key]).as_posix()
(destination / "model.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
print(destination / "model.json")

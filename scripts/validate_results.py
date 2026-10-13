"""Validate real SDK output, prepare waveform data, and record local measurements."""
import json
import math
import struct
import wave
from pathlib import Path

root = Path(__file__).resolve().parents[1]
results = []
for filename in ("chinese-probe-60fps.json", "chinese-probe.json", "chinese-probe-60fps-chunked.json"):
    path = root / "outputs" / filename
    data = json.loads(path.read_text(encoding="utf-8"))
    frames, names = data["frames"], data["blendshape_names"]
    assert len(frames) == data["frame_count"]
    assert len(names) == data["weight_count"] == 68 and len(set(names)) == 68
    assert abs(len(frames) - data["audio_seconds"] * data["fps"]) < 1
    for previous, current in zip(frames, frames[1:]):
        assert previous["time"] < current["time"]
        assert abs(current["time"] - previous["time"] - 1 / data["fps"]) < 1 / data["sample_rate"]
    for frame in frames:
        assert len(frame["weights"]) == 68 and all(math.isfinite(v) for v in frame["weights"])
        assert all(-1e-5 <= v <= 1.00001 for v in frame["weights"])
    stats = {}
    for i, name in enumerate(names):
        values = [f["weights"][i] for f in frames]
        stats[name] = {"min": min(values), "max": max(values), "mean": sum(values) / len(values)}
    assert stats["jawOpen"]["max"] - stats["jawOpen"]["min"] > .2
    assert stats["mouthFunnel"]["max"] > .1 and stats["mouthClose"]["max"] > .1
    measurement = {key: value for key, value in data.items() if key not in ("frames", "blendshape_names", "explicit_emotions")}
    measurement.update(file=filename, channel_statistics=stats, validation="passed")
    results.append(measurement)

with wave.open(str(root / "audio/chinese-probe.wav"), "rb") as wav:
    assert wav.getframerate() == 16000 and wav.getnchannels() == 1 and wav.getsampwidth() == 2
    samples = struct.unpack("<" + "h" * wav.getnframes(), wav.readframes(wav.getnframes()))
step = 320
rms = [math.sqrt(sum((v / 32768) ** 2 for v in samples[i:i+step]) / len(samples[i:i+step]))
       for i in range(0, len(samples), step)]
waveform = {"step_seconds": step / 16000, "duration": len(samples) / 16000, "rms": rms,
            "transcript": "爸爸把杯子摆好了。我去取一杯热水。嗯，我想一想。好吧，我们慢慢说。啊，衣，乌，诶，哦。",
            "voice": "Microsoft Huihui Desktop, zh-CN, local test voice"}
(root / "outputs/waveform.json").write_text(json.dumps(waveform, ensure_ascii=False), encoding="utf-8")
report = {"validation": "passed", "measurements": results,
          "limits": ["Chunk tests deliver audio without wall-clock pacing; they measure readiness, not end-to-end conversation latency.",
                     "Warm-up, GPU clock, renderer activity, and CPU scheduling affect timings; these are local single-run observations.",
                     "Explicit emotions are zero; no automatic emotion recognition is claimed.",
                     "PMX retargeting is an approximate hand-tuned mapping, not a trained 68-channel character rig."]}
(root / "outputs/validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"validation": "passed", "runs": [{k: r[k] for k in ("file", "fps", "frame_count", "inference_seconds", "first_output_after_audio_seconds")} for r in results]}, indent=2))

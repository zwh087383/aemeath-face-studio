"""Add observation to the existing tested campaign driver, without action commands."""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "outputs/action-preservation-live-20261028"
driver = (ROOT / "realtime/character-campaign/run-browser.js").read_text(encoding="utf-8-sig")
probe = (HERE / "probe.js").read_text(encoding="utf-8-sig")
replacements = {
    "  const api=window.characterCenter,": probe + "\n  await installLiveProbe();\n  const api=window.characterCenter,",
    "   await sleep(3500);result.phase='finishing';": "   result.phase='observe_autonomous_continuation';await publish();await sleep(15000);result.phase='finishing';",
    "   await post('/api/campaign/observations',result);await publish();": "   result.liveProbe=window.liveProbe.finish();\n   await post('/api/campaign/observations',result);await publish();",
    "const {samples,bodyEvents,...rest}=result;": "const {samples,bodyEvents,liveProbe,...rest}=result;",
}
for old, new in replacements.items():
    assert driver.count(old) == 1, "source_driver_contract_changed"
    driver = driver.replace(old, new)
path = OUT / "run-browser.generated.js"
path.write_text(driver, encoding="utf-8")
(OUT / "driver-source.json").write_text(json.dumps({"generatedSha256":hashlib.sha256(path.read_bytes()).hexdigest(),
    "originalDriverSha256":hashlib.sha256((ROOT/"realtime/character-campaign/run-browser.js").read_bytes()).hexdigest(),
    "instrumentationOnly":True,"tailObservationSeconds":15,"manualActionCommands":False},indent=2),encoding="utf-8")
print("Generated read-only instrumented browser driver; no model called.")

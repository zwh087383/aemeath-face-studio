"""Protocol hot-path isolation and invalidation, with local catalogues only."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path

import pytest


HERE = Path(__file__).resolve().parents[1] / "character-center"


@pytest.fixture
def protocol():
    spec = importlib.util.spec_from_file_location("character_protocol_cache_test", HERE / "protocol.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rows():
    return [{"id": "gesture:test", "executor": "conversation", "geometry": {"private": [1, 2, 3]},
             "performanceContract": {"variant_set": ["exact"], "micro_set": [], "total_seconds": False}}]


def packet(action="gesture:test"):
    return json.dumps({"operation": "append", "actions": [
        {"action": action, "anchor": "immediate", "performance": {"variant_set": ["exact"]}}]})


def write_catalog(path, value):
    previous = path.stat() if path.exists() else None
    path.write_text(json.dumps({"actions": value}), encoding="utf-8")
    if previous:
        # Explicitly advance the recorded version, including on coarse filesystems.
        os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns + 1_000_000))


def test_public_results_and_tools_cannot_mutate_the_private_file_cache(protocol, tmp_path, monkeypatch):
    path = tmp_path / "catalog.json"
    original = rows()
    write_catalog(path, original)
    monkeypatch.setattr(protocol, "_CATALOG_PATH", path)
    first = protocol.load_catalog()
    first[0]["id"] = "injected"
    first[0]["geometry"]["private"].append(999)
    first[0]["performanceContract"]["variant_set"].clear()
    assert protocol.load_catalog() == original
    tool = protocol.tools()
    tool[1]["function"]["parameters"]["properties"]["actions"]["items"]["properties"]["action"]["enum"].append("injected")
    assert "injected" not in protocol.tools()[1]["function"]["parameters"]["properties"]["actions"]["items"]["properties"]["action"]["enum"]
    parsed = protocol.parse_actions(packet())
    parsed["actions"][0]["performance"]["variant_set"].clear()
    assert protocol.parse_actions(packet())["actions"][0]["performance"] == {"variant_set": ["exact"]}
    with pytest.raises(ValueError, match="invalid_action"):
        protocol.parse_actions(packet("injected"))


@pytest.mark.parametrize("wrapped", [False, True])
def test_explicit_catalogue_is_not_modified_or_retained_and_geometry_is_not_copied(protocol, wrapped):
    original = rows()
    value = {"actions": original} if wrapped else original
    before = deepcopy(value)
    protocol.parse_actions(packet(), value)
    protocol.tools(value)
    assert value == before
    public = protocol.load_catalog(value)
    public[0]["geometry"]["private"].clear()
    assert value == before
    class UncopyableGeometry:
        def __deepcopy__(self, memo):
            raise AssertionError("validation copied irrelevant source geometry")
    original[0]["geometry"] = UncopyableGeometry()
    assert protocol.parse_actions(packet(), value)["actions"][0]["delay_ms"] == 0
    protocol.tools(value)
    original[0]["performanceContract"]["variant_set"].clear()
    with pytest.raises(ValueError, match="unsupported_performance_variant_set"):
        protocol.parse_actions(packet(), value)
    original.append({"id": "gesture:test"})
    with pytest.raises(ValueError, match="invalid_catalog_ids"):
        protocol.parse_actions(packet(), value)


def test_resolved_paths_share_cache_and_mtime_or_size_updates_are_observed(protocol, tmp_path, monkeypatch):
    path = tmp_path / "catalog.json"
    write_catalog(path, rows())
    monkeypatch.setattr(protocol, "_CATALOG_PATH", path)
    read_text, reads = Path.read_text, []
    def track_read(self, *args, **kwargs):
        if self.resolve() == path.resolve():
            reads.append(str(self))
        return read_text(self, *args, **kwargs)
    monkeypatch.setattr(Path, "read_text", track_read)
    protocol.parse_actions(packet())
    protocol.parse_actions(packet(), str(path))
    protocol.parse_actions(packet(), path.parent / "." / path.name)
    protocol.load_catalog(path)
    assert len(reads) == 1
    replacement = rows()
    replacement[0]["id"] = "gesture:next"  # Same byte length, changed mtime.
    write_catalog(path, replacement)
    assert protocol.parse_actions(packet("gesture:next"), path)["actions"][0]["action"] == "gesture:next"
    with pytest.raises(ValueError, match="invalid_action"):
        protocol.parse_actions(packet(), path)
    assert len(reads) == 2
    stamp = path.stat()
    replacement.append({"id": "gesture:extra"})
    path.write_text(json.dumps({"actions": replacement}), encoding="utf-8")
    os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))  # Same mtime, changed size.
    assert len(protocol.load_catalog(path)) == 2
    assert len(reads) == 3


def test_invalid_or_deleted_new_file_version_never_uses_last_good_catalogue(protocol, tmp_path):
    path = tmp_path / "catalog.json"
    write_catalog(path, rows())
    protocol.parse_actions(packet(), path)
    write_catalog(path, [{"id": "gesture:test"}, {"id": "gesture:test"}])
    with pytest.raises(ValueError, match="invalid_catalog_ids"):
        protocol.parse_actions(packet(), path)
    write_catalog(path, rows())
    protocol.parse_actions(packet(), path)
    path.unlink()
    with pytest.raises(FileNotFoundError):
        protocol.parse_actions(packet(), path)


@pytest.mark.parametrize("catalogue", [[], {}, [None], [{"id": ""}], [{"id": True}], [{"id": []}], [{"id": "a"}, {"id": "a"}]])
def test_invalid_definition_ids_are_rejected_by_both_read_and_validation_paths(protocol, catalogue):
    with pytest.raises(ValueError, match="invalid_catalog"):
        protocol.load_catalog(catalogue)
    with pytest.raises(ValueError, match="invalid_catalog"):
        protocol.parse_actions(packet(), catalogue)
    with pytest.raises(ValueError, match="invalid_catalog"):
        protocol.tools(catalogue)


def test_performance_module_is_loaded_once_across_rows_and_packets(protocol, monkeypatch):
    original, loads = protocol.importlib.util.spec_from_file_location, []
    def spy(name, filename, *args, **kwargs):
        if Path(filename).resolve() == (HERE / "performance.py").resolve():
            loads.append(str(filename))
        return original(name, filename, *args, **kwargs)
    monkeypatch.setattr(protocol.importlib.util, "spec_from_file_location", spy)
    value = json.loads(packet())
    value["actions"] *= 8
    for _ in range(3):
        assert len(protocol.parse_actions(json.dumps(value), rows())["actions"]) == 8
    assert len(loads) == 1

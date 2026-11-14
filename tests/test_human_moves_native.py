"""Run the actual Swift move classifier without accessing Reminders."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.skipif(sys.platform != "darwin" or not shutil.which("swiftc"), reason="macOS Swift")
def test_native_move_results(tmp_path):
    source = Path(__file__).resolve().parents[1] / "native" / "reminders-helper"
    main = tmp_path / "main.swift"
    main.write_text('''import Foundation
let before: [String: Any] = ["id": "parent", "calendarId": "source",
                           "title": "Parent", "modified": "a"]
var desired = before; desired["calendarId"] = "destination"
let moved = try verifiedHumanMove(before, desired, desired, nil)
assert(same(moved, desired))
for error: String? in [nil, "synchronous save rejected"] {
    do { _ = try verifiedHumanMove(before, desired, before, error); fatalError("accepted refusal") }
    catch HelperError.moveRefused(_, let current) { assert(same(current, before)) }
}
for field in ["title", "id", "calendarId"] {
    var partial = before; partial[field] = "unexpected"
    do { _ = try verifiedHumanMove(before, desired, partial, nil); fatalError("partial") }
    catch HelperError.uncertain { }
}
var missing = before; missing.removeValue(forKey: "title")
do { _ = try verifiedHumanMove(before, desired, missing, nil); fatalError("missing") }
catch HelperError.uncertain { }
var start = DateComponents()
start.timeZone = TimeZone(identifier: "America/New_York")
try validateHumanDue(nil, nil, recurring: false)
try validateHumanDue(DateComponents(), nil, recurring: false)
try validateHumanDue(start, start, recurring: true)
try validateHumanDue(start, nil, recurring: false)
for (source, due, recurring): (DateComponents?, DateComponents?, Bool) in [
    (nil, nil, true), (start, nil, true), (DateComponents(), start, false),
    (start, DateComponents(), false)
] {
    do { try validateHumanDue(source, due, recurring: recurring); fatalError("unsafe due allowed") }
    catch HelperError.badRequest { }
}
print("move checks passed")
''')
    binary = tmp_path / "moves"
    subprocess.run(["swiftc", *[str(p) for p in source.glob("*.swift") if p.name != "main.swift"],
                    str(main), "-o", str(binary)], check=True, capture_output=True)
    result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
    assert "move checks passed" in result.stdout

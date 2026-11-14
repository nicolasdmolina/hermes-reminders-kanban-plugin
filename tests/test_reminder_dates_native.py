"""Exercise date validation in Swift without requesting Reminders access."""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.skipif(sys.platform != "darwin" or not shutil.which("swiftc"), reason="macOS Swift")
def test_native_date_semantics(tmp_path):
    source = Path(__file__).resolve().parents[1] / "native" / "reminders-helper"
    main = tmp_path / "main.swift"
    main.write_text('''
import Foundation
func date(_ day: Int, _ hour: Int) -> [String: Any] {
    ["calendar": "gregorian", "year": 2030, "month": 3, "day": day,
     "hour": hour, "minute": 0, "timeZone": "America/New_York"]
}
let before = try parseDue(date(9, 9))!
let after = try parseDue(date(10, 9))!
assert(after.date!.timeIntervalSince(before.date!) == 23 * 3600)
let allDay = try parseDue(["calendar": "gregorian", "year": 2030, "month": 11, "day": 3])!
assert(allDay.hour == nil && allDay.timeZone == nil)
assert(try parseDue(NSNull()) == nil)
for invalid: [String: Any] in [
    date(10, 2),
    ["calendar": "gregorian", "year": 2030, "month": 2, "day": 30],
    ["calendar": "hebrew", "year": 2030, "month": 1, "day": 1],
    ["calendar": "gregorian", "year": 2030, "month": 1, "day": 1, "hour": 9]
] {
    do { _ = try parseDue(invalid); fatalError("accepted invalid date") }
    catch HelperError.badRequest { }
}
print("native date checks passed")
'''.replace('assert(try parseDue(NSNull()) == nil)',
            'let cleared = try parseDue(NSNull()); assert(cleared == nil)'))
    binary = tmp_path / "date-tests"
    subprocess.run([
        "swiftc", str(source / "Support.swift"), str(source / "Read.swift"),
        str(source / "Edit.swift"), str(source / "Complete.swift"), str(main), "-o", str(binary),
    ], check=True, capture_output=True, text=True)
    result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
    assert "native date checks passed" in result.stdout

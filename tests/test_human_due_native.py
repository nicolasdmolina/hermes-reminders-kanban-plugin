"""Check the production due assignment and pre-save gates without live writes."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.skipif(sys.platform != "darwin" or not shutil.which("swiftc"), reason="macOS Swift")
def test_native_due_assignment(tmp_path):
    source = Path(__file__).resolve().parents[1] / "native" / "reminders-helper"
    main = tmp_path / "main.swift"
    main.write_text('''import Foundation
import EventKit
let store = EKEventStore()
let all: [String: Any] = ["calendar": "gregorian", "year": 2030, "month": 3, "day": 9]
var timed = all; timed["hour"] = 9; timed["minute"] = 0
 timed["timeZone"] = "America/New_York"
for initial: Any in [NSNull(), all, timed] {
    for target: Any in [NSNull(), all, timed] {
        let r = EKReminder(eventStore: store)
        r.startDateComponents = try parseDue(initial)
        r.title = "Preserve title"
        r.notes = "Preserve notes"
        r.url = URL(string: "https://example.invalid/keep")
        r.priority = 5
        r.alarms = [EKAlarm(absoluteDate: Date(timeIntervalSince1970: 4102444800))]
        let before = components(r.startDateComponents)
        let clearsStart = target is NSNull && r.startDateComponents?.timeZone != nil
        let desired = try parseDue(target)
        let allowed = target is NSNull || r.startDateComponents == nil ||
            r.startDateComponents?.timeZone == desired?.timeZone
        do {
            try humanPatch(["due": target], r, store)
            assert(allowed)
            let expectedStart: Any? = clearsStart ? NSNull() : before
            assert(same(expectedStart, components(r.startDateComponents)))
            assert(r.title == "Preserve title" && r.notes == "Preserve notes")
            assert(r.url?.absoluteString == "https://example.invalid/keep" && r.priority == 5)
            assert(r.alarms?.count == 1)
            assert(r.alarms?.first?.absoluteDate == Date(timeIntervalSince1970: 4102444800))
            assert(verifiedEqual("due", components(desired), components(r.dueDateComponents)))
        } catch HelperError.badRequest { assert(!allowed) }
    }
}
print("due checks passed")
''')
    binary = tmp_path / "due"
    subprocess.run(["swiftc", *[str(p) for p in source.glob("*.swift") if p.name != "main.swift"],
                    str(main), "-o", str(binary)], check=True, capture_output=True)
    result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
    assert "due checks passed" in result.stdout

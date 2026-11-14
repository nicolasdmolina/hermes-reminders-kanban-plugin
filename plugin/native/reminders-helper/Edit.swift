import EventKit
import Foundation
import CoreFoundation
import CoreLocation

// Production writes stay closed until opaque attachment/subtask preservation is proved.
func proofList(_ id: String, _ store: EKEventStore) throws -> EKCalendar {
    guard let c = store.calendar(withIdentifier: id), c.allowedEntityTypes.contains(.reminder),
          c.allowsContentModifications else { throw HelperError.badRequest("Writable reminder list required") }
    return c
}

func requireProof(_ request: [String: Any], _ r: EKReminder? = nil) throws -> String {
    guard let token = request["proofToken"] as? String, UUID(uuidString: token) != nil else {
        throw HelperError.badRequest("Production writes gated pending preservation proof; fixture proofToken required")
    }
    if let r {
        guard ["RK Test", "RK Test 2"].contains(r.calendar.title), (r.title ?? "").hasPrefix("[RK-02] "),
              (r.notes ?? "").contains(token) else {
            throw HelperError.badRequest("Not an owned RK-02 fixture")
        }
    }
    return token
}

func parseDue(_ value: Any) throws -> DateComponents? {
    if value is NSNull { return nil }
    guard let d = value as? [String: Any],
          Set(d.keys).isSubset(of: ["year", "month", "day", "hour", "minute", "timeZone", "calendar"]),
          d["calendar"] as? String == "gregorian",
          let year = d["year"] as? Int, (1900...9999).contains(year),
          let month = d["month"] as? Int, let day = d["day"] as? Int else {
        throw HelperError.badRequest("Gregorian date components required")
    }
    var c = DateComponents()
    c.calendar = Calendar(identifier: .gregorian)
    c.year = year; c.month = month; c.day = day
    if d["hour"] != nil || d["minute"] != nil || d["timeZone"] != nil {
        guard let hour = d["hour"] as? Int, let minute = d["minute"] as? Int,
              let zone = d["timeZone"] as? String, let tz = TimeZone(identifier: zone),
              (0...23).contains(hour), (0...59).contains(minute) else {
            throw HelperError.badRequest("Timed dates require hour, minute, and IANA timeZone")
        }
        c.hour = hour; c.minute = minute; c.second = 0; c.timeZone = tz
    }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = c.timeZone ?? TimeZone(secondsFromGMT: 0)!
    guard let date = calendar.date(from: c) else { throw HelperError.badRequest("Invalid date") }
    let roundtrip = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    guard roundtrip.year == year, roundtrip.month == month, roundtrip.day == day,
          c.hour == nil || (roundtrip.hour == c.hour && roundtrip.minute == c.minute) else {
        throw HelperError.badRequest("Invalid or nonexistent local date/time")
    }
    return c
}

func applyPatch(_ patch: [String: Any], _ r: EKReminder, _ store: EKEventStore) throws {
    guard !patch.isEmpty, Set(patch.keys).isSubset(of: ["title", "notes", "priority", "due", "calendarId"]) else {
        throw HelperError.badRequest("Only title, notes, priority, due and calendarId are editable")
    }
    for (key, value) in patch {
        switch key {
        case "title":
            guard let text = value as? String, text.hasPrefix("[RK-02] ") else {
                throw HelperError.badRequest("RK-02 title required during proof")
            }
            r.title = text
        case "notes":
            guard value is NSNull || value is String else { throw HelperError.badRequest("notes must be text or null") }
            r.notes = value as? String
        case "priority":
            guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                  n.doubleValue == Double(n.intValue), [0, 1, 5, 9].contains(n.intValue) else {
                throw HelperError.badRequest("priority must be 0, 1, 5 or 9")
            }
            r.priority = n.intValue
        case "due":
            let due = try parseDue(value)
            if let existing = r.dueDateComponents {
                guard let due, (existing.hour == nil) == (due.hour == nil) else {
                    throw HelperError.badRequest("Due clearing and all-day/timed conversion await preserving proof")
                }
            }
            r.dueDateComponents = due
        case "calendarId":
            guard let id = value as? String else { throw HelperError.badRequest("calendarId required") }
            let destination = try proofList(id, store)
            guard destination.title == "RK Test" ||
                  destination.title == "RK Test 2" else {
                throw HelperError.badRequest("Destination is not a designated proof list")
            }
            r.calendar = destination
        default: break
        }
    }
}

func saveAndRead(_ r: EKReminder, _ store: EKEventStore) throws -> [String: Any] {
    do { try store.save(r, commit: true) }
    catch { throw HelperError.uncertain("Save failed; reread before retry: \(error)", current: nil) }
    let id = r.calendarItemIdentifier
    let fresh = EKEventStore()
    guard let current = fresh.calendarItem(withIdentifier: id) as? EKReminder else {
        throw HelperError.uncertain("Saved reminder could not be reread", current: nil)
    }
    return snapshot(current)
}

func createReminder(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let token = try requireProof(request)
    guard let id = request["calendarId"] as? String, let patch = request["fields"] as? [String: Any],
          patch["title"] is String, (patch["notes"] as? String ?? "").contains(token),
          patch["calendarId"] == nil else { throw HelperError.badRequest("List, title and token-bearing notes required") }
    let r = EKReminder(eventStore: store)
    r.calendar = try proofList(id, store)
    guard r.calendar.title == "RK Test" else { throw HelperError.badRequest("Only RK Test fixtures permitted") }
    try applyPatch(patch, r, store)
    if request["complexFixture"] as? Bool == true {
        r.url = URL(string: "https://example.invalid/original")
        r.recurrenceRules = [EKRecurrenceRule(recurrenceWith: .monthly, interval: 1,
            daysOfTheWeek: [EKRecurrenceDayOfWeek(.monday), EKRecurrenceDayOfWeek(.friday)],
            daysOfTheMonth: nil, monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil,
            setPositions: [1, -1], end: EKRecurrenceEnd(occurrenceCount: 5))]
        // Far future absolute alarm avoids notifications during the bounded proof.
        let geofence = EKAlarm()
        let location = EKStructuredLocation(title: "RK-02 synthetic South Pole")
        location.geoLocation = CLLocation(latitude: -89, longitude: 0)
        location.radius = 100
        geofence.structuredLocation = location
        geofence.proximity = .enter
        r.alarms = [EKAlarm(absoluteDate: Date(timeIntervalSince1970: 4102444800)), geofence]
    }
    if var start = r.dueDateComponents {
        if start.hour == nil {
            start.hour = 0; start.minute = 0; start.second = 0
            start.isLeapMonth = nil
        } else { start.isLeapMonth = false }
        r.startDateComponents = start
    }
    let desired = snapshot(r)
    let current = try saveAndRead(r, store)
    let ignored: Set<String> = ["id", "externalId", "created", "modified"]
    let changed = desired.keys.filter { !ignored.contains($0) && !verifiedEqual($0, desired[$0], current[$0]) }
    guard changed.isEmpty else { throw HelperError.uncertain("Create verification failed: \(changed.sorted())", current: current) }
    return ["current": current, "requested": patch, "preservationFailures": []]
}

func same(_ a: Any?, _ b: Any?) -> Bool {
    NSDictionary(dictionary: ["value": a ?? NSNull()]).isEqual(to: ["value": b ?? NSNull()])
}

func verifiedEqual(_ key: String, _ expected: Any?, _ actual: Any?) -> Bool {
    // EventKit toggles nil/false isLeapMonth on assigned Gregorian due components.
    // This flag has no semantic distinction for Gregorian dates; keep source snapshots exact.
    if key == "due", var a = expected as? [String: Any], var b = actual as? [String: Any],
       a["calendar"] as? String == "gregorian", b["calendar"] as? String == "gregorian",
       (a["isLeapMonth"] is NSNull || a["isLeapMonth"] as? Bool == false),
       (b["isLeapMonth"] is NSNull || b["isLeapMonth"] as? Bool == false) {
        a.removeValue(forKey: "isLeapMonth"); b.removeValue(forKey: "isLeapMonth")
        return same(a, b)
    }
    return same(expected, actual)
}

func editReminder(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    let token = try requireProof(request, r)
    guard let expected = request["expected"] as? [String: Any], let patch = request["patch"] as? [String: Any] else {
        throw HelperError.badRequest("Full expected snapshot and patch required")
    }
    if let notes = patch["notes"], !(notes as? String ?? "").contains(token) {
        throw HelperError.badRequest("Keep fixture token in notes for retirement")
    }
    guard r.refresh() else { throw HelperError.notFound("Reminder disappeared") }
    let before = snapshot(r)
    guard NSDictionary(dictionary: before).isEqual(to: expected) else {
        throw HelperError.conflict("Source changed; retain draft and compare current", current: before)
    }
    guard !r.isCompleted else { throw HelperError.conflict("Reminder is completed", current: before) }
    try applyPatch(patch, r, store)
    let desired = snapshot(r)
    let current = try saveAndRead(r, store)
    let failures = desired.keys.filter { $0 != "modified" && !verifiedEqual($0, desired[$0], current[$0]) }.sorted()
    guard failures.isEmpty else {
        throw HelperError.uncertain("Preservation/request verification failed: \(failures)", current: current)
    }
    return ["before": before, "current": current, "requested": patch, "preservationFailures": failures]
}

func retireEditFixture(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    _ = try requireProof(request, r)
    r.recurrenceRules = []; r.alarms = []; r.isCompleted = true
    let current = try saveAndRead(r, store)
    guard current["completed"] as? Bool == true,
          (current["rules"] as? [Any])?.isEmpty == true,
          (current["alarms"] as? [Any])?.isEmpty == true else {
        throw HelperError.uncertain("Retirement not verified", current: current)
    }
    return current
}

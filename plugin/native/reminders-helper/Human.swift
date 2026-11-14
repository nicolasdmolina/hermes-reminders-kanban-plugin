import EventKit
import Foundation

func validateHumanDue(_ start: DateComponents?, _ due: DateComponents?, recurring: Bool) throws {
    if due == nil && recurring {
        throw HelperError.badRequest("Repeating reminders need a date; change the repeat schedule in Apple Reminders")
    }
    if let start, let due, start.timeZone != due.timeZone {
        throw HelperError.badRequest("Due edit would change the source start time zone; edit in Reminders")
    }
}

// Creation has no pre-existing opaque fields to preserve.
func humanPatch(_ fields: [String: Any], _ r: EKReminder, _ store: EKEventStore) throws {
    var patch = fields
    if let title = patch.removeValue(forKey: "title") {
        guard let text = title as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HelperError.badRequest("Nonempty title required")
        }
        r.title = text
    }
    if let id = patch.removeValue(forKey: "calendarId") {
        guard let id = id as? String else { throw HelperError.badRequest("List required") }
        r.calendar = try proofList(id, store)
    }
    if let value = patch.removeValue(forKey: "due") {
        // Clear a zoned start with due; otherwise retain it before the single save.
        let start = r.startDateComponents
        let due = try parseDue(value)
        try validateHumanDue(start, due, recurring: !(r.recurrenceRules ?? []).isEmpty)
        r.dueDateComponents = due
        r.startDateComponents = due == nil && start?.timeZone != nil ? nil : start
    }
    if !patch.isEmpty { try applyPatch(patch, r, store) }
}

func humanCreate(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    guard let fields = request["fields"] as? [String: Any], fields["title"] is String,
          let id = fields["calendarId"] as? String else { throw HelperError.badRequest("Title and list required") }
    let r = EKReminder(eventStore: store)
    r.calendar = try proofList(id, store)
    try humanPatch(fields, r, store)
    if var start = r.dueDateComponents {
        if start.hour == nil { start.hour = 0; start.minute = 0; start.second = 0; start.isLeapMonth = nil }
        else { start.isLeapMonth = false }
        r.startDateComponents = start
    }
    let desired = snapshot(r)
    let current = try saveAndRead(r, store)
    let ignored: Set<String> = ["id", "externalId", "created", "modified"]
    guard desired.keys.allSatisfy({ ignored.contains($0) || verifiedEqual($0, desired[$0], current[$0]) }) else {
        throw HelperError.uncertain("Create verification failed", current: current)
    }
    return current
}

func humanFixture(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    guard let token = request["proofToken"] as? String, UUID(uuidString: token) != nil,
          ["RK Test", "RK Test 2"].contains(r.calendar.title),
          ["[RK-09] ", "[RK-31] ", "[RK-33] "].contains(where: { (r.title ?? "").hasPrefix($0) }), (r.notes ?? "").contains(token) else {
        throw HelperError.badRequest("Owned RK-09/RK-31/RK-33 fixture required")
    }
    if request["retire"] as? Bool == true {
        r.recurrenceRules = []; r.alarms = []; r.isCompleted = true
        return try saveAndRead(r, store)
    }
    guard let expected = request["expected"] as? [String: Any], r.refresh(),
          NSDictionary(dictionary: snapshot(r)).isEqual(to: expected), !r.isCompleted else {
        throw HelperError.conflict("Source changed", current: snapshot(r))
    }
    guard let patch = request["patch"] as? [String: Any],
          ["[RK-09] ", "[RK-31] ", "[RK-33] "].contains(where: { (patch["title"] as? String ?? r.title ?? "").hasPrefix($0) }),
          (patch["notes"] as? String ?? r.notes ?? "").contains(token) else {
        throw HelperError.badRequest("Keep fixture ownership markers")
    }
    if let id = patch["calendarId"] as? String {
        let c = try proofList(id, store)
        guard ["RK Test", "RK Test 2"].contains(c.title) else { throw HelperError.badRequest("Test lists only") }
    }
    return try saveHumanPatch(patch, r, store)
}

func saveHumanPatch(_ patch: [String: Any], _ r: EKReminder, _ store: EKEventStore) throws -> Any {
    let before = snapshot(r)
    try humanPatch(patch, r, store)
    let desired = snapshot(r)
    if let due = patch["due"] {
        let clearsStart = due is NSNull &&
            (before["start"] as? [String: Any])?["timeZone"] is String
        let expectedStart: Any? = clearsStart ? NSNull() : before["start"]
        guard same(expectedStart, desired["start"]),
              verifiedEqual("due", components(try parseDue(due)), desired["due"]) else {
            throw HelperError.badRequest("Due edit cannot preserve source components; edit in Reminders")
        }
    }
    if Set(patch.keys) == ["calendarId"] {
        // One synchronous save, never a copy or a compensating move.
        var saveError: String? = nil
        do { try store.save(r, commit: true) }
        catch { saveError = String(describing: error) }
        let fresh = EKEventStore()
        guard let saved = fresh.calendarItem(withIdentifier: r.calendarItemIdentifier) as? EKReminder else {
            throw HelperError.uncertain("Move could not be reread", current: nil)
        }
        return try verifiedHumanMove(before, desired, snapshot(saved), saveError)
    }
    let current = try saveAndRead(r, store)
    guard desired.keys.allSatisfy({ $0 == "modified" || verifiedEqual($0, desired[$0], current[$0]) }) else {
        throw HelperError.uncertain("Preservation verification failed", current: current)
    }
    return current
}

// RK-09 UI proof covers these edits only. EventKit cannot inspect opaque fields.
func humanEdit(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    guard let expected = request["expected"] as? [String: Any], r.refresh(),
          NSDictionary(dictionary: snapshot(r)).isEqual(to: expected), !r.isCompleted else {
        throw HelperError.conflict("Source changed", current: snapshot(r))
    }
    guard let patch = request["patch"] as? [String: Any], !patch.isEmpty,
          Set(patch.keys).isSubset(of: ["title", "notes", "priority", "calendarId", "due"]) else {
        throw HelperError.badRequest("Unsupported reminder edit")
    }
    if patch["calendarId"] != nil && patch.count != 1 {
        throw HelperError.badRequest("Move the reminder separately from other edits")
    }
    if let notes = patch["notes"] {
        guard let text = notes as? String, text.hasPrefix(r.notes ?? "") else {
            throw HelperError.badRequest("Only appended notes have preservation proof")
        }
    }
    return try saveHumanPatch(patch, r, store)
}

// Compare every exposed field, including identity. A refused move must leave
// the entire source unchanged; partial or unexpected results stay unresolved.
func verifiedHumanMove(_ before: [String: Any], _ desired: [String: Any],
                       _ current: [String: Any], _ saveError: String?) throws -> [String: Any] {
    func matches(_ expected: [String: Any]) -> Bool {
        Set(expected.keys) == Set(current.keys) && expected.keys.allSatisfy {
            $0 == "modified" || verifiedEqual($0, expected[$0], current[$0])
        }
    }
    if matches(desired) { return current }
    if matches(before) {
        throw HelperError.moveRefused("Couldn't move this reminder; move it in Reminders", current: current)
    }
    throw HelperError.uncertain("Move verification failed: \(saveError ?? "unexpected saved state")", current: current)
}


// Patch the original object so fields EventKit cannot expose are not rebuilt.
func humanReopen(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    guard let expected = request["expected"] as? [String: Any], r.refresh(),
          NSDictionary(dictionary: snapshot(r)).isEqual(to: expected),
          r.isCompleted, (r.recurrenceRules ?? []).isEmpty else {
        throw HelperError.conflict("Completed one-off source changed", current: snapshot(r))
    }
    r.isCompleted = false
    let current = try saveAndRead(r, store)
    let ignored: Set<String> = ["completed", "completedAt", "modified"]
    guard current["completed"] as? Bool == false, current["completedAt"] is NSNull,
          Set(current.keys) == Set(expected.keys),
          expected.keys.allSatisfy({ ignored.contains($0) || verifiedEqual($0, expected[$0], current[$0]) }) else {
        throw HelperError.uncertain("Reopen preservation verification failed", current: current)
    }
    return current
}

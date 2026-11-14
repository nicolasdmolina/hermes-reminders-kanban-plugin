import EventKit
import Foundation

func completionFetch(_ calendar: EKCalendar, _ store: EKEventStore) throws -> [EKReminder] {
    let semaphore = DispatchSemaphore(value: 0)
    var fetched: [EKReminder]?
    store.fetchReminders(matching: store.predicateForReminders(in: [calendar])) { values in
        fetched = values
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 10) == .success, let fetched else {
        throw NSError(domain: "prototype.fetch", code: 1)
    }
    return fetched
}

func completionRead(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    guard let calendarID = request["calendarId"] as? String else {
        throw HelperError.badRequest("calendarId required")
    }
    var read: [String: Any] = ["calendarIds": [calendarID]]
    if let related = request["relatedTo"] { read["relatedTo"] = related }
    return try readReminders(read, store)
}

func completeOccurrence(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    guard let expected = request["expected"] as? [String: Any],
          let id = expected["id"] as? String,
          let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw HelperError.notFound("Completion identity missing")
    }
    guard !reminder.isCompleted, reminder.refresh(),
          NSDictionary(dictionary: snapshot(reminder)).isEqual(to: expected) else {
        throw HelperError.conflict("Occurrence changed", current: snapshot(reminder))
    }
    // EventKit provides no atomic compare-and-save. Another client can still race here.
    reminder.isCompleted = true
    try store.save(reminder, commit: true)
    var receipt: [String: Any] = ["saved": true]
    if let rules = expected["rules"] as? [Any], rules.isEmpty {
        receipt["rows"] = [snapshot(reminder)]
    } else if let rows = try? completionRead(["calendarId": reminder.calendar.calendarIdentifier,
                                             "relatedTo": expected], store) {
        receipt["rows"] = rows
    }
    return receipt
}

// Synthetic fixtures only. These operations are not product create/edit operations.
func completionFixture(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    guard let run = request["run"] as? String, UUID(uuidString: run) != nil,
          let action = request["action"] as? String else {
        throw HelperError.badRequest("Fixture run UUID and action required")
    }
    let calendars = store.calendars(for: .reminder).filter {
        $0.title == "RK Test" && $0.allowsContentModifications
    }
    guard calendars.count == 1, let calendar = calendars.first else {
        throw HelperError.badRequest("One writable RK Test required")
    }
    let ticket = request["ticket"] as? String ?? "01"
    guard ["01", "33"].contains(ticket) else { throw HelperError.badRequest("Unsupported fixture ticket") }
    let title = "[RK-" + ticket + "] " + run
    let owned = try completionFetch(calendar, store).filter { $0.title == title }
    if action == "create" {
        guard owned.isEmpty else { throw HelperError.badRequest("Fixture exists") }
        let r = EKReminder(eventStore: store)
        r.calendar = calendar; r.title = title; r.notes = "Synthetic instructions " + run
        r.url = URL(string: "https://example.invalid/" + run)
        var due = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        due.calendar = Calendar(identifier: .gregorian)
        r.dueDateComponents = due; r.startDateComponents = due
        r.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .daily, interval: 1, end: nil))
        r.alarms = []
        try store.save(r, commit: true)
        return snapshot(r)
    }
    guard action == "retire", let ids = request["ids"] as? [String],
          Set(ids) == Set(owned.map { $0.calendarItemIdentifier }) else {
        throw HelperError.badRequest("Record all owned IDs before retirement")
    }
    for r in owned {
        r.recurrenceRules = []; r.alarms = []; r.isCompleted = true
        try store.save(r, commit: true)
    }
    return owned.map(snapshot)
}

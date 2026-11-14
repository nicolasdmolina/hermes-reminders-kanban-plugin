import EventKit
import Foundation

// Synthetic fixtures only. These operations are not product create/edit operations.
func occurrenceFixture(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
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
    let ticket = request["ticket"] as? Int ?? 20
    guard [20, 21, 22, 23, 24, 26, 27, 34, 35].contains(ticket) else { throw HelperError.badRequest("Invalid ticket") }
    // Tickets 21, 23 and 34's screen evidence uses a readable title; the run UUID in the notes marks ownership.
    let named = ticket == 21 || ticket == 23 || ticket == 34
    let name = named ? (request["name"] as? String ?? "") : ""
    guard !named || (!name.isEmpty && name.count <= 60 && !name.contains("\n")) else {
        throw HelperError.badRequest("Named fixtures need a short name")
    }
    let title = "[RK-\(ticket)] " + (named ? name : run)
    let owned = try completionFetch(calendar, store).filter {
        $0.title == title && (!named || ($0.notes ?? "").contains(run))
    }
    if action == "create" {
        guard owned.isEmpty else { throw HelperError.badRequest("Fixture exists") }
        let r = EKReminder(eventStore: store)
        r.calendar = calendar; r.title = title
        r.notes = named
            ? "Synthetic RK-\(ticket) test reminder. Reply with a short draft for review. Run " + run
            : "Synthetic verification only. Do not read files, use network, run terminal, or delegate. Immediately call kanban_request_review with summary RK20 verified. " + run
        r.url = URL(string: "https://example.invalid/" + run)
        let mode = request["mode"] as? String ?? "daily"
        var calendarDate = Calendar(identifier: .gregorian)
        calendarDate.timeZone = TimeZone(identifier: "America/New_York")!
        // "series": two daily occurrences, today and tomorrow, then the series ends.
        let offset = mode == "late" ? -8 : (mode == "early" ? 8 : 0)
        let date = calendarDate.date(byAdding: .day, value: offset, to: Date())!
        var due = calendarDate.dateComponents([.year, .month, .day], from: date)
        due.calendar = calendarDate
        if mode == "timed" || mode == "dst" {
            due.hour = 9; due.minute = 0; due.timeZone = calendarDate.timeZone
        }
        if mode == "near-next", ticket == 27 {
            let next = calendarDate.date(byAdding: .minute, value: 5, to: Date())!
            let previous = calendarDate.date(byAdding: .day, value: -1, to: next)!
            due = calendarDate.dateComponents([.year, .month, .day, .hour, .minute], from: previous)
            due.calendar = calendarDate; due.timeZone = calendarDate.timeZone
        }
        if mode == "dst" { due.year = 2027; due.month = 3; due.day = 13 }
        r.dueDateComponents = due; r.startDateComponents = due
        if mode == "complex" {
            r.addRecurrenceRule(EKRecurrenceRule(
                recurrenceWith: .monthly, interval: 1,
                daysOfTheWeek: [EKRecurrenceDayOfWeek(.monday, weekNumber: 1)],
                daysOfTheMonth: nil, monthsOfTheYear: nil, weeksOfTheYear: nil,
                daysOfTheYear: nil, setPositions: nil,
                end: EKRecurrenceEnd(occurrenceCount: 3)))
        } else {
            let last = mode == "series" ? calendarDate.date(byAdding: .day, value: 1, to: date)! : date
            r.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .daily, interval: 1,
                end: mode == "finite" || mode == "series"
                    ? EKRecurrenceEnd(end: calendarDate.startOfDay(for: last)) : nil))
        }
        r.alarms = []
        try store.save(r, commit: true)
        return snapshot(r)
    }
    if action == "shift", named {
        // Moves the owned pending occurrence's due date one day later, as an edit in Reminders would.
        guard let expected = request["expected"] as? [String: Any],
              let r = owned.first(where: { !$0.isCompleted }), r.refresh(),
              NSDictionary(dictionary: snapshot(r)).isEqual(to: expected),
              var due = r.dueDateComponents, let day = due.day else {
            throw HelperError.conflict("Source changed", current: nil)
        }
        due.day = day + 1
        r.dueDateComponents = due; r.startDateComponents = due
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

import EventKit
import Foundation

func testLists(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    guard let action = request["action"] as? String, ["setup", "teardown"].contains(action),
          Set(request.keys).isSubset(of: ["op", "action"]) else {
        throw HelperError.badRequest("test-lists requires setup or teardown; no list override allowed")
    }
    let calendars = store.calendars(for: .reminder).filter { testListTitles.contains($0.title) }
    // Preflight both lists, including completed reminders, before changing either one.
    for title in testListTitles {
        let matches = calendars.filter { $0.title == title }
        guard matches.count <= 1 else { throw HelperError.badRequest("Duplicate test list: \(title)") }
    }
    for calendar in calendars {
        guard calendar.allowsContentModifications else { throw HelperError.badRequest("Test list is read-only") }
        let reminders = try completionFetch(calendar, store)
        guard reminders.allSatisfy({ isTestFixtureTitle($0.title ?? "") }) else {
            throw HelperError.badRequest("Test list contains a non-fixture; refusing to change lists")
        }
    }
    if action == "setup" {
        let missing = testListTitles.filter { title in !calendars.contains { $0.title == title } }
        if !missing.isEmpty {
            guard let source = store.defaultCalendarForNewReminders()?.source else {
                throw HelperError.badRequest("No default Reminders source available")
            }
            for title in missing {
                let calendar = EKCalendar(for: .reminder, eventStore: store)
                calendar.title = title
                calendar.source = source
                try store.saveCalendar(calendar, commit: false)
            }
            try store.commit()
        }
    } else {
        for calendar in calendars { try store.removeCalendar(calendar, commit: false) }
        try store.commit()
    }
    return try listLists([:], store)
}

func listCounts(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    try store.calendars(for: .reminder).map { calendar -> [String: Any] in
        let reminders = try completionFetch(calendar, store)
        return ["id": calendar.calendarIdentifier, "title": calendar.title,
                "count": reminders.count, "completed": reminders.filter { $0.isCompleted }.count]
    }
}

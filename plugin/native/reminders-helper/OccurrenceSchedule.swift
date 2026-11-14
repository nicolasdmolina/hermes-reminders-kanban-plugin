import EventKit
import Foundation

// Resolve the actual source calendar, timezone and all-day components natively.
func occurrenceSchedule(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    guard let expected = request["expected"] as? [String: Any],
          canonical(snapshot(r)) == canonical(expected), !r.isCompleted,
          let components = r.dueDateComponents else {
        throw HelperError.badRequest("Current pending occurrence required")
    }
    var calendar = components.calendar ?? Calendar.current
    calendar.timeZone = components.timeZone ?? TimeZone.current
    guard let date = calendar.date(from: components) else {
        throw HelperError.badRequest("Unresolved source due date")
    }
    return ["due_at": date.timeIntervalSince1970]
}

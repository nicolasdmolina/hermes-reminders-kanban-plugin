import EventKit
import Foundation

// Only this run's recorded fixture IDs and UUID authorize source-signal proof writes.
func sourceFixture(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    guard let token = request["proofToken"] as? String, UUID(uuidString: token) != nil,
          ["RK Test", "RK Test 2"].contains(r.calendar.title),
          ["[RK-11] ", "[RK-24] ", "[RK-26] ", "[RK-27] "].contains(where: { (r.title ?? "").hasPrefix($0) }), (r.notes ?? "").contains(token) else {
        throw HelperError.badRequest("Owned RK-11, RK-24, RK-26 or RK-27 fixture required")
    }
    switch request["action"] as? String {
    case "delete":
        guard !["[RK-26] ", "[RK-27] "].contains(where: { (r.title ?? "").hasPrefix($0) }) else {
            throw HelperError.badRequest("RK-26/RK-27 fixtures must be retired")
        }
        let id = r.calendarItemIdentifier
        try store.remove(r, commit: true)
        return ["deleted": id]
    case "complete", "retire":
        r.recurrenceRules = []; r.alarms = []; r.isCompleted = true
    case "instructions":
        guard let text = request["notes"] as? String, text.contains(token) else {
            throw HelperError.badRequest("Keep ownership token")
        }
        r.notes = text
    default: throw HelperError.badRequest("Unknown fixture action")
    }
    return try saveAndRead(r, store)
}

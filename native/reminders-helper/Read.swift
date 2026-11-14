import EventKit
import Foundation

func maybe<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }
let snapshotDateFormatter = ISO8601DateFormatter()
func iso(_ date: Date?) -> Any { maybe(date.map { snapshotDateFormatter.string(from: $0) }) }
func components(_ value: DateComponents?) -> Any {
    guard let c = value else { return NSNull() }
    return ["year": maybe(c.year), "month": maybe(c.month), "day": maybe(c.day),
            "hour": maybe(c.hour), "minute": maybe(c.minute), "second": maybe(c.second),
            "timeZone": maybe(c.timeZone?.identifier), "calendar": maybe(c.calendar.map { String(describing: $0.identifier) }),
            "isLeapMonth": maybe(c.isLeapMonth)]
}
func snapshot(_ r: EKReminder) -> [String: Any] {
    ["id": r.calendarItemIdentifier, "externalId": maybe(r.calendarItemExternalIdentifier),
     "calendarId": r.calendar.calendarIdentifier, "calendarTitle": r.calendar.title,
     "title": r.title ?? "", "notes": maybe(r.notes), "url": maybe(r.url?.absoluteString),
     "location": maybe(r.location), "priority": r.priority, "completed": r.isCompleted,
     "created": iso(r.creationDate), "modified": iso(r.lastModifiedDate), "completedAt": iso(r.completionDate),
     "start": components(r.startDateComponents), "due": components(r.dueDateComponents),
     "alarms": (r.alarms ?? []).map { a -> [String: Any] in
         ["absoluteDate": iso(a.absoluteDate), "relativeOffset": a.relativeOffset,
          "proximity": a.proximity.rawValue, "locationTitle": maybe(a.structuredLocation?.title),
          "latitude": maybe(a.structuredLocation?.geoLocation?.coordinate.latitude),
          "longitude": maybe(a.structuredLocation?.geoLocation?.coordinate.longitude),
          "radius": maybe(a.structuredLocation?.radius)]
     }.sorted { canonical($0) < canonical($1) },
     "rules": (r.recurrenceRules ?? []).map { rule -> [String: Any] in
         ["frequency": rule.frequency.rawValue, "interval": rule.interval,
          "calendarIdentifier": rule.calendarIdentifier, "firstDayOfWeek": rule.firstDayOfTheWeek,
          "weekdays": (rule.daysOfTheWeek ?? []).map { ["day": $0.dayOfTheWeek.rawValue, "week": $0.weekNumber] },
          "monthDays": rule.daysOfTheMonth ?? [], "months": rule.monthsOfTheYear ?? [],
          "weeks": rule.weeksOfTheYear ?? [], "yearDays": rule.daysOfTheYear ?? [],
          "positions": rule.setPositions ?? [], "endDate": iso(rule.recurrenceEnd?.endDate),
          "endCount": maybe(rule.recurrenceEnd?.occurrenceCount)]
     }]
}

func reminder(_ request: [String: Any], _ store: EKEventStore) throws -> EKReminder {
    guard let id = request["id"] as? String else { throw HelperError.badRequest("id required") }
    guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
        throw HelperError.notFound("Reminder not found; do not substitute externalId")
    }
    return r
}

func readReminder(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    snapshot(try reminder(request, store))
}

func readReminders(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    guard let ids = request["calendarIds"] as? [String], !ids.isEmpty else {
        throw HelperError.badRequest("Explicit nonempty calendarIds required")
    }
    let calendars = try ids.map { id -> EKCalendar in
        guard let c = store.calendar(withIdentifier: id), c.allowedEntityTypes.contains(.reminder) else {
            throw HelperError.notFound("List not found")
        }
        return c
    }
    let done = DispatchSemaphore(value: 0)
    var result: [EKReminder]?
    store.fetchReminders(matching: store.predicateForReminders(in: calendars)) { values in
        result = values; done.signal()
    }
    guard done.wait(timeout: .now() + 15) == .success, let result else {
        throw HelperError.uncertain("Read timed out", current: nil)
    }
    let related = request["relatedTo"] as? [String: Any]
    let wantedLinks = (related?["notes"] as? String ?? "").components(separatedBy: "Open in Hermes: ")
        .dropFirst().compactMap { $0.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) }
    // The "Only on this Mac" claim line names its task by "(ref <owner>.<link>...": the two ids
    // are enough to find a copy, whatever follows them (start time, take over).
    let wantedRefs = (related?["notes"] as? String ?? "").components(separatedBy: "(ref ")
        .dropFirst().compactMap { text -> String? in
            let ids = text.prefix(while: { $0 != ")" && $0 != "~" && $0 != "," }).split(separator: ".")
            return ids.count >= 2 ? "(ref " + ids[0] + "." + ids[1] : nil
        }
    let relevant: [EKReminder] = result.filter { reminder in
        guard let related else { return true }
        if reminder.calendarItemIdentifier == (related["id"] as? String) { return true }
        if reminder.calendarItemExternalIdentifier == (related["externalId"] as? String) { return true }
        if let notes = related["notes"] as? String, !notes.isEmpty, reminder.notes == notes { return true }
        if let url = related["url"] as? String, !url.isEmpty, reminder.url?.absoluteString == url { return true }
        if wantedLinks.contains(where: { (reminder.notes ?? "").contains($0) }) { return true }
        if wantedRefs.contains(where: { (reminder.notes ?? "").contains($0) }) { return true }
        return reminder.title == (related["title"] as? String)
            && same(maybe(reminder.notes), related["notes"])
            && same(maybe(reminder.url?.absoluteString), related["url"])
    }
    return relevant.map(snapshot).sorted { ($0["id"] as! String) < ($1["id"] as! String) }
}

func canonical(_ value: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
}

import EventKit

func listLists(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    store.calendars(for: .reminder).map {
        ["id": $0.calendarIdentifier, "title": $0.title, "writable": $0.allowsContentModifications]
    }
}

import EventKit
import Foundation

// Write the owner's precomputed claim (claimNotes, Delegation.swift). Never rebuild the reminder
// or touch its URL.
func occurrenceLink(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    guard let expected = request["expected"] as? [String: Any] else {
        throw HelperError.badRequest("Exact appended task link required")
    }
    let notes = try claimNotes(request, expected)
    guard r.refresh(), NSDictionary(dictionary: snapshot(r)).isEqual(to: expected),
          !r.isCompleted, !(r.recurrenceRules ?? []).isEmpty else {
        throw HelperError.conflict("Source changed", current: snapshot(r))
    }
    r.notes = notes
    let desired = snapshot(r)
    let current = try saveAndRead(r, store)
    guard desired.keys.allSatisfy({ $0 == "modified" || verifiedEqual($0, desired[$0], current[$0]) }) else {
        throw HelperError.uncertain("Link preservation verification failed", current: current)
    }
    return current
}

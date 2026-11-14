import EventKit
import Foundation

// A claim line says which Hermes has the reminder (reminders_kanban/claims.py):
// "Open in Hermes: <task link>", or "In Hermes on <Mac name> (ref <owner>.<link>.<start>)" with
// the first eight hex digits of each id and the start time in base 36; a take over adds
// "~<owner>[~<n>]". The earlier form still reads: full ids, ", from <id>", ", take <n>".
let localClaim = try! NSRegularExpression(
    pattern: #"^In Hermes on .+ \(ref ([0-9A-Fa-f]{8}\.[0-9A-Fa-f]{8}\.[0-9a-z]{1,10}(~[0-9A-Fa-f]{8}(~[0-9]+)?)?|[0-9A-Fa-f-]{36}\.[0-9A-Fa-f-]{36}(, from [0-9A-Fa-f-]{36})?(, take [0-9]+)?)\)\s*$"#)

func isClaimLine(_ line: String) -> Bool {
    if line.hasPrefix("Open in Hermes: ") {
        // Trailing space of any kind, a carriage return included (notes pasted with CRLF).
        let rest = line.dropFirst("Open in Hermes: ".count).trimmingCharacters(in: .whitespacesAndNewlines)
        return !rest.isEmpty && !rest.contains(where: { $0.isWhitespace })
    }
    return localClaim.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
}

let inlineLink = try! NSRegularExpression(pattern: #"Open in Hermes: \S+"#)

// A line a person typed onto a task link, without the link: their words, less the spaces and
// tabs left at its ends. nil when the line holds no link.
func withoutInlineLinks(_ line: String) -> String? {
    let range = NSRange(line.startIndex..., in: line)
    guard inlineLink.firstMatch(in: line, range: range) != nil else { return nil }
    return inlineLink.stringByReplacingMatches(in: line, range: range, withTemplate: "")
        .trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
}

// The reminder's own text: its notes without claim lines and the blank lines leading up to them.
// inline: links inside other text go too (reminders_kanban/claims.py `without`).
func withoutClaims(_ notes: String, inline: Bool = false) -> String {
    var kept: [String] = []
    for line in notes.components(separatedBy: "\n") {
        let cut = isClaimLine(line) ? "" : (inline ? withoutInlineLinks(line) : nil) ?? line
        // (What is left of a line once its link is off may itself be a claim line.)
        if isClaimLine(line) || isClaimLine(cut) || (cut.isEmpty && cut != line) {
            while let last = kept.last, last.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { kept.removeLast() }
        } else {
            kept.append(cut)
        }
    }
    var text = kept.joined(separator: "\n")
    while let last = text.last, last.isWhitespace { text.removeLast() }
    return text
}

func httpsLink(_ url: String) -> Bool {
    guard let parsed = URLComponents(string: url) else { return false }
    return parsed.scheme == "https" && parsed.host != nil && parsed.user == nil && parsed.password == nil
}

// The notes a claim write may save. With `url` (the earlier request shape): exactly the expected
// notes plus that appended link. Without: Python supplies the whole notes, and only claim lines
// may differ from the expected ones (added, replaced or removed); the reminder's own text may not,
// except that a link typed onto a line of it may be taken off that line.
func claimNotes(_ request: [String: Any], _ expected: [String: Any]) throws -> String {
    guard let notes = request["notes"] as? String else {
        throw HelperError.badRequest("Exact appended task link required")
    }
    let before = expected["notes"] as? String ?? ""
    if let url = request["url"] as? String {
        guard httpsLink(url), notes == before + "\n\nOpen in Hermes: " + url else {
            throw HelperError.badRequest("Exact appended task link required")
        }
        return notes
    }
    // Compared without trailing space: taking a line off also trims the end of the notes.
    let had = Set(before.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) })
    let added = notes.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { isClaimLine($0) && !had.contains($0) }
    // A link a person typed onto may come off its line; none may be put inside other text.
    let links = { (text: String) in text.components(separatedBy: "Open in Hermes: ").count - 1 }
    let same = withoutClaims(notes) == withoutClaims(before)
        || (withoutClaims(notes, inline: true) == withoutClaims(before, inline: true)
            && links(notes) <= links(before) + added.count)
    guard notes != before, same,
          added.allSatisfy({ !$0.hasPrefix("Open in Hermes: ")
              || httpsLink(String($0.dropFirst("Open in Hermes: ".count))) }) else {
        throw HelperError.badRequest("Only claim lines may change")
    }
    return notes
}

// Write the owner's precomputed claim, comparing against the notes it read. Never rebuild the
// reminder or touch its URL.
func delegationLink(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    guard let expected = request["expected"] as? [String: Any] else {
        throw HelperError.badRequest("Exact appended task link required")
    }
    let notes = try claimNotes(request, expected)
    guard r.refresh(), NSDictionary(dictionary: snapshot(r)).isEqual(to: expected),
          !r.isCompleted, (r.recurrenceRules ?? []).isEmpty else {
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

// Retirement is limited to the recorded synthetic one-off proof.
func delegationRetire(_ request: [String: Any], _ store: EKEventStore) throws -> Any {
    let r = try reminder(request, store)
    guard let token = request["proofToken"] as? String, UUID(uuidString: token) != nil,
          ["RK Test", "RK Test 2"].contains(r.calendar.title),
          (r.title ?? "").hasPrefix("[RK-12] "), (r.notes ?? "").contains(token) else {
        throw HelperError.badRequest("Owned RK-12 fixture required")
    }
    r.recurrenceRules = []; r.alarms = []; r.isCompleted = true
    return try saveAndRead(r, store)
}

import EventKit
import Foundation

// One request per launch: reads a JSON request file, writes a JSON response file.
// Request: {"op": "<name>", ...op fields}. Response: {"ok": true, "result": ...}
// or {"ok": false, "error": {"code": "...", "message": "..."}}.
// Each op group lives in its own file; register its handlers in this table.
let handlers: [String: Handler] = [
    "occurrence-schedule": occurrenceSchedule,
    "occurrence-link": occurrenceLink,
    "occurrence-fixture": occurrenceFixture,
    "delegation-link": delegationLink,
    "delegation-retire": delegationRetire,
    "source-fixture": sourceFixture,
    "human-create": humanCreate,
    "human-edit": humanEdit,
    "human-reopen": humanReopen,
    "human-fixture": humanFixture,
    "test-lists": testLists,
    "list-counts": listCounts,
    "lists": listLists,
    "completion-read": completionRead,
    "complete-occurrence": completeOccurrence,
    "completion-fixture": completionFixture,
    "read": readReminder,
    "read_many": readReminders,
    "create": createReminder,
    "edit": editReminder,
    "rk02_retire": retireEditFixture,
]

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("usage: reminders-helper <request.json> <response.json>\n".data(using: .utf8)!)
    exit(64)
}
let responseURL = URL(fileURLWithPath: args[2])

func respond(_ body: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
        ?? Data(#"{"ok":false,"error":{"code":"encoding_failed","message":"response not JSON-serializable"}}"#.utf8)
    try? data.write(to: responseURL, options: .atomic)
    exit(0)
}

let store = EKEventStore()
let accessDone = DispatchSemaphore(value: 0)
var granted = false
store.requestFullAccessToReminders { ok, _ in
    granted = ok
    accessDone.signal()
}
if accessDone.wait(timeout: .now() + 20) == .timedOut || !granted {
    respond(["ok": false, "error": ["code": "access_denied", "message": "Reminders access is not granted"]])
}

do {
    let data = try Data(contentsOf: URL(fileURLWithPath: args[1]))
    guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let op = request["op"] as? String else {
        throw HelperError.badRequest("request must be a JSON object with an op")
    }
    guard let handler = handlers[op] else { throw HelperError.badRequest("unknown op \(op)") }
    respond(["ok": true, "result": try handler(request, store)])
} catch let error as HelperError {
    respond(["ok": false, "error": error.body])
} catch {
    respond(["ok": false, "error": ["code": "failed", "message": "\(error)"]])
}

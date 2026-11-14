import EventKit
import Foundation

typealias Handler = ([String: Any], EKEventStore) throws -> Any

enum HelperError: Error {
    case moveRefused(String, current: Any)
    case badRequest(String)
    case uncertain(String, current: Any?)
    case notFound(String)
    case conflict(String, current: Any?)

    var body: [String: Any] {
        switch self {
        case .moveRefused(let message, let current):
            return ["code": "move_refused", "message": message, "current": current]
        case .uncertain(let message, let current):
            var body: [String: Any] = ["code": "uncertain", "message": message]
            if let current { body["current"] = current }
            return body
        case .badRequest(let message): return ["code": "bad_request", "message": message]
        case .notFound(let message): return ["code": "not_found", "message": message]
        case .conflict(let message, let current):
            var body: [String: Any] = ["code": "conflict", "message": message]
            if let current { body["current"] = current }
            return body
        }
    }
}

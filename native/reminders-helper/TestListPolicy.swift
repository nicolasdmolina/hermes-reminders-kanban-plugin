import Foundation

let testListTitles = ["RK Test", "RK Test 2"]

func isTestFixtureTitle(_ title: String) -> Bool {
    title.range(of: #"^\[RK-[A-Za-z0-9-]+\](?:\s|$)"#, options: .regularExpression) != nil
}

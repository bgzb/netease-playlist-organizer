import Testing
@testable import OrganizerLauncher

@MainActor private final class WindowSpy: LauncherEntryShowing {
    var presentations = 0
    var visible = false
    func showEntry() { presentations += 1; visible = true }
    func close() { visible = false }
}

@MainActor final class LauncherPresentationTests {
    // Removing retained-entry reuse would create a second window on reopening.
    @Test func closingAndReopeningRetainsOneEntryWithoutStartingAnOperation() {
        var creations = 0
        let window = WindowSpy()
        let entry = LauncherEntry { creations += 1; return window }
        entry.show()
        window.close()
        entry.show()
        #expect(creations == 1)
        #expect(window.visible)
        #expect(window.presentations == 2)
    }

    // Removing the guard permits a second client-changing operation while suspended.
    @Test func operationGateRejectsOverlapAndAllowsRetryAfterCompletion() {
        let gate = LauncherOperationGate()
        #expect(gate.begin())
        #expect(gate.running)
        #expect(!gate.begin())
        gate.finish()
        #expect(!gate.running)
        #expect(gate.begin())
    }
}

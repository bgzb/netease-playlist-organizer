import Testing
import Foundation
@testable import OrganizerLauncher

actor FakeTransport: DebugTransport {
    var sent: [JSONValue] = []
    var receivers: [CheckedContinuation<String, Error>] = []
    var messages: [String] = []
    var closed = false
    func send(_ text: String) async throws {
        sent.append(try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)))
    }
    func receive() async throws -> String {
        if closed { throw LauncherError.disconnected }
        if !messages.isEmpty { return messages.removeFirst() }
        return try await withCheckedThrowingContinuation { receivers.append($0) }
    }
    func deliver(_ value: JSONValue) throws {
        let text = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        if !receivers.isEmpty { receivers.removeFirst().resume(returning: text) }
        else { messages.append(text) }
    }
    func close() async {
        closed = true
        let waiting = receivers; receivers.removeAll()
        waiting.forEach { $0.resume(throwing: LauncherError.disconnected) }
    }
    func requests() -> [JSONValue] { sent }
}

final class DebugClientTests {
    func waitForRequests(_ count: Int, _ transport: FakeTransport) async throws -> [JSONValue] {
        for _ in 0..<200 {
            let requests = await transport.requests()
            if requests.count >= count { return requests }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        throw LauncherError.timeout
    }

    // A missing request-ID lookup would assign the second response to the first call.
    @Test func testOutOfOrderResponsesUseRequestIDs() async throws {
        let transport = FakeTransport()
        let client = DebugClient(transport: transport, timeout: 1)
        let first = Task { try await client.call(method: "first", params: [:]) }
        let second = Task { try await client.call(method: "second", params: [:]) }
        let requests = try await waitForRequests(2, transport)
        let firstID = requests.first { $0["method"] == .string("first") }!["id"]!
        let secondID = requests.first { $0["method"] == .string("second") }!["id"]!
        try await transport.deliver(.object(["id": secondID, "result": .string("B")]))
        try await transport.deliver(.object(["id": firstID, "result": .string("A")]))
        let a = try await first.value; let b = try await second.value
        #expect(a == .string("A")); #expect(b == .string("B"))
        await client.close()
    }

    @Test func testProtocolErrorFinishesWaitingCall() async throws {
        let transport = FakeTransport(); let client = DebugClient(transport: transport, timeout: 1)
        let task = Task { try await client.call(method: "missing", params: [:]) }
        let id = try await waitForRequests(1, transport)[0]["id"]!
        try await transport.deliver(.object(["id": id, "error": .object(["code": .number(-32601), "message": .string("missing")])]))
        do { _ = try await task.value; Issue.record("Expected protocol error") }
        catch { #expect(error as? LauncherError == .protocolFailure) }
        await client.close()
    }

    @Test func testDisconnectFinishesAllWaitingCalls() async throws {
        let transport = FakeTransport(); let client = DebugClient(transport: transport, timeout: 1)
        let first = Task { try await client.call(method: "pending-one", params: [:]) }
        let second = Task { try await client.call(method: "pending-two", params: [:]) }
        _ = try await waitForRequests(2, transport)
        await transport.close()
        for task in [first, second] {
            do { _ = try await task.value; Issue.record("Expected disconnect") }
            catch { #expect(error as? LauncherError == .disconnected) }
        }
        await client.close()
    }

    @Test func testTimeoutFinishesWaitingCall() async {
        let client = DebugClient(transport: FakeTransport(), timeout: 0.02)
        do { _ = try await client.call(method: "pending", params: [:]); Issue.record("Expected timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        await client.close()
    }

    @Test func testCloseRejectsNewCalls() async {
        let client = DebugClient(transport: FakeTransport(), timeout: 1)
        await client.close()
        do { _ = try await client.call(method: "pending", params: [:]); Issue.record("Expected disconnect") }
        catch { #expect(error as? LauncherError == .disconnected) }
    }
}

final class LocalBoundaryTests {
    @Test func testOnlyExactLocalMainPageTargetCanBeConnected() throws {
        let valid = DebugTarget(id: "new-id", type: "page", url: "orpheus://orpheus/app.html", webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/new-id")
        #expect(try LocalDebugConnector.validatedWebSocketURL(for: valid, port: 19319).host == "127.0.0.1")
        for target in [
            DebugTarget(id: "a", type: "page", url: "https://other", webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/a"),
            DebugTarget(id: "a", type: "page", url: "orpheus://orpheus/app.html", webSocketDebuggerUrl: "ws://example.com:19319/devtools/page/a"),
            DebugTarget(id: "a", type: "page", url: "orpheus://orpheus/app.html", webSocketDebuggerUrl: "ws://127.0.0.1:20017/devtools/page/a"),
            DebugTarget(id: "a", type: "browser", url: "orpheus://orpheus/app.html", webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/a")
        ] { #expect(throws: (any Error).self) { try LocalDebugConnector.validatedWebSocketURL(for: target, port: 19319) } }
    }

    @Test func testListenerParserRejectsWildcardAndMultipleOwners() throws {
        #expect(try ListenerInspector.parse("p10\nn127.0.0.1:19319\n", port: 19319) == .owned(pid: 10, loopback: true))
        #expect(try ListenerInspector.parse("p10\nn*:19319\n", port: 19319) == .owned(pid: 10, loopback: false))
        #expect(try ListenerInspector.parse("p10\nn127.0.0.1:19319\np999\nn127.0.0.1:19319\n", port: 19319) == .conflict(owners: [10: true, 999: true]))
        #expect(throws: (any Error).self) { try ListenerInspector.parse("n127.0.0.1:19319\n", port: 19319) }
    }
}


@MainActor final class TargetStartupTests {
    private let target = DebugTarget(id: "offline-id", type: "page", url: "orpheus://orpheus/app.html", webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/offline-id")
    @Test func testDelayedCanonicalTargetWaitsWithoutOpeningEarlierSockets() async throws {
        var requests = 0, sockets = 0, checks = 0
        let client = DebugSpy()
        let connector = LocalDebugConnector(targetSource: { remaining in
            #expect(remaining > 0 && remaining <= 15); requests += 1
            return requests < 3 ? [] : [self.target]
        }, clientFactory: { url, _ in sockets += 1; #expect(url.path == "/devtools/page/offline-id"); return client })
        _ = try await connector.connect(port: 19319, validate: { checks += 1 })
        #expect(requests == 3); #expect(sockets == 1); #expect(checks >= 7)
        await client.close()
    }
    @Test func testAbsentTargetTimesOutAndOpensNoSocket() async {
        var requests = 0, sockets = 0
        let connector = LocalDebugConnector(discoveryTimeout: 0.2, targetSource: { _ in requests += 1; return [] },
            clientFactory: { _, _ in sockets += 1; return DebugSpy() })
        do { _ = try await connector.connect(port: 19319); Issue.record("Expected absent-target deadline") }
        catch { #expect(error as? LauncherError == .timeout) }
        #expect(requests >= 1); #expect(sockets == 0)
    }
    @Test func testAmbiguousMainTargetIsRejectedWithoutRetryOrSocket() async {
        var requests = 0, sockets = 0
        let connector = LocalDebugConnector(targetSource: { _ in requests += 1; return [self.target, self.target] },
            clientFactory: { _, _ in sockets += 1; return DebugSpy() })
        do { _ = try await connector.connect(port: 19319); Issue.record("Expected ambiguous-target rejection") }
        catch { #expect(error as? LauncherError == .targetUnavailable) }
        #expect(requests == 1); #expect(sockets == 0)
    }
    @Test func testIdentityReplacementAfterDiscoveryCannotOpenSocket() async {
        var original = true, sockets = 0
        let connector = LocalDebugConnector(targetSource: { _ in original = false; return [self.target] },
            clientFactory: { _, _ in sockets += 1; return DebugSpy() })
        do { _ = try await connector.connect(port: 19319, validate: { if !original { throw LauncherError.disconnected } }); Issue.record("Expected replacement rejection") }
        catch { #expect(error as? LauncherError == .disconnected) }
        #expect(sockets == 0)
    }
    @Test func testUnsafeValidationRejectsBeforeAnyTargetRequest() async {
        var requests = 0
        let connector = LocalDebugConnector(targetSource: { _ in requests += 1; return [self.target] })
        do { _ = try await connector.connect(port: 19319, validate: { throw LauncherError.unsafeListener }); Issue.record("Expected unsafe listener") }
        catch { #expect(error as? LauncherError == .unsafeListener) }
        #expect(requests == 0)
    }
    @Test func testCancellationDuringAbsentTargetWaitIsBounded() async {
        var requests = 0, sockets = 0
        let connector = LocalDebugConnector(targetSource: { _ in requests += 1; return [] },
            clientFactory: { _, _ in sockets += 1; return DebugSpy() })
        let operation = Task { try await connector.connect(port: 19319) }
        while requests == 0 { await Task.yield() }
        operation.cancel()
        do { _ = try await operation.value; Issue.record("Expected discovery cancellation") }
        catch { #expect(error is CancellationError) }
        #expect(sockets == 0)
    }
    @Test func testMalformedResponseIsNotRetriedAsEmptyTargetList() async {
        var requests = 0
        let connector = LocalDebugConnector(targetSource: { _ in requests += 1; return try LocalDebugConnector.decodeTargets(Data("{broken".utf8)) })
        do { _ = try await connector.connect(port: 19319); Issue.record("Expected malformed list rejection") }
        catch { #expect(error is DecodingError) }
        #expect(requests == 1)
    }
    @Test func testInvalidMainAndSocketDestinationsAreNeverRetriedOrOpened() async {
        let canonical = "orpheus://orpheus/app.html"
        for invalid in [
            DebugTarget(id: "a", type: "page", url: canonical + "?query=1", webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/a"),
            DebugTarget(id: "a", type: "page", url: canonical, webSocketDebuggerUrl: "ws://user@127.0.0.1:19319/devtools/page/a"),
            DebugTarget(id: "a", type: "page", url: canonical, webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/a?query=1"),
            DebugTarget(id: "a", type: "page", url: canonical, webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/a#fragment"),
            DebugTarget(id: "a", type: "page", url: canonical, webSocketDebuggerUrl: "ws://remote.invalid:19319/devtools/page/a"),
            DebugTarget(id: "../a", type: "page", url: canonical, webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/../a")
        ] {
            var requests = 0, sockets = 0
            let connector = LocalDebugConnector(targetSource: { _ in requests += 1; return [invalid] },
                clientFactory: { _, _ in sockets += 1; return DebugSpy() })
            do { _ = try await connector.connect(port: 19319); Issue.record("Expected strict target rejection") }
            catch { #expect(error as? LauncherError == .targetUnavailable) }
            #expect(requests == 1); #expect(sockets == 0)
        }
    }
}

final class StartupCallBoundaryTests {
    @Test func testRemainingReadinessDeadlineNarrowsCallTimeout() async {
        let client = DebugClient(transport: FakeTransport(), timeout: 15)
        let start = Date()
        do { _ = try await client.call(method: "Runtime.evaluate", params: [:], timeout: 0.02); Issue.record("Expected narrowed call timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        #expect(Date().timeIntervalSince(start) < 1)
        await client.close()
    }
    @Test func testOnlyNamedMissingContextErrorsAreTransient() async throws {
        let transport = FakeTransport(); let client = DebugClient(transport: transport)
        for (code, message, expected) in [
            (-32000.0, "Cannot find context with specified id", LauncherError.contextUnavailable),
            (-32601.0, "Cannot find context with specified id", LauncherError.protocolFailure),
            (-32000.0, "Other failure", LauncherError.protocolFailure)
        ] {
            let prior = await transport.requests().count
            let operation = Task { try await client.call(method: "Runtime.evaluate", params: [:]) }
            let requests = try await DebugClientTests().waitForRequests(prior + 1, transport)
            try await transport.deliver(.object(["id": requests.last!["id"]!, "error": .object(["code": .number(code), "message": .string(message)])]))
            do { _ = try await operation.value; Issue.record("Expected typed protocol failure") }
            catch { #expect(error as? LauncherError == expected) }
        }
        await client.close()
    }
}

// URLProtocol fixture never opens a socket: the synthetic scheme is handled only in this session.
private final class DribblingTargetsProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var requestCount = 0
    private static var stoppedDribble = false
    private static var completedDribble = false
    private var chunks: [DispatchWorkItem] = []
    private var stopped = false
    private var dribbling = false
    static func reset() { lock.lock(); requestCount = 0; stoppedDribble = false; completedDribble = false; lock.unlock() }
    static func counters() -> (Int, Bool, Bool) { lock.lock(); defer { lock.unlock() }; return (requestCount, stoppedDribble, completedDribble) }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.scheme == "ncm-target-fixture" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.requestCount += 1; let ordinal = Self.requestCount; Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if ordinal == 1 {
            client?.urlProtocol(self, didLoad: Data("[]".utf8)); client?.urlProtocolDidFinishLoading(self); return
        }
        dribbling = true
        let body = Data("[{\"id\":\"fixture\",\"type\":\"page\",\"url\":\"orpheus://orpheus/app.html\",\"webSocketDebuggerUrl\":\"ws://127.0.0.1:19319/devtools/page/fixture\"}]".utf8)
        let width = (body.count + 9) / 10
        for index in 0..<10 {
            let part = body.subdata(in: min(index * width, body.count)..<min((index + 1) * width, body.count))
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                Self.lock.lock(); let stopped = self.stopped; Self.lock.unlock(); if stopped { return }
                self.client?.urlProtocol(self, didLoad: part)
                if index == 9 { Self.lock.lock(); Self.completedDribble = true; Self.lock.unlock(); self.client?.urlProtocolDidFinishLoading(self) }
            }
            chunks.append(work)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.07 * Double(index + 1), execute: work)
        }
    }
    override func stopLoading() {
        Self.lock.lock(); stopped = true; if dribbling { Self.stoppedDribble = true }; Self.lock.unlock()
        chunks.forEach { $0.cancel() }
    }
}

@Suite(.serialized) @MainActor final class AbsoluteDiscoveryTests {
    @Test func testLaterDribblingResponseStopsAtOriginalDiscoveryDeadline() async {
        DribblingTargetsProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 15
        config.protocolClasses = [DribblingTargetsProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        var sockets = 0, budgets: [TimeInterval] = []
        let connector = LocalDebugConnector(discoveryTimeout: 0.35, targetSource: { remaining in
            budgets.append(remaining)
            var request = URLRequest(url: URL(string: "ncm-target-fixture://local/targets")!)
            request.timeoutInterval = remaining
            let (data, _) = try await session.data(for: request)
            return try LocalDebugConnector.decodeTargets(data)
        }, clientFactory: { _, _ in sockets += 1; return DebugSpy() })
        let start = Date()
        do { _ = try await connector.connect(port: 19319); Issue.record("Expected absolute discovery timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        let elapsed = Date().timeIntervalSince(start)
        #expect(elapsed < 0.55)
        #expect(budgets.count == 2); #expect(budgets[1] < budgets[0])
        for _ in 0..<100 where !DribblingTargetsProtocol.counters().1 { try? await Task.sleep(nanoseconds: 1_000_000) }
        #expect(DribblingTargetsProtocol.counters().1); #expect(!DribblingTargetsProtocol.counters().2); #expect(sockets == 0)
        print("synthetic dribble: discoveryBudget=0.35 elapsed=\(elapsed) polls=\(budgets.count) cancelled=\(DribblingTargetsProtocol.counters().1) sockets=\(sockets)")
    }
    @Test func testCancellationWhileLaterHTTPResponseDribblesStopsPromptly() async {
        DribblingTargetsProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 15
        config.protocolClasses = [DribblingTargetsProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        var sockets = 0
        let connector = LocalDebugConnector(targetSource: { remaining in
            var request = URLRequest(url: URL(string: "ncm-target-fixture://local/targets")!)
            request.timeoutInterval = remaining
            let (data, _) = try await session.data(for: request)
            return try LocalDebugConnector.decodeTargets(data)
        }, clientFactory: { _, _ in sockets += 1; return DebugSpy() })
        let operation = Task { try await connector.connect(port: 19319) }
        for _ in 0..<1000 where DribblingTargetsProtocol.counters().0 < 2 { try? await Task.sleep(nanoseconds: 1_000_000) }
        #expect(DribblingTargetsProtocol.counters().0 == 2)
        let cancelAt = Date(); operation.cancel()
        do { _ = try await operation.value; Issue.record("Expected in-flight cancellation") }
        catch { #expect(error is CancellationError) }
        #expect(Date().timeIntervalSince(cancelAt) < 0.2)
        for _ in 0..<100 where !DribblingTargetsProtocol.counters().1 { try? await Task.sleep(nanoseconds: 1_000_000) }
        #expect(DribblingTargetsProtocol.counters().1); #expect(!DribblingTargetsProtocol.counters().2); #expect(sockets == 0)
    }
    @Test func testIgnoringCancellationSourceCannotHoldDiscoveryUntilItsCompletion() async {
        var polls = 0, completed = false, cancelled = false, sockets = 0
        let connector = LocalDebugConnector(discoveryTimeout: 0.25, targetSource: { _ in
            polls += 1; if polls == 1 { return [] }
            // A finite non-cooperative fixture: continuation ignores Task cancellation.
            await withCheckedContinuation { continuation in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { continuation.resume() }
            }
            cancelled = Task.isCancelled; completed = true
            return [DebugTarget(id: "late", type: "page", url: "orpheus://orpheus/app.html", webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/late")]
        }, clientFactory: { _, _ in sockets += 1; return DebugSpy() })
        let start = Date()
        do { _ = try await connector.connect(port: 19319); Issue.record("Expected absolute discovery timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        let elapsed = Date().timeIntervalSince(start)
        #expect(elapsed < 0.45); #expect(!completed); #expect(sockets == 0)
        for _ in 0..<1000 where !completed { try? await Task.sleep(nanoseconds: 1_000_000) }
        #expect(completed); #expect(cancelled); #expect(sockets == 0)
        print("synthetic ignored cancellation: discoveryBudget=0.25 elapsed=\(elapsed) cancelled=\(cancelled) lateCompletionDiscarded=\(sockets == 0)")
    }
}

@MainActor final class DiscoveryConflictTests {
    private let target=DebugTarget(id:"fixture",type:"page",url:"orpheus://orpheus/app.html",webSocketDebuggerUrl:"ws://127.0.0.1:19319/devtools/page/fixture")
    private func running() -> ProcessSpy { let p=ProcessSpy();p.state = .debug(pid:10,port:19319);p.listener = .owned(pid:10,loopback:true);return p }
    private let identity=ClientIdentity(pid:10,startedAt:Date(timeIntervalSince1970:10))
    @Test func testConflictBeforeHTTPAndSocketPausesAllNewRequests() async throws {
        let p=running();p.listener = .conflict(owners: [10: true, 999: true]);var requests=0,sockets=0
        let c=Coordinator(recordFailure: { _ in }, process:p,connector:ConnectorSpy())
        DispatchQueue.main.asyncAfter(deadline:.now()+0.03) { p.listener = .owned(pid:10,loopback:true) }
        let connector=LocalDebugConnector(targetSource:{_ in
            #expect(p.listener == .owned(pid:10,loopback:true));requests+=1;p.listener = .conflict(owners: [10: true, 999: true])
            DispatchQueue.main.asyncAfter(deadline:.now()+0.03) { p.listener = .owned(pid:10,loopback:true) }
            return [self.target]
        },clientFactory:{_,_ in #expect(p.listener == .owned(pid:10,loopback:true));sockets+=1;return DebugSpy()})
        let client=try await connector.connect(port:19319,startupValidate:{deadline in try await c.validateStartupInstance(self.identity,until:deadline)})
        #expect(requests==1);#expect(sockets==1);await client.close()
    }
    @Test func testPersistentPreHTTPConflictUsesDiscoveryDeadlineAndOpensNothing() async {
        let p=running();p.listener = .conflict(owners: [10: true, 999: true]);var requests=0,sockets=0;let c=Coordinator(recordFailure: { _ in }, process:p,connector:ConnectorSpy());let start=Date()
        let connector=LocalDebugConnector(discoveryTimeout:0.04,targetSource:{_ in requests+=1;return [self.target]},clientFactory:{_,_ in sockets+=1;return DebugSpy()})
        do { _ = try await connector.connect(port:19319,startupValidate:{deadline in try await c.validateStartupInstance(self.identity,until:deadline)});Issue.record("Expected persistent conflict") }
        catch { #expect(error as? LauncherError == .portOccupied) }
        #expect(Date().timeIntervalSince(start)<0.2);#expect(requests==0);#expect(sockets==0)
    }
    @Test func testConflictAfterEmptyPollDoesNotRestartDiscoveryBudget() async {
        let p=running();var requests=0,sockets=0;let c=Coordinator(recordFailure: { _ in }, process:p,connector:ConnectorSpy());let start=Date();var deadlines:[Date]=[]
        let connector=LocalDebugConnector(discoveryTimeout:0.18,targetSource:{_ in
            requests+=1;p.listener = .conflict(owners: [10: true, 999: true])
            DispatchQueue.main.asyncAfter(deadline:.now()+0.03) { p.listener = .owned(pid:10,loopback:true) }
            return requests==1 ? [] : [self.target]
        },clientFactory:{_,_ in sockets+=1;return DebugSpy()})
        do { _ = try await connector.connect(port:19319,startupValidate:{deadline in deadlines.append(deadline);try await c.validateStartupInstance(self.identity,until:deadline)});Issue.record("Expected original discovery timeout") }
        catch { #expect(error as? LauncherError == .timeout) }
        #expect(Date().timeIntervalSince(start)<0.3);#expect(requests==1);#expect(sockets==0);#expect(Set(deadlines).count==1)
    }
}


@MainActor final class SocketSessionBoundaryTests {
    // Reusing the 15-second discovery session breaks the long-lived socket boundary;
    // relaxing socket lifetime must retain the local-only session policy.
    @Test func testSocketSessionOutlivesRPCBudgetAndRejectsRedirects() async throws {
        var socketSession: URLSession?
        let target = DebugTarget(id: "session-fixture", type: "page", url: "orpheus://orpheus/app.html",
                                 webSocketDebuggerUrl: "ws://127.0.0.1:19319/devtools/page/session-fixture")
        let connector = LocalDebugConnector(discoveryTimeout: 0.5, targetSource: { remaining in
            #expect(remaining <= 0.5)
            return [target]
        }, clientFactory: { _, session in socketSession = session; return DebugSpy() })
        let client = try await connector.connect(port: 19319)
        let session = try #require(socketSession)
        defer { session.invalidateAndCancel() }
        // RPC calls remain capped at 15 seconds; the socket must survive multiple calls and idle periods.
        #expect(session.configuration.timeoutIntervalForRequest > 15)
        #expect(session.configuration.timeoutIntervalForResource > 15)
        #expect(session.configuration.connectionProxyDictionary?.isEmpty == true)
        let delegate = try #require(session.delegate as? any URLSessionTaskDelegate)
        let request = URLRequest(url: URL(string: "http://127.0.0.1:19319/json/list")!)
        let task = session.dataTask(with: request) // Never resumed: no network.
        let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: nil, headerFields: nil)!
        let redirected = URLRequest(url: URL(string: "https://outside.invalid/")!)
        var callbackCalled = false
        delegate.urlSession?(session, task: task, willPerformHTTPRedirection: response, newRequest: redirected) { accepted in
            callbackCalled = true
            #expect(accepted == nil)
        }
        #expect(callbackCalled)
        task.cancel()
        await client.close()
    }
}

import Foundation

protocol DebugTransport: Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close() async
}

actor DebugClient: DebugCalling {
    private struct Pending {
        let continuation: CheckedContinuation<JSONValue, Error>
        let timeout: Task<Void, Never>
        let send: Task<Void, Never>
    }
    private let transport: any DebugTransport
    private let timeout: TimeInterval
    private var nextID = 0
    private var pending: [Int: Pending] = [:]
    private var receiver: Task<Void, Never>?
    private var closed = false

    init(transport: any DebugTransport, timeout: TimeInterval = 15) {
        self.transport = transport; self.timeout = timeout
    }

    func call(method: String, params: [String: JSONValue]) async throws -> JSONValue {
        try await call(method: method, params: params, timeout: timeout)
    }

    func call(method: String, params: [String: JSONValue], timeout requestedTimeout: TimeInterval) async throws -> JSONValue {
        try Task.checkCancellation()
        let callTimeout = min(timeout, max(0, requestedTimeout))
        guard !closed else { throw LauncherError.disconnected }
        if receiver == nil { receiver = Task { [weak self] in await self?.receiveLoop() } }
        nextID += 1; let id = nextID
        let payload: JSONValue = .object(["id": .number(Double(id)), "method": .string(method), "params": .object(params)])
        let text = String(decoding: try JSONEncoder().encode(payload), as: UTF8.self)
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let timer = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(callTimeout * 1_000_000_000)) }
                    catch { return }
                    await self?.finish(id, result: .failure(LauncherError.timeout))
                }
                let send = Task { [weak self, transport] in
                    do { try await transport.send(text) }
                    catch { await self?.disconnect() }
                }
                pending[id] = Pending(continuation: continuation, timeout: timer, send: send)
            }
        }, onCancel: { Task { await self.finish(id, result: .failure(CancellationError())) } })
    }

    private func receiveLoop() async {
        do {
            while !closed {
                let text = try await transport.receive()
                let response = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
                guard let id = response["id"]?.integerValue else { continue } // CDP events have no ID.
                if let error = response["error"] {
                    let transient = error["code"] == .number(-32000) && [
                        "Cannot find context with specified id", "Cannot find default execution context",
                        "Execution context was destroyed.", "Execution context was destroyed, most likely because of a navigation."
                    ].contains(error["message"]?.stringValue ?? "")
                    finish(id, result: .failure(transient ? LauncherError.contextUnavailable : LauncherError.protocolFailure))
                }
                else if let result = response["result"] { finish(id, result: .success(result)) }
                else { finish(id, result: .failure(LauncherError.protocolFailure)) }
            }
        } catch { await disconnect() }
    }

    private func finish(_ id: Int, result: Result<JSONValue, Error>) {
        guard let item = pending.removeValue(forKey: id) else { return }
        item.timeout.cancel(); item.send.cancel(); item.continuation.resume(with: result)
    }

    private func disconnect() async {
        guard !closed else { return }
        closed = true
        for id in Array(pending.keys) { finish(id, result: .failure(LauncherError.disconnected)) }
        receiver?.cancel(); receiver = nil
        await transport.close()
    }
    func close() async { await disconnect() }
    func isOpen() async -> Bool { !closed }
}

actor WebSocketTransport: DebugTransport {
    private let task: URLSessionWebSocketTask
    private let session: URLSession
    init(url: URL, session: URLSession) {
        self.session = session; task = session.webSocketTask(with: url); task.resume()
    }
    func send(_ text: String) async throws { try await task.send(.string(text)) }
    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let value): return value
        case .data(let value): return String(decoding: value, as: UTF8.self)
        @unknown default: throw LauncherError.protocolFailure
        }
    }
    func close() async { task.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
}

struct DebugTarget: Decodable, Sendable {
    let id: String
    let type: String
    let url: String
    let webSocketDebuggerUrl: String?
}

// Never follow a local debug endpoint's HTTP redirect outside the validated origin.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// Same continuation/timer/cancel pattern as DebugClient's pending calls.
// Finishing never awaits the worker, which may be a non-cooperative injected fixture.
@MainActor private final class PendingTargetLookup {
    var continuation: CheckedContinuation<[DebugTarget], Error>?
    var worker: Task<Void, Never>?
    var timer: Task<Void, Never>?
    func finish(_ result: Result<[DebugTarget], Error>) {
        guard let continuation else { return }
        self.continuation = nil
        worker?.cancel(); timer?.cancel(); worker = nil; timer = nil
        continuation.resume(with: result)
    }
}

@MainActor final class LocalDebugConnector: DebugConnecting {
    private let discoveryTimeout: TimeInterval
    private let targetSource: ((TimeInterval) async throws -> [DebugTarget])?
    private let clientFactory: ((URL, URLSession) -> any DebugCalling)?

    // Injectable transport boundaries permit startup discovery tests without real HTTP/WS.
    init(discoveryTimeout: TimeInterval = 15,
         targetSource: ((TimeInterval) async throws -> [DebugTarget])? = nil,
         clientFactory: ((URL, URLSession) -> any DebugCalling)? = nil) {
        self.discoveryTimeout = min(15, max(0, discoveryTimeout))
        self.targetSource = targetSource; self.clientFactory = clientFactory
    }

    static nonisolated func validatedWebSocketURL(for target: DebugTarget, port: Int) throws -> URL {
        guard port == 19319, target.type == "page", target.url == "orpheus://orpheus/app.html",
              target.id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              let text = target.webSocketDebuggerUrl,
              text == "ws://127.0.0.1:19319/devtools/page/\(target.id)", let value = URL(string: text)
        else { throw LauncherError.targetUnavailable }
        return value
    }

    static nonisolated func decodeTargets(_ data: Data) throws -> [DebugTarget] {
        guard data.count <= 1_048_576 else { throw LauncherError.targetUnavailable }
        return try JSONDecoder().decode([DebugTarget].self, from: data)
    }

    static nonisolated func mainTarget(_ targets: [DebugTarget]) throws -> DebugTarget? {
        let canonical = "orpheus://orpheus/app.html"
        // Similar-but-invalid main pages and ambiguity are incompatibility, not startup delay.
        guard !targets.contains(where: { $0.url.hasPrefix(canonical) && ($0.url != canonical || $0.type != "page") })
        else { throw LauncherError.targetUnavailable }
        let main = targets.filter { $0.type == "page" && $0.url == canonical }
        guard main.count <= 1 else { throw LauncherError.targetUnavailable }
        return main.first
    }

    private static func lookup(until deadline: Date,
                               operation: @escaping @MainActor () async throws -> [DebugTarget]) async throws -> [DebugTarget] {
        let pending = PendingTargetLookup()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                pending.continuation = continuation
                pending.timer = Task {
                    do { try await Task.sleep(nanoseconds: UInt64(max(0, deadline.timeIntervalSinceNow) * 1_000_000_000)) }
                    catch { return }
                    pending.finish(.failure(LauncherError.timeout))
                }
                pending.worker = Task {
                    do {
                        try Task.checkCancellation()
                        guard Date() < deadline else { throw LauncherError.timeout }
                        let targets = try await operation()
                        pending.finish(Date() < deadline ? .success(targets) : .failure(LauncherError.timeout))
                    } catch {
                        let expired = Date() >= deadline || (error as? URLError)?.code == .timedOut
                        pending.finish(.failure(expired ? LauncherError.timeout : error))
                    }
                }
            }
        }, onCancel: { Task { @MainActor in pending.finish(.failure(CancellationError())) } })
    }

    func connect(port: Int) async throws -> any DebugCalling {
        try await connect(port: port, validate: {})
    }

    func connect(port: Int, validate: @MainActor () throws -> Void) async throws -> any DebugCalling {
        try await connect(port: port, startupValidate: { _ in try validate() })
    }

    func connect(port: Int, startupValidate: @MainActor (Date) async throws -> Void) async throws -> any DebugCalling {
        guard port == 19319 else { throw LauncherError.targetUnavailable }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 15
        config.connectionProxyDictionary = [:]
        let session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
        let endpoint = URL(string: "http://127.0.0.1:19319/json/list")!
        let deadline = Date().addingTimeInterval(discoveryTimeout)
        do {
            while Date() < deadline {
                try Task.checkCancellation(); try await startupValidate(deadline)
                let remaining = deadline.timeIntervalSinceNow
                guard remaining > 0 else { throw LauncherError.timeout }
                let targets = try await Self.lookup(until: deadline) { [self] in
                    let remaining = deadline.timeIntervalSinceNow
                    guard remaining > 0 else { throw LauncherError.timeout }
                    if let targetSource { return try await targetSource(remaining) }
                    var request = URLRequest(url: endpoint); request.timeoutInterval = remaining
                    let (data, response) = try await session.data(for: request)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                          http.url == endpoint else { throw LauncherError.targetUnavailable }
                    return try Self.decodeTargets(data)
                }
                try Task.checkCancellation(); try await startupValidate(deadline)
                guard Date() < deadline else { throw LauncherError.timeout }
                if let target = try Self.mainTarget(targets) {
                    let url = try Self.validatedWebSocketURL(for: target, port: port)
                    try await startupValidate(deadline) // Never open a socket for a replaced/unsafe owner.
                    try Task.checkCancellation()
                    guard Date() < deadline else { throw LauncherError.timeout }
                    // Discovery is bounded HTTP; the WebSocket survives idle periods between bounded RPC calls.
                    let socketConfig = URLSessionConfiguration.ephemeral
                    socketConfig.timeoutIntervalForRequest = 604800
                    socketConfig.timeoutIntervalForResource = 604800
                    socketConfig.connectionProxyDictionary = [:]
                    let socketSession = URLSession(configuration: socketConfig, delegate: NoRedirectDelegate(), delegateQueue: nil)
                    session.finishTasksAndInvalidate()
                    return clientFactory?(url, socketSession) ?? DebugClient(transport: WebSocketTransport(url: url, session: socketSession))
                }
                try await Task.sleep(nanoseconds: UInt64(min(0.1, max(0, deadline.timeIntervalSinceNow)) * 1_000_000_000))
            }
            throw LauncherError.timeout
        } catch { session.invalidateAndCancel(); throw error }
    }
}

import Foundation

indirect enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .string(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .object(let v): try value.encode(v)
        }
    }
    subscript(_ key: String) -> JSONValue? {
        guard case .object(let value) = self else { return nil }; return value[key]
    }
    var stringValue: String? { guard case .string(let value) = self else { return nil }; return value }
    var boolValue: Bool? { guard case .bool(let value) = self else { return nil }; return value }
    var integerValue: Int? {
        guard case .number(let value) = self, value.isFinite, value.rounded() == value,
              value >= 0, value <= Double(Int32.max) else { return nil }
        return Int(value)
    }
}

enum ClientState: Equatable, Sendable {
    case notRunning, regular(pid: Int32), debug(pid: Int32, port: Int), unsupported(version: String, build: String)
}

struct ClientIdentity: Hashable, Sendable {
    let pid: Int32
    let startedAt: Date
}

enum PortInspection: Equatable, Sendable {
    case free, owned(pid: Int32, loopback: Bool), conflict(owners: [Int32: Bool])

    var isConflict: Bool {
        if case .conflict = self { return true }
        return false
    }
    var isLoopbackConflict: Bool {
        if case .conflict(let owners) = self {
            return owners.count > 1 && owners.values.allSatisfy { $0 }
        }
        return false
    }
    func hasUnsafeBinding(ownedBy expected: Int32) -> Bool {
        switch self {
        case .owned(let pid, let loopback): return pid == expected && !loopback
        case .conflict(let owners): return owners[expected] == false
        case .free: return false
        }
    }
}

struct LoadStatus: Codable, Equatable, Sendable {
    let installed: Bool
    let adapterVersion: String
    let readReady: Bool
    let writeVerification: String
}

enum LauncherError: Error, Equatable, LocalizedError {
    case restartApprovalRequired, portOccupied, unsafeListener, unsupportedClient, appMissing
    case timeout, disconnected, protocolFailure, capabilityUnavailable, listenerInspectionFailed
    case targetUnavailable, panelMissing, operationInProgress, normalQuitRefused, contextUnavailable

    var errorDescription: String? {
        switch self {
        case .restartApprovalRequired: return "需要经您选择后重新打开网易云，这可能中断播放。"
        case .portOccupied: return "端口 19319 被其他进程占用。未连接或退出该进程。"
        case .unsafeListener: return "调试监听未限定在回环地址，已停止连接。"
        case .unsupportedClient: return "仅支持网易云音乐 3.1.1（build 3019）。"
        case .appMissing: return "找不到网易云音乐应用。"
        case .timeout: return "当前启动阶段或调试请求超过 15 秒，请手动重连。"
        case .disconnected: return "网易云连接已断开，请从菜单重新打开整理面板。"
        case .protocolFailure: return "客户端调试响应不符合预期，已停止操作。"
        case .capabilityUnavailable: return "当前客户端页面能力不可用，未开始整理业务。"
        case .listenerInspectionFailed: return "无法核对监听归属及绑定地址，已停止连接。"
        case .contextUnavailable: return "主页面上下文尚未就绪，请手动重连。"
        case .targetUnavailable: return "找不到本机网易云主页面目标。"
        case .panelMissing: return "应用包缺少真实面板资源 panel.js，请先完成面板构建。"
        case .operationInProgress: return "已有启动器操作正在进行。"
        case .normalQuitRefused: return "网易云未接受正常退出；未强制终止。"
        }
    }
}

protocol DebugCalling: Sendable {
    func call(method: String, params: [String: JSONValue]) async throws -> JSONValue
    func close() async
    func isOpen() async -> Bool
    func call(method: String, params: [String: JSONValue], timeout: TimeInterval) async throws -> JSONValue
}

extension DebugCalling {
    func call(method: String, params: [String: JSONValue], timeout: TimeInterval) async throws -> JSONValue {
        try await call(method: method, params: params)
    }
}

@MainActor protocol DebugConnecting {
    func connect(port: Int) async throws -> any DebugCalling
    func connect(port: Int, validate: @MainActor () throws -> Void) async throws -> any DebugCalling
    func connect(port: Int, startupValidate: @MainActor (Date) async throws -> Void) async throws -> any DebugCalling
}

extension DebugConnecting {
    func connect(port: Int, startupValidate: @MainActor (Date) async throws -> Void) async throws -> any DebugCalling {
        let deadline = Date().addingTimeInterval(15)
        try Task.checkCancellation(); try await startupValidate(deadline)
        let client = try await connect(port: port)
        do { try Task.checkCancellation(); try await startupValidate(deadline); return client }
        catch { await client.close(); throw error }
    }
    func connect(port: Int, validate: @MainActor () throws -> Void) async throws -> any DebugCalling {
        try Task.checkCancellation(); try validate()
        let client = try await connect(port: port)
        do { try Task.checkCancellation(); try validate(); return client }
        catch { await client.close(); throw error }
    }
}

@MainActor protocol ClientProcessControlling {
    func inspect() -> ClientState
    func inspectListener(port: Int) throws -> PortInspection
    func captureIdentity(pid: Int32) throws -> ClientIdentity
    func isRunning(identity: ClientIdentity) -> Bool
    func start(debugPort: Int?) async throws -> ClientIdentity
    func terminateNormally(expected: ClientIdentity) async throws
}

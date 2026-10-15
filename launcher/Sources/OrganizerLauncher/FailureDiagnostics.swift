import Darwin
import Foundation

enum FailureStage: String, Codable {
    case retainedIdentity, currentIdentity, retainIdentity, captureIdentity
    case startupIdentity, startupState, connectState, connectIdentity, connectedIdentity, connect, ui
}

enum FailureKind: String, Codable {
    case restartApprovalRequired, portOccupied, unsafeListener, unsupportedClient, appMissing
    case timeout, disconnected, protocolFailure, capabilityUnavailable, listenerInspectionFailed
    case targetUnavailable, panelMissing, operationInProgress, normalQuitRefused, contextUnavailable
    case cancellation, transport, decoding, other

    init(_ error: Error) {
        if let launcher = error as? LauncherError {
            // LauncherError has only fixed, argument-free cases; raw errors are never serialized.
            self = FailureKind(rawValue: String(describing: launcher)) ?? .other
        } else if error is CancellationError { self = .cancellation }
        else if error is URLError { self = .transport }
        else if error is DecodingError { self = .decoding }
        else { self = .other }
    }
}

struct IdentityFailure: Codable {
    let capturedPresent: Bool
    let capturedTerminated: Bool
    let currentCountIsOne: Bool
    let currentPidMatches: Bool
    let currentStartedAtMatches: Bool
    let identityPresent: Bool
}

struct FailureRecord: Codable {
    let stage: FailureStage
    let failure: FailureKind
    var identity: IdentityFailure? = nil
}

typealias FailureRecorder = (FailureRecord) -> Void

struct FailureLog {
    static let limit = 16 * 1024
    static let header = Data("{\"format\":\"ncm-organizer-startup-failure-v1\"}\n".utf8)
    static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ncm-organizer-v1-diagnostics", isDirectory: true)
    }
    static let filename = "startup-failure.ndjson"
    let directory: URL

    init(directory: URL = Self.directory) { self.directory = directory }
    // Best effort only after a failed decision. Never change launcher behavior on logging failure.
    func append(_ record: FailureRecord) {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard var line = try? encoder.encode(record) else { return }
        line.append(10)
        guard line.count + Self.header.count <= Self.limit else { return }
        if mkdir(directory.path, 0o700) != 0 && errno != EEXIST { return }
        let parent = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { return }
        defer { close(parent) }
        var directoryInfo = stat()
        guard fstat(parent, &directoryInfo) == 0, directoryInfo.st_uid == geteuid(),
              directoryInfo.st_mode & S_IFMT == S_IFDIR,
              directoryInfo.st_mode & 0o7777 == 0o700 else { return }

        let flags = O_RDWR | O_APPEND | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK
        var file = openat(parent, Self.filename, flags | O_CREAT | O_EXCL, 0o600)
        let created = file >= 0
        if !created {
            guard errno == EEXIST else { return }
            file = openat(parent, Self.filename, flags)
        }
        guard file >= 0 else { return }
        defer { close(file) }
        // Only the file just created exclusively by this call may have its mode set.
        if created && fchmod(file, 0o600) != 0 { return }
        var info = stat()
        guard fstat(file, &info) == 0, info.st_uid == geteuid(), info.st_nlink == 1,
              info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o7777 == 0o600,
              flock(file, LOCK_EX | LOCK_NB) == 0 else { return }
        defer { flock(file, LOCK_UN) }
        guard fstat(file, &info) == 0, info.st_nlink == 1 else { return }
        var bytes = line
        if created {
            guard info.st_size == 0 else { return }
            bytes = Self.header + line
        } else {
            guard info.st_size >= Self.header.count else { return }
            var header = Data(count: Self.header.count)
            let count = header.withUnsafeMutableBytes { pread(file, $0.baseAddress, $0.count, 0) }
            // A pre-existing unrelated file is never appended to, even with correct mode/owner.
            guard count == Self.header.count, header == Self.header else { return }
        }
        guard info.st_size <= Self.limit - bytes.count else { return }
        bytes.withUnsafeBytes { buffer in
            var written = 0
            while written < buffer.count {
                let count = write(file, buffer.baseAddress!.advanced(by: written), buffer.count - written)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return }
                written += count
            }
        }
    }
}

enum NativeFailureDiagnostics {
    static func record(_ record: FailureRecord) { FailureLog().append(record) }
}

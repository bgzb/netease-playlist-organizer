import AppKit
import Darwin
import Foundation

final class SingleInstanceLock {
    private let descriptor: Int32
    init(url: URL = FileManager.default.temporaryDirectory.appendingPathComponent("netease-playlist-organizer.launcher.lock")) throws {
        let file = open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard file >= 0 else { throw LauncherError.operationInProgress }
        guard flock(file, LOCK_EX | LOCK_NB) == 0 else {
            close(file); throw LauncherError.operationInProgress
        }
        descriptor = file
    }
    deinit { flock(descriptor, LOCK_UN); close(descriptor) }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    private let coordinator = Coordinator(process: ClientProcess(), connector: LocalDebugConnector())
    private var statusItem: NSStatusItem?
    private let status = NSMenuItem(title: "未连接", action: nil, keyEquivalent: "")
    private var processObserver: NSObjectProtocol?
    private var timer: Timer?
    private let operationGate = LauncherOperationGate()
    private var operationRunning: Bool { operationGate.running }
    private var terminationApproved = false
    private var actionItems: [NSMenuItem] = []
    private var controlWindow: ControlWindowController?
    private lazy var entry = LauncherEntry { [unowned self] in
        let controller = ControlWindowController(target: self, actions: [
            ("打开整理面板", #selector(openPanel)),
            ("移除面板", #selector(removePanel)),
            ("恢复普通启动", #selector(restoreNormal))
        ])
        self.controlWindow = controller
        return controller
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let mainMenu = NSMenu()
        let applicationMenu = NSMenu()
        applicationMenu.autoenablesItems = false
        let rootItem = NSMenuItem()
        rootItem.submenu = applicationMenu
        mainMenu.addItem(rootItem)
        let showItem = NSMenuItem(title: "显示整理工具", action: #selector(showControlWindow), keyEquivalent: "0")
        showItem.target = self
        applicationMenu.addItem(showItem)
        applicationMenu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出整理工具", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        applicationMenu.addItem(quitItem)
        actionItems.append(quitItem)
        NSApp.mainMenu = mainMenu
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "整理"
        let menu = NSMenu()
        menu.autoenablesItems = false
        let showStatusItem = NSMenuItem(title: "显示整理工具", action: #selector(showControlWindow), keyEquivalent: "")
        showStatusItem.target = self
        menu.addItem(showStatusItem)
        status.isEnabled = false; menu.addItem(status); menu.addItem(.separator())
        for (title, selector) in [
            ("打开整理面板", #selector(openPanel)), ("移除面板", #selector(removePanel)),
            ("恢复普通启动", #selector(restoreNormal)), ("退出整理工具", #selector(quit))
        ] {
            let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
            entry.target = self; menu.addItem(entry); actionItems.append(entry)
        }
        item.menu = menu; statusItem = item
        processObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
        ) { [weak self] event in
            guard let app = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier == ClientProcess.bundleID else { return }
            let pid = app.processIdentifier
            Task { @MainActor [weak self] in
                await self?.coordinator.clientDidExit(pid: pid); self?.updateStatus()
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.coordinator.refreshConnection(); self?.updateStatus()
            }
        }
        showControlWindow()
        openPanel()
    }

    @objc private func showControlWindow() { entry.show(); updateStatus() }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showControlWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func updateStatus() {
        status.title = operationRunning ? "操作进行中…" : (coordinator.connected ? "已连接" : "未连接 · 可重新打开面板")
        controlWindow?.update(status: status.title, busy: operationRunning)
        actionItems.forEach { $0.isEnabled = !operationRunning }
    }
    private func alert(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(); alert.messageText = "网易云歌单整理"; alert.informativeText = message
        alert.addButton(withTitle: "好"); alert.runModal()
    }
    private func confirm(title: String, message: String, action: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = message
        alert.addButton(withTitle: action); alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard operationGate.begin() else { return }
        updateStatus()
        Task { @MainActor in
            defer { operationGate.finish(); updateStatus() }
            do { try await operation() }
            catch {
                NativeFailureDiagnostics.record(FailureRecord(stage: .ui, failure: FailureKind(error)))
                alert((error as? LauncherError)?.errorDescription ?? "操作未完成，连接已停止。请手动重试。")
            }
        }
    }

    @objc private func openPanel() {
        perform { [self] in
            guard let file = Bundle.main.url(forResource: "panel", withExtension: "js"),
                  let script = try? String(contentsOf: file, encoding: .utf8), !script.isEmpty else { throw LauncherError.panelMissing }
            do { _ = try await coordinator.connectAndLoad(script: script, restartApproved: false) }
            catch LauncherError.restartApprovalRequired {
                guard confirm(title: "重新打开网易云并加载面板？",
                              message: "正常退出后重新打开可能中断播放。整理期间会保留仅供本机访问的调试监听；恢复普通启动可关闭该监听。",
                              action: "重新打开并加载") else { return }
                _ = try await coordinator.connectAndLoad(script: script, restartApproved: true)
            }
        }
    }

    @objc private func removePanel() {
        perform { [self] in try await coordinator.removePanel() }
    }
    @objc private func restoreNormal() {
        guard !operationRunning else { return }
        guard confirm(title: "恢复网易云普通启动？", message: "这将正常退出并重新打开网易云，可能中断播放。面板将被移除，启动时不再携带调试参数。", action: "恢复普通启动") else { return }
        perform { [self] in try await coordinator.restoreNormalLaunch() }
    }
    @objc private func quit() {
        guard !operationRunning else { return }
        guard confirm(title: "退出整理工具？", message: "退出工具只关闭调试连接。网易云运行期间的调试监听可能仍保留；如需关闭，请取消并选择“恢复普通启动”。", action: "退出整理工具") else { return }
        guard operationGate.begin() else { return }
        updateStatus()
        Task { @MainActor in
            await coordinator.disconnect()
            terminationApproved = true
            NSApp.terminate(nil)
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Dock/application-menu termination uses the same confirmation and busy guard.
        guard terminationApproved else { quit(); return .terminateCancel }
        timer?.invalidate()
        if let processObserver { NSWorkspace.shared.notificationCenter.removeObserver(processObserver) }
        return .terminateNow
    }
}

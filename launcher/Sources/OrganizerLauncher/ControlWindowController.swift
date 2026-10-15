import AppKit

@MainActor protocol LauncherEntryShowing: AnyObject {
    func showEntry()
}

@MainActor final class LauncherEntry {
    private let makeEntry: () -> any LauncherEntryShowing
    init(makeEntry: @escaping () -> any LauncherEntryShowing) { self.makeEntry = makeEntry }
    private var entry: (any LauncherEntryShowing)?
    func show() {
        if entry == nil { entry = makeEntry() }
        entry?.showEntry()
    }
}

@MainActor final class LauncherOperationGate {
    private(set) var running = false
    func begin() -> Bool {
        guard !running else { return false }
        running = true
        return true
    }
    func finish() { running = false }
}


@MainActor final class ControlWindowController: NSWindowController, LauncherEntryShowing {
    private let statusLabel = NSTextField(labelWithString: "未连接")
    private var buttons: [NSButton] = []

    init(target: AnyObject, actions: [(String, Selector)]) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 260),
                              styleMask: [.titled, .closable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = "网易云歌单整理"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let heading = NSTextField(labelWithString: "歌单整理工具")
        heading.font = .boldSystemFont(ofSize: 18)
        stack.addArrangedSubview(heading)
        stack.addArrangedSubview(statusLabel)
        for (title, action) in actions {
            let button = NSButton(title: title, target: target, action: action)
            button.bezelStyle = .rounded
            buttons.append(button)
            stack.addArrangedSubview(button)
        }
        let help = NSTextField(wrappingLabelWithString: "普通打开网易云不会自动加载面板，需要使用此工具。关闭此窗口后，可点击 Dock 图标重新显示。")
        help.textColor = .secondaryLabelColor
        stack.addArrangedSubview(help)
        let content = window.contentView!
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -20)
        ])
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func showEntry() {
        window?.deminiaturize(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func update(status: String, busy: Bool) {
        statusLabel.stringValue = status
        buttons.forEach { $0.isEnabled = !busy }
    }
}

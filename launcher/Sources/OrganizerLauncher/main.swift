import AppKit
import Foundation

MainActor.assumeIsolated {
    let application = NSApplication.shared
    var instanceLock: SingleInstanceLock?
    do { instanceLock = try SingleInstanceLock() }
    catch {
        let alert = NSAlert(); alert.messageText = "整理工具已在运行"
        alert.informativeText = "请点击 Dock 中的整理工具图标重新显示控制窗口，也可使用菜单栏中的“整理”菜单。"; alert.addButton(withTitle: "好"); alert.runModal()
        exit(0)
    }
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
    withExtendedLifetime(instanceLock) {}
}

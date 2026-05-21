import SwiftUI

@main
struct VideoDownloaderApp: App {
    var body: some Scene {
        WindowGroup {
            MainView()
        }
        .windowStyle(.titleBar) // Chuẩn style cửa sổ macOS
        .commands {
            SidebarCommands()
        }
    }
}

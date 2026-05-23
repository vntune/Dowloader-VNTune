import Foundation
import Combine

@MainActor
class DependencyManager: ObservableObject {
    @Published var isReady = false
    @Published var statusMessage = ""
    @Published var progress: Double = 0.0 // Giá trị từ 0 đến 1
    @Published var ytDlpPathDisplay: String = "Chưa cài đặt"
    @Published var ffmpegPathDisplay: String = "Chưa cài đặt"
    @Published var needsInstall: Bool = true
    @Published var isInstalling: Bool = false
    
    @Published var supportDirectory: URL
    @Published var ytDlpURL: URL
    @Published var ffmpegURL: URL
    
    init() {
        supportDirectory = YTDLPService.currentSupportDirectory()
        ytDlpURL = supportDirectory.appendingPathComponent("yt-dlp_macos")
        ffmpegURL = supportDirectory.appendingPathComponent("ffmpeg")
    }
    
    func updatePaths() {
        supportDirectory = YTDLPService.currentSupportDirectory()
        ytDlpURL = supportDirectory.appendingPathComponent("yt-dlp_macos")
        ffmpegURL = supportDirectory.appendingPathComponent("ffmpeg")
        checkDependencies()
        showPaths()
    }
    
    func checkDependencies() {
        let fileManager = FileManager.default
        let ytDlpExists = fileManager.fileExists(atPath: ytDlpURL.path)
        let ffmpegExists = fileManager.fileExists(atPath: ffmpegURL.path)
        
        needsInstall = !ytDlpExists || !ffmpegExists
        isReady = ytDlpExists && ffmpegExists
    }
    
    func updateOrInstallDependencies() async {
        let fileManager = FileManager.default
        isInstalling = true
        progress = 0.0
        
        do {
            if !fileManager.fileExists(atPath: supportDirectory.path) {
                try fileManager.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
            }
            
            // 1. Tải và thiết lập yt-dlp_macos
            if !fileManager.fileExists(atPath: ytDlpURL.path) {
                statusMessage = "Đang tải yt-dlp (Core downloader)..."
                try await downloadFile(from: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos", to: ytDlpURL)
                try await setExecutable(url: ytDlpURL)
            }
            
            statusMessage = "Đang kiểm tra và cập nhật yt-dlp..."
            _ = try? await runCommand(executable: ytDlpURL, arguments: ["-U"])
            
            // 2. Tải và thiết lập ffmpeg (để ghép hình và âm thanh phân giải cao)
            if !fileManager.fileExists(atPath: ffmpegURL.path) {
                statusMessage = "Đang tải FFmpeg (hỗ trợ ghép 1080p+)..."
                let zipURL = supportDirectory.appendingPathComponent("ffmpeg.zip")
                try await downloadFile(from: "https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-osx-64.zip", to: zipURL)
                
                statusMessage = "Đang giải nén FFmpeg..."
                _ = try? await runCommand(executable: URL(fileURLWithPath: "/usr/bin/unzip"), arguments: ["-o", zipURL.path, "-d", supportDirectory.path])
                
                try await setExecutable(url: ffmpegURL)
                try? fileManager.removeItem(at: zipURL)
            }
            
            statusMessage = "Hoàn tất cập nhật!"
            
            // Update display paths after successful installation
            ytDlpPathDisplay = ytDlpURL.path
            ffmpegPathDisplay = ffmpegURL.path
            needsInstall = false
            isReady = true
            
            try await Task.sleep(nanoseconds: 1_000_000_000)
            statusMessage = ""
        } catch {
            statusMessage = "Lỗi cài đặt: \(error.localizedDescription)"
        }
        
        isInstalling = false
    }
    
    func showPaths() {
        let fileManager = FileManager.default
        let ytDlpExists = fileManager.fileExists(atPath: ytDlpURL.path)
        let ffmpegExists = fileManager.fileExists(atPath: ffmpegURL.path)
        
        ytDlpPathDisplay = ytDlpExists ? ytDlpURL.path : "Chưa cài đặt"
        ffmpegPathDisplay = ffmpegExists ? ffmpegURL.path : "Chưa cài đặt"
    }
    
    private func downloadFile(from urlString: String, to destination: URL) async throws {
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        
        self.progress = 0.0
        
        let (tempURL, response) = try await URLSession.shared.download(from: url)
        
        guard let httpResponse = response as? HTTPURLResponse, 
              (200...299).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
        
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        
        try fileManager.moveItem(at: tempURL, to: destination)
        
        self.progress = 1.0
    }
    
    private func setExecutable(url: URL) async throws {
        try await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/chmod")
            process.arguments = ["+x", url.path]
            try process.run()
            process.waitUntilExit()
        }.value
    }
    
    private func runCommand(executable: URL, arguments: [String]) async throws -> String {
        return try await Task.detached {
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            try process.run()
            process.waitUntilExit()
            guard let data = try? pipe.fileHandleForReading.readToEnd() else { return "" }
            return String(decoding: data, as: UTF8.self)
        }.value
    }
}

import Foundation
import Combine

@MainActor
class DependencyManager: ObservableObject {
    @Published var isReady = false
    @Published var statusMessage = "Khởi tạo môi trường..."
    @Published var progress: Double = 0.0 // Giá trị từ 0 đến 1
    
    let supportDirectory: URL
    let ytDlpURL: URL
    let ffmpegURL: URL
    
    init() {
        let fileManager = FileManager.default
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        supportDirectory = appSupport.appendingPathComponent("VideoDownloaderVN", isDirectory: true)
        ytDlpURL = supportDirectory.appendingPathComponent("yt-dlp_macos")
        ffmpegURL = supportDirectory.appendingPathComponent("ffmpeg")
    }
    
    func setupDependencies() async {
        let fileManager = FileManager.default
        isReady = false
        progress = 0.0
        
        do {
            if !fileManager.fileExists(atPath: supportDirectory.path) {
                try fileManager.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
            }
            
            // 1. Tải và thiết lập yt-dlp_macos
            if !fileManager.fileExists(atPath: ytDlpURL.path) {
                statusMessage = "Đang tải yt-dlp (Core downloader)..."
                try await downloadFile(from: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos", to: ytDlpURL)
                
                statusMessage = "Đang cấp quyền thực thi cho yt-dlp..."
                try setExecutable(url: ytDlpURL)
            } else {
                statusMessage = "Đang kiểm tra và cập nhật yt-dlp..."
                _ = try? await runCommand(executable: ytDlpURL, arguments: ["-U"])
            }
            
            // 2. Tải và thiết lập ffmpeg (để ghép hình và âm thanh phân giải cao)
            if !fileManager.fileExists(atPath: ffmpegURL.path) {
                statusMessage = "Đang tải FFmpeg (hỗ trợ ghép 1080p+)..."
                let zipURL = supportDirectory.appendingPathComponent("ffmpeg.zip")
                try await downloadFile(from: "https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-osx-64.zip", to: zipURL)
                
                statusMessage = "Đang giải nén FFmpeg..."
                _ = try? await runCommand(executable: URL(fileURLWithPath: "/usr/bin/unzip"), arguments: ["-o", zipURL.path, "-d", supportDirectory.path])
                
                try setExecutable(url: ffmpegURL)
                try? fileManager.removeItem(at: zipURL)
            }
            
            statusMessage = "Cài đặt thành công! Đang khởi động..."
            try await Task.sleep(nanoseconds: 500_000_000)
            isReady = true
        } catch {
            statusMessage = "Lỗi cài đặt: \(error.localizedDescription)"
        }
    }
    
    private func downloadFile(from urlString: String, to destination: URL) async throws {
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        
        let (asyncBytes, response) = try await URLSession.shared.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        let contentLength = Double(httpResponse.expectedContentLength)
        var data = Data()
        if contentLength > 0 {
            data.reserveCapacity(Int(contentLength))
        }
        
        var currentBytes: Double = 0
        self.progress = 0.0
        
        for try await byte in asyncBytes {
            data.append(byte)
            currentBytes += 1
            // Cập nhật UI mỗi 256KB để tránh quá tải Main Thread
            if contentLength > 0 && Int(currentBytes) % (256 * 1024) == 0 {
                let currentProgress = currentBytes / contentLength
                Task { @MainActor in
                    self.progress = currentProgress
                }
            }
        }
        
        try data.write(to: destination)
        Task { @MainActor in
            self.progress = 1.0
        }
    }
    
    private func setExecutable(url: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/chmod")
        process.arguments = ["+x", url.path]
        try process.run()
        process.waitUntilExit()
    }
    
    private func runCommand(executable: URL, arguments: [String]) async throws -> String {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        process.waitUntilExit()
        guard let data = try? pipe.fileHandleForReading.readToEnd() else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

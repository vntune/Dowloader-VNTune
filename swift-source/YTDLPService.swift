import Foundation

// Custom Error definitions
enum YTDLPError: Error {
    case binaryNotFound
    case invalidJSON
    case processFailed(Int32)
}

// Temporary struct to decode yt-dlp JSON lines
private struct YTDLPVideoResponse: Codable {
    let id: String
    let webpage_url: String?
    let title: String?
    let thumbnail: String?
    let duration: Int?
    let view_count: Int?
    let like_count: Int?
    let upload_date: String?
}

@MainActor
class YTDLPService {
    private var activeProcesses: [Process] = []
    private var videoProcessMap: [String: Process] = [:]
    private var fetchProcess: Process?
    
    static func currentSupportDirectory() -> URL {
        if let customPath = UserDefaults.standard.string(forKey: "customInstallPath"), !customPath.isEmpty {
            return URL(fileURLWithPath: customPath)
        }
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("VideoDownloaderVN", isDirectory: true)
    }
    
    // Path to the downloaded yt-dlp executable in Application Support
    private var executableURL: URL {
        return Self.currentSupportDirectory().appendingPathComponent("yt-dlp_macos")
    }
    
    // Path to ffmpeg folder
    private var ffmpegPath: String {
        return Self.currentSupportDirectory().path
    }
    
    // 1. Fetch Metadata (JSON Lines)
    func fetchMetadata(url: String, startIndex: Int, endIndex: Int) async throws -> [VideoItem] {
        let executableURL = self.executableURL
        
        let process = Process()
        process.executableURL = executableURL
        
        var args = [
            "--ffmpeg-location", ffmpegPath,
            "--dump-json",
            "--playlist-start", "\(startIndex)",
            "--playlist-end", "\(endIndex)",
        ]
        
        if UserDefaults.standard.bool(forKey: "useCookies") {
            let browser = UserDefaults.standard.string(forKey: "cookiesBrowser") ?? "safari"
            args.append(contentsOf: ["--cookies-from-browser", browser])
        }
        
        args.append(url)
        process.arguments = args
        
        let pipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = pipe
        process.standardError = errorPipe
        
        activeProcesses.append(process)
        self.fetchProcess = process
        
        defer {
            activeProcesses.removeAll { $0 == process }
            if self.fetchProcess == process { self.fetchProcess = nil }
        }
        
        // Đẩy tác vụ chạy lệnh và phân tích JSON nặng sang Background để tránh Đơ UI
        return try await Task.detached(priority: .userInitiated) {
            return try await withThrowingTaskGroup(of: [VideoItem].self) { group in
                group.addTask {
                    try process.run()
                    process.waitUntilExit()
                    
                    if process.terminationStatus != 0 {
                        let errorData = try? errorPipe.fileHandleForReading.readToEnd()
                        let errorString = String(decoding: errorData ?? Data(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                        
                        var userFriendlyError = "Lỗi yt-dlp (\(process.terminationStatus))"
                        if errorString.contains("Sign in to confirm you’re not a bot") || errorString.contains("needs to login") || errorString.contains("Login required") {
                            userFriendlyError = "Nền tảng yêu cầu đăng nhập. Vui lòng bật 'Sử dụng Cookies từ trình duyệt' trong Cài đặt."
                        } else if !errorString.isEmpty {
                            userFriendlyError = errorString
                        }
                        
                        throw NSError(domain: "YTDLPError", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: userFriendlyError])
                    }
                    
                    guard let data = try? pipe.fileHandleForReading.readToEnd() else {
                        return [VideoItem]()
                    }
                    
                    let outputString = String(decoding: data, as: UTF8.self)
                    var parsedItems: [VideoItem] = []
                    let decoder = JSONDecoder()
                    let dateFormatter = DateFormatter()
                    dateFormatter.dateFormat = "yyyyMMdd" // yt-dlp upload_date format
                    
                    // Parse JSON Lines
                    let lines = outputString.components(separatedBy: .newlines).filter { !$0.isEmpty }
                    for line in lines {
                        if let lineData = line.data(using: .utf8),
                           let rawVideo = try? decoder.decode(YTDLPVideoResponse.self, from: lineData) {
                            
                            let uploadDate = dateFormatter.date(from: rawVideo.upload_date ?? "") ?? Date()
                            
                            let item = VideoItem(
                                id: rawVideo.id,
                                url: rawVideo.webpage_url ?? "",
                                title: rawVideo.title ?? "Unknown Title",
                                thumbnailURL: rawVideo.thumbnail,
                                duration: rawVideo.duration ?? 0,
                                views: rawVideo.view_count ?? 0,
                                likes: rawVideo.like_count ?? 0,
                                uploadDate: uploadDate,
                                status: .idle
                            )
                            parsedItems.append(item)
                        }
                    }
                    return parsedItems
                }
                
                group.addTask {
                    // Timeout sau 60 giây
                    try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                    process.terminate()
                    throw NSError(domain: "TimeoutError", code: -1, userInfo: [NSLocalizedDescriptionKey: "Hết thời gian chờ (60s). Có thể kết nối mạng yếu hoặc bị chặn, vui lòng thử bật Cookies trong Cài đặt."])
                }
                
                let result = try await group.next()!
                group.cancelAll()
                return result
            }
        }.value
    }
    
    // 2 & 3. Download Video with AsyncStream yielding progress
    func downloadVideo(video: VideoItem, downloadType: String, videoFormat: String, audioFormat: String, resolution: String, destinationFolder: URL) -> AsyncStream<DownloadProgressData> {
        AsyncStream { continuation in
            let executableURL = self.executableURL
            
            let process = Process()
            process.executableURL = executableURL
            
            var args = [
                "--ffmpeg-location", self.ffmpegPath,
                "--newline",
                "--no-colors",
                "--retries", "infinite",
                "--fragment-retries", "infinite",
            ]
            
            if downloadType == "audio" {
                args.append(contentsOf: [
                    "-f", "bestaudio/best",
                    "-x",
                    "--audio-format", audioFormat
                ])
            } else {
                let formatArg = resolution == "best" ? "bestvideo+bestaudio/best" : "bestvideo[height<=\(resolution)]+bestaudio/best"
                args.append(contentsOf: [
                    "-f", formatArg,
                    "--merge-output-format", videoFormat
                ])
            }
            
            if UserDefaults.standard.bool(forKey: "useCookies") {
                let browser = UserDefaults.standard.string(forKey: "cookiesBrowser") ?? "safari"
                args.append(contentsOf: ["--cookies-from-browser", browser])
            }
            
            args.append(contentsOf: [
                "-o", "\(destinationFolder.path)/\(video.safeFileName).%(ext)s",
                video.url
            ])
            
            process.arguments = args
            
            let pipe = Pipe()
            process.standardOutput = pipe
            let errPipe = Pipe()
            process.standardError = errPipe
            
            Task { @MainActor in
                self.activeProcesses.append(process)
                self.videoProcessMap[video.id] = process
            }
            
            let fileHandle = pipe.fileHandleForReading
            fileHandle.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty, let output = String(data: data, encoding: .utf8) else { return }
                
                // Parse stdout lines to yield progress
                let lines = output.components(separatedBy: .newlines)
                for line in lines {
                    if let progress = YTDLPParser.parseProgress(from: line) {
                        continuation.yield(progress)
                    }
                }
            }
            
            var stderrString = ""
            let errHandle = errPipe.fileHandleForReading
            errHandle.readabilityHandler = { handle in
                let data = handle.availableData
                if !data.isEmpty, let output = String(data: data, encoding: .utf8) {
                    stderrString += output
                }
            }
            
            process.terminationHandler = { p in
                fileHandle.readabilityHandler = nil
                errHandle.readabilityHandler = nil
                Task { @MainActor [weak self] in
                    self?.activeProcesses.removeAll { $0 == p }
                    self?.videoProcessMap.removeValue(forKey: video.id)
                }
                
                if p.terminationStatus == 0 {
                    continuation.yield(DownloadProgressData(progress: 1.0, speed: "", totalSize: "", eta: "", isFinished: true, error: nil))
                } else {
                    continuation.yield(DownloadProgressData(progress: 0.0, speed: "", totalSize: "", eta: "", isFinished: true, error: stderrString.trimmingCharacters(in: .whitespacesAndNewlines)))
                }
                continuation.finish()
            }
            
            do {
                try process.run()
            } catch {
                continuation.yield(DownloadProgressData(progress: 0.0, speed: "", totalSize: "", eta: "", isFinished: true, error: "Lỗi thực thi yt-dlp: \(error.localizedDescription)"))
                continuation.finish()
            }
        }
    }
    
    // 4. Pausing, Resuming, Canceling individual videos
    func pauseDownload(videoId: String) {
        if let process = videoProcessMap[videoId], process.isRunning {
            process.suspend()
        }
    }
    
    func resumeDownload(videoId: String) {
        if let process = videoProcessMap[videoId], process.isRunning {
            process.resume()
        }
    }
    
    func cancelDownload(videoId: String) {
        if let process = videoProcessMap[videoId] {
            if process.isRunning {
                process.terminate()
            }
            activeProcesses.removeAll { $0 == process }
            videoProcessMap.removeValue(forKey: videoId)
        }
    }
    
    // 5. Cancel all running processes
    func cancelAllDownloads() {
        for process in activeProcesses where process.isRunning {
            if process != fetchProcess {
                process.terminate()
            }
        }
        activeProcesses.removeAll { $0 != fetchProcess }
        videoProcessMap.removeAll()
    }
    
    func cancelFetch() {
        if let process = fetchProcess, process.isRunning {
            process.terminate()
        }
        fetchProcess = nil
    }
}

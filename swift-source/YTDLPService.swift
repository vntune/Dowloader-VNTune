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
    
    // Path to the downloaded yt-dlp executable in Application Support
    private var executableURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let supportDirectory = appSupport.appendingPathComponent("VideoDownloaderVN", isDirectory: true)
        return supportDirectory.appendingPathComponent("yt-dlp_macos")
    }
    
    // Path to ffmpeg folder
    private var ffmpegPath: String {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let supportDirectory = appSupport.appendingPathComponent("VideoDownloaderVN", isDirectory: true)
        return supportDirectory.path
    }
    
    // 1. Fetch Metadata (JSON Lines)
    func fetchMetadata(url: String, startIndex: Int, endIndex: Int) async throws -> [VideoItem] {
        let executableURL = self.executableURL
        
        let process = Process()
        process.executableURL = executableURL
        process.arguments = [
            "--ffmpeg-location", ffmpegPath,
            "--dump-json",
            "--playlist-start", "\(startIndex)",
            "--playlist-end", "\(endIndex)",
            url
        ]
        
        let pipe = Pipe()
        process.standardOutput = pipe
        
        activeProcesses.append(process)
        
        // Đẩy tác vụ chạy lệnh và phân tích JSON nặng sang Background để tránh Đơ UI
        let items: [VideoItem]? = try? await Task.detached(priority: .userInitiated) {
            try process.run()
            
            guard let data = try? pipe.fileHandleForReading.readToEnd() else {
                process.terminate()
                return [VideoItem]()
            }
            
            process.waitUntilExit()
            
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
        }.value
        
        activeProcesses.removeAll { $0 == process }
        
        return items ?? []
    }
    
    // 2 & 3. Download Video with AsyncStream yielding progress
    func downloadVideo(video: VideoItem, downloadType: String, videoFormat: String, audioFormat: String, resolution: String, destinationFolder: URL) -> AsyncStream<DownloadProgressData> {
        AsyncStream { continuation in
            let executableURL = self.executableURL
            
            let process = Process()
            process.executableURL = executableURL
            
            var args = [
                "--ffmpeg-location", ffmpegPath,
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
    
    // 4. Cancel all running processes
    func cancelAllProcesses() {
        for process in activeProcesses where process.isRunning {
            process.terminate()
        }
        activeProcesses.removeAll()
    }
}

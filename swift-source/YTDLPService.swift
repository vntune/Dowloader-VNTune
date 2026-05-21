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
    
    // Path to the bundled yt-dlp executable
    private var executableURL: URL? {
        Bundle.main.url(forResource: "yt-dlp_macos", withExtension: nil)
    }
    
    // 1. Fetch Metadata (JSON Lines)
    func fetchMetadata(url: String, startIndex: Int, endIndex: Int) async throws -> [VideoItem] {
        guard let executableURL = executableURL else {
            throw YTDLPError.binaryNotFound
        }
        
        let process = Process()
        process.executableURL = executableURL
        process.arguments = [
            "--dump-json",
            "--playlist-start", "\(startIndex)",
            "--playlist-end", "\(endIndex)",
            url
        ]
        
        let pipe = Pipe()
        process.standardOutput = pipe
        
        activeProcesses.append(process)
        try process.run()
        
        // Wait for EOF using modernized Swift reads
        guard let data = try? pipe.fileHandleForReading.readToEnd() else {
            process.terminate()
            throw YTDLPError.processFailed(-1)
        }
        
        process.waitUntilExit()
        activeProcesses.removeAll { $0 == process }
        
        if process.terminationStatus != 0 {
            throw YTDLPError.processFailed(process.terminationStatus)
        }
        
        let outputString = String(decoding: data, as: UTF8.self)
        var items: [VideoItem] = []
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
                items.append(item)
            }
        }
        
        return items
    }
    
    // 2 & 3. Download Video with AsyncStream yielding progress
    func downloadVideo(video: VideoItem, resolution: String, destinationFolder: URL) -> AsyncStream<Double> {
        AsyncStream { continuation in
            guard let executableURL = executableURL else {
                continuation.finish()
                return
            }
            
            let process = Process()
            process.executableURL = executableURL
            process.arguments = [
                "--newline",
                "--no-colors",
                "--restrict-filenames",
                "-f", "bestvideo[height<=\(resolution)]+bestaudio/best",
                "-o", "\(destinationFolder.path)/%(title)s.%(ext)s",
                video.url
            ]
            
            let pipe = Pipe()
            process.standardOutput = pipe
            
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
            
            process.terminationHandler = { p in
                fileHandle.readabilityHandler = nil
                Task { @MainActor [weak self] in
                    self?.activeProcesses.removeAll { $0 == p }
                }
                continuation.finish()
            }
            
            do {
                try process.run()
            } catch {
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

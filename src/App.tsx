import { Check, Copy, Terminal, FileCode2 } from "lucide-react";
import { useState } from "react";

const modelsCode = `import Foundation

// 1. Data Models
enum VideoStatus: String, Codable, Equatable {
    case idle
    case fetching
    case downloading
    case success
    case error
}

struct DownloadProgressData: Equatable {
    var progress: Double
    var speed: String
    var totalSize: String
    var eta: String
    var isFinished: Bool = false
    var error: String? = nil
}

enum NamingStrategy: Int, CaseIterable, Identifiable {
    case original = 0
    case removeSpecialAndSpaces = 1
    
    var id: Int { rawValue }
}

struct VideoItem: Identifiable, Codable, Equatable {
    var id: String
    var url: String
    var title: String
    var thumbnailURL: String?
    var duration: Int
    var views: Int
    var likes: Int
    var uploadDate: Date
    var downloadProgress: Double = 0.0 // Value from 0.0 to 1.0
    var downloadSpeed: String = ""
    var totalSize: String = ""
    var downloadEta: String = ""
    var isSelected: Bool = false
    var status: VideoStatus = .idle
    var errorDescription: String? = nil
    
    // 2. Computed Property for safeFileName based on Settings
    var safeFileName: String {
        let strategyValue = UserDefaults.standard.integer(forKey: "fileNameStrategy")
        let maxLenObj = UserDefaults.standard.object(forKey: "maxFileNameLength")
        let maxLength = maxLenObj == nil ? 200 : (maxLenObj as? Int ?? 200)
        
        var strategy = NamingStrategy(rawValue: strategyValue)
        // Fallback or mapping for old value 2
        if strategy == nil || strategyValue == 2 {
            strategy = .removeSpecialAndSpaces
        }
        
        let invalidChars: Set<Character> = ["/", ":", "\\\\", "*", "?", "\\"", "<", ">", "|"]
        
        switch strategy! {
        case .original:
            // Filter OS-forbidden characters to avoid file write errors, but keep everything else including spaces and unicode
            let cleanedTitle = title.filter { !invalidChars.contains($0) }
            return String(cleanedTitle.prefix(maxLength))
            
        case .removeSpecialAndSpaces:
            let allowedCharacterSet = CharacterSet.alphanumerics.union(CharacterSet.whitespaces)
            let cleanedTitle = title.components(separatedBy: allowedCharacterSet.inverted).joined()
            let shortened = String(cleanedTitle.prefix(maxLength))
            return shortened.replacingOccurrences(of: " ", with: "_")
        }
    }
}

// 3. Regex Helper using modern Swift 5.7+ Regex syntax
struct YTDLPParser {
    static func parseProgress(from output: String) -> DownloadProgressData? {
        // Progress
        var progress: Double = 0.0
        let progressRegex = /\\[download\\]\\s+([0-9\\.]+)%/
        if let match = try? progressRegex.firstMatch(in: output), let val = Double(match.1) {
            progress = val / 100.0
        } else {
            return nil
        }
        
        // Total size
        var totalSize = ""
        let sizeRegex = /of\\s+~?\\s*([0-9\\.]+[A-Za-z]+)/
        if let match = try? sizeRegex.firstMatch(in: output) {
            totalSize = String(match.1)
        }
        
        // Speed
        var speed = ""
        let speedRegex = /at\\s+([0-9\\.]+[A-Za-z]+\\/s)/
        if let match = try? speedRegex.firstMatch(in: output) {
            speed = String(match.1)
        }
        
        // ETA
        var eta = ""
        let etaRegex = /ETA\\s+([0-9:]+)/
        if let match = try? etaRegex.firstMatch(in: output) {
            eta = String(match.1)
        }
        
        return DownloadProgressData(progress: progress, speed: speed, totalSize: totalSize, eta: eta)
    }
}
`;

const serviceCode = `import Foundation

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
        process.arguments = [
            "--ffmpeg-location", ffmpegPath,
            "--dump-json",
            "--playlist-start", "\\(startIndex)",
            "--playlist-end", "\\(endIndex)",
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
                let formatArg = resolution == "best" ? "bestvideo+bestaudio/best" : "bestvideo[height<=\\(resolution)]+bestaudio/best"
                args.append(contentsOf: [
                    "-f", formatArg,
                    "--merge-output-format", videoFormat
                ])
            }
            
            args.append(contentsOf: [
                "-o", "\\(destinationFolder.path)/\\(video.safeFileName).%(ext)s",
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
                continuation.yield(DownloadProgressData(progress: 0.0, speed: "", totalSize: "", eta: "", isFinished: true, error: "Lỗi thực thi yt-dlp: \\(error.localizedDescription)"))
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
`;

const viewModelCode = `import Foundation
import Combine

enum SortOption {
    case dateDesc, dateAsc
    case viewsDesc, viewsAsc
    case titleAsc, titleDesc
}

@MainActor
class DownloaderViewModel: ObservableObject {
    // 1. Properties
    @Published var videos: [VideoItem] = []
    @Published var isLoading: Bool = false
    @Published var urlInput: String = ""
    @Published var selectedResolution: String = "1080" // 720, 1080, 2160
    @Published var downloadType: String = "video"
    @Published var videoFormat: String = "mp4"
    @Published var audioFormat: String = "mp3"
    @Published var destinationFolder: URL?
    
    // Filter and Sort states
    @Published var minViewsFilter: Int = 0
    @Published var sortOption: SortOption = .dateDesc
    
    // Pagination tracking
    private var currentStartIndex: Int = 1
    private var pageSize: Int {
        let saved = UserDefaults.standard.integer(forKey: "fetchPageSize")
        return saved > 0 ? saved : 50
    }
    
    private let service = YTDLPService()
    
    // 3. Computed property for filtered & sorted videos to bind in UI
    var filteredAndSortedVideos: [VideoItem] {
        let filtered = videos.filter { $0.views >= minViewsFilter }
        
        return filtered.sorted { v1, v2 in
            switch sortOption {
            case .dateDesc: return v1.uploadDate > v2.uploadDate
            case .dateAsc: return v1.uploadDate < v2.uploadDate
            case .viewsDesc: return v1.views > v2.views
            case .viewsAsc: return v1.views < v2.views
            case .titleAsc: return v1.title < v2.title
            case .titleDesc: return v1.title > v2.title
            }
        }
    }
    
    // 2. Pagination Logic: Fetch initial batch (1 to 50)
    func fetchVideos(url: String) async {
        self.urlInput = url
        self.currentStartIndex = 1
        self.isLoading = true
        self.videos.removeAll()
        
        do {
            let fetched = try await service.fetchMetadata(
                url: url,
                startIndex: currentStartIndex,
                endIndex: currentStartIndex + pageSize - 1
            )
            self.videos = fetched
        } catch {
            print("Fetch error: \\(error)")
        }
        
        self.isLoading = false
    }
    
    // 2. Pagination Logic: Load next batch and append
    func loadMore() async {
        guard !urlInput.isEmpty, !isLoading else { return }
        
        isLoading = true
        currentStartIndex += pageSize
        
        do {
            let fetched = try await service.fetchMetadata(
                url: urlInput,
                startIndex: currentStartIndex,
                endIndex: currentStartIndex + pageSize - 1
            )
            self.videos.append(contentsOf: fetched)
        } catch {
            print("Load more error: \\(error)")
        }
        
        isLoading = false
    }
    
    // 4. Selection Logic
    func selectAll(_ select: Bool) {
        for index in videos.indices {
            videos[index].isSelected = select
        }
    }
    
    // 5. Download Logic implementation returning AsyncStream results
    func startDownloadSelectedVideos() async {
        guard let destURL = destinationFolder else { return }
        
        let savedMax = UserDefaults.standard.integer(forKey: "maxConcurrentDownloads")
        let maxConcurrentDownloads = savedMax > 0 ? savedMax : 3
        
        let indicesToDownload = videos.indices.filter { videos[$0].isSelected && videos[$0].status != .success }
        
        for index in indicesToDownload {
            videos[index].status = .downloading
            videos[index].downloadProgress = 0.0
            videos[index].errorDescription = nil
        }
        
        let type = self.downloadType
        let vFormat = self.videoFormat
        let aFormat = self.audioFormat
        let resolution = self.selectedResolution
        let service = self.service
        
        await withTaskGroup(of: Void.self) { group in
            var activeTasks = 0
            var iterator = indicesToDownload.makeIterator()
            
            while let index = iterator.next() {
                if activeTasks >= maxConcurrentDownloads {
                    await group.next()
                    activeTasks -= 1
                }
                
                let video = videos[index]
                activeTasks += 1
                
                group.addTask {
                    let stream = await service.downloadVideo(
                        video: video,
                        downloadType: type,
                        videoFormat: vFormat,
                        audioFormat: aFormat,
                        resolution: resolution,
                        destinationFolder: destURL
                    )
                    
                    var finalError: String? = nil
                    
                    for await data in stream {
                        if data.isFinished {
                            finalError = data.error
                            break
                        }
                        
                        await MainActor.run {
                            if let currentIndex = self.videos.firstIndex(where: { $0.id == video.id }) {
                                self.videos[currentIndex].downloadProgress = data.progress
                                self.videos[currentIndex].downloadSpeed = data.speed
                                self.videos[currentIndex].totalSize = data.totalSize
                                self.videos[currentIndex].downloadEta = data.eta
                            }
                        }
                    }
                    
                    await MainActor.run {
                        if let currentIndex = self.videos.firstIndex(where: { $0.id == video.id }) {
                            if let errorMsg = finalError {
                                self.videos[currentIndex].status = .error
                                self.videos[currentIndex].errorDescription = errorMsg
                            } else {
                                self.videos[currentIndex].status = .success
                                self.videos[currentIndex].downloadProgress = 1.0
                            }
                        }
                    }
                }
            }
            
            for _ in 0..<activeTasks {
                await group.next()
            }
        }
    }
    
    func retryDownload(for id: String) {
        guard let index = videos.firstIndex(where: { $0.id == id }) else { return }
        videos[index].status = .idle
        videos[index].errorDescription = nil
        videos[index].isSelected = true
        
        Task {
            await startDownloadSelectedVideos()
        }
    }
    
    // 6. Cancel Downloads
    func cancelDownloads() {
        service.cancelAllProcesses()
        
        // Reset state for currently downloading videos
        for index in videos.indices where videos[index].status == .downloading {
            videos[index].status = .idle
            videos[index].downloadProgress = 0.0
        }
    }
}
`;

const dependencyManagerCode = `import Foundation
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
            statusMessage = "Lỗi cài đặt: \\(error.localizedDescription)"
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
`;

const viewsCode = `import SwiftUI
import AppKit

struct MainView: View {
    @StateObject private var viewModel = DownloaderViewModel()
    @StateObject private var dependencyManager = DependencyManager()
    @State private var selectAll: Bool = false
    @State private var showingSettings = false
    
    var body: some View {
        mainContent
            .frame(minWidth: 800, minHeight: 600)
            .onAppear {
                dependencyManager.checkDependencies()
            }
    }
    
    var loadingView: some View {
        VStack(spacing: 20) {
            if dependencyManager.progress > 0 {
                ProgressView(value: dependencyManager.progress)
                    .progressViewStyle(.linear)
                    .frame(width: 300)
            } else {
                ProgressView()
                    .progressViewStyle(.circular)
                    .scaleEffect(1.5)
            }
            
            Text(dependencyManager.statusMessage)
                .font(.headline)
                .foregroundColor(.secondary)
            
            if dependencyManager.statusMessage.contains("Lỗi") {
                Button("Thử lại") {
                    Task { await dependencyManager.setupDependencies() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
    }
    
    var mainContent: some View {
        VStack(spacing: 0) {
            // 1. Header / Input Section
            VStack(spacing: 16) {
                HStack {
                    TextField("Nhập link YouTube video hoặc playlist...", text: $viewModel.urlInput)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.large)
                    
                    Button("Quét") {
                        Task { await viewModel.fetchVideos(url: viewModel.urlInput) }
                    }
                    .controlSize(.large)
                    .disabled(viewModel.urlInput.isEmpty || viewModel.isLoading || !dependencyManager.isReady)
                    
                    Button(action: { showingSettings = true }) {
                        Image(systemName: "gearshape")
                    }
                    .controlSize(.large)
                    .help("Cài đặt hệ thống")
                }
                
                HStack {
                    Picker("", selection: $viewModel.downloadType) {
                        Text("Video").tag("video")
                        Text("Audio").tag("audio")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 140)
                    
                    if viewModel.downloadType == "video" {
                        Picker("Định dạng:", selection: $viewModel.videoFormat) {
                            Text("mp4").tag("mp4")
                            Text("mkv").tag("mkv")
                            Text("webm").tag("webm")
                            Text("mov").tag("mov")
                            Text("avi").tag("avi")
                        }
                        .pickerStyle(.menu)

                        Picker("Phân giải:", selection: $viewModel.selectedResolution) {
                            Text("Cao nhất").tag("best")
                            Text("720p").tag("720")
                            Text("1080p").tag("1080")
                            Text("2K").tag("1440")
                            Text("4K").tag("2160")
                        }
                        .pickerStyle(.menu)
                    } else {
                        Picker("Định dạng:", selection: $viewModel.audioFormat) {
                            Text("mp3").tag("mp3")
                            Text("m4a").tag("m4a")
                            Text("aac").tag("aac")
                            Text("opus").tag("opus")
                            Text("wav").tag("wav")
                            Text("flac").tag("flac")
                        }
                        .pickerStyle(.menu)
                    }
                    
                    Spacer()
                    
                    Button(action: selectDestinationFolder) {
                        Label(viewModel.destinationFolder?.path ?? "Chọn thư mục lưu...", systemImage: "folder")
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            .padding()
            .background(Color(NSColor.controlBackgroundColor))
            
            Divider()
            
            // 2. Toolbar / Control Bar
            HStack {
                Toggle("Chọn tất cả", isOn: $selectAll)
                    .onChange(of: selectAll) { newValue in
                        viewModel.selectAll(newValue)
                    }
                
                Spacer()
                
                HStack(spacing: 16) {
                    Picker("Lọc Views:", selection: $viewModel.minViewsFilter) {
                        Text("Tất cả").tag(0)
                        Text("> 10K").tag(10000)
                        Text("> 100K").tag(100000)
                        Text("> 1 Triệu").tag(1000000)
                    }
                    .frame(width: 140)
                    
                    Picker("Sắp xếp:", selection: $viewModel.sortOption) {
                        Text("Ngày đăng (Mới nhất)").tag(SortOption.dateDesc)
                        Text("Ngày đăng (Cũ nhất)").tag(SortOption.dateAsc)
                        Text("Lượt xem (Giảm dần)").tag(SortOption.viewsDesc)
                        Text("Lượt xem (Tăng dần)").tag(SortOption.viewsAsc)
                        Text("Tên (A-Z)").tag(SortOption.titleAsc)
                        Text("Tên (Z-A)").tag(SortOption.titleDesc)
                    }
                    .frame(width: 220)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(Color(NSColor.windowBackgroundColor))
            
            Divider()
            
            // 3. Video List
            List {
                ForEach(viewModel.filteredAndSortedVideos) { video in
                    VideoCellView(video: video, viewModel: viewModel)
                }
                
                // Load More Button
                if !viewModel.videos.isEmpty {
                    HStack {
                        Spacer()
                        Button("Tải thêm video") {
                            Task { await viewModel.loadMore() }
                        }
                        .padding(.vertical)
                        .disabled(viewModel.isLoading)
                        Spacer()
                    }
                }
            }
            .overlay {
                if viewModel.isLoading && viewModel.videos.isEmpty {
                    ProgressView("Đang quét dữ liệu...")
                }
            }
            
            Divider()
            
            // 5. Bottom Action Bar
            HStack {
                Text("Video Downloader by VNTune.com")
                    .font(.caption)
                    .foregroundColor(.secondary)
                
                Spacer()
                
                Text("Đã chọn \(viewModel.videos.filter { $0.isSelected }.count) / \(viewModel.videos.count) video")
                    .foregroundColor(.secondary)
                    .padding(.trailing, 10)
                
                Button("Hủy") {
                    viewModel.cancelDownloads()
                }
                .keyboardShortcut(.cancelAction)
                
                Button("Tải xuống các video đã chọn") {
                    Task { await viewModel.startDownloadSelectedVideos() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(viewModel.destinationFolder == nil || !viewModel.videos.contains { $0.isSelected } || !dependencyManager.isReady)
            }
            .padding()
            .background(Color(NSColor.controlBackgroundColor))
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
                .environmentObject(dependencyManager)
        }
    }
    
    // macOS NSOpenPanel
    private func selectDestinationFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Chọn làm thư mục tải về"
        
        if panel.runModal() == .OK {
            viewModel.destinationFolder = panel.url
        }
    }
}

struct VideoCellView: View {
    let video: VideoItem
    @ObservedObject var viewModel: DownloaderViewModel
    
    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Toggle("", isOn: Binding(
                get: { video.isSelected },
                set: { newValue in
                    if let index = viewModel.videos.firstIndex(where: { $0.id == video.id }) {
                        viewModel.videos[index].isSelected = newValue
                    }
                }
            ))
            .labelsHidden()
            .padding(.top, 4)
            
            AsyncImage(url: URL(string: video.thumbnailURL ?? "")) { phase in
                if let image = phase.image {
                    image.resizable()
                         .aspectRatio(contentMode: .fill)
                } else {
                    Rectangle().fill(Color.gray.opacity(0.2))
                }
            }
            .frame(width: 140, height: 75)
            .cornerRadius(8)
            
            VStack(alignment: .leading, spacing: 6) {
                Text(video.title)
                    .font(.system(.headline, design: .default))
                    .lineLimit(2)
                    .foregroundColor(.primary)
                
                HStack(spacing: 16) {
                    Label("\\(video.views.formatted())", systemImage: "eye")
                    Label("\\(video.likes.formatted())", systemImage: "hand.thumbsup")
                    Label(video.uploadDate.formatted(date: .abbreviated, time: .omitted), systemImage: "calendar")
                    if let url = URL(string: video.url) {
                        Link(destination: url) {
                            HStack(spacing: 4) {
                                Image(systemName: "link")
                                Text("Xem Video")
                            }
                        }
                    }
                }
                .font(.caption)
                .foregroundColor(.secondary)
                
                // 4. Tiến trình tải
                if video.status != .idle && video.status != .fetching {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            ProgressView(value: video.downloadProgress)
                                .progressViewStyle(.linear)
                                .frame(maxWidth: 300)
                            
                            Text("\\(Int(video.downloadProgress * 100))%")
                                .font(.caption.monospacedDigit())
                                .foregroundColor(.secondary)
                                .frame(width: 40, alignment: .trailing)
                                
                            Text(statusText)
                                .font(.caption2.bold())
                                .foregroundColor(statusColor)
                                .padding(.leading, 4)
                        }
                        
                        if video.status == .downloading {
                            HStack(spacing: 12) {
                                if !video.totalSize.isEmpty {
                                    Text("Dung lượng: \\(video.totalSize)")
                                }
                                if !video.downloadSpeed.isEmpty {
                                    Text("Tốc độ: \\(video.downloadSpeed)")
                                }
                                if !video.downloadEta.isEmpty {
                                    Text("Còn lại: \\(video.downloadEta)")
                                }
                            }
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        } else if video.status == .success {
                            Button("Mở thư mục") {
                                if let folder = viewModel.destinationFolder {
                                    NSWorkspace.shared.open(folder)
                                }
                            }
                            .buttonStyle(.link)
                            .font(.caption)
                        } else if video.status == .error {
                            HStack {
                                if let errorMsg = video.errorDescription {
                                    Text(errorMsg)
                                        .font(.caption2)
                                        .foregroundColor(.red)
                                        .lineLimit(2)
                                }
                                Button {
                                    viewModel.retryDownload(for: video.id)
                                } label: {
                                    Label("Thử lại", systemImage: "arrow.clockwise")
                                }
                                .buttonStyle(.borderless)
                                .font(.caption2)
                                .foregroundColor(.blue)
                            }
                        }
                    }
                    .padding(.top, 2)
                }
            }
            Spacer()
        }
        .padding(.vertical, 6)
    }
    
    private var statusText: String {
        switch video.status {
        case .downloading: return "Đang tải"
        case .success: return "Hoàn tất"
        case .error: return "Lỗi"
        default: return ""
        }
    }
    
    private var statusColor: Color {
        switch video.status {
        case .downloading: return .blue
        case .success: return .green
        case .error: return .red
        default: return .clear
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var dependencyManager: DependencyManager
    @AppStorage("maxConcurrentDownloads") var maxConcurrentDownloads: Int = 3
    @AppStorage("fetchPageSize") var fetchPageSize: Int = 50
    @AppStorage("fileNameStrategy") var fileNameStrategy: Int = 1
    @AppStorage("maxFileNameLength") var maxFileNameLength: Int = 200
    
    @State private var draftMaxConcurrentDownloads: Int = 3
    @State private var draftFetchPageSize: Int = 50
    @State private var draftFileNameStrategy: Int = 1
    @State private var draftMaxFileNameLength: Int = 200
    
    @Environment(\.dismiss) var dismiss
    
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Cài đặt hệ thống")
                .font(.title2)
                .bold()
            
            Form {
                Stepper(value: $draftMaxConcurrentDownloads, in: 1...10) {
                    HStack {
                        Text("Số video tải xuống cùng lúc:")
                        Text("\\(draftMaxConcurrentDownloads)")
                            .bold()
                    }
                }
                
                Stepper(value: $draftFetchPageSize, in: 10...200, step: 10) {
                    HStack {
                        Text("Số video mỗi lần quét/tải thêm:")
                        Text("\\(draftFetchPageSize)")
                            .bold()
                    }
                }
                
                Picker("Cách đặt tên file tải về:", selection: $draftFileNameStrategy) {
                    Text("1. Giữ nguyên tên gốc").tag(0)
                    Text("2. Loại bỏ ký tự đặc biệt & thay khoảng trắng bằng \"_\"").tag(1)
                }
                .padding(.top, 10)
                
                Stepper(value: $draftMaxFileNameLength, in: 10...255, step: 5) {
                    HStack {
                        Text("Giới hạn số ký tự tên file:")
                        Text("\\(draftMaxFileNameLength)")
                            .bold()
                    }
                }
                
                VStack(alignment: .leading, spacing: 12) {
                    Text("Môi trường thực thi")
                        .font(.headline)
                        .foregroundColor(.primary)
                        .padding(.top, 10)
                    
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Thư mục cài đặt công cụ:")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        
                        HStack {
                            Text(dependencyManager.supportDirectory.path)
                                .font(.caption2.monospaced())
                                .lineLimit(1)
                                .truncationMode(.middle)
                            
                            Spacer()
                            
                            Button("Thay đổi") {
                                let panel = NSOpenPanel()
                                panel.canChooseFiles = false
                                panel.canChooseDirectories = true
                                panel.allowsMultipleSelection = false
                                if panel.runModal() == .OK, let url = panel.url {
                                    UserDefaults.standard.set(url.path, forKey: "customInstallPath")
                                    dependencyManager.updatePaths()
                                }
                            }
                            
                            Button("Mở") {
                                NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: dependencyManager.supportDirectory.path)
                            }
                            
                            Button(action: {
                                dependencyManager.updatePaths()
                            }) {
                                Image(systemName: "arrow.clockwise")
                            }
                            .help("Làm mới trạng thái thư mục")
                        }
                    }
                    
                    VStack(alignment: .leading, spacing: 4) {
                        Text("yt-dlp:")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Text(dependencyManager.ytDlpPathDisplay)
                            .font(.caption2.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    
                    VStack(alignment: .leading, spacing: 4) {
                        Text("ffmpeg:")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Text(dependencyManager.ffmpegPathDisplay)
                            .font(.caption2.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    
                    HStack {
                        Button(dependencyManager.needsInstall ? "Tải về bộ cài" : "Kiểm tra cập nhật") {
                            Task {
                                await dependencyManager.updateOrInstallDependencies()
                            }
                        }
                        .disabled(dependencyManager.isInstalling)
                        
                        if dependencyManager.isInstalling {
                            ProgressView()
                                .controlSize(.small)
                                .padding(.leading, 8)
                            Text(dependencyManager.statusMessage)
                                .font(.caption)
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()
            
            HStack {
                Spacer()
                Button("Đóng") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                
                Button("Lưu") {
                    maxConcurrentDownloads = draftMaxConcurrentDownloads
                    fetchPageSize = draftFetchPageSize
                    fileNameStrategy = draftFileNameStrategy
                    maxFileNameLength = draftMaxFileNameLength
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding()
        .frame(width: 520, height: 600)
        .onAppear {
            draftMaxConcurrentDownloads = maxConcurrentDownloads
            draftFetchPageSize = fetchPageSize
            draftFileNameStrategy = fileNameStrategy
            draftMaxFileNameLength = maxFileNameLength
            dependencyManager.showPaths()
        }
    }
}
`

const appEntryCode = `import SwiftUI

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
`

type Tab = 'models' | 'service' | 'viewmodel' | 'views' | 'dependency' | 'app';

export default function App() {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('app');

  const activeCode = 
    activeTab === 'models' ? modelsCode : 
    activeTab === 'service' ? serviceCode : 
    activeTab === 'viewmodel' ? viewModelCode :
    activeTab === 'dependency' ? dependencyManagerCode :
    activeTab === 'views' ? viewsCode :
    appEntryCode;

  const handleCopy = () => {
    navigator.clipboard.writeText(activeCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#0E1117] text-gray-300 font-sans p-6 md:p-12 flex items-center justify-center">
      <div className="max-w-4xl w-full mx-auto space-y-6">
        
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center space-x-3 text-blue-400">
            <Terminal className="w-6 h-6" />
            <h1 className="text-2xl font-medium tracking-tight text-white">macOS Swift Generators</h1>
          </div>
          <p className="text-sm text-gray-400">
            Generated code for <span className="text-gray-300 font-medium tracking-wide">Video Downloader by VNTune.com</span>
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="flex space-x-1 border-b border-gray-800 overflow-x-auto">
          <button
            onClick={() => setActiveTab('models')}
            className={`flex items-center space-x-2 px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'models' 
                ? 'border-blue-500 text-white' 
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <FileCode2 className="w-4 h-4" />
            <span>Models.swift</span>
          </button>
          <button
            onClick={() => setActiveTab('service')}
            className={`flex items-center space-x-2 px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'service' 
                ? 'border-blue-500 text-white' 
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <FileCode2 className="w-4 h-4" />
            <span>YTDLPService.swift</span>
          </button>
          <button
            onClick={() => setActiveTab('viewmodel')}
            className={`flex items-center space-x-2 px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'viewmodel' 
                ? 'border-blue-500 text-white' 
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <FileCode2 className="w-4 h-4" />
            <span>DownloaderViewModel.swift</span>
          </button>
          <button
            onClick={() => setActiveTab('dependency')}
            className={`flex items-center space-x-2 px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'dependency' 
                ? 'border-blue-500 text-white' 
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <FileCode2 className="w-4 h-4" />
            <span>DependencyManager.swift</span>
          </button>
          <button
            onClick={() => setActiveTab('views')}
            className={`flex items-center space-x-2 px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'views' 
                ? 'border-blue-500 text-white' 
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <FileCode2 className="w-4 h-4" />
            <span>MainView.swift</span>
          </button>
          <button
            onClick={() => setActiveTab('app')}
            className={`flex items-center space-x-2 px-4 py-2 border-b-2 transition-colors ${
              activeTab === 'app' 
                ? 'border-blue-500 text-white' 
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <FileCode2 className="w-4 h-4" />
            <span>App.swift</span>
          </button>
        </div>

        {/* Code Renderer */}
        <div className="relative rounded-xl border border-gray-800 bg-[#161B22] overflow-hidden shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-[#0D1117]">
            <div className="flex space-x-2">
              <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50"></div>
              <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50"></div>
            </div>
            <button
              onClick={handleCopy}
              className="flex items-center space-x-2 text-xs font-mono text-gray-400 hover:text-white transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-green-400" />
                  <span className="text-green-400">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  <span>Copy Code</span>
                </>
              )}
            </button>
          </div>
          <div className="p-4 md:p-6 overflow-x-auto max-h-[60vh]">
            <pre className="font-mono text-xs md:text-sm leading-relaxed whitespace-pre font-light">
              <code className="text-[#E6EDF3]">{activeCode}</code>
            </pre>
          </div>
        </div>

      </div>
    </div>
  );
}


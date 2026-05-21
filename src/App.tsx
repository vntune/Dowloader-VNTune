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
    
    // 2. Computed Property for safeFileName
    var safeFileName: String {
        // MacOS/Windows forbidden characters
        let invalidChars: Set<Character> = ["/", ":", "\\\\", "*", "?", "\\"", "<", ">", "|"]
        let cleanedTitle = title.filter { !invalidChars.contains($0) }
        let shortened = String(cleanedTitle.prefix(200))
        return shortened.replacingOccurrences(of: " ", with: "-")
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
    func downloadVideo(video: VideoItem, format: String, resolution: String, destinationFolder: URL) -> AsyncStream<DownloadProgressData> {
        AsyncStream { continuation in
            let executableURL = self.executableURL
            
            let process = Process()
            process.executableURL = executableURL
            
            var formatArg = ""
            switch format {
            case "original": formatArg = "bestvideo+bestaudio/best"
            case "audio": formatArg = "bestaudio/best"
            default: formatArg = "bestvideo[height<=\\(resolution)]+bestaudio/best"
            }
            
            process.arguments = [
                "--ffmpeg-location", ffmpegPath,
                "--newline",
                "--no-colors",
                "--restrict-filenames",
                "--retries", "infinite",
                "--fragment-retries", "infinite",
                "-f", formatArg,
                "-o", "\\(destinationFolder.path)/\\(video.safeFileName).%(ext)s",
                video.url
            ]
            
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
    @Published var selectedFormatType: String = "original" // original, video, audio
    @Published var destinationFolder: URL?
    
    // Filter and Sort states
    @Published var minViewsFilter: Int = 0
    @Published var sortOption: SortOption = .dateDesc
    
    // Pagination tracking
    private var currentStartIndex: Int = 1
    private let pageSize: Int = 50
    
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
        
        for index in videos.indices where videos[index].isSelected && videos[index].status != .success {
            videos[index].status = .downloading
            videos[index].downloadProgress = 0.0
            videos[index].errorDescription = nil
            
            let stream = service.downloadVideo(
                video: videos[index],
                format: selectedFormatType,
                resolution: selectedResolution,
                destinationFolder: destURL
            )
            
            var finalError: String? = nil
            
            for await data in stream {
                if data.isFinished {
                    finalError = data.error
                    break
                }
                
                // Real-time main actor update from AsyncStream yield
                if let currentIndex = self.videos.firstIndex(where: { $0.id == self.videos[index].id }) {
                    self.videos[currentIndex].downloadProgress = data.progress
                    self.videos[currentIndex].downloadSpeed = data.speed
                    self.videos[currentIndex].totalSize = data.totalSize
                    self.videos[currentIndex].downloadEta = data.eta
                }
            }
            
            // Mark as success or error
            if let currentIndex = self.videos.firstIndex(where: { $0.id == self.videos[index].id }) {
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
            }
            
            statusMessage = "Đang cấp quyền thực thi cho yt-dlp..."
            try await setExecutable(url: ytDlpURL)
            
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
            
            statusMessage = "Cài đặt thành công! Đang khởi động..."
            try await Task.sleep(nanoseconds: 500_000_000)
            isReady = true
        } catch {
            statusMessage = "Lỗi cài đặt: \\(error.localizedDescription)"
        }
    }
    
    private func downloadFile(from urlString: String, to destination: URL) async throws {
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        
        self.progress = 0.0
        
        // Sử dụng download(from:) thay vì URLSession.bytes để tránh vòng lặp từng byte vốn gây đơ UI nghiêm trọng.
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
    
    var body: some View {
        Group {
            if dependencyManager.isReady {
                mainContent
            } else {
                loadingView
            }
        }
        .frame(minWidth: 800, minHeight: 600)
        .onAppear {
            Task {
                await dependencyManager.setupDependencies()
            }
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
                    .disabled(viewModel.urlInput.isEmpty || viewModel.isLoading)
                }
                
                HStack {
                    Picker("Định dạng:", selection: $viewModel.selectedFormatType) {
                        Text("Chất lượng cao nhất").tag("original")
                        Text("Ghép MP4 (Video+Audio)").tag("video")
                        Text("Chỉ Âm thanh (Audio)").tag("audio")
                    }
                    .pickerStyle(.menu)
                    .frame(width: 270)

                    Picker("Phân giải:", selection: $viewModel.selectedResolution) {
                        Text("720p").tag("720")
                        Text("1080p").tag("1080")
                        Text("2K").tag("1440")
                        Text("4K").tag("2160")
                    }
                    .pickerStyle(.menu)
                    .frame(width: 170)
                    .disabled(viewModel.selectedFormatType != "video")
                    
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
                        Button("Tải thêm 50 video") {
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
                
                Button("Hủy") {
                    viewModel.cancelDownloads()
                }
                .keyboardShortcut(.cancelAction)
                
                Button("Tải xuống các video đã chọn") {
                    Task { await viewModel.startDownloadSelectedVideos() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(viewModel.destinationFolder == nil || !viewModel.videos.contains { $0.isSelected })
            }
            .padding()
            .background(Color(NSColor.controlBackgroundColor))
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
                            if let errorMsg = video.errorDescription {
                                Text(errorMsg)
                                    .font(.caption2)
                                    .foregroundColor(.red)
                                    .lineLimit(2)
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


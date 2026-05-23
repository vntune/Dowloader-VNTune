import SwiftUI
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
                    Label("\(video.views.formatted())", systemImage: "eye")
                    Label("\(video.likes.formatted())", systemImage: "hand.thumbsup")
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
                            
                            Text("\(Int(video.downloadProgress * 100))%")
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
                                    Text("Dung lượng: \(video.totalSize)")
                                }
                                if !video.downloadSpeed.isEmpty {
                                    Text("Tốc độ: \(video.downloadSpeed)")
                                }
                                if !video.downloadEta.isEmpty {
                                    Text("Còn lại: \(video.downloadEta)")
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
                        Text("\(draftMaxConcurrentDownloads)")
                            .bold()
                    }
                }
                
                Stepper(value: $draftFetchPageSize, in: 10...200, step: 10) {
                    HStack {
                        Text("Số video mỗi lần quét/tải thêm:")
                        Text("\(draftFetchPageSize)")
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
                        Text("\(draftMaxFileNameLength)")
                            .bold()
                    }
                }
                
                VStack(alignment: .leading, spacing: 12) {
                    Text("Môi trường thực thi")
                        .font(.headline)
                        .foregroundColor(.primary)
                        .padding(.top, 10)
                    
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

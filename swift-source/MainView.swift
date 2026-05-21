import SwiftUI
import AppKit

struct MainView: View {
    @StateObject private var viewModel = DownloaderViewModel()
    @State private var selectAll: Bool = false
    
    var body: some View {
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
                    Picker("Độ phân giải:", selection: $viewModel.selectedResolution) {
                        Text("720p").tag("720")
                        Text("1080p").tag("1080")
                        Text("2K").tag("1440")
                        Text("4K").tag("2160")
                    }
                    .pickerStyle(.menu)
                    .frame(width: 200)
                    
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
        .frame(minWidth: 800, minHeight: 600)
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
                Text(video.safeFileName)
                    .font(.system(.headline, design: .default))
                    .lineLimit(2)
                    .foregroundColor(.primary)
                
                HStack(spacing: 16) {
                    Label("\(video.views.formatted())", systemImage: "eye")
                    Label("\(video.likes.formatted())", systemImage: "hand.thumbsup")
                    Label(video.uploadDate.formatted(date: .abbreviated, time: .omitted), systemImage: "calendar")
                }
                .font(.caption)
                .foregroundColor(.secondary)
                
                // 4. Tiến trình tải
                if video.status != .idle && video.status != .fetching {
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

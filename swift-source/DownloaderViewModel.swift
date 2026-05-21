import Foundation
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
            print("Fetch error: \(error)")
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
            print("Load more error: \(error)")
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
        
        let formatType = self.selectedFormatType
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
                        format: formatType,
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
    
    func retryDownload(for id: UUID) {
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

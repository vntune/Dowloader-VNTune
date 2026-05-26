import Foundation

// 1. Data Models
enum VideoStatus: String, Codable, Equatable {
    case idle
    case pending       // queued
    case fetching
    case downloading
    case paused
    case success
    case error
    case cancelled
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
        
        let invalidChars: Set<Character> = ["/", ":", "\\", "*", "?", "\"", "<", ">", "|"]
        
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
        let progressRegex = /\[download\]\s+([0-9\.]+)%/
        if let match = try? progressRegex.firstMatch(in: output), let val = Double(match.1) {
            progress = val / 100.0
        } else {
            return nil
        }
        
        // Total size
        var totalSize = ""
        let sizeRegex = /of\s+~?\s*([0-9\.]+[A-Za-z]+)/
        if let match = try? sizeRegex.firstMatch(in: output) {
            totalSize = String(match.1)
        }
        
        // Speed
        var speed = ""
        let speedRegex = /at\s+([0-9\.]+[A-Za-z]+\/s)/
        if let match = try? speedRegex.firstMatch(in: output) {
            speed = String(match.1)
        }
        
        // ETA
        var eta = ""
        let etaRegex = /ETA\s+([0-9:]+)/
        if let match = try? etaRegex.firstMatch(in: output) {
            eta = String(match.1)
        }
        
        return DownloadProgressData(progress: progress, speed: speed, totalSize: totalSize, eta: eta)
    }
}

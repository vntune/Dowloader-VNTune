import Foundation

// 1. Data Models
enum VideoStatus: String, Codable, Equatable {
    case idle
    case fetching
    case downloading
    case success
    case error
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
    var isSelected: Bool = false
    var status: VideoStatus = .idle
    
    // 2. Computed Property for safeFileName
    var safeFileName: String {
        // MacOS/Windows forbidden characters
        let invalidChars: Set<Character> = ["/", ":", "\\", "*", "?", "\"", "<", ">", "|"]
        let cleanedTitle = title.filter { !invalidChars.contains($0) }
        return String(cleanedTitle.prefix(200))
    }
}

// 3. Regex Helper using modern Swift 5.7+ Regex syntax
struct YTDLPParser {
    static func parseProgress(from output: String) -> Double? {
        // Matches e.g., "[download]  45.0% of 50.00MiB"
        let regex = /\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/
        
        if let match = try? regex.firstMatch(in: output) {
            if let percent = Double(match.1) {
                return percent / 100.0 // Map 45.0 to 0.45
            }
        }
        return nil
    }
}

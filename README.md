# Video Downloader by VNTune.com

Một ứng dụng macOS native (chạy local) được xây dựng bằng SwiftUI, kiến trúc MVVM và async/await (Swift 5.7+) để tải video/playlist từ YouTube thông qua việc giao tiếp trực tiếp với binary `yt-dlp`.

## 📦 Kiến trúc & Các thành phần chính (Components)

Dự án được chia thành các tệp tin độc lập giúp dễ dàng bảo trì và mở rộng:

1. **`Models.swift` (Data Models & Regex Parser)**
   - Định nghĩa `VideoItem`: Chứa thông tin hiển thị (ID, URL, Tựa đề, Thời lượng, Views, Likes, v.v.) và trạng thái tải.
   - Hỗ trợ computed property `safeFileName` tự động loại bỏ các ký tự cấm của macOS/Windows để tạo tên file hợp lệ.
   - `YTDLPParser`: Sử dụng cú pháp Regex siêu nhanh của Swift 5.7+ (`/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/`) để bóc tách % hoàn thành từ chuỗi console output của `yt-dlp`.

2. **`YTDLPService.swift` (Core Engine)**
   - Lớp giao tiếp trực tiếp với binary `yt-dlp` bằng `Process` và `Pipe`.
   - `fetchMetadata()`: Gắn tham số `--dump-json` và đọc luồng chuẩn (stdout). Thông tin trả về được decode liền mạch từ JSON Lines thành các object `VideoItem`.
   - `downloadVideo()`: Thực thi lệnh tải. Sử dụng `AsyncStream` để liên tục yield (trả về) tiến trình tải xuống mà không chặn Main Thread. 

3. **`DownloaderViewModel.swift` (ViewModel)**
   - Đóng vai trò cầu nối logic giữa UI và Core Engine. 
   - Quản lý **Pagination** (Phân trang): Mặc định tải 50 video mỗi lần quét hoặc khi bấm "Tải thêm".
   - Computed Property `filteredAndSortedVideos`: Nhận trách nhiệm lọc (lượt view) và sắp xếp (theo ngày, views, bảng chữ cái) trước khi đẩy ra View.
   - Điều hướng tiến trình tải xuống theo luồng bất đồng bộ (`startDownloadSelectedVideos`), cập nhật UI real-time thông qua `@MainActor`.

4. **`MainView.swift` & `VideoDownloaderApp.swift` (UI)**
   - Giao diện SwiftUI mang phong cách chuẩn macOS.
   - Sử dụng `NSOpenPanel` để xin quyền người dùng cấp phép truy cập thư mục lưu trữ (không cần thông qua mã cấp quyền sandbox phức tạp nếu Sandbox đã tắt).
   - Hiển thị danh sách video với `AsyncImage` cho thumbnail, `ProgressView` cho tiến trình tải trực tiếp trên từng cell.

## 🚀 Cách thức hoạt động 

Quá trình luân chuyển dữ liệu diễn ra theo các bước sau:

1. **Quét dữ liệu (Fetch Metadata):**
   - Người dùng nhập URL và bấm "Quét".
   - `ViewModel` gọi `YTDLPService.fetchMetadata`.
   - Service khởi chạy một tiến trình ngầm (`Process`), gọi binary `yt-dlp` kèm các cờ `--playlist-start` và `--playlist-end`.
   - `yt-dlp` trả về siêu dữ liệu video dưới dạng JSON Lines qua `stdout`. Swift đón luồng này, giải mã và trả về danh sách `VideoItem` cho View cập nhật (chỉ hiện 50 video đầu).

2. **Cấu hình tuỳ chọn:**
   - Người dùng có thể lọc các video theo lượt view, sắp xếp cũ/mới, và chọn hàng loạt (Checkbox).
   - Chọn độ phân giải (720p, 1080p, 2K, 4K) qua Picker.
   - Bấm nút chọn thư mục, hệ thống gọi `NSOpenPanel` native của macOS để cấp quyền ghi cho thư mục đích.

3. **Tải xuống bất đồng bộ (Concurrent Download):**
   - Khi bấm tải, `ViewModel` lặp qua các video được chọn và kích hoạt `YTDLPService.downloadVideo` (trả về `AsyncStream<Double>`).
   - Binary `yt-dlp` bắt đầu fetch dữ liệu video và audio, sau đó merge lại bằng FFmpeg (nếu yêu cầu tuỳ chọn chất lượng cao).
   - Standard output của yt-dlp in ra tiến trình (vd: `[download]  45.0% of 50.00MiB`). Regex Parser liên tục "bắt" các con số này và truyền vào `AsyncStream`.
   - Giao diện (ProgressView) tự động React và nhích thanh tiến trình lên.

## 🛠 Hướng dẫn Clone và Chạy mã (Setup & Build)

Để biên dịch và chạy dự án này trên Xcode, bạn cần thực hiện cấu hình sau:

1. **Khởi tạo Xcode Project:**
   - Tạo một dự án macOS App mới trong Xcode 14+ (yêu cầu hỗ trợ tối thiểu Swift 5.7+ / macOS 13.0).
   - Kéo tất cả 5 tệp `.swift` trong thư mục `swift-source` vào cây thư mục của dự án Xcode.

2. **Nhúng Binary `yt-dlp`:**
   - Tải file thực thi `yt-dlp_macos` từ [trang release chính thức của yt-dlp](https://github.com/yt-dlp/yt-dlp/releases).
   - Kéo thả file `yt-dlp_macos` vào dự án Xcode. **Cực kỳ quan trọng**: Đảm bảo tệp này được tick chọn vào mục **"Copy items if needed"** và xuất hiện trong **"Copy Bundle Resources"** ở tab Build Phases.
   - Mở Terminal, trỏ tới thư mục chứa file binary vừa kéo vào source và cấp quyền chạy lệnh: 
     ```bash
     chmod +x yt-dlp_macos
     ```

3. **Tắt App Sandbox:**
   - Mặc định, Xcode bật macOS App Sandbox khiến ứng dụng không thể chạy các binary con (như `yt-dlp`) hoặc truy cập file system tùy ý.
   - Hãy vào Tab **Signing & Capabilities** của Project, xóa (dấu trừ) hạng mục **"App Sandbox"**. Mũi tên xanh sẽ xuất hiện để bạn cấp thẻ "Hardened Runtime".

4. **Biên dịch (Build & Run):**
   - Chọn scheme đích là Mac của bạn (vd: My Mac - ARM64).
   - Nhấn `Cmd + R` để chạy ứng dụng. Trải nghiệm tải với thư mục do bạn chỉ định!

---
*Lưu ý: Ứng dụng phụ thuộc vào yt-dlp, vì thế tốc độ tải hoặc lỗi phát sinh trong thời gian thực chủ yếu do cấu trúc YouTube hoặc luồng mạng. Nếu gặp lỗi tải, cân nhắc việc nhúng thêm binary `ffmpeg` vào dự án.*

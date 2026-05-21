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

## 🛠 Hướng dẫn Khởi tạo, Cấu hình và Build App chi tiết (Step-by-Step)

Dưới đây là hướng dẫn từng bước chi tiết nhất để bạn có thể mang mã nguồn này vào Xcode, biên dịch và chạy thành công trên máy Mac của mình.

### Bước 1: Chuẩn bị môi trường
- Máy Mac đang chạy **macOS 13.0** (Ventura) trở lên (hỗ trợ tốt nhất trên chip Apple Silicon - M1/M2/M3/M4).
- Cài đặt **Xcode 14** trở lên (từ App Store hoặc trang developer của Apple).

### Bước 2: Tạo dự án Xcode mới
1. Mở Xcode, chọn **"Create a new Xcode project"**.
2. Ở tab phía trên cùng, chọn **"macOS"**.
3. Trong phần Application, chọn **"App"** và nhấn **Next**.
4. Điền các thông tin:
   - **Product Name:** `Video Downloader` (hoặc tên tùy ý).
   - **Interface:** `SwiftUI`.
   - **Language:** `Swift`.
   - Bỏ chọn các ô *Use Core Data* và *Include Tests* (nếu có).
5. Nhấn **Next** và chọn thư mục để lưu dự án, sau đó nhấn **Create**.

### Bước 3: Đưa tệp mã nguồn vào dự án
1. Trong cửa sổ Xcode, ở cột bên trái (Project Navigator), hệ thống đã tạo sẵn 2 file là `<TênApp>App.swift` và `ContentView.swift`. Nhấn chuột phải vào 2 file này chọn **Delete** -> **Move to Trash**.
2. Mở thư mục `swift-source` mà bạn vừa tải/clone về.
3. Kéo toàn bộ 6 file `.swift` (`Models.swift`, `YTDLPService.swift`, `DownloaderViewModel.swift`, `MainView.swift`, `DependencyManager.swift`, `VideoDownloaderApp.swift`) vào cột bên trái.
4. Một bảng thông báo hiện ra, tích chọn **"Copy items if needed"** và nhấn **Finish**.

### Bước 4: Chức năng tự động tải Dependency (Không cần thao tác tay)
- Trong phiên bản này, ứng dụng được tích hợp sẵn `DependencyManager`. 
- Lần đầu khởi chạy, mã nguồn trong `DependencyManager.swift` sẽ tự động tải phiên bản **yt-dlp** và **FFmpeg** mới nhất, giải nén và cấp quyền thực thi `chmod +x` hoàn toàn tự động trực tiếp vào thư mục `Application Support` của người dùng.

### Bước 5: Tắt App Sandbox (Cực kỳ quan trọng)
Mặc định macOS giới hạn quyền của ứng dụng (Sandbox) khiến nó không thể tải file thực thi bên thứ 3 hoặc không thể ghi file ra ngoài thư mục giới hạn.
1. Nhấn vào tên Project ở cột trái.
2. Chọn mục **TARGETS**.
3. Chọn tab **Signing & Capabilities**.
4. Tìm đến khối có tên **"App Sandbox"**. 
5. Bấm vào biểu tượng **thùng rác** (hoặc dấu `X` ở góc) để XÓA HOÀN TOÀN khối chức năng này.
6. (Tùy chọn) Bạn có thể thêm **Hardened Runtime** để thay thế nếu muốn bảo mật tốt hơn, nhưng xóa App Sandbox là thao tác bắt buộc để code hiện tại chạy trượt tru cục bộ.

### Bước 6: Build & Run (Chạy ứng dụng)
1. Ở thanh công cụ trên cùng của Xcode, đảm bảo thiết bị đích (Scheme) đang chọn là **My Mac**.
2. Nhấn nút **Play** (hình tam giác) hoặc dùng phím tắt `Cmd + R` để biên dịch.
3. Chờ vài giây ("Build Succeeded"). Cửa sổ ứng dụng sẽ tự động bật lên.
4. Chờ ứng dụng chạy thanh tiến trình tải yt-dlp và FFmpeg trong lần đầu tiên.
5. **Test thử:** 
   - Bỏ link YouTube vào, nhấn "Quét".
   - Chọn thư mục lưu, tích chọn video và nhấn Bắt đầu tải!

---
*Lưu ý: yt-dlp sẽ tự động tìm FFmpeg trong cùng thư mục cài đặt ngầm để ghép âm thanh và hình ảnh đối với các định dạng video chất lượng cao (1080p, 4K).*

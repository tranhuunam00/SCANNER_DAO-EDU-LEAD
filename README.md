# DAO EDU Lead Scanner MVP

Chrome Extension Manifest V3 để thử nghiệm đọc bài viết và bình luận đang hiển
thị trên Facebook, sau đó lưu tạm vào `chrome.storage.local`.

## Cài thử

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked**.
4. Chọn thư mục `SCANNER_DAO-EDU-LEAD`.
5. Mở riêng một bài viết Facebook cần thử.
6. Mở extension và chọn **Quét sâu toàn bộ bình luận**.

Chế độ **Quét sâu toàn bộ bình luận** không giới hạn số vòng. Mỗi vòng bấm các
nút mở comment/reply, cuộn vùng bình luận xuống cuối và chờ DOM Facebook ổn
định. Quá trình chỉ dừng sau nhiều lượt liên tiếp xác nhận không còn nút mở,
không có bình luận mới và vùng bình luận đã ở cuối.

## Quét hàng loạt

1. Mở trang chính của nhóm và cuộn để Facebook tải danh sách bài.
2. Bấm **Quét 10 bài trong nhóm**.
3. Extension khóa đúng 10 permalink theo thứ tự đang hiển thị, sau đó mở từng
   bài trong tab nền, mở bình luận, lưu dữ liệu rồi đóng tab.
4. URL bài đã xử lý được lưu local và gắn nhãn `DAO EDU: Đã quét`.
5. Sau 10 bài, mở lại popup và bấm **Quét tiếp 10 bài** nếu muốn tiếp tục.

Extension chỉ lấy các permalink đã được Facebook tải trong DOM của trang nhóm.
Muốn có thêm bài trong hàng chờ, cuộn trang nhóm xuống thêm rồi bắt đầu lượt mới.

## Dữ liệu

Extension lưu:

- Loại `POST` hoặc `COMMENT`.
- Tên và URL tác giả nếu tìm thấy.
- Nội dung chữ.
- URL bài/comment nếu tìm thấy.
- URL nhóm và thời điểm quét.
- Fingerprint chống trùng.

Không lưu cookie, mật khẩu hoặc token Facebook.

## Xuất JSON

- **Xuất JSON thô**: chỉ xuất một mảng bài viết. Mỗi bài có `comments`, mỗi
  bình luận có `replies` lồng nhau theo đúng cấp phản hồi.
- **Xuất JSON có thuật toán**: xuất dữ liệu phẳng kèm kết quả chấm điểm và
  phân loại lead của thuật toán local. Thuật toán chấm theo cấp cây
  `POST`/`COMMENT`/`REPLY`/`DEEP_REPLY`; ý định phải nằm trong chính câu của
  người đó, còn ngữ cảnh cha chỉ dùng để xác định chủ đề giáo dục.

Nếu nội dung bài chỉ nằm trong ảnh và Facebook không cung cấp caption dạng chữ,
post vẫn được xuất đúng URL/ID với `missingPostContent: true` và `text` rỗng.

## Quét bài viết

- Dán link bài Facebook rồi bấm **Quét sâu bài viết** để tab hiện tại tự mở
  bài và quét sâu toàn bộ bình luận.
- Để trống link để quét sâu bài hoặc dialog Facebook đang mở.
- **Quét 10 bài trong nhóm** lấy permalink theo đúng thứ tự feed và đóng băng
  hàng đợi trước khi quét. Mỗi bài được mở trong tab nền riêng, chạy cùng pipeline
  quét sâu, lưu và đánh dấu rồi đóng tab. Một lượt chỉ xử lý tối đa đúng 10 URL;
  bài lỗi không làm batch lấy bù bài thứ 11.

## Đóng Gói Production

1. Sửa `.env` để trỏ tới server thật:

   ```env
   DAO_EDU_SCANNER_API_BASE_URL=https://your-domain.com/api
   DAO_EDU_SCANNER_TOKEN=
   DAO_EDU_SCANNER_SYNC_ENDPOINT=/facebook-lead-scans
   ```

2. Tạo gói zip:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
   ```

3. File zip nằm trong `dist/dao-edu-lead-scanner-<version>.zip`. Giải nén file này
   rồi dùng **Load unpacked** trỏ vào thư mục đã giải nén, hoặc vào
   `chrome://extensions` và dùng **Pack extension** để tạo `.crx` nội bộ.

Script sẽ sinh `scanner-config.js` trong gói build từ `.env`; file `.env`,
`scanner-config.js`, `dist/` không được commit.

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

Chế độ **Quét sâu toàn bộ bình luận** chạy tối đa 10 vòng. Mỗi vòng bấm tối đa
30 nút mở comment/reply, cuộn vùng bình luận xuống cuối và chờ Facebook tải
thêm. Quá trình dừng sớm sau hai vòng liên tiếp không còn dữ liệu mới.

## Quét hàng loạt

1. Mở trang chính của nhóm và cuộn để Facebook tải danh sách bài.
2. Bấm **Quét 10 bài trong nhóm**.
3. Extension mở từng bài trong tab nền, mở bình luận, lưu dữ liệu rồi đóng tab.
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
  phân loại lead của thuật toán local.

Nếu nội dung bài chỉ nằm trong ảnh và Facebook không cung cấp caption dạng chữ,
post vẫn được xuất đúng URL/ID với `missingPostContent: true` và `text` rỗng.

// Agreement shown before any camera/location use on luong.banhmique.vn.
// Changing the substance of this text requires a new version in
// payroll_bn_attendance_consent_config.current_version (and the shared
// PAYROLL_ATTENDANCE_CONSENT_VERSION constant) so every employee accepts again.

export const CONSENT_CONTROLLER = "BMQ – Bánh Mì Que Pháp";

export interface ConsentSection {
  title: string;
  items: string[];
}

export const CONSENT_TITLE = "Thoả thuận sử dụng hình ảnh và vị trí khi chấm công";

export const CONSENT_SECTIONS: ConsentSection[] = [
  {
    title: "1. Dữ liệu được thu thập",
    items: [
      "Chỉ khi bạn bấm Chấm vào hoặc Chấm ra: một ảnh khuôn mặt chụp trực tiếp lúc chấm, vị trí GPS và độ chính xác của vị trí, thời gian chấm.",
      "Mã thiết bị đã được mã hoá và loại trình duyệt, để chống chấm công hộ.",
      "Ảnh khuôn mặt là dữ liệu cá nhân nhạy cảm theo Luật Bảo vệ dữ liệu cá nhân 2025.",
    ],
  },
  {
    title: "2. Mục đích duy nhất",
    items: [
      "Xác nhận bạn có mặt tại nơi làm việc để ghi giờ vào, giờ ra.",
      "Tính ngày công và tiền lương của bạn.",
      "Xử lý khiếu nại, đối soát khi có sai sót chấm công.",
    ],
  },
  {
    title: "3. Cam kết của công ty",
    items: [
      "Không dùng ảnh của bạn vào bất kỳ mục đích nào khác: quảng cáo, truyền thông, đăng mạng xã hội, đánh giá ngoại hình, huấn luyện AI hay nhận diện khuôn mặt tự động.",
      "Không bán, không chia sẻ cho bên thứ ba, trừ khi cơ quan nhà nước có thẩm quyền yêu cầu theo pháp luật.",
      "Chỉ quản lý phụ trách chấm công, tiền lương mới xem được ảnh. Ảnh lưu trong kho riêng tư, không có đường dẫn công khai.",
      "Chỉ lấy vị trí đúng lúc bạn bấm chấm công. Không theo dõi vị trí liên tục, không lấy vị trí khi bạn không chấm công.",
    ],
  },
  {
    title: "4. Thời hạn lưu",
    items: [
      "Ảnh khuôn mặt tự động xoá sau 90 ngày kể từ ngày chụp.",
      "Giờ chấm công và kết quả chấm được lưu cùng hồ sơ tiền lương theo thời hạn pháp luật quy định.",
    ],
  },
  {
    title: "5. Quyền của bạn",
    items: [
      "Xem lại thoả thuận này bất cứ lúc nào ngay trên trang lương.",
      "Yêu cầu quản lý xem, sửa thông tin chấm công sai của bạn.",
      "Rút lại đồng ý bất cứ lúc nào. Khi rút lại, quản lý sẽ hướng dẫn bạn chấm công theo cách khác và tiền lương của bạn không bị ảnh hưởng.",
      "Khiếu nại với công ty hoặc cơ quan có thẩm quyền nếu dữ liệu của bạn bị sử dụng sai mục đích.",
    ],
  },
];

export const CONSENT_CHECKBOX =
  "Tôi đã đọc, hiểu và tự nguyện đồng ý cho công ty sử dụng ảnh khuôn mặt và vị trí của tôi đúng các mục đích và cam kết nêu trên.";

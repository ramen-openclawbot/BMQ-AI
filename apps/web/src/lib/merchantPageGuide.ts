// What the owner chat knows about the page he is on (owner 22/10). Each guide names the
// page and says what it is for, so VNAgent reads "[Trang: …]" with meaning instead of a bare
// path, and offers starter questions for that page.
//
// Suggestions only ask what the merchant agent can actually read today: revenue lines,
// dealer orders/prices, SKUs, POs, phiếu nhập, PRs, suppliers, supplier payments/debt,
// cost classification and the low-stock count. Pages whose data it cannot read (payroll,
// QA, kiểm kê detail) get a description but no suggestions, so the chat falls back to the
// general starters.

export type MerchantPageGuide = {
  prefix: string;
  label: string;
  purpose: string;
  suggestions?: string[];
};

// The server rejects a longer page field (services/merchant-agent server.py, max_length=300).
export const MERCHANT_PAGE_CONTEXT_MAX = 300;

const KHO_SUGGESTIONS = [
  "Có bao nhiêu mặt hàng đang tồn thấp?",
  "Hôm nay nhập kho những phiếu nào?",
  "Phiếu nhập nào lệch số lượng với PO?",
];

const GUIDES: MerchantPageGuide[] = [
  { prefix: "/", label: "Tổng quan", purpose: "tổng quan điều hành: doanh thu, đơn đại lý, chi phí, việc chờ duyệt" },
  {
    prefix: "/payment-requests",
    label: "Duyệt chi",
    purpose: "phiếu đề nghị chi (PR) cho nhà cung cấp: chờ duyệt, đã duyệt, đã chi bằng UNC hoặc tiền mặt",
    suggestions: [
      "Phiếu chi nào đang chờ duyệt?",
      "Phiếu nào đã duyệt nhưng chưa trả đủ?",
      "Tuần này đã chi bao nhiêu?",
      "Phiếu nào cần phiếu nhập mà chưa có?",
    ],
  },
  { prefix: "/salary-payouts", label: "Đợt chi lương", purpose: "một đợt chi lương nhân viên" },
  {
    prefix: "/finance-control/payables",
    label: "Công nợ phải trả",
    purpose: "công nợ BMQ đang nợ nhà cung cấp",
    suggestions: ["Đang nợ nhà cung cấp bao nhiêu?", "Nợ theo từng nhà cung cấp", "Tháng này đã trả nhà cung cấp bao nhiêu?"],
  },
  {
    prefix: "/finance-control/classification",
    label: "Phân loại chi phí",
    purpose: "xếp các khoản chi vào nhóm chi phí và duyệt phân loại",
    suggestions: ["Khoản chi nào chưa phân loại?", "Chi phí tháng này theo nhóm", "So chi phí tháng này với tháng trước"],
  },
  {
    prefix: "/finance",
    label: "Finance",
    purpose: "báo cáo tài chính: lãi lỗ (P&L), chênh lệch, công nợ, trích trước, khóa sổ",
    suggestions: ["Chi phí tháng này theo nhóm", "So chi phí tháng này với tháng trước", "Snapshot doanh thu"],
  },
  {
    prefix: "/finance-control/revenue",
    label: "Quản lý doanh thu",
    purpose: "doanh thu theo kênh: đại lý, B2B/siêu thị, xe bán lẻ, bánh ngọt",
    suggestions: [
      "Snapshot doanh thu",
      "Doanh thu tháng này theo kênh",
      "Kênh nào giảm so với tháng trước?",
      "Doanh thu 7 ngày qua theo ngày",
    ],
  },
  {
    prefix: "/finance-control/revenue/points",
    label: "Doanh thu điểm bán",
    purpose: "doanh thu từng điểm bán/kiosk từ báo cáo hằng ngày",
    suggestions: ["Điểm bán nào chưa nộp báo cáo?", "Top điểm bán tháng này", "Doanh thu xe bán lẻ 7 ngày qua"],
  },
  { prefix: "/finance-control/revenue/debt", label: "Công nợ phải thu", purpose: "khách hàng và đại lý còn nợ BMQ" },
  {
    prefix: "/mini-crm",
    label: "CRM",
    purpose: "khách hàng và đại lý của BMQ",
    suggestions: ["Đại lý nào lâu chưa đặt hàng?", "Top đại lý theo doanh số tháng này", "Hôm nay đơn đại lý có vấn đề gì?"],
  },
  {
    prefix: "/sales-po-inbox",
    label: "PO bán hàng",
    purpose: "PO khách B2B/siêu thị (như Kingfoodmart) gửi tới để BMQ giao hàng",
    suggestions: ["Doanh thu Kingfoodmart tháng này", "Doanh thu B2B 7 ngày qua", "Doanh thu tháng này theo kênh"],
  },
  {
    prefix: "/purchase-orders",
    label: "PO mua hàng",
    purpose: "đơn mua hàng (PO) BMQ gửi nhà cung cấp",
    suggestions: [
      "PO nào đang chờ giao?",
      "Tiền mua tháng này theo nhà cung cấp",
      "PO nào giao thiếu so với đặt?",
      "PO nào chưa có phiếu chi?",
    ],
  },
  {
    prefix: "/goods-receipts",
    label: "Phiếu nhập kho",
    purpose: "phiếu nhận hàng từ nhà cung cấp, đối chiếu với PO",
    suggestions: ["Hôm nay nhập kho những phiếu nào?", "Phiếu nhập nào chưa hoàn tất?", "Phiếu nhập nào lệch số lượng với PO?"],
  },
  { prefix: "/warehouse", label: "Kho", purpose: "kho NVL: Kho Tân Tạo là kho chính, Kho Q7 là kho bánh ngọt", suggestions: KHO_SUGGESTIONS },
  {
    prefix: "/warehouse/danh-muc",
    label: "Danh mục kho",
    purpose: "danh mục NVL, bao bì, thành phẩm của Kho Tân Tạo (kho chính) và Kho Q7 (kho bánh ngọt), đơn vị và quy đổi",
    suggestions: KHO_SUGGESTIONS,
  },
  { prefix: "/warehouse/kiem-ke", label: "Kiểm kê", purpose: "phiếu kiểm kê tồn thực tế", suggestions: KHO_SUGGESTIONS },
  { prefix: "/warehouse/phieu", label: "Phiếu kho", purpose: "phiếu nhập, xuất, chuyển kho", suggestions: KHO_SUGGESTIONS },
  { prefix: "/warehouse/stock-ledger", label: "Sổ tồn NVL", purpose: "sổ nhập, xuất, tồn NVL theo ngày", suggestions: KHO_SUGGESTIONS },
  {
    prefix: "/warehouse/purchase-usage",
    label: "Mua so với dùng",
    purpose: "so lượng NVL mua với lượng dùng theo định mức, cờ bất thường",
    suggestions: ["NVL nào mua nhiều nhất tháng này?", "NVL nào tăng giá mua tháng này?", "Có bao nhiêu mặt hàng đang tồn thấp?"],
  },
  {
    prefix: "/warehouse/gia-von",
    label: "Giá vốn → Kho",
    purpose: "trừ nguyên liệu theo công thức giá vốn từ đơn đã ghi nhận doanh thu: độ phủ, chỗ chưa nối, so với phiếu xuất",
    suggestions: KHO_SUGGESTIONS,
  },
  { prefix: "/warehouse/tan-tao", label: "Kho Tân Tạo", purpose: "kho chính của BMQ: tồn, nhập, xuất NVL", suggestions: KHO_SUGGESTIONS },
  { prefix: "/production", label: "Sản xuất", purpose: "kế hoạch sản xuất, sản phẩm, QA" },
  {
    prefix: "/production/planning/q7",
    label: "Xưởng Q7",
    purpose: "kế hoạch sản xuất bánh ngọt ở Q7 (kho bánh ngọt), chủ yếu cho Kingfoodmart",
    suggestions: ["Doanh thu bánh ngọt 7 ngày qua", "Doanh thu Kingfoodmart tháng này", "Bánh ngọt nào bán nhiều nhất tháng này?"],
  },
  {
    prefix: "/production/products",
    label: "Quản lý sản phẩm",
    purpose: "danh mục SKU: tên, giá bán, ảnh, ẩn/hiện trên trang đại lý",
    suggestions: ["SKU nào thiếu giá hoặc thiếu ảnh?", "SKU nào đang ẩn với đại lý?", "Sản phẩm bán chạy nhất tháng này"],
  },
  { prefix: "/production/qa", label: "QA & Nhập kho TP", purpose: "kiểm tra chất lượng lô sản xuất và nhập kho thành phẩm" },
  {
    prefix: "/sku-costs",
    label: "Giá vốn",
    purpose: "giá vốn từng SKU tính từ NVL và định mức",
    suggestions: ["SKU nào thiếu giá bán?", "NVL nào tăng giá mua tháng này?", "Chi phí tháng này theo nhóm"],
  },
  {
    prefix: "/material-master",
    label: "NVL chuẩn",
    purpose: "mã NVL chuẩn dùng chung cho kho, mua hàng và giá vốn",
    suggestions: ["NVL nào tăng giá mua tháng này?", "NVL nào mua nhiều nhất tháng này?"],
  },
  {
    prefix: "/suppliers",
    label: "Nhà cung cấp",
    purpose: "danh sách nhà cung cấp và điều khoản thanh toán",
    suggestions: ["Top nhà cung cấp theo tiền mua tháng này", "Đang nợ nhà cung cấp bao nhiêu?", "Tháng này đã trả nhà cung cấp bao nhiêu?"],
  },
  {
    prefix: "/invoices",
    label: "Hoá đơn",
    purpose: "hóa đơn đầu vào của nhà cung cấp",
    suggestions: ["Phiếu chi nào chưa có hóa đơn?", "Đang nợ nhà cung cấp bao nhiêu?"],
  },
  { prefix: "/payroll", label: "Bảng lương", purpose: "bảng lương và đợt chi lương nhân viên" },
];

const matches = (pathname: string, prefix: string) =>
  prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The most specific guide for a path, e.g. /warehouse/kiem-ke beats /warehouse. */
export function merchantPageGuide(pathname: string): MerchantPageGuide | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: MerchantPageGuide | null = null;
  for (const guide of GUIDES) {
    if (matches(path, guide.prefix) && (!best || guide.prefix.length > best.prefix.length)) best = guide;
  }
  return best;
}

/** The page field sent with each chat turn: the path plus what the page is for. */
export function merchantPageContext(pathname: string): string {
  const guide = merchantPageGuide(pathname);
  const text = guide ? `${pathname} · ${guide.label}: ${guide.purpose}` : pathname;
  return text.length > MERCHANT_PAGE_CONTEXT_MAX ? `${text.slice(0, MERCHANT_PAGE_CONTEXT_MAX - 1)}…` : text;
}

export const MERCHANT_PAGE_GUIDES: readonly MerchantPageGuide[] = GUIDES;

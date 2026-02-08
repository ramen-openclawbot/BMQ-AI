import { createContext, useContext, useState, useEffect, ReactNode } from "react";

type Language = "en" | "vi";

interface Translations {
  // Navigation
  dashboard: string;
  inventory: string;
  skus: string;
  skuCosts: string;
  skuCostDashboard: string;
  skuCostManagement: string;
  skuCostAnalysis: string;
  skuCostProducts: string;
  skuCostIngredients: string;
  skuCostEmployees: string;
  skuCostOverhead: string;
  suppliers: string;
  invoices: string;
  paymentRequests: string;
  goodsReceipts: string;
  purchaseOrders: string;
  lowStock: string;
  reports: string;
  team: string;
  settings: string;
  
  // Header
  searchPlaceholder: string;
  manager: string;
  signOut: string;
  
  // Settings page
  settingsTitle: string;
  settingsDescription: string;
  profile: string;
  email: string;
  displayName: string;
  enterYourName: string;
  saveProfile: string;
  saving: string;
  notifications: string;
  lowStockAlerts: string;
  lowStockAlertsDesc: string;
  paymentRequestUpdates: string;
  paymentRequestUpdatesDesc: string;
  appearance: string;
  darkMode: string;
  darkModeDesc: string;
  security: string;
  changePassword: string;
  language: string;
  languageDesc: string;
  troubleshooting: string;
  clearCache: string;
  clearCacheDesc: string;
  clearingCache: string;
  
  // Payment Requests page
  paymentRequestsTitle: string;
  paymentRequestsDesc: string;
  pendingApproval: string;
  approved: string;
  delivered: string;
  needsPayment: string;
  totalNeedToPay: string;
  totalUNC: string;
  totalCash: string;
  needsInvoice: string;
  status: string;
  all: string;
  pending: string;
  rejected: string;
  delivery: string;
  notDelivered: string;
  code: string;
  title: string;
  supplier: string;
  createdDate: string;
  totalAmount: string;
  payment: string;
  paymentMethod: string;
  bankTransfer: string;
  cash: string;
  actions: string;
  paid: string;
  unpaid: string;
  noPaymentRequests: string;
  createNewRequest: string;
  selectPaymentMethod: string;
  selectPaymentMethodDesc: string;
  confirmApprove: string;
  invoiceStatus: string;
  invoiceCreated: string;
  invoiceNotCreated: string;
  createInvoice: string;
  createInvoiceFromRequest: string;
  invoiceWarning: string;
  invoiceWarningDesc: string;
  stillMarkPaid: string;
  createInvoiceFirst: string;
  needsInvoiceWarning: string;
  needsInvoiceWarningDesc: string;
  
  // Bulk actions
  selected: string;
  total: string;
  markAsPaid: string;
  clearSelection: string;
  quickApprove: string;
  confirmBulkApprove: string;
  confirmBulkApproveDesc: string;
  approving: string;
  confirmApproveAction: string;
  
  // Edit functionality
  editPaymentRequest: string;
  editPaymentRequestDesc: string;
  
  // Inventory page
  inventoryTitle: string;
  inventoryDescription: string;
  filter: string;
  export: string;
  addItem: string;
  
  // Common
  loading: string;
  error: string;
  success: string;
  cancel: string;
  save: string;
  delete: string;
  edit: string;
  view: string;
  add: string;
  search: string;
  noData: string;
  
  // Toasts
  profileUpdated: string;
  profileUpdateFailed: string;
  
  // App title
  appTitle: string;
}

const translations: Record<Language, Translations> = {
  en: {
    // Navigation
    dashboard: "Dashboard",
    inventory: "Inventory",
    skus: "SKU Management",
    skuCosts: "SKU Management",
    skuCostDashboard: "Dashboard",
    skuCostManagement: "Management",
    skuCostAnalysis: "Analysis",
    skuCostProducts: "Products",
    skuCostIngredients: "Ingredients",
    skuCostEmployees: "Employees",
    skuCostOverhead: "Overhead",
    suppliers: "Suppliers",
    invoices: "Invoices",
    paymentRequests: "Payment Requests",
    goodsReceipts: "Goods Receipts",
    purchaseOrders: "Purchase Orders",
    lowStock: "Low Stock",
    reports: "Reports",
    team: "Team",
    settings: "Settings",
    
    // Header
    searchPlaceholder: "Search inventory, suppliers...",
    manager: "Manager",
    signOut: "Sign Out",
    
    // Settings page
    settingsTitle: "Settings",
    settingsDescription: "Manage your account preferences",
    profile: "Profile",
    email: "Email",
    displayName: "Display Name",
    enterYourName: "Enter your name",
    saveProfile: "Save Profile",
    saving: "Saving...",
    notifications: "Notifications",
    lowStockAlerts: "Low Stock Alerts",
    lowStockAlertsDesc: "Get notified when items are running low",
    paymentRequestUpdates: "Payment Request Updates",
    paymentRequestUpdatesDesc: "Receive updates on payment request status changes",
    appearance: "Appearance",
    darkMode: "Dark Mode",
    darkModeDesc: "Use dark theme for the interface",
    security: "Security",
    changePassword: "Change Password",
    language: "Language",
    languageDesc: "Choose your preferred language",
    troubleshooting: "Troubleshooting",
    clearCache: "Clear Cache",
    clearCacheDesc: "If you're experiencing display issues or seeing outdated content, clear the cache and reload.",
    clearingCache: "Clearing cache...",
    
    // Payment Requests page
    paymentRequestsTitle: "Payment Requests",
    paymentRequestsDesc: "Manage payment approval requests and payments",
    pendingApproval: "Pending Approval",
    approved: "Approved",
    delivered: "Delivered",
    needsPayment: "Needs Payment",
    totalNeedToPay: "Total Unpaid",
    totalUNC: "UNC",
    totalCash: "Cash",
    needsInvoice: "Needs Invoice",
    status: "Status",
    all: "All",
    pending: "Pending",
    rejected: "Rejected",
    delivery: "Delivery",
    notDelivered: "Not Delivered",
    code: "Code",
    title: "Title",
    supplier: "Supplier",
    createdDate: "Created Date",
    totalAmount: "Total Amount",
    payment: "Payment",
    paymentMethod: "Payment Method",
    bankTransfer: "UNC",
    cash: "Cash",
    actions: "Actions",
    paid: "Paid",
    unpaid: "Unpaid",
    noPaymentRequests: "No payment requests found",
    createNewRequest: "Create a new payment request to get started",
    selectPaymentMethod: "Select payment method",
    selectPaymentMethodDesc: "Choose how this payment will be processed",
    confirmApprove: "Confirm Approve",
    invoiceStatus: "Invoice Status",
    invoiceCreated: "Invoice Created",
    invoiceNotCreated: "No Invoice",
    createInvoice: "Create Invoice",
    createInvoiceFromRequest: "Create Invoice from Request",
    invoiceWarning: "Invoice Not Created",
    invoiceWarningDesc: "This order has been paid but no invoice has been created. Please create an invoice to complete the process.",
    stillMarkPaid: "Still Mark as Paid",
    createInvoiceFirst: "Create Invoice First",
    needsInvoiceWarning: "Orders Need Invoices",
    needsInvoiceWarningDesc: "There are orders that have been paid but don't have invoices yet. Please create invoices to complete the process.",
    
    // Bulk actions
    selected: "Selected",
    total: "Total",
    markAsPaid: "Mark as Paid",
    clearSelection: "Clear Selection",
    quickApprove: "Quick Approve",
    confirmBulkApprove: "Confirm Bulk Approval",
    confirmBulkApproveDesc: "You are about to approve {count} payment requests totaling {amount}. Payment methods will remain as originally set.",
    approving: "Approving...",
    confirmApproveAction: "Confirm Approve",
    
    // Edit functionality
    editPaymentRequest: "Edit Payment Request",
    editPaymentRequestDesc: "Edit payment request details",
    
    // Inventory page
    inventoryTitle: "Inventory",
    inventoryDescription: "Manage your bakery ingredients and supplies",
    filter: "Filter",
    export: "Export",
    addItem: "Add Item",
    
    // Common
    loading: "Loading...",
    error: "Error",
    success: "Success",
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    edit: "Edit",
    view: "View",
    add: "Add",
    search: "Search",
    noData: "No data",
    
    // Toasts
    profileUpdated: "Profile updated successfully",
    profileUpdateFailed: "Failed to update profile",
    
    // App title
    appTitle: "Procurement AI Agent",
  },
  vi: {
    // Navigation
    dashboard: "Tổng quan",
    inventory: "Kho hàng",
    skus: "Quản lý SKU",
    skuCosts: "Quản lý SKU",
    skuCostDashboard: "Dashboard",
    skuCostManagement: "Quản trị",
    skuCostAnalysis: "Phân tích",
    skuCostProducts: "Sản phẩm",
    skuCostIngredients: "Nguyên liệu",
    skuCostEmployees: "Nhân sự",
    skuCostOverhead: "Chi phí chung",
    suppliers: "Nhà cung cấp",
    invoices: "Hoá đơn",
    paymentRequests: "Duyệt chi",
    goodsReceipts: "Phiếu nhập kho",
    purchaseOrders: "Đơn đặt hàng",
    lowStock: "Sắp hết hàng",
    reports: "Báo cáo",
    team: "Đội ngũ",
    settings: "Cài đặt",
    
    // Header
    searchPlaceholder: "Tìm kiếm kho hàng, nhà cung cấp...",
    manager: "Quản lý",
    signOut: "Đăng xuất",
    
    // Settings page
    settingsTitle: "Cài đặt",
    settingsDescription: "Quản lý tùy chọn tài khoản của bạn",
    profile: "Hồ sơ",
    email: "Email",
    displayName: "Tên hiển thị",
    enterYourName: "Nhập tên của bạn",
    saveProfile: "Lưu hồ sơ",
    saving: "Đang lưu...",
    notifications: "Thông báo",
    lowStockAlerts: "Cảnh báo sắp hết hàng",
    lowStockAlertsDesc: "Nhận thông báo khi sản phẩm sắp hết",
    paymentRequestUpdates: "Cập nhật duyệt chi",
    paymentRequestUpdatesDesc: "Nhận thông báo khi trạng thái duyệt chi thay đổi",
    appearance: "Giao diện",
    darkMode: "Chế độ tối",
    darkModeDesc: "Sử dụng giao diện tối cho ứng dụng",
    security: "Bảo mật",
    changePassword: "Đổi mật khẩu",
    language: "Ngôn ngữ",
    languageDesc: "Chọn ngôn ngữ ưa thích của bạn",
    troubleshooting: "Khắc phục sự cố",
    clearCache: "Xóa bộ nhớ đệm",
    clearCacheDesc: "Nếu bạn gặp sự cố hiển thị hoặc thấy nội dung cũ, hãy xóa bộ nhớ đệm và tải lại.",
    clearingCache: "Đang xóa bộ nhớ đệm...",
    
    // Payment Requests page
    paymentRequestsTitle: "Duyệt chi",
    paymentRequestsDesc: "Quản lý đề nghị duyệt chi và thanh toán",
    pendingApproval: "Chờ duyệt",
    approved: "Đã duyệt",
    delivered: "Đã giao",
    needsPayment: "Cần thanh toán",
    totalNeedToPay: "Tổng cần chi",
    totalUNC: "UNC",
    totalCash: "Tiền mặt",
    needsInvoice: "Cần tạo hóa đơn",
    status: "Trạng thái",
    all: "Tất cả",
    pending: "Chờ duyệt",
    rejected: "Từ chối",
    delivery: "Giao hàng",
    notDelivered: "Chưa giao",
    code: "Mã",
    title: "Tiêu đề",
    supplier: "Nhà cung cấp",
    createdDate: "Ngày tạo",
    totalAmount: "Tổng tiền",
    payment: "Thanh toán",
    paymentMethod: "Phương thức TT",
    bankTransfer: "UNC",
    cash: "Tiền mặt",
    actions: "Thao tác",
    paid: "Đã thanh toán",
    unpaid: "Chưa thanh toán",
    noPaymentRequests: "Không có đề nghị duyệt chi nào",
    createNewRequest: "Tạo đề nghị duyệt chi mới để bắt đầu",
    selectPaymentMethod: "Chọn phương thức thanh toán",
    selectPaymentMethodDesc: "Chọn cách thức thanh toán cho đề nghị này",
    confirmApprove: "Xác nhận duyệt",
    invoiceStatus: "Trạng thái hóa đơn",
    invoiceCreated: "Đã tạo hóa đơn",
    invoiceNotCreated: "Chưa có hóa đơn",
    createInvoice: "Tạo hóa đơn",
    createInvoiceFromRequest: "Tạo hóa đơn nhập kho",
    invoiceWarning: "Chưa tạo hóa đơn",
    invoiceWarningDesc: "Đơn hàng này đã được thanh toán nhưng chưa được tạo hóa đơn nhập kho. Vui lòng tạo hóa đơn để hoàn tất quy trình.",
    stillMarkPaid: "Vẫn đánh dấu đã TT",
    createInvoiceFirst: "Tạo hóa đơn trước",
    needsInvoiceWarning: "Cần tạo hóa đơn",
    needsInvoiceWarningDesc: "Có đơn hàng đã thanh toán nhưng chưa được tạo hóa đơn nhập kho. Vui lòng tạo hóa đơn để hoàn tất quy trình.",
    
    // Bulk actions
    selected: "Đã chọn",
    total: "Tổng",
    markAsPaid: "Đánh dấu đã TT",
    clearSelection: "Bỏ chọn",
    quickApprove: "Duyệt chi nhanh",
    confirmBulkApprove: "Xác nhận duyệt chi hàng loạt",
    confirmBulkApproveDesc: "Bạn sắp duyệt {count} đề nghị chi với tổng số tiền {amount}. Phương thức thanh toán sẽ giữ nguyên như đã chọn khi tạo.",
    approving: "Đang duyệt...",
    confirmApproveAction: "Xác nhận duyệt",
    
    // Edit functionality
    editPaymentRequest: "Chỉnh sửa đề nghị chi",
    editPaymentRequestDesc: "Chỉnh sửa thông tin đề nghị chi",
    
    // Inventory page
    inventoryTitle: "Kho hàng",
    inventoryDescription: "Quản lý nguyên liệu và vật tư bánh",
    filter: "Lọc",
    export: "Xuất",
    addItem: "Thêm",
    
    // Common
    loading: "Đang tải...",
    error: "Lỗi",
    success: "Thành công",
    cancel: "Hủy",
    save: "Lưu",
    delete: "Xóa",
    edit: "Sửa",
    view: "Xem",
    add: "Thêm",
    search: "Tìm kiếm",
    noData: "Không có dữ liệu",
    
    // Toasts
    profileUpdated: "Cập nhật hồ sơ thành công",
    profileUpdateFailed: "Không thể cập nhật hồ sơ",
    
    // App title
    appTitle: "Procurement AI Agent",
  },
};

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem("app-language");
    return (saved as Language) || "vi";
  });

  useEffect(() => {
    localStorage.setItem("app-language", language);
  }, [language]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
  };

  const t = translations[language];

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}

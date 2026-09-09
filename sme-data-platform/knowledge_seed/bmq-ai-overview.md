# BMQ AI — current application and assistant scope

Source: BMQ-AI application routes and the existing `bmq-analytics` pilot documentation, reviewed 2026-09-09. This note explains software behavior, not accounting policy or live financial amounts.

## English

BMQ AI is the Bánh Mì Que business operations application at ai.banhmique.vn. Its workflows include purchase orders, warehouse inventory, finance/control reporting and supplier payables. VNAgent is the conversational entry point; it is not the database and does not determine accounting policy.

The existing owner analytics pilot covers controlled revenue, purchase-order count, current low-stock items and current supplier debt. It uses bounded read-only tools. It does not automatically know all company procedures, read the entire application schema, or change business records. App language controls new assistant replies; existing message text is not translated retroactively.

The local data-platform integration adds a separate source registry for canonical file imports and business documents. Uploaded CSV/JSON facts are validated and queried through semantic metrics. Uploaded Markdown/text explains procedures and is retrieved with citations. Missing or conflicting evidence should be stated explicitly. Imported revenue is not automatically the same as the controlled-revenue ledger.

To expand the assistant's knowledge, an owner provides reviewed business documents with clear titles and sources, or canonical exports with source IDs and timestamps. No data is automatically used to train a model. The model for this BMQ integration is GPT-5.6 Luna; the shared VNAgent Chat model is independent.

## Tiếng Việt

BMQ AI là ứng dụng vận hành Bánh Mì Que tại ai.banhmique.vn, gồm đơn mua hàng, kho, báo cáo kiểm soát tài chính và công nợ nhà cung cấp. VNAgent là điểm hỏi đáp, không phải cơ sở dữ liệu hay người quyết định chính sách kế toán.

Pilot dành cho owner hiện có bốn chỉ số: doanh thu kiểm soát, số PO, hàng dưới ngưỡng và công nợ NCC hiện tại. Trợ lý chỉ đọc qua công cụ giới hạn; không tự sửa nghiệp vụ, không mặc định biết toàn bộ quy trình công ty. Ngôn ngữ ứng dụng áp dụng cho câu trả lời mới, không dịch lại lịch sử cũ.

Nền tảng dữ liệu cục bộ bổ sung nguồn số liệu CSV/JSON và tài liệu Markdown/text. Số liệu được kiểm tra và truy vấn theo định nghĩa; tài liệu được tra theo đoạn có dẫn nguồn. Không đủ bằng chứng phải nói rõ. Doanh thu từ file nhập không mặc định tương đương sổ doanh thu kiểm soát của BMQ.

Owner có thể bổ sung tài liệu nghiệp vụ đã kiểm tra, ghi rõ tên và nguồn; file số liệu cần ID nguồn và thời điểm cập nhật. Không có tự động đưa dữ liệu vào huấn luyện. Tầng LLM của tích hợp này dùng GPT-5.6 Luna, độc lập với model chung của VNAgent Chat.

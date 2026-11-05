/**
 * Dealer signup contract PDF.
 *
 * The contract body below is copied verbatim from the owner's
 * "HỢP ĐỒNG MẪU ĐẠI LÝ.doc" and mirrored in docs/dealer-signup/contract-template.txt.
 * Only the blanks are filled; keep both copies identical. Word's automatic
 * clause numbers were lost in conversion and were restored to match the
 * contract's own cross-references (2.1, 2.6, 2.7, 2.8.1, 2.9, 3.2).
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

export type DealerContractInput = {
  application_code: string;
  contract_date: string;
  applicant_name: string;
  business_name: string;
  cccd: string;
  cccd_valid_until: string;
  phone: string;
  email: string;
  address_text: string;
};

export type DealerContractPdfAssets = {
  regular: Uint8Array;
  bold: Uint8Array;
};

const CONTRACT_TEMPLATE = `CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM
Độc lập - Tự do - Hạnh phúc
HỢP ĐỒNG PHÂN PHỐI BÁNH MÌ QUE BMQ (ĐẠI LÝ MỞ 01 ĐIỂM)
Số: {application_code}/2026/BMQFOOD

Bản dự thảo – có hiệu lực khi hai bên ký

- Căn cứ vào Bộ luật Dân sự số 91/2015/QH13 của Quốc Hội khóa 13 kỳ họp thứ 10 ban hành ngày 24/11/2015 và có hiệu lực thi hành ngày 01/01/2017.
- Căn cứ vào Bộ luật thương mại số 36/2005/QH11 ban hành ngày 14/06/2005 và có hiệu lực thi hành ngày 01/01/2006.
- Căn cứ vào nhu cầu và khả năng của 2 bên.
Hợp đồng phân phối Bánh Mì Que (“Hợp đồng”) này được lập ngày {contract_date} giữa:

BÊN GIAO ĐẠI LÍ:
CÔNG TY CỔ PHẦN THỰC PHẨM BMQ
Giấy phép đăng ký kinh doanh số: 0311840107 do Sở Kế hoạch và Đầu tư thành phố Hồ Chí Minh cấp lần 14 ngày 04/03/2026
Đại diện bởi: (Ông) Vũ Trần Chí Tâm
Chức vụ: P. Giám đốc
Trụ sở chính: Tầng 2, 68 Nguyễn Huệ, Phường Sài Gòn, Tp.Hồ Chí Minh
Điện thoại: 1900 555591
(Sau đây được gọi là “Bên A”)
Và
BÊN NHẬN ĐẠI LÍ:
Tên hộ kinh doanh / doanh nghiệp: {business_name}
Đại diện bởi: {applicant_name}
Địa chỉ: {address_text}
CCCD/CMND/HC: {cccd}    Có giá trị đến: {cccd_valid_until}
Điện thoại: {phone}
Email: {email}
(Sau đây gọi tắt là “Bên B”)

VÌ RẰNG,
Bên A là chủ sở hữu thương hiệu Bánh Mì Que (sau đây gọi tắt là “BMQ”) và mong muốn được hợp tác với Bên B trong việc phân phối BMQ;
Bên B là một doanh nghiệp hoặc hộ kinh doanh cá thể được thành lập và hoạt động hợp pháp theo quy định của pháp luật Việt Nam, có uy tín, kinh nghiệm trong việc phân phối các sản phẩm thực phẩm tiêu dùng và mong muốn được hợp tác với Bên A trong việc phân phối BMQ;
VẬY NÊN, sau khi trao đổi và bàn bạc, hai bên đã đi đến thống nhất ký kết Hợp đồng này với các điều khoản và điều kiện sau:

Điều 1: Định nghĩa
1.1. Trong Hợp đồng này, các từ ngữ được đề cập dưới đây (trừ trường hợp ngữ cảnh yêu cầu hiểu khác đi) sẽ có nghĩa như sau:
a) Pate là Patê bánh mì do Bên A cung cấp;
b) BMQ là chữ viết tắt của thương hiệu Bánh Mì Que do Bên A là chủ sở hữu; BMQ bao gồm bánh mì, Pate và giấy gói do bên A cung cấp;
c) Giá bán lẻ BMQ là giá bán BMQ tới tay Khách hàng hoặc phí gia hạn do Bên A quyết định và có thể điều chỉnh tại từng thời điểm và Bên B phải phân phối BMQ theo đúng giá này;
d) Giá bán sỉ BMQ là giá bán BMQ từ Bên Giao Đại Lí dành cho Bên Nhận Đại Lí. Giá bán sỉ BMQ chưa bao gồm VAT 10%.
e) Khách hàng là những đối tượng mà Bên B được phép tiếp cận để phân phối BMQ và được quy định tại Điều 2.2 của Hợp đồng này;
f) Lãnh thổ là giới hạn địa lí được xác định tại Điều 2.1 dưới đây, theo đó Bên B được phép phân phối BMQ;
g) VAT là Thuế Giá trị Gia tăng.
1.2. Trong Hợp Đồng này, trừ khi ngữ cảnh yêu cầu phải hiểu khác đi:
a) Các đề mục chỉ để tiện tra cứu và không ảnh hưởng đến việc giải thích các điều, khoản của Hợp Đồng;
b) Các từ bao gồm và bao gồm cả sẽ luôn được hiểu là được đi kèm với cụm từ nhưng không giới hạn bởi; và

Điều 2: Thỏa thuận về việc phân phối BMQ
2.1. Lãnh thổ: Bên A đồng ý giao và Bên B đồng ý nhận làm đại lí phân phối BMQ theo các điều khoản và điều kiện tại Hợp đồng này trong phạm vi địa chỉ:
- {address_text} Là trong vòng phạm vi bán kính 1km.
2.2. Khách hàng: Bên B chỉ được phép tiếp cận và phân phối BMQ cho Khách hàng. Bên B không được phép phân phối cho các đại lí phân phối khác dưới bất kỳ hình thức nào.
2.3. Giá bán lẻ BMQ ngoài thị trường:
Giá bán lẻ tại thời điểm ký Hợp đồng này đối với BMQ là 14,000 VNĐ (mười bốn nghìn đồng), giá đã bao gồm VAT. Đại lý có thể tự lựa chọn giá bán khác phù hợp với mô hình kinh doanh hiện tại và tự chịu trách nhiệm với giá bán đó.
Mỗi đợt điều chỉnh Giá bán lẻ BMQ, Bên A sẽ thông báo bằng văn bản cho Bên B trước thời điểm dự kiến áp dụng giá mới là 15 (mười lăm) ngày làm việc.
2.4. Doanh số và giá bán sỉ BMQ dành cho bên Nhận đại lí:
Giá bán sỉ BMQ:
Cấp độ | Số lượng BMQ/1 tháng (que) | Giá trị chiết khấu (VNĐ) | Giá bán sỉ (không bao gồm VAT, VND)
1 | <= 3.000 | - | 6,500
2 | <= 6.000 và không được ít hơn 3.000 | 500 | 6,000
3 | > 6.000 | 1,000 | 5,500
Tùy theo sự biến động giá cả trên thị trường mà bên A được phép tăng giá bán sỉ BMQ. Mỗi đợt điều chỉnh Giá bán sỉ BMQ, Bên A sẽ thông báo bằng văn bản cho Bên B trước thời điểm dự kiến áp dụng giá mới là 15 (mười lăm) ngày làm việc.
2.5. Phương thức đặt hàng và giao hàng: Bên B sẽ gửi đơn đặt hàng của ngày hôm sau bằng văn bản thông qua thư điện tử, fax hoặc tin nhắn trước 9h tối mỗi ngày. Số lượng bánh đặt phải chia hết cho 20 (Cách đặt: đặt bánh trên Zalo App của BMQ). Thời gian đặt bánh trong ngày là trước 20h hằng ngày.
2.6. Thanh toán:
Sau khi ký hợp đồng, bên B thanh toán trước tiền hàng cho bên A. Mức tối thiểu là 1,000,000 VNĐ (Một triệu đồng). Số tiền này sẽ được khấu trừ dần vào số lượng đặt hàng của bên B. Sau khi khấu trừ, nếu số dư tối thiểu đạt mức tương ứng với 100 bánh (khoảng 650,000VNĐ), bên B phải tiếp tục thanh toán tiền hàng cho bên A bằng hình thức chuyển khoản. Nếu bên B không đáp ứng được những điều kiện trên, bên A sẽ tiến hành ngừng cung cấp bánh cho đến khi bên B thanh toán đủ tiền.
Bên A có nghĩa vụ thông báo số dư cho bên B khi số tiền trong tài khoản dưới mức quy định
2.7. Thời hạn của Hợp đồng: Hợp đồng này có hiệu lực trong 1 (Một) năm kể từ ngày {contract_start_date} đến hết ngày {contract_end_date}. Trước khi kết thúc Hợp đồng 07 (bảy) ngày, hai bên sẽ xem xét việc gia hạn Hợp đồng hoặc ký hợp đồng mới. Nếu đến thời hạn chấm dứt Hợp đồng, hai bên không xem xét hoặc không có quyết định việc gia hạn thì Hợp đồng này sẽ đương nhiên chấm dứt hiệu lực.
Ngoài ra, nếu bên B ngừng kinh doanh trong 2 tháng liên tiếp mà không có sự đồng ý của bên A thì bên A có quyền thanh lý hợp đồng trước thời hạn và bên B sẽ chịu toàn bộ mọi chi phí phát sinh có liên quan.
2.8. Giao hàng: Bên A chỉ đồng ý nhận đặt hàng với số lượng tối thiểu 100 ổ trở lên và có trách nhiệm giao hàng cho Bên B với số lượng tối thiểu 100 ổ BMQ mỗi lần giao trong phạm vi « lãnh thổ » mà không tính bất kì chi phí nào.
2.8.1. Thời gian giao hàng: Bên A có trách nhiệm giao hàng cho Bên B theo thời gian linh động trong ngày.
2.9. Nhận hàng: Bên B có trách nhiệm kiểm tra BMQ khi Bên A giao hàng và xác nhận số lượng với Bên A. Trong suốt thời gian nhận hàng, Bên B phải kiểm tra và thông báo kịp thời cho Bên A (không quá 1 giờ đồng hồ kể từ khi ký biên bản nhận hàng) trong trường hợp BMQ bị lỗi. Bên A có trách nhiệm cử nhân viên đến xác nhận BMQ bị lỗi và tiến hành đổi cho bên B. Bên B phải có trách nhiệm thông báo địa điểm nhận hàng thuộc phạm vị « lãnh thổ » trước 24h nếu Bên B thay đổi địa điểm.
2.10. Tiền đặt cọc: 0 VNĐ (Không đồng)
2.11. Phí gia nhập: 0 VNĐ (Không đồng)
2.12. Mượn xe bánh: không
2.13. Xe bán bánh: Bên B cần xe bánh, bên A sẽ đặt xe mới giá 5,000,000 VNĐ (Năm triệu đồng chẵn), phí vận chuyển (sẽ báo khi chuyển xe) chi phí này bên B chịu.
2.14. Phí mở thêm chi nhánh: Nếu bên B có nhu cầu mở thêm chi nhánh mới. Bên B phải đóng phí gia nhập là 5.000,000 VNĐ (Năm triệu đồng) cho mỗi địa điểm được mở thêm. Số tiền này sẽ không hoàn trả lại sau khi hợp đồng được thanh lý.

Điều 3: Nghĩa vụ và trách nhiệm khác của các Bên
3.1. Nghĩa vụ và trách nhiệm của Bên A:
a) Đảm bảo rằng BMQ thuộc quyền sở hữu hợp pháp của Bên A và việc Bên B phân phối BMQ theo Hợp đồng này sẽ không bị tranh chấp bởi bất kỳ bên thứ ba nào;
b) Bàn giao cho Bên B kỹ thuật làm BMQ trong vòng 03 (ba) ngày làm việc kể từ ngày ký Hợp đồng này;
c) Đào tạo miễn phí nhân viên của Bên B về phương pháp trét patê, nướng bánh mì, bảo quản bánh mì. Kịp thời cập nhật, bổ sung những thay đổi về BMQ cho Bên B;
d) Tư vấn cho Bên B trong việc khắc phục các khiếu nại của Khách hàng khi sử dụng BMQ;
e) Trường hợp BMQ của Bên A bị lỗi, Bên A phải có trách nhiệm đổi lại cho Bên B theo đúng trình tự và thoả thuận như điều 2.9.
f) Trường hợp bên A không được cung cấp BMQ vì bất kỳ lý do nào từ các cơ quan quản lý của nhà nước và/hoặc các cơ quan chủ quản thì Bên A phải có trách nhiệm hoàn trả lại Bên B số tiền đã thanh toán tương ứng với số lượng BMQ.
g) Tuân thủ và thực hiện đúng các thỏa thuận khác tại Hợp đồng này.
3.2. Nghĩa vụ và trách nhiệm của Bên B:
a) Chịu trách nhiệm phân phối BMQ một cách hiệu quả trong phạm vi <Lãnh thổ>;
b) Bảo mật thông tin liên quan tới bí mật kinh doanh BMQ. Bên A không chịu trách nhiệm về việc phân phối, sử dụng sai với quy định an toàn thực phẩm đối với số lượng BMQ Bên B phân phối ra thị trường;
c) Chịu trách nhiệm chọn địa điểm, đặt các thiết bị và bảo quản BMQ kể từ sau khi Bên A giao hàng.
d) Chịu trách nhiệm tất cả các vấn đề liên quan đến <Lãnh Thổ>
e) Chịu trách nhiệm quảng bá, tiếp thị BMQ tới Khách hàng trong phạm vi Lãnh thổ;
f) Chịu mọi chi phí liên quan (nếu có) trong việc bố trí nhân viên để Bên A đào tạo về BMQ.
g) Thanh toán cho Bên A đầy đủ và đúng hạn theo như quy định tại Điều 2.6;
h) Bên B có trách nhiệm tuân thủ đúng quy trình chế biến và bảo quản thực phẩm như bên A đã hướng dẫn.
i) Bên B phải đảm bảo và hoàn toàn chịu trách nhiệm về an toàn vệ sinh thực phẩm tại cơ sở của mình.
k) Bên B chỉ được phép bán duy nhất các sản phẩm do bên A phân phối độc quyền. Và không được phép bán bất kỳ sản phẩm tương tự nào dưới mọi hình thức.
l) Nếu bên B vi phạm bất kỳ điều khoản nào có trên hợp đồng thì bên A được quyền chấm dứt hợp đồng mà không chịu bất kỳ chi phí phát sinh nào. Và trong vòng 03 tháng kể từ ngày chấm dứt hoặc thanh lý hợp đồng, bên B không được phép kinh doanh bất kỳ sản phẩm tương tự nào dưới mọi hình thức. Nếu bên B vi phạm sẽ phải chịu toàn bộ mọi chi phí phát sinh cho bên A.

Điều 4: Chấm dứt Hợp đồng
4.1. Hợp đồng này sẽ đương nhiên chấm dứt hiệu lực khi xảy một trong các sự kiện sau mà không bên nào bị phạt vi phạm và bồi thường thiệt hại:
a) Hết thời hạn của Hợp đồng được quy định tại Điều 2.7;
b) Một trong các Bên bị phá sản, giải thể, ngừng hoạt động sản xuất kinh doanh vì bất kỳ lí do nào.
4.2. Chấm dứt Hợp đồng bởi Bên A:
Bên A có quyền chấm dứt Hợp đồng này trong các trường hợp sau mà không phải hoàn trả hoặc bồi thường hoặc thanh toán bất kỳ khoản phạt vi phạm cho Bên B.
a) Bên B vi phạm nghĩa vụ thanh toán của mình tại Điều 2.6 quá 15 (mười lăm) ngày kể từ ngày đến hạn thanh toán. Trong trường hợp này Bên A chỉ cần gửi thông báo chấm dứt Hợp đồng bằng văn bản cho Bên B và Hợp đồng sẽ chấm dứt hiệu lực kể từ thời điểm do Bên A quyết định trong thông báo.
b) Bên B không nhập hàng trong vòng 3 tháng, không thông báo nguyên nhân với bên A.
c) Đại lý tự ý chuyển địa điểm bán hàng mà không thông báo cho bên A.
d) Trường hợp Bên B vi phạm các điều khoản và điều kiện khác quy định tại Hợp đồng này thì Bên A phải thông báo cho Bên B bằng văn bản chỉ rõ hành vi vi phạm của Bên B. Bên B có nghĩa vụ khắc phục hành vi vi phạm trong thời hạn 7 (bảy) ngày kể từ ngày nhận được thông báo của Bên A. Nếu quá thời hạn này mà Bên B vẫn không khắc phục hành vi vi phạm thì Bên A có quyền chấm dứt Hợp đồng;
4.3. Chấm dứt Hợp đồng bởi Bên B:
Trường hợp Bên A vi phạm các điều khoản và điều kiện quy định trong Hợp đồng này thì Bên B phải thông báo cho Bên A bằng văn bản chỉ rõ hành vi vi phạm của Bên A. Bên A có nghĩa vụ khắc phục hành vi vi phạm trong thời hạn 7 (bảy) ngày kể từ ngày nhận được thông báo của Bên B. Nếu quá thời hạn này mà Bên A vẫn không khắc phục hành vi vi phạm thì Bên B có quyền chấm dứt Hợp đồng.
4.4. Khi hợp đồng bị chấm dứt bởi bất kỳ bên nào hoặc lý do gì, hai bên phải giải quyết dứt điểm các nghĩa vụ còn tồn đọng giữa hai bên và với khách hàng, kể cả trong trường hợp một trong hai bên phá sản.
4.5. Hoàn trả lại các thiết bị kinh doanh mà bên A cung cấp (nếu có) và hoàn trả lại đầy đủ cho bên A sau khi Bên B ngừng kinh doanh và hợp đồng không còn hiệu lực

Điều 5: Thông báo
5.1. Mọi thư từ giao dịch, tài liệu, thông báo và/hoặc đơn đặt hàng giữa các bên phải được lập thành văn bản và được gửi bằng hình thức tương ứng qua thư điện tử hoặc fax hoặc chuyển phát nhanh có báo phát hoặc chuyển trực tiếp tới địa chỉ của bên kia được nêu tại phần đầu của Hợp đồng;
5.2. Thời điểm một bên được coi là đã nhận được thư từ, thông báo, tài liệu hoặc đơn đặt hàng từ bên kia là thời điểm thư điện tử đã được gửi đi thành công từ địa chỉ thư điện tử của Bên kia nếu gửi qua thư điện tử hoặc thời điểm báo cáo gửi thành công được in ra từ máy fax nếu gửi bằng fax hoặc thời điểm mà người đại diện của bên nhận ký nhận vào báo phát hoặc giấy biên nhận nếu gửi bằng chuyển phát nhanh hoặc chuyển trực tiếp tới địa chỉ của bên nhận.

Điều 6: Điều khoản cuối cùng
6.1. Các Bên cam kết tuân thủ nghiêm túc những thoả thuận trong Hợp đồng này. Mọi tranh chấp phát sinh trong quá trình thực hiện Hợp đồng sẽ được các Bên giải quyết thông qua thương lượng và hoà giải trên cơ sở đôi bên cùng có lợi. Trường hợp hai bên không thể giải quyết được những bất đồng thông qua thương lượng thì tranh chấp, bất đồng đó sẽ được giải quyết tại Toà án nhân dân có thẩm quyền. Bên thua kiện sẽ phải bồi thường mọi chi phí liên quan tới việc khởi kiện cho bên thắng kiện (bao gồm cả chi phí Luật sư).
6.2. Hợp đồng này được lập thành hai (02) bản bằng tiếng Việt có giá trị như nhau, mỗi Bên giữ một (01) bản và được lập vào ngày được nêu tại phần đầu của Hợp đồng.

ĐẠI DIỆN BÊN A | ĐẠI DIỆN BÊN B
VŨ TRẦN CHÍ TÂM | {applicant_name}
`;

export function formatContractDate(value: string): string {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value || "");
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Validity runs from the sending date through the day before the same date next year. */
export function contractTerm(contractDate: string): { start: string; end: string } {
  const match = String(contractDate || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return { start: contractDate, end: contractDate };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const end = new Date(Date.UTC(year + 1, month - 1, day));
  end.setUTCDate(end.getUTCDate() - 1);
  const endIso = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;

  return { start: `${match[1]}-${match[2]}-${match[3]}`, end: endIso };
}

export function buildDealerContractText(input: DealerContractInput): string {
  const term = contractTerm(input.contract_date);
  const replacements: Record<string, string> = {
    application_code: input.application_code,
    contract_date: formatContractDate(input.contract_date),
    contract_start_date: formatContractDate(term.start),
    contract_end_date: formatContractDate(term.end),
    applicant_name: input.applicant_name,
    business_name: input.business_name,
    cccd: input.cccd,
    cccd_valid_until: formatContractDate(input.cccd_valid_until),
    phone: input.phone,
    email: input.email,
    address_text: input.address_text,
  };

  return CONTRACT_TEMPLATE.replace(/\{([a-z0-9_]+)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match;
  });
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 48;
const MARGIN_TOP = 52;
const MARGIN_BOTTOM = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const DEFAULT_FONT_BASE = new URL("./fonts/", import.meta.url);

export async function loadDefaultContractFonts(): Promise<DealerContractPdfAssets> {
  const [regular, bold] = await Promise.all([
    Deno.readFile(new URL("NotoSans-Regular-vi.ttf", DEFAULT_FONT_BASE)),
    Deno.readFile(new URL("NotoSans-Bold-vi.ttf", DEFAULT_FONT_BASE)),
  ]);
  return { regular, bold };
}

type TextWidthCache = {
  space: number;
  words: Map<string, number>;
};

// Widths are cached per embedded font object and font size. The contract has a
// small, repeated vocabulary, so this avoids re-measuring words line by line.
const textWidthCaches = new WeakMap<PDFFont, Map<number, TextWidthCache>>();

function textWidthCacheFor(font: PDFFont, size: number): TextWidthCache {
  let bySize = textWidthCaches.get(font);
  if (!bySize) {
    bySize = new Map();
    textWidthCaches.set(font, bySize);
  }
  let cache = bySize.get(size);
  if (!cache) {
    cache = { space: font.widthOfTextAtSize(" ", size), words: new Map() };
    bySize.set(size, cache);
  }
  return cache;
}

function cachedWordWidth(
  font: PDFFont,
  size: number,
  cache: TextWidthCache,
  word: string,
): number {
  let width = cache.words.get(word);
  if (width === undefined) {
    width = font.widthOfTextAtSize(word, size);
    cache.words.set(word, width);
  }
  return width;
}

export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const words = normalized.split(" ");
  const lines: string[] = [];
  const cache = textWidthCacheFor(font, size);
  let current = "";
  let currentWidth = 0;

  for (const word of words) {
    const wordWidth = cachedWordWidth(font, size, cache, word);
    const candidateWidth = current ? currentWidth + cache.space + wordWidth : wordWidth;
    if (candidateWidth <= maxWidth) {
      current = current ? `${current} ${word}` : word;
      currentWidth = candidateWidth;
      continue;
    }

    if (current) lines.push(current);

    if (wordWidth <= maxWidth) {
      current = word;
      currentWidth = wordWidth;
      continue;
    }

    // Split a single over-long token (URL, long name) by characters. Keep the
    // original per-character measurement here, including its kern/shaping
    // behaviour, so over-long tokens break exactly as before.
    let chunk = "";
    for (const char of word) {
      if (font.widthOfTextAtSize(`${chunk}${char}`, size) > maxWidth && chunk) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    current = chunk;
    currentWidth = font.widthOfTextAtSize(current, size);
  }

  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

const isHeading = (line: string): boolean =>
  /^Điều \d+:/.test(line) ||
  line.startsWith("BÊN ") ||
  line.startsWith("CÔNG TY CỔ PHẦN") ||
  line.startsWith("VÌ RẰNG") ||
  line.startsWith("VẬY NÊN");

/** Lines 0-3 (national motto, title, contract number) are centred. */
const CENTERED_LINES = 4;

export async function buildDealerSignupContractPdf(
  input: DealerContractInput,
  assets?: DealerContractPdfAssets,
): Promise<Uint8Array> {
  const fonts = assets ?? await loadDefaultContractFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit as never);

  // The checked-in -vi fonts are already subsetted to the characters this
  // contract needs, so skipping pdf-lib/fontkit subsetting avoids the
  // compute-heavy save step that exceeded the Edge worker limit.
  const regularFont = await doc.embedFont(fonts.regular, { subset: false });
  const boldFont = await doc.embedFont(fonts.bold, { subset: false });

  doc.setTitle(`Hợp đồng phân phối BMQ - ${input.application_code}`);
  doc.setAuthor("CÔNG TY CỔ PHẦN THỰC PHẨM BMQ");
  doc.setCreator("BMQ-AI");
  doc.setProducer("BMQ-AI");
  doc.setSubject(
    `Hợp đồng ${input.application_code} | ${input.applicant_name} | CCCD ${input.cccd} | ${input.phone} | ${input.address_text}`,
  );
  doc.setKeywords([
    input.application_code,
    input.applicant_name,
    input.business_name,
    "6,500",
    "6,000",
    "5,500",
    "bán kính 1km",
  ]);

  const text = buildDealerContractText(input);
  const lines = text.split("\n");

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const newPage = () => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN_TOP;
  };

  const ensureSpace = (height: number) => {
    if (y - height < MARGIN_BOTTOM) newPage();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      y -= 6;
      continue;
    }

    if (index < CENTERED_LINES) {
      const size = index === 2 ? 13.5 : index === 3 ? 10 : 11;
      const wrapped = wrapText(line, boldFont, size, CONTENT_WIDTH);
      for (const part of wrapped) {
        ensureSpace(size + 6);
        page.drawText(part, {
          x: (PAGE_WIDTH - boldFont.widthOfTextAtSize(part, size)) / 2,
          y,
          size,
          font: boldFont,
          color: rgb(0.08, 0.08, 0.08),
        });
        y -= size + 3;
      }
      y -= index === 1 || index === 3 ? 8 : 2;
      continue;
    }

    if (line === "Bản dự thảo – có hiệu lực khi hai bên ký") {
      const size = 9.5;
      ensureSpace(size + 6);
      page.drawText(line, {
        x: MARGIN_X,
        y,
        size,
        font: regularFont,
        color: rgb(0.45, 0.45, 0.45),
      });
      y -= size + 8;
      continue;
    }

    // Table rows (wholesale price table, signature block) use " | " separators.
    if (line.includes(" | ")) {
      const cells = line.split(" | ");
      const tableSize = 8.6;
      const columnWidth = CONTENT_WIDTH / cells.length;
      const wrappedCells = cells.map((cell) => wrapText(cell, boldFont, tableSize, columnWidth - 8));
      const rowLines = Math.max(...wrappedCells.map((parts) => parts.length));
      ensureSpace(rowLines * (tableSize + 3) + 6);
      wrappedCells.forEach((parts, column) => {
        parts.forEach((part, partIndex) => {
          page.drawText(part, {
            x: MARGIN_X + column * columnWidth + 4,
            y: y - partIndex * (tableSize + 3),
            size: tableSize,
            font: boldFont,
            color: rgb(0.1, 0.1, 0.1),
          });
        });
      });
      y -= rowLines * (tableSize + 3) + 4;
      continue;
    }

    const bold = isHeading(line);
    const font = bold ? boldFont : regularFont;
    const size = bold ? 10 : 9.2;
    const wrapped = wrapText(line, font, size, CONTENT_WIDTH);
    for (const part of wrapped) {
      ensureSpace(size + 4);
      page.drawText(part, {
        x: MARGIN_X,
        y,
        size,
        font,
        color: rgb(0.12, 0.12, 0.12),
      });
      y -= size + 3.2;
    }
    y -= bold ? 3 : 1;
  }

  const pageCount = doc.getPageCount();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const current = doc.getPage(pageNumber - 1);
    current.drawText(`Trang ${pageNumber}/${pageCount}`, {
      x: PAGE_WIDTH - MARGIN_X - 45,
      y: 26,
      size: 8,
      font: regularFont,
      color: rgb(0.45, 0.45, 0.45),
    });
  }

  return await doc.save();
}

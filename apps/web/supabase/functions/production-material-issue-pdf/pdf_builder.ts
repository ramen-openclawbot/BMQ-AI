import { jsPDF } from "npm:jspdf@4.0.0";
import { autoTable } from "npm:jspdf-autotable@5.0.7";
import QRCode from "npm:qrcode@1.5.4";

export type MaterialIssuePdfHeader = {
  issue_id: string;
  issue_number: string;
  issue_date: string;
  revision: number;
  immutable_token: string;
  source_hash: string;
  production_order: {
    production_number: string;
  };
};

export type MaterialIssuePdfRow = {
  ingredient_name: string;
  required_qty: number;
  unit: string;
};

export type PdfAssets = {
  regular: Uint8Array;
  bold: Uint8Array;
  logo: Uint8Array;
};

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const PAGE_MARGIN_X = 14;
const PAGE_FOOTER_Y = PAGE_HEIGHT - 8;
const SIGNATURE_BLOCK_HEIGHT = 42;
const SIGNATURE_TOP_GAP = 18;

const bytesToBinary = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return binary;
};

const bytesToBase64 = (bytes: Uint8Array) => btoa(bytesToBinary(bytes));

const formatDateVi = (value: string) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value || "-";
  return `${match[3]}/${match[2]}/${match[1]}`;
};

const formatQty = (value: number) =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(Number(value || 0));

const shortHash = (value: string) => String(value || "").slice(0, 12);

export async function buildQ7MaterialIssuePdf(
  header: MaterialIssuePdfHeader,
  rows: MaterialIssuePdfRow[],
  assets: PdfAssets,
): Promise<Uint8Array> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const deterministicFileId = header.source_hash.slice(0, 32).toUpperCase();
  const deterministicCreationDate = /^\d{4}-\d{2}-\d{2}/.test(header.issue_date)
    ? new Date(`${header.issue_date.slice(0, 10)}T00:00:00.000Z`)
    : new Date("2000-01-01T00:00:00.000Z");
  doc.setFileId(/^[A-F0-9]{32}$/.test(deterministicFileId) ? deterministicFileId : "00000000000000000000000000000000");
  doc.setCreationDate(deterministicCreationDate);
  doc.setProperties({
    title: `Phiếu xuất kho NVL ${header.issue_number}`,
    subject: `Q7 material issue revision ${header.revision}`,
    author: "Bánh Mì Que",
    creator: "BMQ-AI",
  });

  doc.addFileToVFS("NotoSans-Regular.ttf", bytesToBase64(assets.regular));
  doc.addFileToVFS("NotoSans-Bold.ttf", bytesToBase64(assets.bold));
  doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  doc.setFont("NotoSans", "normal");

  const qrPayload = JSON.stringify({
    kind: "q7-material-issue-pdf",
    issue_id: header.issue_id,
    issue_number: header.issue_number,
    revision: header.revision,
    immutable_token: header.immutable_token,
    source_hash: header.source_hash,
  });
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { margin: 0, width: 120, errorCorrectionLevel: "M" });

  doc.addImage(assets.logo, "PNG", 14, 6, 24, 24);
  doc.setFont("NotoSans", "bold");
  doc.setFontSize(17);
  doc.text("PHIẾU XUẤT KHO NGUYÊN VẬT LIỆU", PAGE_WIDTH / 2, 28, { align: "center" });

  doc.setFont("NotoSans", "normal");
  doc.setFontSize(10);
  doc.text(`Số phiếu: ${header.issue_number}`, 14, 42);
  doc.text(`Ngày: ${formatDateVi(header.issue_date)}`, 14, 49);
  doc.text(`Lệnh sản xuất: ${header.production_order.production_number}`, 14, 56);
  doc.text("Kho xuất: Kho bếp Q7", 14, 63);
  doc.text(`Lần sửa đổi: ${header.revision}`, 130, 42);
  doc.text(`Mã xác thực: ${header.immutable_token}`, 130, 49, { maxWidth: 58 });
  doc.text(`Nguồn: ${shortHash(header.source_hash)}`, 130, 63);
  doc.addImage(qrDataUrl, "PNG", 172, 15, 24, 24);

  autoTable(doc, {
    startY: 74,
    margin: { left: PAGE_MARGIN_X, right: PAGE_MARGIN_X, bottom: 18 },
    styles: {
      font: "NotoSans",
      fontStyle: "normal",
      fontSize: 9,
      cellPadding: 1.8,
      minCellWidth: 0,
      lineColor: [220, 225, 230],
      lineWidth: 0.1,
      valign: "middle",
      overflow: "linebreak",
    },
    headStyles: {
      font: "NotoSans",
      fontStyle: "bold",
      fillColor: [244, 246, 248],
      textColor: [20, 25, 32],
    },
    columnStyles: {
      0: { cellWidth: 10, minCellWidth: 10, halign: "center" },
      1: { cellWidth: 126, minCellWidth: 70 },
      2: { cellWidth: 28, minCellWidth: 22, halign: "right" },
      3: { cellWidth: 18, minCellWidth: 16 },
    },
    head: [["STT", "Tên nguyên vật liệu", "Số lượng", "Đơn vị"]],
    body: rows.map((row, index) => [
      String(index + 1),
      row.ingredient_name,
      formatQty(row.required_qty),
      row.unit,
    ]),
  });

  const finalY = (doc as any).lastAutoTable?.finalY || 92;
  const currentPage = doc.getCurrentPageInfo().pageNumber;
  const remainingHeight = PAGE_FOOTER_Y - (finalY + SIGNATURE_TOP_GAP);
  if (remainingHeight < SIGNATURE_BLOCK_HEIGHT) {
    doc.addPage();
  }
  const signatureY = Math.max(
    (doc.getCurrentPageInfo().pageNumber === currentPage ? finalY : 92) + SIGNATURE_TOP_GAP,
    196,
  );
  const blocks = [
    { label: "Người lập phiếu", x: 34 },
    { label: "Người xuất kho", x: 105 },
    { label: "Người nhận NVL", x: 176 },
  ];
  doc.setFont("NotoSans", "bold");
  doc.setFontSize(10);
  for (const block of blocks) {
    doc.text(block.label, block.x, signatureY, { align: "center" });
    doc.setFont("NotoSans", "normal");
    doc.setFontSize(8);
    doc.text("(Ký, ghi rõ họ tên)", block.x, signatureY + 6, { align: "center" });
    doc.setFont("NotoSans", "bold");
    doc.setFontSize(10);
  }

  const pageCount = doc.getNumberOfPages();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    doc.setPage(pageNumber);
    doc.setFont("NotoSans", "normal");
    doc.setFontSize(8);
    doc.text(`Trang ${pageNumber}/${pageCount}`, PAGE_WIDTH - PAGE_MARGIN_X, PAGE_FOOTER_Y, { align: "right" });
  }

  const arrayBuffer = doc.output("arraybuffer") as ArrayBuffer;
  return new Uint8Array(arrayBuffer);
}

import { memo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createEmptyPoDraftItem,
  formatVnd,
  sanitizePoLineSource,
} from "./poDraftUtils";

type LineItemRowProps = {
  item: any;
  onPatch: (patch: Record<string, any>) => void;
  onRemove: () => void;
};

const PoLineItemRow = memo(function PoLineItemRow({ item, onPatch, onRemove }: LineItemRowProps) {
  const source = sanitizePoLineSource(item?.source);
  return (
    <TableRow className="align-top">
      <TableCell className="py-2 pr-2">
        <Input className="h-9" value={item?.sku || ""} onChange={(e) => onPatch({ sku: e.target.value })} placeholder="Mã" />
      </TableCell>
      <TableCell className="py-2 pr-2">
        <Input className="h-9" value={item?.product_name || ""} onChange={(e) => onPatch({ product_name: e.target.value, source: source === "parsed" ? "manually_edited" : source })} placeholder="Tên sản phẩm / điểm giao" />
      </TableCell>
      <TableCell className="py-2 pr-2">
        <Input className="h-9" value={item?.specification || ""} onChange={(e) => onPatch({ specification: e.target.value, source: source === "parsed" ? "manually_edited" : source })} placeholder="Quy cách" />
      </TableCell>
      <TableCell className="py-2 pr-2">
        <Input className="h-9" value={item?.unit || ""} onChange={(e) => onPatch({ unit: e.target.value, source: source === "parsed" ? "manually_edited" : source })} placeholder="cái" />
      </TableCell>
      <TableCell className="py-2 pr-2">
        <Input
          type="number"
          value={item?.qty ?? ""}
          onChange={(e) => {
            const qty = Number(e.target.value || 0) || 0;
            const unitPrice = Number(item?.unit_price || 0) || 0;
            onPatch({ qty, line_total: qty * unitPrice || Number(item?.line_total || 0) || 0, source: source === "parsed" ? "manually_edited" : source });
          }}
          className="h-9 text-right"
          placeholder="0"
        />
      </TableCell>
      <TableCell className="py-2 pr-2">
        <Input
          type="number"
          value={item?.unit_price ?? ""}
          onChange={(e) => {
            const unitPrice = Number(e.target.value || 0) || 0;
            const qty = Number(item?.qty || 0) || 0;
            onPatch({ unit_price: unitPrice, line_total: qty * unitPrice || Number(item?.line_total || 0) || 0, source: source === "parsed" ? "manually_edited" : source });
          }}
          className="h-9 text-right"
          placeholder="0"
        />
      </TableCell>
      <TableCell className="py-2 pr-2">
        <Input
          type="number"
          value={item?.line_total ?? ""}
          onChange={(e) => onPatch({ line_total: Number(e.target.value || 0) || 0, source: source === "parsed" ? "manually_edited" : source })}
          className="h-9 text-right"
          placeholder="0"
        />
        <div className="mt-1 text-[10px] text-muted-foreground text-right leading-none">{formatVnd(item?.line_total || 0)}</div>
      </TableCell>
      <TableCell className="py-2 pr-2">
        <Input className="h-9" value={item?.note || ""} onChange={(e) => onPatch({ note: e.target.value, source: source === "parsed" ? "manually_edited" : source })} placeholder="Ghi chú" />
      </TableCell>
      <TableCell className="py-2 pr-2">
        <Badge variant={source === "parsed" ? "secondary" : "default"} className="whitespace-nowrap text-[11px]">{source}</Badge>
      </TableCell>
      <TableCell className="py-2 text-right">
        <Button type="button" size="icon" variant="ghost" className="h-9 w-9" onClick={onRemove}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </TableCell>
    </TableRow>
  );
});

type Props = {
  selectedPo: any;
  selectedPoResolvedCustomerId: string | null;
  customers: any[];
  poSummaryDraft: any;
  poDraftDerivedTotalAmount: number;
  poDraftLineItemsAmount: number;
  poDraftSubtotalAmount: number;
  poDraftVatAmount: number;
  poDraftSubtotalMismatch: boolean;
  isPoDraftDirty: boolean;
  savePoStatus: string;
  postRevenueStatus: string;
  parseAttachmentPending: boolean;
  savePending: boolean;
  postRevenuePending: boolean;
  poParseDebug?: any | null;
  onDraftFieldChange: (field: string, value: any) => void;
  onAddLineItem: () => void;
  onPatchLineItem: (_rowId: string, patch: Record<string, any>) => void;
  onRemoveLineItem: (_rowId: string) => void;
  onParseAttachment: () => void;
  onParseEmailBody: () => void;
  onSave: () => void;
  onPostRevenue: () => void;
};

export function SalesPoQuickViewEditor(props: Props) {
  const {
    selectedPo,
    selectedPoResolvedCustomerId,
    customers,
    poSummaryDraft,
    poDraftDerivedTotalAmount,
    poDraftLineItemsAmount,
    poDraftSubtotalAmount,
    poDraftVatAmount,
    poDraftSubtotalMismatch,
    isPoDraftDirty,
    savePoStatus,
    postRevenueStatus,
    parseAttachmentPending,
    savePending,
    postRevenuePending,
    poParseDebug,
    onDraftFieldChange,
    onAddLineItem,
    onPatchLineItem,
    onRemoveLineItem,
    onParseAttachment,
    onParseEmailBody,
    onSave,
    onPostRevenue,
  } = props;

  const productionItems = Array.isArray(poSummaryDraft.production_items) ? poSummaryDraft.production_items : [];
  const totalQty = productionItems.reduce((sum: number, item: any) => sum + Number(item?.qty || item?.quantity || 0), 0);

  const primaryStatus = isPoDraftDirty
    ? "Bạn đang có thay đổi chưa lưu. Hãy lưu tóm tắt PO trước khi parse lại hoặc đẩy sang kiểm soát doanh thu."
    : savePoStatus;

  return (
    <div className="space-y-3">
      <Tabs defaultValue="accounting" className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="accounting">Kế toán</TabsTrigger>
          <TabsTrigger value="production">QL Sản xuất</TabsTrigger>
        </TabsList>

        <TabsContent value="accounting" className="space-y-3 pt-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>PO Number</Label>
              <Input value={poSummaryDraft.po_number || ""} onChange={(e) => onDraftFieldChange("po_number", e.target.value)} />
            </div>
            <div>
              <Label>Ngày giao</Label>
              <Input type="date" value={poSummaryDraft.delivery_date || ""} onChange={(e) => onDraftFieldChange("delivery_date", e.target.value)} />
            </div>
            <div>
              <Label>Tạm tính</Label>
              <Input type="number" value={poSummaryDraft.subtotal_amount || ""} onChange={(e) => onDraftFieldChange("subtotal_amount", e.target.value)} />
              <div className="text-xs text-muted-foreground mt-1">{formatVnd(poSummaryDraft.subtotal_amount)}</div>
            </div>
            <div>
              <Label>VAT</Label>
              <Input type="number" value={poSummaryDraft.vat_amount || ""} onChange={(e) => onDraftFieldChange("vat_amount", e.target.value)} />
              <div className="text-xs text-muted-foreground mt-1">{formatVnd(poSummaryDraft.vat_amount)}</div>
            </div>
            <div>
              <Label>Tổng tiền đơn hàng</Label>
              <Input type="number" value={poDraftDerivedTotalAmount || ""} readOnly />
              <div className="text-xs text-muted-foreground mt-1">{formatVnd(poDraftDerivedTotalAmount)}</div>
            </div>
          </div>
          <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Tổng dòng sản phẩm: <b>{formatVnd(poDraftLineItemsAmount)}</b> • Tạm tính hiện nhập: <b>{formatVnd(poDraftSubtotalAmount)}</b> • VAT: <b>{formatVnd(poDraftVatAmount)}</b>
          </div>
          {poDraftSubtotalMismatch && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              Cảnh báo: tổng thành tiền của line items ({formatVnd(poDraftLineItemsAmount)}) đang lệch so với tạm tính ({formatVnd(poDraftSubtotalAmount)}). Hệ thống vẫn cho phép lưu, nhưng anh/chị nên kiểm tra lại trước khi chốt.
            </div>
          )}
        </TabsContent>

        <TabsContent value="production" className="space-y-3 pt-3">
          <div className="grid gap-3 md:grid-cols-[minmax(260px,1fr)_minmax(320px,1.2fr)]">
            <div>
              <Label>Khách hàng / NPP</Label>
              <select
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={poSummaryDraft.customer_id || selectedPo.customer_id || selectedPoResolvedCustomerId || ""}
                onChange={(e) => onDraftFieldChange("customer_id", e.target.value)}
              >
                <option value="">-- Chưa chọn khách hàng --</option>
                {customers.map((c: any) => (
                  <option key={c.id} value={c.id}>{c.customer_name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Ghi chú xử lý tay</Label>
              <textarea
                className="mt-1 min-h-[92px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={poSummaryDraft.notes || ""}
                onChange={(e) => onDraftFieldChange("notes", e.target.value)}
                placeholder="Ví dụ: thêm 2 dòng hàng còn thiếu theo xác nhận của khách / chỉnh lại số lượng theo file gốc"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2">
            <Label className="text-sm font-medium">Danh sách sản phẩm cho quản lí sản xuất</Label>
            <div className="flex items-center gap-2">
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                Tổng dòng: {productionItems.length} • Tổng SL: {totalQty.toLocaleString("vi-VN")}
              </div>
              <Button type="button" size="sm" variant="outline" className="h-8 px-2" onClick={onAddLineItem}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {poParseDebug && (
            <div className="rounded-md border bg-muted/20 p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div className="text-sm font-medium">Parse debug từ nội dung email</div>
                <div className="flex items-center gap-2">
                  <Badge variant={Number(poParseDebug?.confidence || 0) < 0.8 ? "destructive" : "secondary"}>
                    Confidence: {Math.round(Number(poParseDebug?.confidence || 0) * 100)}%
                  </Badge>
                  {Number(poParseDebug?.confidence || 0) < 0.8 && (
                    <Badge variant="outline" className="border-amber-500 text-amber-600">Cần kiểm tra lại parse</Badge>
                  )}
                </div>
              </div>
              <div className="rounded-md border overflow-x-auto bg-background">
                <Table className="min-w-[980px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[280px]">Raw segment</TableHead>
                      <TableHead className="min-w-[180px]">Tên điểm parse ra</TableHead>
                      <TableHead className="w-[90px] text-right">qty_base</TableHead>
                      <TableHead className="w-[110px] text-right">qty_exchange</TableHead>
                      <TableHead className="w-[90px] text-right">qty_total</TableHead>
                      <TableHead className="min-w-[180px]">Ghi chú</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(poParseDebug?.debugSegments || []).map((seg: any, idx: number) => (
                      <TableRow key={idx} className={!seg?.matched ? "bg-amber-500/5" : ""}>
                        <TableCell className="align-top text-xs leading-5">{seg?.raw_segment || "-"}</TableCell>
                        <TableCell className="align-top">{seg?.product_name || <span className="text-muted-foreground">Không parse được</span>}</TableCell>
                        <TableCell className="align-top text-right">{Number(seg?.qty_base || 0).toLocaleString("vi-VN")}</TableCell>
                        <TableCell className="align-top text-right">{Number(seg?.qty_exchange || 0).toLocaleString("vi-VN")}</TableCell>
                        <TableCell className="align-top text-right">{Number(seg?.qty_total || 0).toLocaleString("vi-VN")}</TableCell>
                        <TableCell className="align-top text-xs leading-5 text-muted-foreground">{seg?.note || "-"}</TableCell>
                      </TableRow>
                    ))}
                    {!(poParseDebug?.debugSegments || []).length && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-4">Chưa có dữ liệu parse debug.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          <div className="rounded-md border overflow-x-auto">
            <Table className="min-w-[1080px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px] pl-4">SKU</TableHead>
                  <TableHead className="min-w-[250px]">Tên sản phẩm</TableHead>
                  <TableHead className="min-w-[180px]">Quy cách / mô tả</TableHead>
                  <TableHead className="w-[84px]">ĐVT</TableHead>
                  <TableHead className="w-[88px] text-right">SL</TableHead>
                  <TableHead className="w-[110px] text-right">Đơn giá</TableHead>
                  <TableHead className="w-[120px] text-right">Thành tiền</TableHead>
                  <TableHead className="min-w-[190px]">Ghi chú dòng</TableHead>
                  <TableHead className="w-[120px]">Nguồn</TableHead>
                  <TableHead className="w-[56px] text-right pr-4"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {productionItems.map((item: any) => (
                  <PoLineItemRow
                    key={item._rowId}
                    item={item}
                    onPatch={(patch) => onPatchLineItem(item._rowId, patch)}
                    onRemove={() => onRemoveLineItem(item._rowId)}
                  />
                ))}
                {productionItems.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-6">
                      Chưa có dữ liệu sản phẩm. Có thể parse lại hoặc bấm “Thêm dòng” để nhập tay.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="secondary" className="h-9" onClick={onParseAttachment} disabled={parseAttachmentPending}>
          {parseAttachmentPending ? "Đang parse..." : "Parse từ file đính kèm"}
        </Button>
        <Button variant="outline" className="h-9" onClick={onParseEmailBody}>Parse từ nội dung email</Button>
        <Button className="h-9" onClick={onSave} disabled={savePending}>Lưu tóm tắt PO</Button>
        <Button variant="outline" className="h-9" onClick={onPostRevenue} disabled={postRevenuePending || isPoDraftDirty}>
          {postRevenuePending ? "Đang đẩy..." : "Đẩy sang kiểm soát doanh thu"}
        </Button>
      </div>

      {primaryStatus && (
        <div className={`text-sm rounded-md border px-3 py-2 ${isPoDraftDirty ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-muted/40"}`}>
          {primaryStatus}
        </div>
      )}
      {!isPoDraftDirty && postRevenueStatus && <div className="text-sm rounded-md border px-3 py-2 bg-muted/40">{postRevenueStatus}</div>}
    </div>
  );
}

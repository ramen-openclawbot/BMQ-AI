import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";

const vnd = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0);

const breadChannels = [
  { key: "banhmi_point", label: "Doanh thu điểm bán" },
  { key: "banhmi_agency", label: "Doanh thu đại lý" },
  { key: "online_grab", label: "Online - GrabFood" },
  { key: "online_shopee", label: "Online - ShopeeFood" },
  { key: "online_be", label: "Online - Be" },
  { key: "online_facebook", label: "Online - Facebook" },
] as const;

const cakeChannels = [
  { key: "cake_kingfoodmart", label: "Kingfoodmart" },
  { key: "cake_cafe", label: "Quán cafe" },
] as const;

type RevenueState = Record<string, number>;

const normalizeChannel = (channel?: string | null) => {
  const key = String(channel || "").trim();
  if (!key) return "";
  if (key === "wholesale_kfm") return "cake_kingfoodmart";
  return key;
};

const dateOnly = (value?: string | null) => String(value || "").slice(0, 10);
const todayLocal = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export default function FinanceRevenueControl() {
  const [selectedDate, setSelectedDate] = useState<string>(todayLocal());
  const [manualAdjust, setManualAdjust] = useState<RevenueState>({});

  const { data: postedPoRows = [] } = useQuery({
    queryKey: ["finance-posted-po"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id,po_number,email_subject,revenue_channel,total_amount,subtotal_amount,vat_amount,delivery_date,received_at,raw_payload")
        .order("received_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const postedRows = useMemo(
    () => postedPoRows.filter((r: any) => Boolean(r?.raw_payload?.revenue_post?.posted)),
    [postedPoRows]
  );

  const postedRowsByDate = useMemo(() => {
    return postedRows.filter((r: any) => {
      // Rule: ghi nhận doanh thu theo ngày đặt PO
      const poOrderDate = dateOnly(r?.raw_payload?.parse_meta?.po_order_date) || dateOnly(r?.received_at);
      const postedDate = dateOnly(r?.raw_payload?.revenue_post?.posted_at);
      const d = poOrderDate || postedDate || dateOnly(r.delivery_date);
      return d === selectedDate;
    });
  }, [postedRows, selectedDate]);

  const autoData = useMemo(() => {
    const out: RevenueState = {};
    for (const row of postedRowsByDate) {
      const channel = normalizeChannel(row.revenue_channel);
      if (!channel) continue;
      const amount = Number(row.total_amount || row.subtotal_amount || 0);
      out[channel] = (out[channel] || 0) + amount;
    }
    return out;
  }, [postedRowsByDate]);

  const mergedData = useMemo(() => {
    const out: RevenueState = { ...autoData };
    for (const [k, v] of Object.entries(manualAdjust)) {
      out[k] = Number(out[k] || 0) + Number(v || 0);
    }
    return out;
  }, [autoData, manualAdjust]);

  const setAmount = (key: string, value: string) => {
    setManualAdjust((prev) => ({ ...prev, [key]: Number(value || 0) }));
  };

  const totals = useMemo(() => {
    const breadTotal = breadChannels.reduce((sum, c) => sum + Number(mergedData[c.key] || 0), 0);
    const cakeTotal = cakeChannels.reduce((sum, c) => sum + Number(mergedData[c.key] || 0), 0);
    return {
      breadTotal,
      cakeTotal,
      grandTotal: breadTotal + cakeTotal,
    };
  }, [mergedData]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">Kiểm soát doanh thu</h1>
        <p className="text-muted-foreground">Phân tách doanh thu theo nhóm Bánh mì / Bánh ngọt và theo từng kênh bán.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bộ lọc ngày</CardTitle>
          <CardDescription>Ghi nhận doanh thu theo từng ngày vận hành.</CardDescription>
        </CardHeader>
        <CardContent className="max-w-xs">
          <Label>Ngày</Label>
          <Input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>PO đã đẩy từ Mini-CRM</CardTitle>
          <CardDescription>Tự động tổng hợp theo ngày đặt PO (ưu tiên po_order_date/received_at).</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground mb-1">Số PO trong ngày: {postedRowsByDate.length}</div>
          <div className="text-xs text-muted-foreground mb-3">Tổng PO đã đẩy (mọi ngày): {postedRows.length}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO</TableHead>
                <TableHead>Kênh</TableHead>
                <TableHead className="text-right">Giá trị</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {postedRowsByDate.map((row: any) => (
                <TableRow key={row.id}>
                  <TableCell>{row.po_number || row.email_subject || "-"}</TableCell>
                  <TableCell>{normalizeChannel(row.revenue_channel) || "-"}</TableCell>
                  <TableCell className="text-right">{vnd(Number(row.total_amount || row.subtotal_amount || 0))}</TableCell>
                </TableRow>
              ))}
              {postedRowsByDate.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground py-6">Chưa có PO nào được đẩy cho ngày này.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Tổng doanh thu Bánh mì</div>
            <div className="text-xl font-semibold">{vnd(totals.breadTotal)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Tổng doanh thu Bánh ngọt</div>
            <div className="text-xl font-semibold">{vnd(totals.cakeTotal)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Tổng doanh thu toàn bộ</div>
            <div className="text-xl font-semibold">{vnd(totals.grandTotal)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>I. Doanh thu Bánh mì</CardTitle>
          <CardDescription>Giá trị ô = tự động từ PO đã đẩy + điều chỉnh tay (nếu cần).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {breadChannels.map((channel) => (
            <div key={channel.key} className="space-y-2">
              <Label>{channel.label}</Label>
              <Input
                type="number"
                value={Number(manualAdjust[channel.key] || 0)}
                onChange={(e) => setAmount(channel.key, e.target.value)}
                placeholder="Điều chỉnh thêm (VND)"
              />
              <div className="text-xs text-muted-foreground">Tự động: {vnd(Number(autoData[channel.key] || 0))} • Tổng hiển thị: {vnd(Number(mergedData[channel.key] || 0))}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>II. Doanh thu Bánh ngọt</CardTitle>
          <CardDescription>Giá trị ô = tự động từ PO đã đẩy + điều chỉnh tay (nếu cần).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {cakeChannels.map((channel) => (
            <div key={channel.key} className="space-y-2">
              <Label>{channel.label}</Label>
              <Input
                type="number"
                value={Number(manualAdjust[channel.key] || 0)}
                onChange={(e) => setAmount(channel.key, e.target.value)}
                placeholder="Điều chỉnh thêm (VND)"
              />
              <div className="text-xs text-muted-foreground">Tự động: {vnd(Number(autoData[channel.key] || 0))} • Tổng hiển thị: {vnd(Number(mergedData[channel.key] || 0))}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>RO - Recipe of Operation (PO qua email po@bmq.vn)</CardTitle>
          <CardDescription>Thiết kế luồng vận hành cho Phase 4: nhận PO email, nhận diện khách hàng từ mini-CRM và bắt buộc duyệt tay.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bước</TableHead>
                <TableHead>Mô tả</TableHead>
                <TableHead>Trạng thái</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>1. Ingest Gmail</TableCell>
                <TableCell>Đọc email mới từ po@bmq.vn (Google Workspace).</TableCell>
                <TableCell><Badge variant="secondary">Done</Badge></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>2. Parse PO</TableCell>
                <TableCell>Tách subject/body/attachment + số PO + giá trị tạm tính/VAT/tổng tiền.</TableCell>
                <TableCell><Badge variant="secondary">Done</Badge></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>3. Match mini-CRM</TableCell>
                <TableCell>Map email người gửi với khách hàng đã khai báo ở mini-CRM.</TableCell>
                <TableCell><Badge variant="secondary">Done</Badge></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>4. Manual Approval + Post revenue</TableCell>
                <TableCell>Bắt buộc duyệt tay trước khi đẩy sang màn Kiểm soát doanh thu.</TableCell>
                <TableCell><Badge className="bg-emerald-600">Done</Badge></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

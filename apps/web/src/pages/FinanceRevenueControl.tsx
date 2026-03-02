import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/contexts/LanguageContext";

const vnd = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0);

const GROUP_LABEL_MAP: Record<string, string> = {
  banhmi_point: "Bán lẻ",
  banhmi_agency: "Đại lý",
  online: "Online",
  b2b: "B2B",
};
const PRODUCT_GROUP_LABEL_MAP: Record<string, string> = {
  banhmi: "Bánh mì",
  banhngot: "Bánh ngọt",
};

const inferProductGroup = (row: any): "banhmi" | "banhngot" => {
  const pg = String(row?.mini_crm_customers?.product_group || "").trim();
  if (pg === "banhngot") return "banhngot";
  const channel = normalizeChannel(row?.revenue_channel);
  if (channel.startsWith("cake_") || channel === "wholesale_kfm") return "banhngot";
  return "banhmi";
};

const normalizeChannel = (channel?: string | null) => {
  const key = String(channel || "").trim();
  if (!key) return "";
  if (key === "wholesale_kfm") return "cake_kingfoodmart";
  return key;
};

const dateOnly = (value?: string | null) => String(value || "").slice(0, 10);
const extractPoNumberFromSubject = (subject?: string) => {
  const s = String(subject || "");
  const m = s.match(/\b(PO\d{6,})\b/i) || s.match(/PO\s*(\d{6,})/i);
  if (!m) return "";
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};
const calcAmountFromRow = (row: any) => {
  const postedTotal = Number(row?.raw_payload?.revenue_post?.total || row?.raw_payload?.revenue_post?.amount || 0);
  if (postedTotal > 0) return postedTotal;
  const direct = Number(row?.total_amount || row?.subtotal_amount || 0);
  if (direct > 0) return direct;
  const meta = row?.raw_payload?.parse_meta || {};
  const metaTotal = Number(meta?.total_amount || 0);
  if (metaTotal > 0) return metaTotal;
  const metaSubtotal = Number(meta?.subtotal || 0);
  const metaVat = Number(meta?.vat_amount || 0);
  if (metaSubtotal > 0) return metaSubtotal + metaVat;
  const items = Array.isArray(row?.raw_payload?.parsed_items_preview) ? row.raw_payload.parsed_items_preview : [];
  return items.reduce((sum: number, it: any) => sum + Number(it?.line_total || 0), 0);
};
const todayLocal = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export default function FinanceRevenueControl() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const [selectedDate, setSelectedDate] = useState<string>(todayLocal());

  const { data: postedPoRows = [] } = useQuery({
    queryKey: ["finance-posted-po"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id,email_subject,revenue_channel,total_amount,subtotal_amount,vat_amount,delivery_date,received_at,raw_payload, mini_crm_customers(customer_name,customer_group,product_group)")
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

  const totals = useMemo(() => {
    let breadTotal = 0;
    let cakeTotal = 0;
    for (const row of postedRowsByDate) {
      const amount = calcAmountFromRow(row);
      if (inferProductGroup(row) === "banhngot") cakeTotal += amount;
      else breadTotal += amount;
    }
    return {
      breadTotal,
      cakeTotal,
      grandTotal: breadTotal + cakeTotal,
    };
  }, [postedRowsByDate]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">{isVi ? "Kiểm soát doanh thu" : "Revenue control"}</h1>
        <p className="text-muted-foreground">{isVi ? "Phân tách doanh thu theo nhóm Bánh mì / Bánh ngọt và theo từng kênh bán." : "Split revenue by Bread / Cake group and by channel."}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{isVi ? "Bộ lọc ngày" : "Date filter"}</CardTitle>
          <CardDescription>{isVi ? "Ghi nhận doanh thu theo từng ngày vận hành." : "Record revenue by operating date."}</CardDescription>
        </CardHeader>
        <CardContent className="max-w-xs">
          <Label>{isVi ? "Ngày" : "Date"}</Label>
          <Input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{isVi ? "Danh sách PO của khách hàng" : "Customer PO list"}</CardTitle>
          <CardDescription>{isVi ? "Dữ liệu đồng bộ theo thông tin đã khai báo trong CRM." : "Synced from CRM-declared customer information."}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground mb-1">{isVi ? "Số PO trong ngày" : "PO count today"}: {postedRowsByDate.length}</div>
          <div className="text-xs text-muted-foreground mb-3">{isVi ? "Tổng PO đã đẩy (mọi ngày)" : "Total posted POs (all days)"}: {postedRows.length}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{isVi ? "Tên khách hàng" : "Customer"}</TableHead>
                <TableHead>{isVi ? "Nhóm" : "Group"}</TableHead>
                <TableHead>{isVi ? "Nhóm sản phẩm" : "Product group"}</TableHead>
                <TableHead className="text-right">{isVi ? "Giá trị" : "Amount"}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {postedRowsByDate.map((row: any) => (
                <TableRow key={row.id}>
                  <TableCell>{row?.mini_crm_customers?.customer_name || "-"}</TableCell>
                  <TableCell>{GROUP_LABEL_MAP[row?.mini_crm_customers?.customer_group] || row?.mini_crm_customers?.customer_group || normalizeChannel(row.revenue_channel) || "-"}</TableCell>
                  <TableCell>{PRODUCT_GROUP_LABEL_MAP[row?.mini_crm_customers?.product_group] || row?.mini_crm_customers?.product_group || "-"}</TableCell>
                  <TableCell className="text-right">{vnd(calcAmountFromRow(row))}</TableCell>
                </TableRow>
              ))}
              {postedRowsByDate.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-6">{isVi ? "Chưa có PO nào được đẩy cho ngày này." : "No posted PO for this date."}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{isVi ? "Tổng doanh thu Bánh mì" : "Total Bread revenue"}</div>
            <div className="text-xl font-semibold">{vnd(totals.breadTotal)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{isVi ? "Tổng doanh thu Bánh ngọt" : "Total Cake revenue"}</div>
            <div className="text-xl font-semibold">{vnd(totals.cakeTotal)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">{isVi ? "Tổng doanh thu toàn bộ" : "Total revenue"}</div>
            <div className="text-xl font-semibold">{vnd(totals.grandTotal)}</div>
          </CardContent>
        </Card>
      </div>


    </div>
  );
}

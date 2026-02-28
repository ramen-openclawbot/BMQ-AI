import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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

export default function FinanceRevenueControl() {
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<RevenueState>({});

  const setAmount = (key: string, value: string) => {
    setData((prev) => ({ ...prev, [key]: Number(value || 0) }));
  };

  const totals = useMemo(() => {
    const breadTotal = breadChannels.reduce((sum, c) => sum + Number(data[c.key] || 0), 0);
    const cakeTotal = cakeChannels.reduce((sum, c) => sum + Number(data[c.key] || 0), 0);
    return {
      breadTotal,
      cakeTotal,
      grandTotal: breadTotal + cakeTotal,
    };
  }, [data]);

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
          <CardDescription>Điểm bán, đại lý và các kênh bán online.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {breadChannels.map((channel) => (
            <div key={channel.key} className="space-y-2">
              <Label>{channel.label}</Label>
              <Input
                type="number"
                value={Number(data[channel.key] || 0)}
                onChange={(e) => setAmount(channel.key, e.target.value)}
                placeholder="Nhập doanh thu VND"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>II. Doanh thu Bánh ngọt</CardTitle>
          <CardDescription>Doanh thu qua hệ thống phân phối bánh ngọt.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {cakeChannels.map((channel) => (
            <div key={channel.key} className="space-y-2">
              <Label>{channel.label}</Label>
              <Input
                type="number"
                value={Number(data[channel.key] || 0)}
                onChange={(e) => setAmount(channel.key, e.target.value)}
                placeholder="Nhập doanh thu VND"
              />
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
                <TableCell><Badge variant="secondary">Planned</Badge></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>2. Parse PO</TableCell>
                <TableCell>Tách subject/body/attachment + số PO + giá trị tạm tính.</TableCell>
                <TableCell><Badge variant="secondary">Planned</Badge></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>3. Match mini-CRM</TableCell>
                <TableCell>Map email người gửi với khách hàng đã khai báo ở mini-CRM.</TableCell>
                <TableCell><Badge variant="secondary">Planned</Badge></TableCell>
              </TableRow>
              <TableRow>
                <TableCell>4. Manual Approval</TableCell>
                <TableCell>Bắt buộc duyệt tay trước khi tạo đơn chính thức.</TableCell>
                <TableCell><Badge className="bg-amber-600">Required</Badge></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

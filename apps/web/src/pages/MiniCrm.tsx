import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

const GROUP_OPTIONS = [
  { value: "banhmi_point", label: "Bánh mì - Điểm bán" },
  { value: "banhmi_agency", label: "Bánh mì - Đại lý" },
  { value: "online", label: "Bánh mì - Online" },
  { value: "cake_kingfoodmart", label: "Bánh ngọt - Kingfoodmart" },
  { value: "cake_cafe", label: "Bánh ngọt - Quán cafe" },
];

const extractPoNumberFromSubject = (subject?: string) => {
  const s = String(subject || "");
  const m = s.match(/\b(PO\d{6,})\b/i) || s.match(/PO\s*(\d{6,})/i);
  if (!m) return "";
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};

const extractDeliveryDateFromSubject = (subject?: string) => {
  const s = String(subject || "");
  const m = s.match(/GIAO\s*NGÀY\s*(\d{2})[./-](\d{2})[./-](\d{4})/i);
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
};

const calcSubtotalFromItems = (items: any[]) =>
  (Array.isArray(items) ? items : []).reduce((sum: number, it: any) => sum + Number(it?.line_total || 0), 0);


export default function MiniCrm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [customerName, setCustomerName] = useState("");
  const [customerCode, setCustomerCode] = useState("");
  const [customerGroup, setCustomerGroup] = useState("banhmi_point");
  const [defaultRevenueChannel, setDefaultRevenueChannel] = useState("");
  const [emailsInput, setEmailsInput] = useState("");
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const [poSummaryDraft, setPoSummaryDraft] = useState<any>({});

  const { data: gmailConnectedEmail } = useQuery({
    queryKey: ["gmail-connected-email"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "google_gmail_connected_email")
        .maybeSingle();
      if (error) throw error;
      return data?.value || null;
    },
  });

  const { data: customers = [] } = useQuery({
    queryKey: ["mini-crm-customers"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customers")
        .select("*, mini_crm_customer_emails(*)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: poInbox = [] } = useQuery({
    queryKey: ["customer-po-inbox"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select("*, mini_crm_customers(customer_name)")
        .order("received_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
  });

  const addCustomerMutation = useMutation({
    mutationFn: async () => {
      const trimmedName = customerName.trim();
      if (!trimmedName) throw new Error("Vui lòng nhập tên khách hàng");

      const { data: created, error: createError } = await (supabase as any)
        .from("mini_crm_customers")
        .insert({
          customer_name: trimmedName,
          customer_code: customerCode.trim() || null,
          customer_group: customerGroup,
          default_revenue_channel: defaultRevenueChannel.trim() || null,
        })
        .select("id")
        .single();

      if (createError) throw createError;

      const emails = emailsInput
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      if (emails.length) {
        const { error: emailError } = await (supabase as any)
          .from("mini_crm_customer_emails")
          .insert(emails.map((email, idx) => ({ customer_id: created.id, email, is_primary: idx === 0 })));
        if (emailError) throw emailError;
      }
    },
    onSuccess: async () => {
      setCustomerName("");
      setCustomerCode("");
      setDefaultRevenueChannel("");
      setEmailsInput("");
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] });
      toast({ title: "Đã thêm khách hàng", description: "Mini-CRM đã cập nhật." });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi", description: e?.message || "Không thể thêm khách hàng", variant: "destructive" });
    },
  });

  const syncGmailMutation = useMutation({
    mutationFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Phiên đăng nhập hết hạn");

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-gmail-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ maxResults: 30, query: "to:po@bmq.vn newer_than:14d" }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || "Gmail sync thất bại");
      return result;
    },
    onSuccess: async (result: any) => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      toast({ title: "Đã sync Gmail", description: `Đã đồng bộ ${result?.synced || 0} email PO.` });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi Gmail sync", description: e?.message || "Không thể đồng bộ Gmail", variant: "destructive" });
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "approved" | "rejected" }) => {
      const { error } = await (supabase as any)
        .from("customer_po_inbox")
        .update({ match_status: status, reviewed_at: new Date().toISOString(), review_note: status === "approved" ? "Manual approved" : "Manual rejected" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      toast({ title: "Đã cập nhật duyệt", description: "Trạng thái PO inbox đã đổi." });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi", description: e?.message || "Không thể cập nhật trạng thái", variant: "destructive" });
    },
  });

  const statusCounts = useMemo(() => {
    return poInbox.reduce(
      (acc: Record<string, number>, row: any) => {
        const key = row.match_status || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      {}
    );
  }, [poInbox]);

  const selectedPo = useMemo(() => poInbox.find((r: any) => r.id === selectedPoId) || null, [poInbox, selectedPoId]);

  useEffect(() => {
    if (!selectedPo) return;
    const items = Array.isArray(selectedPo.production_items)
      ? selectedPo.production_items
      : Array.isArray(selectedPo?.raw_payload?.parsed_items_preview)
        ? selectedPo.raw_payload.parsed_items_preview
        : [];
    const subtotal = Number(selectedPo.subtotal_amount || selectedPo?.raw_payload?.parse_meta?.subtotal || calcSubtotalFromItems(items) || 0);
    setPoSummaryDraft({
      po_number: selectedPo.po_number || extractPoNumberFromSubject(selectedPo.email_subject) || "",
      delivery_date: selectedPo.delivery_date || extractDeliveryDateFromSubject(selectedPo.email_subject) || "",
      subtotal_amount: subtotal || "",
      vat_amount: selectedPo.vat_amount || 0,
      total_amount: Number(selectedPo.total_amount || subtotal || 0) || "",
      production_items: items,
    });
  }, [selectedPo]);

  const parseAttachmentMutation = useMutation({
    mutationFn: async (inboxId: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Phiên đăng nhập hết hạn");
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-parse-inbox-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ inboxId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || "Parse attachment thất bại");
      return result;
    },
    onSuccess: async (result: any) => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      if (Array.isArray(result?.parsed?.items)) {
        const parsedItems = result.parsed.items;
        const subtotal = Number(result?.parsed?.subtotal || calcSubtotalFromItems(parsedItems) || 0);
        setPoSummaryDraft((s: any) => ({
          ...s,
          po_number: s?.po_number || extractPoNumberFromSubject(selectedPo?.email_subject),
          delivery_date: s?.delivery_date || extractDeliveryDateFromSubject(selectedPo?.email_subject),
          production_items: parsedItems,
          subtotal_amount: subtotal || s?.subtotal_amount,
          total_amount: subtotal || s?.total_amount,
        }));
      }
      toast({ title: "Đã parse file đính kèm", description: `${result?.parsed?.itemCount || 0} dòng sản phẩm` });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi parse file", description: e?.message || "Không parse được", variant: "destructive" });
    },
  });

  const savePoSummaryMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPoId) throw new Error("Chưa chọn PO");
      const payload = {
        po_number: poSummaryDraft.po_number || null,
        delivery_date: poSummaryDraft.delivery_date || null,
        subtotal_amount: Number(poSummaryDraft.subtotal_amount || 0) || null,
        vat_amount: Number(poSummaryDraft.vat_amount || 0) || null,
        total_amount: Number(poSummaryDraft.total_amount || 0) || null,
        production_items: poSummaryDraft.production_items || [],
      };
      const { error } = await (supabase as any).from("customer_po_inbox").update(payload).eq("id", selectedPoId);
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      toast({ title: "Đã lưu tóm tắt PO" });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi lưu PO", description: e?.message || "Không lưu được", variant: "destructive" });
    },
  });

  const postRevenueMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("customer_po_inbox")
        .update({ posted_to_revenue: true, posted_to_revenue_at: new Date().toISOString(), match_status: "approved" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      toast({ title: "Đã đánh dấu đẩy doanh thu" });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi đẩy doanh thu", description: e?.message || "Không thể cập nhật", variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-display font-bold">Mini-CRM & PO Inbox</h1>
          <p className="text-muted-foreground">Phase 4: nhận diện khách hàng qua email và duyệt tay PO từ hộp thư po@bmq.vn.</p>
          <p className="text-xs text-muted-foreground mt-1">Kết nối Gmail PO được cấu hình trong Settings.</p>
        </div>
        <div className="flex flex-col gap-2 items-end">
          {gmailConnectedEmail ? <Badge>{gmailConnectedEmail}</Badge> : <Badge variant="secondary">Chưa kết nối Gmail PO</Badge>}
          <Button onClick={() => syncGmailMutation.mutate()} disabled={syncGmailMutation.isPending || !gmailConnectedEmail}>
            {syncGmailMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Sync Gmail PO
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Tổng PO inbox</div><div className="text-xl font-semibold">{poInbox.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Pending approval</div><div className="text-xl font-semibold">{statusCounts.pending_approval || 0}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Approved</div><div className="text-xl font-semibold">{statusCounts.approved || 0}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Unmatched</div><div className="text-xl font-semibold">{statusCounts.unmatched || 0}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Thiết lập khách hàng mini-CRM</CardTitle>
          <CardDescription>Map email khách hàng để hệ thống tự nhận diện khi PO gửi vào po@bmq.vn.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Tên khách hàng</Label>
            <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Ví dụ: Đại lý Hòa Bình" />
          </div>
          <div className="space-y-2">
            <Label>Mã khách hàng</Label>
            <Input value={customerCode} onChange={(e) => setCustomerCode(e.target.value)} placeholder="VD: DL-HB" />
          </div>
          <div className="space-y-2">
            <Label>Nhóm khách hàng</Label>
            <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={customerGroup} onChange={(e) => setCustomerGroup(e.target.value)}>
              {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label>Revenue channel mặc định</Label>
            <Input value={defaultRevenueChannel} onChange={(e) => setDefaultRevenueChannel(e.target.value)} placeholder="VD: online_grab" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Email nhận diện (phân tách dấu phẩy)</Label>
            <Input value={emailsInput} onChange={(e) => setEmailsInput(e.target.value)} placeholder="buyer@agency.com, order@agency.com" />
          </div>
          <div className="md:col-span-2">
            <Button onClick={() => addCustomerMutation.mutate()} disabled={addCustomerMutation.isPending}>Thêm khách hàng</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách khách hàng</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên</TableHead>
                <TableHead>Nhóm</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Trạng thái</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell>{c.customer_name}</TableCell>
                  <TableCell>{c.customer_group}</TableCell>
                  <TableCell>{(c.mini_crm_customer_emails || []).map((e: any) => e.email).join(", ") || "-"}</TableCell>
                  <TableCell>{c.is_active ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>PO Inbox (manual approval bắt buộc)</CardTitle>
          <CardDescription>PO đọc từ email po@bmq.vn sẽ nằm ở đây trước khi duyệt tay.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Matched Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {poInbox.map((row: any) => (
                <TableRow key={row.id}>
                  <TableCell>{new Date(row.received_at).toLocaleString("vi-VN")}</TableCell>
                  <TableCell>{row.from_email}</TableCell>
                  <TableCell>{row.email_subject || "(no subject)"}</TableCell>
                  <TableCell>{row.mini_crm_customers?.customer_name || "Chưa match"}</TableCell>
                  <TableCell><Badge variant={row.match_status === "approved" ? "default" : "secondary"}>{row.match_status}</Badge></TableCell>
                  <TableCell className="space-x-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setSelectedPoId(row.id);
                        setPoSummaryDraft({
                          po_number: row.po_number || "",
                          delivery_date: row.delivery_date || "",
                          subtotal_amount: row.subtotal_amount || "",
                          vat_amount: row.vat_amount || "",
                          total_amount: row.total_amount || "",
                          production_items: Array.isArray(row.production_items) ? row.production_items : [],
                        });
                      }}
                    >
                      Xem nhanh
                    </Button>
                    <Button size="sm" onClick={() => reviewMutation.mutate({ id: row.id, status: "approved" })} disabled={reviewMutation.isPending || row.match_status === "approved"}>Approve</Button>
                    <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: row.id, status: "rejected" })} disabled={reviewMutation.isPending || row.match_status === "rejected"}>Reject</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedPo && (
        <Card>
          <CardHeader>
            <CardTitle>PO Quick View: {poSummaryDraft.po_number || selectedPo.po_number || selectedPo.email_subject}</CardTitle>
            <CardDescription>Giao diện xem nhanh cho Kế toán và Quản lí sản xuất (không cần mở email).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-muted-foreground">
              <div><b>From:</b> {selectedPo.from_email}</div>
              <div><b>Subject:</b> {selectedPo.email_subject}</div>
              <div><b>Nội dung nhanh:</b> {selectedPo.body_preview || "(trống)"}</div>
              <div><b>Attachments:</b> {(selectedPo.attachment_names || []).join(", ") || "Không có"}</div>
            </div>

            <Tabs defaultValue="accounting" className="w-full">
              <TabsList>
                <TabsTrigger value="accounting">Kế toán</TabsTrigger>
                <TabsTrigger value="production">QL Sản xuất</TabsTrigger>
              </TabsList>

              <TabsContent value="accounting" className="space-y-3 pt-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <Label>PO Number</Label>
                    <Input value={poSummaryDraft.po_number || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, po_number: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Ngày giao</Label>
                    <Input type="date" value={poSummaryDraft.delivery_date || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, delivery_date: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Tạm tính</Label>
                    <Input type="number" value={poSummaryDraft.subtotal_amount || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, subtotal_amount: e.target.value }))} />
                  </div>
                  <div>
                    <Label>VAT</Label>
                    <Input type="number" value={poSummaryDraft.vat_amount || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, vat_amount: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Tổng tiền đơn hàng</Label>
                    <Input type="number" value={poSummaryDraft.total_amount || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, total_amount: e.target.value }))} />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="production" className="space-y-3 pt-3">
                <div className="flex items-center justify-between">
                  <Label>Danh sách sản phẩm cho quản lí sản xuất</Label>
                  <div className="text-xs text-muted-foreground">
                    Tổng dòng: {Array.isArray(poSummaryDraft.production_items) ? poSummaryDraft.production_items.length : 0}
                  </div>
                </div>

                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Tên sản phẩm</TableHead>
                        <TableHead>ĐVT</TableHead>
                        <TableHead className="text-right">SL</TableHead>
                        <TableHead className="text-right">Đơn giá</TableHead>
                        <TableHead className="text-right">Thành tiền</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(Array.isArray(poSummaryDraft.production_items) ? poSummaryDraft.production_items : []).map((item: any, idx: number) => (
                        <TableRow key={`${item?.sku || "row"}-${idx}`}>
                          <TableCell>{item?.sku || "-"}</TableCell>
                          <TableCell>{item?.product_name || item?.name || "-"}</TableCell>
                          <TableCell>{item?.unit || "-"}</TableCell>
                          <TableCell className="text-right">{Number(item?.qty || item?.quantity || 0).toLocaleString("vi-VN")}</TableCell>
                          <TableCell className="text-right">{Number(item?.unit_price || 0).toLocaleString("vi-VN")}</TableCell>
                          <TableCell className="text-right">{Number(item?.line_total || 0).toLocaleString("vi-VN")}</TableCell>
                        </TableRow>
                      ))}
                      {(!Array.isArray(poSummaryDraft.production_items) || poSummaryDraft.production_items.length === 0) && (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                            Chưa có dữ liệu sản phẩm. Bấm "Parse từ file đính kèm" để lấy tự động.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => parseAttachmentMutation.mutate(selectedPo.id)} disabled={parseAttachmentMutation.isPending}>
                {parseAttachmentMutation.isPending ? "Đang parse..." : "Parse từ file đính kèm"}
              </Button>
              <Button onClick={() => savePoSummaryMutation.mutate()} disabled={savePoSummaryMutation.isPending}>Lưu tóm tắt PO</Button>
              <Button variant="outline" onClick={() => postRevenueMutation.mutate(selectedPo.id)} disabled={postRevenueMutation.isPending || selectedPo.posted_to_revenue}>
                {selectedPo.posted_to_revenue ? "Đã đẩy doanh thu" : "Đẩy sang kiểm soát doanh thu"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

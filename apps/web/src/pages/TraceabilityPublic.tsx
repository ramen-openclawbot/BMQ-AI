import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";

const sb = supabase as any;

export default function TraceabilityPublic() {
  const { token } = useParams();
  const [batch, setBatch] = useState<any>(null);
  const [materials, setMaterials] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const { data: b } = await sb
        .from("production_batches")
        .select("*, product_skus(*)")
        .eq("public_token", token)
        .maybeSingle();

      setBatch(b);
      if (!b) return;

      const [{ data: m }, { data: d }] = await Promise.all([
        sb.from("production_batch_materials").select("*").eq("batch_id", b.id).order("sort_order"),
        sb.from("sku_trace_documents").select("*").eq("sku_id", b.sku_id).order("created_at", { ascending: false }),
      ]);

      setMaterials(m || []);
      setDocs(d || []);
    })();
  }, [token]);

  if (!batch) {
    return <div className="min-h-screen flex items-center justify-center">Không tìm thấy dữ liệu truy xuất.</div>;
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-bold">Báo cáo truy xuất lô hàng</h1>

      <Card>
        <CardHeader><CardTitle>Thông tin lô</CardTitle></CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-3 text-sm">
          <div><b>Mã lô:</b> {batch.batch_code}</div>
          <div><b>Sản phẩm:</b> {batch.product_skus?.sku_code} - {batch.product_skus?.product_name}</div>
          <div><b>NSX:</b> {batch.production_date}</div>
          <div><b>HSD:</b> {batch.expiry_date || "-"}</div>
          <div><b>Mã vỏ:</b> {batch.shell_code || "-"}</div>
          <div><b>Mã thành phẩm:</b> {batch.finished_code || "-"}</div>
          <div><b>Mã nhân/sốt:</b> {batch.filling_sauce_code || "-"}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Nguyên liệu và mã lô NVL</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nhóm</TableHead>
                <TableHead>Tên</TableHead>
                <TableHead>Mã vật tư</TableHead>
                <TableHead>Mã lô NVL</TableHead>
                <TableHead>Số lượng</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {materials.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.material_group}</TableCell>
                  <TableCell>{m.material_name}</TableCell>
                  <TableCell>{m.material_code || "-"}</TableCell>
                  <TableCell>{m.material_batch_code || "-"}</TableCell>
                  <TableCell>{m.quantity} {m.unit}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Hồ sơ đính kèm</CardTitle></CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-3">
          {docs.map((d) => (
            <a key={d.id} href={d.document_url} target="_blank" rel="noreferrer" className="border rounded p-3 hover:bg-muted text-sm">
              <div className="font-medium">{d.document_name}</div>
              <div className="text-muted-foreground">{d.document_type}</div>
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

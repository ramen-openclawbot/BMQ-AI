import { useEffect, useMemo, useState } from "react";
import { Building2, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSuppliers } from "@/hooks/useSuppliers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type SupplierAlias = {
  id: string;
  supplier_id: string;
  alias_text: string;
  alias_key: string;
  active: boolean;
  created_at: string;
};

const normalizeText = (v: string) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function SupplierAliasManager() {
  const { data: suppliers } = useSuppliers();
  const [aliases, setAliases] = useState<SupplierAlias[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newSupplierId, setNewSupplierId] = useState("");
  const [newAliasText, setNewAliasText] = useState("");

  const supplierMap = useMemo(() => new Map((suppliers || []).map((s) => [s.id, s.name])), [suppliers]);

  const fetchAliases = async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("supplier_aliases")
        .select("id,supplier_id,alias_text,alias_key,active,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setAliases((data || []) as SupplierAlias[]);
    } catch (error: any) {
      toast.error(error?.message || "Không tải được danh sách alias NCC");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAliases();
  }, []);

  const handleCreate = async () => {
    if (!newSupplierId || !newAliasText.trim()) {
      toast.error("Vui lòng chọn NCC và nhập alias");
      return;
    }

    const aliasKey = normalizeText(newAliasText);
    const duplicated = aliases.find((a) => a.alias_key === aliasKey);
    if (duplicated) {
      toast.error("Alias này đã tồn tại");
      return;
    }

    setCreating(true);
    try {
      const { error } = await (supabase as any)
        .from("supplier_aliases")
        .insert({
          supplier_id: newSupplierId,
          alias_text: newAliasText.trim(),
          alias_key: aliasKey,
          active: true,
        });
      if (error) throw error;
      setNewAliasText("");
      toast.success("Đã thêm alias NCC");
      await fetchAliases();
    } catch (error: any) {
      toast.error(error?.message || "Không thể thêm alias NCC");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (alias: SupplierAlias, active: boolean) => {
    try {
      const { error } = await (supabase as any)
        .from("supplier_aliases")
        .update({ active })
        .eq("id", alias.id);
      if (error) throw error;
      setAliases((prev) => prev.map((x) => (x.id === alias.id ? { ...x, active } : x)));
    } catch (error: any) {
      toast.error(error?.message || "Không cập nhật được trạng thái alias");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await (supabase as any)
        .from("supplier_aliases")
        .delete()
        .eq("id", id);
      if (error) throw error;
      setAliases((prev) => prev.filter((x) => x.id !== id));
      toast.success("Đã xoá alias");
    } catch (error: any) {
      toast.error(error?.message || "Không xoá được alias");
    }
  };

  return (
    <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Building2 className="h-5 w-5 text-primary" />
        <h2 className="font-display font-semibold text-lg">NCC Alias Manager</h2>
      </div>
      <Separator />

      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
        <div>
          <Label>Nhà cung cấp chuẩn</Label>
          <Select value={newSupplierId} onValueChange={setNewSupplierId}>
            <SelectTrigger>
              <SelectValue placeholder="Chọn NCC" />
            </SelectTrigger>
            <SelectContent>
              {(suppliers || []).map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Tên alias trên phiếu (OCR)</Label>
          <Input value={newAliasText} onChange={(e) => setNewAliasText(e.target.value)} placeholder="Ví dụ: STC, Cty TNHH TP STC" />
        </div>
        <div className="flex items-end">
          <Button onClick={handleCreate} disabled={creating}>
            <Plus className="h-4 w-4 mr-1" /> Thêm alias
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {(loading ? [] : aliases).map((a) => (
          <div key={a.id} className="rounded-md border p-3 flex items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="font-medium">{a.alias_text}</div>
              <div className="text-xs text-muted-foreground">{supplierMap.get(a.supplier_id) || a.supplier_id}</div>
              <div className="text-xs text-muted-foreground">key: {a.alias_key}</div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={a.active ? "secondary" : "outline"}>{a.active ? "active" : "inactive"}</Badge>
              <Button size="sm" variant="outline" onClick={() => handleToggleActive(a, !a.active)}>
                {a.active ? "Tắt" : "Bật"}
              </Button>
              <Button size="icon" variant="ghost" onClick={() => handleDelete(a.id)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </div>
        ))}

        {!loading && aliases.length === 0 && (
          <div className="text-sm text-muted-foreground">Chưa có alias nào.</div>
        )}
      </div>
    </div>
  );
}

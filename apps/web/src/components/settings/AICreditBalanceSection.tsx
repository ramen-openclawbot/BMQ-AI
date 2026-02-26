import { useEffect, useState } from "react";
import { Wallet, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";

type CreditState = {
  provider?: string;
  status?: string;
  currency?: string;
  total_available?: number;
  total_used?: number;
  total_granted?: number;
  message?: string;
  fetched_at?: string;
};

export function AICreditBalanceSection() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CreditState | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("get-ai-credit-balance", { method: "GET" });
      if (error) throw error;
      setData(data || null);
    } catch (e: any) {
      setData({ status: "error", message: e?.message || "Không lấy được thông tin credit" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const provider = (data?.provider || "openai").toUpperCase();

  return (
    <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Wallet className="h-5 w-5 text-primary" />
        <h2 className="font-display font-semibold text-lg">AI API Credit</h2>
      </div>
      <Separator />

      <div className="space-y-2 text-sm">
        <p><span className="text-muted-foreground">Provider:</span> <strong>{provider}</strong></p>

        {data?.status === "ok" ? (
          <>
            <p><span className="text-muted-foreground">Available:</span> <strong>{data.total_available?.toFixed(2)} {data.currency || "USD"}</strong></p>
            <p><span className="text-muted-foreground">Used:</span> {data.total_used?.toFixed(2)} {data.currency || "USD"}</p>
            <p><span className="text-muted-foreground">Granted:</span> {data.total_granted?.toFixed(2)} {data.currency || "USD"}</p>
          </>
        ) : (
          <p className="text-muted-foreground">{data?.message || "Chưa có dữ liệu credit."}</p>
        )}

        {data?.fetched_at && (
          <p className="text-xs text-muted-foreground">Cập nhật: {new Date(data.fetched_at).toLocaleString("vi-VN")}</p>
        )}
      </div>

      <Button variant="outline" onClick={load} disabled={loading}>
        <RefreshCw className="h-4 w-4 mr-2" />
        {loading ? "Đang tải..." : "Làm mới"}
      </Button>
    </div>
  );
}

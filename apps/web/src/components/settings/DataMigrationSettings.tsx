import { useEffect, useState } from "react";
import {
  Archive,
  Database,
  Download,
  FileJson,
  FileText,
  FolderArchive,
  HardDrive,
  ListChecks,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type ExportFormat = "schema" | "json" | "sql";

const TABLES = [
  "profiles",
  "user_roles",
  "suppliers",
  "inventory_items",
  "inventory_batches",
  "product_skus",
  "purchase_orders",
  "purchase_order_items",
  "goods_receipts",
  "goods_receipt_items",
  "orders",
  "order_items",
  "payment_requests",
  "payment_request_items",
  "invoices",
  "invoice_items",
  "app_settings",
  "drive_sync_config",
  "drive_file_index",
  "drive_import_logs",
] as const;

const IMPORT_STEPS = [
  "Chạy migrations để tạo schema trước khi nạp dữ liệu.",
  "Tạo đầy đủ buckets storage cần thiết ở môi trường đích.",
  "Import storage-manifest.json để khôi phục đúng bucket/path cho từng file.",
  "Upload file ZIP theo đúng cấu trúc bucket/path đã export.",
  "Import SQL hoặc JSON theo đúng thứ tự phụ thuộc.",
  "Đối soát manifest, số object và checksum để xác minh toàn vẹn.",
];

function downloadTextFile(fileName: string, content: string, contentType = "application/json") {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function fetchTableRows(table: string) {
  const pageSize = 1000;
  let from = 0;
  let allRows: Record<string, any>[] = [];

  while (true) {
    const { data, error } = await (supabase as any)
      .from(table)
      .select("*")
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`${table}: ${error.message}`);

    const rows = (data || []) as Record<string, any>[];
    allRows = allRows.concat(rows);

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

function toSqlLiteral(value: any): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function DataMigrationSettings() {
  const { toast } = useToast();
  const [busyFormat, setBusyFormat] = useState<ExportFormat | "manifest" | "zip" | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [bucketFilter, setBucketFilter] = useState("");
  const [maxFiles, setMaxFiles] = useState("1000");
  const [zipProgress, setZipProgress] = useState<number | null>(null);
  const [zipProgressText, setZipProgressText] = useState("");

  const canExport = isOwner && busyFormat === null;

  useEffect(() => {
    const init = async () => {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth?.user?.id;
      if (!userId) return;

      const { data: roleRows, error } = await (supabase as any)
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .limit(10);

      if (error) {
        console.warn("[DataMigration] Không đọc được user_roles", error.message);
        setIsOwner(false);
        return;
      }

      const owner = (roleRows || []).some((r: any) => r.role === "owner");
      setIsOwner(owner);
    };

    init();
  }, []);

  const exportDatabase = async (format: ExportFormat) => {
    if (!isOwner) {
      toast({
        title: "Không đủ quyền",
        description: "Chỉ owner mới có thể export dữ liệu.",
        variant: "destructive",
      });
      return;
    }

    try {
      setBusyFormat(format);
      const now = new Date().toISOString();

      if (format === "schema") {
        const schemaSnapshot = {
          generatedAt: now,
          source: "supabase-client",
          tables: TABLES,
          note: "Schema chi tiết (constraints/index/RLS) nên lấy qua endpoint backend: /api/migration/export/schema",
        };

        downloadTextFile(`bmq-schema-${Date.now()}.json`, JSON.stringify(schemaSnapshot, null, 2));
      }

      if (format === "json") {
        const tableData: Record<string, Record<string, any>[]> = {};

        for (const table of TABLES) {
          tableData[table] = await fetchTableRows(table);
        }

        const jsonSnapshot = {
          generatedAt: now,
          tables: tableData,
        };

        downloadTextFile(`bmq-data-${Date.now()}.json`, JSON.stringify(jsonSnapshot, null, 2));
      }

      if (format === "sql") {
        let sql = `-- BMQ data export\n-- Generated at ${now}\n\nBEGIN;\n\n`;

        for (const table of TABLES) {
          const rows = await fetchTableRows(table);
          if (!rows.length) continue;

          const columns = Object.keys(rows[0]);
          sql += `-- Table: ${table}\n`;

          for (const row of rows) {
            const values = columns.map((col) => toSqlLiteral(row[col]));
            sql += `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")});\n`;
          }

          sql += "\n";
        }

        sql += "COMMIT;\n";
        downloadTextFile(`bmq-data-${Date.now()}.sql`, sql, "text/sql");
      }

      toast({
        title: "Đã tạo file export",
        description: "Export hoàn tất.",
      });
    } catch (error: any) {
      toast({
        title: "Export thất bại",
        description: error?.message || "Không thể tạo file export.",
        variant: "destructive",
      });
    } finally {
      setBusyFormat(null);
    }
  };

  const generateManifest = async () => {
    if (!isOwner) {
      toast({
        title: "Không đủ quyền",
        description: "Chỉ owner mới có thể export dữ liệu.",
        variant: "destructive",
      });
      return;
    }

    try {
      setBusyFormat("manifest");

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");

      const bucketIds = bucketFilter
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const { data, error } = await supabase.functions.invoke("migration-storage-manifest", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: {
          bucketIds: bucketIds.length ? bucketIds : undefined,
        },
      });

      if (error) {
        throw new Error(error.message || "Không thể tạo storage manifest.");
      }

      downloadTextFile("storage-manifest.json", JSON.stringify(data, null, 2));
      toast({
        title: "Đã tạo manifest",
        description: "storage-manifest.json đã sẵn sàng.",
      });
    } catch (error: any) {
      toast({
        title: "Tạo manifest thất bại",
        description: error?.message || "Không thể tạo storage manifest.",
        variant: "destructive",
      });
    } finally {
      setBusyFormat(null);
    }
  };

  const exportFilesZip = async () => {
    if (!isOwner) {
      toast({
        title: "Không đủ quyền",
        description: "Chỉ owner mới có thể export dữ liệu.",
        variant: "destructive",
      });
      return;
    }

    try {
      setBusyFormat("zip");
      setZipProgress(0);
      setZipProgressText("Đang chuẩn bị tải ZIP...");

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");

      const bucketIds = bucketFilter
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedMaxFiles = Number(maxFiles || "0") || undefined;

      const functionUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/migration-storage-archive`;
      const resp = await fetch(functionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bucketIds: bucketIds.length ? bucketIds : undefined,
          maxFiles: parsedMaxFiles,
        }),
      });

      if (!resp.ok) {
        let errMsg = `Tải ZIP thất bại (HTTP ${resp.status})`;
        try {
          const errJson = await resp.json();
          errMsg = errJson?.error || errMsg;
        } catch {
          // ignore json parse errors
        }
        throw new Error(errMsg);
      }

      const contentDisposition = resp.headers.get("Content-Disposition") || "";
      const match = contentDisposition.match(/filename="?([^\"]+)"?/i);
      const filename = match?.[1] || `bmq-storage-archive-${Date.now()}.zip`;

      const totalBytes = Number(resp.headers.get("Content-Length") || 0);
      const reader = resp.body?.getReader();

      let blob: Blob;
      if (!reader) {
        blob = await resp.blob();
        setZipProgress(100);
        setZipProgressText("Tải hoàn tất.");
      } else {
        const chunks: Uint8Array[] = [];
        let receivedBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          chunks.push(value);
          receivedBytes += value.length;

          if (totalBytes > 0) {
            const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
            setZipProgress(percent);
            setZipProgressText(`Đã tải ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`);
          } else {
            setZipProgress(null);
            setZipProgressText(`Đã tải ${formatBytes(receivedBytes)}...`);
          }
        }

        blob = new Blob(chunks, { type: "application/zip" });
        setZipProgress(100);
        setZipProgressText("Tải hoàn tất.");
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast({
        title: "Đã tạo ZIP storage",
        description: "File ZIP đang được tải về máy của anh.",
      });
    } catch (error: any) {
      toast({
        title: "Tạo ZIP thất bại",
        description: error?.message || "Không thể export storage ZIP.",
        variant: "destructive",
      });
    } finally {
      setBusyFormat(null);
      setTimeout(() => {
        setZipProgress(null);
        setZipProgressText("");
      }, 1200);
    }
  };

  return (
    <div id="data-migration" className="card-elevated rounded-xl border border-border p-6 space-y-5 scroll-mt-24">
      <div className="flex items-center gap-3">
        <Archive className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-display font-semibold text-lg">Data Migration</h2>
          <p className="text-sm text-muted-foreground">Xuất dữ liệu và storage theo chuẩn migration-safe để backup/chuyển môi trường.</p>
        </div>
      </div>

      <Separator />

      {!isOwner && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 p-3 text-sm">
          Chỉ tài khoản role <strong>owner</strong> mới có quyền export dữ liệu.
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <p className="font-medium">Export Database</p>
        </div>
        <div className="grid sm:grid-cols-3 gap-2">
          <Button variant="outline" onClick={() => exportDatabase("schema")} disabled={!canExport}>
            <FileText className="h-4 w-4 mr-2" />
            {busyFormat === "schema" ? "Đang tạo..." : "Download Schema"}
          </Button>
          <Button variant="outline" onClick={() => exportDatabase("json")} disabled={!canExport}>
            <FileJson className="h-4 w-4 mr-2" />
            {busyFormat === "json" ? "Đang tạo..." : "Download JSON"}
          </Button>
          <Button variant="outline" onClick={() => exportDatabase("sql")} disabled={!canExport}>
            <Download className="h-4 w-4 mr-2" />
            {busyFormat === "sql" ? "Đang tạo..." : "Download SQL"}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-primary" />
          <p className="font-medium">Export Storage</p>
        </div>
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Chuẩn export hiện tại</p>
          <p>Manifest lấy từ <code>supabase.storage</code>.</p>
          <p>ZIP giữ nguyên cấu trúc <code>bucket/path</code> để phục vụ restore chính xác.</p>
          <p>Mỗi file trong manifest gồm bucket, path, contentType, size, checksum và timestamps.</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Bucket filter (tuỳ chọn)</p>
            <Input
              value={bucketFilter}
              onChange={(e) => setBucketFilter(e.target.value)}
              placeholder="vd: invoices,purchase-orders"
            />
            <p className="text-xs text-muted-foreground">Để trống = export tất cả buckets.</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Max files cho ZIP</p>
            <Input
              value={maxFiles}
              onChange={(e) => setMaxFiles(e.target.value)}
              inputMode="numeric"
              placeholder="1000"
            />
            <p className="text-xs text-muted-foreground">Giảm số này nếu archive quá lớn hoặc timeout.</p>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          <Button variant="outline" onClick={generateManifest} disabled={!canExport}>
            <ListChecks className="h-4 w-4 mr-2" />
            {busyFormat === "manifest" ? "Đang tạo..." : "Generate Manifest"}
          </Button>
          <Button variant="outline" onClick={exportFilesZip} disabled={!isOwner || busyFormat !== null}>
            <FolderArchive className="h-4 w-4 mr-2" />
            {busyFormat === "zip"
              ? zipProgress !== null
                ? `Đang tải ZIP (${zipProgress}%)`
                : "Đang tải ZIP..."
              : "Download Files ZIP"}
          </Button>
        </div>

        {(busyFormat === "zip" || zipProgressText) && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{zipProgressText || "Đang tải ZIP..."}</span>
              {zipProgress !== null && <span className="font-medium text-foreground">{zipProgress}%</span>}
            </div>
            {zipProgress !== null ? (
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${zipProgress}%` }}
                />
              </div>
            ) : (
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-1/3 animate-pulse bg-primary/60" />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border p-4 space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <p className="font-medium">Guardrails khuyến nghị</p>
        </div>
        <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
          <li>Chỉ cho phép role owner thao tác export.</li>
          <li>Luôn export manifest trước khi tải ZIP để có mapping bucket/path.</li>
          <li>Giữ nguyên cấu trúc bucket/path khi restore sang môi trường mới.</li>
          <li>Đối soát checksum sau import để xác minh toàn vẹn file.</li>
          <li>Với archive lớn, cân nhắc tách batch thay vì 1 ZIP duy nhất.</li>
        </ul>
      </div>

      <div className="rounded-lg border p-4 space-y-2">
        <p className="font-medium">Import Guide</p>
        <ol className="list-decimal pl-5 text-sm text-muted-foreground space-y-1">
          {IMPORT_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

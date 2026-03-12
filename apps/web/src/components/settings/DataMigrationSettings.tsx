import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Database,
  Download,
  FileJson,
  FileText,
  FolderArchive,
  HardDrive,
  ListChecks,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type ExportFormat = "schema" | "json" | "sql";

interface MigrationSummary {
  tables: number;
  records: number;
  files: number;
  totalSizeMb: number;
  imageFiles: number;
  imageSizeMb: number;
}

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
  "Tạo đầy đủ buckets storage cần thiết.",
  "Upload files theo storage manifest (giữ nguyên bucket/path).",
  "Import SQL hoặc JSON theo đúng thứ tự phụ thuộc.",
  "Đối soát record count + checksum để xác minh toàn vẹn.",
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

  const text =
    typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

  return `'${text.replace(/'/g, "''")}'`;
}

export function DataMigrationSettings() {
  const { toast } = useToast();
  const [busyFormat, setBusyFormat] = useState<ExportFormat | "manifest" | "zip" | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [summary, setSummary] = useState<MigrationSummary>({
    tables: TABLES.length,
    records: 0,
    files: 0,
    totalSizeMb: 0,
    imageFiles: 0,
    imageSizeMb: 0,
  });

  const canExport = useMemo(() => isOwner && busyFormat === null, [isOwner, busyFormat]);

  const fetchSummary = async () => {
    setLoadingSummary(true);
    try {
      const countPromises = TABLES.map(async (table) => {
        const { count, error } = await (supabase as any)
          .from(table)
          .select("*", { count: "exact", head: true });

        if (error) {
          console.warn(`[DataMigration] count failed for ${table}:`, error.message);
          return 0;
        }
        return count || 0;
      });

      const counts = await Promise.all(countPromises);
      const records = counts.reduce((sum, c) => sum + c, 0);

      const { count: filesCount } = await (supabase as any)
        .from("drive_file_index")
        .select("id", { count: "exact", head: true });

      const { data: fileSizeRows } = await (supabase as any)
        .from("drive_file_index")
        .select("file_size,mime_type,file_name")
        .not("file_size", "is", null)
        .limit(50000);

      const rows = (fileSizeRows || []) as Array<{ file_size: number | null; mime_type: string | null; file_name: string | null }>;
      const imageExts = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "tif", "tiff", "avif"]);
      const isImageRow = (row: { mime_type: string | null; file_name: string | null }) => {
        const mime = String(row?.mime_type || "").toLowerCase();
        if (mime.startsWith("image/")) return true;

        const name = String(row?.file_name || "").toLowerCase();
        const ext = name.includes(".") ? name.split(".").pop() || "" : "";
        return imageExts.has(ext);
      };

      const totalFileBytes = rows.reduce((sum: number, row) => sum + Number(row.file_size || 0), 0);
      const imageFileRows = rows.filter((row) => isImageRow(row));
      const imageFileBytes = imageFileRows.reduce((sum: number, row) => sum + Number(row.file_size || 0), 0);

      const estimatedDbBytes = records * 600;
      const estimatedTotalMb = (totalFileBytes + estimatedDbBytes) / (1024 * 1024);

      setSummary({
        tables: TABLES.length,
        records,
        files: filesCount || 0,
        totalSizeMb: Number(estimatedTotalMb.toFixed(1)),
        imageFiles: imageFileRows.length,
        imageSizeMb: Number((imageFileBytes / (1024 * 1024)).toFixed(1)),
      });
    } catch (error: any) {
      toast({
        title: "Không tải được thống kê migration",
        description: error?.message || "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setLoadingSummary(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth?.user?.id;
      if (!userId) return;

      // Nếu hệ thống chưa cấu hình phân quyền user_roles thì mặc định cho phép tài khoản đã đăng nhập sử dụng migration.
      // Khi bảng role đã có dữ liệu, chỉ owner mới được phép.
      const { data: roleRows, error } = await (supabase as any)
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .limit(10);

      if (error) {
        console.warn("[DataMigration] Không đọc được user_roles, fallback allow logged-in user", error.message);
        setIsOwner(true);
        await fetchSummary();
        return;
      }

      if (!roleRows || roleRows.length === 0) {
        setIsOwner(true);
        await fetchSummary();
        return;
      }

      const owner = roleRows.some((r: any) => r.role === "owner");
      setIsOwner(owner);

      if (owner) {
        await fetchSummary();
      }
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

      const { data, error } = await (supabase as any)
        .from("drive_file_index")
        .select("file_id,file_name,file_size,mime_type,folder_type,folder_date,parent_folder_id")
        .limit(50000);

      if (error) throw error;

      const manifest = {
        generatedAt: new Date().toISOString(),
        source: "drive_file_index",
        files: (data || []).map((item: any) => ({
          provider: "google-drive",
          fileId: item.file_id,
          fileName: item.file_name,
          size: item.file_size,
          mimeType: item.mime_type,
          folderType: item.folder_type,
          folderDate: item.folder_date,
          parentFolderId: item.parent_folder_id,
        })),
      };

      downloadTextFile("storage-manifest.json", JSON.stringify(manifest, null, 2));
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

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");

      const functionUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/migration-storage-archive`;
      const resp = await fetch(functionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderType: "all" }),
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

      const blob = await resp.blob();
      const contentDisposition = resp.headers.get("Content-Disposition") || "";
      const match = contentDisposition.match(/filename="?([^\"]+)"?/i);
      const filename = match?.[1] || `bmq-storage-archive-${Date.now()}.zip`;

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
    }
  };

  return (
    <div id="data-migration" className="card-elevated rounded-xl border border-border p-6 space-y-5 scroll-mt-24">
      <div className="flex items-center gap-3">
        <Archive className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-display font-semibold text-lg">Data Migration</h2>
          <p className="text-sm text-muted-foreground">Xuất dữ liệu và storage để backup/chuyển môi trường an toàn.</p>
        </div>
      </div>

      <Separator />

      {!isOwner && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 p-3 text-sm">
          Chỉ tài khoản role <strong>owner</strong> mới có quyền export dữ liệu.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Tables</p>
          <p className="text-lg font-semibold">{summary.tables}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Records</p>
          <p className="text-lg font-semibold">{summary.records.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Files</p>
          <p className="text-lg font-semibold">{summary.files.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Estimated size</p>
          <p className="text-lg font-semibold">{summary.totalSizeMb.toFixed(1)} MB</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Image files</p>
          <p className="text-lg font-semibold">{summary.imageFiles.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Image size</p>
          <p className="text-lg font-semibold">{summary.imageSizeMb.toFixed(1)} MB</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Estimated size = dữ liệu DB ước tính + toàn bộ file trong drive_file_index. Image size tính theo mime_type image/* và fallback theo đuôi file ảnh (jpg/png/webp/heic...).
      </p>

      <div className="flex justify-end">
        <Button variant="outline" disabled={!isOwner || loadingSummary} onClick={fetchSummary}>
          {loadingSummary ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Làm mới thống kê
        </Button>
      </div>

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
        <div className="grid sm:grid-cols-2 gap-2">
          <Button variant="outline" onClick={generateManifest} disabled={!canExport}>
            <ListChecks className="h-4 w-4 mr-2" />
            {busyFormat === "manifest" ? "Đang tạo..." : "Generate Manifest"}
          </Button>
          <Button variant="outline" onClick={exportFilesZip} disabled={!isOwner || busyFormat !== null}>
            <FolderArchive className="h-4 w-4 mr-2" />
            {busyFormat === "zip" ? "Đang nén..." : "Download Files ZIP"}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border p-4 space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <p className="font-medium">Guardrails khuyến nghị</p>
        </div>
        <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
          <li>Chỉ cho phép role owner/admin thao tác export.</li>
          <li>Mask hoặc loại bỏ dữ liệu nhạy cảm (PII) trước khi tải.</li>
          <li>Ghi audit log: người export, thời điểm, loại dữ liệu.</li>
          <li>Áp checksum SHA256 cho từng file và toàn bộ gói backup.</li>
          <li>Giới hạn dung lượng/timeout và có retry cho job lớn.</li>
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

      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">API contract khuyến nghị (backend)</p>
        <p>GET /api/migration/summary</p>
        <p>POST /api/migration/export/schema</p>
        <p>POST /api/migration/export/json</p>
        <p>POST /api/migration/export/sql</p>
        <p>POST /api/migration/storage/manifest</p>
        <p>POST /api/migration/storage/archive</p>
      </div>
    </div>
  );
}

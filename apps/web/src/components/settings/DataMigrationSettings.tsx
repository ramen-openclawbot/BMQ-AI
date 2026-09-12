import type { PeopleKey } from "@/i18n/people";
import { PeopleLocalError, peopleErrorDescription, peopleSupabaseErrorDescription, peopleToast, showPeopleToast, usePeopleCopy } from "@/hooks/usePeopleCopy";
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
import { supabase } from "@/integrations/supabase/client";
import { getFreshAccessToken } from "@/lib/supabase-helpers";

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

    if (error) {
      if (typeof error.message === "string" && error.message.trim()) throw error;
      throw new PeopleLocalError({ key: "unableToCreateTheExportFile" });
    }

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
  const pc = usePeopleCopy();

  const IMPORT_STEPS = [
  pc("runMigrationsToCreateTheSchemaBefore"),
  pc("createAllRequiredStorageBucketsInThe"),
  pc("importStorageManifestJsonToRestoreThe"),
  pc("uploadTheZipUsingTheExportedBucket"),
  pc("importSqlOrJsonInDependencyOrder"),
  pc("reconcileTheManifestObjectCountsAndChecksums"),
];
  const [busyFormat, setBusyFormat] = useState<ExportFormat | "manifest" | "zip" | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [bucketFilter, setBucketFilter] = useState("");
  const [maxFiles, setMaxFiles] = useState("1000");
  const [zipProgress, setZipProgress] = useState<number | null>(null);
  const [zipProgressText, setZipProgressText] = useState<{ key: PeopleKey; values?: Record<string, string | number> } | null>(null);

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
      showPeopleToast("error", peopleToast("insufficientPermissions"), {
        description: peopleToast("onlyOwnersCanExportData"),
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

      showPeopleToast("success", peopleToast("exportFileCreated"), {
        description: peopleToast("exportComplete"),
      });
    } catch (error: any) {
      showPeopleToast("error", peopleToast("exportFailed"), {
        description: peopleErrorDescription(error, "unableToCreateTheExportFile"),
      });
    } finally {
      setBusyFormat(null);
    }
  };

  const generateManifest = async () => {
    if (!isOwner) {
      showPeopleToast("error", peopleToast("insufficientPermissions"), {
        description: peopleToast("onlyOwnersCanExportData"),
      });
      return;
    }

    try {
      setBusyFormat("manifest");

      const accessToken = await getFreshAccessToken();

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
        if (typeof error.message === "string" && error.message.trim()) throw error;
        throw new PeopleLocalError({ key: "unableToCreateTheStorageManifest" });
      }

      downloadTextFile("storage-manifest.json", JSON.stringify(data, null, 2));
      showPeopleToast("success", peopleToast("manifestCreated"), {
        description: peopleToast("storageManifestJsonIsReady"),
      });
    } catch (error: any) {
      showPeopleToast("error", peopleToast("manifestCreationFailed"), {
        description: peopleSupabaseErrorDescription(error, "unableToCreateTheStorageManifest"),
      });
    } finally {
      setBusyFormat(null);
    }
  };

  const exportFilesZip = async () => {
    if (!isOwner) {
      showPeopleToast("error", peopleToast("insufficientPermissions"), {
        description: peopleToast("onlyOwnersCanExportData"),
      });
      return;
    }

    try {
      setBusyFormat("zip");
      setZipProgress(0);
      setZipProgressText({ key: "preparingZipDownload" });

      const accessToken = await getFreshAccessToken();

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
        let failure: Error = new PeopleLocalError(
          { key: "zipDownloadFailedHttp", values: { p0: resp.status } },
        );
        try {
          const errJson = await resp.json();
          if (typeof errJson?.error === "string" && errJson.error.trim()) failure = new Error(errJson.error);
        } catch {
          // ignore json parse errors
        }
        throw failure;
      }

      const contentDisposition = resp.headers.get("Content-Disposition") || "";
      const match = contentDisposition.match(/filename="?([^";]+)"?/i);
      const filename = match?.[1] || `bmq-storage-archive-${Date.now()}.zip`;

      const totalBytes = Number(resp.headers.get("Content-Length") || 0);
      const reader = resp.body?.getReader();

      let blob: Blob;
      if (!reader) {
        blob = await resp.blob();
        setZipProgress(100);
        setZipProgressText({ key: "downloadComplete" });
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
            setZipProgressText({ key: "downloaded", values: { p0: formatBytes(receivedBytes), p1: formatBytes(totalBytes) } });
          } else {
            setZipProgress(null);
            setZipProgressText({ key: "downloaded2", values: { p0: formatBytes(receivedBytes) } });
          }
        }

        blob = new Blob(chunks, { type: "application/zip" });
        setZipProgress(100);
        setZipProgressText({ key: "downloadComplete" });
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      showPeopleToast("success", peopleToast("storageZipCreated"), {
        description: peopleToast("theZipFileIsDownloadingToYour"),
      });
    } catch (error: any) {
      showPeopleToast("error", peopleToast("zipCreationFailed"), {
        description: peopleSupabaseErrorDescription(error, "unableToExportTheStorageZip"),
      });
    } finally {
      setBusyFormat(null);
      setTimeout(() => {
        setZipProgress(null);
        setZipProgressText(null);
      }, 1200);
    }
  };

  return (
    <div id="data-migration" className="card-elevated rounded-xl border border-border p-6 space-y-5 scroll-mt-24">
      <div className="flex items-center gap-3">
        <Archive className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-display font-semibold text-lg">{pc("dataMigration2")}</h2>
          <p className="text-sm text-muted-foreground">{pc("exportDataAndStorageForBackupOr")}</p>
        </div>
      </div>

      <Separator />

      {!isOwner && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 p-3 text-sm"> {pc("onlyAccountsWithThe")} <strong>owner</strong> {pc("roleCanExportData")} </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <p className="font-medium">{pc("exportDatabase")}</p>
        </div>
        <div className="grid sm:grid-cols-3 gap-2">
          <Button variant="outline" onClick={() => exportDatabase("schema")} disabled={!canExport}>
            <FileText className="h-4 w-4 mr-2" />
            {busyFormat === "schema" ? pc("generating") : pc("downloadSchema")}
          </Button>
          <Button variant="outline" onClick={() => exportDatabase("json")} disabled={!canExport}>
            <FileJson className="h-4 w-4 mr-2" />
            {busyFormat === "json" ? pc("generating") : pc("downloadJson")}
          </Button>
          <Button variant="outline" onClick={() => exportDatabase("sql")} disabled={!canExport}>
            <Download className="h-4 w-4 mr-2" />
            {busyFormat === "sql" ? pc("generating") : pc("downloadSql")}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-primary" />
          <p className="font-medium">{pc("exportStorage")}</p>
        </div>
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">{pc("currentExportFormat")}</p>
          <p>{pc("theManifestComesFrom")} <code>supabase.storage</code>.</p>
          <p>{pc("theZipPreservesThe")} <code>bucket/path</code> {pc("structureForAccurateRestoration")}</p>
          <p>{pc("eachManifestFileIncludesBucketPathContenttype")}</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{pc("bucketFilterOptional")}</p>
            <Input
              value={bucketFilter}
              onChange={(e) => setBucketFilter(e.target.value)}
              placeholder={pc("eGInvoicesPurchaseOrders")}
            />
            <p className="text-xs text-muted-foreground">{pc("leaveBlankToExportAllBuckets")}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{pc("maximumFilesPerZip")}</p>
            <Input
              value={maxFiles}
              onChange={(e) => setMaxFiles(e.target.value)}
              inputMode="numeric"
              placeholder="1000"
            />
            <p className="text-xs text-muted-foreground">{pc("reduceThisIfTheArchiveIsToo")}</p>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          <Button variant="outline" onClick={generateManifest} disabled={!canExport}>
            <ListChecks className="h-4 w-4 mr-2" />
            {busyFormat === "manifest" ? pc("generating") : pc("generateManifest")}
          </Button>
          <Button variant="outline" onClick={exportFilesZip} disabled={!isOwner || busyFormat !== null}>
            <FolderArchive className="h-4 w-4 mr-2" />
            {busyFormat === "zip"
              ? zipProgress !== null
                ? pc("downloadingZip", { p0: zipProgress })
                : pc("downloadingZip2")
              : pc("downloadFilesZip")}
          </Button>
        </div>

        {(busyFormat === "zip" || zipProgressText) && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{zipProgressText ? pc(zipProgressText.key, zipProgressText.values) : pc("downloadingZip2")}</span>
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
          <p className="font-medium">{pc("recommendedSafeguards")}</p>
        </div>
        <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
          <li>{pc("allowOnlyOwnersToExport")}</li>
          <li>{pc("alwaysExportTheManifestBeforeDownloadingThe")}</li>
          <li>{pc("preserveBucketPathStructureWhenRestoringTo")}</li>
          <li>{pc("verifyChecksumsAfterImportToConfirmFile")}</li>
          <li>{pc("forLargeArchivesConsiderBatchesInsteadOf")}</li>
        </ul>
      </div>

      <div className="rounded-lg border p-4 space-y-2">
        <p className="font-medium">{pc("importGuide")}</p>
        <ol className="list-decimal pl-5 text-sm text-muted-foreground space-y-1">
          {IMPORT_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * React Query wrapper for the HACCP dossier. It chooses the manager RPC source
 * or the public Edge link, always returns an HaccpStore, and exposes the Excel
 * and ZIP exports for the existing preview dialog.
 */

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import templateUrl from "@/assets/haccp/haccp-q7-template.xlsx?url";
import type { HaccpStore } from "@/components/haccp/store";
import type { HaccpTableId } from "@/lib/haccp-schema";
import {
  HACCP_TABLE_SECTION,
  HaccpApiError,
  createLinkStore,
  createManagerStore,
  haccpEmptyData,
  loadLinkSnapshot,
  loadManagerSnapshot,
  type HaccpRawSnapshot,
} from "@/lib/haccp-api";
import {
  HACCP_EXCEL_FILE_NAME,
  buildHaccpWorkbook,
  buildHaccpZip,
  type HaccpAttachment,
} from "@/lib/haccp-export";

export interface UseHaccpManageOptions {
  mode: "manage";
}

export interface UseHaccpLinkOptions {
  mode: "link";
  token: string;
}

export type UseHaccpOptions = UseHaccpManageOptions | UseHaccpLinkOptions;

export interface UseHaccpResult {
  store: HaccpStore;
  isLoading: boolean;
  /** A dossier snapshot has arrived at least once. */
  ready: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  buildExcel: () => Promise<Blob>;
  buildZip: () => Promise<Blob>;
  exportExcel: () => Promise<void>;
  exportZip: () => Promise<void>;
}

const TABLE_IDS: HaccpTableId[] = ["suppliers", "team", "staff", "measure", "machines", "chemicals", "process"];
const ZIP_NAME = "Ho-so-HACCP-Q7.zip";

let templatePromise: Promise<ArrayBuffer> | null = null;

function readTemplate(): Promise<ArrayBuffer> {
  if (!templatePromise) {
    templatePromise = fetch(templateUrl)
      .then((response) => {
        if (!response.ok) throw new Error("template_unavailable");
        return response.arrayBuffer();
      })
      .catch((error) => {
        templatePromise = null;
        throw error;
      });
  }
  return templatePromise;
}

function emptyStore(): HaccpStore {
  return {
    data: haccpEmptyData(),
    layoutFiles: [],
    link: { url: "", days: 30, active: false, expiresOn: "" },
    activity: [],
    saveRow: () => undefined,
    removeRow: () => undefined,
    addLayoutFiles: () => undefined,
    removeLayoutFile: () => undefined,
    pullFromApp: () => 0,
    createLink: () => undefined,
    revokeLink: () => undefined,
  };
}

async function collectAttachments(
  store: HaccpStore,
): Promise<{ attachments: HaccpAttachment[]; missing: string[] }> {
  const jobs: { section: HaccpAttachment["section"]; file: { name: string; url?: string } }[] = [];
  const missing: string[] = [];
  for (const table of TABLE_IDS) {
    for (const row of store.data[table]) {
      for (const file of row.files) {
        if (file.url) jobs.push({ section: HACCP_TABLE_SECTION[table], file });
        else missing.push(file.name);
      }
    }
  }
  for (const file of store.layoutFiles) {
    if (file.url) jobs.push({ section: "layout", file });
    else missing.push(file.name);
  }

  const downloaded = await Promise.allSettled(jobs.map(async (job): Promise<HaccpAttachment> => {
    const response = await fetch(job.file.url as string);
    if (!response.ok) throw new Error("file_unavailable");
    return {
      section: job.section,
      name: job.file.name,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }));

  const attachments: HaccpAttachment[] = [];
  downloaded.forEach((result, index) => {
    if (result.status === "fulfilled") attachments.push(result.value);
    else missing.push(jobs[index].file.name);
  });
  return { attachments, missing };
}

function download(blob: Blob, name: string): void {
  if (typeof document === "undefined") return;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

export function useHaccp(options: UseHaccpOptions): UseHaccpResult {
  const queryClient = useQueryClient();
  const token = options.mode === "link" ? options.token : "";

  const fetchSnapshot = useCallback(async (): Promise<HaccpRawSnapshot> => {
    if (options.mode === "link") return loadLinkSnapshot(token);
    const loaded = await loadManagerSnapshot();
    return loaded.snapshot;
  }, [options.mode, token]);

  const query = useQuery<HaccpRawSnapshot>({
    queryKey: ["haccp", options.mode, token],
    enabled: options.mode === "manage" || Boolean(token),
    retry: false,
    refetchOnWindowFocus: true,
    queryFn: fetchSnapshot,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["haccp"] });
  }, [queryClient]);

  const store = useMemo<HaccpStore>(() => {
    if (!query.data) return emptyStore();
    return options.mode === "manage"
      ? createManagerStore(query.data, refresh)
      : createLinkStore(token, query.data, refresh);
  }, [options.mode, query.data, refresh, token]);

  const buildExcel = useCallback(async () => {
    const template = await readTemplate();
    const bytes = await buildHaccpWorkbook(template, store.data, store.layoutFiles);
    return new Blob([bytes as unknown as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }, [store.data, store.layoutFiles]);

  const buildZip = useCallback(async () => {
    const template = await readTemplate();
    // Re-read the dossier first: manager signed URLs last one hour, and a link
    // token may have been revoked since the screen was opened.
    const freshSnapshot = await queryClient.fetchQuery<HaccpRawSnapshot>({
      queryKey: ["haccp", options.mode, token],
      queryFn: fetchSnapshot,
      staleTime: 0,
    });
    const freshStore = options.mode === "manage"
      ? createManagerStore(freshSnapshot, refresh)
      : createLinkStore(token, freshSnapshot, refresh);
    const { attachments, missing } = await collectAttachments(freshStore);
    if (missing.length) {
      throw new HaccpApiError(
        "attachment_missing",
        `Không tải được ${missing.length} file đính kèm: ${missing.join(", ")}`,
      );
    }
    const bytes = await buildHaccpZip(template, freshStore.data, freshStore.layoutFiles, attachments);
    return new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
  }, [fetchSnapshot, options.mode, queryClient, refresh, token]);

  const exportExcel = useCallback(async () => {
    download(await buildExcel(), HACCP_EXCEL_FILE_NAME);
  }, [buildExcel]);

  const exportZip = useCallback(async () => {
    download(await buildZip(), ZIP_NAME);
  }, [buildZip]);

  return {
    store,
    isLoading: query.isLoading || query.isFetching,
    ready: Boolean(query.data),
    error: query.error instanceof Error ? query.error : null,
    refetch: refresh,
    buildExcel,
    buildZip,
    exportExcel,
    exportZip,
  };
}

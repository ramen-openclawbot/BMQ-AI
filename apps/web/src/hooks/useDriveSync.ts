import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface DriveSyncConfig {
  id: string;
  folder_type: 'po' | 'bank_slip';
  sync_mode: 'auto' | 'manual';
  auto_sync_interval_minutes: number;
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  files_synced_count: number;
  created_at: string;
  updated_at: string;
}

export interface DriveFileIndex {
  id: string;
  file_id: string;
  file_name: string;
  folder_date: string;
  folder_type: 'po' | 'bank_slip';
  mime_type: string | null;
  parent_folder_id: string | null;
  file_size: number | null;
  indexed_at: string;
  last_seen_at: string;
  processed: boolean;
  processed_at: string | null;
  purchase_order_id: string | null;
  payment_request_id: string | null;
  invoice_id: string | null;
  created_by: string | null;
}

// Fetch sync config for both folder types
export function useDriveSyncConfigs() {
  return useQuery({
    queryKey: ["drive-sync-configs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("drive_sync_config")
        .select("*")
        .order("folder_type");
      
      if (error) throw error;
      return data as DriveSyncConfig[];
    },
    staleTime: 30000,
  });
}

// Get unprocessed files from index
export function useUnprocessedDriveFiles(folderType: 'po' | 'bank_slip') {
  return useQuery({
    queryKey: ["drive-file-index", folderType, "unprocessed"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("drive_file_index")
        .select("*")
        .eq("folder_type", folderType)
        .eq("processed", false)
        .order("folder_date", { ascending: false })
        .order("file_name");
      
      if (error) throw error;
      return data as DriveFileIndex[];
    },
    staleTime: 10000,
  });
}

// Get files by folder date
export function useDriveFilesByDate(folderType: 'po' | 'bank_slip', folderDate: string) {
  return useQuery({
    queryKey: ["drive-file-index", folderType, folderDate],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("drive_file_index")
        .select("*")
        .eq("folder_type", folderType)
        .eq("folder_date", folderDate)
        .order("file_name");
      
      if (error) throw error;
      return data as DriveFileIndex[];
    },
    enabled: !!folderDate,
    staleTime: 10000,
  });
}

// Track folders currently being synced to prevent concurrent syncs
const syncingFoldersRef = { current: new Set<string>() };

// Trigger manual sync
export function useTriggerSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (folderType: 'po' | 'bank_slip') => {
      // Prevent concurrent syncs for the same folder
      if (syncingFoldersRef.current.has(folderType)) {
        throw new Error("Đang đồng bộ, vui lòng đợi...");
      }
      syncingFoldersRef.current.add(folderType);

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          throw new Error("Phiên đăng nhập đã hết hạn");
        }

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-drive-index`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ folderType }),
          }
        );

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Sync failed');
        }

        return response.json();
      } finally {
        syncingFoldersRef.current.delete(folderType);
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["drive-sync-configs"] });
      queryClient.invalidateQueries({ queryKey: ["drive-file-index"] });
      
      toast.success(`Đã đồng bộ ${data.filesSynced} files từ ${data.foldersScanned} thư mục`);
    },
    onError: (error: Error) => {
      toast.error("Đồng bộ thất bại", {
        description: error.message,
      });
    },
  });
}

// Mark file as processed
export function useMarkFileProcessed() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ 
      fileId, 
      purchaseOrderId,
      paymentRequestId,
      invoiceId,
    }: { 
      fileId: string;
      purchaseOrderId?: string;
      paymentRequestId?: string;
      invoiceId?: string;
    }) => {
      const { error } = await supabase
        .from("drive_file_index")
        .update({ 
          processed: true,
          processed_at: new Date().toISOString(),
          purchase_order_id: purchaseOrderId || null,
          payment_request_id: paymentRequestId || null,
          invoice_id: invoiceId || null,
        })
        .eq("file_id", fileId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drive-file-index"] });
    },
  });
}

// Get file count summary by folder type
export function useDriveFileSummary() {
  return useQuery({
    queryKey: ["drive-file-summary"],
    queryFn: async () => {
      // Get counts for PO
      const { count: poTotal } = await supabase
        .from("drive_file_index")
        .select("*", { count: "exact", head: true })
        .eq("folder_type", "po");

      const { count: poUnprocessed } = await supabase
        .from("drive_file_index")
        .select("*", { count: "exact", head: true })
        .eq("folder_type", "po")
        .eq("processed", false);

      // Get counts for bank_slip
      const { count: bankSlipTotal } = await supabase
        .from("drive_file_index")
        .select("*", { count: "exact", head: true })
        .eq("folder_type", "bank_slip");

      const { count: bankSlipUnprocessed } = await supabase
        .from("drive_file_index")
        .select("*", { count: "exact", head: true })
        .eq("folder_type", "bank_slip")
        .eq("processed", false);

      return {
        po: { total: poTotal || 0, unprocessed: poUnprocessed || 0 },
        bank_slip: { total: bankSlipTotal || 0, unprocessed: bankSlipUnprocessed || 0 },
      };
    },
    staleTime: 30000,
  });
}

import { RefreshCw, Clock, FileText, CreditCard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useDriveSyncConfigs, useTriggerSync, useDriveFileSummary } from "@/hooks/useDriveSync";
import { format } from "date-fns";
import { vi } from "date-fns/locale";

interface SyncFolderCardProps {
  label: string;
  icon: React.ReactNode;
  config: {
    last_synced_at: string | null;
    last_sync_status: string | null;
  } | undefined;
  summary: { total: number; unprocessed: number } | undefined;
  isSyncing: boolean;
  onSync: () => void;
}

function SyncFolderCard({ 
  label, 
  icon, 
  config, 
  summary,
  isSyncing, 
  onSync, 
}: SyncFolderCardProps) {
  const formatLastSync = (timestamp: string | null) => {
    if (!timestamp) return "Chưa đồng bộ";
    try {
      return format(new Date(timestamp), "dd/MM/yyyy HH:mm", { locale: vi });
    } catch {
      return "Không xác định";
    }
  };

  return (
    <div className="p-4 border border-border rounded-lg bg-card space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium">{label}</span>
        </div>
        {summary && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {summary.total} files
            </Badge>
            {summary.unprocessed > 0 && (
              <Badge variant="secondary" className="text-xs bg-primary/10 text-primary">
                {summary.unprocessed} mới
              </Badge>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span>Lần sync gần nhất: {formatLastSync(config?.last_synced_at || null)}</span>
          {config?.last_sync_status === 'success' && (
            <Badge variant="outline" className="text-xs text-primary border-primary/30">
              Thành công
            </Badge>
          )}
          {config?.last_sync_status === 'partial' && (
            <Badge variant="outline" className="text-xs text-warning border-warning/30">
              Một phần
            </Badge>
          )}
        </div>
        <Button 
          size="sm" 
          variant="outline" 
          onClick={onSync}
          disabled={isSyncing}
        >
          {isSyncing ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1" />
          )}
          Sync ngay
        </Button>
      </div>
    </div>
  );
}

export function DriveSyncSection() {
  const { data: syncConfigs, isLoading: configsLoading } = useDriveSyncConfigs();
  const { data: fileSummary, isLoading: summaryLoading } = useDriveFileSummary();
  const { mutate: triggerSync, isPending: isSyncing, variables: syncingType } = useTriggerSync();

  const poConfig = syncConfigs?.find(c => c.folder_type === 'po');
  const bankSlipConfig = syncConfigs?.find(c => c.folder_type === 'bank_slip');

  const handleSync = (folderType: 'po' | 'bank_slip') => {
    triggerSync(folderType);
  };

  if (configsLoading || summaryLoading) {
    return (
      <div className="p-4 border border-border rounded-lg bg-card">
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <RefreshCw className="h-5 w-5 text-primary" />
        <h3 className="font-display font-semibold">Đồng bộ danh sách file</h3>
      </div>
      
      <p className="text-sm text-muted-foreground">
        Hệ thống tự động đồng bộ khi đăng nhập. Bạn cũng có thể bấm "Sync ngay" để đồng bộ thủ công.
      </p>

      <SyncFolderCard
        label="Folder PO"
        icon={<FileText className="h-4 w-4 text-primary" />}
        config={poConfig}
        summary={fileSummary?.po}
        isSyncing={isSyncing && syncingType === 'po'}
        onSync={() => handleSync('po')}
      />

      <SyncFolderCard
        label="Folder Bank Receipts"
        icon={<CreditCard className="h-4 w-4 text-primary" />}
        config={bankSlipConfig}
        summary={fileSummary?.bank_slip}
        isSyncing={isSyncing && syncingType === 'bank_slip'}
        onSync={() => handleSync('bank_slip')}
      />
    </div>
  );
}

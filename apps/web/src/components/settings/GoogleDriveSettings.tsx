import { useState, useEffect } from "react";
import { FolderOpen, Save, Check, X, Loader2, TestTube, Link2, Unlink, RefreshCw, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { DriveSyncSection } from "./DriveSyncSection";

export function GoogleDriveSettings() {
  const [poFolderUrl, setPoFolderUrl] = useState("");
  const [receiptsFolderUrl, setReceiptsFolderUrl] = useState("");
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testingPo, setTestingPo] = useState(false);
  const [testingReceipts, setTestingReceipts] = useState(false);
  const [poFolderSaved, setPoFolderSaved] = useState(false);
  const [receiptsFolderSaved, setReceiptsFolderSaved] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const { data } = await supabase
          .from("app_settings")
          .select("key, value")
          .in("key", ["google_drive_po_folder", "google_drive_receipts_folder", "google_drive_connected_email"]);

        if (data) {
          const poFolder = data.find(d => d.key === "google_drive_po_folder");
          const receiptsFolder = data.find(d => d.key === "google_drive_receipts_folder");
          const emailSetting = data.find(d => d.key === "google_drive_connected_email");
          
          if (poFolder?.value) {
            setPoFolderUrl(poFolder.value);
            setPoFolderSaved(true);
          }
          if (receiptsFolder?.value) {
            setReceiptsFolderUrl(receiptsFolder.value);
            setReceiptsFolderSaved(true);
          }
          if (emailSetting?.value) {
            setConnectedEmail(emailSetting.value);
          }
        }
      } catch (error) {
        console.error("Failed to fetch Google Drive settings:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchSettings();

    // Check for OAuth callback params
    const urlParams = new URLSearchParams(window.location.search);
    const driveSuccess = urlParams.get('drive_success');
    const driveError = urlParams.get('drive_error');
    const driveEmail = urlParams.get('drive_email');

    if (driveSuccess === 'true') {
      toast.success("Kết nối Google Drive thành công!", {
        description: driveEmail ? `Đã kết nối với ${driveEmail}` : undefined
      });
      if (driveEmail) {
        setConnectedEmail(driveEmail);
      }
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (driveError) {
      toast.error("Kết nối Google Drive thất bại", {
        description: driveError
      });
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const validateGoogleDriveUrl = (url: string): boolean => {
    if (!url) return true;
    return url.includes("drive.google.com/drive/folders/");
  };

  const handleConnect = async () => {
    setConnecting(true);
    
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-drive-auth`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ 
            redirect: window.location.origin 
          }),
        }
      );

      const result = await response.json();
      
      if (result.authUrl) {
        // Redirect to Google OAuth
        window.location.href = result.authUrl;
      } else if (result.error) {
        toast.error("Không thể kết nối", {
          description: result.error
        });
        setConnecting(false);
      }
    } catch (error: any) {
      console.error("Connect error:", error);
      toast.error("Lỗi kết nối", {
        description: error.message || "Không thể bắt đầu quá trình kết nối"
      });
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast.error("Phiên đăng nhập đã hết hạn");
      return;
    }

    setDisconnecting(true);

    try {
      // Delete refresh token
      await supabase
        .from("app_settings")
        .delete()
        .eq("key", "google_drive_refresh_token");

      // Delete connected email
      await supabase
        .from("app_settings")
        .delete()
        .eq("key", "google_drive_connected_email");

      setConnectedEmail(null);
      toast.success("Đã ngắt kết nối Google Drive");
    } catch (error: any) {
      console.error("Disconnect error:", error);
      toast.error("Không thể ngắt kết nối", {
        description: error.message
      });
    } finally {
      setDisconnecting(false);
    }
  };

  const handleTestConnection = async (type: 'po' | 'receipts') => {
    const url = type === 'po' ? poFolderUrl : receiptsFolderUrl;
    const setTesting = type === 'po' ? setTestingPo : setTestingReceipts;
    const setSaved = type === 'po' ? setPoFolderSaved : setReceiptsFolderSaved;
    const settingKey = type === 'po' ? 'google_drive_po_folder' : 'google_drive_receipts_folder';
    const label = type === 'po' ? 'PO' : 'Bank Receipts';

    if (!url) {
      toast.error(`Vui lòng nhập URL folder ${label}`);
      return;
    }

    if (!validateGoogleDriveUrl(url)) {
      toast.error("URL không hợp lệ", {
        description: "Vui lòng sử dụng link Google Drive folder"
      });
      return;
    }

    if (!connectedEmail) {
      toast.error("Chưa kết nối Google Drive", {
        description: "Vui lòng kết nối Google account trước"
      });
      return;
    }

    setTesting(true);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/test-drive-connection`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ folderUrl: url }),
        }
      );

      const result = await response.json();

      if (result.success) {
        // Auto-save to database on success
        const { error: saveError } = await supabase
          .from("app_settings")
          .upsert({ 
            key: settingKey, 
            value: url.trim(),
            updated_at: new Date().toISOString()
          }, { onConflict: 'key' });

        if (saveError) {
          console.error("Failed to auto-save folder URL:", saveError);
          toast.success(`Kết nối thành công!`, {
            description: `Folder "${result.folderName}" - ${result.itemCount} items (Lưu thất bại)`
          });
        } else {
          setSaved(true);
          toast.success(`Kết nối thành công và đã lưu!`, {
            description: `Folder "${result.folderName}" - ${result.itemCount} items`
          });
        }
      } else {
        toast.error("Kết nối thất bại", {
          description: result.error || "Không thể truy cập folder"
        });
      }
    } catch (error: any) {
      console.error("Test connection error:", error);
      toast.error("Lỗi kết nối", {
        description: error.message || "Không thể kiểm tra kết nối"
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast.error("Phiên đăng nhập đã hết hạn", {
        description: "Vui lòng đăng nhập lại"
      });
      return;
    }

    if (!validateGoogleDriveUrl(poFolderUrl)) {
      toast.error("URL folder PO không hợp lệ", {
        description: "Vui lòng sử dụng link Google Drive folder"
      });
      return;
    }

    if (!validateGoogleDriveUrl(receiptsFolderUrl)) {
      toast.error("URL folder Bank Receipts không hợp lệ", {
        description: "Vui lòng sử dụng link Google Drive folder"
      });
      return;
    }

    setSaving(true);
    try {
      const { error: poError } = await supabase
        .from("app_settings")
        .upsert({ 
          key: "google_drive_po_folder", 
          value: poFolderUrl.trim(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

      if (poError) throw poError;

      const { error: receiptsError } = await supabase
        .from("app_settings")
        .upsert({ 
          key: "google_drive_receipts_folder", 
          value: receiptsFolderUrl.trim(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

      if (receiptsError) throw receiptsError;

      setPoFolderSaved(true);
      setReceiptsFolderSaved(true);
      
      toast.success("Đã lưu cấu hình Google Drive");
    } catch (error: any) {
      console.error("Failed to save Google Drive settings:", error);
      
      let errorMessage = error?.message || "Vui lòng thử lại";
      if (error?.code === "42501") {
        errorMessage = "Bạn không có quyền thực hiện thao tác này. Vui lòng đăng nhập với tài khoản Owner.";
      }
      
      toast.error("Không thể lưu cấu hình", {
        description: errorMessage
      });
    } finally {
      setSaving(false);
    }
  };

  const getUrlStatusIndicator = (url: string, saved: boolean) => {
    if (!url) {
      return (
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          <X className="h-4 w-4 text-destructive" />
          Chưa cấu hình
        </span>
      );
    }
    if (saved) {
      return (
        <span className="flex items-center gap-1 text-sm text-primary">
          <Check className="h-4 w-4" />
          Đã lưu
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        <Check className="h-4 w-4 text-warning" />
        Chưa lưu
      </span>
    );
  };

  if (loading) {
    return (
      <div className="card-elevated rounded-xl border border-border p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center gap-3">
        <FolderOpen className="h-5 w-5 text-primary" />
        <h2 className="font-display font-semibold text-lg">Google Drive Integration</h2>
      </div>
      <Separator />

      <div className="bg-muted/50 rounded-lg p-4 text-sm text-muted-foreground mb-4">
        <p className="font-medium text-foreground mb-2">Hướng dẫn:</p>
        <ol className="list-decimal ml-4 space-y-1">
          <li>Kết nối Google account (bấm nút bên dưới)</li>
          <li>Tạo 2 folder trên Google Drive: 1 cho PO, 1 cho Bank Receipts</li>
          <li>Copy link folder và dán vào ô bên dưới</li>
          <li>Trong mỗi folder, tạo subfolder theo ngày (YYMMDD, VD: 260124)</li>
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">
          <strong>Lưu ý:</strong> Folder không cần share public. Hệ thống sử dụng OAuth để truy cập private folder.
        </p>
      </div>

      <div className="space-y-4">
        {/* Google Account Connection */}
        <div className="p-4 border border-border rounded-lg bg-card">
          <Label className="flex items-center gap-2 mb-3">
            <Link2 className="h-4 w-4" />
            Kết nối Google Account
          </Label>
          
          {connectedEmail ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Check className="h-5 w-5 text-primary" />
                <span className="text-sm">
                  Đã kết nối: <strong>{connectedEmail}</strong>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                {disconnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Unlink className="h-4 w-4 mr-1" />
                )}
                Ngắt kết nối
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <X className="h-4 w-4 text-destructive" />
                Chưa kết nối
              </span>
              <Button
                onClick={handleConnect}
                disabled={connecting}
                size="sm"
              >
                {connecting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Link2 className="h-4 w-4 mr-1" />
                )}
                Kết nối Google Drive
              </Button>
            </div>
          )}
        </div>

        {/* PO Folder */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="po-folder">
              Folder PO (Purchase Orders)
            </Label>
            {getUrlStatusIndicator(poFolderUrl, poFolderSaved)}
          </div>
          <div className="flex gap-2">
            <Input
              id="po-folder"
              type="text"
              value={poFolderUrl}
              onChange={(e) => {
                setPoFolderUrl(e.target.value);
                setPoFolderSaved(false);
              }}
              placeholder="https://drive.google.com/drive/folders/..."
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => handleTestConnection('po')}
              disabled={testingPo || !poFolderUrl || !connectedEmail}
            >
              {testingPo ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <TestTube className="h-4 w-4" />
              )}
              <span className="ml-1 hidden sm:inline">Test</span>
            </Button>
          </div>
        </div>

        {/* Receipts Folder */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="receipts-folder">
              Folder Bank Receipts (Ủy nhiệm chi)
            </Label>
            {getUrlStatusIndicator(receiptsFolderUrl, receiptsFolderSaved)}
          </div>
          <div className="flex gap-2">
            <Input
              id="receipts-folder"
              type="text"
              value={receiptsFolderUrl}
              onChange={(e) => {
                setReceiptsFolderUrl(e.target.value);
                setReceiptsFolderSaved(false);
              }}
              placeholder="https://drive.google.com/drive/folders/..."
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => handleTestConnection('receipts')}
              disabled={testingReceipts || !receiptsFolderUrl || !connectedEmail}
            >
              {testingReceipts ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <TestTube className="h-4 w-4" />
              )}
              <span className="ml-1 hidden sm:inline">Test</span>
            </Button>
          </div>
        </div>
      </div>

      <Separator />

      {/* Sync Section - Only show when connected */}
      {connectedEmail && poFolderSaved && (
        <DriveSyncSection />
      )}

      <Separator />

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          Lưu cấu hình
        </Button>
      </div>
    </div>
  );
}

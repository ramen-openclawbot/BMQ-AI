import { useState, useEffect } from "react";
import { Save, Loader2, TestTube, Link2, Unlink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { LoadingState } from "@/components/ui/loading";
import { InvoiceEmailSettings } from "./InvoiceEmailSettings";
import { OrderEmailSettings } from "./OrderEmailSettings";
import { SettingsGroup, SettingsRow, SettingsStatus } from "./SettingsKit";

export function GoogleDriveSettings() {
  const [poFolderUrl, setPoFolderUrl] = useState("");
  const [receiptsFolderUrl, setReceiptsFolderUrl] = useState("");
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);
  const [receiptsUncPattern, setReceiptsUncPattern] = useState("yyyy/MM/dd/UNC");
  const [receiptsQtmPattern, setReceiptsQtmPattern] = useState("yyyy/MM/dd/QTM");
  const [gmailConnectedEmail, setGmailConnectedEmail] = useState<string | null>(null);
  const [debtGmailConnectedEmail, setDebtGmailConnectedEmail] = useState<string | null>(null);
  const [debtEmailSender, setDebtEmailSender] = useState("no-reply@bmq.vn");
  const [debtEmailCc, setDebtEmailCc] = useState("ketoantruong@bmq.vn");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [gmailDisconnecting, setGmailDisconnecting] = useState(false);
  const [debtGmailConnecting, setDebtGmailConnecting] = useState(false);
  const [debtGmailDisconnecting, setDebtGmailDisconnecting] = useState(false);
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
          .in("key", ["google_drive_po_folder", "google_drive_receipts_folder", "google_drive_receipts_unc_pattern", "google_drive_receipts_qtm_pattern", "google_drive_connected_email", "google_gmail_connected_email", "debt_gmail_connected_email", "customer_debt_gmail_sender", "customer_debt_default_cc"]);

        if (data) {
          const poFolder = data.find(d => d.key === "google_drive_po_folder");
          const receiptsFolder = data.find(d => d.key === "google_drive_receipts_folder");
          const uncPatternSetting = data.find(d => d.key === "google_drive_receipts_unc_pattern");
          const qtmPatternSetting = data.find(d => d.key === "google_drive_receipts_qtm_pattern");
          const emailSetting = data.find(d => d.key === "google_drive_connected_email");
          const gmailEmailSetting = data.find(d => d.key === "google_gmail_connected_email");
          const debtGmailEmailSetting = data.find(d => d.key === "debt_gmail_connected_email");
          const debtSenderSetting = data.find(d => d.key === "customer_debt_gmail_sender");
          const debtCcSetting = data.find(d => d.key === "customer_debt_default_cc");
          
          if (poFolder?.value) {
            setPoFolderUrl(poFolder.value);
            setPoFolderSaved(true);
          }
          if (receiptsFolder?.value) {
            setReceiptsFolderUrl(receiptsFolder.value);
            setReceiptsFolderSaved(true);
          }
          if (uncPatternSetting?.value) setReceiptsUncPattern(String(uncPatternSetting.value));
          if (qtmPatternSetting?.value) setReceiptsQtmPattern(String(qtmPatternSetting.value));
          if (emailSetting?.value) {
            setConnectedEmail(emailSetting.value);
          }
          if (gmailEmailSetting?.value) {
            setGmailConnectedEmail(gmailEmailSetting.value);
          }
          if (debtGmailEmailSetting?.value) {
            setDebtGmailConnectedEmail(debtGmailEmailSetting.value);
          }
          if (debtSenderSetting?.value) setDebtEmailSender(String(debtSenderSetting.value));
          if (debtCcSetting?.value) setDebtEmailCc(String(debtCcSetting.value));
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
    const gmailSuccess = urlParams.get('gmail_success');
    const gmailError = urlParams.get('gmail_error');
    const gmailEmail = urlParams.get('gmail_email');
    const debtGmailSuccess = urlParams.get('debt_gmail_success');
    const debtGmailError = urlParams.get('debt_gmail_error');
    const debtGmailEmail = urlParams.get('debt_gmail_email');

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
    } else if (gmailSuccess === 'true') {
      toast.success("Kết nối Gmail PO thành công!", {
        description: gmailEmail ? `Đã kết nối với ${gmailEmail}` : undefined
      });
      if (gmailEmail) setGmailConnectedEmail(gmailEmail);
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (gmailError) {
      toast.error("Kết nối Gmail PO thất bại", {
        description: gmailError
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (debtGmailSuccess === 'true') {
      toast.success("Kết nối Gmail gửi công nợ thành công!", {
        description: debtGmailEmail ? `Đã kết nối với ${debtGmailEmail}` : undefined
      });
      if (debtGmailEmail) setDebtGmailConnectedEmail(debtGmailEmail);
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (debtGmailError) {
      toast.error("Kết nối Gmail gửi công nợ thất bại", {
        description: debtGmailError
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const validateGoogleDriveUrl = (url: string): boolean => {
    if (!url) return true;
    // Accept both /drive/folders/ and /drive/u/N/folders/ (user-index variant)
    return url.includes("drive.google.com") && url.includes("/folders/");
  };

  const getErrorMessage = (error: unknown, fallback = "Vui lòng thử lại") =>
    error instanceof Error ? error.message : fallback;

  const getErrorCode = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code || "") : "";

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
    } catch (error) {
      console.error("Connect error:", error);
      toast.error("Lỗi kết nối", {
        description: getErrorMessage(error, "Không thể bắt đầu quá trình kết nối")
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
    } catch (error) {
      console.error("Disconnect error:", error);
      toast.error("Không thể ngắt kết nối", {
        description: getErrorMessage(error)
      });
    } finally {
      setDisconnecting(false);
    }
  };

  const handleConnectGmail = async () => {
    setGmailConnecting(true);
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-drive-auth`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect: window.location.origin, mode: 'gmail' }),
        }
      );
      const result = await response.json();
      if (result.authUrl) {
        window.location.href = result.authUrl;
      } else if (result.error) {
        toast.error("Không thể kết nối Gmail", { description: result.error });
      }
    } catch (error) {
      toast.error("Lỗi kết nối Gmail", { description: getErrorMessage(error, "Không thể bắt đầu quá trình kết nối") });
    } finally {
      setGmailConnecting(false);
    }
  };

  const handleDisconnectGmail = async () => {
    setGmailDisconnecting(true);
    try {
      await supabase.from("app_settings").delete().eq("key", "google_gmail_refresh_token");
      await supabase.from("app_settings").delete().eq("key", "google_gmail_connected_email");
      setGmailConnectedEmail(null);
      toast.success("Đã ngắt kết nối Gmail PO");
    } catch (error) {
      toast.error("Không thể ngắt Gmail", { description: getErrorMessage(error) });
    } finally {
      setGmailDisconnecting(false);
    }
  };

  const handleConnectDebtGmail = async () => {
    setDebtGmailConnecting(true);
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-drive-auth`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect: window.location.origin, mode: 'debt_gmail' }),
        }
      );
      const result = await response.json();
      if (result.authUrl) {
        window.location.href = result.authUrl;
      } else if (result.error) {
        toast.error("Không thể kết nối Gmail gửi công nợ", { description: result.error });
      }
    } catch (error) {
      toast.error("Lỗi kết nối Gmail gửi công nợ", { description: getErrorMessage(error, "Không thể bắt đầu quá trình kết nối") });
    } finally {
      setDebtGmailConnecting(false);
    }
  };

  const handleDisconnectDebtGmail = async () => {
    setDebtGmailDisconnecting(true);
    try {
      await supabase.from("app_settings").delete().eq("key", "debt_gmail_refresh_token");
      await supabase.from("app_settings").delete().eq("key", "debt_gmail_connected_email");
      setDebtGmailConnectedEmail(null);
      toast.success("Đã ngắt Gmail gửi công nợ");
    } catch (error) {
      toast.error("Không thể ngắt Gmail gửi công nợ", { description: getErrorMessage(error) });
    } finally {
      setDebtGmailDisconnecting(false);
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
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/test-drive-connection`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({ folderUrl: url }),
        }
      );

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(
          response.status === 401
            ? "Phiên đăng nhập hết hạn — vui lòng đăng nhập lại"
            : errBody?.error || `HTTP ${response.status}`
        );
      }

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
    } catch (error) {
      console.error("Test connection error:", error);
      toast.error("Lỗi kết nối", {
        description: getErrorMessage(error, "Không thể kiểm tra kết nối")
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

      const { error: uncPatternError } = await supabase
        .from("app_settings")
        .upsert({ key: "google_drive_receipts_unc_pattern", value: receiptsUncPattern.trim() || "yyyy/MM/dd/UNC", updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (uncPatternError) throw uncPatternError;

      const { error: qtmPatternError } = await supabase
        .from("app_settings")
        .upsert({ key: "google_drive_receipts_qtm_pattern", value: receiptsQtmPattern.trim() || "yyyy/MM/dd/QTM", updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (qtmPatternError) throw qtmPatternError;

      const { error: debtSenderError } = await supabase
        .from("app_settings")
        .upsert({ key: "customer_debt_gmail_sender", value: debtEmailSender.trim() || "no-reply@bmq.vn", updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (debtSenderError) throw debtSenderError;

      const { error: debtCcError } = await supabase
        .from("app_settings")
        .upsert({ key: "customer_debt_default_cc", value: debtEmailCc.trim() || "ketoantruong@bmq.vn", updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (debtCcError) throw debtCcError;

      setPoFolderSaved(true);
      setReceiptsFolderSaved(true);
      
      toast.success("Đã lưu cấu hình Google Drive");
    } catch (error) {
      console.error("Failed to save Google Drive settings:", error);
      
      let errorMessage = getErrorMessage(error);
      if (getErrorCode(error) === "42501") {
        errorMessage = "Bạn không có quyền thực hiện thao tác này. Vui lòng đăng nhập với tài khoản Owner.";
      }
      
      toast.error("Không thể lưu cấu hình", {
        description: errorMessage
      });
    } finally {
      setSaving(false);
    }
  };

  const folderStatus = (url: string, saved: boolean) => (
    !url ? <SettingsStatus tone="off">Chưa có</SettingsStatus>
      : saved ? <SettingsStatus tone="ok">Đã lưu</SettingsStatus>
      : <SettingsStatus tone="warn">Chưa lưu</SettingsStatus>
  );
  const busyIcon = (busy: boolean, Icon: typeof Link2) => busy ? <Loader2 className="animate-spin" /> : <Icon />;
  const saveButton = (
    <button type="button" className="st-link is-primary" onClick={() => void handleSave()} disabled={saving} data-bmq-settings-save>
      {busyIcon(saving, Save)}Lưu
    </button>
  );

  if (loading) {
    return (
      <SettingsGroup title="Kết nối">
        <LoadingState flat rows={4} label="Đang tải cấu hình kết nối…" />
      </SettingsGroup>
    );
  }

  return (
    <>
      <SettingsGroup id="google-drive" title="Kết nối">
        <SettingsRow
          dataAttr="bmq-settings-drive"
          label="Google Drive"
          hint={connectedEmail ? connectedEmail : "Đọc thư mục PO và UNC"}
          value={connectedEmail ? <SettingsStatus tone="ok">Đã kết nối</SettingsStatus> : <SettingsStatus tone="off">Chưa kết nối</SettingsStatus>}
          action={connectedEmail ? (
            <button type="button" className="st-link is-danger" onClick={() => void handleDisconnect()} disabled={disconnecting}>{busyIcon(disconnecting, Unlink)}Ngắt</button>
          ) : (
            <button type="button" className="st-link is-primary" onClick={() => void handleConnect()} disabled={connecting}>{busyIcon(connecting, Link2)}Kết nối</button>
          )}
        />
        <SettingsRow
          dataAttr="bmq-settings-gmail-po"
          label="Gmail đọc PO"
          hint={gmailConnectedEmail ? gmailConnectedEmail : "Hộp thư nhận PO của khách"}
          value={gmailConnectedEmail ? <SettingsStatus tone="ok">Đã kết nối</SettingsStatus> : <SettingsStatus tone="off">Chưa kết nối</SettingsStatus>}
          action={gmailConnectedEmail ? (
            <button type="button" className="st-link is-danger" onClick={() => void handleDisconnectGmail()} disabled={gmailDisconnecting}>{busyIcon(gmailDisconnecting, Unlink)}Ngắt</button>
          ) : (
            <button type="button" className="st-link is-primary" onClick={() => void handleConnectGmail()} disabled={gmailConnecting}>{busyIcon(gmailConnecting, Link2)}Kết nối</button>
          )}
        />
        <OrderEmailSettings />
        <InvoiceEmailSettings />
        <SettingsRow
          dataAttr="bmq-settings-debt-email"
          label="Email gửi công nợ"
          hint={debtGmailConnectedEmail ? `Gửi từ ${debtEmailSender || debtGmailConnectedEmail}` : "Gửi file công nợ cho khách"}
          value={debtGmailConnectedEmail ? <SettingsStatus tone="ok">Đã kết nối</SettingsStatus> : <SettingsStatus tone="off">Chưa kết nối</SettingsStatus>}
          action={debtGmailConnectedEmail ? (
            <button type="button" className="st-link is-danger" onClick={() => void handleDisconnectDebtGmail()} disabled={debtGmailDisconnecting}>{busyIcon(debtGmailDisconnecting, Unlink)}Ngắt</button>
          ) : (
            <button type="button" className="st-link is-primary" onClick={() => void handleConnectDebtGmail()} disabled={debtGmailConnecting}>{busyIcon(debtGmailConnecting, Link2)}Kết nối</button>
          )}
        >
          <p className="st-note">{debtGmailConnectedEmail ? <>Tài khoản Gmail: <b>{debtGmailConnectedEmail}</b>. Email gửi nên trùng tài khoản này.</> : "Đăng nhập Gmail bằng đúng email gửi bên dưới."}</p>
          <div className="st-panel-grid is-two">
            <label className="st-field">
              <span>Email gửi</span>
              <Input id="debt-email-sender" type="email" value={debtEmailSender} onChange={(e) => setDebtEmailSender(e.target.value)} placeholder="no-reply@bmq.vn" />
            </label>
            <label className="st-field">
              <span>CC mặc định</span>
              <Input id="debt-email-cc" type="text" value={debtEmailCc} onChange={(e) => setDebtEmailCc(e.target.value)} placeholder="ketoantruong@bmq.vn" />
              <small>Nhiều email cách nhau bằng dấu phẩy</small>
            </label>
          </div>
          <div className="st-panel-actions">{saveButton}</div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Thư mục Google Drive" footer={saveButton}>
        <SettingsRow dataAttr="bmq-settings-po-folder" label="Thư mục PO" hint="Thư mục con theo ngày YYMMDD" value={folderStatus(poFolderUrl, poFolderSaved)}>
          <label className="st-field">
            <span>Link thư mục</span>
            <div className="st-inline">
              <Input id="po-folder" type="text" value={poFolderUrl} onChange={(e) => { setPoFolderUrl(e.target.value); setPoFolderSaved(false); }} placeholder="https://drive.google.com/drive/folders/..." />
              <button type="button" className="st-link" onClick={() => void handleTestConnection("po")} disabled={testingPo || !poFolderUrl || !connectedEmail}>{busyIcon(testingPo, TestTube)}Thử</button>
            </div>
          </label>
        </SettingsRow>
        <SettingsRow dataAttr="bmq-settings-receipts-folder" label="Thư mục UNC (ủy nhiệm chi)" hint="Thư mục con theo ngày YYMMDD" value={folderStatus(receiptsFolderUrl, receiptsFolderSaved)}>
          <label className="st-field">
            <span>Link thư mục</span>
            <div className="st-inline">
              <Input id="receipts-folder" type="text" value={receiptsFolderUrl} onChange={(e) => { setReceiptsFolderUrl(e.target.value); setReceiptsFolderSaved(false); }} placeholder="https://drive.google.com/drive/folders/..." />
              <button type="button" className="st-link" onClick={() => void handleTestConnection("receipts")} disabled={testingReceipts || !receiptsFolderUrl || !connectedEmail}>{busyIcon(testingReceipts, TestTube)}Thử</button>
            </div>
          </label>
        </SettingsRow>
        <SettingsRow dataAttr="bmq-settings-patterns" label="Mẫu đường dẫn UNC / QTM" value={<span>{receiptsUncPattern} · {receiptsQtmPattern}</span>}>
          <div className="st-panel-grid is-two">
            <label className="st-field">
              <span>UNC</span>
              <Input id="receipts-unc-pattern" type="text" value={receiptsUncPattern} onChange={(e) => setReceiptsUncPattern(e.target.value)} placeholder="yyyy/MM/dd/UNC" />
            </label>
            <label className="st-field">
              <span>QTM</span>
              <Input id="receipts-qtm-pattern" type="text" value={receiptsQtmPattern} onChange={(e) => setReceiptsQtmPattern(e.target.value)} placeholder="yyyy/MM/dd/QTM" />
            </label>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

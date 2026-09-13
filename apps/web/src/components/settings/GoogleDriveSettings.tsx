import { usePeopleCopy } from "@/hooks/usePeopleCopy";
import { useState, useEffect, useRef } from "react";
import { FolderOpen, Save, Check, X, Loader2, TestTube, Link2, Unlink, RefreshCw, Clock, Mail } from "lucide-react";
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
  const pc = usePeopleCopy();
  const latestCopy = useRef(pc);
  latestCopy.current = pc;
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
      toast.success(latestCopy.current("googleDriveConnectedSuccessfully"), {
        description: driveEmail ? latestCopy.current("connectedTo", { p0: driveEmail }) : undefined
      });
      if (driveEmail) {
        setConnectedEmail(driveEmail);
      }
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (driveError) {
      toast.error(latestCopy.current("unableToConnectGoogleDrive"), {
        description: driveError
      });
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (gmailSuccess === 'true') {
      toast.success(latestCopy.current("poGmailConnectedSuccessfully"), {
        description: gmailEmail ? latestCopy.current("connectedTo", { p0: gmailEmail }) : undefined
      });
      if (gmailEmail) setGmailConnectedEmail(gmailEmail);
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (gmailError) {
      toast.error(latestCopy.current("unableToConnectPoGmail"), {
        description: gmailError
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (debtGmailSuccess === 'true') {
      toast.success(latestCopy.current("debtEmailGmailConnectedSuccessfully"), {
        description: debtGmailEmail ? latestCopy.current("connectedTo", { p0: debtGmailEmail }) : undefined
      });
      if (debtGmailEmail) setDebtGmailConnectedEmail(debtGmailEmail);
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (debtGmailError) {
      toast.error(latestCopy.current("unableToConnectDebtEmailGmail"), {
        description: debtGmailError
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    // OAuth callback and initial settings run once; switching language preserves unsaved inputs.
  }, []);

  const validateGoogleDriveUrl = (url: string): boolean => {
    if (!url) return true;
    // Accept both /drive/folders/ and /drive/u/N/folders/ (user-index variant)
    return url.includes("drive.google.com") && url.includes("/folders/");
  };

  const getErrorMessage = (error: unknown, fallback = pc("pleaseTryAgain")) =>
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
        toast.error(pc("unableToConnect"), {
          description: result.error
        });
        setConnecting(false);
      }
    } catch (error) {
      console.error("Connect error:", error);
      toast.error(pc("connectionError"), {
        description: getErrorMessage(error, pc("unableToStartTheConnectionProcess"))
      });
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast.error(pc("yourSessionHasExpired"));
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
      toast.success(pc("googleDriveDisconnected"));
    } catch (error) {
      console.error("Disconnect error:", error);
      toast.error(pc("unableToDisconnect"), {
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
        toast.error(pc("unableToConnectGmail"), { description: result.error });
      }
    } catch (error) {
      toast.error(pc("gmailConnectionError"), { description: getErrorMessage(error, pc("unableToStartTheConnectionProcess")) });
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
      toast.success(pc("poGmailDisconnected"));
    } catch (error) {
      toast.error(pc("unableToDisconnectGmail"), { description: getErrorMessage(error) });
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
        toast.error(pc("unableToConnectDebtEmailGmail2"), { description: result.error });
      }
    } catch (error) {
      toast.error(pc("debtEmailGmailConnectionError"), { description: getErrorMessage(error, pc("unableToStartTheConnectionProcess")) });
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
      toast.success(pc("debtEmailGmailDisconnected"));
    } catch (error) {
      toast.error(pc("unableToDisconnectDebtEmailGmail"), { description: getErrorMessage(error) });
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
      toast.error(pc("pleaseEnterTheFolderUrl", { p0: label }));
      return;
    }

    if (!validateGoogleDriveUrl(url)) {
      toast.error(pc("invalidUrl"), {
        description: pc("pleaseUseAGoogleDriveFolderLink")
      });
      return;
    }

    if (!connectedEmail) {
      toast.error(pc("googleDriveIsNotConnected"), {
        description: pc("pleaseConnectAGoogleAccountFirst")
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
            ? pc("yourSessionHasExpiredPleaseSignIn")
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
          toast.success(pc("connectedSuccessfully"), {
            description: pc("folderItemsSaveFailed", { p0: result.folderName, p1: result.itemCount })
          });
        } else {
          setSaved(true);
          toast.success(pc("connectedAndSavedSuccessfully"), {
            description: pc("folderItems", { p0: result.folderName, p1: result.itemCount })
          });
        }
      } else {
        toast.error(pc("connectionFailed"), {
          description: result.error || pc("unableToAccessTheFolder")
        });
      }
    } catch (error) {
      console.error("Test connection error:", error);
      toast.error(pc("connectionError"), {
        description: getErrorMessage(error, pc("unableToTestTheConnection"))
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast.error(pc("yourSessionHasExpired"), {
        description: pc("pleaseSignInAgain")
      });
      return;
    }

    if (!validateGoogleDriveUrl(poFolderUrl)) {
      toast.error(pc("invalidPoFolderUrl"), {
        description: pc("pleaseUseAGoogleDriveFolderLink")
      });
      return;
    }

    if (!validateGoogleDriveUrl(receiptsFolderUrl)) {
      toast.error(pc("invalidBankReceiptsFolderUrl"), {
        description: pc("pleaseUseAGoogleDriveFolderLink")
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
      
      toast.success(pc("googleDriveSettingsSaved"));
    } catch (error) {
      console.error("Failed to save Google Drive settings:", error);
      
      let errorMessage = getErrorMessage(error);
      if (getErrorCode(error) === "42501") {
        errorMessage = pc("youDoNotHavePermissionForThis");
      }
      
      toast.error(pc("unableToSaveSettings"), {
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
          <X className="h-4 w-4 text-destructive" /> {pc("notConfigured")} </span>
      );
    }
    if (saved) {
      return (
        <span className="flex items-center gap-1 text-sm text-primary">
          <Check className="h-4 w-4" /> {pc("saved")} </span>
      );
    }
    return (
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        <Check className="h-4 w-4 text-warning" /> {pc("notSaved")} </span>
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
        <h2 className="font-display font-semibold text-lg">{pc("googleDriveIntegration2")}</h2>
      </div>
      <Separator />

      <div className="bg-muted/50 rounded-lg p-4 text-sm text-muted-foreground mb-4">
        <p className="font-medium text-foreground mb-2">{pc("instructions")}</p>
        <ol className="list-decimal ml-4 space-y-1">
          <li>{pc("connectAGoogleAccountForDriveUsing")}</li>
          <li>{pc("connectASeparatePoGmailAccountIf")}</li>
          <li>{pc("connectNoReplyBmqVnInThe")}</li>
          <li>{pc("createTwoGoogleDriveFoldersOneFor")}</li>
          <li>{pc("copyTheFolderLinkAndPasteIt")}</li>
          <li>{pc("createDatedSubfoldersInEachFolderYymmdd")}</li>
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">
          <strong>{pc("note")}</strong> {pc("foldersDoNotNeedPublicSharingThe")} </p>
      </div>

      <div className="space-y-4">
        {/* Google Account Connection */}
        <div className="p-4 border border-border rounded-lg bg-card">
          <Label className="flex items-center gap-2 mb-3">
            <Link2 className="h-4 w-4" /> {pc("connectGoogleAccount")} </Label>
          
          {connectedEmail ? (
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Check className="h-5 w-5 text-primary" />
                  <span className="text-sm"> {pc("connected")} <strong>{connectedEmail}</strong>
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">{pc("thisConnectionIsOnlyForDrivePo")}</span>
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
                )} {pc("disconnect")} </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <X className="h-4 w-4 text-destructive" /> {pc("notConnected")} </span>
              <Button
                onClick={handleConnect}
                disabled={connecting}
                size="sm"
              >
                {connecting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Link2 className="h-4 w-4 mr-1" />
                )} {pc("connectGoogleDrive")} </Button>
            </div>
          )}
        </div>

        {/* Gmail PO Account Connection */}
        <div className="p-4 border border-border rounded-lg bg-card">
          <Label className="flex items-center gap-2 mb-3">
            <Link2 className="h-4 w-4" /> {pc("connectPoGmailAccount")} </Label>

          {gmailConnectedEmail ? (
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Check className="h-5 w-5 text-primary" />
                  <span className="text-sm"> {pc("gmailConnected")} <strong>{gmailConnectedEmail}</strong>
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">{pc("thisAccountReadsThePoMailboxAnd")}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnectGmail}
                disabled={gmailDisconnecting}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                {gmailDisconnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Unlink className="h-4 w-4 mr-1" />
                )} {pc("disconnectGmail")} </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <X className="h-4 w-4 text-destructive" /> {pc("gmailIsNotConnected")} </span>
              <Button
                onClick={handleConnectGmail}
                disabled={gmailConnecting}
                size="sm"
              >
                {gmailConnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Link2 className="h-4 w-4 mr-1" />
                )} {pc("connectGmail")} </Button>
            </div>
          )}
        </div>

        {/* Debt Email Sender */}
        <div className="p-4 border border-border rounded-lg bg-card space-y-3">
          <Label className="flex items-center gap-2">
            <Mail className="h-4 w-4" /> {pc("debtEmail")} </Label>
          <p className="text-xs text-muted-foreground"> {pc("theseSettingsAreOnlyForSendingDebt")} </p>
          {debtGmailConnectedEmail ? (
            <div className="flex items-center justify-between rounded-md border border-primary/20 bg-primary/5 p-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Check className="h-5 w-5 text-primary" />
                  <span className="text-sm"> {pc("debtEmailGmailConnected")} <strong>{debtGmailConnectedEmail}</strong>
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">{pc("theSenderShouldMatchThisOauthAccount")}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnectDebtGmail}
                disabled={debtGmailDisconnecting}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                {debtGmailDisconnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Unlink className="h-4 w-4 mr-1" />
                )} {pc("disconnectDebtGmail")} </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-md border border-destructive/20 bg-destructive/5 p-3">
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <X className="h-4 w-4 text-destructive" /> {pc("debtEmailGmailIsNotConnected")} </span>
              <Button onClick={handleConnectDebtGmail} disabled={debtGmailConnecting} size="sm">
                {debtGmailConnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Link2 className="h-4 w-4 mr-1" />
                )} {pc("connectDebtGmail")} </Button>
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="debt-email-sender">{pc("senderEmail")}</Label>
              <Input
                id="debt-email-sender"
                type="email"
                value={debtEmailSender}
                onChange={(e) => setDebtEmailSender(e.target.value)}
                placeholder="no-reply@bmq.vn"
              />
              <p className="text-xs text-muted-foreground">{pc("recommended")} <code>no-reply@bmq.vn</code></p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="debt-email-cc">{pc("defaultCc")}</Label>
              <Input
                id="debt-email-cc"
                type="text"
                value={debtEmailCc}
                onChange={(e) => setDebtEmailCc(e.target.value)}
                placeholder="ketoantruong@bmq.vn"
              />
              <p className="text-xs text-muted-foreground">{pc("separateMultipleEmailAddressesWithCommas")}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground"> {pc("whenSendingAs")} <code>no-reply@bmq.vn</code>{pc("connectOauthAs")} <code>no-reply@bmq.vn</code> {pc("inThisSection")} </p>
        </div>

        {/* PO Folder */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="po-folder"> {pc("poFolderPurchaseOrders")} </Label>
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
              <span className="ml-1 hidden sm:inline">{pc("test")}</span>
            </Button>
          </div>
        </div>

        {/* Receipts Folder */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="receipts-folder"> {pc("bankReceiptsFolderPaymentOrders")} </Label>
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
              <span className="ml-1 hidden sm:inline">{pc("test")}</span>
            </Button>
          </div>
        </div>
      </div>

        {/* Bank Receipts Patterns */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="receipts-unc-pattern">{pc("uncPathTemplate")}</Label>
            <Input
              id="receipts-unc-pattern"
              type="text"
              value={receiptsUncPattern}
              onChange={(e) => setReceiptsUncPattern(e.target.value)}
              placeholder="yyyy/MM/dd/UNC"
            />
            <p className="text-xs text-muted-foreground">{pc("example")} <code>yyyy/MM/dd/UNC</code></p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="receipts-qtm-pattern">{pc("qtmPathTemplate")}</Label>
            <Input
              id="receipts-qtm-pattern"
              type="text"
              value={receiptsQtmPattern}
              onChange={(e) => setReceiptsQtmPattern(e.target.value)}
              placeholder="yyyy/MM/dd/QTM"
            />
            <p className="text-xs text-muted-foreground">{pc("example")} <code>yyyy/MM/dd/QTM</code></p>
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
          )} {pc("saveSettings")} </Button>
      </div>
    </div>
  );
}

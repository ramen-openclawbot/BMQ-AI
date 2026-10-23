import { useState, useEffect } from "react";
import { LogOut, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/components/settings/SettingsKit";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { supabase } from "@/integrations/supabase/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const Settings = () => {
  const { user, profile, signOut, refreshProfile } = useAuth();
  const { language, setLanguage, t } = useLanguage();
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(profile?.full_name || user?.user_metadata?.full_name || "");
  }, [profile, user]);

  const handleSaveProfile = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: displayName })
        .eq("user_id", user.id);
      
      if (error) throw error;
      await refreshProfile();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Profile update failed:", message);
    } finally {
      setSaving(false);
    }
  };

  const isVi = language !== "en";
  const nameChanged = displayName.trim() !== (profile?.full_name || user?.user_metadata?.full_name || "").trim();

  return (
    <SettingsPage title={t.settingsTitle}>
      <SettingsGroup id="profile" title={t.profile}>
        <SettingsRow label={t.email} value={user?.email || "—"} />
        <SettingsRow dataAttr="bmq-settings-name" label={t.displayName} value={<b>{displayName || "—"}</b>}>
          <label className="st-field">
            <span>{t.displayName}</span>
            <Input id="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t.enterYourName} />
          </label>
          <div className="st-panel-actions">
            <button type="button" className="st-link is-primary" onClick={() => void handleSaveProfile()} disabled={saving || !nameChanged || !displayName.trim()}>
              {saving ? t.saving : t.saveProfile}
            </button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup id="language" title={isVi ? "Hiển thị" : "Display"}>
        <SettingsRow
          label={t.language}
          action={
            <Select value={language} onValueChange={(value: "en" | "vi") => setLanguage(value)}>
              <SelectTrigger className="h-9 w-36" aria-label={t.language}>
                <SelectValue><span>{language === "en" ? "English" : "Tiếng Việt"}</span></SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en"><span>English</span></SelectItem>
                <SelectItem value="vi"><span>Tiếng Việt</span></SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow label={t.appearance} value={isVi ? "Sáng" : "Light"} />
      </SettingsGroup>

      <SettingsGroup title={t.notifications}>
        <SettingsRow label={t.lowStockAlerts} action={<Switch defaultChecked aria-label={t.lowStockAlerts} />} />
        <SettingsRow label={t.paymentRequestUpdates} action={<Switch defaultChecked aria-label={t.paymentRequestUpdates} />} />
      </SettingsGroup>

      <SettingsGroup id="security" title={t.security}>
        <SettingsRow
          label={isVi ? "Tải lại trang" : "Reload page"}
          hint={isVi ? "Khi giao diện hiển thị sai" : "If the page looks wrong"}
          action={<button type="button" className="st-link" onClick={() => window.location.reload()}><RefreshCw />{isVi ? "Tải lại" : "Reload"}</button>}
        />
        <SettingsRow
          label={isVi ? "Phiên đăng nhập" : "Session"}
          hint={user?.email || undefined}
          action={<button type="button" className="st-link is-danger" onClick={() => void signOut()} data-bmq-settings-signout><LogOut />{t.signOut}</button>}
        />
      </SettingsGroup>
    </SettingsPage>
  );
};

export default Settings;

import { useState, useEffect } from "react";
import { User, Bell, Shield, Palette, Globe, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { GoogleDriveSettings } from "@/components/settings/GoogleDriveSettings";
import { AppVersionSection } from "@/components/settings/AppVersionSection";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const Settings = () => {
  const { user, profile, signOut, refreshProfile } = useAuth();
  const { theme, toggleTheme } = useTheme();
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
    } catch (error: any) {
      console.error("Profile update failed:", error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">
          {t.settingsTitle}
        </h1>
        <p className="text-muted-foreground mt-1">
          {t.settingsDescription}
        </p>
      </div>

      {/* Profile Section */}
      <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-3">
          <User className="h-5 w-5 text-primary" />
          <h2 className="font-display font-semibold text-lg">{t.profile}</h2>
        </div>
        <Separator />
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t.email}</Label>
            <Input id="email" value={user?.email || ""} disabled />
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">{t.displayName}</Label>
            <Input 
              id="name" 
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t.enterYourName}
            />
          </div>
          <Button onClick={handleSaveProfile} disabled={saving}>
            {saving ? t.saving : t.saveProfile}
          </Button>
        </div>
      </div>

      {/* Language Section */}
      <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Globe className="h-5 w-5 text-primary" />
          <h2 className="font-display font-semibold text-lg">{t.language}</h2>
        </div>
        <Separator />
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{t.language}</p>
            <p className="text-sm text-muted-foreground">{t.languageDesc}</p>
          </div>
          <Select value={language} onValueChange={(value: "en" | "vi") => setLanguage(value)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="vi">Tiếng Việt</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Notifications Section */}
      <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-primary" />
          <h2 className="font-display font-semibold text-lg">{t.notifications}</h2>
        </div>
        <Separator />
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{t.lowStockAlerts}</p>
              <p className="text-sm text-muted-foreground">{t.lowStockAlertsDesc}</p>
            </div>
            <Switch defaultChecked />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{t.paymentRequestUpdates}</p>
              <p className="text-sm text-muted-foreground">{t.paymentRequestUpdatesDesc}</p>
            </div>
            <Switch defaultChecked />
          </div>
        </div>
      </div>

      {/* Appearance Section */}
      <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Palette className="h-5 w-5 text-primary" />
          <h2 className="font-display font-semibold text-lg">{t.appearance}</h2>
        </div>
        <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{t.darkMode}</p>
              <p className="text-sm text-muted-foreground">{t.darkModeDesc}</p>
            </div>
            <Switch checked={theme === "dark"} onCheckedChange={toggleTheme} />
          </div>
      </div>

      {/* Security Section */}
      <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Shield className="h-5 w-5 text-primary" />
          <h2 className="font-display font-semibold text-lg">{t.security}</h2>
        </div>
        <Separator />
        <div className="space-y-4">
          <Button variant="outline">{t.changePassword}</Button>
          <div>
            <Button variant="destructive" onClick={signOut}>
              {t.signOut}
            </Button>
          </div>
        </div>
      </div>

      {/* Google Drive Integration */}
      <GoogleDriveSettings />

      {/* Troubleshooting Section */}
      <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-3">
          <RefreshCw className="h-5 w-5 text-primary" />
          <h2 className="font-display font-semibold text-lg">{t.troubleshooting || "Troubleshooting"}</h2>
        </div>
        <Separator />
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Reload Page</p>
            <p className="text-sm text-muted-foreground">
              If you're experiencing display issues, try reloading the page.
            </p>
          </div>
          <Button 
            variant="outline" 
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Reload
          </Button>
        </div>
      </div>

      {/* App Version Section */}
      <AppVersionSection />
    </div>
  );
};

export default Settings;

import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Formats a timestamp into version format: v1.YYYY.MMDD
 */
function formatVersion(timestamp: string): string {
  try {
    const date = new Date(parseInt(timestamp));
    if (isNaN(date.getTime())) {
      return "v1.0.0";
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `v1.${year}.${month}${day}`;
  } catch {
    return "v1.0.0";
  }
}

export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const { data } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "app_version")
          .single();

        if (data?.value) {
          setVersion(formatVersion(data.value));
        }
      } catch (error) {
        console.error("Failed to fetch app version:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchVersion();
  }, []);

  return { version, isLoading };
}

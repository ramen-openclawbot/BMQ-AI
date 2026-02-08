import { supabase } from "@/integrations/supabase/client";

// Helper to bypass type checking for tables not yet in generated types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = supabase as any;

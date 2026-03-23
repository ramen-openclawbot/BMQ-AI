import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Pencil, Save, X, Trash2 } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import ExcelJS from "exceljs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SalesPoQuickViewEditor } from "@/components/mini-crm/SalesPoQuickViewEditor";
import { KnowledgeBaseProfileEditor } from "@/components/mini-crm/KnowledgeBaseProfileEditor";
import {
  buildManualSummaryMessage,
  buildPoDraftSignature,
  calcDraftItemLineTotal,
  calcDraftItemsAmount,
  calcSafeTotal,
  calcSubtotalFromItems,
  calcTotalFromRawPayload,
  createDraftFromPoRow,
  createEmptyPoDraftItem,
  extractDeliveryDateFromSubject,
  extractPoNumberFromSubject,
  formatVnd,
  getPoDraftItemsFromRow,
  hasManualPoDraft,
  normalizePoDraftItems,
  parseDraftItemsForSave,
} from "@/components/mini-crm/poDraftUtils";
import {
  composeKbAiMarkers,
  extractKbAiConfig,
  extractKbBusinessDescription,
  stripKbAiMarkers,
  type KbAiParseSuggestion,
} from "@/components/mini-crm/kbAiUtils";

const GROUP_OPTIONS = [
  { value: "banhmi_point", label: "Bán lẻ" },
  { value: "banhmi_agency", label: "Đại lý" },
  { value: "online", label: "Online" },
  { value: "b2b", label: "B2B" },
];

const GROUP_LABEL_MAP: Record<string, string> = GROUP_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {} as Record<string, string>);

const PRODUCT_GROUP_OPTIONS = [
  { value: "banhmi", label: "Bánh mì" },
  { value: "banhngot", label: "Bánh ngọt" },
];
const PRODUCT_GROUP_LABEL_MAP: Record<string, string> = PRODUCT_GROUP_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {} as Record<string, string>);

const KB_PO_MODE_LABEL: Record<string, string> = {
  daily_new_po: "PO mới theo ngày",
  cumulative_snapshot: "PO cộng dồn (delta)",
};

const KB_PO_SOURCE_LABEL: Record<string, string> = {
  attachment_first: "Ưu tiên parse file đính kèm",
  email_body_only: "PO từ nội dung email",
};

const stripKbSystemMarkers = (note?: string | null) =>
  stripKbAiMarkers(
    String(note || "")
      .replace(/\s*\[PO_SOURCE:[^\]]+\]\s*/gi, " ")
      .replace(/\[EMAIL_BODY_TEMPLATE_START\][\s\S]*?\[EMAIL_BODY_TEMPLATE_END\]/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );

const extractEmailBodyTemplate = (note?: string | null) => {
  const m = String(note || "").match(/\[EMAIL_BODY_TEMPLATE_START\]([\s\S]*?)\[EMAIL_BODY_TEMPLATE_END\]/i);
  return String(m?.[1] || "").trim();
};

const getKbPoSource = (kb?: any) => {
  const hay = `${String(kb?.operational_notes || "")} ${String(kb?.calculation_notes || "")}`.toLowerCase();
  if (/\[po_source\s*:\s*email_body_only\]/i.test(hay) || /po_source\s*=\s*email_body_only/i.test(hay)) return "email_body_only";
  return "attachment_first";
};

const injectPoSourceMarker = (note: string, source: string) => {
  const base = stripKbSystemMarkers(note);
  const marker = `[PO_SOURCE:${source}]`;
  return `${base ? `${base} ` : ""}${marker}`.trim();
};

const composeOperationalNotes = (
  note: string,
  source: string,
  emailBodyTemplate: string,
  businessDescription = "",
  aiConfig: KbAiParseSuggestion | null = null,
) => {
  const withSource = injectPoSourceMarker(note, source);
  const sample = String(emailBodyTemplate || "").trim();
  const base = sample
    ? `${withSource}
[EMAIL_BODY_TEMPLATE_START]
${sample}
[EMAIL_BODY_TEMPLATE_END]`.trim()
    : withSource;
  const aiMarkers = composeKbAiMarkers(businessDescription, aiConfig);
  return [base, aiMarkers].filter(Boolean).join("\n").trim();
};

const normalizeIsoDay = (s?: string | null) => {
  if (!s) return "";
  const v = String(s).trim();
  if (!v) return "";
  return v.length >= 10 ? v.slice(0, 10) : v;
};

const buildItemsSignature = (items: any[]) => {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items
    .map((it: any) => `${String(it?.sku || "").trim()}|${String(it?.product_name || "").trim().toLowerCase()}|${Number(it?.qty || it?.quantity || 0)}`)
    .sort()
    .join(";");
};

const getReadableError = (e: any) => {
  if (!e) return "Không rõ nguyên nhân";
  const parts = [e?.message, e?.details, e?.hint].filter(Boolean);
  if (parts.length) return parts.join(" | ");
  try {
    return JSON.stringify(e);
  } catch {
    return "Không rõ nguyên nhân";
  }
};

const normalizeVietnameseText = (value?: string | null) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

const parseEmailBodyToProductionItems = (subject?: string, body?: string, aiConfig?: KbAiParseSuggestion | null) => {
  const text = String(body || "").replace(/\r/g, "\n");
  const chunks = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((line) => line.split(/\s{2,}|(?=\d+\.)/g).map((x) => x.trim()).filter(Boolean));

  const aiExchangeKeywords = Array.isArray(aiConfig?.exchange_keywords) && aiConfig?.exchange_keywords.length > 0
    ? aiConfig.exchange_keywords.map((x) => normalizeVietnameseText(String(x || "")).replace(/\s+/g, "\\s*"))
    : ["doi", "đổi"].map((x) => normalizeVietnameseText(x).replace(/\s+/g, "\\s*"));
  const exchangeRegex = new RegExp(`(?:\\+\\s*)?(?:${aiExchangeKeywords.join("|")})\\s*[:=]?\\s*([0-9]+)`, "i");
  const prefersCommaSegments = String(aiConfig?.item_split_rule || "").toLowerCase().includes("comma") || String(aiConfig?.item_split_rule || "").toLowerCase().includes("segment");
  const normalize = (s: string) => s
    .replace(/^[-•]+\s*/, "")
    .replace(/^\d+[.)]?\s*/, "")
    .replace(/Ð/g, "Đ")
    .replace(/\bdoi\b/gi, "đổi")
    .trim();
  const cleanNote = (s: string) => String(s || "").trim().replace(/^[-,;.]\s*/, "");
  const extractExchangeQty = (s: string) => {
    const m = String(s || "").match(exchangeRegex);
    return Number(m?.[1] || 0);
  };
  const pushParsedItem = (locationRaw: string, qtyBaseRaw: any, noteRaw = "") => {
    const location = normalize(String(locationRaw || "").replace(/:$/, "")).trim();
    const qtyBase = Number(qtyBaseRaw || 0);
    const note = cleanNote(String(noteRaw || ""));
    const qtyExchange = extractExchangeQty(note);
    const formula = String(aiConfig?.quantity_formula?.expression || "qty_total = qty_base + qty_exchange").toLowerCase();
    const qtyTotal = formula.includes("-")
      ? (Number.isFinite(qtyBase) ? qtyBase : 0) - (Number.isFinite(qtyExchange) ? qtyExchange : 0)
      : (Number.isFinite(qtyBase) ? qtyBase : 0) + (Number.isFinite(qtyExchange) ? qtyExchange : 0);
    if (!location) return false;
    items.push({
      sku: "",
      product_name: location,
      unit: "cái",
      qty_base: qtyBase,
      qty_exchange: qtyExchange,
      qty_total: qtyTotal,
      qty: qtyTotal,
      unit_price: 0,
      line_total: 0,
      parse_source: aiConfig ? "email_body_ai_rule" : "email_body",
      note,
    });
    return true;
  };

  const items: any[] = [];
  for (const raw of chunks) {
    const line = normalize(raw);
    if (!line) continue;

    const compactSegments = line.split(/\s*,\s*/).map((seg) => normalize(seg)).filter(Boolean);
    if ((prefersCommaSegments || compactSegments.length > 1) && compactSegments.some((seg) => seg.includes(":"))) {
      let parsedCompact = 0;
      for (const seg of compactSegments) {
        let mCompact = seg.match(/^(.+?)\s*:\s*\(([^)]*?)\)$/i);
        if (mCompact) {
          const inside = String(mCompact[2] || "");
          const qtyBase = Number((inside.match(/\d+/)?.[0] || "0"));
          if (pushParsedItem(mCompact[1], qtyBase, inside)) parsedCompact += 1;
          continue;
        }

        mCompact = seg.match(/^(.+?)\s*:\s*([0-9]+)\s*(.*)$/i);
        if (mCompact) {
          if (pushParsedItem(mCompact[1], mCompact[2], mCompact[3])) parsedCompact += 1;
          continue;
        }

        mCompact = seg.match(/^(.+?)\s+([0-9]+)\s*:\s*(.*)$/i);
        if (mCompact) {
          if (pushParsedItem(mCompact[1], mCompact[2], mCompact[3])) parsedCompact += 1;
          continue;
        }
      }
      if (parsedCompact > 0) continue;
    }

    let m = line.match(/^(.+?)\s*:\s*([0-9]+)(.*)$/i);
    if (m) {
      if (pushParsedItem(m[1], m[2], m[3])) continue;
    }

    m = line.match(/^(.+?)\s+([0-9]+)\s*:\s*(.*)$/i);
    if (m) {
      if (pushParsedItem(m[1], m[2], m[3])) continue;
    }

    m = line.match(/^(.+?)\s*:\s*\(([^)]*?)\)$/i);
    if (m) {
      const inside = String(m[2] || "");
      const qtyBase = Number((inside.match(/\d+/)?.[0] || "0"));
      if (pushParsedItem(m[1], qtyBase, inside)) continue;
    }
  }

  const deliveryDate = extractDeliveryDateFromSubject(subject) || null;
  return { items, deliveryDate, aiApplied: Boolean(aiConfig) };
};


export default function MiniCrm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const location = useLocation();
  const isSalesPoPage = location.pathname === "/sales-po-inbox";

  const [customerName, setCustomerName] = useState("");
  const [customerGroup, setCustomerGroup] = useState("banhmi_point");
  const [productGroup, setProductGroup] = useState("banhmi");
  const [emailsInput, setEmailsInput] = useState("");
  const [editingCustomerId, setEditingCustomerId] = useState<string | null>(null);
  const [editCustomerName, setEditCustomerName] = useState("");
  const [editCustomerGroup, setEditCustomerGroup] = useState("banhmi_point");
  const [editProductGroup, setEditProductGroup] = useState("banhmi");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editEmailsInput, setEditEmailsInput] = useState("");
  const [editOriginalEmailsInput, setEditOriginalEmailsInput] = useState("");
  const [editFeedback, setEditFeedback] = useState<string>("");
  const [templateFileName, setTemplateFileName] = useState<string>("");
  const [templatePreview, setTemplatePreview] = useState<any | null>(null);
  const [pendingTemplateFileName, setPendingTemplateFileName] = useState<string>("");
  const [pendingTemplatePreview, setPendingTemplatePreview] = useState<any | null>(null);
  const [templateConfirmOpen, setTemplateConfirmOpen] = useState<boolean>(false);
  const [templateReviewDraft, setTemplateReviewDraft] = useState<any | null>(null);
  const [templateReviewTouched, setTemplateReviewTouched] = useState<boolean>(false);
  const [templateAiContext, setTemplateAiContext] = useState<string>("");
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const [poSummaryDraft, setPoSummaryDraft] = useState<any>({});
  const [poDraftBaseSignature, setPoDraftBaseSignature] = useState<string>("");
  const [poDraftHydrationNonce, setPoDraftHydrationNonce] = useState(0);
  const [pendingParseAction, setPendingParseAction] = useState<null | "attachment" | "email_body">(null);
  const poDraftHydrationKeyRef = useRef<string>("");
  const [savePoStatus, setSavePoStatus] = useState<string>("");
  const [postRevenueStatus, setPostRevenueStatus] = useState<string>("");
  const [poDateFrom, setPoDateFrom] = useState<string>("");
  const [poDateTo, setPoDateTo] = useState<string>("");
  const [poNeedsDeltaReviewOnly, setPoNeedsDeltaReviewOnly] = useState<boolean>(false);
  const [customerSearch, setCustomerSearch] = useState<string>("");
  const [poCustomerFilter, setPoCustomerFilter] = useState<string>("all");
  const [poModeFilter, setPoModeFilter] = useState<string>("all");
  const [syncDate, setSyncDate] = useState<string>(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = `${now.getMonth() + 1}`.padStart(2, "0");
    const d = `${now.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${d}`;
  });
  const [syncDebug, setSyncDebug] = useState<any | null>(null);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>("idle");
  const [syncError, setSyncError] = useState<string>("");
  const [previewItems, setPreviewItems] = useState<any[]>([]);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const [selectedPreviewIds, setSelectedPreviewIds] = useState<string[]>([]);
  const [confirmTemplateRead, setConfirmTemplateRead] = useState<boolean>(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [viewCustomer, setViewCustomer] = useState<any | null>(null);
  const [setupContractFile, setSetupContractFile] = useState<File | null>(null);
  const [setupPriceRows, setSetupPriceRows] = useState<Array<{ skuId: string; price: string }>>([{ skuId: "", price: "" }]);
  const [setupEmailBodyTemplate, setSetupEmailBodyTemplate] = useState("");
  const [setupIsNpp, setSetupIsNpp] = useState(false);
  const [setupUsesNpp, setSetupUsesNpp] = useState(false);
  const [setupSuppliedByNppCustomerId, setSetupSuppliedByNppCustomerId] = useState("");
  const [editContractFile, setEditContractFile] = useState<File | null>(null);
  const [editPriceRows, setEditPriceRows] = useState<Array<{ skuId: string; price: string }>>([{ skuId: "", price: "" }]);
  const [editKbProfileName, setEditKbProfileName] = useState("Default Customer Knowledge");
  const [editKbPoMode, setEditKbPoMode] = useState("daily_new_po");
  const [editKbPoSource, setEditKbPoSource] = useState("attachment_first");
  const [editKbCalcNotes, setEditKbCalcNotes] = useState("");
  const [editKbOperationalNotes, setEditKbOperationalNotes] = useState("");
  const [editEmailBodyTemplate, setEditEmailBodyTemplate] = useState("");
  const [editKbBusinessDescription, setEditKbBusinessDescription] = useState("");
  const [kbAiSuggestion, setKbAiSuggestion] = useState<KbAiParseSuggestion | null>(null);
  const [kbAiStatus, setKbAiStatus] = useState("");
  const [editIsNpp, setEditIsNpp] = useState(false);
  const [editUsesNpp, setEditUsesNpp] = useState(false);
  const [editSuppliedByNppCustomerId, setEditSuppliedByNppCustomerId] = useState("");
  const [kbChangeNote, setKbChangeNote] = useState("");
  const [agentCommand, setAgentCommand] = useState("");
  const [agentDraft, setAgentDraft] = useState<any | null>(null);
  const [agentStatus, setAgentStatus] = useState("");
  const [agentMissingFields, setAgentMissingFields] = useState<string[]>([]);
  const [agentPendingSlot, setAgentPendingSlot] = useState<string | null>(null);
  const [agentChatLog, setAgentChatLog] = useState<Array<{ role: "user" | "agent"; text: string }>>([]);
  const [agentActionTimeline, setAgentActionTimeline] = useState<Array<{ step: string; status: "pending" | "done" | "error"; detail?: string }>>([]);
  const [agentExecutionArmed, setAgentExecutionArmed] = useState(false);

  const { data: gmailConnectedEmail } = useQuery({
    queryKey: ["gmail-connected-email"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "google_gmail_connected_email")
        .maybeSingle();
      if (error) throw error;
      return data?.value || null;
    },
  });

  const { data: customers = [] } = useQuery({
    queryKey: ["mini-crm-customers"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customers")
        .select("*, mini_crm_customer_emails(*)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const vietjetCustomerId = useMemo(() => {
    const hit = customers.find((c: any) => String(c?.customer_name || "").toLowerCase().includes("vietjet"));
    return hit?.id || null;
  }, [customers]);

  const { data: finishedSkus = [] } = useQuery({
    queryKey: ["finished-skus"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("product_skus")
        .select("id, sku_code, product_name, sku_type, category")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data || []).filter((s: any) => String(s.sku_type || "").toLowerCase() === "finished_good" || String(s.category || "").toLowerCase().includes("thành phẩm"));
    },
    enabled: !isSalesPoPage,
  });

  const { data: customerContracts = [] } = useQuery({
    queryKey: ["mini-crm-customer-contracts"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customer_contracts")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !isSalesPoPage,
  });

  const { data: customerPriceList = [] } = useQuery({
    queryKey: ["mini-crm-customer-price-list"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customer_price_list")
        .select("*")
        .eq("is_active", true)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !isSalesPoPage,
  });

  const { data: poTemplates = [] } = useQuery({
    queryKey: ["mini-crm-po-templates"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_po_templates")
        .select("*")
        .eq("is_active", true)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !isSalesPoPage,
  });

  const { data: poInbox = [] } = useQuery({
    queryKey: ["customer-po-inbox"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select("*, mini_crm_customers(customer_name)")
        .order("received_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: customerKnowledgeProfiles = [] } = useQuery({
    queryKey: ["mini-crm-knowledge-profiles"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_knowledge_profiles")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: revenueAuditRows = [] } = useQuery({
    queryKey: ["po-revenue-post-audit"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("po_revenue_post_audit")
        .select("*, mini_crm_customers(customer_name)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data || [];
    },
    enabled: isSalesPoPage,
  });

  const { data: knowledgeProfileVersions = [] } = useQuery({
    queryKey: ["mini-crm-knowledge-profile-versions"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_knowledge_profile_versions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return data || [];
    },
    enabled: !isSalesPoPage,
  });

  const { data: knowledgeChangeRequests = [] } = useQuery({
    queryKey: ["mini-crm-knowledge-change-requests"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_knowledge_change_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return data || [];
    },
    enabled: !isSalesPoPage,
  });

  const startEditCustomer = (c: any) => {
    setEditFeedback("");
    setEditingCustomerId(c.id);
    setEditCustomerName(c.customer_name || "");
    setEditCustomerGroup(c.customer_group || "banhmi_point");
    setEditProductGroup(c.product_group || "banhmi");
    setEditIsActive(Boolean(c.is_active));
    setEditIsNpp(Boolean(c.is_npp));
    setEditUsesNpp(Boolean(c.supplied_by_npp_customer_id));
    setEditSuppliedByNppCustomerId(String(c.supplied_by_npp_customer_id || ""));
    const emails = (c.mini_crm_customer_emails || []).map((e: any) => e.email).join(", ");
    setEditEmailsInput(emails);
    setEditOriginalEmailsInput(emails);
    setTemplateFileName("");
    setTemplatePreview(null);
    setTemplateAiContext("");
    setPendingTemplateFileName("");
    setPendingTemplatePreview(null);
    setTemplateConfirmOpen(false);
    setEditContractFile(null);
    const currentPrices = customerPriceList.filter((x: any) => x.customer_id === c.id);
    setEditPriceRows(currentPrices.length ? currentPrices.map((p: any) => ({ skuId: p.sku_id, price: String(Number(p.price_vnd_per_unit || 0)) })) : [{ skuId: "", price: "" }]);

    const kb = customerKnowledgeProfiles.find((x: any) => x.customer_id === c.id);
    setEditKbProfileName(String(kb?.profile_name || `${c.customer_name || "Customer"} Knowledge`));
    setEditKbPoMode(String(kb?.po_mode || "daily_new_po"));
    setEditKbPoSource(getKbPoSource(kb));
    setEditKbCalcNotes(String(kb?.calculation_notes || ""));
    setEditKbOperationalNotes(stripKbSystemMarkers(String(kb?.operational_notes || "")));
    setEditEmailBodyTemplate(extractEmailBodyTemplate(String(kb?.operational_notes || "")));
    setEditKbBusinessDescription(String(kb?.business_description || extractKbBusinessDescription(String(kb?.operational_notes || ""))));
    setKbAiSuggestion((kb?.ai_parse_config as KbAiParseSuggestion | null) || extractKbAiConfig(String(kb?.operational_notes || "")));
    setTemplateAiContext(String(kb?.template_context || ""));
    setKbAiStatus("");
    setKbChangeNote("");
  };

  const cancelEditCustomer = () => {
    setEditFeedback("");
    setEditingCustomerId(null);
    setEditCustomerName("");
    setEditCustomerGroup("banhmi_point");
    setEditProductGroup("banhmi");
    setEditIsActive(true);
    setEditIsNpp(false);
    setEditUsesNpp(false);
    setEditSuppliedByNppCustomerId("");
    setEditEmailsInput("");
    setEditOriginalEmailsInput("");
    setTemplateFileName("");
    setTemplatePreview(null);
    setTemplateAiContext("");
    setPendingTemplateFileName("");
    setPendingTemplatePreview(null);
    setTemplateConfirmOpen(false);
    setTemplateReviewDraft(null);
    setEditContractFile(null);
    setEditPriceRows([{ skuId: "", price: "" }]);
    setEditKbProfileName("Default Customer Knowledge");
    setEditKbPoMode("daily_new_po");
    setEditKbPoSource("attachment_first");
    setEditKbCalcNotes("");
    setEditKbOperationalNotes("");
    setEditEmailBodyTemplate("");
    setEditKbBusinessDescription("");
    setKbAiSuggestion(null);
    setKbAiStatus("");
    setKbChangeNote("");
  };

  const getNextTemplateVersion = async (customerId: string) => {
    const { data, error } = await (supabase as any)
      .from("mini_crm_po_templates")
      .select("version_no")
      .eq("customer_id", customerId)
      .order("version_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return Number(data?.version_no || 0) + 1;
  };

  const getNextKnowledgeProfileVersion = async (customerId: string) => {
    const { data, error } = await (supabase as any)
      .from("mini_crm_knowledge_profile_versions")
      .select("version_no")
      .eq("customer_id", customerId)
      .order("version_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return Number(data?.version_no || 0) + 1;
  };

  const parseAgentCreateCustomerCommand = (raw: string) => {
    const text = String(raw || "").trim();
    if (!text) throw new Error("Vui lòng nhập yêu cầu cho Agent UI");

    const findValue = (keys: string[]) => {
      for (const k of keys) {
        const re = new RegExp(`(?:^|[;,\n])\\s*${k}\\s*[:=]\\s*([^;\\n]+)`, "i");
        const m = text.match(re);
        if (m?.[1]) return String(m[1]).trim();
      }
      return "";
    };

    const inferredName = (() => {
      const m1 = text.match(/t[aạ]o\s+kh[aá]ch\s+h[aà]ng\s+([^,;\n]+)/i);
      if (m1?.[1]) return m1[1].trim();
      const m2 = text.match(/customer\s+([^,;\n]+)/i);
      if (m2?.[1]) return m2[1].trim();
      return "";
    })();

    const customerName = findValue(["ten", "tên", "name", "customer_name", "khach", "khách hàng"]) || inferredName;
    const customerGroupRaw = findValue(["group", "nhom", "nhóm", "customer_group"]) || (/\bb2b\b/i.test(text) ? "b2b" : "");
    const productGroupRaw = findValue(["product_group", "nhom_sp", "nhóm sản phẩm"]) || (/b[aá]nh\s*m[iì]/i.test(text) ? "banhmi" : "");
    const emailsRaw = findValue(["email", "emails", "mail"]);
    const poModeRaw = findValue(["po_mode", "mode", "kb_mode"]) || (/c[oộ]ng\s*d[oồ]n|cumulative/i.test(text) ? "cumulative" : "daily");
    const calcNotes = findValue(["calc", "calculation", "calculation_notes"]);
    const opsNotes = findValue(["ops", "operational", "operational_notes"]);

    const groupMap: Record<string, string> = {
      banle: "banhmi_point",
      "bán lẻ": "banhmi_point",
      dai_ly: "banhmi_agency",
      "đại lý": "banhmi_agency",
      online: "online",
      b2b: "b2b",
      banhmi_point: "banhmi_point",
      banhmi_agency: "banhmi_agency",
    };
    const productMap: Record<string, string> = {
      banhmi: "banhmi",
      "bánh mì": "banhmi",
      banhngot: "banhngot",
      "bánh ngọt": "banhngot",
    };

    const g = groupMap[String(customerGroupRaw || "").trim().toLowerCase()] || "b2b";
    const pg = productMap[String(productGroupRaw || "").trim().toLowerCase()] || "banhmi";
    const pm = String(poModeRaw || "").toLowerCase().includes("cum") ? "cumulative_snapshot" : "daily_new_po";

    const directEmails = String(emailsRaw || "").split(/[;,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /@/.test(s));
    const textEmails = Array.from(new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase())));
    const emails = Array.from(new Set([...directEmails, ...textEmails]));

    const missing: string[] = [];
    if (!customerName) missing.push("tên khách hàng");
    if (!emails.length) missing.push("ít nhất 1 email nhận diện");

    return {
      customer_name: customerName,
      customer_group: g,
      product_group: pg,
      emails,
      kb_profile_name: `${customerName || "Customer"} Knowledge`,
      kb_po_mode: pm,
      kb_calc_notes: calcNotes || null,
      kb_ops_notes: opsNotes || null,
      missing,
    };
  };

  const computeAgentMissing = (draft: any) => {
    const missing: string[] = [];
    if (!String(draft?.customer_name || "").trim()) missing.push("tên khách hàng");
    if (!Array.isArray(draft?.emails) || draft.emails.length === 0) missing.push("ít nhất 1 email nhận diện");
    return missing;
  };

  const mergeAgentSlotAnswer = (draft: any, slot: string, answer: string) => {
    const v = String(answer || "").trim();
    if (!v) return draft;
    if (slot === "tên khách hàng") {
      return { ...draft, customer_name: v, kb_profile_name: `${v} Knowledge` };
    }
    if (slot === "ít nhất 1 email nhận diện") {
      const emails = Array.from(new Set(v.split(/[;,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /@/.test(s))));
      return { ...draft, emails };
    }
    return draft;
  };

  const handleAgentCommandTurn = () => {
    const text = String(agentCommand || "").trim();
    if (!text) return;

    setAgentChatLog((prev) => [...prev, { role: "user", text }]);

    try {
      if (agentPendingSlot && agentDraft) {
        const nextDraft = mergeAgentSlotAnswer(agentDraft, agentPendingSlot, text);
        const missing = computeAgentMissing(nextDraft);
        setAgentDraft(nextDraft);
        setAgentMissingFields(missing);
        setAgentExecutionArmed(false);
        setAgentCommand("");
        if (missing.length) {
          setAgentPendingSlot(missing[0]);
          const ask = `Em cần bổ sung ${missing[0]}.`;
          setAgentStatus(`⚠️ ${ask}`);
          setAgentChatLog((prev) => [...prev, { role: "agent", text: ask }]);
        } else {
          setAgentPendingSlot(null);
          const ok = "Đã đủ thông tin. Anh xác nhận tạo khách hàng.";
          setAgentStatus(`✅ ${ok}`);
          setAgentChatLog((prev) => [...prev, { role: "agent", text: ok }]);
        }
        return;
      }

      const draft = parseAgentCreateCustomerCommand(text);
      const missing = computeAgentMissing(draft);
      setAgentDraft(draft);
      setAgentMissingFields(missing);
      setAgentExecutionArmed(false);
      setAgentCommand("");
      if (missing.length) {
        setAgentPendingSlot(missing[0]);
        const ask = `Em cần bổ sung ${missing[0]}.`;
        setAgentStatus(`⚠️ ${ask}`);
        setAgentChatLog((prev) => [...prev, { role: "agent", text: ask }]);
      } else {
        setAgentPendingSlot(null);
        const ok = "Đã parse xong. Anh bấm xác nhận để tạo khách hàng.";
        setAgentStatus(`✅ ${ok}`);
        setAgentChatLog((prev) => [...prev, { role: "agent", text: ok }]);
      }
    } catch (e: any) {
      const msg = e?.message || "Không đọc được yêu cầu";
      setAgentStatus(`❌ Parse lỗi: ${msg}`);
      setAgentChatLog((prev) => [...prev, { role: "agent", text: `Parse lỗi: ${msg}` }]);
    }
  };

  const summarizeTemplateDiff = (beforeSnap: any, afterSnap: any) => {
    const beforeItems = Array.isArray(beforeSnap?.items) ? beforeSnap.items : [];
    const afterItems = Array.isArray(afterSnap?.items) ? afterSnap.items : [];
    const changedItemCount = afterItems.reduce((acc: number, it: any, idx: number) => {
      const b = beforeItems[idx] || {};
      const changed = String(b.product || "") !== String(it.product || "") || String(b.qty ?? "") !== String(it.qty ?? "") || String(b.unitPrice ?? "") !== String(it.unitPrice ?? "") || String(b.lineTotal ?? "") !== String(it.lineTotal ?? "");
      return acc + (changed ? 1 : 0);
    }, 0);
    const changedDate = String(beforeSnap?.orderDate || "") !== String(afterSnap?.orderDate || "");
    const changedTotals = String(beforeSnap?.subtotal ?? "") !== String(afterSnap?.subtotal ?? "") || String(beforeSnap?.vat ?? "") !== String(afterSnap?.vat ?? "") || String(beforeSnap?.total ?? "") !== String(afterSnap?.total ?? "");
    return `date:${changedDate ? "changed" : "same"}; items_changed:${changedItemCount}; totals:${changedTotals ? "changed" : "same"}`;
  };

  const addCustomerMutation = useMutation({
    mutationFn: async () => {
      const trimmedName = customerName.trim();
      if (!trimmedName) throw new Error("Vui lòng nhập tên khách hàng");

      const { data: created, error: createError } = await (supabase as any)
        .from("mini_crm_customers")
        .insert({
          customer_name: trimmedName,
          customer_group: customerGroup,
          product_group: productGroup,
        })
        .select("id")
        .single();

      if (createError) throw createError;

      const emails = Array.from(new Set(
        emailsInput
          .split(/[;,\n]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      ));

      if (emails.length) {
        const { error: emailError } = await (supabase as any)
          .from("mini_crm_customer_emails")
          .insert(emails.map((email, idx) => ({ customer_id: created.id, email, is_primary: idx === 0 })));
        if (emailError) throw emailError;
      }
    },
    onSuccess: async () => {
      setCustomerName("");
      setProductGroup("banhmi");
      setEmailsInput("");
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] });
      toast({ title: "Thêm khách hàng thành công", description: "Mini-CRM đã cập nhật." });
    },
    onError: (e: any) => {
      const msg = e?.message || "Không thể thêm khách hàng";
      toast({ title: "Thêm khách hàng thất bại", description: msg, variant: "destructive" });
    },
  });

  const setupCustomerMutation = useMutation({
    mutationFn: async () => {
      const trimmedName = customerName.trim();
      if (!trimmedName) throw new Error("Vui lòng nhập tên khách hàng");
      if (!setupIsNpp && setupUsesNpp && !setupSuppliedByNppCustomerId) throw new Error("Vui lòng chọn nhà phân phối cung cấp hàng");

      const { data: created, error: createError } = await (supabase as any)
        .from("mini_crm_customers")
        .insert({ customer_name: trimmedName, customer_group: customerGroup, product_group: productGroup, is_npp: setupIsNpp, supplied_by_npp_customer_id: setupIsNpp ? null : (setupUsesNpp ? (setupSuppliedByNppCustomerId || null) : null) })
        .select("id")
        .single();
      if (createError) throw createError;

      const customerId = created.id;
      const emails = Array.from(new Set(
        emailsInput.split(/[;,\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
      ));
      if (emails.length) {
        const { error: emailError } = await (supabase as any)
          .from("mini_crm_customer_emails")
          .insert(emails.map((email, idx) => ({ customer_id: customerId, email, is_primary: idx === 0 })));
        if (emailError) throw emailError;
      }

      if (setupContractFile) {
        const filePath = `${customerId}/${Date.now()}-${setupContractFile.name}`;
        const { error: uploadError } = await (supabase as any).storage.from("customer-contracts").upload(filePath, setupContractFile, { upsert: false, contentType: setupContractFile.type || "application/pdf" });
        if (uploadError) throw uploadError;
        const { data: pub } = (supabase as any).storage.from("customer-contracts").getPublicUrl(filePath);
        const { error: contractError } = await (supabase as any)
          .from("mini_crm_customer_contracts")
          .insert({ customer_id: customerId, file_name: setupContractFile.name, file_url: pub?.publicUrl || filePath, file_size: setupContractFile.size, mime_type: setupContractFile.type || "application/pdf", is_active: true });
        if (contractError) throw contractError;
      }

      const validRows = setupPriceRows
        .map((r) => ({ sku_id: r.skuId, price_vnd_per_unit: Number(String(r.price || "").replace(/[^0-9]/g, "")) }))
        .filter((r) => r.sku_id && Number.isFinite(r.price_vnd_per_unit) && r.price_vnd_per_unit > 0);
      if (validRows.length) {
        const { error: priceError } = await (supabase as any)
          .from("mini_crm_customer_price_list")
          .insert(validRows.map((r) => ({ customer_id: customerId, sku_id: r.sku_id, price_vnd_per_unit: r.price_vnd_per_unit, currency: "VND", is_active: true })));
        if (priceError) throw priceError;
      }

      if (templatePreview?.parserConfig) {
        const versionNo = await getNextTemplateVersion(customerId);
        const { error: tplError } = await (supabase as any)
          .from("mini_crm_po_templates")
          .insert({
            customer_id: customerId,
            template_name: `Template v${versionNo} - ${new Date().toLocaleString("vi-VN")}`,
            file_name: templateFileName || "uploaded-template.xlsx",
            parser_config: { ...(templatePreview.parserConfig || {}), version_no: versionNo },
            sample_preview: templatePreview.sampleRows || [],
            confirmation_snapshot: templatePreview?.confirmationView || {},
            parse_confidence: Number(templatePreview?.confidenceScore || 1),
            version_no: versionNo,
            is_active: true,
          });
        if (tplError) throw tplError;
      }

      const kbSeedPayload = {
        customer_id: customerId,
        profile_name: `${trimmedName} Knowledge`,
        po_mode: "daily_new_po",
        profile_status: "active",
        calculation_notes: null,
        operational_notes: composeOperationalNotes("", "attachment_first", setupEmailBodyTemplate),
      };
      const { data: kbInserted, error: kbError } = await (supabase as any)
        .from("mini_crm_knowledge_profiles")
        .insert(kbSeedPayload)
        .select("id,customer_id,profile_name,po_mode,profile_status,calculation_notes,operational_notes")
        .single();
      if (kbError) throw kbError;

      const kbVersionNo = await getNextKnowledgeProfileVersion(customerId);
      const { error: kbVersionError } = await (supabase as any)
        .from("mini_crm_knowledge_profile_versions")
        .insert({
          customer_id: customerId,
          knowledge_profile_id: kbInserted?.id || null,
          version_no: kbVersionNo,
          profile_name: kbInserted?.profile_name || kbSeedPayload.profile_name,
          po_mode: kbInserted?.po_mode || kbSeedPayload.po_mode,
          profile_status: kbInserted?.profile_status || kbSeedPayload.profile_status,
          calculation_notes: kbInserted?.calculation_notes || null,
          operational_notes: kbInserted?.operational_notes || null,
          changed_by: "mini-crm-ui",
          change_note: "Initial knowledge profile",
          is_active: true,
          effective_from: new Date().toISOString(),
        });
      if (kbVersionError) throw kbVersionError;
    },
    onSuccess: async () => {
      setSetupModalOpen(false);
      setCustomerName("");
      setCustomerGroup("banhmi_point");
      setProductGroup("banhmi");
      setEmailsInput("");
      setSetupContractFile(null);
      setSetupPriceRows([{ skuId: "", price: "" }]);
      setSetupEmailBodyTemplate("");
      setSetupIsNpp(false);
      setSetupUsesNpp(false);
      setSetupSuppliedByNppCustomerId("");
      setTemplateFileName("");
      setTemplatePreview(null);
      setTemplateAiContext("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-contracts"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-price-list"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-po-templates"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profiles"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profile-versions"] }),
      ]);
      toast({ title: "Thiết lập khách hàng thành công" });
    },
    onError: (e: any) => {
      toast({ title: "Thiết lập khách hàng thất bại", description: e?.message || "Không thể lưu thiết lập", variant: "destructive" });
    },
  });

  const agentCreateCustomerMutation = useMutation({
    mutationFn: async (draft: any) => {
      const executionPlan = [
        "Tạo bản ghi customer",
        "Tạo email nhận diện",
        "Tạo KB profile active",
        "Tạo KB version",
        "Rollback customer nếu lỗi",
      ];
      const runtimeTimeline: Array<{ step: string; status: "pending" | "done" | "error"; detail?: string }> = [
        { step: "Tạo customer", status: "pending" },
        { step: "Tạo emails", status: "pending" },
        { step: "Tạo KB profile", status: "pending" },
        { step: "Tạo KB version", status: "pending" },
      ];
      setAgentActionTimeline(runtimeTimeline);

      const markStep = (step: string, status: "pending" | "done" | "error", detail?: string) => {
        const idx = runtimeTimeline.findIndex((x) => x.step === step);
        if (idx >= 0) runtimeTimeline[idx] = { ...runtimeTimeline[idx], status, detail };
        setAgentActionTimeline([...runtimeTimeline]);
      };

      let createdCustomerId: string | null = null;
      let rolledBack = false;

      try {
        const { data: created, error: createError } = await (supabase as any)
          .from("mini_crm_customers")
          .insert({
            customer_name: draft.customer_name,
            customer_group: draft.customer_group,
            product_group: draft.product_group,
            is_active: true,
          })
          .select("id, customer_name")
          .single();
        if (createError || !created?.id) throw createError || new Error("Không tạo được khách hàng");
        createdCustomerId = created.id;
        markStep("Tạo customer", "done", created.customer_name);

        if (Array.isArray(draft.emails) && draft.emails.length) {
          const { error: emailError } = await (supabase as any)
            .from("mini_crm_customer_emails")
            .insert(draft.emails.map((email: string, idx: number) => ({ customer_id: created.id, email, is_primary: idx === 0 })));
          if (emailError) throw emailError;
        }
        markStep("Tạo emails", "done", `${Array.isArray(draft.emails) ? draft.emails.length : 0} email`);

        const { data: kbInserted, error: kbError } = await (supabase as any)
          .from("mini_crm_knowledge_profiles")
          .insert({
            customer_id: created.id,
            profile_name: draft.kb_profile_name,
            po_mode: draft.kb_po_mode,
            profile_status: "active",
            calculation_notes: draft.kb_calc_notes,
            operational_notes: draft.kb_ops_notes,
          })
          .select("id,profile_name,po_mode,profile_status,calculation_notes,operational_notes")
          .single();
        if (kbError) throw kbError;
        markStep("Tạo KB profile", "done", kbInserted?.profile_name || "ok");

        const versionNo = await getNextKnowledgeProfileVersion(created.id);
        const { error: kbVerError } = await (supabase as any)
          .from("mini_crm_knowledge_profile_versions")
          .insert({
            customer_id: created.id,
            knowledge_profile_id: kbInserted?.id || null,
            version_no: versionNo,
            profile_name: kbInserted?.profile_name || draft.kb_profile_name,
            po_mode: kbInserted?.po_mode || draft.kb_po_mode,
            profile_status: kbInserted?.profile_status || "active",
            calculation_notes: kbInserted?.calculation_notes || draft.kb_calc_notes || null,
            operational_notes: kbInserted?.operational_notes || draft.kb_ops_notes || null,
            changed_by: "agent-ui",
            change_note: "Created from Agent UI",
            is_active: true,
            effective_from: new Date().toISOString(),
          });
        if (kbVerError) throw kbVerError;
        markStep("Tạo KB version", "done", `v${versionNo}`);

        await (supabase as any).from("mini_crm_agent_ui_audit_logs").insert({
          action_name: "create_customer",
          actor: "agent-ui",
          input_payload: { raw_command: agentCommand },
          normalized_payload: draft,
          execution_plan: executionPlan,
          action_timeline: runtimeTimeline,
          result_status: "success",
          result_message: `Created customer ${created.customer_name}`,
          customer_name: draft.customer_name,
          created_customer_id: created.id,
          rolled_back: false,
        });

        return created;
      } catch (e: any) {
        if (createdCustomerId) {
          await (supabase as any).from("mini_crm_customers").delete().eq("id", createdCustomerId);
          rolledBack = true;
        }
        const errMsg = e?.message || "Unknown error";
        setAgentActionTimeline((prev) => prev.map((x) => (x.status === "pending" ? { ...x, status: "error", detail: `rollback: ${errMsg}` } : x)));

        await (supabase as any).from("mini_crm_agent_ui_audit_logs").insert({
          action_name: "create_customer",
          actor: "agent-ui",
          input_payload: { raw_command: agentCommand },
          normalized_payload: draft,
          execution_plan: executionPlan,
          action_timeline: runtimeTimeline,
          result_status: "failed",
          result_message: errMsg,
          customer_name: draft?.customer_name || null,
          created_customer_id: createdCustomerId,
          rolled_back: rolledBack,
        });
        throw e;
      }
    },
    onSuccess: async (created: any) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profiles"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profile-versions"] }),
      ]);
      setAgentStatus(`✅ Agent đã tạo khách hàng: ${created?.customer_name || ""}`);
      setAgentChatLog((prev) => [...prev, { role: "agent", text: `Đã tạo khách hàng ${created?.customer_name || ""} thành công.` }]);
      setAgentDraft(null);
      setAgentMissingFields([]);
      setAgentPendingSlot(null);
      setAgentExecutionArmed(false);
      setAgentCommand("");
      toast({ title: "Agent UI tạo khách hàng thành công", description: created?.customer_name || "" });
    },
    onError: (e: any) => {
      setAgentStatus(`❌ Agent tạo khách hàng thất bại: ${e?.message || "Không rõ lỗi"}`);
      setAgentChatLog((prev) => [...prev, { role: "agent", text: `Tạo khách hàng thất bại, đã rollback dữ liệu tạm. Lỗi: ${e?.message || "Không rõ"}` }]);
      toast({ title: "Agent UI lỗi", description: e?.message || "Không thể tạo khách hàng", variant: "destructive" });
    },
  });

  const kbAiSuggestMutation = useMutation({
    mutationFn: async () => {
      const activeTemplateName = poTemplates.find((t: any) => t.customer_id === editingCustomerId && t.is_active)?.file_name || null;
      const { data, error } = await supabase.functions.invoke("kb-suggest-po-rules", {
        body: {
          profileName: editKbProfileName,
          poMode: editKbPoMode,
          poSource: editKbPoSource,
          businessDescription: editKbBusinessDescription,
          sampleEmailContent: editEmailBodyTemplate,
          templateFileName: activeTemplateName || templateFileName || null,
          templateExtractedContext: templateAiContext || null,
        },
      });
      if (error) throw error;
      if (!data?.suggestion) throw new Error("AI không trả về rule hợp lệ");
      return data.suggestion as KbAiParseSuggestion;
    },
    onMutate: () => {
      setKbAiStatus("AI đang phân tích mô tả + mẫu email để đề xuất rule...");
    },
    onSuccess: (suggestion) => {
      setKbAiSuggestion(suggestion);
      setKbAiStatus(`Đã tạo đề xuất AI • confidence ${Math.round(Number(suggestion?.confidence || 0) * 100)}%`);
      toast({ title: "AI đã đề xuất rule KB", description: suggestion?.human_summary || "" });
    },
    onError: (e: any) => {
      setKbAiStatus(`AI tính toán thất bại: ${e?.message || "Không rõ lỗi"}`);
      toast({ title: "AI tính toán thất bại", description: e?.message || "Không thể tạo rule KB", variant: "destructive" });
    },
  });

  const updateCustomerMutation = useMutation({
    mutationFn: async () => {
      if (!editingCustomerId) throw new Error("Chưa chọn khách hàng để sửa");
      const trimmedName = editCustomerName.trim();
      if (!trimmedName) throw new Error("Vui lòng nhập tên khách hàng");
      if (!editIsNpp && editUsesNpp && !editSuppliedByNppCustomerId) throw new Error("Vui lòng chọn nhà phân phối cung cấp hàng");

      const customerUpdatePayload = {
        customer_name: trimmedName,
        customer_group: editCustomerGroup,
        product_group: editProductGroup,
        is_active: editIsActive,
        is_npp: editIsNpp,
        supplied_by_npp_customer_id: editIsNpp ? null : (editUsesNpp ? (editSuppliedByNppCustomerId || null) : null),
      };

      const { data: updatedCustomer, error: updateError } = await (supabase as any)
        .from("mini_crm_customers")
        .update(customerUpdatePayload)
        .eq("id", editingCustomerId)
        .select("id")
        .maybeSingle();

      if (updateError) {
        throw new Error(`Lỗi cập nhật thông tin khách hàng: ${updateError.message}`);
      }
      if (!updatedCustomer?.id) {
        throw new Error("Không cập nhật được khách hàng (có thể do quyền RLS hoặc bản ghi không tồn tại)");
      }

      const normalizeEmails = (raw: string) =>
        Array.from(new Set(
          String(raw || "")
            .split(/[;,\n]+/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        ));

      const emails = normalizeEmails(editEmailsInput);
      const oldEmails = normalizeEmails(editOriginalEmailsInput);
      const emailChanged = JSON.stringify(emails) !== JSON.stringify(oldEmails);
      const warnings: string[] = [];

      try {
        if (emailChanged) {
          const { error: deleteEmailsError } = await (supabase as any)
            .from("mini_crm_customer_emails")
            .delete()
            .eq("customer_id", editingCustomerId);

          if (deleteEmailsError) {
            throw new Error(`Lỗi cập nhật danh sách email (bước xoá email cũ): ${deleteEmailsError.message}`);
          }

          if (emails.length) {
            const { error: insertEmailsError } = await (supabase as any)
              .from("mini_crm_customer_emails")
              .insert(emails.map((email, idx) => ({ customer_id: editingCustomerId, email, is_primary: idx === 0 })));
            if (insertEmailsError) {
              throw new Error(`Lỗi cập nhật danh sách email (bước thêm email mới): ${insertEmailsError.message}`);
            }
          }
        }

        if (editContractFile) {
          const { error: deactivateContractError } = await (supabase as any)
            .from("mini_crm_customer_contracts")
            .update({ is_active: false })
            .eq("customer_id", editingCustomerId)
            .eq("is_active", true);
          if (deactivateContractError) throw deactivateContractError;

          const filePath = `${editingCustomerId}/${Date.now()}-${editContractFile.name}`;
          const { error: uploadError } = await (supabase as any).storage.from("customer-contracts").upload(filePath, editContractFile, { upsert: false, contentType: editContractFile.type || "application/pdf" });
          if (uploadError) throw uploadError;
          const { data: pub } = (supabase as any).storage.from("customer-contracts").getPublicUrl(filePath);
          const { error: contractInsertError } = await (supabase as any)
            .from("mini_crm_customer_contracts")
            .insert({ customer_id: editingCustomerId, file_name: editContractFile.name, file_url: pub?.publicUrl || filePath, file_size: editContractFile.size, mime_type: editContractFile.type || "application/pdf", is_active: true });
          if (contractInsertError) throw contractInsertError;
        }

        const validRows = editPriceRows
          .map((r) => ({ sku_id: r.skuId, price_vnd_per_unit: Number(String(r.price || "").replace(/[^0-9]/g, "")) }))
          .filter((r) => r.sku_id && Number.isFinite(r.price_vnd_per_unit) && r.price_vnd_per_unit > 0);

        const { error: deactivatePriceError } = await (supabase as any)
          .from("mini_crm_customer_price_list")
          .update({ is_active: false })
          .eq("customer_id", editingCustomerId)
          .eq("is_active", true);
        if (deactivatePriceError) throw deactivatePriceError;

        if (validRows.length) {
          const { error: priceInsertError } = await (supabase as any)
            .from("mini_crm_customer_price_list")
            .insert(validRows.map((r) => ({ customer_id: editingCustomerId, sku_id: r.sku_id, price_vnd_per_unit: r.price_vnd_per_unit, currency: "VND", is_active: true })));
          if (priceInsertError) throw priceInsertError;
        }

        if (templatePreview?.parserConfig) {
          const { error: deactivateTplError } = await (supabase as any)
            .from("mini_crm_po_templates")
            .update({ is_active: false })
            .eq("customer_id", editingCustomerId)
            .eq("is_active", true);
          if (deactivateTplError) throw deactivateTplError;

          const versionNo = await getNextTemplateVersion(editingCustomerId);
          const { error: tplInsertError } = await (supabase as any)
            .from("mini_crm_po_templates")
            .insert({ customer_id: editingCustomerId, template_name: `Template v${versionNo} - ${new Date().toLocaleString("vi-VN")}`, file_name: templateFileName || "uploaded-template.xlsx", parser_config: { ...(templatePreview.parserConfig || {}), version_no: versionNo }, sample_preview: templatePreview.sampleRows || [], confirmation_snapshot: templatePreview?.confirmationView || {}, parse_confidence: Number(templatePreview?.confidenceScore || 1), version_no: versionNo, is_active: true });
          if (tplInsertError) throw tplInsertError;
        }

        const kbPayload = {
          customer_id: editingCustomerId,
          profile_name: editKbProfileName.trim() || `${trimmedName} Knowledge`,
          po_mode: editKbPoMode,
          calculation_notes: editKbCalcNotes.trim() || null,
          business_description: editKbBusinessDescription.trim() || null,
          ai_parse_config: kbAiSuggestion || null,
          template_context: templateAiContext || null,
          operational_notes: composeOperationalNotes(editKbOperationalNotes.trim(), editKbPoSource, editEmailBodyTemplate, editKbBusinessDescription, kbAiSuggestion),
          profile_status: "active",
        };
        const { data: kbSaved, error: kbError } = await (supabase as any)
          .from("mini_crm_knowledge_profiles")
          .upsert(kbPayload, { onConflict: "customer_id" })
          .select("id,customer_id,profile_name,po_mode,profile_status,calculation_notes,operational_notes")
          .single();
        if (kbError) throw new Error(`Lỗi lưu Knowledge Base profile: ${kbError.message}`);

        const kbVersionNo = await getNextKnowledgeProfileVersion(editingCustomerId);
        const { error: kbVersionError } = await (supabase as any)
          .from("mini_crm_knowledge_profile_versions")
          .insert({
            customer_id: editingCustomerId,
            knowledge_profile_id: kbSaved?.id || null,
            version_no: kbVersionNo,
            profile_name: kbSaved?.profile_name || kbPayload.profile_name,
            po_mode: kbSaved?.po_mode || kbPayload.po_mode,
            profile_status: kbSaved?.profile_status || kbPayload.profile_status,
            calculation_notes: kbSaved?.calculation_notes || kbPayload.calculation_notes || null,
            operational_notes: kbSaved?.operational_notes || kbPayload.operational_notes || null,
            changed_by: "mini-crm-ui",
            change_note: "Profile updated from CRM",
            is_active: true,
            effective_from: new Date().toISOString(),
          });
        if (kbVersionError) throw new Error(`Lỗi lưu KB version: ${kbVersionError.message}`);
      } catch (detailError: any) {
        warnings.push(detailError?.message || "Một phần dữ liệu mở rộng chưa lưu được");
      }

      return { saved: true, emailCount: emails.length, emailChanged, warnings };
    },
    onSuccess: async (result: any) => {
      cancelEditCustomer();
      const warningText = Array.isArray(result?.warnings) && result.warnings.length ? ` Tuy nhiên có phần mở rộng chưa lưu được: ${result.warnings.join("; ")}.` : "";
      const msg = `Đã lưu thành công${result?.emailChanged ? ` (${result?.emailCount || 0} email)` : ""}.${warningText}`;
      setEditFeedback(msg);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-contracts"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-price-list"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-po-templates"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profiles"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profile-versions"] }),
      ]);
      toast({ title: Array.isArray(result?.warnings) && result.warnings.length ? "Lưu thành công một phần" : "Lưu thành công", description: msg });
    },
    onError: (e: any) => {
      const msg = e?.message || "Không thể cập nhật khách hàng";
      setEditFeedback(`Lưu thất bại: ${msg}`);
      toast({ title: "Lỗi lưu CRM", description: msg, variant: "destructive" });
    },
  });

  const submitKbChangeRequestMutation = useMutation({
    mutationFn: async () => {
      if (!editingCustomerId) throw new Error("Chưa chọn khách hàng");
      const payload = {
        customer_id: editingCustomerId,
        profile_name: editKbProfileName.trim() || `${editCustomerName.trim() || "Customer"} Knowledge`,
        po_mode: editKbPoMode,
        profile_status: "pending_approval",
        calculation_notes: editKbCalcNotes.trim() || null,
        business_description: editKbBusinessDescription.trim() || null,
        ai_parse_config: kbAiSuggestion || null,
        template_context: templateAiContext || null,
        operational_notes: composeOperationalNotes(editKbOperationalNotes.trim(), editKbPoSource, editEmailBodyTemplate, editKbBusinessDescription, kbAiSuggestion),
        change_note: kbChangeNote.trim() || "KB update request",
        request_status: "pending",
        requested_by: "mini-crm-ui",
      };
      const { error } = await (supabase as any).from("mini_crm_knowledge_change_requests").insert(payload);
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-change-requests"] });
      toast({ title: "Đã gửi yêu cầu duyệt KB", description: "Yêu cầu đã vào hàng chờ phê duyệt." });
      setKbChangeNote("");
    },
    onError: (e: any) => {
      toast({ title: "Gửi yêu cầu KB thất bại", description: e?.message || "Không thể gửi yêu cầu", variant: "destructive" });
    },
  });

  const approveKbLatestRequestMutation = useMutation({
    mutationFn: async () => {
      if (!editingCustomerId) throw new Error("Chưa chọn khách hàng");
      const pending = knowledgeChangeRequests.find((r: any) => r.customer_id === editingCustomerId && r.request_status === "pending");
      if (!pending) throw new Error("Không có yêu cầu KB pending để duyệt");

      const kbPayload = {
        customer_id: editingCustomerId,
        profile_name: pending.profile_name,
        po_mode: pending.po_mode,
        calculation_notes: pending.calculation_notes,
        business_description: pending.business_description || null,
        ai_parse_config: pending.ai_parse_config || null,
        template_context: pending.template_context || null,
        operational_notes: pending.operational_notes,
        profile_status: "active",
      };
      const { data: kbSaved, error: kbError } = await (supabase as any)
        .from("mini_crm_knowledge_profiles")
        .upsert(kbPayload, { onConflict: "customer_id" })
        .select("id,customer_id,profile_name,po_mode,profile_status,calculation_notes,operational_notes")
        .single();
      if (kbError) throw kbError;

      const versionNo = await getNextKnowledgeProfileVersion(editingCustomerId);
      const { error: verErr } = await (supabase as any).from("mini_crm_knowledge_profile_versions").insert({
        customer_id: editingCustomerId,
        knowledge_profile_id: kbSaved?.id || null,
        version_no: versionNo,
        profile_name: kbSaved?.profile_name || kbPayload.profile_name,
        po_mode: kbSaved?.po_mode || kbPayload.po_mode,
        profile_status: "active",
        calculation_notes: kbSaved?.calculation_notes || null,
        business_description: kbSaved?.business_description || pending.business_description || null,
        ai_parse_config: kbSaved?.ai_parse_config || pending.ai_parse_config || null,
        template_context: kbSaved?.template_context || pending.template_context || null,
        operational_notes: kbSaved?.operational_notes || null,
        changed_by: "mini-crm-approver",
        change_note: pending.change_note || "Approved KB request",
        is_active: true,
        effective_from: new Date().toISOString(),
      });
      if (verErr) throw verErr;

      const { error: reqErr } = await (supabase as any)
        .from("mini_crm_knowledge_change_requests")
        .update({ request_status: "approved", approved_by: "mini-crm-approver", approved_at: new Date().toISOString(), applied_version_no: versionNo })
        .eq("id", pending.id);
      if (reqErr) throw reqErr;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profiles"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profile-versions"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-change-requests"] }),
      ]);
      toast({ title: "Đã duyệt & áp dụng KB", description: "Rule KB đã active theo version mới." });
    },
    onError: (e: any) => {
      toast({ title: "Duyệt KB thất bại", description: e?.message || "Không thể duyệt KB", variant: "destructive" });
    },
  });

  const deleteCustomerMutation = useMutation({
    mutationFn: async ({ customerId }: { customerId: string; customerName?: string }) => {
      const { error: deleteEmailError } = await (supabase as any)
        .from("mini_crm_customer_emails")
        .delete()
        .eq("customer_id", customerId);
      if (deleteEmailError) throw deleteEmailError;

      const { error: deleteCustomerError } = await (supabase as any)
        .from("mini_crm_customers")
        .delete()
        .eq("id", customerId);
      if (deleteCustomerError) throw deleteCustomerError;
    },
    onSuccess: async (_data, vars) => {
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] });
      toast({ title: "Xoá khách hàng thành công", description: vars?.customerName ? `Đã xoá ${vars.customerName}.` : undefined });
    },
    onError: (e: any) => {
      toast({ title: "Xoá khách hàng thất bại", description: e?.message || "Không thể xoá khách hàng", variant: "destructive" });
    },
  });

  const extractPdfTemplateContext = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const pdf = await getDocument({ data: buffer }).promise;
    const pages = Math.min(pdf.numPages, 5);
    const texts: string[] = [];
    for (let p = 1; p <= pages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const pageText = content.items.map((item: any) => String(item?.str || "")).join(" ").replace(/\s+/g, " ").trim();
      if (pageText) texts.push(pageText);
    }
    return texts.join("\n").slice(0, 8000);
  };

  const extractImageTemplateContext = async (file: File) => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const payload = result.split(",")[1];
        if (!payload) reject(new Error("Không đọc được ảnh mẫu"));
        else resolve(payload);
      };
      reader.onerror = () => reject(reader.error || new Error("Không thể đọc file ảnh"));
      reader.readAsDataURL(file);
    });
    const { data, error } = await supabase.functions.invoke("scan-purchase-order", {
      body: { imageBase64: base64, mimeType: file.type || "image/png" },
    });
    if (error) throw error;
    const items = Array.isArray(data?.items) ? data.items : [];
    const supplier = String(data?.supplier_name || "").trim();
    const lines = items.slice(0, 20).map((it: any) => `${String(it?.product_name || "").trim()} | qty=${Number(it?.quantity || 0) || 0} | unit=${String(it?.unit || "").trim()}`);
    return [`supplier=${supplier}`, ...lines].filter(Boolean).join("\n").slice(0, 8000);
  };

  const handleAnalyzeTemplateFile = async (file?: File | null) => {
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const worksheet = workbook.getWorksheet("NEW") || workbook.worksheets[0];
    if (!worksheet) throw new Error("Không đọc được sheet trong file mẫu");

    const row1 = worksheet.getRow(1).values as any[];
    const row2 = worksheet.getRow(2).values as any[];

    const normalizeHeader = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
    const normalizeToken = (s: string) => normalizeHeader(s).toLowerCase().replace(/[^a-z0-9à-ỹ]/g, "");
    const isLikelyMetaHeader = (name: string) => {
      const t = normalizeToken(name);
      return ["stt", "no", "ngaydate", "ac", "amenity", "type", "fltno", "dep", "arr"].includes(t) || t.includes("tongcong") || t.includes("hotmealdat");
    };
    const toNumericQty = (raw: any) => {
      if (raw == null) return 0;
      if (raw instanceof Date) return 0;
      if (typeof raw === "object" && raw?.result != null) return toNumericQty(raw.result);
      if (typeof raw === "object" && raw?.formula) return toNumericQty(raw.result);
      const n = Number(String(raw).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const parseDateCell = (raw: any) => {
      if (!raw) return null;
      if (raw instanceof Date) return raw;
      if (typeof raw === "object" && raw?.result instanceof Date) return raw.result;
      const dt = new Date(raw);
      return Number.isNaN(dt.getTime()) ? null : dt;
    };

    const findHeaderRow = () => {
      for (let r = 1; r <= Math.min(6, worksheet.rowCount); r++) {
        const vals = worksheet.getRow(r).values as any[];
        const cols = vals.map((v, idx) => ({ idx, name: normalizeHeader(v) })).filter((c) => c.idx > 0 && c.name);
        const hasProduct = cols.some((c) => /(tên\s*sản\s*phẩm|ten\s*san\s*pham|product|item)/i.test(c.name));
        const hasQty = cols.some((c) => /(số\s*lượng|so\s*luong|qty|quantity)/i.test(c.name));
        if (hasProduct && hasQty) return { row: r, cols };
      }
      return null;
    };

    const detectedHeader = findHeaderRow();
    const headerRowNo = detectedHeader?.row || 2;
    const headerColumns = (detectedHeader?.cols || row2.map((v, idx) => ({ idx, name: normalizeHeader(v) })))
      .filter((c: any) => c.idx > 0 && c.name);

    const findHeaderIndex = (patterns: RegExp[]) => {
      const m = headerColumns.find((c: any) => patterns.some((p) => p.test(c.name)));
      return m?.idx || 0;
    };

    const productCol = findHeaderIndex([/(tên\s*sản\s*phẩm|ten\s*san\s*pham|product|item)/i]);
    const qtyCol = findHeaderIndex([/(số\s*lượng|so\s*luong|qty|quantity)/i]);
    const dateCol = findHeaderIndex([/(ngày\s*giao|ngày|date)/i]);
    const skuCol = findHeaderIndex([/(barcode|mã|ma|sku|code)/i]);
    const unitCol = findHeaderIndex([/(đơn\s*vị|don\s*vi|unit)/i]);
    const unitPriceCol = findHeaderIndex([/(đơn\s*giá|don\s*gia|unit\s*price|price)/i]);

    const sampleRows = [] as any[];
    const lineItems = [] as any[];

    const isRowItemMode = Boolean(productCol && qtyCol);

    if (isRowItemMode) {
      const dataStartRow = headerRowNo + 1;
      for (let r = dataStartRow; r <= worksheet.rowCount; r++) {
        const firstCellText = String(worksheet.getCell(r, 1).value || "").toUpperCase();
        if (firstCellText.includes("TỔNG CỘNG")) continue;
        const product = String(worksheet.getCell(r, productCol).value || "").trim();
        const qty = toNumericQty(worksheet.getCell(r, qtyCol).value);
        if (!product || qty <= 0) continue;
        const dateObj = parseDateCell(dateCol ? worksheet.getCell(r, dateCol).value : null);
        const date = dateObj ? dateObj.toISOString().slice(0, 10) : "";
        sampleRows.push({ row: r, date, rowQtyTotal: qty });
        lineItems.push({
          date,
          product,
          sourceColumnName: String(headerColumns.find((c: any) => c.idx === productCol)?.name || "Tên sản phẩm"),
          qty,
          sku: skuCol ? String(worksheet.getCell(r, skuCol).value || "").trim() : "",
          unit: unitCol ? String(worksheet.getCell(r, unitCol).value || "").trim() : "",
          unitPrice: unitPriceCol ? toNumericQty(worksheet.getCell(r, unitPriceCol).value) : null,
          lineTotal: null,
        });
      }
    }

    const quantityColumns = isRowItemMode ? [] : headerColumns
      .filter((c: any) => !isLikelyMetaHeader(c.name))
      .map((c: any) => {
        let maxQty = 0;
        for (let r = 3; r <= worksheet.rowCount; r++) {
          const q = toNumericQty(worksheet.getCell(r, c.idx).value);
          if (q > maxQty) maxQty = q;
        }
        return { columnIndex: c.idx, columnName: c.name, sampleQty: maxQty };
      })
      .filter((c: any) => c.sampleQty > 0);

    if (!isRowItemMode) {
      for (let r = 3; r <= worksheet.rowCount; r++) {
        const firstCellText = String(worksheet.getCell(r, 1).value || "").toUpperCase();
        if (firstCellText.includes("TỔNG CỘNG")) continue;
        const dateObj = parseDateCell(worksheet.getCell(r, 2).value);
        if (!dateObj) continue;
        const rowQtyTotal = quantityColumns.reduce((sum: number, q: any) => sum + toNumericQty(worksheet.getCell(r, q.columnIndex).value), 0);
        if (rowQtyTotal <= 0) continue;
        const date = dateObj.toISOString().slice(0, 10);
        sampleRows.push({ row: r, date, rowQtyTotal });
        for (const q of quantityColumns) {
          const qty = toNumericQty(worksheet.getCell(r, q.columnIndex).value);
          if (qty > 0) lineItems.push({ date, product: q.columnName, sourceColumnName: q.columnName, qty, unitPrice: null, lineTotal: null });
        }
      }
    }

    const parserConfig = {
      sheetName: worksheet.name,
      headerRow: headerRowNo,
      productCodeRow: 1,
      dateColumnName: "Ngày/Date",
      rowItemMode: isRowItemMode,
      rowItemColumns: isRowItemMode ? {
        productNameColumnIndex: productCol,
        qtyColumnIndex: qtyCol,
        dateColumnIndex: dateCol,
        skuColumnIndex: skuCol,
        unitColumnIndex: unitCol,
        unitPriceColumnIndex: unitPriceCol,
      } : null,
      quantityColumns,
      headerColumns: headerColumns.slice(0, 60),
    };

    const datedRows = sampleRows.filter((s: any) => String(s?.date || "").trim());
    const confirmationView = {
      orderDate: datedRows.length ? `${datedRows[0].date} → ${datedRows[datedRows.length - 1].date}` : "",
      items: lineItems,
      subtotal: null,
      vat: null,
      total: null,
      hasNoMoneyInPo: true,
    };

    const confidenceScore = (() => {
      const hasDate = Boolean(String(confirmationView.orderDate || "").trim());
      const itemCount = (confirmationView.items || []).filter((it: any) => String(it?.product || "").trim()).length;
      const qtyCount = (confirmationView.items || []).filter((it: any) => Number(it?.qty || 0) > 0).length;
      let score = 0;
      if (hasDate) score += 0.35;
      if (itemCount > 0) score += 0.35;
      if (qtyCount > 0) score += 0.3;
      return Number(score.toFixed(2));
    })();

    setPendingTemplateFileName(file.name);
    setPendingTemplatePreview({ parserConfig, sampleRows, confirmationView, confidenceScore });
    setTemplateConfirmOpen(true);
  };

  const saveTemplateMutation = useMutation({
    mutationFn: async (customerId: string) => {
      if (!customerId) throw new Error("Vui lòng chọn khách hàng");
      if (!templatePreview?.parserConfig) throw new Error("Vui lòng upload và phân tích file mẫu trước");

      const { error: disableError } = await (supabase as any)
        .from("mini_crm_po_templates")
        .update({ is_active: false })
        .eq("customer_id", customerId)
        .eq("is_active", true);
      if (disableError) throw disableError;

      const versionNo = await getNextTemplateVersion(customerId);
      const { error: insertError } = await (supabase as any)
        .from("mini_crm_po_templates")
        .insert({
          customer_id: customerId,
          template_name: `Template v${versionNo} - ${new Date().toLocaleString("vi-VN")}`,
          file_name: templateFileName || "uploaded-template.xlsx",
          parser_config: { ...(templatePreview.parserConfig || {}), version_no: versionNo },
          sample_preview: templatePreview.sampleRows || [],
          confirmation_snapshot: templatePreview?.confirmationView || {},
          parse_confidence: Number(templatePreview?.confidenceScore || 1),
          version_no: versionNo,
          is_active: true,
        });
      if (insertError) throw insertError;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-po-templates"] });
      setTemplateFileName("");
      setTemplatePreview(null);
      setTemplateAiContext("");
      toast({ title: "Lưu mẫu PO thành công", description: "Đã lưu format để scan cho lần sau." });
    },
    onError: (e: any) => {
      toast({ title: "Lưu mẫu PO thất bại", description: e?.message || "Không thể lưu mẫu PO", variant: "destructive" });
    },
  });

  const buildGmailQuery = () => {
    const getDayRangeEpochSeconds = (dateStr?: string) => {
      if (!dateStr) return null;
      const from = new Date(`${dateStr}T00:00:00`);
      const to = new Date(`${dateStr}T23:59:59`);
      return {
        from: Math.floor(from.getTime() / 1000),
        to: Math.floor(to.getTime() / 1000),
      };
    };

    const dayRange = getDayRangeEpochSeconds(syncDate);
    const dateQuery = dayRange
      ? `after:${dayRange.from} before:${dayRange.to}`
      : "newer_than:30d";

    return `in:anywhere deliveredto:po@bmq.vn ${dateQuery}`.trim();
  };

  const callPoGmailSync = async (payload: any, stepLabel: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      throw new Error(`[${stepLabel}] Phiên đăng nhập hết hạn (không có access token). Vui lòng đăng xuất và đăng nhập lại.`);
    }

    const { error: userError } = await supabase.auth.getUser();
    if (userError) {
      throw new Error(`[${stepLabel}] Phiên đăng nhập không hợp lệ (${userError.message}). Vui lòng đăng xuất và đăng nhập lại.`);
    }

    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-gmail-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    let result: any = {};
    try {
      result = rawText ? JSON.parse(rawText) : {};
    } catch {
      result = { raw: rawText };
    }

    if (!response.ok) {
      const msg = result?.error || result?.message || result?.raw || rawText || "Unknown error";
      if (response.status === 401 && /invalid jwt/i.test(String(msg))) {
        throw new Error(`[${stepLabel}] HTTP 401 - Phiên đăng nhập đã hết hạn/không hợp lệ (Invalid JWT). Vui lòng đăng xuất và đăng nhập lại.`);
      }
      throw new Error(`[${stepLabel}] HTTP ${response.status} - ${msg}`);
    }

    return result;
  };

  const syncGmailMutation = useMutation({
    mutationFn: async () => {
      setSyncDebug(null);
      setSyncError("");
      setSyncStatus("syncing");

      const query = buildGmailQuery();
      const result = await callPoGmailSync({ mode: "preview", maxResults: 100, query, includeOnlyCrm: true }, "preview");
      return { ...result, query };
    },
    onSuccess: (result: any) => {
      setSyncDebug(result);
      const items = Array.isArray(result?.previews) ? result.previews : [];
      setPreviewItems(items);
      setSelectedPreviewId(items[0]?.messageId || null);
      setSelectedPreviewIds([]);
      setConfirmTemplateRead(false);
      setSyncStatus("preview_success");
    },
    onError: (e: any) => {
      setSyncStatus("error");
      setSyncError(e?.message || "Không thể đồng bộ Gmail");
    },
  });

  const importPoMutation = useMutation({
    mutationFn: async (scope: "all" | "selected" = "all") => {
      const query = buildGmailQuery();
      const allIds = previewItems.map((x: any) => x.messageId).filter(Boolean);
      const messageIds = scope === "selected" ? selectedPreviewIds : allIds;
      if (scope === "selected" && messageIds.length === 0) {
        throw new Error("Vui lòng chọn ít nhất 1 PO để nhập.");
      }

      const targetItems = scope === "selected"
        ? previewItems.filter((x: any) => messageIds.includes(x.messageId))
        : previewItems;
      const hasTemplateMatched = targetItems.some((x: any) => Boolean(x?.template?.id));
      if (hasTemplateMatched && !confirmTemplateRead) {
        throw new Error("Vui lòng xác nhận đã kiểm tra PO theo mẫu trước khi nhập.");
      }

      return await callPoGmailSync({ mode: "import", maxResults: 100, query, messageIds, includeOnlyCrm: true }, "import");
    },
    onSuccess: async (result: any) => {
      setSyncDebug(result);
      setSyncStatus("import_success");
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      await queryClient.refetchQueries({ queryKey: ["customer-po-inbox"], type: "active" });
      toast({ title: "Đã nhập PO vào hệ thống", description: `Đã nhập ${result?.synced || 0} PO.` });
      setSyncModalOpen(false);
    },
    onError: (e: any) => {
      setSyncStatus("error");
      setSyncError(e?.message || "Import PO thất bại");
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "approved" | "rejected" }) => {
      const { data: row, error: rowErr } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id,customer_id,raw_payload")
        .eq("id", id)
        .single();
      if (rowErr || !row) throw rowErr || new Error("Không tìm thấy PO");

      const { error } = await (supabase as any)
        .from("customer_po_inbox")
        .update({ match_status: status, reviewed_at: new Date().toISOString(), review_note: status === "approved" ? "Manual approved" : "Manual rejected" })
        .eq("id", id);
      if (error) throw error;

      await (supabase as any).from("po_revenue_post_audit").insert({
        po_inbox_id: id,
        customer_id: row.customer_id,
        action: "manual_match_review",
        amount: Number(row?.raw_payload?.revenue_post?.total || row?.raw_payload?.revenue_post?.amount || 0),
        full_snapshot_total: Number(row?.raw_payload?.revenue_post?.full_snapshot_total || 0),
        base_amount: Number(row?.raw_payload?.revenue_post?.base_amount || 0),
        delta_amount: Number(row?.raw_payload?.revenue_post?.delta_amount || 0),
        decision: status,
        note: status === "approved" ? "Manual approved" : "Manual rejected",
        actor: "mini-crm-ui",
        raw_payload: row?.raw_payload?.revenue_post || {},
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      await queryClient.invalidateQueries({ queryKey: ["po-revenue-post-audit"] });
      toast({ title: "Đã cập nhật duyệt", description: "Trạng thái PO inbox đã đổi." });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi", description: e?.message || "Không thể cập nhật trạng thái", variant: "destructive" });
    },
  });

  const reviewDeltaMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "approve_zero" | "reject" }) => {
      const { data: row, error: rowErr } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id,customer_id,raw_payload")
        .eq("id", id)
        .single();
      if (rowErr || !row) throw rowErr || new Error("Không tìm thấy PO");

      const revenuePost = { ...(row.raw_payload?.revenue_post || {}) };
      const nextRevenuePost = {
        ...revenuePost,
        reviewed_at: new Date().toISOString(),
        reviewed_by: "mini-crm-ui",
        requires_review: false,
      };

      if (action === "approve_zero") {
        nextRevenuePost.posted = true;
        nextRevenuePost.posted_at = new Date().toISOString();
        nextRevenuePost.review_decision = "approved_zero";
        nextRevenuePost.amount = 0;
        nextRevenuePost.total = 0;
      } else {
        nextRevenuePost.posted = false;
        nextRevenuePost.review_decision = "rejected";
      }

      const { error } = await (supabase as any)
        .from("customer_po_inbox")
        .update({
          match_status: action === "approve_zero" ? "approved" : "rejected",
          raw_payload: { ...(row.raw_payload || {}), revenue_post: nextRevenuePost },
        })
        .eq("id", id);
      if (error) throw error;

      await (supabase as any).from("po_revenue_post_audit").insert({
        po_inbox_id: id,
        customer_id: row.customer_id,
        action: "review",
        amount: Number(nextRevenuePost?.total || nextRevenuePost?.amount || 0),
        full_snapshot_total: Number(nextRevenuePost?.full_snapshot_total || 0),
        base_amount: Number(nextRevenuePost?.base_amount || 0),
        delta_amount: Number(nextRevenuePost?.delta_amount || 0),
        decision: action === "approve_zero" ? "approved_zero" : "rejected",
        note: String(nextRevenuePost?.review_reason || ""),
        actor: "mini-crm-ui",
        raw_payload: nextRevenuePost,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      await queryClient.invalidateQueries({ queryKey: ["po-revenue-post-audit"] });
      toast({ title: "Đã duyệt điều chỉnh", description: "Đã xử lý PO cumulative cần review." });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi duyệt điều chỉnh", description: e?.message || "Không thể xử lý", variant: "destructive" });
    },
  });

  const filteredPoInbox = useMemo(() => {
    const fromMs = poDateFrom ? new Date(`${poDateFrom}T00:00:00`).getTime() : null;
    const toMs = poDateTo ? new Date(`${poDateTo}T23:59:59`).getTime() : null;
    return poInbox.filter((row: any) => {
      const t = new Date(row?.received_at || 0).getTime();
      if (!Number.isFinite(t)) return false;
      if (fromMs && t < fromMs) return false;
      if (toMs && t > toMs) return false;
      if (poNeedsDeltaReviewOnly && !row?.raw_payload?.revenue_post?.requires_review) return false;
      if (poCustomerFilter !== "all" && String(row?.customer_id || "") !== poCustomerFilter) return false;
      if (poModeFilter !== "all") {
        const kb = customerKnowledgeProfiles.find((x: any) => x.customer_id === row?.customer_id);
        const mode = String(kb?.po_mode || "daily_new_po");
        if (mode !== poModeFilter) return false;
      }
      return true;
    });
  }, [poInbox, poDateFrom, poDateTo, poNeedsDeltaReviewOnly, poCustomerFilter, poModeFilter, customerKnowledgeProfiles]);

  const statusCounts = useMemo(() => {
    return filteredPoInbox.reduce(
      (acc: Record<string, number>, row: any) => {
        const key = row.match_status || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      {}
    );
  }, [filteredPoInbox]);

  const filteredCustomers = useMemo(() => {
    const keyword = normalizeVietnameseText(customerSearch);
    if (!keyword) return customers;
    return customers.filter((c: any) => {
      const name = normalizeVietnameseText(c?.customer_name);
      const group = normalizeVietnameseText(GROUP_LABEL_MAP[c?.customer_group] || c?.customer_group || "");
      const productGroup = normalizeVietnameseText(PRODUCT_GROUP_LABEL_MAP[c?.product_group] || c?.product_group || "");
      const emails = normalizeVietnameseText((c?.mini_crm_customer_emails || []).map((e: any) => e?.email).join(" "));
      const haystack = `${name} ${group} ${productGroup} ${emails}`;
      return haystack.includes(keyword);
    });
  }, [customers, customerSearch]);

  const pendingDeltaReviewCount = useMemo(() => {
    return filteredPoInbox.filter((row: any) => Boolean(row?.raw_payload?.revenue_post?.requires_review)).length;
  }, [filteredPoInbox]);

  const exceptionQueue = useMemo(() => {
    return poInbox.filter((row: any) => {
      const rp = row?.raw_payload?.revenue_post || {};
      return Boolean(rp?.requires_review) || ["rejected", "unmatched"].includes(String(row?.match_status || ""));
    });
  }, [poInbox]);

  const recentRevenueAudit = useMemo(() => revenueAuditRows.slice(0, 20), [revenueAuditRows]);

  const selectedPo = useMemo(() => poInbox.find((r: any) => r.id === selectedPoId) || null, [poInbox, selectedPoId]);
  const poDraftSignature = useMemo(() => buildPoDraftSignature(poSummaryDraft), [poSummaryDraft]);
  const isPoDraftDirty = useMemo(() => Boolean(selectedPoId) && poDraftSignature !== poDraftBaseSignature, [selectedPoId, poDraftSignature, poDraftBaseSignature]);

  const poDraftLineItemsAmount = useMemo(() => calcDraftItemsAmount(poSummaryDraft?.production_items || []), [poSummaryDraft?.production_items]);
  const poDraftSubtotalAmount = useMemo(() => Number(poSummaryDraft?.subtotal_amount || 0) || 0, [poSummaryDraft?.subtotal_amount]);
  const poDraftVatAmount = useMemo(() => Number(poSummaryDraft?.vat_amount || 0) || 0, [poSummaryDraft?.vat_amount]);
  const poDraftDerivedTotalAmount = useMemo(() => calcSafeTotal(poDraftSubtotalAmount, poDraftVatAmount, poSummaryDraft?.total_amount), [poDraftSubtotalAmount, poDraftVatAmount, poSummaryDraft?.total_amount]);
  const poDraftSubtotalMismatch = useMemo(() => Math.abs(poDraftLineItemsAmount - poDraftSubtotalAmount) >= 1, [poDraftLineItemsAmount, poDraftSubtotalAmount]);

  // Manual edits become the source of truth after save, so draft hydration is guarded
  // and only happens on explicit editor transitions (open/saved reset), not every refetch.
  const resetPoDraftFromRow = (po: any, fallbackCustomerId?: string | null) => {
    if (!po) return;
    const nextDraft = createDraftFromPoRow(po, fallbackCustomerId);
    setPoSummaryDraft(nextDraft);
    setPoDraftBaseSignature(buildPoDraftSignature(nextDraft));
    setPendingParseAction(null);
    setPostRevenueStatus("");
    setSavePoStatus(buildManualSummaryMessage(po));
  };

  const updatePoDraft = (updater: (draft: any) => any) => {
    setPoSummaryDraft((current: any) => updater(current || {}));
  };

  const patchPoDraftItem = (_rowId: string, patch: Record<string, any>) => {
    updatePoDraft((draft: any) => ({
      ...draft,
      production_items: (Array.isArray(draft?.production_items) ? draft.production_items : []).map((item: any) =>
        item?._rowId === _rowId ? { ...item, ...patch } : item
      ),
    }));
  };

  const removePoDraftItem = (_rowId: string) => {
    updatePoDraft((draft: any) => ({
      ...draft,
      production_items: (Array.isArray(draft?.production_items) ? draft.production_items : []).filter((item: any) => item?._rowId !== _rowId),
    }));
  };

  const addPoDraftItem = () => {
    updatePoDraft((draft: any) => ({
      ...draft,
      production_items: [...(Array.isArray(draft?.production_items) ? draft.production_items : []), createEmptyPoDraftItem()],
    }));
  };

  const replacePoDraftItems = (items: any[], extra: Record<string, any> = {}) => {
    updatePoDraft((draft: any) => ({
      ...draft,
      ...extra,
      production_items: normalizePoDraftItems(items),
    }));
  };

  const selectedPoResolvedCustomerId = useMemo(() => {
    if (!selectedPo) return null;
    if (selectedPo.customer_id) return selectedPo.customer_id;
    const fromEmail = String(selectedPo.from_email || "").trim().toLowerCase();
    if (!fromEmail) return null;
    const matched = customers.filter((c: any) =>
      Array.isArray(c?.mini_crm_customer_emails)
      && c.mini_crm_customer_emails.some((e: any) => String(e?.email || "").trim().toLowerCase() === fromEmail)
    );
    const nonNppDependent = matched.filter((c: any) => !c?.supplied_by_npp_customer_id);
    const preferredNpp = nonNppDependent.filter((c: any) => Boolean(c?.is_npp));
    if (preferredNpp.length === 1) return preferredNpp[0].id;
    if (preferredNpp.length > 1) return null;
    if (nonNppDependent.length === 1) return nonNppDependent[0].id;
    return null;
  }, [selectedPo, customers]);
  const selectedPoKnowledgeProfile = useMemo(() => {
    if (!selectedPoResolvedCustomerId) return null;
    return customerKnowledgeProfiles.find((x: any) => x.customer_id === selectedPoResolvedCustomerId) || null;
  }, [customerKnowledgeProfiles, selectedPoResolvedCustomerId]);
  const selectedPoAiConfig = useMemo(() => extractKbAiConfig(String(selectedPoKnowledgeProfile?.operational_notes || "")), [selectedPoKnowledgeProfile]);
  const selectedPreview = useMemo(() => previewItems.find((r: any) => r.messageId === selectedPreviewId) || null, [previewItems, selectedPreviewId]);
  const nppCustomers = useMemo(() => customers.filter((c: any) => Boolean(c?.is_npp)), [customers]);
  const setupAvailableNppCustomers = useMemo(() => nppCustomers, [nppCustomers]);
  const editAvailableNppCustomers = useMemo(() => nppCustomers.filter((npp: any) => npp.id !== editingCustomerId), [nppCustomers, editingCustomerId]);

  useEffect(() => {
    if (!templateConfirmOpen || !pendingTemplatePreview?.confirmationView) return;
    setTemplateReviewDraft(JSON.parse(JSON.stringify(pendingTemplatePreview.confirmationView)));
    setTemplateReviewTouched(false);
  }, [templateConfirmOpen, pendingTemplatePreview]);

  useEffect(() => {
    if (!selectedPo) return;
    const hydrationKey = `${selectedPo.id}:${poDraftHydrationNonce}`;
    if (poDraftHydrationKeyRef.current === hydrationKey) return;
    poDraftHydrationKeyRef.current = hydrationKey;

    resetPoDraftFromRow(selectedPo, selectedPoResolvedCustomerId);
  }, [selectedPo, selectedPoResolvedCustomerId, poDraftHydrationNonce]);

  useEffect(() => {
    if (!selectedPo || !selectedPoKnowledgeProfile) return;
    const source = getKbPoSource(selectedPoKnowledgeProfile);
    if (source !== "email_body_only") return;

    const currentItems = Array.isArray(poSummaryDraft?.production_items) ? poSummaryDraft.production_items : [];
    if (currentItems.length > 0 || isPoDraftDirty) return;

    const parsed = parseEmailBodyToProductionItems(selectedPo?.email_subject, selectedPo?.body_preview || selectedPo?.raw_payload?.snippet || "", selectedPoAiConfig);
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return;

    setPoSummaryDraft((s: any) => ({
      ...s,
      delivery_date: s?.delivery_date || parsed.deliveryDate || "",
      production_items: normalizePoDraftItems(parsed.items),
      subtotal_amount: 0,
      vat_amount: 0,
      total_amount: 0,
    }));
  }, [selectedPo, selectedPoKnowledgeProfile, selectedPoAiConfig, poSummaryDraft?.production_items, isPoDraftDirty]);

  const parseAttachmentMutation = useMutation({
    mutationFn: async (inboxId: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Phiên đăng nhập hết hạn");
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-parse-inbox-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ inboxId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || "Parse attachment thất bại");
      return result;
    },
    onSuccess: async (result: any) => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      if (Array.isArray(result?.parsed?.items)) {
        const parsedItems = result.parsed.items;
        const subtotal = Number(result?.parsed?.subtotal || calcSubtotalFromItems(parsedItems) || 0);
        const vat = Number(result?.parsed?.vat ?? 0);
        const total = subtotal + vat;
        replacePoDraftItems(parsedItems, {
          po_number: poSummaryDraft?.po_number || extractPoNumberFromSubject(selectedPo?.email_subject),
          delivery_date: poSummaryDraft?.delivery_date || extractDeliveryDateFromSubject(selectedPo?.email_subject),
          subtotal_amount: subtotal || poSummaryDraft?.subtotal_amount,
          vat_amount: vat,
          total_amount: total,
        });
      }
      setSavePoStatus("Đã cập nhật draft từ file đính kèm. Nhớ lưu trước khi đẩy doanh thu.");
      toast({ title: "Đã parse file đính kèm", description: `${result?.parsed?.itemCount || 0} dòng sản phẩm` });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi parse file", description: e?.message || "Không parse được", variant: "destructive" });
    },
  });

  const savePoSummaryMutation = useMutation({
    onMutate: () => {
      setSavePoStatus("Đang lưu tóm tắt PO...");
    },
    mutationFn: async () => {
      if (!selectedPoId) throw new Error("Chưa chọn PO");
      const normalizedItems = parseDraftItemsForSave(poSummaryDraft.production_items || []);

      if (normalizedItems.length === 0) throw new Error("Cần ít nhất 1 dòng sản phẩm hoặc dịch vụ trước khi lưu");
      const hasMissingIdentity = normalizedItems.some((item: any) => !String(item.product_name || "").trim() && !String(item.sku || "").trim());
      if (hasMissingIdentity) throw new Error("Mỗi dòng cần có tên sản phẩm hoặc SKU");
      const hasInvalidQty = normalizedItems.some((item: any) => Number(item.qty || 0) <= 0);
      if (hasInvalidQty) throw new Error("Mỗi dòng cần có số lượng lớn hơn 0");

      const { data: latestRow, error: latestRowError } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id, customer_id, email_subject, raw_payload, updated_at")
        .eq("id", selectedPoId)
        .single();
      if (latestRowError || !latestRow) throw latestRowError || new Error("Không tải được dữ liệu PO mới nhất trước khi lưu");

      const safeTotal = calcSafeTotal(poSummaryDraft.subtotal_amount, poSummaryDraft.vat_amount, poSummaryDraft.total_amount);
      const poNumber = poSummaryDraft.po_number || extractPoNumberFromSubject(latestRow?.email_subject || selectedPo?.email_subject) || null;
      const customerId = String(poSummaryDraft.customer_id || latestRow?.customer_id || selectedPoResolvedCustomerId || "").trim() || null;
      const latestItems = normalizePoDraftItems(getPoDraftItemsFromRow(latestRow));
      const latestItemKeys = new Set(latestItems.map((item: any) => `${String(item?.sku || "").trim()}|${String(item?.product_name || "").trim()}|${Number(item?.qty || 0) || 0}|${Number(calcDraftItemLineTotal(item) || 0) || 0}`));
      const nextItemKeys = new Set(normalizedItems.map((item: any) => `${String(item?.sku || "").trim()}|${String(item?.product_name || "").trim()}|${Number(item?.qty || 0) || 0}|${Number(item?.line_total || 0) || 0}`));
      const manualSummary = {
        ...(latestRow?.raw_payload?.manual_summary || {}),
        edited: true,
        edited_at: new Date().toISOString(),
        notes: String(poSummaryDraft.notes || "").trim(),
        item_count: normalizedItems.length,
        has_manual_additions: normalizedItems.some((item: any) => item.line_source === "manually_added"),
        has_manual_edits: normalizedItems.some((item: any) => item.line_source === "manually_edited"),
        has_deleted_items: latestItems.length > normalizedItems.length || Array.from(latestItemKeys).some((key: any) => !nextItemKeys.has(key)),
        subtotal_mismatch_warning: Math.abs((Number(poSummaryDraft.subtotal_amount || 0) || 0) - calcDraftItemsAmount(normalizedItems)) >= 1,
      };
      const payload = {
        customer_id: customerId,
        po_number: poNumber,
        delivery_date: poSummaryDraft.delivery_date || null,
        subtotal_amount: Number(poSummaryDraft.subtotal_amount || 0) || null,
        vat_amount: Number(poSummaryDraft.vat_amount || 0) || null,
        total_amount: Number(safeTotal || 0) || null,
        production_items: normalizedItems,
        raw_payload: {
          ...(latestRow?.raw_payload || {}),
          po_number: poNumber,
          manual_summary: manualSummary,
        },
      };
      let updateQuery = (supabase as any)
        .from("customer_po_inbox")
        .update(payload)
        .eq("id", selectedPoId);
      if (latestRow?.updated_at) updateQuery = updateQuery.eq("updated_at", latestRow.updated_at);
      const { data, error } = await updateQuery
        .select("id,po_number,customer_id,raw_payload,updated_at")
        .single();
      if (error) throw error;
      if (!data) throw new Error("Lưu thất bại vì dữ liệu PO vừa thay đổi ở nơi khác. Vui lòng tải lại và thử lại.");
      return data;
    },
    onSuccess: async (saved: any) => {
      const poCode = saved?.po_number || poSummaryDraft?.po_number || selectedPoId;
      const nextDraft = { ...poSummaryDraft };
      setPoDraftBaseSignature(buildPoDraftSignature(nextDraft));
      setPoDraftHydrationNonce((n) => n + 1);
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      setSavePoStatus(`✅ Lưu thành công: ${poCode}`);
      toast({ title: "✅ Đã lưu tóm tắt PO", description: String(poCode || "") });
    },
    onError: (e: any) => {
      const errMsg = getReadableError(e);
      setSavePoStatus(`❌ Lưu thất bại: ${errMsg}`);
      toast({ title: "Lỗi lưu PO", description: errMsg, variant: "destructive" });
    },
  });

  const requestParseAttachment = () => {
    if (!selectedPo?.id) return;
    if (isPoDraftDirty) {
      setPendingParseAction("attachment");
      return;
    }
    parseAttachmentMutation.mutate(selectedPo.id);
  };

  const requestParseFromEmailBody = () => {
    if (isPoDraftDirty) {
      setPendingParseAction("email_body");
      return;
    }
    applyParseFromEmailBody();
  };

  const confirmOverwriteDraftAndParse = () => {
    if (pendingParseAction === "attachment") {
      setPendingParseAction(null);
      if (selectedPo?.id) parseAttachmentMutation.mutate(selectedPo.id);
      return;
    }
    if (pendingParseAction === "email_body") {
      setPendingParseAction(null);
      applyParseFromEmailBody();
    }
  };

  const applyParseFromEmailBody = () => {
    const parsed = parseEmailBodyToProductionItems(selectedPo?.email_subject, selectedPo?.body_preview || selectedPo?.raw_payload?.snippet || "", selectedPoAiConfig);
    const nextItems = normalizePoDraftItems(Array.isArray(parsed.items) ? parsed.items : []);
    replacePoDraftItems(nextItems, {
      delivery_date: poSummaryDraft?.delivery_date || parsed.deliveryDate || "",
      subtotal_amount: 0,
      vat_amount: 0,
      total_amount: 0,
    });
    setSavePoStatus(parsed.aiApplied ? "Đã cập nhật draft từ nội dung email theo AI rule đã duyệt. Nhớ lưu trước khi đẩy doanh thu." : "Đã cập nhật draft từ nội dung email. Nhớ lưu trước khi đẩy doanh thu.");
    if (!nextItems.length) {
      toast({ title: "Không parse được từ nội dung email", description: "Email có thể bị cắt ngắn. Vui lòng mở mail gốc hoặc bổ sung thủ công.", variant: "destructive" });
      return;
    }
    toast({ title: "Đã parse từ nội dung email", description: `${nextItems.length} dòng sản phẩm` });
  };

  // Revenue posting must always use persisted DB data; unsaved draft state is intentionally blocked.
  const handlePostRevenue = () => {
    if (!selectedPo?.id) return;
    if (isPoDraftDirty) {
      const message = "Draft PO đang có thay đổi chưa lưu. Vui lòng lưu tóm tắt PO trước khi đẩy sang kiểm soát doanh thu.";
      setPostRevenueStatus(`⚠️ ${message}`);
      toast({ title: "Cần lưu trước khi đẩy doanh thu", description: message, variant: "destructive" });
      return;
    }
    postRevenueMutation.mutate(selectedPo.id);
  };

  const postRevenueMutation = useMutation({
    onMutate: () => {
      setPostRevenueStatus("Đang đẩy dữ liệu sang Kiểm soát doanh thu...");
      toast({ title: "Đang đẩy sang kiểm soát doanh thu..." });
    },
    mutationFn: async (id: string) => {
      const nowIso = new Date().toISOString();
      const { data: row, error: rowErr } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id,customer_id,po_number,delivery_date,email_subject,total_amount,subtotal_amount,vat_amount,revenue_channel,production_items,raw_payload")
        .eq("id", id)
        .single();
      if (rowErr || !row) throw rowErr || new Error("Không tìm thấy PO để đẩy doanh thu");
      if (row?.raw_payload?.revenue_post?.posted) {
        throw new Error("PO này đã được đẩy doanh thu trước đó. Hệ thống đã chặn double-post.");
      }

      const { data: kbProfile } = await (supabase as any)
        .from("mini_crm_knowledge_profiles")
        .select("po_mode,profile_name")
        .eq("customer_id", row.customer_id)
        .maybeSingle();
      const poMode = String(kbProfile?.po_mode || "daily_new_po");

      const postedSubtotal = Number(row?.subtotal_amount || 0);
      const postedVat = Number(row?.vat_amount || 0);
      const fullTotal = Number(
        calcSafeTotal(postedSubtotal, postedVat, row?.total_amount) ||
        row?.total_amount ||
        calcTotalFromRawPayload(row?.raw_payload || {}) ||
        0
      );

      let finalAmount = fullTotal;
      let baseAmount = 0;
      let deltaAmount = fullTotal;
      let requiresReview = false;
      let reviewReason: string | null = null;

      if (poMode === "cumulative_snapshot") {
        const { data: previousRows, error: prevErr } = await (supabase as any)
          .from("customer_po_inbox")
          .select("id,po_number,delivery_date,received_at,production_items,raw_payload")
          .eq("customer_id", row.customer_id)
          .neq("id", row.id)
          .eq("match_status", "approved")
          .order("received_at", { ascending: false })
          .limit(200);
        if (prevErr) throw prevErr;

        const postedRows = (previousRows || []).filter((x: any) => Boolean(x?.raw_payload?.revenue_post?.posted));
        const rowPoNumber = String(row.po_number || "").trim();
        const rowDay = normalizeIsoDay(row.delivery_date);
        const rowSignature = buildItemsSignature(Array.isArray(row.production_items) ? row.production_items : []);

        const strictByPo = postedRows.find((x: any) => rowPoNumber && String(x.po_number || "").trim() === rowPoNumber) || null;
        const strictByDayAndSig = postedRows.find((x: any) => {
          const xDay = normalizeIsoDay(x.delivery_date);
          const xSig = buildItemsSignature(Array.isArray(x.production_items) ? x.production_items : []);
          return Boolean(rowDay && xDay && rowDay === xDay && rowSignature && xSig && rowSignature === xSig);
        }) || null;
        const fallbackByDay = postedRows.find((x: any) => {
          const xDay = normalizeIsoDay(x.delivery_date);
          return Boolean(rowDay && xDay && rowDay === xDay);
        }) || null;

        const baseline = strictByPo || strictByDayAndSig || fallbackByDay || postedRows[0] || null;

        baseAmount = Number(baseline?.raw_payload?.revenue_post?.total || baseline?.raw_payload?.revenue_post?.amount || 0);
        deltaAmount = Number(fullTotal - baseAmount);
        finalAmount = deltaAmount > 0 ? deltaAmount : 0;

        if (deltaAmount <= 0) {
          requiresReview = true;
          reviewReason = `Cumulative snapshot không tăng thêm (delta=${deltaAmount.toLocaleString("vi-VN")}).`;
        }
      }

      const nextRawPayload = {
        ...(row.raw_payload || {}),
        revenue_post: {
          posted: !requiresReview,
          posted_at: !requiresReview ? nowIso : null,
          posted_by: "mini-crm-ui",
          mode: poMode,
          profile_name: kbProfile?.profile_name || null,
          amount: finalAmount,
          subtotal: postedSubtotal,
          vat: postedVat,
          total: finalAmount,
          full_snapshot_total: fullTotal,
          base_amount: baseAmount,
          delta_amount: deltaAmount,
          requires_review: requiresReview,
          review_reason: reviewReason,
        },
      };

      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .update({ raw_payload: nextRawPayload, match_status: requiresReview ? "draft" : "approved" })
        .eq("id", id)
        .select("id,customer_id,email_subject,total_amount,revenue_channel,raw_payload")
        .single();
      if (error) throw error;

      await (supabase as any).from("po_revenue_post_audit").insert({
        po_inbox_id: id,
        customer_id: row.customer_id,
        action: requiresReview ? "flag_review" : "post",
        amount: Number(finalAmount || 0),
        full_snapshot_total: Number(fullTotal || 0),
        base_amount: Number(baseAmount || 0),
        delta_amount: Number(deltaAmount || 0),
        decision: requiresReview ? "needs_review" : "posted",
        note: reviewReason,
        actor: "mini-crm-ui",
        raw_payload: nextRawPayload?.revenue_post || {},
      });

      if (requiresReview) {
        throw new Error(reviewReason || "PO cumulative cần duyệt điều chỉnh trước khi ghi nhận doanh thu");
      }
      if (!data?.raw_payload?.revenue_post?.posted) throw new Error("Đẩy doanh thu chưa được ghi nhận trong raw_payload.revenue_post");
      return {
        ...data,
        posted_to_revenue_at: data?.raw_payload?.revenue_post?.posted_at || nowIso,
      };
    },
    onSuccess: async (row: any) => {
      const poCode = extractPoNumberFromSubject(row?.email_subject) || row?.id;
      setPostRevenueStatus(`✅ Đã đẩy thành công PO ${poCode} lúc ${new Date(row?.posted_to_revenue_at || Date.now()).toLocaleString("vi-VN")}`);
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      await queryClient.invalidateQueries({ queryKey: ["finance-posted-po"] });
      await queryClient.invalidateQueries({ queryKey: ["po-revenue-post-audit"] });
      const postedDisplay = Number(row?.raw_payload?.revenue_post?.total || row?.raw_payload?.revenue_post?.amount || row?.total_amount || 0);
      toast({
        title: "✅ Đã đẩy sang kiểm soát doanh thu",
        description: `${extractPoNumberFromSubject(row?.email_subject) || row?.id} • ${postedDisplay.toLocaleString("vi-VN")} ₫ • ${row?.revenue_channel || "(chưa có kênh)"}`,
      });
    },
    onError: (e: any) => {
      const errMsg = getReadableError(e);
      setPostRevenueStatus(`❌ Đẩy thất bại: ${errMsg}`);
      toast({
        title: "❌ Đẩy sang kiểm soát doanh thu thất bại",
        description: errMsg,
        variant: "destructive",
      });
    },
  });

  const autoPostSafeMutation = useMutation({
    mutationFn: async () => {
      const safeRows = (poInbox || []).filter((row: any) => {
        const kb = customerKnowledgeProfiles.find((x: any) => x.customer_id === row.customer_id);
        const mode = String(kb?.po_mode || "daily_new_po");
        const rp = row?.raw_payload?.revenue_post || {};
        const total = Number(row?.total_amount || calcTotalFromRawPayload(row?.raw_payload || {}) || 0);
        return (
          mode === "daily_new_po" &&
          !rp?.posted &&
          !rp?.requires_review &&
          !["rejected", "unmatched"].includes(String(row?.match_status || "")) &&
          total > 0 &&
          Boolean(row?.po_number || extractPoNumberFromSubject(row?.email_subject))
        );
      });

      let posted = 0;
      for (const row of safeRows) {
        const nowIso = new Date().toISOString();
        const total = Number(row?.total_amount || calcTotalFromRawPayload(row?.raw_payload || {}) || 0);
        const nextRawPayload = {
          ...(row?.raw_payload || {}),
          revenue_post: {
            ...(row?.raw_payload?.revenue_post || {}),
            posted: true,
            posted_at: nowIso,
            posted_by: "mini-crm-auto-safe",
            mode: "daily_new_po",
            amount: total,
            total,
            full_snapshot_total: total,
            base_amount: 0,
            delta_amount: total,
            requires_review: false,
            review_reason: null,
          },
        };

        const { error } = await (supabase as any)
          .from("customer_po_inbox")
          .update({ raw_payload: nextRawPayload, match_status: "approved" })
          .eq("id", row.id);
        if (error) throw error;

        await (supabase as any).from("po_revenue_post_audit").insert({
          po_inbox_id: row.id,
          customer_id: row.customer_id,
          action: "auto_post_safe",
          amount: total,
          full_snapshot_total: total,
          base_amount: 0,
          delta_amount: total,
          decision: "posted",
          note: "Auto-post safe rule (daily_new_po)",
          actor: "mini-crm-auto-safe",
          raw_payload: nextRawPayload?.revenue_post || {},
        });

        posted += 1;
      }
      return { posted, totalCandidates: safeRows.length };
    },
    onSuccess: async (res: any) => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      await queryClient.invalidateQueries({ queryKey: ["po-revenue-post-audit"] });
      toast({ title: "Auto-post safe hoàn tất", description: `Đã post ${res?.posted || 0}/${res?.totalCandidates || 0} PO an toàn.` });
    },
    onError: (e: any) => {
      toast({ title: "Auto-post safe lỗi", description: e?.message || "Không thể chạy auto-post", variant: "destructive" });
    },
  });

  const exportDeltaReconciliationCsv = () => {
    const rows = filteredPoInbox
      .filter((row: any) => {
        const revenuePost = row?.raw_payload?.revenue_post;
        return Boolean(revenuePost && (revenuePost.delta_amount != null || revenuePost.base_amount != null || revenuePost.full_snapshot_total != null));
      })
      .map((row: any) => {
        const revenuePost = row?.raw_payload?.revenue_post || {};
        const kb = customerKnowledgeProfiles.find((x: any) => x.customer_id === row.customer_id);
        return {
          received_at: row?.received_at || "",
          customer_name: row?.mini_crm_customers?.customer_name || "",
          po_number: row?.po_number || "",
          subject: row?.email_subject || "",
          po_mode: String(kb?.po_mode || "daily_new_po"),
          match_status: row?.match_status || "",
          full_snapshot_total: Number(revenuePost?.full_snapshot_total || 0),
          base_amount: Number(revenuePost?.base_amount || 0),
          delta_amount: Number(revenuePost?.delta_amount || 0),
          posted_amount: Number(revenuePost?.total || revenuePost?.amount || 0),
          requires_review: revenuePost?.requires_review ? "yes" : "no",
          review_decision: String(revenuePost?.review_decision || ""),
          reviewed_at: revenuePost?.reviewed_at || "",
          posted_at: revenuePost?.posted_at || "",
        };
      });

    if (!rows.length) {
      toast({ title: "Không có dữ liệu delta", description: "Chưa có bản ghi cumulative để xuất báo cáo." });
      return;
    }

    const headers = Object.keys(rows[0]);
    const esc = (v: any) => {
      const s = String(v ?? "");
      if (s.includes('"') || s.includes(',') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => esc((r as any)[h])).join(","))].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `po-delta-reconciliation-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Đã xuất CSV đối soát delta", description: `${rows.length} dòng` });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-display font-bold">{isSalesPoPage ? "PO (Bán hàng)" : "CRM"}</h1>
          <p className="text-muted-foreground">
            {isSalesPoPage
              ? "Duyệt tay PO từ hộp thư po@bmq.vn và đẩy doanh thu."
              : "Quản lý thông tin khách hàng và map email nhận diện."}
          </p>
          {isSalesPoPage && <p className="text-xs text-muted-foreground mt-1">Kết nối Gmail PO được cấu hình trong Settings.</p>}
        </div>
        {isSalesPoPage && (
          <div className="flex flex-col gap-2 items-end">
            {gmailConnectedEmail ? <Badge>{gmailConnectedEmail}</Badge> : <Badge variant="secondary">Chưa kết nối Gmail PO</Badge>}
            <div className="flex items-center gap-2">
              <Input type="date" value={syncDate} onChange={(e) => setSyncDate(e.target.value)} className="w-[150px] h-9" />
              <Button onClick={() => { setSyncModalOpen(true); syncGmailMutation.mutate(); }} disabled={syncGmailMutation.isPending || !gmailConnectedEmail}>
                {syncGmailMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Sync PO
              </Button>
            </div>
          </div>
        )}
      </div>

      {isSalesPoPage && (
        <>
        <Dialog open={syncModalOpen} onOpenChange={setSyncModalOpen}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Sync PO từ Gmail</DialogTitle>
              <DialogDescription>Đồng bộ để xem trước, chỉ nhập vào hệ thống khi bấm "Nhập PO vào hệ thống".</DialogDescription>
            </DialogHeader>

            <div className="text-xs rounded-md border bg-muted/30 p-3 space-y-1">
              <div><b>Trạng thái:</b> {syncStatus === "syncing" ? "Đang sync..." : syncStatus === "preview_success" ? "Đã lấy preview" : syncStatus === "import_success" ? "Đã nhập thành công" : syncStatus === "error" ? "Lỗi" : "Sẵn sàng"}</div>
              <div>Mailbox: {syncDebug?.mailbox || "-"}</div>
              <div>Query: <span className="font-mono">{syncDebug?.query || "-"}</span></div>
              <div>Matched (Gmail): {syncDebug?.resultSizeEstimate || 0} • Fetched: {syncDebug?.fetched || 0} • Synced: {syncDebug?.synced || 0}</div>
              <div>Loại do ngoài CRM: {syncDebug?.debug?.skippedNotInCrm || 0}</div>
              {!!(syncDebug?.debug?.skippedNotInCrmSamples?.length) && (
                <div className="text-muted-foreground">Mẫu email bị loại: {syncDebug.debug.skippedNotInCrmSamples.join(", ")}</div>
              )}
              {syncError && <div className="text-destructive">Lỗi: {syncError}</div>}
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <div className="border rounded-md max-h-80 overflow-auto">
                {(previewItems || []).map((item: any) => {
                  const isChecked = selectedPreviewIds.includes(item.messageId);
                  return (
                    <button
                      key={item.messageId}
                      type="button"
                      onClick={() => setSelectedPreviewId(item.messageId)}
                      className={`w-full text-left p-3 border-b hover:bg-muted/40 ${selectedPreviewId === item.messageId ? "bg-muted" : ""}`}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setSelectedPreviewIds((prev) => checked
                              ? Array.from(new Set([...prev, item.messageId]))
                              : prev.filter((id) => id !== item.messageId)
                            );
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-muted-foreground">{new Date(item.receivedAt).toLocaleString("vi-VN")}</div>
                          <div className="font-medium text-sm line-clamp-1">{item.subject}</div>
                          <div className="text-xs line-clamp-1">{item.fromEmail}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {previewItems.length === 0 && <div className="p-3 text-sm text-muted-foreground">Không lấy được nội dung PO.</div>}
              </div>

              <div className="border rounded-md p-3 text-sm space-y-2">
                {selectedPreview ? (
                  <>
                    <div><b>From:</b> {selectedPreview.fromEmail}</div>
                    <div><b>Subject:</b> {selectedPreview.subject}</div>
                    <div><b>Snippet:</b> {selectedPreview.snippet || "(trống)"}</div>
                    <div><b>Attachments:</b> {(selectedPreview.attachmentNames || []).join(", ") || "Không có"}</div>
                    <div className="pt-2 border-t mt-2 space-y-1">
                      <div><b>Mẫu PO:</b> {selectedPreview?.template?.name || "Chưa có mẫu riêng"}</div>
                      {selectedPreview?.template?.fileName && <div><b>File mẫu:</b> {selectedPreview.template.fileName}</div>}
                      {selectedPreview?.template?.updatedAt && <div><b>Cập nhật:</b> {new Date(selectedPreview.template.updatedAt).toLocaleString("vi-VN")}</div>}
                    </div>
                  </>
                ) : (
                  <div className="text-muted-foreground">Chọn một PO để xem chi tiết.</div>
                )}
              </div>
            </div>

            <div className="flex justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                Đã chọn: <b>{selectedPreviewIds.length}</b> / {previewItems.length}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedPreviewIds(previewItems.map((x: any) => x.messageId).filter(Boolean))}
                  disabled={previewItems.length === 0}
                >
                  Chọn tất cả
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedPreviewIds([])}
                  disabled={selectedPreviewIds.length === 0}
                >
                  Bỏ chọn
                </Button>
              </div>

              <div className="flex justify-end gap-2 items-center flex-wrap">
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground mr-2">
                  <input type="checkbox" checked={confirmTemplateRead} onChange={(e) => setConfirmTemplateRead(e.target.checked)} />
                  Đã kiểm tra PO theo mẫu và xác nhận đúng
                </label>
                <Button variant="outline" onClick={() => setSyncModalOpen(false)}>Huỷ</Button>
                <Button
                  variant="secondary"
                  onClick={() => importPoMutation.mutate("selected")}
                  disabled={importPoMutation.isPending || selectedPreviewIds.length === 0 || syncStatus === "syncing"}
                >
                  {importPoMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Nhập PO đã chọn
                </Button>
                <Button onClick={() => importPoMutation.mutate("all")} disabled={importPoMutation.isPending || previewItems.length === 0 || syncStatus === "syncing"}>
                  {importPoMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Nhập tất cả PO
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(pendingParseAction)} onOpenChange={(open) => { if (!open) setPendingParseAction(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Ghi đè thay đổi chưa lưu?</DialogTitle>
              <DialogDescription>Draft hiện tại có thay đổi chưa lưu. Nếu parse lại bây giờ, các chỉnh sửa tay trên màn hình có thể bị thay thế.</DialogDescription>
            </DialogHeader>
            <div className="text-sm text-muted-foreground">Hãy lưu trước nếu muốn giữ lại chỉnh sửa hiện tại.</div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPendingParseAction(null)}>Huỷ</Button>
              <Button variant="destructive" onClick={confirmOverwriteDraftAndParse}>Vẫn parse và ghi đè</Button>
            </div>
          </DialogContent>
        </Dialog>
        </>
      )}

      {!isSalesPoPage && (
      <> 
      <div className="flex justify-end">
        <Button onClick={() => setSetupModalOpen(true)}>Thiết lập khách hàng</Button>
      </div>

      <Dialog open={setupModalOpen} onOpenChange={setSetupModalOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Thiết lập khách hàng</DialogTitle>
            <DialogDescription>Tạo mới khách hàng, upload hợp đồng, thiết lập giá bán SKU và mẫu PO.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Tên khách hàng</Label>
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Ví dụ: Đại lý Hòa Bình" />
            </div>
            <div className="space-y-2">
              <Label>Nhóm khách hàng</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={customerGroup} onChange={(e) => setCustomerGroup(e.target.value)}>
                {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Nhóm sản phẩm</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={productGroup} onChange={(e) => setProductGroup(e.target.value)}>
                {PRODUCT_GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Email nhận diện (phân tách dấu phẩy)</Label>
              <Input value={emailsInput} onChange={(e) => setEmailsInput(e.target.value)} placeholder="buyer@agency.com, order@agency.com" />
            </div>
            <div className="space-y-2">
              <Label>NPP (yes/no)</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={setupIsNpp ? "yes" : "no"} onChange={(e) => {
                const next = e.target.value === "yes";
                setSetupIsNpp(next);
                if (next) {
                  setSetupUsesNpp(false);
                  setSetupSuppliedByNppCustomerId("");
                }
              }}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Lấy hàng qua NPP</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={setupUsesNpp ? "yes" : "no"} onChange={(e) => {
                const next = e.target.value === "yes";
                setSetupUsesNpp(next);
                if (!next) {
                  setSetupSuppliedByNppCustomerId("");
                } else if (setupAvailableNppCustomers.length === 1) {
                  setSetupSuppliedByNppCustomerId(String(setupAvailableNppCustomers[0].id));
                }
              }} disabled={setupIsNpp}>
                <option value="no">Không</option>
                <option value="yes">Có</option>
              </select>
            </div>
            {setupUsesNpp && !setupIsNpp && (
              <div className="space-y-2 md:col-span-2">
                <Label>Chọn nhà phân phối</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={setupSuppliedByNppCustomerId} onChange={(e) => setSetupSuppliedByNppCustomerId(e.target.value)}>
                  <option value="">-- Chọn nhà phân phối --</option>
                  {setupAvailableNppCustomers.map((npp: any) => <option key={npp.id} value={npp.id}>{npp.customer_name}</option>)}
                </select>
                {setupAvailableNppCustomers.length === 0 && <div className="text-xs text-muted-foreground">Chưa có khách hàng nào được đánh dấu là NPP để chọn.</div>}
              </div>
            )}

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Upload hợp đồng (PDF)</Label>
              <Input type="file" accept="application/pdf,.pdf" onChange={(e) => setSetupContractFile(e.target.files?.[0] || null)} />
              {setupContractFile && <div className="text-xs text-muted-foreground">{setupContractFile.name}</div>}
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Giá bán theo SKU thành phẩm</Label>
              <div className="space-y-2">
                {setupPriceRows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2">
                    <select className="col-span-7 h-10 rounded-md border border-input bg-background px-3 text-sm" value={row.skuId} onChange={(e) => setSetupPriceRows((prev) => prev.map((r, i) => i === idx ? { ...r, skuId: e.target.value } : r))}>
                      <option value="">-- Chọn SKU thành phẩm --</option>
                      {finishedSkus.map((s: any) => <option key={s.id} value={s.id}>{s.sku_code} - {s.product_name}</option>)}
                    </select>
                    <Input className="col-span-4" value={row.price} onChange={(e) => setSetupPriceRows((prev) => prev.map((r, i) => i === idx ? { ...r, price: e.target.value } : r))} placeholder="VND/cái" />
                    <Button type="button" variant="outline" className="col-span-1" onClick={() => setSetupPriceRows((prev) => prev.filter((_, i) => i !== idx))} disabled={setupPriceRows.length === 1}>-</Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" onClick={() => setSetupPriceRows((prev) => [...prev, { skuId: "", price: "" }])}>+ Thêm sản phẩm</Button>
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Upload form mẫu PO (.xlsx)</Label>
              <Input
                type="file"
                accept=".xlsx"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    await handleAnalyzeTemplateFile(f);
                  } catch (err: any) {
                    toast({ title: "Đọc file mẫu thất bại", description: err?.message || "Không thể đọc file", variant: "destructive" });
                  }
                }}
              />
              {templateFileName && <div className="text-xs text-muted-foreground">Đã xác nhận: {templateFileName}</div>}
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Mẫu nội dung PO từ email (copy/paste)</Label>
              <textarea
                className="min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={setupEmailBodyTemplate}
                onChange={(e) => setSetupEmailBodyTemplate(e.target.value)}
                placeholder="Dán 1 mẫu email PO thực tế để lưu vào Knowledge Base (không bắt buộc)."
              />
              <div className="text-xs text-muted-foreground">Dùng khi khách hàng gửi PO trong nội dung email thay vì file đính kèm.</div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSetupModalOpen(false)}>Huỷ</Button>
            <Button onClick={() => setupCustomerMutation.mutate()} disabled={setupCustomerMutation.isPending}>
              {setupCustomerMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Lưu thiết lập khách hàng
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách khách hàng</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center gap-2">
            <Input
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              placeholder="Tìm khách hàng (hỗ trợ tiếng Việt: ví dụ 'my tho', 'mỹ thọ', email...)"
              className="max-w-md"
            />
            {customerSearch && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setCustomerSearch("")}>Xoá</Button>
            )}
          </div>
          {editFeedback && (
            <div
              className={`mb-3 rounded-md border px-3 py-2 text-sm ${
                editFeedback.startsWith("Lưu thất bại")
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : editFeedback.startsWith("Đã lưu")
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-border bg-muted/40 text-muted-foreground"
              }`}
            >
              {editFeedback}
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên</TableHead>
                <TableHead>Nhóm</TableHead>
                <TableHead>Nhóm sản phẩm</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>NPP</TableHead>
                <TableHead>Lấy qua NPP</TableHead>
                <TableHead>Knowledge</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead className="text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCustomers.map((c: any) => {
                return (
                  <TableRow key={c.id}>
                    <TableCell>{c.customer_name}</TableCell>
                    <TableCell>{GROUP_LABEL_MAP[c.customer_group] || c.customer_group}</TableCell>
                    <TableCell>{PRODUCT_GROUP_LABEL_MAP[c.product_group] || c.product_group || "-"}</TableCell>
                    <TableCell>{(c.mini_crm_customer_emails || []).map((e: any) => e.email).join(", ") || "-"}</TableCell>
                    <TableCell>{c.is_npp ? <Badge variant="default">Yes</Badge> : <Badge variant="secondary">No</Badge>}</TableCell>
                    <TableCell>{(() => { const npp = customers.find((x: any) => x.id === c.supplied_by_npp_customer_id); return npp?.customer_name || "-"; })()}</TableCell>
                    <TableCell>
                      {(() => {
                        const kb = customerKnowledgeProfiles.find((x: any) => x.customer_id === c.id);
                        const latestVer = knowledgeProfileVersions.find((v: any) => v.customer_id === c.id);
                        if (!kb) return <span className="text-xs text-muted-foreground">Chưa cấu hình</span>;
                        return (
                          <div className="space-y-1">
                            <div className="text-xs font-medium">{kb.profile_name || "Default"}</div>
                            <div className="flex gap-1 flex-wrap">
                              <Badge variant="outline" className="text-[10px]">
                                {String(kb.po_mode || "") === "cumulative_snapshot" ? "Cộng dồn (delta)" : "PO ngày"}
                              </Badge>
                              {latestVer?.version_no && (
                                <Badge variant="secondary" className="text-[10px]">KB v{latestVer.version_no}</Badge>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell>{c.is_active ? <Badge>Active</Badge> : <Badge variant="secondary">Tạm ngưng</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setViewCustomer(c)}>Xem</Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (confirm(`Xoá khách hàng ${c.customer_name}?`)) deleteCustomerMutation.mutate({ customerId: c.id, customerName: c.customer_name });
                          }}
                          disabled={deleteCustomerMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 mr-1" />Xoá
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filteredCustomers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-6">Không tìm thấy khách hàng phù hợp.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      </>
      )}

      {isSalesPoPage && (
      <>
      <Card className="border-border/70 bg-gradient-to-b from-background to-muted/20 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <CardTitle className="text-2xl">PO Inbox (manual approval bắt buộc)</CardTitle>
              <CardDescription className="mt-1">PO đọc từ email po@bmq.vn sẽ nằm ở đây trước khi duyệt tay.</CardDescription>
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div className="rounded-lg border bg-background/80 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Đang lọc</div>
                <div className="text-xl font-semibold leading-tight">{filteredPoInbox.length}</div>
              </div>
              <div className="rounded-lg border bg-background/80 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Pending</div>
                <div className="text-xl font-semibold leading-tight">{statusCounts.pending_approval || 0}</div>
              </div>
              <div className="rounded-lg border bg-background/80 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Approved</div>
                <div className="text-xl font-semibold leading-tight">{statusCounts.approved || 0}</div>
              </div>
              <div className="rounded-lg border bg-background/80 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Needs review</div>
                <div className="text-xl font-semibold leading-tight text-amber-600">{pendingDeltaReviewCount}</div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border bg-background/70 p-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="space-y-1">
                <Label>Từ ngày</Label>
                <Input type="date" value={poDateFrom} onChange={(e) => setPoDateFrom(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Đến ngày</Label>
                <Input type="date" value={poDateTo} onChange={(e) => setPoDateTo(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Khách hàng</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={poCustomerFilter} onChange={(e) => setPoCustomerFilter(e.target.value)}>
                  <option value="all">Tất cả khách hàng</option>
                  {customers.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.customer_name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label>PO mode</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={poModeFilter} onChange={(e) => setPoModeFilter(e.target.value)}>
                  <option value="all">Tất cả mode</option>
                  <option value="daily_new_po">PO mới theo ngày</option>
                  <option value="cumulative_snapshot">PO cộng dồn (delta)</option>
                </select>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm rounded-md border bg-background px-3 h-10 w-full">
                  <input
                    type="checkbox"
                    checked={poNeedsDeltaReviewOnly}
                    onChange={(e) => setPoNeedsDeltaReviewOnly(e.target.checked)}
                  />
                  Chỉ hiện Needs delta review
                </label>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPoDateFrom("");
                  setPoDateTo("");
                  setPoNeedsDeltaReviewOnly(false);
                  setPoCustomerFilter("all");
                  setPoModeFilter("all");
                }}
              >
                Reset bộ lọc
              </Button>
              <Button type="button" variant="secondary" onClick={exportDeltaReconciliationCsv}>
                Xuất CSV đối soát delta
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!vietjetCustomerId) {
                    toast({ title: "Chưa tìm thấy khách Vietjet", description: "Vui lòng kiểm tra tên customer trong CRM." });
                    return;
                  }
                  setPoCustomerFilter(vietjetCustomerId);
                  setPoModeFilter("cumulative_snapshot");
                  setPoNeedsDeltaReviewOnly(true);
                }}
              >
                Preset Vietjet review
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!vietjetCustomerId) {
                    toast({ title: "Chưa tìm thấy khách Vietjet", description: "Vui lòng kiểm tra tên customer trong CRM." });
                    return;
                  }
                  setPoCustomerFilter(vietjetCustomerId);
                  setPoModeFilter("cumulative_snapshot");
                  setPoNeedsDeltaReviewOnly(false);
                }}
              >
                Preset Vietjet all cumulative
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => autoPostSafeMutation.mutate()}
                disabled={autoPostSafeMutation.isPending}
              >
                {autoPostSafeMutation.isPending ? "Đang auto-post..." : "Auto-post an toàn (daily)"}
              </Button>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">Màn hình nhỏ có thể vuốt ngang để xem đủ cột.</div>
          <div className="rounded-xl border bg-background/70 overflow-x-auto">
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Received</TableHead>
                  <TableHead className="whitespace-nowrap hidden lg:table-cell">From</TableHead>
                  <TableHead className="min-w-[220px]">Subject</TableHead>
                  <TableHead className="whitespace-nowrap">Matched Customer</TableHead>
                  <TableHead className="whitespace-nowrap hidden md:table-cell">PO mode</TableHead>
                  <TableHead className="whitespace-nowrap">Status</TableHead>
                  <TableHead className="whitespace-nowrap sticky right-0 z-10 bg-background">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPoInbox.map((row: any) => (
                  <TableRow key={row.id} className="align-top hover:bg-muted/40">
                    <TableCell className="whitespace-nowrap">{new Date(row.received_at).toLocaleString("vi-VN")}</TableCell>
                    <TableCell className="min-w-[200px] break-all hidden lg:table-cell">{row.from_email}</TableCell>
                    <TableCell className="min-w-[280px]">
                      <div className="font-medium">{row.email_subject || "(no subject)"}</div>
                      <div className="text-xs text-muted-foreground mt-1 lg:hidden break-all">{row.from_email}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{row.mini_crm_customers?.customer_name || "Chưa match"}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      {(() => {
                        const kb = customerKnowledgeProfiles.find((x: any) => x.customer_id === row.customer_id);
                        if (!kb) return <span className="text-xs text-muted-foreground">Mặc định</span>;
                        return <Badge variant="outline">{KB_PO_MODE_LABEL[String(kb.po_mode || "")] || String(kb.po_mode || "-")}</Badge>;
                      })()}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={row.match_status === "approved" ? "default" : "secondary"} className="w-fit">{row.match_status}</Badge>
                        {row?.raw_payload?.revenue_post?.requires_review && (
                          <Badge variant="destructive" className="w-fit">Needs delta review</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="sticky right-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 min-w-[220px]">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setSelectedPoId(row.id);
                            setPoSummaryDraft({
                              customer_id: row.customer_id || "",
                              po_number: row.po_number || "",
                              delivery_date: row.delivery_date || "",
                              subtotal_amount: row.subtotal_amount || "",
                              vat_amount: row.vat_amount || "",
                              total_amount: row.total_amount || "",
                              notes: String(row?.raw_payload?.manual_summary?.notes || ""),
                              production_items: getPoDraftItemsFromRow(row),
                            });
                          }}
                        >
                          Xem nhanh
                        </Button>
                        <Button size="sm" onClick={() => reviewMutation.mutate({ id: row.id, status: "approved" })} disabled={reviewMutation.isPending || row.match_status === "approved"}>Approve</Button>
                        <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: row.id, status: "rejected" })} disabled={reviewMutation.isPending || row.match_status === "rejected"}>Reject</Button>
                        {row?.raw_payload?.revenue_post?.requires_review && (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => reviewDeltaMutation.mutate({ id: row.id, action: "approve_zero" })} disabled={reviewDeltaMutation.isPending}>Duyệt delta=0</Button>
                            <Button size="sm" variant="destructive" onClick={() => reviewDeltaMutation.mutate({ id: row.id, action: "reject" })} disabled={reviewDeltaMutation.isPending}>Reject delta</Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredPoInbox.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Không có PO phù hợp bộ lọc hiện tại.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Exception Queue</CardTitle>
            <CardDescription>Các PO cần xử lý thủ công trước khi chốt doanh thu.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-xs text-muted-foreground mb-2">Tổng exception: <b>{exceptionQueue.length}</b></div>
            <div className="max-h-72 overflow-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Received</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>PO</TableHead>
                    <TableHead>Lý do</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exceptionQueue.slice(0, 30).map((row: any) => (
                    <TableRow key={`ex-${row.id}`}>
                      <TableCell>{row?.received_at ? new Date(row.received_at).toLocaleString("vi-VN") : "-"}</TableCell>
                      <TableCell>{row?.mini_crm_customers?.customer_name || "-"}</TableCell>
                      <TableCell>{row?.po_number || extractPoNumberFromSubject(row?.email_subject) || row?.id}</TableCell>
                      <TableCell>{row?.raw_payload?.revenue_post?.review_reason || row?.match_status || "-"}</TableCell>
                    </TableRow>
                  ))}
                  {exceptionQueue.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Không có exception</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Revenue Audit (latest)</CardTitle>
            <CardDescription>Nhật ký post/review doanh thu mới nhất.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-72 overflow-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Thời gian</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead>Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRevenueAudit.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell>{r?.created_at ? new Date(r.created_at).toLocaleString("vi-VN") : "-"}</TableCell>
                      <TableCell>{r?.mini_crm_customers?.customer_name || "-"}</TableCell>
                      <TableCell>{String(r?.action || "-")}</TableCell>
                      <TableCell>{String(r?.decision || "-")}</TableCell>
                      <TableCell>{Number(r?.amount || 0).toLocaleString("vi-VN")} ₫</TableCell>
                    </TableRow>
                  ))}
                  {recentRevenueAudit.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Chưa có audit log</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {isSalesPoPage && (
        <Dialog
          open={Boolean(selectedPo)}
          onOpenChange={(open) => {
            if (!open) setSelectedPoId(null);
          }}
        >
          <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
            {selectedPo && (
              <>
                <DialogHeader>
                  <DialogTitle>PO Quick View: {poSummaryDraft.po_number || selectedPo.po_number || selectedPo.email_subject}</DialogTitle>
                  <DialogDescription>Giao diện xem nhanh cho Kế toán và Quản lí sản xuất (không cần mở email).</DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">
                    <div><b>From:</b> {selectedPo.from_email}</div>
                    <div><b>Subject:</b> {selectedPo.email_subject}</div>
                    <div><b>Nội dung nhanh:</b> {selectedPo.body_preview || "(trống)"}</div>
                    <div><b>Attachments:</b> {(selectedPo.attachment_names || []).join(", ") || "Không có"}</div>
                    <div>
                      <b>Knowledge mode:</b> {selectedPoKnowledgeProfile ? (KB_PO_MODE_LABEL[String(selectedPoKnowledgeProfile.po_mode || "")] || String(selectedPoKnowledgeProfile.po_mode || "-")) : "Mặc định (PO mới theo ngày)"}
                    </div>
                    <div>
                      <b>PO source:</b> {KB_PO_SOURCE_LABEL[getKbPoSource(selectedPoKnowledgeProfile)] || "Ưu tiên parse file đính kèm"}
                    </div>
                    {!selectedPoKnowledgeProfile && (
                      <div className="text-amber-600">
                        Chưa áp dụng KB theo khách hàng cho email này. Vui lòng kiểm tra mapping email khách hàng trong CRM.
                      </div>
                    )}
                    {selectedPoKnowledgeProfile?.operational_notes && (
                      <div><b>Ops note:</b> {stripKbSystemMarkers(String(selectedPoKnowledgeProfile.operational_notes))}</div>
                    )}
                    {selectedPo?.raw_payload?.revenue_post && (
                      <div className="rounded-md border p-2 bg-muted/30 mt-2">
                        <div className="font-medium text-foreground mb-1">Audit revenue post</div>
                        <div>Decision: {String(selectedPo.raw_payload.revenue_post.review_decision || (selectedPo.raw_payload.revenue_post.posted ? "posted" : "pending"))}</div>
                        <div>Delta: {Number(selectedPo.raw_payload.revenue_post.delta_amount || 0).toLocaleString("vi-VN")} ₫</div>
                        <div>Base: {Number(selectedPo.raw_payload.revenue_post.base_amount || 0).toLocaleString("vi-VN")} ₫</div>
                        <div>Posted: {Number(selectedPo.raw_payload.revenue_post.total || selectedPo.raw_payload.revenue_post.amount || 0).toLocaleString("vi-VN")} ₫</div>
                        <div>Reviewed at: {selectedPo.raw_payload.revenue_post.reviewed_at ? new Date(selectedPo.raw_payload.revenue_post.reviewed_at).toLocaleString("vi-VN") : "-"}</div>
                        <div>Posted at: {selectedPo.raw_payload.revenue_post.posted_at ? new Date(selectedPo.raw_payload.revenue_post.posted_at).toLocaleString("vi-VN") : "-"}</div>
                      </div>
                    )}
                  </div>

                  <SalesPoQuickViewEditor
                    selectedPo={selectedPo}
                    selectedPoResolvedCustomerId={selectedPoResolvedCustomerId}
                    customers={customers}
                    poSummaryDraft={poSummaryDraft}
                    poDraftDerivedTotalAmount={poDraftDerivedTotalAmount}
                    poDraftLineItemsAmount={poDraftLineItemsAmount}
                    poDraftSubtotalAmount={poDraftSubtotalAmount}
                    poDraftVatAmount={poDraftVatAmount}
                    poDraftSubtotalMismatch={poDraftSubtotalMismatch}
                    isPoDraftDirty={isPoDraftDirty}
                    savePoStatus={savePoStatus}
                    postRevenueStatus={postRevenueStatus}
                    parseAttachmentPending={parseAttachmentMutation.isPending}
                    savePending={savePoSummaryMutation.isPending}
                    postRevenuePending={postRevenueMutation.isPending}
                    onDraftFieldChange={(field, value) => updatePoDraft((draft: any) => ({ ...draft, [field]: value }))}
                    onAddLineItem={addPoDraftItem}
                    onPatchLineItem={patchPoDraftItem}
                    onRemoveLineItem={removePoDraftItem}
                    onParseAttachment={requestParseAttachment}
                    onParseEmailBody={requestParseFromEmailBody}
                    onSave={() => savePoSummaryMutation.mutate()}
                    onPostRevenue={handlePostRevenue}
                  />
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      )}
      </>
      )}

      <Dialog open={Boolean(viewCustomer)} onOpenChange={(open) => !open && setViewCustomer(null)}>
        <DialogContent className="max-w-3xl">
          {viewCustomer && (
            <>
              <DialogHeader>
                <DialogTitle>Xem khách hàng: {viewCustomer.customer_name}</DialogTitle>
              </DialogHeader>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => {
                    startEditCustomer(viewCustomer);
                    setViewCustomer(null);
                  }}
                >
                  <Pencil className="h-4 w-4 mr-1" />Sửa khách hàng
                </Button>
              </div>
              <div className="space-y-3 text-sm">
                <div><b>Nhóm:</b> {GROUP_LABEL_MAP[viewCustomer.customer_group] || viewCustomer.customer_group}</div>
                <div><b>Nhóm sản phẩm:</b> {PRODUCT_GROUP_LABEL_MAP[viewCustomer.product_group] || viewCustomer.product_group || "-"}</div>
                <div><b>Trạng thái:</b> {viewCustomer.is_active ? "Active" : "Tạm ngưng"}</div>
                <div><b>Email:</b> {(viewCustomer.mini_crm_customer_emails || []).map((e: any) => e.email).join(", ") || "-"}</div>
                <div><b>Hợp đồng:</b> {(customerContracts.find((x: any) => x.customer_id === viewCustomer.id)?.file_name) || "Chưa có"}</div>
                <div>
                  <b>Bảng giá:</b>
                  <ul className="list-disc pl-5">
                    {customerPriceList.filter((x: any) => x.customer_id === viewCustomer.id).length === 0 && <li>Chưa có</li>}
                    {customerPriceList.filter((x: any) => x.customer_id === viewCustomer.id).map((p: any) => {
                      const sku = finishedSkus.find((s: any) => s.id === p.sku_id);
                      return <li key={p.id}>{sku?.product_name || p.sku_id}: {Number(p.price_vnd_per_unit || 0).toLocaleString("vi-VN")} đ/cái</li>;
                    })}
                  </ul>
                </div>
                <div><b>Mẫu PO active:</b> {(() => { const t = poTemplates.find((x: any) => x.customer_id === viewCustomer.id); return t ? `${t.file_name || t.template_name} (v${t.version_no || 1})` : "Chưa có"; })()}</div>
                <div>
                  <b>Knowledge Base:</b> {(() => {
                    const kb = customerKnowledgeProfiles.find((x: any) => x.customer_id === viewCustomer.id);
                    if (!kb) return "Chưa cấu hình";
                    const modeMap: Record<string, string> = {
                      daily_new_po: "PO mới theo ngày",
                      cumulative_snapshot: "PO cộng dồn (delta)",
                    };
                    return `${kb.profile_name || "Default"} • ${modeMap[String(kb.po_mode || "")] || kb.po_mode || "-"}`;
                  })()}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingCustomerId)} onOpenChange={(open) => !open && cancelEditCustomer()}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Sửa khách hàng</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Tên khách hàng</Label>
              <Input value={editCustomerName} onChange={(e) => setEditCustomerName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Nhóm khách hàng</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editCustomerGroup} onChange={(e) => setEditCustomerGroup(e.target.value)}>
                {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Nhóm sản phẩm</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editProductGroup} onChange={(e) => setEditProductGroup(e.target.value)}>
                {PRODUCT_GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>NPP (yes/no)</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editIsNpp ? "yes" : "no"} onChange={(e) => {
                const next = e.target.value === "yes";
                setEditIsNpp(next);
                if (next) {
                  setEditUsesNpp(false);
                  setEditSuppliedByNppCustomerId("");
                }
              }}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Lấy hàng qua NPP</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editUsesNpp ? "yes" : "no"} onChange={(e) => {
                const next = e.target.value === "yes";
                setEditUsesNpp(next);
                if (!next) {
                  setEditSuppliedByNppCustomerId("");
                } else if (editAvailableNppCustomers.length === 1) {
                  setEditSuppliedByNppCustomerId(String(editAvailableNppCustomers[0].id));
                }
              }} disabled={editIsNpp}>
                <option value="no">Không</option>
                <option value="yes">Có</option>
              </select>
            </div>
            {editUsesNpp && !editIsNpp && (
              <div className="space-y-2 md:col-span-2">
                <Label>Chọn nhà phân phối</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editSuppliedByNppCustomerId} onChange={(e) => setEditSuppliedByNppCustomerId(e.target.value)}>
                  <option value="">-- Chọn nhà phân phối --</option>
                  {editAvailableNppCustomers.map((npp: any) => <option key={npp.id} value={npp.id}>{npp.customer_name}</option>)}
                </select>
                {editAvailableNppCustomers.length === 0 && <div className="text-xs text-muted-foreground">Chưa có nhà phân phối nào khả dụng để chọn.</div>}
              </div>
            )}
            <div className="space-y-2 md:col-span-2">
              <Label>Email nhận diện</Label>
              <Input value={editEmailsInput} onChange={(e) => setEditEmailsInput(e.target.value)} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Trạng thái</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editIsActive ? "active" : "paused"} onChange={(e) => setEditIsActive(e.target.value === "active")}>
                <option value="active">Active</option>
                <option value="paused">Tạm ngưng</option>
              </select>
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Hợp đồng (PDF)</Label>
              <div className="text-xs">Active: {(customerContracts.find((x: any) => x.customer_id === editingCustomerId)?.file_name) || "Chưa có"}</div>
              <div className="flex gap-2">
                <Input type="file" accept="application/pdf,.pdf" onChange={(e) => setEditContractFile(e.target.files?.[0] || null)} />
                <Button type="button" variant="outline" onClick={async () => {
                  await (supabase as any).from("mini_crm_customer_contracts").update({ is_active: false }).eq("customer_id", editingCustomerId).eq("is_active", true);
                  await queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-contracts"] });
                  toast({ title: "Đã xoá hợp đồng active" });
                }}>Xoá HĐ</Button>
              </div>
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Giá bán SKU</Label>
              {editPriceRows.map((row, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 mb-2">
                  <select className="col-span-7 h-10 rounded-md border border-input bg-background px-3 text-sm" value={row.skuId} onChange={(e) => setEditPriceRows((prev) => prev.map((r, i) => i === idx ? { ...r, skuId: e.target.value } : r))}>
                    <option value="">-- Chọn SKU --</option>
                    {finishedSkus.map((s: any) => <option key={s.id} value={s.id}>{s.sku_code} - {s.product_name}</option>)}
                  </select>
                  <Input className="col-span-4" value={row.price} onChange={(e) => setEditPriceRows((prev) => prev.map((r, i) => i === idx ? { ...r, price: e.target.value } : r))} placeholder="VND/cái" />
                  <Button type="button" variant="outline" className="col-span-1" onClick={() => setEditPriceRows((prev) => prev.filter((_, i) => i !== idx))} disabled={editPriceRows.length === 1}>-</Button>
                </div>
              ))}
              <Button type="button" variant="outline" onClick={() => setEditPriceRows((prev) => [...prev, { skuId: "", price: "" }])}>+ Thêm SKU</Button>
            </div>

            <KnowledgeBaseProfileEditor
              poTemplates={poTemplates}
              editingCustomerId={editingCustomerId}
              editKbProfileName={editKbProfileName}
              editKbPoMode={editKbPoMode}
              editKbPoSource={editKbPoSource}
              editKbCalcNotes={editKbCalcNotes}
              editKbOperationalNotes={editKbOperationalNotes}
              editKbBusinessDescription={editKbBusinessDescription}
              editEmailBodyTemplate={editEmailBodyTemplate}
              kbAiSuggestion={kbAiSuggestion}
              kbAiStatus={kbAiStatus}
              kbChangeNote={kbChangeNote}
              templateFileName={templateFileName}
              templateAiContext={templateAiContext}
              kbAiSuggestPending={kbAiSuggestMutation.isPending}
              submitPending={submitKbChangeRequestMutation.isPending}
              approvePending={approveKbLatestRequestMutation.isPending}
              pendingCount={knowledgeChangeRequests.filter((r: any) => r.customer_id === editingCustomerId && r.request_status === "pending").length}
              onKbProfileNameChange={setEditKbProfileName}
              onKbPoModeChange={setEditKbPoMode}
              onKbPoSourceChange={setEditKbPoSource}
              onKbCalcNotesChange={setEditKbCalcNotes}
              onKbOperationalNotesChange={setEditKbOperationalNotes}
              onKbBusinessDescriptionChange={setEditKbBusinessDescription}
              onEmailBodyTemplateChange={setEditEmailBodyTemplate}
              onKbChangeNoteChange={setKbChangeNote}
              onTemplateFileChange={async (f) => {
                if (!f) return;
                try {
                  if (/\.xlsx$/i.test(f.name)) {
                    await handleAnalyzeTemplateFile(f);
                  } else if (/\.pdf$/i.test(f.name)) {
                    const context = await extractPdfTemplateContext(f);
                    setTemplateFileName(f.name);
                    setTemplateAiContext(context);
                    toast({ title: "Đã đọc mẫu PDF", description: context ? "Đã trích xuất text ngữ cảnh để dùng cho AI Tính Toán." : "PDF không trích được text rõ ràng, anh/chị vẫn có thể bổ sung mô tả tay." });
                  } else if ((f.type || "").startsWith("image/")) {
                    const context = await extractImageTemplateContext(f);
                    setTemplateFileName(f.name);
                    setTemplateAiContext(context);
                    toast({ title: "Đã đọc mẫu ảnh", description: context ? "Đã trích xuất ngữ cảnh từ ảnh để dùng cho AI Tính Toán." : "Ảnh chưa trích được đủ dữ liệu, anh/chị vẫn có thể bổ sung mô tả tay." });
                  } else {
                    setTemplateFileName(f.name);
                    setTemplateAiContext("");
                    toast({ title: "Đã nhận mẫu KB", description: "Định dạng file này chưa có parser riêng. Anh/chị vẫn có thể dùng mô tả business + mẫu email để AI tạo rule." });
                  }
                } catch (err: any) {
                  toast({ title: "Đọc file mẫu thất bại", description: err?.message || "Không thể đọc file", variant: "destructive" });
                }
              }}
              onClearTemplate={async () => {
                await (supabase as any).from("mini_crm_po_templates").update({ is_active: false }).eq("customer_id", editingCustomerId).eq("is_active", true);
                setTemplateFileName("");
                setTemplatePreview(null);
                setTemplateAiContext("");
                await queryClient.invalidateQueries({ queryKey: ["mini-crm-po-templates"] });
                toast({ title: "Đã xoá mẫu PO active" });
              }}
              onAiSuggest={() => kbAiSuggestMutation.mutate()}
              onSubmitApproval={() => submitKbChangeRequestMutation.mutate()}
              onApproveLatest={() => approveKbLatestRequestMutation.mutate()}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={cancelEditCustomer}>Huỷ</Button>
            <Button onClick={async () => { setEditFeedback("Đang lưu..."); try { await updateCustomerMutation.mutateAsync(); } catch (_) {} }} disabled={updateCustomerMutation.isPending}>
              {updateCustomerMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}Lưu thay đổi
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={templateConfirmOpen} onOpenChange={setTemplateConfirmOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Xác nhận mẫu PO trước khi lưu</DialogTitle>
            <DialogDescription>
              Hệ thống đã đọc file mẫu. Anh kiểm tra nội dung parse trước khi xác nhận lưu format.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <div><b>File:</b> {pendingTemplateFileName || "-"}</div>
            <div><b>Sheet:</b> {pendingTemplatePreview?.parserConfig?.sheetName || "-"}</div>
            <div><b>Header row:</b> {pendingTemplatePreview?.parserConfig?.headerRow || "-"}</div>
            <div className={`text-xs rounded px-2 py-1 ${Number(pendingTemplatePreview?.confidenceScore || 0) >= 0.9 ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700"}`}>
              Độ tin cậy parse: {Math.round(Number(pendingTemplatePreview?.confidenceScore || 0) * 100)}%
              {Number(pendingTemplatePreview?.confidenceScore || 0) < 0.9 ? " — Parse thấp, cần chỉnh tay trước khi xác nhận." : ""}
            </div>

            <Tabs defaultValue="parsed" className="w-full">
              <TabsList>
                <TabsTrigger value="parsed">Dữ liệu parse</TabsTrigger>
                <TabsTrigger value="totals">Tổng tiền</TabsTrigger>
              </TabsList>

              <TabsContent value="parsed" className="space-y-2">
                <div>
                  <Label>Ngày đặt hàng</Label>
                  <Input
                    value={templateReviewDraft?.orderDate || ""}
                    onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), orderDate: e.target.value })); }}
                    placeholder="YYYY-MM-DD hoặc theo mẫu PO"
                  />
                </div>
                <div className="rounded border max-h-64 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ngày</TableHead>
                        <TableHead>Sản phẩm</TableHead>
                        <TableHead>Số lượng</TableHead>
                        <TableHead>Đơn giá</TableHead>
                        <TableHead>Thành tiền</TableHead>
                        <TableHead className="w-[70px]">Xoá</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(templateReviewDraft?.items || []).map((it: any, idx: number) => (
                        <TableRow key={idx}>
                          <TableCell><Input value={it.date || ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, date: e.target.value } : x) })); }} placeholder="YYYY-MM-DD" /></TableCell>
                          <TableCell><Input value={it.product || ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, product: e.target.value } : x) })); }} /></TableCell>
                          <TableCell><Input value={it.qty ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, qty: e.target.value } : x) })); }} /></TableCell>
                          <TableCell><Input value={it.unitPrice ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, unitPrice: e.target.value } : x) })); }} placeholder="tuỳ chọn" /></TableCell>
                          <TableCell><Input value={it.lineTotal ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, lineTotal: e.target.value } : x) })); }} placeholder="tuỳ chọn" /></TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setTemplateReviewTouched(true);
                                setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).filter((_x: any, i: number) => i !== idx) }));
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="totals" className="space-y-2">
                <div className="grid md:grid-cols-3 gap-2">
                  <div><Label>Tạm tính</Label><Input value={templateReviewDraft?.subtotal ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), subtotal: e.target.value })); }} /></div>
                  <div><Label>VAT</Label><Input value={templateReviewDraft?.vat ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), vat: e.target.value })); }} /></div>
                  <div><Label>Thành tiền</Label><Input value={templateReviewDraft?.total ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), total: e.target.value })); }} /></div>
                </div>
                <label className="inline-flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={Boolean(templateReviewDraft?.hasNoMoneyInPo)} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), hasNoMoneyInPo: e.target.checked })); }} />
                  PO này chỉ có số lượng, chưa có thông tin tiền
                </label>
              </TabsContent>
            </Tabs>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setTemplateConfirmOpen(false)}>Huỷ</Button>
            <Button
              onClick={async () => {
                const hasOrderDate = Boolean(String(templateReviewDraft?.orderDate || "").trim());
                const validItems = (templateReviewDraft?.items || []).filter((it: any) => String(it?.date || "").trim() && String(it?.product || "").trim() && Number(String(it?.qty || 0).replace(/[^0-9.-]/g, "")) > 0);
                if (!hasOrderDate || validItems.length === 0) {
                  toast({ title: "Thiếu dữ liệu bắt buộc", description: "Cần xác nhận dải ngày và ít nhất 1 dòng hợp lệ (ngày + sản phẩm + số lượng > 0)", variant: "destructive" });
                  return;
                }

                const confidence = Number(pendingTemplatePreview?.confidenceScore || 0);
                if (confidence < 0.9 && !templateReviewTouched) {
                  toast({ title: "Parse độ tin cậy thấp", description: "Vui lòng chỉnh tay ít nhất 1 trường trước khi xác nhận lưu mẫu", variant: "destructive" });
                  return;
                }

                const selectedSourceColumns = Array.from(new Set(validItems.map((it: any) => String(it?.sourceColumnName || "").trim()).filter(Boolean)));
                const baseParserConfig = pendingTemplatePreview?.parserConfig || {};
                const baseQuantityCols = Array.isArray(baseParserConfig?.quantityColumns) ? baseParserConfig.quantityColumns : [];
                const filteredQuantityCols = selectedSourceColumns.length
                  ? baseQuantityCols.filter((q: any) => selectedSourceColumns.includes(String(q?.columnName || "").trim()))
                  : baseQuantityCols;

                const mergedPreview = {
                  ...(pendingTemplatePreview || {}),
                  parserConfig: {
                    ...baseParserConfig,
                    quantityColumns: filteredQuantityCols,
                    productNameOverrides: Object.fromEntries(
                      validItems
                        .filter((it: any) => String(it?.sourceColumnName || "").trim())
                        .map((it: any) => [String(it.sourceColumnName), String(it.product || it.sourceColumnName)])
                    ),
                  },
                  confirmationView: { ...(templateReviewDraft || {}) },
                  sampleRows: validItems,
                  confidenceScore: confidence < 0.9 && templateReviewTouched ? 0.95 : confidence,
                };

                const beforeSnap = pendingTemplatePreview?.confirmationView || {};
                const afterSnap = templateReviewDraft || {};
                const hasChanged = JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap);
                if (hasChanged) {
                  const diffSummary = summarizeTemplateDiff(beforeSnap, afterSnap);
                  try {
                    await (supabase as any).from("mini_crm_po_template_learning_logs").insert({
                      customer_id: editingCustomerId || null,
                      source_file_name: pendingTemplateFileName || null,
                      source_confidence: Number(pendingTemplatePreview?.confidenceScore || 0),
                      before_snapshot: beforeSnap,
                      after_snapshot: afterSnap,
                      diff_summary: diffSummary,
                    });
                  } catch (e) {
                    console.warn("Cannot write learning log", e);
                  }
                }

                setTemplateFileName(pendingTemplateFileName);
                setTemplatePreview(mergedPreview);
                setTemplateConfirmOpen(false);
                toast({ title: "Đã xác nhận mẫu PO", description: hasChanged ? "Đã lưu correction để cải thiện parse lần sau." : "Anh có thể bấm Lưu mẫu PO để lưu format." });
              }}
            >
              Xác nhận nội dung parse
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

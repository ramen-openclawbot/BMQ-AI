import { Gift, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  usePayrollMissionsAdmin,
  type PayrollMissionAdminCampaign,
  type PayrollMissionAdminOffer,
} from "@/hooks/usePayrollMissionsAdmin";
import type { PayrollEmployee } from "@/lib/payroll-bn/types.ts";

function shortDate(value: string): string {
  const [, m, d] = value.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : value;
}

/** The active campaign, or null. Everything about the mission comes from its data. */
export function useMissionGifts(enabled: boolean) {
  const admin = usePayrollMissionsAdmin({ enabled });
  const campaign: PayrollMissionAdminCampaign | null =
    admin.campaigns.find((item) => item.status === "active") ?? null;
  const offerByCode = new Map<string, PayrollMissionAdminOffer>(
    (campaign?.offers ?? []).map((offer) => [offer.employee_code, offer]),
  );
  return { admin, campaign, offerByCode };
}

export type MissionGifts = ReturnType<typeof useMissionGifts>;

function offerLabel(offer: PayrollMissionAdminOffer | undefined): { text: string; tone: string } | null {
  if (!offer || !offer.gift_enabled) return null;
  if (offer.review?.disqualified) return { text: "Không áp dụng", tone: "bg-red-50 text-red-700" };
  if (offer.review) return { text: "Đã chốt", tone: "bg-emerald-50 text-emerald-700" };
  if (offer.status === "accepted") return { text: "Đã nhận", tone: "bg-emerald-50 text-emerald-700" };
  if (offer.status === "declined") return { text: "Từ chối", tone: "bg-red-50 text-red-700" };
  return { text: "Chưa trả lời", tone: "bg-orange-50 text-orange-700" };
}

/** Gift toggle next to an employee's name. */
export function MissionGiftButton({ gifts, employee }: { gifts: MissionGifts; employee: PayrollEmployee }) {
  const { toast } = useToast();
  const { campaign, offerByCode, admin } = gifts;
  if (!campaign) return null;
  const offer = offerByCode.get(employee.code);
  const on = offer?.gift_enabled === true;
  const label = offerLabel(offer);
  const busy = admin.setGift.isPending && admin.setGift.variables?.employeeCode === employee.code;

  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5">
      <button
        type="button"
        disabled={admin.setGift.isPending}
        aria-pressed={on}
        aria-label={on ? `Tắt quà bất ngờ cho ${employee.name}` : `Gửi quà bất ngờ cho ${employee.name}`}
        data-mission-gift={employee.code}
        onClick={async () => {
          try {
            await admin.setGift.mutateAsync({ campaignId: campaign.id, employeeCode: employee.code, enabled: !on });
            toast({ title: on ? `Đã tắt quà cho ${employee.name}` : `Đã gửi quà cho ${employee.name}` });
          } catch (error) {
            toast({
              title: "Không đổi được quà",
              description: error instanceof Error ? error.message : "Vui lòng thử lại.",
              variant: "destructive",
            });
          }
        }}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg border transition",
          on ? "border-[#f5c542] bg-[#fff7e0] text-[#d97706] shadow-[0_0_0_3px_#fff1c2]" : "border-border bg-background text-muted-foreground/60",
        )}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gift className="h-4 w-4" />}
      </button>
      {label ? <span className={cn("whitespace-nowrap rounded-full px-1.5 text-[10px] font-semibold", label.tone)}>{label.text}</span> : null}
    </div>
  );
}

/** Campaign strip above the employee table with the "send to everyone" action. */
export function MissionGiftBar({ gifts, employees }: { gifts: MissionGifts; employees: PayrollEmployee[] }) {
  const { toast } = useToast();
  const { campaign, offerByCode, admin } = gifts;
  if (!campaign) return null;
  const codes = employees.map((employee) => employee.code);
  const enabledCount = codes.filter((code) => offerByCode.get(code)?.gift_enabled).length;
  const allOn = codes.length > 0 && enabledCount === codes.length;
  const counts = { accepted: 0, pending: 0, declined: 0 };
  for (const code of codes) {
    const offer = offerByCode.get(code);
    if (offer?.gift_enabled) counts[offer.status] += 1;
  }

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-[#f5c542]/60 bg-[#fffbeb] p-3 sm:flex-row sm:items-center sm:justify-between" data-mission-bar>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#ffd34d] to-[#f59e0b] text-white">
          <Gift className="h-4 w-4" />
        </span>
        <div className="min-w-0 text-sm">
          <p className="font-medium">
            Quà bất ngờ: {campaign.title} ({shortDate(campaign.starts_on)} – {shortDate(campaign.ends_on)})
          </p>
          <p className="text-xs text-muted-foreground">
            Đã gửi {enabledCount}/{codes.length} · nhận {counts.accepted} · chưa trả lời {counts.pending} · từ chối {counts.declined}
          </p>
        </div>
      </div>
      <Button
        variant={allOn ? "outline" : "default"}
        size="sm"
        className="shrink-0 gap-2 self-start sm:self-auto"
        disabled={admin.setGiftBulk.isPending || codes.length === 0}
        data-mission-bulk
        onClick={async () => {
          try {
            await admin.setGiftBulk.mutateAsync({ campaignId: campaign.id, employeeCodes: codes, enabled: !allOn });
            toast({ title: allOn ? "Đã tắt quà cho toàn bộ" : `Đã gửi quà cho ${codes.length} nhân viên` });
          } catch (error) {
            toast({
              title: "Không gửi được quà",
              description: error instanceof Error ? error.message : "Vui lòng thử lại.",
              variant: "destructive",
            });
          }
        }}
      >
        {admin.setGiftBulk.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="h-4 w-4" />}
        {allOn ? "Tắt quà toàn bộ" : "Gửi quà cho toàn bộ"}
      </Button>
    </div>
  );
}

/** 24h hour/minute pickers for the delivery window.
 *
 * The native `input[type=time]` control opened its picker but never committed
 * the chosen value for the Q7 operator, so the window stayed empty. Two explicit
 * selects keep both halves visible and only ever store what was actually picked:
 * a half-filled window (hour or minute alone) stays partial and cannot be
 * submitted. The combined value is always zero-padded "HH:mm" for the portal.
 */

export const KFM_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
export const KFM_MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

export type KfmTimeParts = { hour: string; minute: string };

/** "08:30" -> {08,30}; "08:" -> {08,""}; ":30" -> {"",30}; "" -> {"",""}. */
export function splitKfmTime(value: string | null | undefined): KfmTimeParts {
  if (!value) return { hour: "", minute: "" };
  const [hour = "", minute = ""] = value.split(":");
  return { hour, minute };
}

/** Keeps a half-filled window half-filled so it never reads as a valid time. */
export function joinKfmTime(hour: string, minute: string): string {
  if (!hour && !minute) return "";
  if (hour && !minute) return `${hour}:`;
  if (!hour && minute) return `:${minute}`;
  return `${hour}:${minute}`;
}

export function isCompleteKfmTime(value: string | null | undefined): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

const SELECT_CLASS = "mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base sm:text-sm";

export function KfmTimeSelect({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  const { hour, minute } = splitKfmTime(value);
  return (
    <div className="min-w-0" data-kfm-time-select="v1">
      <span className="text-xs">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <select
          data-kfm-time-part="hour"
          aria-label={`${label} · giờ (24h)`}
          className={`${SELECT_CLASS} flex-1`}
          value={hour}
          onChange={event => onChange(joinKfmTime(event.target.value, minute))}
        >
          <option value="">--</option>
          {KFM_HOURS.map(row => <option key={row} value={row}>{row}</option>)}
        </select>
        <span aria-hidden="true" className="shrink-0 text-sm text-muted-foreground">:</span>
        <select
          data-kfm-time-part="minute"
          aria-label={`${label} · phút`}
          className={`${SELECT_CLASS} flex-1`}
          value={minute}
          onChange={event => onChange(joinKfmTime(hour, event.target.value))}
        >
          <option value="">--</option>
          {KFM_MINUTES.map(row => <option key={row} value={row}>{row}</option>)}
        </select>
      </div>
    </div>
  );
}

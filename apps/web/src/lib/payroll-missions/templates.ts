// Mission template catalogue for the Bếp BN surprise-reward missions.
//
// A template only declares its shape (verification, mode, applies_to, which
// params are mandatory). The thresholds and the reward_vnd always come from the
// per-period configuration — this file has no default amount and no default
// threshold, by design.

import type {
  MissionMode,
  MissionTemplate,
  MissionTemplateCode,
  MissionTemplateConfig,
  MissionVerification,
} from "./types.ts";

export interface MissionTemplateDefinition {
  name: string;
  description: string;
  verification: MissionVerification;
  mode: MissionMode;
  /** Params the configuration must provide; missing → refuse to build. */
  requiredParams: readonly string[];
  /** Whether the generator may propose candidates for this template. */
  autoSuggest: boolean;
  /** Default only; the configuration may override. */
  defaultProrateAllowed: boolean;
}

export const MISSION_TEMPLATE_DEFINITIONS: Record<MissionTemplateCode, MissionTemplateDefinition> = {
  "T-DUNGGIO": {
    name: "Đúng giờ",
    description: "Đi làm đúng giờ theo chấm công ca hành chính, sai số trong ngưỡng cho phép.",
    verification: "auto",
    mode: "pay",
    requiredParams: ["dung_sai_phut"],
    autoSuggest: true,
    defaultProrateAllowed: false,
  },
  "T-CHAMDU": {
    name: "Chấm đủ",
    description: "Chấm công đủ giờ vào và giờ ra, không có ngày bất thường.",
    verification: "auto",
    mode: "pay",
    requiredParams: [],
    autoSuggest: true,
    defaultProrateAllowed: false,
  },
  "T-CHUYENCAN": {
    name: "Chuyên cần",
    description: "Đủ số ngày có mặt trong kỳ theo cấu hình (chỉ đối chiếu, không cộng tiền).",
    verification: "auto",
    mode: "reconcile_only",
    requiredParams: [],
    autoSuggest: false,
    defaultProrateAllowed: false,
  },
  "T-GIOPT": {
    name: "Mốc giờ part-time",
    description: "Tổng giờ part-time nằm trong mốc tối thiểu–tối đa cấu hình (chỉ đối chiếu, không cộng tiền).",
    verification: "auto",
    mode: "reconcile_only",
    requiredParams: ["gio_toi_thieu", "gio_toi_da"],
    autoSuggest: true,
    defaultProrateAllowed: false,
  },
  "T-QL": {
    name: "Quản lý xác nhận",
    description: "Quản lý tự đánh giá và xác nhận kết quả; hệ thống không tự gợi ý.",
    verification: "manager",
    mode: "pay",
    requiredParams: [],
    autoSuggest: false,
    defaultProrateAllowed: false,
  },
};

export const MISSION_TEMPLATE_CODES = Object.keys(
  MISSION_TEMPLATE_DEFINITIONS,
) as MissionTemplateCode[];

export function isMissionTemplateCode(value: unknown): value is MissionTemplateCode {
  return typeof value === "string" && value in MISSION_TEMPLATE_DEFINITIONS;
}

/**
 * Build the concrete template of a period. A missing required param (for example
 * T-GIOPT without gio_toi_da) throws instead of silently inventing a threshold.
 */
export function buildMissionTemplate(
  code: MissionTemplateCode,
  config: MissionTemplateConfig = {},
): MissionTemplate {
  const definition = MISSION_TEMPLATE_DEFINITIONS[code];
  if (!definition) throw new Error(`Mẫu nhiệm vụ không hợp lệ: ${String(code)}`);

  const params = { ...(config.params ?? {}) };
  for (const required of definition.requiredParams) {
    if (params[required] === undefined || params[required] === null || params[required] === "") {
      throw new Error(`Thiếu tham số ${required} cho ${code}`);
    }
  }

  return {
    code,
    name: definition.name,
    description: definition.description,
    verification: definition.verification,
    mode: definition.mode,
    appliesTo: config.appliesTo ?? {},
    params,
    rewardVnd: config.rewardVnd ?? null,
    acceptDeadline: config.acceptDeadline ?? null,
    prorateAllowed: config.prorateAllowed ?? definition.defaultProrateAllowed,
    enabled: config.enabled ?? true,
  };
}

export function isMissionTemplateAutoSuggest(code: MissionTemplateCode): boolean {
  return MISSION_TEMPLATE_DEFINITIONS[code]?.autoSuggest ?? false;
}

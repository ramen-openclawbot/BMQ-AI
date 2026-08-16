export type KfmNullableNumber = number | null | undefined;

export type KfmQuantitySource = {
  actual_qty?: KfmNullableNumber;
  planned_qty?: KfmNullableNumber;
  ordered_qty?: KfmNullableNumber;
};

export type KfmProductionSourceRecord = KfmQuantitySource & {
  source_id: string;
  order_identity?: string | null;
  replacement_group?: string | null;
  created_at: string;
  finished_sku_code: string;
};

export type KfmBomRow = {
  finished_sku_code: string;
  finished_output_qty: KfmNullableNumber;
  formulation_version_id: string;
  effective_from: string;
  ingredient_name: string;
  material_code?: string | null;
  material_name?: string | null;
  unit?: string | null;
  dosage_qty: KfmNullableNumber;
  wastage_percent?: KfmNullableNumber;
};

export type KfmMaterialIssueBlockerCode =
  | "ambiguous_source_identity"
  | "invalid_finished_quantity"
  | "no_eligible_bom_version"
  | "invalid_bom_output_qty"
  | "invalid_bom_dosage_qty"
  | "invalid_bom_wastage_percent"
  | "missing_material_identity"
  | "missing_material_unit";

export type KfmMaterialIssueBlocker = {
  code: KfmMaterialIssueBlockerCode;
  message: string;
  source_id?: string;
  finished_sku_code?: string;
  formulation_version_id?: string;
  ingredient_name?: string;
};

export type KfmMaterialIssueRow = {
  material_identity: string;
  material_code: string;
  display_name: string;
  unit: string;
  required_qty: number;
  source_ids: string[];
};

export type KfmMaterialIssueInput = {
  issue_date: string;
  sources: KfmProductionSourceRecord[];
  bom_rows: KfmBomRow[];
};

export type KfmResolvedProductionSources = {
  sources: KfmProductionSourceRecord[];
  blockers: KfmMaterialIssueBlocker[];
};

export type KfmMaterialIssueResult = {
  materials: KfmMaterialIssueRow[];
  blockers: KfmMaterialIssueBlocker[];
};

export function selectPositiveFinishedQuantity(source: KfmQuantitySource): number | null {
  for (const qty of [source.actual_qty, source.planned_qty, source.ordered_qty]) {
    if (isPositiveFiniteNumber(qty)) {
      return qty;
    }
  }

  return null;
}

export function resolveKfmProductionSources(sources: KfmProductionSourceRecord[]): KfmResolvedProductionSources {
  const blockers: KfmMaterialIssueBlocker[] = [];
  const retained: KfmProductionSourceRecord[] = [];
  const replacementIndexes = new Map<string, number>();

  for (const source of sources) {
    const orderIdentity = cleanText(source.order_identity);
    const replacementGroup = cleanText(source.replacement_group);

    if (!orderIdentity && !replacementGroup) {
      blockers.push({
        code: "ambiguous_source_identity",
        source_id: source.source_id,
        finished_sku_code: source.finished_sku_code,
        message: `KFM source ${source.source_id} is missing order_identity and replacement_group; cannot safely decide whether to add or replace it.`,
      });
      continue;
    }

    if (!replacementGroup) {
      retained.push(source);
      continue;
    }

    const existingIndex = replacementIndexes.get(replacementGroup);
    if (existingIndex === undefined) {
      replacementIndexes.set(replacementGroup, retained.length);
      retained.push(source);
      continue;
    }

    if (compareCreatedAt(source.created_at, retained[existingIndex].created_at) >= 0) {
      retained[existingIndex] = source;
    }
  }

  return { sources: retained, blockers };
}

export function calculateKfmMaterialIssue(input: KfmMaterialIssueInput): KfmMaterialIssueResult {
  const resolved = resolveKfmProductionSources(input.sources);
  const blockers: KfmMaterialIssueBlocker[] = [...resolved.blockers];
  const selectedBomRowsBySku = new Map<string, KfmBomRow[]>();

  for (const source of resolved.sources) {
    const finishedQty = selectPositiveFinishedQuantity(source);
    if (finishedQty === null) {
      blockers.push({
        code: "invalid_finished_quantity",
        source_id: source.source_id,
        finished_sku_code: source.finished_sku_code,
        message: `KFM source ${source.source_id} has no positive actual, planned, or ordered quantity.`,
      });
    }

    if (!selectedBomRowsBySku.has(source.finished_sku_code)) {
      const selected = selectBomRowsForSku(input.bom_rows, source.finished_sku_code, input.issue_date);
      selectedBomRowsBySku.set(source.finished_sku_code, selected);
      if (selected.length === 0) {
        blockers.push({
          code: "no_eligible_bom_version",
          source_id: source.source_id,
          finished_sku_code: source.finished_sku_code,
          message: `No BOM formulation is effective for ${source.finished_sku_code} on ${input.issue_date}.`,
        });
      }
    }
  }

  const leafBomRowsBySku = new Map<string, KfmBomRow[]>();

  for (const [sku, rows] of selectedBomRowsBySku.entries()) {
    const leafRows = omitParentRows(rows);
    leafBomRowsBySku.set(sku, leafRows);

    for (const row of leafRows) {
      blockers.push(...validateBomRow(row));
    }
  }

  if (blockers.length > 0) {
    return { materials: [], blockers };
  }

  const materialIndexes = new Map<string, number>();
  const materials: KfmMaterialIssueRow[] = [];

  for (const source of resolved.sources) {
    const finishedQty = selectPositiveFinishedQuantity(source) as number;
    const bomRows = leafBomRowsBySku.get(source.finished_sku_code) ?? [];

    for (const row of bomRows) {
      const materialIdentity = normalizeIdentity(row.material_code) || normalizeIdentity(row.material_name) as string;
      const unit = normalizeUnit(row.unit) as string;
      const key = `${materialIdentity}\u0000${unit}`;
      const requiredQty = finishedQty / (row.finished_output_qty as number) * (row.dosage_qty as number) * (1 + ((row.wastage_percent ?? 0) as number) / 100);
      const existingIndex = materialIndexes.get(key);

      if (existingIndex === undefined) {
        materialIndexes.set(key, materials.length);
        materials.push({
          material_identity: materialIdentity,
          material_code: normalizeMaterialCode(row.material_code) || cleanText(row.material_name) as string,
          display_name: displayName(row.ingredient_name, row.material_name, row.material_code),
          unit,
          required_qty: requiredQty,
          source_ids: [source.source_id],
        });
      } else {
        materials[existingIndex].required_qty += requiredQty;
        if (!materials[existingIndex].source_ids.includes(source.source_id)) {
          materials[existingIndex].source_ids.push(source.source_id);
        }
      }
    }
  }

  return { materials, blockers: [] };
}

function selectBomRowsForSku(rows: KfmBomRow[], sku: string, issueDate: string): KfmBomRow[] {
  let selectedVersion: string | null = null;
  let selectedEffectiveFrom: string | null = null;

  for (const row of rows) {
    if (row.finished_sku_code !== sku || compareDateOnly(row.effective_from, issueDate) > 0) {
      continue;
    }

    if (selectedEffectiveFrom === null || compareDateOnly(row.effective_from, selectedEffectiveFrom) > 0) {
      selectedEffectiveFrom = row.effective_from;
      selectedVersion = row.formulation_version_id;
    }
  }

  if (selectedVersion === null || selectedEffectiveFrom === null) {
    return [];
  }

  return rows.filter((row) => row.finished_sku_code === sku
    && row.formulation_version_id === selectedVersion
    && row.effective_from === selectedEffectiveFrom);
}

function validateBomRow(row: KfmBomRow): KfmMaterialIssueBlocker[] {
  const blockers: KfmMaterialIssueBlocker[] = [];
  const common = {
    finished_sku_code: row.finished_sku_code,
    formulation_version_id: row.formulation_version_id,
    ingredient_name: row.ingredient_name,
  };

  if (!isPositiveFiniteNumber(row.finished_output_qty)) {
    blockers.push({
      ...common,
      code: "invalid_bom_output_qty",
      message: `BOM row ${row.ingredient_name} for ${row.finished_sku_code} must have positive finished_output_qty.`,
    });
  }

  if (!isPositiveFiniteNumber(row.dosage_qty)) {
    blockers.push({
      ...common,
      code: "invalid_bom_dosage_qty",
      message: `BOM row ${row.ingredient_name} for ${row.finished_sku_code} must have positive dosage_qty.`,
    });
  }

  if (row.wastage_percent != null && (!Number.isFinite(row.wastage_percent) || row.wastage_percent < 0)) {
    blockers.push({
      ...common,
      code: "invalid_bom_wastage_percent",
      message: `BOM row ${row.ingredient_name} for ${row.finished_sku_code} must have a non-negative wastage_percent.`,
    });
  }

  if (!normalizeIdentity(row.material_code) && !normalizeIdentity(row.material_name)) {
    blockers.push({
      ...common,
      code: "missing_material_identity",
      message: `BOM row ${row.ingredient_name} for ${row.finished_sku_code} is missing material_code and material_name.`,
    });
  }

  if (!normalizeUnit(row.unit)) {
    blockers.push({
      ...common,
      code: "missing_material_unit",
      message: `BOM row ${row.ingredient_name} for ${row.finished_sku_code} is missing the material unit.`,
    });
  }

  return blockers;
}

function omitParentRows(rows: KfmBomRow[]): KfmBomRow[] {
  const ingredientNames = rows.map((row) => cleanText(row.ingredient_name) ?? "");
  return rows.filter((row) => {
    const ingredientName = cleanText(row.ingredient_name) ?? "";
    return !ingredientNames.some((candidate) => candidate.startsWith(`${ingredientName} >`));
  });
}

function displayName(ingredientName: string, materialName?: string | null, materialCode?: string | null): string {
  const ingredient = cleanText(ingredientName);
  if (ingredient?.includes(" > ")) {
    return ingredient.split(" > ").slice(1).join(" > ");
  }

  return ingredient || cleanText(materialName) || cleanText(materialCode) || "Unknown material";
}

function isPositiveFiniteNumber(value: KfmNullableNumber): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/\s+/g, " ") ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeIdentity(value: string | null | undefined): string | null {
  return cleanText(value)?.toUpperCase() ?? null;
}

function normalizeMaterialCode(value: string | null | undefined): string | null {
  return normalizeIdentity(value);
}

function normalizeUnit(value: string | null | undefined): string | null {
  return cleanText(value)?.toLowerCase() ?? null;
}

function compareCreatedAt(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function compareDateOnly(left: string, right: string): number {
  return Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`);
}

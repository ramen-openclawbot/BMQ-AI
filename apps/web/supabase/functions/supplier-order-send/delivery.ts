export type DeliveryContact = {
  address: string;
  contactName: string;
  contactPhone: string;
};

export type DeliveryChoice =
  | { target: "auto" }
  | { target: "q7" }
  | { target: "tan_tao" }
  | {
    target: "custom";
    address: string;
    contactName: string;
    contactPhone: string;
  };

export type DeliveryProfiles = {
  q7: DeliveryContact;
  tanTao: DeliveryContact | null;
};

export type DeliveryLine = {
  name: string;
  location: string | null;
};

export type ResolvedDelivery = DeliveryContact & {
  label: string;
  items: string[];
};

const Q7_LABEL = "Kho Q7";
const TAN_TAO_LABEL = "Kho Tân Tạo";
const CUSTOM_LABEL = "Địa chỉ giao";

function contactOrFallback(
  profile: DeliveryContact,
  fallback: DeliveryContact,
): DeliveryContact {
  return {
    address: fallback.address || profile.address,
    contactName: fallback.contactName || profile.contactName,
    contactPhone: fallback.contactPhone || profile.contactPhone,
  };
}

function cleanDeliveryText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, ", ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDeliveryChoice(raw: unknown): DeliveryChoice | null {
  if (raw === undefined || raw === null) return { target: "auto" };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  if (record.target === "auto") return { target: "auto" };
  if (record.target === "q7") return { target: "q7" };
  if (record.target === "tan_tao") return { target: "tan_tao" };
  if (record.target !== "custom") return null;

  const address = cleanDeliveryText(record.address);
  const contactName = cleanDeliveryText(record.contact_name);
  const contactPhone = cleanDeliveryText(record.contact_phone);
  if (address.length < 5 || address.length > 300) return null;
  // The supplier's driver needs someone to call: a name and a phone with 8+ digits.
  if (!contactName || contactName.length > 100) return null;
  if (contactPhone.length > 40) return null;
  if (!/^[0-9 +.()-]*$/.test(contactPhone)) return null;
  if (contactPhone.replace(/\D/g, "").length < 8) return null;

  return { target: "custom", address, contactName, contactPhone };
}

/**
 * Split the ordered lines by warehouse. The Q7 block keeps the catalog/prepare
 * delivery values so every existing single-warehouse email is unchanged; the
 * Tân Tạo block uses its own app_settings profile.
 */
export function resolveDeliveries(
  lines: DeliveryLine[],
  profiles: DeliveryProfiles,
  fallback: DeliveryContact,
): ResolvedDelivery[] {
  const q7Items: string[] = [];
  const tanTaoItems: string[] = [];
  const tanTao = profiles.tanTao && String(profiles.tanTao.address ?? "").trim()
    ? profiles.tanTao
    : null;

  for (const line of Array.isArray(lines) ? lines : []) {
    if (line.location === "tan_tao" && tanTao) {
      tanTaoItems.push(line.name);
    } else {
      q7Items.push(line.name);
    }
  }

  const deliveries: ResolvedDelivery[] = [];
  if (q7Items.length > 0) {
    deliveries.push({
      label: Q7_LABEL,
      ...contactOrFallback(profiles.q7, fallback),
      items: q7Items,
    });
  }
  if (tanTaoItems.length > 0 && tanTao) {
    deliveries.push({
      label: TAN_TAO_LABEL,
      address: tanTao.address,
      contactName: tanTao.contactName,
      contactPhone: tanTao.contactPhone,
      items: tanTaoItems,
    });
  }
  return deliveries;
}

export function resolveDeliveriesForChoice(
  lines: DeliveryLine[],
  profiles: DeliveryProfiles,
  fallback: DeliveryContact,
  choice: DeliveryChoice,
): ResolvedDelivery[] | "unavailable" {
  if (choice.target === "auto") return resolveDeliveries(lines, profiles, fallback);

  const source = Array.isArray(lines) ? lines : [];
  if (source.length === 0) return [];
  const items = source.map((line) => line.name);

  if (choice.target === "q7") {
    return [{
      label: Q7_LABEL,
      ...contactOrFallback(profiles.q7, fallback),
      items,
    }];
  }

  if (choice.target === "tan_tao") {
    const tanTao = profiles.tanTao;
    if (!tanTao || !String(tanTao.address ?? "").trim()) return "unavailable";
    return [{
      label: TAN_TAO_LABEL,
      address: tanTao.address,
      contactName: tanTao.contactName,
      contactPhone: tanTao.contactPhone,
      items,
    }];
  }

  return [{
    label: CUSTOM_LABEL,
    address: choice.address,
    contactName: choice.contactName,
    contactPhone: choice.contactPhone,
    items,
  }];
}

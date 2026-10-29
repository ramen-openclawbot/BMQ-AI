export type DeliveryContact = {
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

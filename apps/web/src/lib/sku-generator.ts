import { supabase } from "@/integrations/supabase/client";
import { isPhysicalItem } from "@/lib/inventory-utils";

interface SupplierInfo {
  id: string;
  name: string;
  short_code: string | null;
}

interface PaymentRequestItemForSKU {
  id: string;
  product_name: string;
  product_code: string | null;
  unit: string | null;
  unit_price: number;
  sku_id: string | null;
}

/**
 * Find or create SKU for a payment request item.
 * Called when a payment request is approved.
 */
export async function findOrCreateSKU(
  item: PaymentRequestItemForSKU,
  supplierId: string | null,
  supplier: SupplierInfo | null,
  category: string = "Nguyên liệu"
): Promise<string | null> {
  try {
    // If item already has an SKU linked, skip
    if (item.sku_id) {
      return item.sku_id;
    }

    // Try to find existing SKU by exact match (product_name + supplier + unit)
    const { data: existingSKU } = await supabase
      .from("product_skus")
      .select("id")
      .eq("product_name", item.product_name)
      .eq("supplier_id", supplierId || "")
      .eq("unit", item.unit || "kg")
      .maybeSingle();

    if (existingSKU) {
      // Link item to existing SKU
      await supabase
        .from("payment_request_items")
        .update({ sku_id: existingSKU.id })
        .eq("id", item.id);
      
      return existingSKU.id;
    }

    // Try to find by SKU code if item has product_code
    if (item.product_code) {
      const { data: skuByCode } = await supabase
        .from("product_skus")
        .select("id")
        .eq("sku_code", item.product_code)
        .maybeSingle();

      if (skuByCode) {
        await supabase
          .from("payment_request_items")
          .update({ sku_id: skuByCode.id })
          .eq("id", item.id);
        
        return skuByCode.id;
      }
    }

    // Generate new SKU code using database function
    const supplierShortCode = supplier?.short_code || generateSupplierShortCode(supplier?.name);
    
    const { data: skuCodeResult, error: rpcError } = await supabase.rpc("generate_sku_code", {
      p_category: category,
      p_supplier_short_code: supplierShortCode,
      p_product_name: item.product_name,
      p_unit: item.unit || "kg",
    });

    if (rpcError) {
      console.error("Error generating SKU code:", rpcError);
      // Fallback to simple generation
      const fallbackCode = `${category.substring(0, 2).toUpperCase()}-${supplierShortCode}-${Date.now()}`;
      return await createSKURecord(fallbackCode, item, supplierId, category);
    }

    const skuCode = skuCodeResult as string;
    return await createSKURecord(skuCode, item, supplierId, category);
  } catch (error) {
    console.error("Error in findOrCreateSKU:", error);
    return null;
  }
}

/**
 * Create a new SKU record and link it to the payment request item
 */
async function createSKURecord(
  skuCode: string,
  item: PaymentRequestItemForSKU,
  supplierId: string | null,
  category: string
): Promise<string | null> {
  const { data: newSKU, error: insertError } = await supabase
    .from("product_skus")
    .insert({
      sku_code: skuCode,
      product_name: item.product_name,
      unit: item.unit || "kg",
      unit_price: item.unit_price,
      supplier_id: supplierId,
      category: category,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("Error creating SKU:", insertError);
    return null;
  }

  // Link item to new SKU
  await supabase
    .from("payment_request_items")
    .update({ sku_id: newSKU.id })
    .eq("id", item.id);

  return newSKU.id;
}

/**
 * Generate a short code from supplier name if not set
 */
function generateSupplierShortCode(name: string | null | undefined): string {
  if (!name) return "GEN";
  
  // Remove Vietnamese diacritics
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
  
  // Take first letters of each word, max 6 chars
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].substring(0, 6).toUpperCase();
  }
  
  return words
    .map((w) => w[0])
    .join("")
    .substring(0, 6)
    .toUpperCase();
}

/**
 * Process all items in a payment request and create/link SKUs (OPTIMIZED)
 * Uses batch queries to minimize database calls
 */
export async function processPaymentRequestSKUs(
  paymentRequestId: string
): Promise<{ created: number; linked: number; failed: number }> {
  const result = { created: 0, linked: 0, failed: 0 };

  try {
    // 1. Get all data in ONE query (with items included)
    const { data: request, error: requestError } = await supabase
      .from("payment_requests")
      .select(`
        id, supplier_id, 
        suppliers(id, name, short_code),
        payment_request_items(id, product_name, product_code, unit, unit_price, sku_id)
      `)
      .eq("id", paymentRequestId)
      .single();

    if (requestError || !request) {
      console.error("Error fetching payment request:", requestError);
      return result;
    }

    const items = (request as any).payment_request_items || [];
    const supplier = request.suppliers as unknown as SupplierInfo | null;

    // Filter items that need SKU processing
    const itemsNeedingSKU = items.filter(
      (item: any) => !item.sku_id && isPhysicalItem(item.product_name)
    );

    if (itemsNeedingSKU.length === 0) {
      return result;
    }

    // 2. Batch check existing SKUs (one query instead of N)
    const productNames = itemsNeedingSKU.map((i: any) => i.product_name);
    const { data: existingSKUs } = await supabase
      .from("product_skus")
      .select("id, product_name, unit")
      .eq("supplier_id", request.supplier_id || "")
      .in("product_name", productNames);

    // Build lookup map for existing SKUs
    const skuMap = new Map<string, string>(
      existingSKUs?.map(s => [`${s.product_name}|${s.unit}`, s.id]) || []
    );

    // 3. Separate items into: link existing vs create new
    const toLink: { id: string; sku_id: string }[] = [];
    const toCreate: { item: PaymentRequestItemForSKU; supplier: SupplierInfo | null }[] = [];

    for (const item of itemsNeedingSKU) {
      const key = `${item.product_name}|${item.unit || 'kg'}`;
      const existingId = skuMap.get(key);
      
      if (existingId) {
        toLink.push({ id: item.id, sku_id: existingId });
        result.linked++;
      } else {
        toCreate.push({ item: item as PaymentRequestItemForSKU, supplier });
      }
    }

    // 4. Batch link existing SKUs in parallel
    if (toLink.length > 0) {
      await Promise.all(
        toLink.map(({ id, sku_id }) =>
          supabase
            .from("payment_request_items")
            .update({ sku_id })
            .eq("id", id)
        )
      );
    }

    // 5. Create new SKUs in parallel (limited concurrency to avoid overload)
    const BATCH_SIZE = 5;
    for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
      const batch = toCreate.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(({ item, supplier: s }) =>
          findOrCreateSKU(item, request.supplier_id, s)
        )
      );
      result.created += results.filter(Boolean).length;
      result.failed += results.filter(r => !r).length;
    }

    return result;
  } catch (error) {
    console.error("Error processing SKUs:", error);
    return result;
  }
}

/**
 * Update supplier short_code if not set
 */
export async function ensureSupplierShortCode(
  supplierId: string,
  supplierName: string
): Promise<string> {
  // Check if short_code already exists
  const { data: supplier } = await supabase
    .from("suppliers")
    .select("short_code")
    .eq("id", supplierId)
    .single();

  if (supplier?.short_code) {
    return supplier.short_code;
  }

  // Generate and update
  const shortCode = generateSupplierShortCode(supplierName);
  
  await supabase
    .from("suppliers")
    .update({ short_code: shortCode })
    .eq("id", supplierId);

  return shortCode;
}

-- ============================================================================
-- PRODUCTION MODULE — Full pipeline: Sales PO → Production → QA → Dispatch → Stock Report
-- Version: 0.0.31
-- Date: 2026-03-30
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE production_order_status AS ENUM ('draft','planned','in_progress','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE production_shift_type AS ENUM ('morning','afternoon','night');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE production_shift_status AS ENUM ('scheduled','in_progress','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE qa_inspection_status AS ENUM ('pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE warehouse_dispatch_status AS ENUM ('pending','picked','dispatched','delivered');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE inventory_movement_type AS ENUM (
    'goods_receipt_in',      -- NVL nhập từ nhà cung cấp
    'production_consume',    -- NVL tiêu hao cho sản xuất
    'production_output',     -- Thành phẩm nhập kho sau QA
    'dispatch_out',          -- Xuất kho giao khách
    'adjustment'             -- Điều chỉnh thủ công
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. PRODUCTION ORDERS — Lệnh sản xuất (from sales PO)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_number text UNIQUE NOT NULL,          -- SX-YYYYMMDD-NNN
  source_po_inbox_id uuid REFERENCES customer_po_inbox(id) ON DELETE SET NULL,
  customer_id     uuid,                            -- from mini_crm_customers
  status          production_order_status NOT NULL DEFAULT 'draft',
  planned_start_date date,
  planned_end_date   date,
  completed_at    timestamptz,
  ai_plan_suggestion jsonb,                        -- AI agent suggested plan
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_production_orders_status ON production_orders(status);
CREATE INDEX IF NOT EXISTS idx_production_orders_source_po ON production_orders(source_po_inbox_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_customer ON production_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_planned_start ON production_orders(planned_start_date);

-- Trigger updated_at
CREATE OR REPLACE TRIGGER set_production_orders_updated_at
  BEFORE UPDATE ON production_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. PRODUCTION ORDER ITEMS — Chi tiết lệnh sản xuất (finished goods to produce)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_order_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id  uuid NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  sku_id               uuid REFERENCES product_skus(id) ON DELETE SET NULL,
  product_name         text NOT NULL,
  ordered_qty          numeric(15,3) NOT NULL DEFAULT 0,  -- qty from customer PO
  planned_qty          numeric(15,3) NOT NULL DEFAULT 0,  -- qty planned to produce (may differ)
  actual_qty           numeric(15,3) NOT NULL DEFAULT 0,  -- qty actually produced
  unit                 text NOT NULL DEFAULT 'kg',
  delivery_date        date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_order_items_order ON production_order_items(production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_order_items_sku ON production_order_items(sku_id);

-- ---------------------------------------------------------------------------
-- 4. PRODUCTION SHIFTS — Ca sản xuất
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_shifts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_code           text NOT NULL,              -- CA-YYYYMMDD-S/C/T
  production_order_id  uuid NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  shift_date           date NOT NULL,
  shift_type           production_shift_type NOT NULL DEFAULT 'morning',
  status               production_shift_status NOT NULL DEFAULT 'scheduled',
  started_at           timestamptz,
  completed_at         timestamptz,
  assigned_to          text,                       -- staff name(s)
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_shifts_order ON production_shifts(production_order_id);
CREATE INDEX IF NOT EXISTS idx_production_shifts_date ON production_shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_production_shifts_status ON production_shifts(status);

CREATE OR REPLACE TRIGGER set_production_shifts_updated_at
  BEFORE UPDATE ON production_shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. PRODUCTION SHIFT ITEMS — Items phân bổ vào ca
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_shift_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_shift_id      uuid NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
  production_order_item_id uuid NOT NULL REFERENCES production_order_items(id) ON DELETE CASCADE,
  sku_id                   uuid REFERENCES product_skus(id) ON DELETE SET NULL,
  planned_qty              numeric(15,3) NOT NULL DEFAULT 0,
  actual_qty               numeric(15,3) NOT NULL DEFAULT 0,
  unit                     text NOT NULL DEFAULT 'kg',
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_shift_items_shift ON production_shift_items(production_shift_id);

-- ---------------------------------------------------------------------------
-- 6. QA INSPECTIONS — Kiểm tra chất lượng + duyệt nhập kho thành phẩm
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_inspections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_number     text UNIQUE NOT NULL,       -- QA-YYYYMMDD-NNN
  production_order_id   uuid REFERENCES production_orders(id) ON DELETE SET NULL,
  production_shift_id   uuid REFERENCES production_shifts(id) ON DELETE SET NULL,
  status                qa_inspection_status NOT NULL DEFAULT 'pending',
  inspected_by          text,
  inspected_at          timestamptz,
  product_photos        text[] DEFAULT '{}',
  notes                 text,
  rejection_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_inspections_order ON qa_inspections(production_order_id);
CREATE INDEX IF NOT EXISTS idx_qa_inspections_status ON qa_inspections(status);

CREATE OR REPLACE TRIGGER set_qa_inspections_updated_at
  BEFORE UPDATE ON qa_inspections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. QA INSPECTION ITEMS — Chi tiết kiểm tra từng SKU
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_inspection_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qa_inspection_id    uuid NOT NULL REFERENCES qa_inspections(id) ON DELETE CASCADE,
  sku_id              uuid REFERENCES product_skus(id) ON DELETE SET NULL,
  product_name        text NOT NULL,
  inspected_qty       numeric(15,3) NOT NULL DEFAULT 0,
  approved_qty        numeric(15,3) NOT NULL DEFAULT 0,
  rejected_qty        numeric(15,3) NOT NULL DEFAULT 0,
  unit                text NOT NULL DEFAULT 'kg',
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_inspection_items_inspection ON qa_inspection_items(qa_inspection_id);

-- ---------------------------------------------------------------------------
-- 8. WAREHOUSE DISPATCHES — Phiếu xuất kho giao khách
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouse_dispatches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_number       text UNIQUE NOT NULL,       -- XK-YYYYMMDD-NNN
  customer_id           uuid,                       -- from mini_crm_customers
  production_order_id   uuid REFERENCES production_orders(id) ON DELETE SET NULL,
  status                warehouse_dispatch_status NOT NULL DEFAULT 'pending',
  dispatch_date         date,
  delivered_date        date,
  delivery_address      text,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_warehouse_dispatches_customer ON warehouse_dispatches(customer_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_dispatches_status ON warehouse_dispatches(status);
CREATE INDEX IF NOT EXISTS idx_warehouse_dispatches_date ON warehouse_dispatches(dispatch_date);

CREATE OR REPLACE TRIGGER set_warehouse_dispatches_updated_at
  BEFORE UPDATE ON warehouse_dispatches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. WAREHOUSE DISPATCH ITEMS — Chi tiết xuất kho
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouse_dispatch_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id     uuid NOT NULL REFERENCES warehouse_dispatches(id) ON DELETE CASCADE,
  sku_id          uuid REFERENCES product_skus(id) ON DELETE SET NULL,
  product_name    text NOT NULL,
  quantity        numeric(15,3) NOT NULL DEFAULT 0,
  unit            text NOT NULL DEFAULT 'kg',
  batch_id        uuid REFERENCES inventory_batches(id) ON DELETE SET NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warehouse_dispatch_items_dispatch ON warehouse_dispatch_items(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_dispatch_items_sku ON warehouse_dispatch_items(sku_id);

-- ---------------------------------------------------------------------------
-- 10. INVENTORY MOVEMENTS — Sổ kho thống nhất (unified stock ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_movements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type     inventory_movement_type NOT NULL,
  sku_id            uuid REFERENCES product_skus(id) ON DELETE SET NULL,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  batch_id          uuid REFERENCES inventory_batches(id) ON DELETE SET NULL,
  quantity          numeric(15,3) NOT NULL,          -- positive = in, negative = out
  unit              text NOT NULL DEFAULT 'kg',
  reference_type    text,                            -- 'goods_receipt','production_order','qa_inspection','dispatch'
  reference_id      uuid,                            -- FK to the source record
  movement_date     date NOT NULL DEFAULT CURRENT_DATE,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_type ON inventory_movements(movement_type);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_sku ON inventory_movements(sku_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_date ON inventory_movements(movement_date);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_ref ON inventory_movements(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON inventory_movements(inventory_item_id);

-- ---------------------------------------------------------------------------
-- 11. ROW-LEVEL SECURITY
-- ---------------------------------------------------------------------------

-- Enable RLS on all new tables
ALTER TABLE production_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_shift_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_inspection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_dispatch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read/write all production tables (internal app, trusted staff)
DO $$ DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'production_orders','production_order_items',
      'production_shifts','production_shift_items',
      'qa_inspections','qa_inspection_items',
      'warehouse_dispatches','warehouse_dispatch_items',
      'inventory_movements'
    ])
  LOOP
    EXECUTE format(
      'CREATE POLICY "authenticated_full_access_%1$s" ON %1$I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 12. HELPER: auto-generate sequential numbers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_production_number(prefix text, ref_date date DEFAULT CURRENT_DATE)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  date_str text := to_char(ref_date, 'YYYYMMDD');
  pattern  text := prefix || '-' || date_str || '-%';
  max_seq  int;
  new_seq  int;
BEGIN
  EXECUTE format(
    'SELECT COALESCE(MAX(CAST(split_part(t.num, ''-'', 3) AS int)), 0)
     FROM (SELECT %I AS num FROM %I WHERE %I LIKE $1) t',
    CASE prefix
      WHEN 'SX' THEN 'production_number'
      WHEN 'CA' THEN 'shift_code'
      WHEN 'QA' THEN 'inspection_number'
      WHEN 'XK' THEN 'dispatch_number'
    END,
    CASE prefix
      WHEN 'SX' THEN 'production_orders'
      WHEN 'CA' THEN 'production_shifts'
      WHEN 'QA' THEN 'qa_inspections'
      WHEN 'XK' THEN 'warehouse_dispatches'
    END,
    CASE prefix
      WHEN 'SX' THEN 'production_number'
      WHEN 'CA' THEN 'shift_code'
      WHEN 'QA' THEN 'inspection_number'
      WHEN 'XK' THEN 'dispatch_number'
    END
  ) INTO max_seq USING pattern;

  new_seq := COALESCE(max_seq, 0) + 1;
  RETURN prefix || '-' || date_str || '-' || lpad(new_seq::text, 3, '0');
END;
$$;

-- ---------------------------------------------------------------------------
-- 13. MODULE PERMISSION KEY — add 'production' module
-- ---------------------------------------------------------------------------
-- Insert default permission for existing staff users (if user_module_permissions table exists)
-- This is safe to run multiple times due to ON CONFLICT
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_module_permissions' AND table_schema = 'public') THEN
    -- No auto-insert needed; permissions managed by owner via UI
    NULL;
  END IF;
END $$;

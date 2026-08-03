#!/usr/bin/env python3
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SUBMIT_SOURCE = ROOT / "supabase/functions/dealer-order-submit/index.ts"
MIGRATIONS = ROOT / "supabase/migrations"


class DealerOrderPriceSourceContractTests(unittest.TestCase):
    def test_database_constraint_accepts_submit_fallback_price_source(self) -> None:
        submit_source = SUBMIT_SOURCE.read_text(encoding="utf-8")
        self.assertIn('override === undefined ? "cost_values_selling_price" : "customer_override"', submit_source)

        migration_sql = "\n".join(
            path.read_text(encoding="utf-8")
            for path in sorted(MIGRATIONS.glob("*.sql"))
        )
        self.assertIn("drop constraint if exists dealer_order_items_price_source_check", migration_sql.lower())
        self.assertIn("'cost_values_selling_price'", migration_sql)
        self.assertIn("'customer_override'", migration_sql)


if __name__ == "__main__":
    unittest.main()

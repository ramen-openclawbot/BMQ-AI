# Cost Calculation Engine (apps/costs)

## Quick Start

### Calculate a cost for a product
```python
from apps.costs.services import CostService
from apps.products.models import Product

product = Product.objects.get(sku_code='BREAD001')
cost = CostService.calculate_and_create_cost(
    product,
    calculated_by='user@example.com'
)
print(f"Total cost: {cost.total_cost_per_unit}")
print(f"Ingredient: {cost.ingredient_cost}")
print(f"Labor: {cost.labor_cost}")
print(f"Overhead: {cost.overhead_cost}")
print(f"Margin: {cost.margin_percentage}%")
```

### Get cost analysis
```python
# Latest cost for a product
latest = CostService.get_latest_cost(product)

# Cost history
history = CostService.get_cost_history(product, limit=10)

# Trend data for charts
trend = CostService.get_cost_trend(product, months=6)

# Summary statistics
summary = CostService.get_cost_summary()
print(f"Avg margin: {summary['avg_margin_percentage']}%")
print(f"Highest cost SKU: {summary['highest_cost_sku']}")
```

### Export costs
```python
csv_data = CostService.export_costs_csv()
# Save to file or return as HTTP response
```

### Approve and activate costs
```python
# After review, approve a calculated cost
CostService.approve_cost(sku_cost)

# Then activate it (archives previous active)
CostService.activate_cost(sku_cost)
```

## File Structure

```
apps/costs/
├── models.py                    # SKUCost, CostComponent, InflationTracking
├── services.py                  # CostService - main business logic API
├── signals.py                   # Auto-recalculation triggers
├── views.py                     # Django class-based views
├── urls.py                      # URL routing
├── admin.py                     # Django admin configuration
├── apps.py                      # App config with signal setup
│
├── calculators/
│   ├── base.py                 # BaseCostCalculator abstract class
│   ├── ingredient_cost_calculator.py
│   ├── labor_cost_calculator.py
│   ├── overhead_cost_calculator.py
│   ├── sku_cost_aggregator.py   # Orchestrates all calculators
│   └── __init__.py
│
└── tests.py                     # Unit tests (implement as needed)
```

## Models

### SKUCost
Stores complete cost calculation for a product at a specific version.

**Key properties:**
- `ingredient_percentage`, `labor_percentage`, `overhead_percentage` - Cost composition
- `margin` - Selling price minus total cost
- `margin_percentage` - Margin as % of selling price

**Status workflow:**
1. `calculated` - Initial calculation
2. `approved` - Reviewed and approved for use
3. `active` - Currently in use
4. `archived` - Previous active costs

### CostComponent
Individual line items that make up a SKUCost. Each contains:
- Component type (ingredient, labor, overhead)
- Name and amount
- Percentage of total cost
- JSON details with component-specific information

### InflationTracking
Compares current SKUCost to previous version, tracking:
- Absolute changes for each cost component
- Percentage changes
- Reason for change

## Calculators

### IngredientCostCalculator
Calculates ingredient costs from Bill of Materials:
1. Gets active BOM for product
2. For each line item: effective_quantity × cost_per_unit
3. Effective quantity accounts for waste percentage

### LaborCostCalculator
Calculates labor costs from production time:
1. Gets active ProductionTime with phases
2. For each phase: (duration ÷ 60) × employees × hourly_rate
3. Gets average hourly rate by employee role
4. Divides by batch size for per-unit cost

### OverheadCostCalculator
Calculates overhead using allocation methods:
- **per_unit_produced**: Total overhead ÷ total units
- **percentage_of_prime_cost**: (Ingredient + Labor) × allocation %
- **direct_assign**: Full category amount

### SKUCostAggregator
Orchestrates all three calculators:
1. Runs ingredient, labor, overhead calculations
2. Sums to total cost
3. Creates SKUCost record
4. Creates CostComponent records
5. Creates InflationTracking record
6. Tracks version numbers

## Automatic Recalculation

Cost calculations are automatically triggered when:

1. **Ingredient costs change** - PurchaseOrderLine received
   - Updates ingredient current_cost_per_unit
   - Triggers recalc for products using that ingredient

2. **Wage rates change** - EmployeeWage created/updated
   - Triggers recalc for products using that employee role

3. **Overhead amounts change** - OverheadCost created/updated
   - Triggers recalc for all products in that month

4. **BOM is activated** - BillOfMaterials status changes
   - Triggers recalc for that product

5. **Production time changes** - ProductionTime created/updated
   - Triggers recalc for that product

## Views & URL Routes

```
GET  /costs/                     - List all costs (with filters)
GET  /costs/cost/1/              - Cost detail with breakdown
GET  /costs/product/1/history/   - Cost history for product
GET  /costs/product/1/trend/     - JSON trend data (Chart.js format)
GET  /costs/export/              - Download CSV
POST /costs/recalculate/         - Trigger recalculation
```

**Filtering on list view:**
- `?category=bread` - Filter by product category
- `?min_cost=5&max_cost=10` - Filter by cost range
- `?min_margin=20` - Filter by margin percentage

**POST to recalculate:**
```json
{
  "product_id": 1
}
```
or
```json
{
  "all": "true"
}
```

## Admin Interface

Three admin classes (all read-only):

1. **SKUCostAdmin** - Main cost record with:
   - Status badges with color coding
   - Inline cost components
   - Inline inflation tracking
   - Detailed fieldsets for organization

2. **CostComponentAdmin** - Individual cost line items
   - Filter by type and product category
   - Shows component amounts and percentages

3. **InflationTrackingAdmin** - Cost change history
   - Color-coded percentage changes
   - Links to compared versions

## API Examples

### Service API
```python
from apps.costs.services import CostService
from apps.products.models import Product

# Calculate
cost = CostService.calculate_and_create_cost(product)

# Retrieve
latest = CostService.get_latest_cost(product)
history = CostService.get_cost_history(product, limit=20)
trend = CostService.get_cost_trend(product, months=12)

# Manage status
CostService.approve_cost(cost)
CostService.activate_cost(cost)

# Export
csv = CostService.export_costs_csv()

# Analysis
summary = CostService.get_cost_summary()

# Bulk operations
result = CostService.recalculate_all_costs()
# result = {
#     'total_products': 50,
#     'success_count': 48,
#     'failed_count': 2,
#     'errors': [...]
# }
```

### Aggregator API (Lower-level)
```python
from apps.costs.calculators import SKUCostAggregator

aggregator = SKUCostAggregator()

# Single product
cost = aggregator.calculate_sku_cost(
    product,
    month=2,
    year=2024,
    calculated_by='batch_job'
)

# All products
result = aggregator.recalculate_all(month=2, year=2024)
```

## Database Queries

Get active costs:
```python
from apps.costs.models import SKUCost

active = SKUCost.objects.filter(status='active')
```

Get cost history for product:
```python
product.sku_costs.all()  # Ordered by created_at desc
```

Get components for a cost:
```python
cost.components.all()
# Filter by type: .filter(component_type='ingredient')
```

Get cost changes:
```python
cost.inflation_records.all()
```

## Performance Tips

1. **Bulk recalculation** - Use `recalculate_all()` in scheduled tasks
2. **Batch operations** - Group product updates before triggering calc
3. **Caching** - Cache `get_cost_summary()` results, refresh on post_save
4. **Selective signals** - If performance issues, conditionally enable signals

## Testing

Basic test template:
```python
from django.test import TestCase
from apps.costs.services import CostService
from apps.products.models import Product

class CostCalculationTest(TestCase):
    def test_basic_cost_calculation(self):
        product = Product.objects.get(sku_code='TEST001')
        cost = CostService.calculate_and_create_cost(product)
        
        self.assertIsNotNone(cost)
        self.assertEqual(cost.status, 'calculated')
        self.assertGreater(cost.total_cost_per_unit, 0)
        self.assertEqual(
            cost.total_cost_per_unit,
            cost.ingredient_cost + cost.labor_cost + cost.overhead_cost
        )
```

## Troubleshooting

**Cost not updating after ingredient change?**
- Check signal is registered in `apps.py` ready()
- Verify ingredient's current_cost_per_unit is being updated

**Why are overhead costs zero?**
- Check OverheadCategory is marked is_active=True
- Verify OverheadCost record exists for that month/year
- Check MonthlyProductionVolume is set if using per_unit_produced method

**Can I manually edit costs in admin?**
- No, by design (immutable history)
- Create new cost via CostService instead

**How to delete a cost?**
- Costs cannot be deleted (audit trail protection)
- Archive via status change instead


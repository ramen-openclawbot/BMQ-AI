# Cost Calculation Engine - BMQ AI SKU Bakery Webapp

## Overview
The Cost Calculation Engine is the core app (`apps/costs`) that orchestrates all SKU cost calculations for the bakery webapp. It integrates ingredient costs, labor costs, and overhead costs to produce comprehensive cost analysis and profitability metrics.

## Architecture

### Models (`apps/costs/models.py`)

#### 1. SKUCost
- **Purpose**: Represents a complete cost calculation snapshot for a product SKU at a specific version
- **Key Fields**:
  - `product`: FK to Product
  - `version`: Sequential version number for tracking cost changes
  - `status`: calculated, approved, active, or archived
  - `ingredient_cost`, `labor_cost`, `overhead_cost`: Decimal cost components
  - `total_cost_per_unit`: Sum of all costs
  - `calculation_details`: JSON blob with detailed breakdown
  - `calculated_by`: User/system identifier
  - `margin`, `margin_percentage`: Computed properties for profitability analysis

#### 2. CostComponent
- **Purpose**: Detailed breakdown of individual cost line items
- **Relationships**: Many-to-One with SKUCost
- **Types**: ingredient, labor, overhead
- **Stores**: Name, amount, percentage of total, and component-specific details as JSON

#### 3. InflationTracking
- **Purpose**: Historical cost change tracking for analysis
- **Relationships**: Links current SKUCost to previous version
- **Metrics**: Stores absolute and percentage changes for each cost component

### Calculators (`apps/costs/calculators/`)

#### BaseCostCalculator (Abstract)
- Defines interface for all calculators
- Single abstract method: `calculate(product, **kwargs)`

#### IngredientCostCalculator
- **Source**: Active BOM for product
- **Logic**:
  1. Retrieves active Bill of Materials
  2. For each ingredient line item:
     - Gets current cost per unit
     - Calculates effective quantity (accounting for waste %)
     - Multiplies quantity × cost = line cost
  3. Returns total and component list

#### LaborCostCalculator
- **Source**: ProductionTime and ProductionPhase records
- **Logic**:
  1. Gets active ProductionTime for product
  2. For each ProductionPhase:
     - Gets average hourly rate for employee role
     - Calculates: (duration_minutes / 60) × employees_required × hourly_rate
     - Divides by batch_size for per-unit cost
  3. Returns total labor cost per unit and components

#### OverheadCostCalculator
- **Source**: OverheadCategory and OverheadCost records
- **Allocation Methods**:
  - `per_unit_produced`: Total overhead ÷ total units produced
  - `percentage_of_prime_cost`: (Ingredient + Labor cost) × allocation_percentage
  - `direct_assign`: Full category cost for specific products
- **Returns**: Overhead cost per unit and component breakdown

#### SKUCostAggregator
- **Orchestrator**: Coordinates all three calculators
- **Key Method**: `calculate_sku_cost(product, month, year, calculated_by, notes)`
  1. Runs all three calculators
  2. Sums costs: total = ingredient + labor + overhead
  3. Determines version number
  4. Creates SKUCost record
  5. Creates CostComponent records for each component
  6. Creates InflationTracking record comparing to previous version
- **Bulk Operation**: `recalculate_all()` for all active products

### Services (`apps/costs/services.py`)

CostService provides high-level business logic:

- **get_latest_cost(product)**: Most recent SKUCost
- **get_cost_history(product, limit)**: Previous versions
- **get_cost_trend(product, months)**: Cost data over time for charting
- **approve_cost()**: Transition to approved status
- **activate_cost()**: Set as active, archive previous
- **get_all_active_costs()**: Current costs for all products
- **export_costs_csv()**: Download costs as CSV
- **get_cost_summary()**: Summary statistics and extremes
- **calculate_and_create_cost()**: Wrapper around SKUCostAggregator
- **recalculate_product_cost()**: Update single product
- **recalculate_all_costs()**: Bulk recalculation

### Signals (`apps/costs/signals.py`)

Automatic cost recalculation triggers:

1. **PurchaseOrderLine.post_save** → Ingredient cost update
   - When ingredient costs change (via received PO lines)
   - Recalculates all products using that ingredient

2. **EmployeeWage.post_save** → Labor cost update
   - When wage rates change
   - Recalculates all products using that employee role

3. **OverheadCost.post_save** → Overhead cost update
   - When monthly overhead amounts change
   - Recalculates all active products for that month

4. **BillOfMaterials.post_save** → BOM activation
   - When BOM status changes to 'active'
   - Recalculates that product's cost

5. **ProductionTime.post_save** → Production time update
   - When production time/phases change
   - Recalculates that product's cost

### Views (`apps/costs/views.py`)

#### CostListView
- Lists all active or latest calculated costs
- Filtering: by product category, cost range, margin
- Pagination: 25 items per page
- Context: Cost summary statistics

#### CostDetailView
- Single SKUCost with full breakdown
- Shows: Cost history, trend data, components by type, inflation records

#### CostHistoryView
- All cost versions for a product
- Includes trend visualization data

#### CostTrendAPIView
- JSON endpoint returning Chart.js formatted data
- Cost trends over N months
- Datasets: Ingredient, Labor, Overhead, Total, Margin

#### ExportCSVView
- Downloads active costs as CSV
- Optional product filtering
- Includes: All cost components, margins, selling prices

#### RecalculateView
- POST endpoint for manual recalculation
- Supports: Single product or all products
- Returns: JSON success/error response

### Admin (`apps/costs/admin.py`)

- **SKUCostAdmin**: Full read-only display with status badges
  - Inlines: CostComponent and InflationTracking
  - Fieldsets: Costs, Percentages, Margin Analysis
  - Prevents direct creation/deletion
  
- **CostComponentAdmin**: Component breakdown view
  - Filters by type and product category
  - Read-only (auto-created by aggregator)

- **InflationTrackingAdmin**: Cost change tracking
  - Color-coded percentage changes
  - Detailed comparison fields
  - Read-only (auto-created by aggregator)

### URL Routes (`apps/costs/urls.py`)

```
/costs/                              - Cost list with filters
/costs/cost/<id>/                   - Cost detail view
/costs/product/<id>/history/        - Cost history for product
/costs/product/<id>/trend/          - JSON trend data
/costs/export/                      - CSV export
/costs/recalculate/                 - POST to trigger recalculation
```

## Data Flow

### Cost Calculation Flow
```
Product (with active BOM, ProductionTime, selling_price)
    ↓
SKUCostAggregator.calculate_sku_cost()
    ├→ IngredientCostCalculator.calculate()
    │   └→ Returns: total_ingredient_cost, ingredient_components
    ├→ LaborCostCalculator.calculate()
    │   └→ Returns: total_labor_cost_per_unit, labor_components
    ├→ OverheadCostCalculator.calculate()
    │   └→ Returns: total_overhead_per_unit, overhead_components
    ↓
Aggregate totals: total_cost = ingredient + labor + overhead
    ↓
Create SKUCost record
    ├→ Create CostComponent records (one per component)
    └→ Create InflationTracking record (if previous version exists)
```

### Automatic Recalculation Triggers
```
Input Changes (Ingredients, Wages, Overhead, BOM, ProductionTime)
    ↓
Django Signal (post_save)
    ↓
CostService.calculate_and_create_cost()
    ↓
New SKUCost version created
```

## Key Design Decisions

1. **Immutable History**: Cost records are never modified, only new versions created
2. **Component Tracking**: Each cost component stored separately for detailed auditing
3. **Automatic Triggers**: Signals ensure costs stay up-to-date when inputs change
4. **Status Workflow**: Calculated → Approved → Active → Archived
5. **Flexible Overhead**: Multiple allocation methods for different cost types
6. **JSON Details**: calculation_details and component.details store full audit trail

## Usage Examples

### Calculate cost for a product
```python
from apps.costs.services import CostService

cost = CostService.calculate_and_create_cost(
    product,
    calculated_by='user@example.com',
    notes='Monthly recalculation'
)
```

### Get current cost and analysis
```python
from apps.costs.services import CostService

latest_cost = CostService.get_latest_cost(product)
print(f"Cost: {latest_cost.total_cost_per_unit}")
print(f"Margin: {latest_cost.margin_percentage}%")

summary = CostService.get_cost_summary()
print(f"Average margin: {summary['avg_margin_percentage']}%")
```

### Approve and activate a cost
```python
CostService.approve_cost(sku_cost)
CostService.activate_cost(sku_cost)
```

### Export costs
```python
csv_data = CostService.export_costs_csv()
# Save to file or return as HTTP response
```

## Integration Points

The Cost Engine integrates with:

- **apps.products**: Product, BillOfMaterials, BOMLineItem
- **apps.inventory**: Ingredient costs via PurchaseOrderLine
- **apps.labor**: EmployeeWage and ProductionTime data
- **apps.overhead**: OverheadCategory and OverheadCost records

All integrations are read-only, pulling data needed for calculations.

## Performance Considerations

- **Bulk Recalculation**: Use `CostService.recalculate_all_costs()` in batch jobs
- **Lazy Loading**: Services use `.first()` to get latest rather than loading all
- **Transactions**: All cost creation wrapped in `@transaction.atomic`
- **JSON Details**: Stores calculation details for audit without additional DB queries

## Future Enhancements

- Time-based cost forecasting
- Cost variance analysis vs. targets
- Product profitability rankings
- Sensitivity analysis for cost changes
- Direct product-overhead assignment tracking

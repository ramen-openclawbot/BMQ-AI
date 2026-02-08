from decimal import Decimal
from datetime import date
from django.db import transaction, models
from apps.products.models import Product
from apps.costs.models import SKUCost, CostComponent, InflationTracking
from .ingredient_cost_calculator import IngredientCostCalculator
from .labor_cost_calculator import LaborCostCalculator
from .overhead_cost_calculator import OverheadCostCalculator


class SKUCostAggregator:
    """Aggregator that orchestrates all cost calculators and creates SKUCost records."""

    def __init__(self):
        """Initialize all calculator instances."""
        self.ingredient_calculator = IngredientCostCalculator()
        self.labor_calculator = LaborCostCalculator()
        self.overhead_calculator = OverheadCostCalculator()

    @transaction.atomic
    def calculate_sku_cost(self, product, month=None, year=None, calculated_by='system', notes=''):
        """
        Calculate and create a complete SKUCost record with all components.

        Args:
            product: Product instance to calculate cost for
            month: Month (1-12), defaults to current month
            year: Year, defaults to current year
            calculated_by: Username or identifier of who triggered the calculation
            notes: Optional notes about the calculation

        Returns:
            SKUCost: The newly created SKUCost instance
        """
        # Use current month/year if not provided
        if month is None or year is None:
            today = date.today()
            month = month or today.month
            year = year or today.year

        # Step 1: Calculate ingredient cost
        ingredient_cost, ingredient_components = self.ingredient_calculator.calculate(product)

        # Step 2: Calculate labor cost
        labor_cost, labor_components = self.labor_calculator.calculate(product)

        # Step 3: Calculate overhead cost
        overhead_cost, overhead_components = self.overhead_calculator.calculate(
            product,
            month=month,
            year=year,
            ingredient_cost=ingredient_cost,
            labor_cost=labor_cost
        )

        # Step 4: Calculate total cost
        total_cost_per_unit = ingredient_cost + labor_cost + overhead_cost

        # Step 5: Get previous SKUCost version for comparison
        previous_sku_cost = product.sku_costs.first()

        # Step 6: Determine new version number
        latest_version = product.sku_costs.aggregate(
            max_version=models.Max('version')
        )['max_version'] or 0
        new_version = latest_version + 1

        # Step 7: Create SKUCost record with calculation details
        calculation_details = {
            'month': month,
            'year': year,
            'ingredient_components': ingredient_components,
            'labor_components': labor_components,
            'overhead_components': overhead_components,
        }

        sku_cost = SKUCost.objects.create(
            product=product,
            version=new_version,
            status='calculated',
            ingredient_cost=ingredient_cost,
            labor_cost=labor_cost,
            overhead_cost=overhead_cost,
            total_cost_per_unit=total_cost_per_unit,
            calculation_details=calculation_details,
            calculated_by=calculated_by,
            notes=notes,
        )

        # Step 8: Create CostComponent records for each component
        all_components = [
            ('ingredient', ingredient_components),
            ('labor', labor_components),
            ('overhead', overhead_components),
        ]

        for component_type, components in all_components:
            for component_data in components:
                # Extract amount based on component type
                if component_type == 'ingredient':
                    amount = Decimal(str(component_data.get('line_cost', 0)))
                    name = component_data.get('name', '')
                elif component_type == 'labor':
                    amount = Decimal(str(component_data.get('cost_per_unit', 0)))
                    name = f"{component_data.get('phase_display', '')} ({component_data.get('role_display', '')})"
                else:  # overhead
                    amount = Decimal(str(component_data.get('allocation_amount', 0)))
                    name = component_data.get('name', '')

                # Calculate percentage of total
                percentage_of_total = Decimal('0')
                if total_cost_per_unit > 0:
                    percentage_of_total = (amount / total_cost_per_unit) * 100

                CostComponent.objects.create(
                    sku_cost=sku_cost,
                    component_type=component_type,
                    name=name,
                    amount=amount,
                    percentage_of_total=percentage_of_total,
                    details=component_data,
                )

        # Step 9: Create InflationTracking record if previous version exists
        if previous_sku_cost:
            self._create_inflation_tracking(sku_cost, previous_sku_cost)

        return sku_cost

    @staticmethod
    def _create_inflation_tracking(sku_cost, previous_sku_cost):
        """
        Create an InflationTracking record comparing current and previous SKUCost.

        Args:
            sku_cost: Current SKUCost instance
            previous_sku_cost: Previous SKUCost instance for comparison
        """
        # Calculate cost changes
        ingredient_change = sku_cost.ingredient_cost - previous_sku_cost.ingredient_cost
        ingredient_change_pct = Decimal('0')
        if previous_sku_cost.ingredient_cost > 0:
            ingredient_change_pct = (ingredient_change / previous_sku_cost.ingredient_cost) * 100

        labor_change = sku_cost.labor_cost - previous_sku_cost.labor_cost
        labor_change_pct = Decimal('0')
        if previous_sku_cost.labor_cost > 0:
            labor_change_pct = (labor_change / previous_sku_cost.labor_cost) * 100

        overhead_change = sku_cost.overhead_cost - previous_sku_cost.overhead_cost
        overhead_change_pct = Decimal('0')
        if previous_sku_cost.overhead_cost > 0:
            overhead_change_pct = (overhead_change / previous_sku_cost.overhead_cost) * 100

        total_change = sku_cost.total_cost_per_unit - previous_sku_cost.total_cost_per_unit
        total_change_pct = Decimal('0')
        if previous_sku_cost.total_cost_per_unit > 0:
            total_change_pct = (total_change / previous_sku_cost.total_cost_per_unit) * 100

        # Create inflation tracking record
        InflationTracking.objects.create(
            sku_cost=sku_cost,
            previous_sku_cost=previous_sku_cost,
            ingredient_cost_change=ingredient_change,
            ingredient_cost_change_pct=ingredient_change_pct,
            labor_cost_change=labor_change,
            labor_cost_change_pct=labor_change_pct,
            overhead_cost_change=overhead_change,
            overhead_cost_change_pct=overhead_change_pct,
            total_cost_change=total_change,
            total_cost_change_pct=total_change_pct,
        )

    def recalculate_all(self, month=None, year=None, calculated_by='system'):
        """
        Recalculate SKU costs for all active products.

        Args:
            month: Month (1-12), defaults to current month
            year: Year, defaults to current year
            calculated_by: Username or identifier of who triggered the calculation

        Returns:
            dict: Summary of recalculation {total_products, success_count, errors}
        """
        # Get all active products
        active_products = Product.objects.filter(is_active=True)

        total_products = active_products.count()
        success_count = 0
        errors = []

        for product in active_products:
            try:
                self.calculate_sku_cost(
                    product,
                    month=month,
                    year=year,
                    calculated_by=calculated_by,
                    notes=f'Bulk recalculation'
                )
                success_count += 1
            except Exception as e:
                errors.append({
                    'product': str(product),
                    'error': str(e)
                })

        return {
            'total_products': total_products,
            'success_count': success_count,
            'failed_count': total_products - success_count,
            'errors': errors,
        }

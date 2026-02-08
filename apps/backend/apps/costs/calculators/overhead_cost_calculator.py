from decimal import Decimal
from datetime import date
from apps.overhead.services import OverheadService
from apps.overhead.models import OverheadCategory, OverheadCost, MonthlyProductionVolume
from .base import BaseCostCalculator


class OverheadCostCalculator(BaseCostCalculator):
    """Calculator for overhead costs using various allocation methods."""

    def calculate(self, product, month=None, year=None, ingredient_cost=Decimal('0'), labor_cost=Decimal('0'), **kwargs):
        """
        Calculate overhead cost per unit for a product using allocation methods.

        Args:
            product: Product instance
            month: Month (1-12), defaults to current month
            year: Year, defaults to current year
            ingredient_cost: Ingredient cost per unit (for percentage_of_prime_cost calculation)
            labor_cost: Labor cost per unit (for percentage_of_prime_cost calculation)
            **kwargs: Unused, for interface compatibility

        Returns:
            tuple: (total_overhead_per_unit, components_list)
                  components_list contains dicts with: name, method, amount,
                  category_total, allocation_details
        """
        # Use current month/year if not provided
        if month is None or year is None:
            today = date.today()
            month = month or today.month
            year = year or today.year

        total_overhead_per_unit = Decimal('0')
        components_list = []

        # Process each active overhead category
        for category in OverheadCategory.objects.filter(is_active=True):
            try:
                cost_record = OverheadCost.objects.get(category=category, month=month, year=year)
                category_cost = cost_record.amount
            except OverheadCost.DoesNotExist:
                category_cost = Decimal('0')

            allocation_amount = Decimal('0')
            allocation_details = {
                'method': category.get_allocation_method_display(),
            }

            # Calculate allocation based on method
            if category.allocation_method == 'per_unit_produced':
                try:
                    volume = MonthlyProductionVolume.objects.get(month=month, year=year)
                    total_units = volume.total_units_produced
                except MonthlyProductionVolume.DoesNotExist:
                    total_units = Decimal('0')

                if total_units > 0:
                    allocation_amount = category_cost / total_units
                    allocation_details['total_units'] = float(total_units)
                    allocation_details['category_cost'] = float(category_cost)

            elif category.allocation_method == 'percentage_of_prime_cost':
                prime_cost = ingredient_cost + labor_cost
                if prime_cost > 0:
                    allocation_percentage = category.allocation_percentage or Decimal('0')
                    allocation_amount = (prime_cost * allocation_percentage) / Decimal('100')
                    allocation_details['prime_cost'] = float(prime_cost)
                    allocation_details['allocation_percentage'] = float(allocation_percentage)
                    allocation_details['category_cost'] = float(category_cost)

            elif category.allocation_method == 'direct_assign':
                # For direct assignment, use the full category cost
                # In practice, this would need product-specific allocation tracking
                allocation_amount = category_cost
                allocation_details['category_cost'] = float(category_cost)
                allocation_details['note'] = 'Direct assignment (requires product-specific allocation)'

            total_overhead_per_unit += allocation_amount

            # Create component details
            component = {
                'name': category.name,
                'category_id': category.id,
                'allocation_method': category.allocation_method,
                'allocation_method_display': category.get_allocation_method_display(),
                'category_cost': float(category_cost),
                'allocation_amount': float(allocation_amount),
                'allocation_percentage': float(category.allocation_percentage or 0),
                'allocation_details': allocation_details,
            }
            components_list.append(component)

        return (total_overhead_per_unit, components_list)

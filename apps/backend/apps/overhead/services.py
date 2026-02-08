from decimal import Decimal
from django.db.models import Sum

from .models import OverheadCategory, OverheadCost, MonthlyProductionVolume


class OverheadService:
    """Service class for overhead cost calculations and related operations."""

    @staticmethod
    def get_monthly_overhead_total(month: int, year: int) -> Decimal:
        """
        Calculate total overhead costs for a given month and year.

        Args:
            month: Month (1-12)
            year: Year

        Returns:
            Decimal total overhead cost for the month
        """
        total = OverheadCost.objects.filter(
            month=month,
            year=year
        ).aggregate(total=Sum('amount'))['total']

        return total if total is not None else Decimal('0')

    @staticmethod
    def calculate_overhead_per_unit(product, month: int, year: int) -> Decimal:
        """
        Calculate overhead cost per unit for a product.

        Calculation depends on allocation method:
        - per_unit_produced: total_overhead / total_units_produced
        - percentage_of_prime_cost: (ingredient_cost + labor_cost) * allocation_percentage / 100
        - direct_assign: amount / units_of_that_product

        Args:
            product: Product instance
            month: Month (1-12)
            year: Year

        Returns:
            Decimal overhead cost per unit
        """
        total_overhead = OverheadService.get_monthly_overhead_total(month, year)

        if total_overhead == 0:
            return Decimal('0')

        # Get production volume for the month
        try:
            volume = MonthlyProductionVolume.objects.get(month=month, year=year)
            total_units = volume.total_units_produced
        except MonthlyProductionVolume.DoesNotExist:
            total_units = Decimal('0')

        # Calculate based on allocation method
        overhead_per_unit = Decimal('0')

        for category in OverheadCategory.objects.filter(is_active=True):
            try:
                cost = OverheadCost.objects.get(category=category, month=month, year=year)
            except OverheadCost.DoesNotExist:
                continue

            if category.allocation_method == 'per_unit_produced':
                if total_units > 0:
                    overhead_per_unit += cost.amount / total_units
            elif category.allocation_method == 'percentage_of_prime_cost':
                # Import here to avoid circular imports
                from apps.labor.services import LaborService

                ingredient_cost = product.latest_cost
                labor_cost = LaborService.calculate_labor_cost_per_unit(product)
                prime_cost = ingredient_cost + labor_cost

                if prime_cost > 0:
                    overhead_per_unit += (prime_cost * category.allocation_percentage / 100)
            elif category.allocation_method == 'direct_assign':
                # For direct assign, would need additional tracking
                # This is a placeholder - in practice would need a ProductCategoryAllocation model
                pass

        return overhead_per_unit

    @staticmethod
    def get_overhead_breakdown(month: int, year: int) -> list:
        """
        Get overhead breakdown by category for a month.

        Args:
            month: Month (1-12)
            year: Year

        Returns:
            List of dicts with category info, amount, and percentage
        """
        total_overhead = OverheadService.get_monthly_overhead_total(month, year)
        breakdown = []

        for category in OverheadCategory.objects.filter(is_active=True):
            try:
                cost = OverheadCost.objects.get(category=category, month=month, year=year)
                amount = cost.amount
            except OverheadCost.DoesNotExist:
                amount = Decimal('0')

            percentage = Decimal('0')
            if total_overhead > 0:
                percentage = (amount / total_overhead) * 100

            breakdown.append({
                'category': category.name,
                'amount': amount,
                'percentage': percentage,
                'allocation_method': category.get_allocation_method_display(),
            })

        return breakdown

    @staticmethod
    def record_monthly_cost(category_id: int, amount: Decimal, month: int, year: int, notes: str = '') -> OverheadCost:
        """
        Create or update an overhead cost for a category in a specific month.

        Args:
            category_id: OverheadCategory ID
            amount: Cost amount
            month: Month (1-12)
            year: Year
            notes: Optional notes

        Returns:
            OverheadCost instance (created or updated)
        """
        category = OverheadCategory.objects.get(id=category_id)

        overhead_cost, created = OverheadCost.objects.update_or_create(
            category=category,
            month=month,
            year=year,
            defaults={
                'amount': amount,
                'notes': notes,
            }
        )

        return overhead_cost

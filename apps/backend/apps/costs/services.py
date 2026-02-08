from decimal import Decimal
from datetime import date, timedelta
from django.db.models import Q, Avg, Sum
import csv
from io import StringIO

from apps.products.models import Product
from .models import SKUCost, CostComponent, InflationTracking
from .calculators import SKUCostAggregator


class CostService:
    """Service class for cost management and reporting."""

    @staticmethod
    def get_latest_cost(product: Product):
        """
        Get the most recent SKUCost for a product.

        Args:
            product: Product instance

        Returns:
            SKUCost instance or None
        """
        return product.sku_costs.first()

    @staticmethod
    def get_cost_history(product: Product, limit=10):
        """
        Get historical SKUCost versions for a product.

        Args:
            product: Product instance
            limit: Maximum number of versions to return

        Returns:
            QuerySet of SKUCost instances ordered by version descending
        """
        return product.sku_costs.all()[:limit]

    @staticmethod
    def get_cost_trend(product: Product, months=6):
        """
        Get cost data over the last N months for charting/analysis.

        Args:
            product: Product instance
            months: Number of months to look back

        Returns:
            list: List of dicts with cost data {date, ingredient, labor, overhead, total, margin}
        """
        # Calculate date cutoff
        cutoff_date = date.today() - timedelta(days=30 * months)

        # Get SKUCosts created after cutoff date
        sku_costs = product.sku_costs.filter(
            created_at__date__gte=cutoff_date
        ).order_by('created_at')

        trend_data = []
        for sku_cost in sku_costs:
            trend_data.append({
                'date': sku_cost.effective_date.isoformat(),
                'created_at': sku_cost.created_at.isoformat(),
                'version': sku_cost.version,
                'ingredient': float(sku_cost.ingredient_cost),
                'labor': float(sku_cost.labor_cost),
                'overhead': float(sku_cost.overhead_cost),
                'total': float(sku_cost.total_cost_per_unit),
                'margin': float(sku_cost.margin),
                'margin_percentage': float(sku_cost.margin_percentage),
            })

        return trend_data

    @staticmethod
    def approve_cost(sku_cost: SKUCost) -> SKUCost:
        """
        Change SKUCost status to 'approved'.

        Args:
            sku_cost: SKUCost instance to approve

        Returns:
            Updated SKUCost instance
        """
        sku_cost.status = 'approved'
        sku_cost.save()
        return sku_cost

    @staticmethod
    def activate_cost(sku_cost: SKUCost) -> SKUCost:
        """
        Activate a SKUCost and archive any previous active cost for the same product.

        Args:
            sku_cost: SKUCost instance to activate

        Returns:
            Updated SKUCost instance
        """
        # Archive previous active costs for this product
        previous_active = SKUCost.objects.filter(
            product=sku_cost.product,
            status='active'
        ).exclude(pk=sku_cost.pk)

        previous_active.update(status='archived', end_date=date.today())

        # Activate the provided cost
        sku_cost.status = 'active'
        sku_cost.save()

        return sku_cost

    @staticmethod
    def get_all_active_costs():
        """
        Get all currently active SKU costs (status='active' or latest 'calculated').

        For products with no 'active' cost, returns the latest 'calculated' cost.

        Returns:
            QuerySet of active SKUCost instances
        """
        # Get all products with active costs
        active_costs = SKUCost.objects.filter(status='active')

        # Get products that don't have active costs
        products_with_active = set(active_costs.values_list('product_id', flat=True))
        products_without_active = Product.objects.filter(
            is_active=True
        ).exclude(id__in=products_with_active)

        # For products without active costs, get the latest calculated
        latest_calculated = []
        for product in products_without_active:
            latest = product.sku_costs.filter(status='calculated').first()
            if latest:
                latest_calculated.append(latest.pk)

        # Combine active costs with latest calculated
        all_cost_ids = list(active_costs.values_list('id', flat=True)) + latest_calculated

        return SKUCost.objects.filter(id__in=all_cost_ids).order_by('product__sku_code')

    @staticmethod
    def export_costs_csv(products=None):
        """
        Export current SKU costs to CSV format.

        Args:
            products: Optional queryset/list of products to export. If None, exports all.

        Returns:
            String: CSV content
        """
        if products is None:
            cost_records = CostService.get_all_active_costs()
        else:
            cost_records = SKUCost.objects.filter(product__in=products, status__in=['active', 'calculated'])

        # Create CSV string
        output = StringIO()
        writer = csv.writer(output)

        # Write header
        writer.writerow([
            'SKU Code',
            'Product Name',
            'Version',
            'Status',
            'Ingredient Cost',
            'Labor Cost',
            'Overhead Cost',
            'Total Cost Per Unit',
            'Selling Price',
            'Margin',
            'Margin %',
            'Effective Date',
            'Calculated By',
        ])

        # Write data rows
        for sku_cost in cost_records:
            writer.writerow([
                sku_cost.product.sku_code,
                sku_cost.product.name,
                sku_cost.version,
                sku_cost.get_status_display(),
                float(sku_cost.ingredient_cost),
                float(sku_cost.labor_cost),
                float(sku_cost.overhead_cost),
                float(sku_cost.total_cost_per_unit),
                float(sku_cost.product.selling_price),
                float(sku_cost.margin),
                float(sku_cost.margin_percentage),
                sku_cost.effective_date.isoformat(),
                sku_cost.calculated_by,
            ])

        return output.getvalue()

    @staticmethod
    def get_cost_summary():
        """
        Get summary statistics of all active SKU costs.

        Returns:
            dict: Summary stats {avg_margin, avg_margin_pct, total_products, highest_cost_sku, lowest_margin_sku}
        """
        active_costs = CostService.get_all_active_costs()

        if not active_costs.exists():
            return {
                'avg_margin': 0,
                'avg_margin_percentage': 0,
                'total_products': 0,
                'highest_cost_sku': None,
                'lowest_margin_sku': None,
                'avg_ingredient_percentage': 0,
                'avg_labor_percentage': 0,
                'avg_overhead_percentage': 0,
            }

        # Calculate averages
        total_costs = active_costs.count()
        avg_margin = active_costs.aggregate(avg=Avg('margin'))['avg'] or 0
        avg_margin_pct = Decimal('0')
        avg_ingredient_pct = Decimal('0')
        avg_labor_pct = Decimal('0')
        avg_overhead_pct = Decimal('0')

        for cost in active_costs:
            avg_margin_pct += cost.margin_percentage
            avg_ingredient_pct += cost.ingredient_percentage
            avg_labor_pct += cost.labor_percentage
            avg_overhead_pct += cost.overhead_percentage

        avg_margin_pct = avg_margin_pct / total_costs if total_costs > 0 else Decimal('0')
        avg_ingredient_pct = avg_ingredient_pct / total_costs if total_costs > 0 else Decimal('0')
        avg_labor_pct = avg_labor_pct / total_costs if total_costs > 0 else Decimal('0')
        avg_overhead_pct = avg_overhead_pct / total_costs if total_costs > 0 else Decimal('0')

        # Find extremes
        highest_cost = active_costs.order_by('-total_cost_per_unit').first()
        lowest_margin = active_costs.order_by('margin').first()

        return {
            'avg_margin': float(avg_margin),
            'avg_margin_percentage': float(avg_margin_pct),
            'total_products': total_costs,
            'highest_cost_sku': {
                'product': highest_cost.product.sku_code,
                'cost': float(highest_cost.total_cost_per_unit),
            } if highest_cost else None,
            'lowest_margin_sku': {
                'product': lowest_margin.product.sku_code,
                'margin': float(lowest_margin.margin),
                'margin_pct': float(lowest_margin.margin_percentage),
            } if lowest_margin else None,
            'avg_ingredient_percentage': float(avg_ingredient_pct),
            'avg_labor_percentage': float(avg_labor_pct),
            'avg_overhead_percentage': float(avg_overhead_pct),
        }

    @staticmethod
    def calculate_and_create_cost(product: Product, month=None, year=None, calculated_by='system', notes='') -> SKUCost:
        """
        Calculate and create a new SKUCost for a product.

        Uses SKUCostAggregator to perform the calculation.

        Args:
            product: Product instance
            month: Month (1-12), defaults to current
            year: Year, defaults to current
            calculated_by: Username or system identifier
            notes: Optional notes about the calculation

        Returns:
            SKUCost: The newly created SKUCost instance
        """
        aggregator = SKUCostAggregator()
        return aggregator.calculate_sku_cost(
            product,
            month=month,
            year=year,
            calculated_by=calculated_by,
            notes=notes
        )

    @staticmethod
    def recalculate_product_cost(product: Product, month=None, year=None, calculated_by='system') -> SKUCost:
        """
        Recalculate cost for a specific product.

        Args:
            product: Product instance
            month: Month (1-12)
            year: Year
            calculated_by: Username or system identifier

        Returns:
            SKUCost: The newly created SKUCost instance
        """
        return CostService.calculate_and_create_cost(
            product,
            month=month,
            year=year,
            calculated_by=calculated_by,
            notes='Manual recalculation'
        )

    @staticmethod
    def recalculate_all_costs(month=None, year=None, calculated_by='system'):
        """
        Recalculate costs for all active products.

        Args:
            month: Month (1-12)
            year: Year
            calculated_by: Username or system identifier

        Returns:
            dict: Summary of recalculation results
        """
        aggregator = SKUCostAggregator()
        return aggregator.recalculate_all(
            month=month,
            year=year,
            calculated_by=calculated_by
        )

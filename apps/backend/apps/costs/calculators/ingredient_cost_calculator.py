from decimal import Decimal
from apps.products.services import ProductService
from .base import BaseCostCalculator


class IngredientCostCalculator(BaseCostCalculator):
    """Calculator for ingredient costs based on Bill of Materials."""

    def calculate(self, product, **kwargs):
        """
        Calculate total ingredient cost for a product using its active BOM.

        Args:
            product: Product instance
            **kwargs: Unused, for interface compatibility

        Returns:
            tuple: (total_ingredient_cost, components_list)
                  components_list contains dicts with: name, ingredient_id, quantity, unit,
                  cost_per_unit, waste_pct, line_cost
        """
        # Get active BOM for the product
        active_bom = ProductService.get_active_bom(product)

        if not active_bom:
            return (Decimal('0'), [])

        total_ingredient_cost = Decimal('0')
        components_list = []

        # Process each BOM line item
        for line_item in active_bom.line_items.all():
            ingredient = line_item.ingredient
            cost_per_unit = ingredient.current_cost_per_unit
            effective_quantity = line_item.effective_quantity

            # Calculate line cost
            line_cost = effective_quantity * cost_per_unit
            total_ingredient_cost += line_cost

            # Create component details
            component = {
                'name': ingredient.name,
                'ingredient_id': ingredient.id,
                'quantity': float(line_item.quantity_per_unit),
                'unit': ingredient.unit,
                'cost_per_unit': float(cost_per_unit),
                'waste_pct': float(line_item.waste_percentage),
                'effective_quantity': float(effective_quantity),
                'line_cost': float(line_cost),
            }
            components_list.append(component)

        return (total_ingredient_cost, components_list)

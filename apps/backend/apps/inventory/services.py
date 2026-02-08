from datetime import date
from decimal import Decimal
from django.db import transaction
from .models import (
    Ingredient,
    IngredientPriceHistory,
    PurchaseOrder,
    PurchaseOrderLine,
)


class InventoryService:
    """Service class for managing inventory operations."""

    @staticmethod
    @transaction.atomic
    def receive_po_line(po_line: PurchaseOrderLine, received_qty: Decimal) -> PurchaseOrderLine:
        """
        Record receipt of a purchase order line.

        Args:
            po_line: The PurchaseOrderLine to receive
            received_qty: The quantity received

        Returns:
            The updated PurchaseOrderLine
        """
        po_line.received_quantity = received_qty
        po_line.save()

        # Update ingredient stock
        ingredient = po_line.ingredient
        ingredient.current_stock += received_qty
        ingredient.save()

        # Recalculate weighted average cost
        InventoryService.calculate_weighted_average_cost(ingredient)

        # Update purchase order status
        InventoryService.check_po_status(po_line.purchase_order)

        return po_line

    @staticmethod
    def calculate_weighted_average_cost(ingredient: Ingredient) -> Decimal:
        """
        Calculate weighted average cost for an ingredient from all received PO lines.

        Args:
            ingredient: The ingredient to calculate WAC for

        Returns:
            The weighted average cost as Decimal
        """
        # Get all received purchase order lines for this ingredient
        received_lines = PurchaseOrderLine.objects.filter(
            ingredient=ingredient,
            received_quantity__gt=0
        ).select_related('purchase_order')

        total_quantity = Decimal('0')
        total_cost = Decimal('0')

        for line in received_lines:
            total_quantity += line.received_quantity
            total_cost += line.received_quantity * line.unit_price

        if total_quantity > 0:
            wac = total_cost / total_quantity
            ingredient.current_cost_per_unit = wac
            ingredient.save()
            return wac

        return ingredient.current_cost_per_unit

    @staticmethod
    @transaction.atomic
    def update_ingredient_cost(
        ingredient: Ingredient,
        new_cost: Decimal,
        source: str = ''
    ) -> IngredientPriceHistory:
        """
        Update ingredient cost and create a price history record.

        Args:
            ingredient: The ingredient to update
            new_cost: The new cost per unit
            source: Optional source/reason for the price change

        Returns:
            The created IngredientPriceHistory record
        """
        previous_cost = ingredient.current_cost_per_unit

        # Calculate change percentage
        change_percentage = None
        if previous_cost > 0:
            change_percentage = ((new_cost - previous_cost) / previous_cost) * 100

        # Create price history record
        price_history = IngredientPriceHistory.objects.create(
            ingredient=ingredient,
            cost_per_unit=new_cost,
            effective_date=date.today(),
            previous_cost=previous_cost if previous_cost > 0 else None,
            change_percentage=change_percentage,
            source=source
        )

        # Update ingredient cost
        ingredient.current_cost_per_unit = new_cost
        ingredient.save()

        return price_history

    @staticmethod
    def check_po_status(purchase_order: PurchaseOrder) -> str:
        """
        Update purchase order status based on received quantities.

        Args:
            purchase_order: The purchase order to check

        Returns:
            The new status string
        """
        lines = purchase_order.lines.all()

        if not lines.exists():
            return purchase_order.status

        total_quantity = sum(line.quantity for line in lines)
        total_received = sum(line.received_quantity for line in lines)

        # Determine new status
        if total_received == 0:
            new_status = 'confirmed'
        elif total_received < total_quantity:
            new_status = 'partially_received'
        elif total_received >= total_quantity:
            new_status = 'received'
        else:
            new_status = purchase_order.status

        purchase_order.status = new_status
        purchase_order.save()

        return new_status

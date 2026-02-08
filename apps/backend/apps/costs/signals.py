from django.db.models.signals import post_save
from django.dispatch import receiver
from django.utils import timezone

from apps.inventory.models import PurchaseOrderLine
from apps.labor.models import EmployeeWage, ProductionTime, ProductionPhase
from apps.overhead.models import OverheadCost
from apps.products.models import BillOfMaterials

from .services import CostService


@receiver(post_save, sender=PurchaseOrderLine)
def trigger_ingredient_cost_recalculation(sender, instance, created, **kwargs):
    """
    Trigger ingredient cost recalculation when a purchase order line is received.

    When received_quantity changes, recalculate affected product costs.
    """
    # Get the ingredient from this PO line
    ingredient = instance.ingredient

    # Find all products that use this ingredient in their active BOM
    from apps.products.models import BOMLineItem

    affected_bom_lines = BOMLineItem.objects.filter(ingredient=ingredient)

    for bom_line in affected_bom_lines:
        # Get the product from the BOM
        product = bom_line.bom.product

        # Only recalculate if BOM is active
        if bom_line.bom.status == 'active':
            try:
                CostService.recalculate_product_cost(
                    product,
                    calculated_by='system - ingredient_update',
                    notes=f'Triggered by ingredient cost update: {ingredient.name}'
                )
            except Exception:
                # Log error but don't fail the signal
                pass


@receiver(post_save, sender=EmployeeWage)
def trigger_labor_cost_recalculation(sender, instance, created, **kwargs):
    """
    Trigger labor cost recalculation when employee wage is updated.

    When wage rates change, recalculate costs for all products using this role.
    """
    employee = instance.employee
    employee_role = employee.role

    # Find all ProductionPhases using this role
    affected_phases = ProductionPhase.objects.filter(employee_role=employee_role)

    # Get unique products from these phases
    affected_products = set()
    for phase in affected_phases:
        affected_products.add(phase.production_time.product)

    # Recalculate for each affected product
    for product in affected_products:
        try:
            CostService.recalculate_product_cost(
                product,
                calculated_by='system - wage_update',
                notes=f'Triggered by wage update for role: {employee_role}'
            )
        except Exception:
            # Log error but don't fail the signal
            pass


@receiver(post_save, sender=OverheadCost)
def trigger_overhead_cost_recalculation(sender, instance, created, **kwargs):
    """
    Trigger overhead cost recalculation when monthly overhead costs are updated.

    When overhead costs change, recalculate for all active products in that month.
    """
    month = instance.month
    year = instance.year

    # Get all active products
    from apps.products.models import Product

    active_products = Product.objects.filter(is_active=True)

    # Recalculate for each product
    for product in active_products:
        try:
            CostService.calculate_and_create_cost(
                product,
                month=month,
                year=year,
                calculated_by='system - overhead_update',
                notes=f'Triggered by overhead cost update: {instance.category.name}'
            )
        except Exception:
            # Log error but don't fail the signal
            pass


@receiver(post_save, sender=BillOfMaterials)
def trigger_bom_activation_cost_calculation(sender, instance, created, **kwargs):
    """
    Trigger cost calculation when a BOM is activated.

    When BOM status changes to 'active', recalculate the product cost.
    """
    if instance.status == 'active':
        product = instance.product

        try:
            CostService.recalculate_product_cost(
                product,
                calculated_by='system - bom_activation',
                notes=f'Triggered by BOM v{instance.version} activation'
            )
        except Exception:
            # Log error but don't fail the signal
            pass


@receiver(post_save, sender=ProductionTime)
def trigger_labor_cost_recalculation_production_time(sender, instance, created, **kwargs):
    """
    Trigger labor cost recalculation when production time is updated.

    When production time or phases change, recalculate the product cost.
    """
    product = instance.product

    try:
        CostService.recalculate_product_cost(
            product,
            calculated_by='system - production_time_update',
            notes=f'Triggered by ProductionTime v{instance.version} update'
        )
    except Exception:
        # Log error but don't fail the signal
        pass

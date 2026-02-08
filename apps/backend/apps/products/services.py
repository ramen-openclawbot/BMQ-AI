from decimal import Decimal
from django.db import transaction, models
from .models import Product, BillOfMaterials, BOMLineItem


class ProductService:
    """Service class for managing product and BOM operations."""

    @staticmethod
    @transaction.atomic
    def create_new_bom_version(product: Product) -> BillOfMaterials:
        """
        Create a new version of BOM, copying line items from current active BOM.

        Args:
            product: The product to create a new BOM for

        Returns:
            The newly created BillOfMaterials
        """
        # Get current active BOM
        current_bom = product.get_active_bom()

        # Calculate next version number
        latest_version = product.boms.aggregate(
            max_version=models.Max('version')
        )['max_version'] or 0
        next_version = latest_version + 1

        # Create new BOM
        new_bom = BillOfMaterials.objects.create(
            product=product,
            version=next_version,
            status='draft',
            notes=f'Created from v{latest_version}'
        )

        # Copy line items from current BOM if it exists
        if current_bom:
            for line_item in current_bom.line_items.all():
                BOMLineItem.objects.create(
                    bom=new_bom,
                    ingredient=line_item.ingredient,
                    quantity_per_unit=line_item.quantity_per_unit,
                    waste_percentage=line_item.waste_percentage,
                    notes=line_item.notes
                )

        return new_bom

    @staticmethod
    @transaction.atomic
    def activate_bom(bom: BillOfMaterials) -> BillOfMaterials:
        """
        Activate a BOM and archive the current active one.

        Args:
            bom: The BOM to activate

        Returns:
            The activated BOM
        """
        # Archive current active BOM if exists
        current_active = bom.product.get_active_bom()
        if current_active and current_active.pk != bom.pk:
            current_active.status = 'archived'
            current_active.save()

        # Activate the provided BOM
        bom.status = 'active'
        bom.save()

        return bom

    @staticmethod
    def get_active_bom(product: Product):
        """
        Get the active Bill of Materials for a product.

        Args:
            product: The product to get the active BOM for

        Returns:
            The active BOM or None
        """
        return product.get_active_bom()

    @staticmethod
    def calculate_bom_cost(bom: BillOfMaterials) -> Decimal:
        """
        Calculate total ingredient cost from all line items in a BOM.

        Args:
            bom: The BOM to calculate cost for

        Returns:
            The total cost as Decimal
        """
        return bom.calculate_bom_cost()

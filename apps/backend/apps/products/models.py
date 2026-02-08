from django.db import models
from decimal import Decimal
from django.core.validators import MinValueValidator
from apps.core.models import ActiveModel, TimestampedModel
from apps.inventory.models import Ingredient


class Product(ActiveModel):
    """Model representing a bakery product."""
    CATEGORY_CHOICES = [
        ('bread', 'Bread'),
        ('pastry', 'Pastry'),
        ('cake', 'Cake'),
        ('cookie', 'Cookie'),
        ('pie', 'Pie'),
        ('other', 'Other'),
    ]

    UNIT_CHOICES = [
        ('piece', 'Piece'),
        ('dozen', 'Dozen'),
        ('kg', 'Kilogram'),
        ('batch', 'Batch'),
    ]

    STATUS_CHOICES = [
        ('active', 'Active'),
        ('discontinued', 'Discontinued'),
        ('development', 'Development'),
    ]

    sku_code = models.CharField(max_length=50, unique=True)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=50, choices=CATEGORY_CHOICES)
    unit = models.CharField(max_length=20, choices=UNIT_CHOICES, default='piece')
    yield_percentage = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=100,
        validators=[MinValueValidator(0), ]
    )
    selling_price = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='active'
    )

    class Meta:
        ordering = ['sku_code']
        verbose_name = 'Product'
        verbose_name_plural = 'Products'

    def __str__(self):
        return f"{self.sku_code} - {self.name}"

    @property
    def latest_cost(self) -> Decimal:
        """Get the cost of the latest active BOM."""
        active_bom = self.get_active_bom()
        if active_bom:
            return active_bom.calculate_bom_cost()
        return Decimal('0')

    @property
    def margin(self) -> Decimal:
        """Calculate selling price minus latest cost."""
        return self.selling_price - self.latest_cost

    @property
    def margin_percentage(self) -> Decimal:
        """Calculate margin as percentage of selling price."""
        if self.selling_price > 0:
            return (self.margin / self.selling_price) * 100
        return Decimal('0')

    def get_active_bom(self):
        """Get the active Bill of Materials for this product."""
        return self.boms.filter(status='active').first()


class BillOfMaterials(TimestampedModel):
    """Model representing a Bill of Materials for a product."""
    STATUS_CHOICES = [
        ('draft', 'Draft'),
        ('active', 'Active'),
        ('archived', 'Archived'),
    ]

    product = models.ForeignKey(
        Product,
        on_delete=models.CASCADE,
        related_name='boms'
    )
    version = models.PositiveIntegerField(default=1)
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='draft'
    )
    effective_date = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ['-version']
        unique_together = ['product', 'version']
        verbose_name = 'Bill of Materials'
        verbose_name_plural = 'Bills of Materials'

    def __str__(self):
        return f"{self.product.name} BOM v{self.version}"

    def calculate_bom_cost(self) -> Decimal:
        """Calculate total ingredient cost from all line items."""
        total_cost = Decimal('0')
        for line_item in self.line_items.all():
            total_cost += line_item.estimated_cost
        return total_cost


class BOMLineItem(TimestampedModel):
    """Model representing a line item in a Bill of Materials."""
    bom = models.ForeignKey(
        BillOfMaterials,
        on_delete=models.CASCADE,
        related_name='line_items'
    )
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.PROTECT
    )
    quantity_per_unit = models.DecimalField(
        max_digits=10,
        decimal_places=4,
        validators=[MinValueValidator(0)]
    )
    waste_percentage = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )
    notes = models.TextField(blank=True)

    class Meta:
        verbose_name = 'BOM Line Item'
        verbose_name_plural = 'BOM Line Items'

    def __str__(self):
        return f"{self.ingredient.name}: {self.quantity_per_unit} {self.ingredient.unit}"

    @property
    def effective_quantity(self) -> Decimal:
        """Calculate quantity including waste percentage."""
        if self.waste_percentage >= 100:
            return Decimal('0')
        return self.quantity_per_unit / (1 - Decimal(self.waste_percentage) / 100)

    @property
    def estimated_cost(self) -> Decimal:
        """Calculate estimated cost for this line item."""
        return self.effective_quantity * self.ingredient.current_cost_per_unit

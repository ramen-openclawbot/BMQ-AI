from django.db import models
from django.core.validators import MinValueValidator
from apps.core.models import ActiveModel, TimestampedModel


class Supplier(ActiveModel):
    """Model representing a supplier of ingredients."""
    name = models.CharField(max_length=200)
    contact_person = models.CharField(max_length=200, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=50, blank=True)
    address = models.TextField(blank=True)

    class Meta:
        ordering = ['name']
        verbose_name = 'Supplier'
        verbose_name_plural = 'Suppliers'

    def __str__(self):
        return self.name


class Ingredient(ActiveModel):
    """Model representing a bakery ingredient."""
    UNIT_CHOICES = [
        ('kg', 'Kilogram'),
        ('g', 'Gram'),
        ('l', 'Liter'),
        ('ml', 'Milliliter'),
        ('piece', 'Piece'),
        ('dozen', 'Dozen'),
        ('pack', 'Pack'),
    ]

    CATEGORY_CHOICES = [
        ('flour', 'Flour'),
        ('sugar', 'Sugar'),
        ('dairy', 'Dairy'),
        ('eggs', 'Eggs'),
        ('oils_fats', 'Oils & Fats'),
        ('leavening', 'Leavening'),
        ('flavoring', 'Flavoring'),
        ('fruit', 'Fruit'),
        ('nuts', 'Nuts'),
        ('chocolate', 'Chocolate'),
        ('packaging', 'Packaging'),
        ('other', 'Other'),
    ]

    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    unit = models.CharField(max_length=20, choices=UNIT_CHOICES)
    category = models.CharField(max_length=50, choices=CATEGORY_CHOICES)
    current_cost_per_unit = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0,
        validators=[MinValueValidator(0)]
    )
    minimum_stock = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )
    current_stock = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )

    class Meta:
        ordering = ['name']
        verbose_name = 'Ingredient'
        verbose_name_plural = 'Ingredients'

    def __str__(self):
        return f"{self.name} ({self.unit})"


class IngredientPriceHistory(TimestampedModel):
    """Model tracking historical price changes for ingredients."""
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.CASCADE,
        related_name='price_history'
    )
    cost_per_unit = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        validators=[MinValueValidator(0)]
    )
    effective_date = models.DateField()
    previous_cost = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        validators=[MinValueValidator(0)]
    )
    change_percentage = models.DecimalField(
        max_digits=8,
        decimal_places=2,
        null=True,
        blank=True
    )
    source = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ['-effective_date']
        verbose_name = 'Ingredient Price History'
        verbose_name_plural = 'Ingredient Price Histories'

    def __str__(self):
        return f"{self.ingredient.name}: {self.cost_per_unit} on {self.effective_date}"


class PurchaseOrder(TimestampedModel):
    """Model representing a purchase order from a supplier."""
    STATUS_CHOICES = [
        ('draft', 'Draft'),
        ('confirmed', 'Confirmed'),
        ('partially_received', 'Partially Received'),
        ('received', 'Received'),
        ('cancelled', 'Cancelled'),
    ]

    po_number = models.CharField(max_length=50, unique=True)
    supplier = models.ForeignKey(
        Supplier,
        on_delete=models.PROTECT,
        related_name='purchase_orders'
    )
    order_date = models.DateField()
    expected_delivery_date = models.DateField(null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='draft'
    )
    notes = models.TextField(blank=True)
    total_amount = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )

    class Meta:
        ordering = ['-order_date']
        verbose_name = 'Purchase Order'
        verbose_name_plural = 'Purchase Orders'

    def __str__(self):
        return f"PO-{self.po_number} ({self.supplier.name})"


class PurchaseOrderLine(TimestampedModel):
    """Model representing a line item in a purchase order."""
    purchase_order = models.ForeignKey(
        PurchaseOrder,
        on_delete=models.CASCADE,
        related_name='lines'
    )
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.PROTECT
    )
    quantity = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )
    unit_price = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        validators=[MinValueValidator(0)]
    )
    received_quantity = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )

    class Meta:
        verbose_name = 'Purchase Order Line'
        verbose_name_plural = 'Purchase Order Lines'

    @property
    def line_total(self):
        """Calculate the total cost of this line item."""
        return self.quantity * self.unit_price

    def __str__(self):
        return f"{self.ingredient.name} x {self.quantity}"

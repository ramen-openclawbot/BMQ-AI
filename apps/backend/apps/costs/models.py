from django.db import models
from decimal import Decimal
from django.core.validators import MinValueValidator
from apps.core.models import ActiveModel, TimestampedModel


class SKUCost(TimestampedModel):
    """Model representing cost calculation for a product SKU."""
    STATUS_CHOICES = [
        ('calculated', 'Calculated'),
        ('approved', 'Approved'),
        ('active', 'Active'),
        ('archived', 'Archived'),
    ]

    product = models.ForeignKey(
        'products.Product',
        on_delete=models.CASCADE,
        related_name='sku_costs'
    )
    version = models.PositiveIntegerField(default=1)
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='calculated'
    )
    effective_date = models.DateField(auto_now_add=True)
    end_date = models.DateField(null=True, blank=True)

    ingredient_cost = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0,
        validators=[MinValueValidator(0)]
    )
    labor_cost = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0,
        validators=[MinValueValidator(0)]
    )
    overhead_cost = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0,
        validators=[MinValueValidator(0)]
    )
    total_cost_per_unit = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0,
        validators=[MinValueValidator(0)]
    )

    calculation_details = models.JSONField(
        default=dict,
        blank=True,
        help_text='Detailed breakdown for audit trail'
    )
    calculated_by = models.CharField(max_length=100, default='system')
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ['-created_at']
        unique_together = ['product', 'version']
        verbose_name = 'SKU Cost'
        verbose_name_plural = 'SKU Costs'

    def __str__(self):
        return f"{self.product.name} v{self.version}: {self.total_cost_per_unit}"

    @property
    def ingredient_percentage(self) -> Decimal:
        """Calculate ingredient cost as percentage of total cost."""
        if self.total_cost_per_unit > 0:
            return (self.ingredient_cost / self.total_cost_per_unit) * 100
        return Decimal('0')

    @property
    def labor_percentage(self) -> Decimal:
        """Calculate labor cost as percentage of total cost."""
        if self.total_cost_per_unit > 0:
            return (self.labor_cost / self.total_cost_per_unit) * 100
        return Decimal('0')

    @property
    def overhead_percentage(self) -> Decimal:
        """Calculate overhead cost as percentage of total cost."""
        if self.total_cost_per_unit > 0:
            return (self.overhead_cost / self.total_cost_per_unit) * 100
        return Decimal('0')

    @property
    def margin(self) -> Decimal:
        """Calculate margin (selling price - total cost per unit)."""
        return self.product.selling_price - self.total_cost_per_unit

    @property
    def margin_percentage(self) -> Decimal:
        """Calculate margin as percentage of selling price."""
        if self.product.selling_price > 0:
            return (self.margin / self.product.selling_price) * 100
        return Decimal('0')


class CostComponent(TimestampedModel):
    """Model representing individual cost components of a SKU cost."""
    COMPONENT_TYPE_CHOICES = [
        ('ingredient', 'Ingredient'),
        ('labor', 'Labor'),
        ('overhead', 'Overhead'),
    ]

    sku_cost = models.ForeignKey(
        SKUCost,
        on_delete=models.CASCADE,
        related_name='components'
    )
    component_type = models.CharField(
        max_length=20,
        choices=COMPONENT_TYPE_CHOICES
    )
    name = models.CharField(max_length=200)
    amount = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        validators=[MinValueValidator(0)]
    )
    percentage_of_total = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )
    details = models.JSONField(
        default=dict,
        blank=True,
        help_text='Additional component-specific details'
    )

    class Meta:
        ordering = ['component_type', '-amount']
        verbose_name = 'Cost Component'
        verbose_name_plural = 'Cost Components'

    def __str__(self):
        return f"{self.sku_cost.product.name} - {self.name}: {self.amount}"


class InflationTracking(TimestampedModel):
    """Model tracking cost changes between SKU cost versions."""
    sku_cost = models.ForeignKey(
        SKUCost,
        on_delete=models.CASCADE,
        related_name='inflation_records'
    )
    previous_sku_cost = models.ForeignKey(
        SKUCost,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='next_inflation'
    )

    ingredient_cost_change = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0
    )
    ingredient_cost_change_pct = models.DecimalField(
        max_digits=8,
        decimal_places=2,
        default=0
    )

    labor_cost_change = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0
    )
    labor_cost_change_pct = models.DecimalField(
        max_digits=8,
        decimal_places=2,
        default=0
    )

    overhead_cost_change = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0
    )
    overhead_cost_change_pct = models.DecimalField(
        max_digits=8,
        decimal_places=2,
        default=0
    )

    total_cost_change = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=0
    )
    total_cost_change_pct = models.DecimalField(
        max_digits=8,
        decimal_places=2,
        default=0
    )

    reason = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = 'Inflation Tracking'
        verbose_name_plural = 'Inflation Tracking'

    def __str__(self):
        return f"{self.sku_cost.product.name} v{self.sku_cost.version}: {self.total_cost_change_pct}%"

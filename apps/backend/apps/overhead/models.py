from django.db import models
from decimal import Decimal
from django.core.validators import MinValueValidator
from apps.core.models import ActiveModel, TimestampedModel


class OverheadCategory(ActiveModel):
    """Model representing overhead cost categories."""
    ALLOCATION_METHOD_CHOICES = [
        ('percentage_of_prime_cost', 'Percentage of Prime Cost'),
        ('per_unit_produced', 'Per Unit Produced'),
        ('direct_assign', 'Direct Assignment'),
    ]

    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    allocation_method = models.CharField(
        max_length=50,
        choices=ALLOCATION_METHOD_CHOICES,
        default='per_unit_produced'
    )
    allocation_percentage = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=Decimal('0'),
        validators=[MinValueValidator(0)]
    )

    class Meta:
        ordering = ['name']
        verbose_name = 'Overhead Category'
        verbose_name_plural = 'Overhead Categories'

    def __str__(self):
        return self.name


class OverheadCost(TimestampedModel):
    """Model representing monthly overhead costs."""
    category = models.ForeignKey(
        OverheadCategory,
        on_delete=models.CASCADE,
        related_name='costs'
    )
    amount = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )
    month = models.PositiveIntegerField(
        validators=[MinValueValidator(1), ]
    )
    year = models.PositiveIntegerField()
    notes = models.TextField(blank=True)

    class Meta:
        unique_together = ['category', 'month', 'year']
        ordering = ['-year', '-month']
        verbose_name = 'Overhead Cost'
        verbose_name_plural = 'Overhead Costs'

    def __str__(self):
        return f"{self.category.name}: {self.amount} ({self.month}/{self.year})"


class MonthlyProductionVolume(TimestampedModel):
    """Model tracking total production volume for a month."""
    month = models.PositiveIntegerField(
        validators=[MinValueValidator(1), ]
    )
    year = models.PositiveIntegerField()
    total_units_produced = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        default=Decimal('0'),
        validators=[MinValueValidator(0)]
    )
    notes = models.TextField(blank=True)

    class Meta:
        unique_together = ['month', 'year']
        ordering = ['-year', '-month']
        verbose_name = 'Monthly Production Volume'
        verbose_name_plural = 'Monthly Production Volumes'

    def __str__(self):
        return f"Production Volume {self.month}/{self.year}: {self.total_units_produced} units"

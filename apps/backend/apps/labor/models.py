from django.db import models
from decimal import Decimal
from django.core.validators import MinValueValidator
from apps.core.models import ActiveModel, TimestampedModel


class Employee(ActiveModel):
    """Model representing a bakery employee."""
    ROLE_CHOICES = [
        ('baker', 'Baker'),
        ('assistant', 'Assistant'),
        ('decorator', 'Decorator'),
        ('packer', 'Packer'),
        ('supervisor', 'Supervisor'),
        ('other', 'Other'),
    ]

    employee_id = models.CharField(max_length=50, unique=True)
    name = models.CharField(max_length=200)
    role = models.CharField(max_length=50, choices=ROLE_CHOICES)
    hire_date = models.DateField()
    phone = models.CharField(max_length=50, blank=True)
    email = models.EmailField(blank=True)

    class Meta:
        ordering = ['employee_id']
        verbose_name = 'Employee'
        verbose_name_plural = 'Employees'

    def __str__(self):
        return f"{self.employee_id} - {self.name}"


class EmployeeWage(TimestampedModel):
    """Model representing employee wage information."""
    WAGE_TYPE_CHOICES = [
        ('hourly', 'Hourly'),
        ('monthly_salary', 'Monthly Salary'),
    ]

    employee = models.ForeignKey(
        Employee,
        on_delete=models.CASCADE,
        related_name='wages'
    )
    wage_type = models.CharField(
        max_length=20,
        choices=WAGE_TYPE_CHOICES,
        default='monthly_salary'
    )
    base_rate = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )
    benefits_multiplier = models.DecimalField(
        max_digits=4,
        decimal_places=2,
        default=Decimal('1.30'),
        validators=[MinValueValidator(0)]
    )
    effective_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ['-effective_date']
        verbose_name = 'Employee Wage'
        verbose_name_plural = 'Employee Wages'

    def __str__(self):
        return f"{self.employee.name}: {self.base_rate} ({self.wage_type}) from {self.effective_date}"

    @property
    def fully_loaded_rate(self) -> Decimal:
        """Calculate fully loaded rate (base_rate * benefits_multiplier)."""
        return self.base_rate * self.benefits_multiplier

    @property
    def hourly_rate(self) -> Decimal:
        """Calculate hourly rate."""
        if self.wage_type == 'monthly_salary':
            # 22 working days per month, 8 hours per day
            return self.base_rate / 22 / 8
        return self.base_rate

    @property
    def fully_loaded_hourly_rate(self) -> Decimal:
        """Calculate fully loaded hourly rate."""
        return self.hourly_rate * self.benefits_multiplier


class ProductionTime(TimestampedModel):
    """Model representing production time and batching for products."""
    product = models.ForeignKey(
        'products.Product',
        on_delete=models.CASCADE,
        related_name='production_times'
    )
    version = models.PositiveIntegerField(default=1)
    total_time_minutes = models.DecimalField(
        max_digits=8,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )
    batch_size = models.PositiveIntegerField(default=1, validators=[MinValueValidator(1)])
    effective_date = models.DateField()
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ['-effective_date']
        unique_together = ['product', 'version']
        verbose_name = 'Production Time'
        verbose_name_plural = 'Production Times'

    def __str__(self):
        return f"{self.product.name} - v{self.version} ({self.total_time_minutes} min)"

    @property
    def time_per_unit_minutes(self) -> Decimal:
        """Calculate time per unit in minutes."""
        return self.total_time_minutes / self.batch_size


class ProductionPhase(TimestampedModel):
    """Model representing a phase within product production."""
    PHASE_CHOICES = [
        ('mixing', 'Mixing'),
        ('shaping', 'Shaping'),
        ('proofing', 'Proofing'),
        ('baking', 'Baking'),
        ('cooling', 'Cooling'),
        ('decorating', 'Decorating'),
        ('packaging', 'Packaging'),
        ('other', 'Other'),
    ]

    ROLE_CHOICES = [
        ('baker', 'Baker'),
        ('assistant', 'Assistant'),
        ('decorator', 'Decorator'),
        ('packer', 'Packer'),
        ('supervisor', 'Supervisor'),
        ('other', 'Other'),
    ]

    production_time = models.ForeignKey(
        ProductionTime,
        on_delete=models.CASCADE,
        related_name='phases'
    )
    phase = models.CharField(max_length=50, choices=PHASE_CHOICES)
    duration_minutes = models.DecimalField(
        max_digits=8,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )
    employees_required = models.PositiveIntegerField(default=1, validators=[MinValueValidator(1)])
    employee_role = models.CharField(max_length=50, choices=ROLE_CHOICES)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ['id']
        verbose_name = 'Production Phase'
        verbose_name_plural = 'Production Phases'

    def __str__(self):
        return f"{self.production_time.product.name} - {self.phase}"

    @property
    def labor_minutes(self) -> Decimal:
        """Calculate total labor minutes (duration * employees_required)."""
        return self.duration_minutes * self.employees_required

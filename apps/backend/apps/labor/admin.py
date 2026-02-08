from django.contrib import admin
from .models import Employee, EmployeeWage, ProductionTime, ProductionPhase


class EmployeeWageInline(admin.TabularInline):
    """Inline admin for employee wages."""
    model = EmployeeWage
    extra = 0
    fields = ['wage_type', 'base_rate', 'benefits_multiplier', 'effective_date', 'end_date', 'notes']


@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    """Admin interface for Employee model."""
    list_display = ['employee_id', 'name', 'role', 'hire_date', 'is_active']
    list_filter = ['role', 'is_active', 'hire_date']
    search_fields = ['employee_id', 'name', 'email']
    fieldsets = (
        ('Basic Information', {
            'fields': ('employee_id', 'name', 'role', 'hire_date')
        }),
        ('Contact Information', {
            'fields': ('phone', 'email')
        }),
        ('Status', {
            'fields': ('is_active',)
        }),
    )
    inlines = [EmployeeWageInline]
    readonly_fields = ['created_at', 'updated_at']


@admin.register(EmployeeWage)
class EmployeeWageAdmin(admin.ModelAdmin):
    """Admin interface for EmployeeWage model."""
    list_display = ['employee', 'wage_type', 'base_rate', 'benefits_multiplier', 'effective_date', 'end_date']
    list_filter = ['wage_type', 'effective_date', 'employee__role']
    search_fields = ['employee__name', 'employee__employee_id']
    fieldsets = (
        ('Employee', {
            'fields': ('employee',)
        }),
        ('Wage Information', {
            'fields': ('wage_type', 'base_rate', 'benefits_multiplier', 'effective_date', 'end_date')
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
    )
    readonly_fields = ['created_at', 'updated_at']


class ProductionPhaseInline(admin.TabularInline):
    """Inline admin for production phases."""
    model = ProductionPhase
    extra = 0
    fields = ['phase', 'duration_minutes', 'employees_required', 'employee_role', 'notes']


@admin.register(ProductionTime)
class ProductionTimeAdmin(admin.ModelAdmin):
    """Admin interface for ProductionTime model."""
    list_display = ['product', 'version', 'total_time_minutes', 'batch_size', 'time_per_unit_minutes', 'effective_date']
    list_filter = ['product', 'effective_date', 'version']
    search_fields = ['product__name', 'product__sku_code']
    fieldsets = (
        ('Product Information', {
            'fields': ('product', 'version')
        }),
        ('Time Information', {
            'fields': ('total_time_minutes', 'batch_size', 'effective_date')
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
    )
    inlines = [ProductionPhaseInline]
    readonly_fields = ['created_at', 'updated_at']


@admin.register(ProductionPhase)
class ProductionPhaseAdmin(admin.ModelAdmin):
    """Admin interface for ProductionPhase model."""
    list_display = ['production_time', 'phase', 'duration_minutes', 'employees_required', 'employee_role', 'labor_minutes']
    list_filter = ['phase', 'employee_role', 'production_time__product']
    search_fields = ['production_time__product__name']
    fieldsets = (
        ('Production Information', {
            'fields': ('production_time',)
        }),
        ('Phase Details', {
            'fields': ('phase', 'duration_minutes', 'employees_required', 'employee_role')
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
    )
    readonly_fields = ['created_at', 'updated_at']

from django.contrib import admin
from .models import OverheadCategory, OverheadCost, MonthlyProductionVolume


class OverheadCostInline(admin.TabularInline):
    """Inline admin for overhead costs."""
    model = OverheadCost
    extra = 0
    fields = ['month', 'year', 'amount', 'notes']


@admin.register(OverheadCategory)
class OverheadCategoryAdmin(admin.ModelAdmin):
    """Admin interface for OverheadCategory model."""
    list_display = ['name', 'allocation_method', 'allocation_percentage', 'is_active']
    list_filter = ['allocation_method', 'is_active']
    search_fields = ['name', 'description']
    fieldsets = (
        ('Category Information', {
            'fields': ('name', 'description')
        }),
        ('Allocation Method', {
            'fields': ('allocation_method', 'allocation_percentage')
        }),
        ('Status', {
            'fields': ('is_active',)
        }),
    )
    inlines = [OverheadCostInline]
    readonly_fields = ['created_at', 'updated_at']


@admin.register(OverheadCost)
class OverheadCostAdmin(admin.ModelAdmin):
    """Admin interface for OverheadCost model."""
    list_display = ['category', 'amount', 'month', 'year']
    list_filter = ['category', 'year', 'month']
    search_fields = ['category__name', 'notes']
    fieldsets = (
        ('Category', {
            'fields': ('category',)
        }),
        ('Cost Information', {
            'fields': ('amount', 'month', 'year')
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
    )
    readonly_fields = ['created_at', 'updated_at']


@admin.register(MonthlyProductionVolume)
class MonthlyProductionVolumeAdmin(admin.ModelAdmin):
    """Admin interface for MonthlyProductionVolume model."""
    list_display = ['year', 'month', 'total_units_produced']
    list_filter = ['year', 'month']
    search_fields = ['notes']
    fieldsets = (
        ('Period', {
            'fields': ('month', 'year')
        }),
        ('Production Information', {
            'fields': ('total_units_produced',)
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
    )
    readonly_fields = ['created_at', 'updated_at']

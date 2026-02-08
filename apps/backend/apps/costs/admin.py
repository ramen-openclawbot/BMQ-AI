from django.contrib import admin
from django.utils.html import format_html
from .models import SKUCost, CostComponent, InflationTracking


class CostComponentInline(admin.TabularInline):
    """Inline admin for cost components."""
    model = CostComponent
    extra = 0
    readonly_fields = ['component_type', 'name', 'amount', 'percentage_of_total', 'created_at']
    can_delete = False
    fields = ['component_type', 'name', 'amount', 'percentage_of_total']


class InflationTrackingInline(admin.TabularInline):
    """Inline admin for inflation tracking."""
    model = InflationTracking
    fk_name = 'sku_cost'
    extra = 0
    readonly_fields = ['total_cost_change', 'total_cost_change_pct', 'created_at']
    can_delete = False
    fields = ['total_cost_change', 'total_cost_change_pct', 'reason']


@admin.register(SKUCost)
class SKUCostAdmin(admin.ModelAdmin):
    """Admin for SKU costs."""
    list_display = [
        'product',
        'version',
        'status_badge',
        'total_cost_per_unit',
        'margin',
        'margin_percentage',
        'effective_date',
    ]
    list_filter = ['status', 'product__category', 'effective_date']
    search_fields = ['product__name', 'product__sku_code']
    readonly_fields = [
        'product',
        'version',
        'ingredient_cost',
        'labor_cost',
        'overhead_cost',
        'total_cost_per_unit',
        'ingredient_percentage',
        'labor_percentage',
        'overhead_percentage',
        'margin',
        'margin_percentage',
        'calculated_by',
        'created_at',
        'updated_at',
        'calculation_details',
    ]
    fieldsets = (
        ('Product Information', {
            'fields': ('product', 'version', 'status', 'effective_date', 'end_date'),
        }),
        ('Costs', {
            'fields': (
                'ingredient_cost',
                'labor_cost',
                'overhead_cost',
                'total_cost_per_unit',
            ),
        }),
        ('Percentages', {
            'fields': (
                'ingredient_percentage',
                'labor_percentage',
                'overhead_percentage',
            ),
        }),
        ('Margin Analysis', {
            'fields': ('margin', 'margin_percentage'),
        }),
        ('Metadata', {
            'fields': (
                'calculated_by',
                'notes',
                'created_at',
                'updated_at',
                'calculation_details',
            ),
            'classes': ('collapse',),
        }),
    )
    inlines = [CostComponentInline, InflationTrackingInline]
    can_delete = False

    def status_badge(self, obj):
        """Display status with color coding."""
        colors = {
            'calculated': '#FFC107',
            'approved': '#17A2B8',
            'active': '#28A745',
            'archived': '#6C757D',
        }
        color = colors.get(obj.status, '#6C757D')
        return format_html(
            '<span style="background-color: {}; color: white; padding: 3px 10px; border-radius: 3px;">{}</span>',
            color,
            obj.get_status_display(),
        )
    status_badge.short_description = 'Status'

    def has_add_permission(self, request):
        """Disable direct creation - should use CostService.calculate_and_create_cost()"""
        return False

    def has_delete_permission(self, request, obj=None):
        """Prevent deletion of cost records."""
        return False


@admin.register(CostComponent)
class CostComponentAdmin(admin.ModelAdmin):
    """Admin for cost components."""
    list_display = ['sku_cost', 'component_type', 'name', 'amount', 'percentage_of_total']
    list_filter = ['component_type', 'sku_cost__product__category']
    search_fields = ['name', 'sku_cost__product__name']
    readonly_fields = [
        'sku_cost',
        'component_type',
        'name',
        'amount',
        'percentage_of_total',
        'details',
        'created_at',
        'updated_at',
    ]
    can_delete = False

    def has_add_permission(self, request):
        """Disable direct creation - created via SKUCostAggregator"""
        return False


@admin.register(InflationTracking)
class InflationTrackingAdmin(admin.ModelAdmin):
    """Admin for inflation tracking."""
    list_display = [
        'sku_cost',
        'total_cost_change',
        'total_cost_change_pct_display',
        'created_at',
    ]
    list_filter = ['created_at', 'sku_cost__product__category']
    search_fields = ['sku_cost__product__name', 'reason']
    readonly_fields = [
        'sku_cost',
        'previous_sku_cost',
        'ingredient_cost_change',
        'ingredient_cost_change_pct',
        'labor_cost_change',
        'labor_cost_change_pct',
        'overhead_cost_change',
        'overhead_cost_change_pct',
        'total_cost_change',
        'total_cost_change_pct',
        'created_at',
        'updated_at',
    ]
    fieldsets = (
        ('SKU Cost Reference', {
            'fields': ('sku_cost', 'previous_sku_cost', 'reason'),
        }),
        ('Ingredient Cost Changes', {
            'fields': ('ingredient_cost_change', 'ingredient_cost_change_pct'),
        }),
        ('Labor Cost Changes', {
            'fields': ('labor_cost_change', 'labor_cost_change_pct'),
        }),
        ('Overhead Cost Changes', {
            'fields': ('overhead_cost_change', 'overhead_cost_change_pct'),
        }),
        ('Total Cost Changes', {
            'fields': ('total_cost_change', 'total_cost_change_pct'),
        }),
        ('Metadata', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',),
        }),
    )
    can_delete = False

    def total_cost_change_pct_display(self, obj):
        """Display percentage change with color coding."""
        if obj.total_cost_change_pct >= 0:
            color = '#DC3545'  # Red for increase
            symbol = '+'
        else:
            color = '#28A745'  # Green for decrease
            symbol = ''

        return format_html(
            '<span style="color: {}; font-weight: bold;">{}{:.2f}%</span>',
            color,
            symbol,
            obj.total_cost_change_pct,
        )
    total_cost_change_pct_display.short_description = 'Cost Change %'

    def has_add_permission(self, request):
        """Disable direct creation - created via SKUCostAggregator"""
        return False

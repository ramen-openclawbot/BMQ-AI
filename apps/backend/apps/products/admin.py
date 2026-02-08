from django.contrib import admin
from .models import Product, BillOfMaterials, BOMLineItem


class BOMLineItemInline(admin.TabularInline):
    """Inline admin for BOM line items."""
    model = BOMLineItem
    extra = 1
    fields = ('ingredient', 'quantity_per_unit', 'waste_percentage', 'notes')
    readonly_fields = ()


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    """Admin interface for products."""
    list_display = ('sku_code', 'name', 'category', 'unit', 'selling_price', 'status', 'is_active')
    list_filter = ('category', 'unit', 'status', 'is_active', 'created_at')
    search_fields = ('sku_code', 'name', 'description')
    fieldsets = (
        ('Basic Information', {
            'fields': ('sku_code', 'name', 'description', 'category')
        }),
        ('Pricing & Units', {
            'fields': ('unit', 'yield_percentage', 'selling_price')
        }),
        ('Status', {
            'fields': ('status', 'is_active')
        }),
    )
    readonly_fields = ('created_at', 'updated_at')


@admin.register(BillOfMaterials)
class BillOfMaterialsAdmin(admin.ModelAdmin):
    """Admin interface for Bills of Materials."""
    list_display = ('product', 'version', 'status', 'effective_date', 'created_at')
    list_filter = ('product', 'status', 'effective_date', 'created_at')
    search_fields = ('product__name', 'product__sku_code', 'notes')
    inlines = [BOMLineItemInline]
    fieldsets = (
        ('Product & Version', {
            'fields': ('product', 'version')
        }),
        ('Status & Dates', {
            'fields': ('status', 'effective_date')
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
    )
    readonly_fields = ('created_at', 'updated_at')


@admin.register(BOMLineItem)
class BOMLineItemAdmin(admin.ModelAdmin):
    """Admin interface for BOM line items."""
    list_display = ('bom', 'ingredient', 'quantity_per_unit', 'waste_percentage', 'effective_quantity')
    list_filter = ('bom__product', 'ingredient', 'created_at')
    search_fields = ('bom__product__name', 'ingredient__name', 'notes')
    fieldsets = (
        ('BOM & Ingredient', {
            'fields': ('bom', 'ingredient')
        }),
        ('Quantities & Waste', {
            'fields': ('quantity_per_unit', 'waste_percentage')
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
    )
    readonly_fields = ('created_at', 'updated_at', 'effective_quantity')

    def effective_quantity(self, obj):
        """Display effective quantity in readonly field."""
        return f"{obj.effective_quantity:.4f}"
    effective_quantity.short_description = 'Effective Quantity'

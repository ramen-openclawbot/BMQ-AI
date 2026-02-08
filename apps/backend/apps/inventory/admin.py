from django.contrib import admin
from .models import (
    Supplier,
    Ingredient,
    IngredientPriceHistory,
    PurchaseOrder,
    PurchaseOrderLine,
)


@admin.register(Supplier)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ('name', 'email', 'phone', 'is_active')
    list_filter = ('is_active', 'created_at')
    search_fields = ('name', 'email', 'contact_person')
    fieldsets = (
        ('Basic Information', {
            'fields': ('name', 'contact_person', 'email', 'phone')
        }),
        ('Address', {
            'fields': ('address',)
        }),
        ('Status', {
            'fields': ('is_active',)
        }),
    )


@admin.register(Ingredient)
class IngredientAdmin(admin.ModelAdmin):
    list_display = ('name', 'category', 'unit', 'current_cost_per_unit', 'current_stock', 'is_active')
    list_filter = ('category', 'unit', 'is_active', 'created_at')
    search_fields = ('name', 'description')
    fieldsets = (
        ('Basic Information', {
            'fields': ('name', 'description', 'category', 'unit')
        }),
        ('Pricing & Stock', {
            'fields': ('current_cost_per_unit', 'minimum_stock', 'current_stock')
        }),
        ('Status', {
            'fields': ('is_active',)
        }),
    )


@admin.register(IngredientPriceHistory)
class IngredientPriceHistoryAdmin(admin.ModelAdmin):
    list_display = ('ingredient', 'cost_per_unit', 'effective_date', 'change_percentage', 'created_at')
    list_filter = ('ingredient', 'effective_date', 'created_at')
    search_fields = ('ingredient__name', 'source')
    fieldsets = (
        ('Ingredient & Price', {
            'fields': ('ingredient', 'cost_per_unit', 'previous_cost', 'change_percentage')
        }),
        ('Date & Source', {
            'fields': ('effective_date', 'source')
        }),
    )
    readonly_fields = ('created_at', 'updated_at')


class PurchaseOrderLineInline(admin.TabularInline):
    model = PurchaseOrderLine
    extra = 1
    fields = ('ingredient', 'quantity', 'unit_price', 'received_quantity')
    readonly_fields = ()


@admin.register(PurchaseOrder)
class PurchaseOrderAdmin(admin.ModelAdmin):
    list_display = ('po_number', 'supplier', 'order_date', 'status', 'total_amount')
    list_filter = ('status', 'order_date', 'supplier', 'created_at')
    search_fields = ('po_number', 'supplier__name', 'notes')
    inlines = [PurchaseOrderLineInline]
    fieldsets = (
        ('Order Information', {
            'fields': ('po_number', 'supplier', 'order_date', 'expected_delivery_date')
        }),
        ('Status & Amount', {
            'fields': ('status', 'total_amount')
        }),
        ('Notes', {
            'fields': ('notes',)
        }),
    )
    readonly_fields = ('created_at', 'updated_at')


@admin.register(PurchaseOrderLine)
class PurchaseOrderLineAdmin(admin.ModelAdmin):
    list_display = ('purchase_order', 'ingredient', 'quantity', 'unit_price', 'received_quantity')
    list_filter = ('purchase_order', 'ingredient', 'created_at')
    search_fields = ('purchase_order__po_number', 'ingredient__name')
    fieldsets = (
        ('Order & Ingredient', {
            'fields': ('purchase_order', 'ingredient')
        }),
        ('Quantities & Pricing', {
            'fields': ('quantity', 'unit_price', 'received_quantity')
        }),
    )
    readonly_fields = ('created_at', 'updated_at')

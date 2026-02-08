from django import forms
from .models import Ingredient, Supplier, PurchaseOrder, PurchaseOrderLine


class SupplierForm(forms.ModelForm):
    """Form for creating and updating suppliers."""

    class Meta:
        model = Supplier
        fields = ('name', 'contact_person', 'email', 'phone', 'address', 'is_active')
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'contact_person': forms.TextInput(attrs={'class': 'form-control'}),
            'email': forms.EmailInput(attrs={'class': 'form-control'}),
            'phone': forms.TextInput(attrs={'class': 'form-control'}),
            'address': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
            'is_active': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
        }


class IngredientForm(forms.ModelForm):
    """Form for creating and updating ingredients."""

    class Meta:
        model = Ingredient
        fields = (
            'name',
            'description',
            'unit',
            'category',
            'current_cost_per_unit',
            'minimum_stock',
            'current_stock',
            'is_active'
        )
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'description': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
            'unit': forms.Select(attrs={'class': 'form-control'}),
            'category': forms.Select(attrs={'class': 'form-control'}),
            'current_cost_per_unit': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.0001',
                'min': '0'
            }),
            'minimum_stock': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0'
            }),
            'current_stock': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0'
            }),
            'is_active': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
        }


class PurchaseOrderForm(forms.ModelForm):
    """Form for creating and updating purchase orders."""

    class Meta:
        model = PurchaseOrder
        fields = (
            'po_number',
            'supplier',
            'order_date',
            'expected_delivery_date',
            'status',
            'notes',
            'total_amount'
        )
        widgets = {
            'po_number': forms.TextInput(attrs={'class': 'form-control'}),
            'supplier': forms.Select(attrs={'class': 'form-control'}),
            'order_date': forms.DateInput(attrs={
                'class': 'form-control',
                'type': 'date'
            }),
            'expected_delivery_date': forms.DateInput(attrs={
                'class': 'form-control',
                'type': 'date'
            }),
            'status': forms.Select(attrs={'class': 'form-control'}),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
            'total_amount': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0'
            }),
        }


class PurchaseOrderLineForm(forms.ModelForm):
    """Form for creating and updating purchase order line items."""

    class Meta:
        model = PurchaseOrderLine
        fields = (
            'purchase_order',
            'ingredient',
            'quantity',
            'unit_price',
            'received_quantity'
        )
        widgets = {
            'purchase_order': forms.Select(attrs={'class': 'form-control'}),
            'ingredient': forms.Select(attrs={'class': 'form-control'}),
            'quantity': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0'
            }),
            'unit_price': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.0001',
                'min': '0'
            }),
            'received_quantity': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0'
            }),
        }


class PurchaseOrderLineInlineForm(forms.ModelForm):
    """Inline form for purchase order line items without PO field."""

    class Meta:
        model = PurchaseOrderLine
        fields = ('ingredient', 'quantity', 'unit_price', 'received_quantity')
        widgets = {
            'ingredient': forms.Select(attrs={'class': 'form-control'}),
            'quantity': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0'
            }),
            'unit_price': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.0001',
                'min': '0'
            }),
            'received_quantity': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0'
            }),
        }

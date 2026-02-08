from django import forms
from .models import Product, BillOfMaterials, BOMLineItem


class ProductForm(forms.ModelForm):
    """Form for creating and updating products."""

    class Meta:
        model = Product
        fields = (
            'sku_code',
            'name',
            'description',
            'category',
            'unit',
            'yield_percentage',
            'selling_price',
            'status',
            'is_active'
        )
        widgets = {
            'sku_code': forms.TextInput(attrs={'class': 'form-control'}),
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'description': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
            'category': forms.Select(attrs={'class': 'form-control'}),
            'unit': forms.Select(attrs={'class': 'form-control'}),
            'yield_percentage': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0',
                'max': '100'
            }),
            'selling_price': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0'
            }),
            'status': forms.Select(attrs={'class': 'form-control'}),
            'is_active': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
        }


class BillOfMaterialsForm(forms.ModelForm):
    """Form for creating and updating Bills of Materials."""

    class Meta:
        model = BillOfMaterials
        fields = ('product', 'version', 'status', 'effective_date', 'notes')
        widgets = {
            'product': forms.Select(attrs={'class': 'form-control'}),
            'version': forms.NumberInput(attrs={
                'class': 'form-control',
                'min': '1'
            }),
            'status': forms.Select(attrs={'class': 'form-control'}),
            'effective_date': forms.DateInput(attrs={
                'class': 'form-control',
                'type': 'date'
            }),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
        }


class BOMLineItemForm(forms.ModelForm):
    """Form for creating and updating BOM line items."""

    class Meta:
        model = BOMLineItem
        fields = ('bom', 'ingredient', 'quantity_per_unit', 'waste_percentage', 'notes')
        widgets = {
            'bom': forms.Select(attrs={'class': 'form-control'}),
            'ingredient': forms.Select(attrs={'class': 'form-control'}),
            'quantity_per_unit': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.0001',
                'min': '0'
            }),
            'waste_percentage': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0',
                'max': '100'
            }),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 2}),
        }


class BOMLineItemInlineForm(forms.ModelForm):
    """Inline form for BOM line items without BOM field."""

    class Meta:
        model = BOMLineItem
        fields = ('ingredient', 'quantity_per_unit', 'waste_percentage', 'notes')
        widgets = {
            'ingredient': forms.Select(attrs={'class': 'form-control'}),
            'quantity_per_unit': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.0001',
                'min': '0'
            }),
            'waste_percentage': forms.NumberInput(attrs={
                'class': 'form-control',
                'step': '0.01',
                'min': '0',
                'max': '100'
            }),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 2}),
        }

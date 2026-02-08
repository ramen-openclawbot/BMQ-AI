from django import forms
from django.forms import inlineformset_factory

from .models import OverheadCategory, OverheadCost, MonthlyProductionVolume


class OverheadCategoryForm(forms.ModelForm):
    """Form for creating and editing OverheadCategory records."""

    class Meta:
        model = OverheadCategory
        fields = ['name', 'description', 'allocation_method', 'allocation_percentage', 'is_active']
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'description': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
            'allocation_method': forms.Select(attrs={'class': 'form-control'}),
            'allocation_percentage': forms.NumberInput(attrs={'class': 'form-control', 'step': '0.01'}),
            'is_active': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
        }


class OverheadCostForm(forms.ModelForm):
    """Form for creating and editing OverheadCost records."""

    class Meta:
        model = OverheadCost
        fields = ['category', 'amount', 'month', 'year', 'notes']
        widgets = {
            'category': forms.Select(attrs={'class': 'form-control'}),
            'amount': forms.NumberInput(attrs={'class': 'form-control', 'step': '0.01'}),
            'month': forms.NumberInput(attrs={'class': 'form-control', 'min': '1', 'max': '12'}),
            'year': forms.NumberInput(attrs={'class': 'form-control'}),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
        }


class MonthlyProductionVolumeForm(forms.ModelForm):
    """Form for creating and editing MonthlyProductionVolume records."""

    class Meta:
        model = MonthlyProductionVolume
        fields = ['month', 'year', 'total_units_produced', 'notes']
        widgets = {
            'month': forms.NumberInput(attrs={'class': 'form-control', 'min': '1', 'max': '12'}),
            'year': forms.NumberInput(attrs={'class': 'form-control'}),
            'total_units_produced': forms.NumberInput(attrs={'class': 'form-control', 'step': '0.01'}),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
        }


# Inline formsets
OverheadCostFormSet = inlineformset_factory(
    OverheadCategory,
    OverheadCost,
    form=OverheadCostForm,
    extra=1,
    can_delete=True
)

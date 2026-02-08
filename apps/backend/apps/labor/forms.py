from django import forms
from django.forms import inlineformset_factory

from .models import Employee, EmployeeWage, ProductionTime, ProductionPhase


class EmployeeForm(forms.ModelForm):
    """Form for creating and editing Employee records."""

    class Meta:
        model = Employee
        fields = ['employee_id', 'name', 'role', 'hire_date', 'phone', 'email', 'is_active']
        widgets = {
            'employee_id': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'e.g., EMP001'}),
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'role': forms.Select(attrs={'class': 'form-control'}),
            'hire_date': forms.DateInput(attrs={'class': 'form-control', 'type': 'date'}),
            'phone': forms.TextInput(attrs={'class': 'form-control', 'placeholder': '+1 (555) 123-4567'}),
            'email': forms.EmailInput(attrs={'class': 'form-control'}),
            'is_active': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
        }


class EmployeeWageForm(forms.ModelForm):
    """Form for creating and editing EmployeeWage records."""

    class Meta:
        model = EmployeeWage
        fields = ['employee', 'wage_type', 'base_rate', 'benefits_multiplier', 'effective_date', 'end_date', 'notes']
        widgets = {
            'employee': forms.Select(attrs={'class': 'form-control'}),
            'wage_type': forms.Select(attrs={'class': 'form-control'}),
            'base_rate': forms.NumberInput(attrs={'class': 'form-control', 'step': '0.01'}),
            'benefits_multiplier': forms.NumberInput(attrs={'class': 'form-control', 'step': '0.01'}),
            'effective_date': forms.DateInput(attrs={'class': 'form-control', 'type': 'date'}),
            'end_date': forms.DateInput(attrs={'class': 'form-control', 'type': 'date'}),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
        }


class ProductionTimeForm(forms.ModelForm):
    """Form for creating and editing ProductionTime records."""

    class Meta:
        model = ProductionTime
        fields = ['product', 'version', 'total_time_minutes', 'batch_size', 'effective_date', 'notes']
        widgets = {
            'product': forms.Select(attrs={'class': 'form-control'}),
            'version': forms.NumberInput(attrs={'class': 'form-control'}),
            'total_time_minutes': forms.NumberInput(attrs={'class': 'form-control', 'step': '0.01'}),
            'batch_size': forms.NumberInput(attrs={'class': 'form-control'}),
            'effective_date': forms.DateInput(attrs={'class': 'form-control', 'type': 'date'}),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
        }


class ProductionPhaseForm(forms.ModelForm):
    """Form for creating and editing ProductionPhase records."""

    class Meta:
        model = ProductionPhase
        fields = ['production_time', 'phase', 'duration_minutes', 'employees_required', 'employee_role', 'notes']
        widgets = {
            'production_time': forms.Select(attrs={'class': 'form-control'}),
            'phase': forms.Select(attrs={'class': 'form-control'}),
            'duration_minutes': forms.NumberInput(attrs={'class': 'form-control', 'step': '0.01'}),
            'employees_required': forms.NumberInput(attrs={'class': 'form-control'}),
            'employee_role': forms.Select(attrs={'class': 'form-control'}),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 3}),
        }


# Inline formsets
ProductionPhaseFormSet = inlineformset_factory(
    ProductionTime,
    ProductionPhase,
    form=ProductionPhaseForm,
    extra=1,
    can_delete=True
)

EmployeeWageFormSet = inlineformset_factory(
    Employee,
    EmployeeWage,
    form=EmployeeWageForm,
    extra=1,
    can_delete=True
)

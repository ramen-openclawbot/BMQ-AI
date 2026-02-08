from django.shortcuts import render, get_object_or_404
from django.views.generic import ListView, CreateView, DetailView, UpdateView
from django.urls import reverse_lazy
from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Q
from django.views import View
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.utils.dateparse import parse_date
from django.utils import timezone
import json

from .models import Employee, EmployeeWage, ProductionTime, ProductionPhase
from .forms import (
    EmployeeForm,
    EmployeeWageForm,
    ProductionTimeForm,
    ProductionPhaseForm,
    ProductionPhaseFormSet,
    EmployeeWageFormSet,
)
from .services import LaborService


@csrf_exempt
def employees_api(request):
    if request.method == 'GET':
        items = []
        for e in Employee.objects.all().order_by('name'):
            wage = e.wages.order_by('-effective_date').first()
            items.append({
                "id": e.id,
                "employee_id": e.employee_id,
                "name": e.name,
                "role": e.role,
                "hire_date": e.hire_date.isoformat() if e.hire_date else None,
                "phone": e.phone,
                "email": e.email,
                "wage_type": wage.wage_type if wage else None,
                "base_rate": float(wage.base_rate) if wage else None,
                "hourly_rate": float(wage.hourly_rate) if wage else None,
                "status": "active" if e.is_active else "inactive",
            })
        return JsonResponse({"items": items})

    if request.method == 'POST':
        data = json.loads(request.body or '{}')
        e = Employee.objects.create(
            employee_id=data.get('employee_id'),
            name=data.get('name'),
            role=data.get('role', 'other'),
            hire_date=parse_date(data.get('hire_date')) or timezone.now().date(),
            phone=data.get('phone', ''),
            email=data.get('email', ''),
            is_active=True,
        )
        base_rate = data.get('base_rate') or 0
        wage_type = data.get('wage_type') or 'monthly_salary'
        EmployeeWage.objects.create(
            employee=e,
            wage_type=wage_type,
            base_rate=base_rate,
            effective_date=timezone.now().date(),
        )
        return JsonResponse({"id": e.id})

    return JsonResponse({"error": "Method not allowed"}, status=405)


@csrf_exempt
def employee_api_detail(request, pk):
    e = get_object_or_404(Employee, pk=pk)

    if request.method == 'GET':
        wage = e.wages.order_by('-effective_date').first()
        return JsonResponse({
            "id": e.id,
            "employee_id": e.employee_id,
            "name": e.name,
            "role": e.role,
            "hire_date": e.hire_date.isoformat() if e.hire_date else None,
            "phone": e.phone,
            "email": e.email,
            "wage_type": wage.wage_type if wage else None,
            "base_rate": float(wage.base_rate) if wage else None,
            "hourly_rate": float(wage.hourly_rate) if wage else None,
            "status": "active" if e.is_active else "inactive",
        })

    if request.method in ['PUT', 'PATCH']:
        data = json.loads(request.body or '{}')
        for field in ['employee_id','name','role','phone','email']:
            if field in data:
                setattr(e, field, data.get(field))
        if 'hire_date' in data:
            e.hire_date = parse_date(data.get('hire_date')) or e.hire_date
        if 'is_active' in data:
            e.is_active = bool(data.get('is_active'))
        e.save()
        if 'base_rate' in data or 'wage_type' in data:
            EmployeeWage.objects.create(
                employee=e,
                wage_type=data.get('wage_type') or 'monthly_salary',
                base_rate=data.get('base_rate') or 0,
                effective_date=timezone.now().date(),
            )
        return JsonResponse({"ok": True})

    if request.method == 'DELETE':
        e.delete()
        return JsonResponse({"ok": True})

    return JsonResponse({"error": "Method not allowed"}, status=405)


class EmployeeListView(LoginRequiredMixin, ListView):
    """Display list of employees."""
    model = Employee
    context_object_name = 'employees'
    template_name = 'labor/employee_list.html'
    paginate_by = 20

    def get_queryset(self):
        queryset = Employee.objects.all()
        role = self.request.GET.get('role')
        active_only = self.request.GET.get('active_only')

        if role:
            queryset = queryset.filter(role=role)
        if active_only:
            queryset = queryset.filter(is_active=True)

        return queryset

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context['role_choices'] = Employee.ROLE_CHOICES
        context['selected_role'] = self.request.GET.get('role', '')
        return context


class EmployeeCreateView(LoginRequiredMixin, CreateView):
    """Create a new employee."""
    model = Employee
    form_class = EmployeeForm
    template_name = 'labor/employee_form.html'
    success_url = reverse_lazy('labor:employee_list')

    def form_valid(self, form):
        response = super().form_valid(form)
        return response


class EmployeeDetailView(LoginRequiredMixin, DetailView):
    """Display employee details with wage history."""
    model = Employee
    context_object_name = 'employee'
    template_name = 'labor/employee_detail.html'
    slug_field = 'employee_id'
    slug_url_kwarg = 'employee_id'

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        employee = self.get_object()
        context['wages'] = employee.wages.all()
        context['current_wage'] = LaborService.get_current_wage(employee)
        return context


class EmployeeUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing employee."""
    model = Employee
    form_class = EmployeeForm
    template_name = 'labor/employee_form.html'
    slug_field = 'employee_id'
    slug_url_kwarg = 'employee_id'

    def get_success_url(self):
        return reverse_lazy('labor:employee_detail', kwargs={'employee_id': self.object.employee_id})


class ProductionTimeListView(LoginRequiredMixin, ListView):
    """Display list of production times."""
    model = ProductionTime
    context_object_name = 'production_times'
    template_name = 'labor/productiontime_list.html'
    paginate_by = 20

    def get_queryset(self):
        queryset = ProductionTime.objects.select_related('product').all()
        product_id = self.request.GET.get('product')

        if product_id:
            queryset = queryset.filter(product_id=product_id)

        return queryset.order_by('-effective_date')

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        from apps.products.models import Product
        context['products'] = Product.objects.filter(is_active=True)
        return context


class ProductionTimeCreateView(LoginRequiredMixin, CreateView):
    """Create a new production time with phases."""
    model = ProductionTime
    form_class = ProductionTimeForm
    template_name = 'labor/productiontime_form.html'
    success_url = reverse_lazy('labor:productiontime_list')

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        if self.request.POST:
            context['formset'] = ProductionPhaseFormSet(self.request.POST, instance=self.object)
        else:
            context['formset'] = ProductionPhaseFormSet(instance=self.object)
        return context

    def form_valid(self, form):
        context = self.get_context_data()
        formset = context['formset']
        if formset.is_valid():
            self.object = form.save()
            formset.instance = self.object
            formset.save()
            return super().form_valid(form)
        else:
            return self.form_invalid(form)


class ProductionTimeUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing production time with phases."""
    model = ProductionTime
    form_class = ProductionTimeForm
    template_name = 'labor/productiontime_form.html'

    def get_success_url(self):
        return reverse_lazy('labor:productiontime_list')

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        if self.request.POST:
            context['formset'] = ProductionPhaseFormSet(self.request.POST, instance=self.object)
        else:
            context['formset'] = ProductionPhaseFormSet(instance=self.object)
        return context

    def form_valid(self, form):
        context = self.get_context_data()
        formset = context['formset']
        if formset.is_valid():
            self.object = form.save()
            formset.instance = self.object
            formset.save()
            return super().form_valid(form)
        else:
            return self.form_invalid(form)

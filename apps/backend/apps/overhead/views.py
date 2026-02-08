from django.shortcuts import render, get_object_or_404
from django.views.generic import ListView, CreateView, UpdateView, TemplateView
from django.urls import reverse_lazy
from django.contrib.auth.mixins import LoginRequiredMixin
from django.utils import timezone
from django.views import View
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
import json

from .models import OverheadCategory, OverheadCost, MonthlyProductionVolume
from .forms import (
    OverheadCategoryForm,
    OverheadCostForm,
    MonthlyProductionVolumeForm,
    OverheadCostFormSet,
)
from .services import OverheadService


class OverheadCategoryListView(LoginRequiredMixin, ListView):
    """Display list of overhead categories."""
    model = OverheadCategory
    context_object_name = 'categories'
    template_name = 'overhead/overheadcategory_list.html'
    paginate_by = 20

    def get_queryset(self):
        return OverheadCategory.objects.all()

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context['allocation_methods'] = OverheadCategory.ALLOCATION_METHOD_CHOICES
        return context


class OverheadCategoryCreateView(LoginRequiredMixin, CreateView):
    """Create a new overhead category."""
    model = OverheadCategory
    form_class = OverheadCategoryForm
    template_name = 'overhead/overheadcategory_form.html'
    success_url = reverse_lazy('overhead:category_list')


class OverheadCategoryUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing overhead category."""
    model = OverheadCategory
    form_class = OverheadCategoryForm
    template_name = 'overhead/overheadcategory_form.html'

    def get_success_url(self):
        return reverse_lazy('overhead:category_list')


@csrf_exempt
def overhead_costs_api(request):
    if request.method == 'GET':
        items = []
        for c in OverheadCost.objects.select_related('category').order_by('-month'):
            items.append({
                "id": c.id,
                "category": c.category.name,
                "amount": float(c.amount),
                "month": c.month.strftime('%Y-%m') if hasattr(c.month, 'strftime') else str(c.month) if c.month is not None else None,
            })
        return JsonResponse({"items": items})

    if request.method == 'POST':
        data = json.loads(request.body or '{}')
        category = OverheadCategory.objects.get(id=data.get('category_id'))
        c = OverheadCost.objects.create(
            category=category,
            amount=data.get('amount') or 0,
            month=data.get('month') or None,
        )
        return JsonResponse({"id": c.id})

    return JsonResponse({"error": "Method not allowed"}, status=405)


@csrf_exempt
def overhead_cost_api_detail(request, pk):
    c = get_object_or_404(OverheadCost, pk=pk)

    if request.method == 'GET':
        return JsonResponse({
            "id": c.id,
            "category": c.category.name,
            "category_id": c.category.id,
            "amount": float(c.amount),
            "month": c.month.strftime('%Y-%m') if hasattr(c.month, 'strftime') else str(c.month) if c.month is not None else None,
        })

    if request.method in ['PUT','PATCH']:
        data = json.loads(request.body or '{}')
        if 'category_id' in data:
            c.category = OverheadCategory.objects.get(id=data.get('category_id'))
        if 'amount' in data:
            c.amount = data.get('amount') or 0
        if 'month' in data:
            c.month = data.get('month') or None
        c.save()
        return JsonResponse({"ok": True})

    if request.method == 'DELETE':
        c.delete()
        return JsonResponse({"ok": True})

    return JsonResponse({"error": "Method not allowed"}, status=405)


class OverheadCostListView(LoginRequiredMixin, ListView):
    """Display list of overhead costs with filtering by month/year."""
    model = OverheadCost
    context_object_name = 'costs'
    template_name = 'overhead/overheadcost_list.html'
    paginate_by = 50

    def get_queryset(self):
        queryset = OverheadCost.objects.select_related('category').all()

        month = self.request.GET.get('month')
        year = self.request.GET.get('year')
        category = self.request.GET.get('category')

        if month:
            queryset = queryset.filter(month=month)
        if year:
            queryset = queryset.filter(year=year)
        if category:
            queryset = queryset.filter(category_id=category)

        return queryset.order_by('-year', '-month')

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        current_year = timezone.now().year

        context['categories'] = OverheadCategory.objects.filter(is_active=True)
        context['years'] = range(current_year - 5, current_year + 1)
        context['months'] = range(1, 13)
        context['selected_month'] = self.request.GET.get('month', '')
        context['selected_year'] = self.request.GET.get('year', '')
        context['selected_category'] = self.request.GET.get('category', '')

        # Calculate totals for the selected month/year
        month = self.request.GET.get('month')
        year = self.request.GET.get('year')
        if month and year:
            context['monthly_total'] = OverheadService.get_monthly_overhead_total(int(month), int(year))

        return context


class OverheadCostCreateView(LoginRequiredMixin, CreateView):
    """Create a new overhead cost."""
    model = OverheadCost
    form_class = OverheadCostForm
    template_name = 'overhead/overheadcost_form.html'
    success_url = reverse_lazy('overhead:cost_list')


class OverheadCostUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing overhead cost."""
    model = OverheadCost
    form_class = OverheadCostForm
    template_name = 'overhead/overheadcost_form.html'

    def get_success_url(self):
        return reverse_lazy('overhead:cost_list')


class MonthlyOverviewView(LoginRequiredMixin, TemplateView):
    """Display monthly overhead overview with breakdown by category."""
    template_name = 'overhead/monthly_overview.html'

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        current_year = timezone.now().year
        current_month = timezone.now().month

        month = int(self.request.GET.get('month', current_month))
        year = int(self.request.GET.get('year', current_year))

        context['month'] = month
        context['year'] = year
        context['months'] = range(1, 13)
        context['years'] = range(current_year - 5, current_year + 1)

        # Get overhead breakdown
        context['breakdown'] = OverheadService.get_overhead_breakdown(month, year)
        context['total_overhead'] = OverheadService.get_monthly_overhead_total(month, year)

        # Get production volume
        try:
            volume = MonthlyProductionVolume.objects.get(month=month, year=year)
            context['production_volume'] = volume
            context['overhead_per_unit'] = context['total_overhead'] / volume.total_units_produced if volume.total_units_produced > 0 else 0
        except MonthlyProductionVolume.DoesNotExist:
            context['production_volume'] = None
            context['overhead_per_unit'] = 0

        return context


class MonthlyProductionVolumeListView(LoginRequiredMixin, ListView):
    """Display list of monthly production volumes."""
    model = MonthlyProductionVolume
    context_object_name = 'volumes'
    template_name = 'overhead/monthlyproductionvolume_list.html'
    paginate_by = 20

    def get_queryset(self):
        return MonthlyProductionVolume.objects.all().order_by('-year', '-month')


class MonthlyProductionVolumeCreateView(LoginRequiredMixin, CreateView):
    """Create a new monthly production volume record."""
    model = MonthlyProductionVolume
    form_class = MonthlyProductionVolumeForm
    template_name = 'overhead/monthlyproductionvolume_form.html'
    success_url = reverse_lazy('overhead:volume_list')


class MonthlyProductionVolumeUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing monthly production volume record."""
    model = MonthlyProductionVolume
    form_class = MonthlyProductionVolumeForm
    template_name = 'overhead/monthlyproductionvolume_form.html'

    def get_success_url(self):
        return reverse_lazy('overhead:volume_list')

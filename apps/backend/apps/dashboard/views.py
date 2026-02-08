from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import TemplateView, ListView
from django.db.models import Q, Avg, Count, Sum, F
from decimal import Decimal
from apps.costs.models import SKUCost
from apps.products.models import Product
from apps.inventory.models import Ingredient
from apps.labor.models import Employee, EmployeeWage


class DashboardHomeView(LoginRequiredMixin, TemplateView):
    """Main dashboard home view."""
    template_name = 'dashboard/home.html'
    login_url = 'accounts:login'

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        # Get latest SKU costs
        latest_costs = SKUCost.objects.filter(
            status='active'
        ).select_related('product').order_by('-created_at')[:10]

        # Get cost summary
        active_costs = SKUCost.objects.filter(status='active')
        context['total_products'] = Product.objects.filter(status='active').count()
        context['avg_ingredient_cost'] = active_costs.aggregate(
            avg=Avg('ingredient_cost')
        )['avg'] or Decimal('0')
        context['avg_margin_percentage'] = active_costs.aggregate(
            avg=Avg('total_cost_per_unit')
        )['avg'] or Decimal('0')

        # Low stock alerts
        low_stock = Ingredient.objects.filter(
            Q(current_stock__lte=Decimal('10')) |
            Q(current_stock__lte=F('minimum_stock'))
        )
        context['low_stock_count'] = low_stock.count()
        context['low_stock_items'] = low_stock[:5]

        context['recent_costs'] = latest_costs
        context['page_title'] = 'Dashboard'

        return context


class SKUCostDashboardView(LoginRequiredMixin, ListView):
    """SKU Cost listing and filtering view."""
    model = SKUCost
    template_name = 'dashboard/sku_costs.html'
    context_object_name = 'sku_costs'
    paginate_by = 20
    login_url = 'accounts:login'

    def get_queryset(self):
        queryset = SKUCost.objects.filter(
            status='active'
        ).select_related('product').order_by('-created_at')

        # Filter by category
        category = self.request.GET.get('category')
        if category:
            queryset = queryset.filter(product__category=category)

        # Filter by search
        search = self.request.GET.get('search')
        if search:
            queryset = queryset.filter(
                Q(product__name__icontains=search) |
                Q(product__sku_code__icontains=search)
            )

        # Sort
        sort = self.request.GET.get('sort', '-created_at')
        queryset = queryset.order_by(sort)

        return queryset

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context['categories'] = Product.CATEGORY_CHOICES
        context['page_title'] = 'SKU Costs'
        return context


class CostTrendsView(LoginRequiredMixin, TemplateView):
    """Cost trends visualization view."""
    template_name = 'dashboard/trends.html'
    login_url = 'accounts:login'

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        # Get trend data for Chart.js
        costs = SKUCost.objects.filter(
            status='active'
        ).order_by('created_at').values('created_at', 'total_cost_per_unit')

        context['cost_data'] = list(costs)
        context['page_title'] = 'Cost Trends'
        context['categories'] = Product.CATEGORY_CHOICES

        return context


class OverheadBreakdownView(LoginRequiredMixin, TemplateView):
    """Overhead cost breakdown view."""
    template_name = 'dashboard/overhead_breakdown.html'
    login_url = 'accounts:login'

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)

        # Get overhead breakdown
        overhead_data = SKUCost.objects.filter(
            status='active'
        ).aggregate(
            total_overhead=Sum('overhead_cost'),
            avg_overhead=Avg('overhead_cost')
        )

        context['overhead_data'] = overhead_data
        context['page_title'] = 'Overhead Breakdown'

        return context

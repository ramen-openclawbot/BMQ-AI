from django.shortcuts import render, get_object_or_404, redirect
from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import ListView, DetailView
from django.views import View
from django.http import JsonResponse, HttpResponse
from django.db.models import Q
from django.utils import timezone
from datetime import datetime

from apps.products.models import Product
from .models import SKUCost
from .services import CostService


class CostListView(LoginRequiredMixin, ListView):
    """List all current SKU costs with filtering."""
    model = SKUCost
    template_name = 'costs/cost_list.html'
    context_object_name = 'costs'
    paginate_by = 25

    def get_queryset(self):
        """
        Get active or latest calculated costs for all products.
        Filter by category and cost range if provided.
        """
        queryset = CostService.get_all_active_costs()

        # Filter by product category
        category = self.request.GET.get('category')
        if category:
            queryset = queryset.filter(product__category=category)

        # Filter by cost range
        min_cost = self.request.GET.get('min_cost')
        max_cost = self.request.GET.get('max_cost')

        if min_cost:
            try:
                min_cost = float(min_cost)
                queryset = queryset.filter(total_cost_per_unit__gte=min_cost)
            except (ValueError, TypeError):
                pass

        if max_cost:
            try:
                max_cost = float(max_cost)
                queryset = queryset.filter(total_cost_per_unit__lte=max_cost)
            except (ValueError, TypeError):
                pass

        # Filter by margin
        min_margin = self.request.GET.get('min_margin')
        if min_margin:
            try:
                min_margin = float(min_margin)
                queryset = [c for c in queryset if float(c.margin_percentage) >= min_margin]
            except (ValueError, TypeError):
                pass

        return queryset

    def get_context_data(self, **kwargs):
        """Add filter options to context."""
        context = super().get_context_data(**kwargs)
        context['categories'] = Product.CATEGORY_CHOICES
        context['summary'] = CostService.get_cost_summary()
        return context


class CostDetailView(LoginRequiredMixin, DetailView):
    """Detailed cost breakdown for one SKU."""
    model = SKUCost
    template_name = 'costs/cost_detail.html'
    context_object_name = 'cost'

    def get_context_data(self, **kwargs):
        """Add related data to context."""
        context = super().get_context_data(**kwargs)
        cost = self.get_object()

        # Get cost history
        context['history'] = CostService.get_cost_history(cost.product, limit=10)

        # Get cost trend data for chart
        context['trend_data'] = CostService.get_cost_trend(cost.product, months=12)

        # Get components grouped by type
        context['components_by_type'] = {}
        for component_type in ['ingredient', 'labor', 'overhead']:
            context['components_by_type'][component_type] = cost.components.filter(
                component_type=component_type
            ).order_by('-amount')

        # Get inflation tracking if available
        context['inflation_records'] = cost.inflation_records.all()

        return context


class CostHistoryView(LoginRequiredMixin, DetailView):
    """Show all cost versions for a product."""
    model = Product
    template_name = 'costs/cost_history.html'
    context_object_name = 'product'

    def get_context_data(self, **kwargs):
        """Add cost history to context."""
        context = super().get_context_data(**kwargs)
        product = self.get_object()

        # Get all versions
        context['costs'] = product.sku_costs.all()

        # Get trend data
        context['trend_data'] = CostService.get_cost_trend(product, months=12)

        return context


class CostListAPIView(View):
    """JSON API endpoint returning active SKU costs (no auth for local integration)."""

    def get(self, request):
        costs = CostService.get_all_active_costs()
        data = []
        for c in costs:
            data.append({
                "id": c.id,
                "product_id": c.product.id,
                "product_name": c.product.name,
                "sku_code": c.product.sku_code,
                "category": c.product.get_category_display() if hasattr(c.product, "get_category_display") else c.product.category,
                "unit": getattr(c.product, "unit", None),
                "version": c.version,
                "status": c.status,
                "ingredient_cost": float(c.ingredient_cost),
                "labor_cost": float(c.labor_cost),
                "overhead_cost": float(c.overhead_cost),
                "total_cost_per_unit": float(c.total_cost_per_unit),
                "margin": float(c.margin),
                "margin_percentage": float(c.margin_percentage),
                "updated_at": c.updated_at.isoformat() if c.updated_at else None,
            })
        return JsonResponse({"items": data})


class CostTrendPublicAPIView(View):
    """Public JSON API endpoint returning cost trend data for Chart.js."""

    def get(self, request, product_id):
        return CostTrendAPIView().get(request, product_id)


class RecentCostsAPIView(View):
    """Public JSON API returning recent cost calculations."""

    def get(self, request):
        costs = SKUCost.objects.select_related('product').order_by('-updated_at')[:10]
        items = []
        for c in costs:
            items.append({
                "id": c.id,
                "product_name": c.product.name,
                "sku_code": c.product.sku_code,
                "total_cost_per_unit": float(c.total_cost_per_unit),
                "margin_percentage": float(c.margin_percentage),
                "updated_at": c.updated_at.isoformat() if c.updated_at else None,
            })
        return JsonResponse({"items": items})


class CostTrendAPIView(LoginRequiredMixin, View):
    """JSON API endpoint returning cost trend data for Chart.js."""

    def get(self, request, product_id):
        """
        Return cost trend data as JSON.

        Query params:
        - months: Number of months to look back (default: 6)
        """
        product = get_object_or_404(Product, pk=product_id)
        months = request.GET.get('months', 6)

        try:
            months = int(months)
        except (ValueError, TypeError):
            months = 6

        trend_data = CostService.get_cost_trend(product, months=months)

        # Format for Chart.js
        chart_data = {
            'labels': [d['date'] for d in trend_data],
            'datasets': [
                {
                    'label': 'Ingredient Cost',
                    'data': [d['ingredient'] for d in trend_data],
                    'borderColor': '#FF6384',
                    'backgroundColor': 'rgba(255, 99, 132, 0.1)',
                    'fill': False,
                },
                {
                    'label': 'Labor Cost',
                    'data': [d['labor'] for d in trend_data],
                    'borderColor': '#36A2EB',
                    'backgroundColor': 'rgba(54, 162, 235, 0.1)',
                    'fill': False,
                },
                {
                    'label': 'Overhead Cost',
                    'data': [d['overhead'] for d in trend_data],
                    'borderColor': '#FFCE56',
                    'backgroundColor': 'rgba(255, 206, 86, 0.1)',
                    'fill': False,
                },
                {
                    'label': 'Total Cost',
                    'data': [d['total'] for d in trend_data],
                    'borderColor': '#4BC0C0',
                    'backgroundColor': 'rgba(75, 192, 192, 0.1)',
                    'borderWidth': 2,
                    'fill': False,
                },
                {
                    'label': 'Margin',
                    'data': [d['margin'] for d in trend_data],
                    'borderColor': '#C9CBCF',
                    'backgroundColor': 'rgba(201, 203, 207, 0.1)',
                    'fill': False,
                },
            ],
        }

        return JsonResponse(chart_data)


class ExportCSVView(LoginRequiredMixin, View):
    """Download costs as CSV."""

    def get(self, request):
        """Export all active costs to CSV."""
        # Get optional product filter
        product_ids = request.GET.getlist('products')

        if product_ids:
            products = Product.objects.filter(id__in=product_ids)
        else:
            products = None

        csv_content = CostService.export_costs_csv(products=products)

        response = HttpResponse(csv_content, content_type='text/csv')
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        response['Content-Disposition'] = f'attachment; filename="sku_costs_{timestamp}.csv"'

        return response


class RecalculateView(LoginRequiredMixin, View):
    """POST endpoint to trigger cost recalculation."""

    def post(self, request):
        """
        Trigger recalculation for one or all products.

        POST params:
        - product_id: Optional specific product to recalculate
        - all: "true" to recalculate all products
        """
        all_products = request.POST.get('all') == 'true'
        product_id = request.POST.get('product_id')

        try:
            if all_products:
                result = CostService.recalculate_all_costs(
                    calculated_by=request.user.username or 'system'
                )
                message = f"Recalculated {result['success_count']} products"
            elif product_id:
                product = get_object_or_404(Product, pk=product_id)
                CostService.recalculate_product_cost(
                    product,
                    calculated_by=request.user.username or 'system'
                )
                message = f"Recalculated cost for {product.name}"
            else:
                return JsonResponse(
                    {'error': 'Either product_id or all parameter required'},
                    status=400
                )

            return JsonResponse({
                'success': True,
                'message': message,
            })

        except Exception as e:
            return JsonResponse({
                'success': False,
                'error': str(e),
            }, status=500)

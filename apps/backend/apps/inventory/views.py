from decimal import Decimal
from django.shortcuts import render, redirect, get_object_or_404
from django.views.generic import ListView, CreateView, UpdateView, DetailView
from django.urls import reverse_lazy
from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Q
from django.http import HttpResponseRedirect, JsonResponse
from django.views import View
from django.db import models
from django.views.decorators.http import require_POST
from django.contrib.auth.decorators import login_required
from django.views.decorators.csrf import csrf_exempt
import json
from .models import Ingredient, Supplier, PurchaseOrder, PurchaseOrderLine
from .forms import (
    IngredientForm,
    SupplierForm,
    PurchaseOrderForm,
    PurchaseOrderLineForm,
)
from .services import InventoryService


# Ingredient Views
class IngredientListView(LoginRequiredMixin, ListView):
    """Display list of all ingredients with search/filter capabilities."""
    model = Ingredient
    template_name = 'inventory/ingredient_list.html'
    context_object_name = 'ingredients'
    paginate_by = 20

    def get_queryset(self):
        """Filter ingredients based on search and category."""
        queryset = Ingredient.objects.filter(is_active=True)

        search_query = self.request.GET.get('search', '')
        if search_query:
            queryset = queryset.filter(
                Q(name__icontains=search_query) |
                Q(description__icontains=search_query)
            )

        category = self.request.GET.get('category', '')
        if category:
            queryset = queryset.filter(category=category)

        return queryset.order_by('name')

    def get_context_data(self, **kwargs):
        """Add filter options to context."""
        context = super().get_context_data(**kwargs)
        context['categories'] = Ingredient.CATEGORY_CHOICES
        context['search_query'] = self.request.GET.get('search', '')
        context['selected_category'] = self.request.GET.get('category', '')
        return context


class IngredientCreateView(LoginRequiredMixin, CreateView):
    """Create a new ingredient."""
    model = Ingredient
    form_class = IngredientForm
    template_name = 'inventory/ingredient_form.html'
    success_url = reverse_lazy('inventory:ingredient_list')


@csrf_exempt
def ingredients_api(request):
    if request.method == 'GET':
        items = []
        for i in Ingredient.objects.all().order_by('name'):
            items.append({
                "id": i.id,
                "name": i.name,
                "category": i.get_category_display() if hasattr(i, 'get_category_display') else i.category,
                "unit": i.unit,
                "current_stock": float(i.current_stock),
                "minimum_stock": float(i.minimum_stock),
                "current_cost_per_unit": float(i.current_cost_per_unit),
            })
        return JsonResponse({"items": items})

    if request.method == 'POST':
        data = json.loads(request.body or '{}')
        i = Ingredient.objects.create(
            name=data.get('name'),
            category=data.get('category', 'other'),
            unit=data.get('unit', 'kg'),
            current_stock=data.get('current_stock') or 0,
            minimum_stock=data.get('minimum_stock') or 0,
            current_cost_per_unit=data.get('current_cost_per_unit') or 0,
            is_active=True,
        )
        return JsonResponse({"id": i.id})

    return JsonResponse({"error": "Method not allowed"}, status=405)


@csrf_exempt
def ingredient_api_detail(request, pk):
    i = get_object_or_404(Ingredient, pk=pk)

    if request.method == 'GET':
        return JsonResponse({
            "id": i.id,
            "name": i.name,
            "category": i.get_category_display() if hasattr(i, 'get_category_display') else i.category,
            "unit": i.unit,
            "current_stock": float(i.current_stock),
            "minimum_stock": float(i.minimum_stock),
            "current_cost_per_unit": float(i.current_cost_per_unit),
        })

    if request.method in ['PUT', 'PATCH']:
        data = json.loads(request.body or '{}')
        for field in ['name','category','unit']:
            if field in data:
                setattr(i, field, data.get(field))
        for field in ['current_stock','minimum_stock','current_cost_per_unit']:
            if field in data:
                setattr(i, field, data.get(field) or 0)
        i.save()
        return JsonResponse({"ok": True})

    if request.method == 'DELETE':
        i.delete()
        return JsonResponse({"ok": True})

    return JsonResponse({"error": "Method not allowed"}, status=405)


class LowStockAPIView(View):
    def get(self, request):
        qs = Ingredient.objects.filter(current_stock__lte=models.F('minimum_stock')).order_by('name')
        items = []
        for i in qs:
            items.append({
                "id": i.id,
                "name": i.name,
                "unit": i.unit,
                "current_stock": float(i.current_stock),
                "minimum_stock": float(i.minimum_stock),
            })
        return JsonResponse({"items": items})


class IngredientUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing ingredient."""
    model = Ingredient
    form_class = IngredientForm
    template_name = 'inventory/ingredient_form.html'
    success_url = reverse_lazy('inventory:ingredient_list')


# Supplier Views
class SupplierListView(LoginRequiredMixin, ListView):
    """Display list of all suppliers."""
    model = Supplier
    template_name = 'inventory/supplier_list.html'
    context_object_name = 'suppliers'
    paginate_by = 20

    def get_queryset(self):
        """Get active suppliers with search capability."""
        queryset = Supplier.objects.filter(is_active=True)

        search_query = self.request.GET.get('search', '')
        if search_query:
            queryset = queryset.filter(
                Q(name__icontains=search_query) |
                Q(email__icontains=search_query) |
                Q(contact_person__icontains=search_query)
            )

        return queryset.order_by('name')

    def get_context_data(self, **kwargs):
        """Add search query to context."""
        context = super().get_context_data(**kwargs)
        context['search_query'] = self.request.GET.get('search', '')
        return context


class SupplierCreateView(LoginRequiredMixin, CreateView):
    """Create a new supplier."""
    model = Supplier
    form_class = SupplierForm
    template_name = 'inventory/supplier_form.html'
    success_url = reverse_lazy('inventory:supplier_list')


class SupplierUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing supplier."""
    model = Supplier
    form_class = SupplierForm
    template_name = 'inventory/supplier_form.html'
    success_url = reverse_lazy('inventory:supplier_list')


# Purchase Order Views
class PurchaseOrderListView(LoginRequiredMixin, ListView):
    """Display list of purchase orders with status filtering."""
    model = PurchaseOrder
    template_name = 'inventory/purchaseorder_list.html'
    context_object_name = 'purchase_orders'
    paginate_by = 20

    def get_queryset(self):
        """Filter purchase orders by status if requested."""
        queryset = PurchaseOrder.objects.all().select_related('supplier')

        status = self.request.GET.get('status', '')
        if status:
            queryset = queryset.filter(status=status)

        return queryset.order_by('-order_date')

    def get_context_data(self, **kwargs):
        """Add status choices to context."""
        context = super().get_context_data(**kwargs)
        context['status_choices'] = PurchaseOrder.STATUS_CHOICES
        context['selected_status'] = self.request.GET.get('status', '')
        return context


class PurchaseOrderCreateView(LoginRequiredMixin, CreateView):
    """Create a new purchase order."""
    model = PurchaseOrder
    form_class = PurchaseOrderForm
    template_name = 'inventory/purchaseorder_form.html'
    success_url = reverse_lazy('inventory:purchaseorder_list')


class PurchaseOrderDetailView(LoginRequiredMixin, DetailView):
    """Display details of a purchase order with its line items."""
    model = PurchaseOrder
    template_name = 'inventory/purchaseorder_detail.html'
    context_object_name = 'purchase_order'

    def get_context_data(self, **kwargs):
        """Add line items and form to context."""
        context = super().get_context_data(**kwargs)
        context['line_items'] = self.object.lines.all()
        context['line_form'] = PurchaseOrderLineForm(
            initial={'purchase_order': self.object}
        )
        return context


class PurchaseOrderUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing purchase order."""
    model = PurchaseOrder
    form_class = PurchaseOrderForm
    template_name = 'inventory/purchaseorder_form.html'

    def get_success_url(self):
        """Redirect to purchase order detail after update."""
        return reverse_lazy('inventory:purchaseorder_detail', kwargs={'pk': self.object.pk})


@login_required
@require_POST
def receive_po_line_view(request, po_line_id):
    """
    Handle receipt of a purchase order line.
    POST parameter: received_quantity (decimal)
    """
    po_line = get_object_or_404(PurchaseOrderLine, pk=po_line_id)

    try:
        received_qty = Decimal(request.POST.get('received_quantity', '0'))
        InventoryService.receive_po_line(po_line, received_qty)

        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return JsonResponse({
                'success': True,
                'message': f'Received {received_qty} units of {po_line.ingredient.name}'
            })

        return redirect('inventory:purchaseorder_detail', pk=po_line.purchase_order.pk)

    except (ValueError, TypeError) as e:
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return JsonResponse({
                'success': False,
                'message': f'Invalid quantity: {str(e)}'
            }, status=400)

        return redirect('inventory:purchaseorder_detail', pk=po_line.purchase_order.pk)

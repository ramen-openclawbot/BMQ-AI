from django.shortcuts import render, redirect, get_object_or_404
from django.views.generic import ListView, CreateView, UpdateView, DetailView
from django.views import View
from django.http import JsonResponse
from django.urls import reverse_lazy
from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Q
from django.http import JsonResponse
from django.views.decorators.http import require_POST
from django.contrib.auth.decorators import login_required
from django.views.decorators.csrf import csrf_exempt
import json
from .models import Product, BillOfMaterials, BOMLineItem
from .forms import (
    ProductForm,
    BillOfMaterialsForm,
    BOMLineItemForm,
    BOMLineItemInlineForm,
)
from .services import ProductService


# Product Views
@csrf_exempt
def products_api(request):
    if request.method == 'GET':
        items = []
        for p in Product.objects.all().order_by('name'):
            items.append({
                "id": p.id,
                "name": p.name,
                "sku_code": p.sku_code,
                "category": p.get_category_display() if hasattr(p, 'get_category_display') else p.category,
                "unit": getattr(p, 'unit', None),
                "selling_price": float(p.selling_price),
                "status": p.status,
            })
        return JsonResponse({"items": items})

    if request.method == 'POST':
        data = json.loads(request.body or '{}')
        p = Product.objects.create(
            sku_code=data.get('sku_code'),
            name=data.get('name'),
            category=data.get('category', 'other'),
            unit=data.get('unit', 'piece'),
            selling_price=data.get('selling_price') or 0,
            status=data.get('status', 'active'),
            description=data.get('description',''),
        )
        return JsonResponse({"id": p.id})

    return JsonResponse({"error": "Method not allowed"}, status=405)


@csrf_exempt
def product_api_detail(request, pk):
    p = get_object_or_404(Product, pk=pk)

    if request.method == 'GET':
        return JsonResponse({
            "id": p.id,
            "name": p.name,
            "sku_code": p.sku_code,
            "category": p.get_category_display() if hasattr(p, 'get_category_display') else p.category,
            "unit": p.unit,
            "selling_price": float(p.selling_price),
            "status": p.status,
        })

    if request.method in ['PUT', 'PATCH']:
        data = json.loads(request.body or '{}')
        for field in ['sku_code','name','category','unit','status','description']:
            if field in data:
                setattr(p, field, data.get(field))
        if 'selling_price' in data:
            p.selling_price = data.get('selling_price') or 0
        p.save()
        return JsonResponse({"ok": True})

    if request.method == 'DELETE':
        p.delete()
        return JsonResponse({"ok": True})

    return JsonResponse({"error": "Method not allowed"}, status=405)


class ProductListView(LoginRequiredMixin, ListView):
    """Display list of all products with search/filter capabilities."""
    model = Product
    template_name = 'products/product_list.html'
    context_object_name = 'products'
    paginate_by = 20

    def get_queryset(self):
        """Filter products based on search and category."""
        queryset = Product.objects.filter(is_active=True)

        search_query = self.request.GET.get('search', '')
        if search_query:
            queryset = queryset.filter(
                Q(sku_code__icontains=search_query) |
                Q(name__icontains=search_query) |
                Q(description__icontains=search_query)
            )

        category = self.request.GET.get('category', '')
        if category:
            queryset = queryset.filter(category=category)

        status = self.request.GET.get('status', '')
        if status:
            queryset = queryset.filter(status=status)

        return queryset.order_by('sku_code')

    def get_context_data(self, **kwargs):
        """Add filter options to context."""
        context = super().get_context_data(**kwargs)
        context['categories'] = Product.CATEGORY_CHOICES
        context['statuses'] = Product.STATUS_CHOICES
        context['search_query'] = self.request.GET.get('search', '')
        context['selected_category'] = self.request.GET.get('category', '')
        context['selected_status'] = self.request.GET.get('status', '')
        return context


class ProductCreateView(LoginRequiredMixin, CreateView):
    """Create a new product."""
    model = Product
    form_class = ProductForm
    template_name = 'products/product_form.html'
    success_url = reverse_lazy('products:product_list')


class ProductUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing product."""
    model = Product
    form_class = ProductForm
    template_name = 'products/product_form.html'
    success_url = reverse_lazy('products:product_list')


class ProductDetailView(LoginRequiredMixin, DetailView):
    """Display details of a product with its BOMs."""
    model = Product
    template_name = 'products/product_detail.html'
    context_object_name = 'product'

    def get_context_data(self, **kwargs):
        """Add BOMs and active BOM to context."""
        context = super().get_context_data(**kwargs)
        context['boms'] = self.object.boms.all().order_by('-version')
        context['active_bom'] = self.object.get_active_bom()
        return context


# Bill of Materials Views
class BOMListView(LoginRequiredMixin, ListView):
    """Display list of all BOMs."""
    model = BillOfMaterials
    template_name = 'products/bom_list.html'
    context_object_name = 'boms'
    paginate_by = 20

    def get_queryset(self):
        """Get BOMs filtered by product and status."""
        queryset = BillOfMaterials.objects.all().select_related('product')

        product_id = self.request.GET.get('product', '')
        if product_id:
            queryset = queryset.filter(product_id=product_id)

        status = self.request.GET.get('status', '')
        if status:
            queryset = queryset.filter(status=status)

        return queryset.order_by('-created_at')

    def get_context_data(self, **kwargs):
        """Add filter options to context."""
        context = super().get_context_data(**kwargs)
        context['products'] = Product.objects.filter(is_active=True)
        context['statuses'] = BillOfMaterials.STATUS_CHOICES
        context['selected_product'] = self.request.GET.get('product', '')
        context['selected_status'] = self.request.GET.get('status', '')
        return context


class BOMDetailView(LoginRequiredMixin, DetailView):
    """Display details of a BOM with its line items."""
    model = BillOfMaterials
    template_name = 'products/bom_detail.html'
    context_object_name = 'bom'

    def get_context_data(self, **kwargs):
        """Add line items and form to context."""
        context = super().get_context_data(**kwargs)
        context['line_items'] = self.object.line_items.all()
        context['line_form'] = BOMLineItemInlineForm()
        context['bom_cost'] = self.object.calculate_bom_cost()
        return context


class BOMCreateView(LoginRequiredMixin, CreateView):
    """Create a new BOM."""
    model = BillOfMaterials
    form_class = BillOfMaterialsForm
    template_name = 'products/bom_form.html'

    def get_success_url(self):
        """Redirect to BOM detail after creation."""
        return reverse_lazy('products:bom_detail', kwargs={'pk': self.object.pk})


class BOMUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing BOM."""
    model = BillOfMaterials
    form_class = BillOfMaterialsForm
    template_name = 'products/bom_form.html'

    def get_success_url(self):
        """Redirect to BOM detail after update."""
        return reverse_lazy('products:bom_detail', kwargs={'pk': self.object.pk})


# BOM Line Item Views
class BOMLineItemCreateView(LoginRequiredMixin, CreateView):
    """Create a new BOM line item."""
    model = BOMLineItem
    form_class = BOMLineItemForm
    template_name = 'products/bomlineitem_form.html'

    def get_success_url(self):
        """Redirect to BOM detail after creation."""
        return reverse_lazy('products:bom_detail', kwargs={'pk': self.object.bom.pk})

    def get_initial(self):
        """Pre-fill BOM if provided in query params."""
        initial = super().get_initial()
        bom_id = self.request.GET.get('bom')
        if bom_id:
            initial['bom'] = bom_id
        return initial


class BOMLineItemUpdateView(LoginRequiredMixin, UpdateView):
    """Update an existing BOM line item."""
    model = BOMLineItem
    form_class = BOMLineItemForm
    template_name = 'products/bomlineitem_form.html'

    def get_success_url(self):
        """Redirect to BOM detail after update."""
        return reverse_lazy('products:bom_detail', kwargs={'pk': self.object.bom.pk})


# BOM Management Views
@login_required
def clone_bom_view(request, pk):
    """
    Clone a BOM to create a new draft version.
    """
    bom = get_object_or_404(BillOfMaterials, pk=pk)
    new_bom = ProductService.create_new_bom_version(bom.product)

    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return JsonResponse({
            'success': True,
            'message': f'New BOM version {new_bom.version} created',
            'bom_id': new_bom.pk,
            'bom_url': reverse_lazy('products:bom_detail', kwargs={'pk': new_bom.pk})
        })

    return redirect('products:bom_detail', pk=new_bom.pk)


@login_required
@require_POST
def activate_bom_view(request, pk):
    """
    Activate a BOM and archive the current active one.
    """
    bom = get_object_or_404(BillOfMaterials, pk=pk)

    try:
        ProductService.activate_bom(bom)

        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return JsonResponse({
                'success': True,
                'message': f'BOM version {bom.version} activated'
            })

        return redirect('products:bom_detail', pk=bom.pk)

    except Exception as e:
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return JsonResponse({
                'success': False,
                'message': f'Error activating BOM: {str(e)}'
            }, status=400)

        return redirect('products:bom_detail', pk=bom.pk)

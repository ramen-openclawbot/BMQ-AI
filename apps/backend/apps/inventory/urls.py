from django.urls import path
from . import views

app_name = 'inventory'

urlpatterns = [
    # Ingredient URLs
    path('ingredients/', views.IngredientListView.as_view(), name='ingredient_list'),
    path('ingredients/api/', views.ingredients_api, name='ingredient_list_api'),
    path('ingredients/api/<int:pk>/', views.ingredient_api_detail, name='ingredient_detail_api'),
    path('ingredients/low-stock/', views.LowStockAPIView.as_view(), name='ingredient_low_stock_api'),
    path('ingredients/create/', views.IngredientCreateView.as_view(), name='ingredient_create'),
    path('ingredients/<int:pk>/edit/', views.IngredientUpdateView.as_view(), name='ingredient_update'),

    # Supplier URLs
    path('suppliers/', views.SupplierListView.as_view(), name='supplier_list'),
    path('suppliers/create/', views.SupplierCreateView.as_view(), name='supplier_create'),
    path('suppliers/<int:pk>/edit/', views.SupplierUpdateView.as_view(), name='supplier_update'),

    # Purchase Order URLs
    path('purchase-orders/', views.PurchaseOrderListView.as_view(), name='purchaseorder_list'),
    path('purchase-orders/create/', views.PurchaseOrderCreateView.as_view(), name='purchaseorder_create'),
    path('purchase-orders/<int:pk>/', views.PurchaseOrderDetailView.as_view(), name='purchaseorder_detail'),
    path('purchase-orders/<int:pk>/edit/', views.PurchaseOrderUpdateView.as_view(), name='purchaseorder_update'),

    # Purchase Order Line URLs
    path('purchase-order-lines/<int:po_line_id>/receive/', views.receive_po_line_view, name='receive_po_line'),
]

from django.urls import path
from . import views

app_name = 'products'

urlpatterns = [
    # Product URLs
    path('', views.ProductListView.as_view(), name='product_list'),
    path('api/', views.products_api, name='product_list_api'),
    path('api/<int:pk>/', views.product_api_detail, name='product_detail_api'),
    path('create/', views.ProductCreateView.as_view(), name='product_create'),
    path('<int:pk>/', views.ProductDetailView.as_view(), name='product_detail'),
    path('<int:pk>/edit/', views.ProductUpdateView.as_view(), name='product_update'),

    # BOM URLs
    path('boms/', views.BOMListView.as_view(), name='bom_list'),
    path('boms/create/', views.BOMCreateView.as_view(), name='bom_create'),
    path('boms/<int:pk>/', views.BOMDetailView.as_view(), name='bom_detail'),
    path('boms/<int:pk>/edit/', views.BOMUpdateView.as_view(), name='bom_update'),
    path('boms/<int:pk>/clone/', views.clone_bom_view, name='bom_clone'),
    path('boms/<int:pk>/activate/', views.activate_bom_view, name='bom_activate'),

    # BOM Line Item URLs
    path('bom-line-items/create/', views.BOMLineItemCreateView.as_view(), name='bomlineitem_create'),
    path('bom-line-items/<int:pk>/edit/', views.BOMLineItemUpdateView.as_view(), name='bomlineitem_update'),
]

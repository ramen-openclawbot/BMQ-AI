from django.urls import path
from . import views

app_name = 'overhead'

urlpatterns = [
    # Overhead Category URLs
    path('categories/', views.OverheadCategoryListView.as_view(), name='category_list'),
    path('categories/new/', views.OverheadCategoryCreateView.as_view(), name='category_create'),
    path('categories/<int:pk>/edit/', views.OverheadCategoryUpdateView.as_view(), name='category_edit'),

    # Overhead Cost URLs
    path('costs/', views.OverheadCostListView.as_view(), name='cost_list'),
    path('costs/api/', views.overhead_costs_api, name='cost_list_api'),
    path('costs/api/<int:pk>/', views.overhead_cost_api_detail, name='cost_detail_api'),
    path('costs/new/', views.OverheadCostCreateView.as_view(), name='cost_create'),
    path('costs/<int:pk>/edit/', views.OverheadCostUpdateView.as_view(), name='cost_edit'),

    # Monthly Overview
    path('monthly-overview/', views.MonthlyOverviewView.as_view(), name='monthly_overview'),

    # Production Volume URLs
    path('production-volumes/', views.MonthlyProductionVolumeListView.as_view(), name='volume_list'),
    path('production-volumes/new/', views.MonthlyProductionVolumeCreateView.as_view(), name='volume_create'),
    path('production-volumes/<int:pk>/edit/', views.MonthlyProductionVolumeUpdateView.as_view(), name='volume_edit'),
]

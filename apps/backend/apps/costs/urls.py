from django.urls import path
from . import views

app_name = 'costs'

urlpatterns = [
    path('', views.CostListView.as_view(), name='cost_list'),
    path('list/', views.CostListAPIView.as_view(), name='cost_list_api'),
    path('cost/<int:pk>/', views.CostDetailView.as_view(), name='cost_detail'),
    path('product/<int:pk>/history/', views.CostHistoryView.as_view(), name='cost_history'),
    path('product/<int:product_id>/trend/', views.CostTrendAPIView.as_view(), name='cost_trend_api'),
    path('product/<int:product_id>/trend-public/', views.CostTrendPublicAPIView.as_view(), name='cost_trend_public_api'),
    path('recent/', views.RecentCostsAPIView.as_view(), name='recent_costs_api'),
    path('export/', views.ExportCSVView.as_view(), name='export_csv'),
    path('recalculate/', views.RecalculateView.as_view(), name='recalculate'),
]

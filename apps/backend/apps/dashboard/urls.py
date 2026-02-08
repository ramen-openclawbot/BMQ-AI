from django.urls import path
from . import views

app_name = 'dashboard'

urlpatterns = [
    path('', views.DashboardHomeView.as_view(), name='home'),
    path('sku-costs/', views.SKUCostDashboardView.as_view(), name='sku_costs'),
    path('trends/', views.CostTrendsView.as_view(), name='trends'),
    path('overhead/', views.OverheadBreakdownView.as_view(), name='overhead'),
]

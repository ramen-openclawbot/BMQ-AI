from django.urls import path
from . import views

app_name = 'labor'

urlpatterns = [
    # Employee URLs
    path('employees/', views.EmployeeListView.as_view(), name='employee_list'),
    path('employees/api/', views.employees_api, name='employee_list_api'),
    path('employees/api/<int:pk>/', views.employee_api_detail, name='employee_detail_api'),
    path('employees/new/', views.EmployeeCreateView.as_view(), name='employee_create'),
    path('employees/<str:employee_id>/', views.EmployeeDetailView.as_view(), name='employee_detail'),
    path('employees/<str:employee_id>/edit/', views.EmployeeUpdateView.as_view(), name='employee_edit'),

    # Production Time URLs
    path('production-times/', views.ProductionTimeListView.as_view(), name='productiontime_list'),
    path('production-times/new/', views.ProductionTimeCreateView.as_view(), name='productiontime_create'),
    path('production-times/<int:pk>/edit/', views.ProductionTimeUpdateView.as_view(), name='productiontime_edit'),
]

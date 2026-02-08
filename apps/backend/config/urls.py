from django.contrib import admin
from django.urls import path, include
from django.views.generic import RedirectView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('accounts/', include('apps.accounts.urls')),

    # Web views (for iframe embedding)
    path('inventory/', include('apps.inventory.urls')),
    path('products/', include('apps.products.urls')),
    path('labor/', include('apps.labor.urls')),
    path('overhead/', include('apps.overhead.urls')),
    path('costs/', include('apps.costs.urls')),

    # API
    path('api/inventory/', include('apps.inventory.urls', namespace='inventory-api')),
    path('api/products/', include('apps.products.urls', namespace='products-api')),
    path('api/labor/', include('apps.labor.urls', namespace='labor-api')),
    path('api/overhead/', include('apps.overhead.urls', namespace='overhead-api')),
    path('api/costs/', include('apps.costs.urls', namespace='costs-api')),

    path('dashboard/', include('apps.dashboard.urls', namespace='dashboard')),
    path('', RedirectView.as_view(url='/dashboard/', permanent=False)),
]

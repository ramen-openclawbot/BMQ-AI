from django.apps import AppConfig


class CostsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.costs'
    label = 'costs'

    def ready(self):
        """Import signals when app is ready."""
        import apps.costs.signals  # noqa: F401

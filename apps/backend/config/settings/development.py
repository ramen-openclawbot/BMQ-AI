from .base import *

DEBUG = True

ALLOWED_HOSTS = ['*']

# Dev-friendly CSRF
CSRF_TRUSTED_ORIGINS = [
    'http://localhost:8000',
    'http://127.0.0.1:8000',
]
CSRF_COOKIE_SECURE = False
CSRF_COOKIE_SAMESITE = 'Lax'

# Allow iframe embedding for local integration
X_FRAME_OPTIONS = 'ALLOWALL'

INSTALLED_APPS += [
]

REST_FRAMEWORK['DEFAULT_PERMISSION_CLASSES'] = [
    'rest_framework.permissions.IsAuthenticated',
]

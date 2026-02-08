from django.db import models


class TimestampedModel(models.Model):
    """Abstract base model that adds created_at and updated_at timestamps."""
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        abstract = True


class ActiveModel(TimestampedModel):
    """Abstract base model that extends TimestampedModel with is_active field."""
    is_active = models.BooleanField(default=True)
    
    class Meta:
        abstract = True

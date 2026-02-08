from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    ROLE_CHOICES = [
        ('owner', 'Owner'),
        ('manager', 'Manager'),
        ('staff', 'Staff'),
    ]
    
    phone = models.CharField(
        max_length=20,
        blank=True,
        null=True,
        help_text='User phone number'
    )
    company_name = models.CharField(
        max_length=255,
        blank=True,
        null=True,
        help_text='Associated company name'
    )
    role = models.CharField(
        max_length=20,
        choices=ROLE_CHOICES,
        default='staff',
        help_text='User role in the system'
    )
    
    class Meta:
        db_table = 'auth_user'
        verbose_name = 'User'
        verbose_name_plural = 'Users'
    
    def __str__(self):
        return f"{self.get_full_name()} ({self.username})"
    
    def is_owner(self):
        return self.role == 'owner'
    
    def is_manager(self):
        return self.role == 'manager'
    
    def is_staff_member(self):
        return self.role == 'staff'

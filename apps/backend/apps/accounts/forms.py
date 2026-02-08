from django import forms
from django.contrib.auth.forms import UserCreationForm as DjangoUserCreationForm
from django.contrib.auth.forms import AuthenticationForm
from .models import User


class UserCreationForm(DjangoUserCreationForm):
    """Extended user creation form with additional fields."""
    email = forms.EmailField(
        required=True,
        help_text='A valid email address.'
    )
    first_name = forms.CharField(
        max_length=150,
        required=True,
        help_text='User first name.'
    )
    last_name = forms.CharField(
        max_length=150,
        required=True,
        help_text='User last name.'
    )
    phone = forms.CharField(
        max_length=20,
        required=False,
        help_text='User phone number (optional).'
    )
    company_name = forms.CharField(
        max_length=255,
        required=False,
        help_text='Associated company name (optional).'
    )
    role = forms.ChoiceField(
        choices=User.ROLE_CHOICES,
        initial='staff',
        help_text='User role in the system.'
    )
    
    class Meta:
        model = User
        fields = ('username', 'email', 'first_name', 'last_name', 'phone', 'company_name', 'role', 'password1', 'password2')
    
    def clean_email(self):
        email = self.cleaned_data.get('email')
        if User.objects.filter(email=email).exists():
            raise forms.ValidationError('A user with this email address already exists.')
        return email
    
    def save(self, commit=True):
        user = super().save(commit=False)
        user.email = self.cleaned_data['email']
        user.first_name = self.cleaned_data['first_name']
        user.last_name = self.cleaned_data['last_name']
        user.phone = self.cleaned_data.get('phone', '')
        user.company_name = self.cleaned_data.get('company_name', '')
        user.role = self.cleaned_data.get('role', 'staff')
        if commit:
            user.save()
        return user


class UserLoginForm(AuthenticationForm):
    """Login form for user authentication."""
    username = forms.CharField(
        max_length=254,
        widget=forms.TextInput(attrs={
            'class': 'form-control',
            'placeholder': 'Username or Email'
        })
    )
    password = forms.CharField(
        widget=forms.PasswordInput(attrs={
            'class': 'form-control',
            'placeholder': 'Password'
        })
    )
    
    class Meta:
        model = User
        fields = ('username', 'password')

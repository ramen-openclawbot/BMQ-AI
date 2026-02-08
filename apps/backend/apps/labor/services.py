from decimal import Decimal
from django.utils import timezone
from django.db.models import Avg, Q
from datetime import date

from .models import Employee, EmployeeWage, ProductionTime, ProductionPhase


class LaborService:
    """Service class for labor cost calculations and related operations."""

    @staticmethod
    def get_current_wage(employee: Employee) -> EmployeeWage:
        """
        Get the most recent active EmployeeWage for an employee.

        Returns the most recent EmployeeWage where effective_date <= today
        and (end_date is null or end_date >= today).

        Args:
            employee: Employee instance

        Returns:
            EmployeeWage instance or None
        """
        today = date.today()
        return employee.wages.filter(
            effective_date__lte=today
        ).filter(
            Q(end_date__isnull=True) | Q(end_date__gte=today)
        ).first()

    @staticmethod
    def get_average_hourly_rate_by_role(role: str) -> Decimal:
        """
        Calculate average fully_loaded_hourly_rate for all active employees with a specific role.

        Args:
            role: Employee role (baker, assistant, decorator, packer, supervisor, other)

        Returns:
            Decimal average fully loaded hourly rate, or Decimal('0') if no employees found
        """
        today = date.today()

        # Get active employees with the given role
        employees = Employee.objects.filter(role=role, is_active=True)

        if not employees.exists():
            return Decimal('0')

        total_rate = Decimal('0')
        count = 0

        for employee in employees:
            current_wage = LaborService.get_current_wage(employee)
            if current_wage:
                total_rate += current_wage.fully_loaded_hourly_rate
                count += 1

        if count == 0:
            return Decimal('0')

        return total_rate / count

    @staticmethod
    def get_active_production_time(product) -> ProductionTime:
        """
        Get the most recent active ProductionTime for a product.

        Args:
            product: Product instance

        Returns:
            ProductionTime instance or None
        """
        return product.production_times.first()

    @staticmethod
    def calculate_labor_cost_per_unit(product) -> Decimal:
        """
        Calculate labor cost per unit of a product.

        Uses active ProductionTime and sums phase costs:
        (duration_minutes / 60) * employees_required * avg_hourly_rate_for_role / batch_size

        Args:
            product: Product instance

        Returns:
            Decimal labor cost per unit
        """
        production_time = LaborService.get_active_production_time(product)

        if not production_time:
            return Decimal('0')

        total_labor_cost = Decimal('0')

        for phase in production_time.phases.all():
            # Calculate cost for this phase
            hours = phase.duration_minutes / 60
            avg_hourly_rate = LaborService.get_average_hourly_rate_by_role(phase.employee_role)
            phase_cost = hours * phase.employees_required * avg_hourly_rate
            total_labor_cost += phase_cost

        # Divide by batch size to get cost per unit
        if production_time.batch_size > 0:
            return total_labor_cost / production_time.batch_size

        return Decimal('0')

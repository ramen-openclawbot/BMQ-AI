from decimal import Decimal
from apps.labor.services import LaborService
from .base import BaseCostCalculator


class LaborCostCalculator(BaseCostCalculator):
    """Calculator for labor costs based on production time and wage rates."""

    def calculate(self, product, **kwargs):
        """
        Calculate total labor cost for a product using production time phases.

        Args:
            product: Product instance
            **kwargs: Unused, for interface compatibility

        Returns:
            tuple: (total_labor_cost_per_unit, components_list)
                  components_list contains dicts with: phase, duration_min, employees,
                  role, hourly_rate, phase_cost, cost_per_unit
        """
        # Get active ProductionTime for the product
        production_time = LaborService.get_active_production_time(product)

        if not production_time:
            return (Decimal('0'), [])

        total_labor_cost = Decimal('0')
        components_list = []

        # Process each production phase
        for phase in production_time.phases.all():
            # Get average hourly rate for this phase's employee role
            hourly_rate = LaborService.get_average_hourly_rate_by_role(phase.employee_role)

            # Calculate phase cost (duration in hours * employees * hourly rate)
            duration_hours = Decimal(phase.duration_minutes) / Decimal('60')
            employees_required = Decimal(phase.employees_required)
            phase_cost = duration_hours * employees_required * hourly_rate

            total_labor_cost += phase_cost

            # Calculate cost per unit by dividing by batch size
            cost_per_unit = phase_cost / production_time.batch_size

            # Create component details
            component = {
                'phase': phase.phase,
                'phase_display': phase.get_phase_display(),
                'duration_min': float(phase.duration_minutes),
                'employees_required': phase.employees_required,
                'employee_role': phase.employee_role,
                'role_display': phase.get_employee_role_display(),
                'hourly_rate': float(hourly_rate),
                'phase_cost': float(phase_cost),
                'cost_per_unit': float(cost_per_unit),
            }
            components_list.append(component)

        # Calculate total cost per unit
        total_cost_per_unit = total_labor_cost / production_time.batch_size

        return (total_cost_per_unit, components_list)

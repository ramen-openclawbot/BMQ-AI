from abc import ABC, abstractmethod
from decimal import Decimal


class BaseCostCalculator(ABC):
    """Abstract base class for cost calculators."""

    @abstractmethod
    def calculate(self, product, **kwargs):
        """
        Calculate cost for a product.

        Args:
            product: Product instance to calculate cost for
            **kwargs: Additional arguments specific to the calculator

        Returns:
            tuple: (total_cost, components_list) where components_list is a list of dicts
        """
        pass

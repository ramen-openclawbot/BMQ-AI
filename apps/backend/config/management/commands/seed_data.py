from django.core.management.base import BaseCommand
from django.utils import timezone
from datetime import date, timedelta
from decimal import Decimal
from apps.inventory.models import Supplier, Ingredient, PurchaseOrder, PurchaseOrderLine
from apps.products.models import Product, BillOfMaterials, BOMLineItem
from apps.labor.models import Employee, EmployeeWage, ProductionTime, ProductionPhase
from apps.overhead.models import OverheadCategory, OverheadCost, MonthlyProductionVolume
from apps.costs.calculators.sku_cost_aggregator import SKUCostAggregator
from apps.accounts.models import User


class Command(BaseCommand):
    help = 'Seeds the database with realistic Vietnamese bakery data'

    def handle(self, *args, **options):
        self.stdout.write(self.style.SUCCESS('Starting seed data creation...'))

        try:
            # Create admin user
            self._create_admin_user()

            # Create suppliers
            suppliers = self._create_suppliers()

            # Create ingredients
            ingredients = self._create_ingredients()

            # Create products
            products = self._create_products()

            # Create BOMs with line items
            self._create_boms(products, ingredients)

            # Create employees
            employees = self._create_employees()

            # Create production times and phases
            self._create_production_times(products, employees)

            # Create overhead categories and costs
            self._create_overhead_data()

            # Create monthly production volume
            self._create_monthly_production_volume()

            # Create purchase orders
            self._create_purchase_orders(suppliers, ingredients)

            # Run SKU cost aggregator
            self._calculate_sku_costs(products)

            # Print summary
            self._print_summary()

            self.stdout.write(self.style.SUCCESS('Seed data created successfully!'))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'Error during seeding: {str(e)}'))
            raise

    def _create_admin_user(self):
        """Create admin superuser."""
        username = 'admin'
        email = 'admin@bmq.vn'
        password = 'admin123'

        if not User.objects.filter(username=username).exists():
            User.objects.create_superuser(
                username=username,
                email=email,
                password=password,
                first_name='BMQ',
                last_name='Admin',
                role='owner'
            )
            self.stdout.write(self.style.SUCCESS(f'✓ Created superuser: {username}'))
        else:
            self.stdout.write(self.style.WARNING(f'✓ Superuser already exists: {username}'))

    def _create_suppliers(self):
        """Create suppliers."""
        suppliers_data = [
            {
                'name': 'Vinamilk Dairy',
                'contact_person': 'Tran Duc Minh',
                'email': 'sales@vinamilk.vn',
                'phone': '028 3823 6888',
                'address': 'Kilometer 9, Hanoi-Haiphong Road, Ha Noi'
            },
            {
                'name': 'Mekong Flour Mill',
                'contact_person': 'Nguyen Van Long',
                'email': 'contact@mekongmill.vn',
                'phone': '028 3911 9999',
                'address': '123 Mekong Road, Ho Chi Minh City'
            },
            {
                'name': 'Saigon Sugar Co.',
                'contact_person': 'Le Thi Thu Huong',
                'email': 'sales@saigonsugar.vn',
                'phone': '028 3847 3333',
                'address': '456 Sugar Street, Ho Chi Minh City'
            },
            {
                'name': 'BMQ Packaging',
                'contact_person': 'Pham Minh Duc',
                'email': 'orders@bmqpkg.vn',
                'phone': '028 3721 5555',
                'address': '789 Packaging Ave, Ho Chi Minh City'
            }
        ]

        suppliers = {}
        for data in suppliers_data:
            supplier, created = Supplier.objects.get_or_create(
                name=data['name'],
                defaults=data
            )
            suppliers[data['name']] = supplier
            action = 'Created' if created else 'Already exists'
            self.stdout.write(f'✓ {action}: {supplier.name}')

        return suppliers

    def _create_ingredients(self):
        """Create ingredients with realistic Vietnamese bakery prices."""
        ingredients_data = [
            # Flour
            {
                'name': 'Bot mi da dung (All-purpose flour)',
                'category': 'flour',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('18000'),
                'minimum_stock': Decimal('50'),
                'current_stock': Decimal('100')
            },
            {
                'name': 'Bot mi lam banh mi (Bread flour)',
                'category': 'flour',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('22000'),
                'minimum_stock': Decimal('50'),
                'current_stock': Decimal('100')
            },
            # Sugar
            {
                'name': 'Duong trang (White sugar)',
                'category': 'sugar',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('25000'),
                'minimum_stock': Decimal('30'),
                'current_stock': Decimal('60')
            },
            {
                'name': 'Duong nau (Brown sugar)',
                'category': 'sugar',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('28000'),
                'minimum_stock': Decimal('20'),
                'current_stock': Decimal('40')
            },
            # Dairy
            {
                'name': 'Bo (Butter)',
                'category': 'dairy',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('180000'),
                'minimum_stock': Decimal('10'),
                'current_stock': Decimal('30')
            },
            {
                'name': 'Sua tuoi (Fresh milk)',
                'category': 'dairy',
                'unit': 'l',
                'current_cost_per_unit': Decimal('32000'),
                'minimum_stock': Decimal('20'),
                'current_stock': Decimal('50')
            },
            {
                'name': 'Kem tuoi (Heavy cream)',
                'category': 'dairy',
                'unit': 'l',
                'current_cost_per_unit': Decimal('120000'),
                'minimum_stock': Decimal('5'),
                'current_stock': Decimal('15')
            },
            {
                'name': 'Pho mai (Cheese)',
                'category': 'dairy',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('250000'),
                'minimum_stock': Decimal('5'),
                'current_stock': Decimal('10')
            },
            # Eggs
            {
                'name': 'Trung ga (Eggs)',
                'category': 'eggs',
                'unit': 'piece',
                'current_cost_per_unit': Decimal('3500'),
                'minimum_stock': Decimal('200'),
                'current_stock': Decimal('500')
            },
            # Oils & Fats
            {
                'name': 'Dau an (Cooking oil)',
                'category': 'oils_fats',
                'unit': 'l',
                'current_cost_per_unit': Decimal('45000'),
                'minimum_stock': Decimal('10'),
                'current_stock': Decimal('30')
            },
            # Leavening
            {
                'name': 'Men (Yeast)',
                'category': 'leavening',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('85000'),
                'minimum_stock': Decimal('2'),
                'current_stock': Decimal('5')
            },
            {
                'name': 'Bot no (Baking powder)',
                'category': 'leavening',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('65000'),
                'minimum_stock': Decimal('2'),
                'current_stock': Decimal('5')
            },
            # Flavoring
            {
                'name': 'Vani (Vanilla extract)',
                'category': 'flavoring',
                'unit': 'l',
                'current_cost_per_unit': Decimal('350000'),
                'minimum_stock': Decimal('1'),
                'current_stock': Decimal('3')
            },
            {
                'name': 'Muoi (Salt)',
                'category': 'flavoring',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('8000'),
                'minimum_stock': Decimal('5'),
                'current_stock': Decimal('10')
            },
            {
                'name': 'Cacao (Cocoa powder)',
                'category': 'flavoring',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('180000'),
                'minimum_stock': Decimal('2'),
                'current_stock': Decimal('5')
            },
            # Chocolate
            {
                'name': 'Chocolate (Chocolate chips)',
                'category': 'chocolate',
                'unit': 'kg',
                'current_cost_per_unit': Decimal('280000'),
                'minimum_stock': Decimal('3'),
                'current_stock': Decimal('10')
            },
            # Packaging
            {
                'name': 'Hop banh (Cake boxes)',
                'category': 'packaging',
                'unit': 'piece',
                'current_cost_per_unit': Decimal('5000'),
                'minimum_stock': Decimal('100'),
                'current_stock': Decimal('500')
            },
            {
                'name': 'Tui giay (Paper bags)',
                'category': 'packaging',
                'unit': 'piece',
                'current_cost_per_unit': Decimal('1500'),
                'minimum_stock': Decimal('200'),
                'current_stock': Decimal('1000')
            }
        ]

        ingredients = {}
        for data in ingredients_data:
            ingredient, created = Ingredient.objects.get_or_create(
                name=data['name'],
                defaults=data
            )
            ingredients[data['name']] = ingredient
            action = 'Created' if created else 'Already exists'
            self.stdout.write(f'✓ {action}: {ingredient.name}')

        return ingredients

    def _create_products(self):
        """Create bakery products."""
        products_data = [
            {
                'sku_code': 'SKU-001',
                'name': 'Banh Mi (Vietnamese Baguette)',
                'category': 'bread',
                'unit': 'piece',
                'selling_price': Decimal('15000'),
                'yield_percentage': Decimal('100')
            },
            {
                'sku_code': 'SKU-002',
                'name': 'Banh Croissant (Croissant)',
                'category': 'pastry',
                'unit': 'piece',
                'selling_price': Decimal('25000'),
                'yield_percentage': Decimal('100')
            },
            {
                'sku_code': 'SKU-003',
                'name': 'Banh Bong Lan (Sponge Cake)',
                'category': 'cake',
                'unit': 'piece',
                'selling_price': Decimal('180000'),
                'yield_percentage': Decimal('100')
            },
            {
                'sku_code': 'SKU-004',
                'name': 'Banh Cookie Socola (Chocolate Chip Cookie)',
                'category': 'cookie',
                'unit': 'piece',
                'selling_price': Decimal('8000'),
                'yield_percentage': Decimal('100')
            },
            {
                'sku_code': 'SKU-005',
                'name': 'Banh Pho Mai (Cheesecake)',
                'category': 'cake',
                'unit': 'piece',
                'selling_price': Decimal('350000'),
                'yield_percentage': Decimal('100')
            }
        ]

        products = {}
        for data in products_data:
            product, created = Product.objects.get_or_create(
                sku_code=data['sku_code'],
                defaults=data
            )
            products[data['sku_code']] = product
            action = 'Created' if created else 'Already exists'
            self.stdout.write(f'✓ {action}: {product.sku_code} - {product.name}')

        return products

    def _create_boms(self, products, ingredients):
        """Create Bills of Materials with line items."""
        bom_data = {
            'SKU-001': {  # Banh Mi
                'batch_size': 20,
                'items': [
                    ('Bot mi lam banh mi (Bread flour)', Decimal('0.15'), Decimal('2')),
                    ('Men (Yeast)', Decimal('0.003'), Decimal('0')),
                    ('Muoi (Salt)', Decimal('0.003'), Decimal('0')),
                    ('Duong trang (White sugar)', Decimal('0.005'), Decimal('0')),
                    ('Dau an (Cooking oil)', Decimal('0.01'), Decimal('0')),
                    ('Tui giay (Paper bags)', Decimal('1'), Decimal('0')),
                ]
            },
            'SKU-002': {  # Banh Croissant
                'batch_size': 12,
                'items': [
                    ('Bot mi da dung (All-purpose flour)', Decimal('0.08'), Decimal('3')),
                    ('Bo (Butter)', Decimal('0.06'), Decimal('5')),
                    ('Duong trang (White sugar)', Decimal('0.01'), Decimal('0')),
                    ('Men (Yeast)', Decimal('0.002'), Decimal('0')),
                    ('Sua tuoi (Fresh milk)', Decimal('0.03'), Decimal('0')),
                    ('Trung ga (Eggs)', Decimal('0.5'), Decimal('0')),
                    ('Muoi (Salt)', Decimal('0.001'), Decimal('0')),
                ]
            },
            'SKU-003': {  # Banh Bong Lan
                'batch_size': 4,
                'items': [
                    ('Bot mi da dung (All-purpose flour)', Decimal('0.2'), Decimal('2')),
                    ('Duong trang (White sugar)', Decimal('0.2'), Decimal('0')),
                    ('Trung ga (Eggs)', Decimal('5'), Decimal('0')),
                    ('Bo (Butter)', Decimal('0.1'), Decimal('0')),
                    ('Sua tuoi (Fresh milk)', Decimal('0.1'), Decimal('0')),
                    ('Vani (Vanilla extract)', Decimal('0.005'), Decimal('0')),
                    ('Bot no (Baking powder)', Decimal('0.008'), Decimal('0')),
                    ('Hop banh (Cake boxes)', Decimal('1'), Decimal('0')),
                ]
            },
            'SKU-004': {  # Banh Cookie Socola
                'batch_size': 1,
                'items': [
                    ('Bot mi da dung (All-purpose flour)', Decimal('0.025'), Decimal('1')),
                    ('Bo (Butter)', Decimal('0.015'), Decimal('0')),
                    ('Duong trang (White sugar)', Decimal('0.012'), Decimal('0')),
                    ('Duong nau (Brown sugar)', Decimal('0.01'), Decimal('0')),
                    ('Trung ga (Eggs)', Decimal('0.1'), Decimal('0')),
                    ('Chocolate (Chocolate chips)', Decimal('0.015'), Decimal('0')),
                    ('Vani (Vanilla extract)', Decimal('0.001'), Decimal('0')),
                    ('Bot no (Baking powder)', Decimal('0.001'), Decimal('0')),
                ]
            },
            'SKU-005': {  # Banh Pho Mai
                'batch_size': 1,
                'items': [
                    ('Bot mi da dung (All-purpose flour)', Decimal('0.1'), Decimal('0')),
                    ('Bo (Butter)', Decimal('0.08'), Decimal('0')),
                    ('Pho mai (Cheese)', Decimal('0.5'), Decimal('0')),
                    ('Duong trang (White sugar)', Decimal('0.15'), Decimal('0')),
                    ('Trung ga (Eggs)', Decimal('4'), Decimal('0')),
                    ('Kem tuoi (Heavy cream)', Decimal('0.2'), Decimal('0')),
                    ('Vani (Vanilla extract)', Decimal('0.005'), Decimal('0')),
                    ('Hop banh (Cake boxes)', Decimal('1'), Decimal('0')),
                ]
            }
        }

        for sku_code, bom_info in bom_data.items():
            product = products[sku_code]

            # Create BOM
            bom, created = BillOfMaterials.objects.get_or_create(
                product=product,
                version=1,
                defaults={
                    'status': 'active',
                    'effective_date': date.today(),
                    'notes': f'Initial BOM for {product.name}'
                }
            )

            if created:
                # Create line items
                for ingredient_name, quantity, waste_pct in bom_info['items']:
                    ingredient = ingredients[ingredient_name]
                    BOMLineItem.objects.get_or_create(
                        bom=bom,
                        ingredient=ingredient,
                        defaults={
                            'quantity_per_unit': quantity,
                            'waste_percentage': waste_pct
                        }
                    )
                self.stdout.write(f'✓ Created BOM for {sku_code}')
            else:
                self.stdout.write(f'✓ BOM already exists for {sku_code}')

    def _create_employees(self):
        """Create employees."""
        employees_data = [
            {
                'employee_id': 'EMP-001',
                'name': 'Nguyen Van Minh',
                'role': 'baker',
                'hire_date': date(2020, 1, 15),
                'wage_base_rate': Decimal('50000'),
                'wage_benefits': Decimal('1.25')
            },
            {
                'employee_id': 'EMP-002',
                'name': 'Tran Thi Lan',
                'role': 'baker',
                'hire_date': date(2019, 6, 1),
                'wage_base_rate': Decimal('48000'),
                'wage_benefits': Decimal('1.25')
            },
            {
                'employee_id': 'EMP-003',
                'name': 'Le Hoang Nam',
                'role': 'assistant',
                'hire_date': date(2021, 3, 15),
                'wage_base_rate': Decimal('35000'),
                'wage_benefits': Decimal('1.20')
            },
            {
                'employee_id': 'EMP-004',
                'name': 'Pham Thu Ha',
                'role': 'decorator',
                'hire_date': date(2018, 9, 1),
                'wage_base_rate': Decimal('55000'),
                'wage_benefits': Decimal('1.25')
            },
            {
                'employee_id': 'EMP-005',
                'name': 'Vo Duc Tai',
                'role': 'packer',
                'hire_date': date(2021, 11, 15),
                'wage_base_rate': Decimal('30000'),
                'wage_benefits': Decimal('1.20')
            }
        ]

        employees = {}
        for data in employees_data:
            wage_data = {
                'base_rate': data.pop('wage_base_rate'),
                'benefits_multiplier': data.pop('wage_benefits')
            }

            employee, created = Employee.objects.get_or_create(
                employee_id=data['employee_id'],
                defaults=data
            )

            # Create wage record
            EmployeeWage.objects.get_or_create(
                employee=employee,
                effective_date=date.today(),
                defaults={
                    'wage_type': 'hourly',
                    **wage_data
                }
            )

            employees[data['employee_id']] = employee
            action = 'Created' if created else 'Already exists'
            self.stdout.write(f'✓ {action}: {employee.employee_id} - {employee.name}')

        return employees

    def _create_production_times(self, products, employees):
        """Create production times and phases."""
        production_data = {
            'SKU-001': {  # Banh Mi
                'total_time_minutes': Decimal('130'),
                'batch_size': 20,
                'phases': [
                    ('mixing', Decimal('15'), 1, 'baker'),
                    ('shaping', Decimal('20'), 2, 'baker'),
                    ('proofing', Decimal('60'), 0, 'baker'),
                    ('baking', Decimal('25'), 1, 'baker'),
                    ('packaging', Decimal('10'), 1, 'packer'),
                ]
            },
            'SKU-002': {  # Banh Croissant
                'total_time_minutes': Decimal('168'),
                'batch_size': 12,
                'phases': [
                    ('mixing', Decimal('20'), 1, 'baker'),
                    ('shaping', Decimal('30'), 2, 'baker'),
                    ('proofing', Decimal('90'), 0, 'baker'),
                    ('baking', Decimal('18'), 1, 'baker'),
                    ('packaging', Decimal('10'), 1, 'packer'),
                ]
            },
            'SKU-003': {  # Banh Bong Lan
                'total_time_minutes': Decimal('105'),
                'batch_size': 4,
                'phases': [
                    ('mixing', Decimal('15'), 1, 'baker'),
                    ('baking', Decimal('35'), 1, 'baker'),
                    ('cooling', Decimal('30'), 0, 'baker'),
                    ('decorating', Decimal('20'), 1, 'decorator'),
                    ('packaging', Decimal('5'), 1, 'packer'),
                ]
            },
            'SKU-004': {  # Banh Cookie Socola
                'total_time_minutes': Decimal('45'),
                'batch_size': 1,
                'phases': [
                    ('mixing', Decimal('10'), 1, 'baker'),
                    ('baking', Decimal('12'), 1, 'baker'),
                    ('cooling', Decimal('15'), 0, 'baker'),
                    ('packaging', Decimal('8'), 1, 'packer'),
                ]
            },
            'SKU-005': {  # Banh Pho Mai
                'total_time_minutes': Decimal('120'),
                'batch_size': 1,
                'phases': [
                    ('mixing', Decimal('20'), 1, 'baker'),
                    ('baking', Decimal('50'), 1, 'baker'),
                    ('cooling', Decimal('30'), 0, 'baker'),
                    ('decorating', Decimal('15'), 1, 'decorator'),
                    ('packaging', Decimal('5'), 1, 'packer'),
                ]
            }
        }

        for sku_code, prod_data in production_data.items():
            product = products[sku_code]

            prod_time, created = ProductionTime.objects.get_or_create(
                product=product,
                version=1,
                defaults={
                    'total_time_minutes': prod_data['total_time_minutes'],
                    'batch_size': prod_data['batch_size'],
                    'effective_date': date.today(),
                    'notes': f'Initial production time for {product.name}'
                }
            )

            if created:
                # Create phases
                for phase_name, duration, employees_required, role in prod_data['phases']:
                    if employees_required > 0:
                        ProductionPhase.objects.get_or_create(
                            production_time=prod_time,
                            phase=phase_name,
                            defaults={
                                'duration_minutes': duration,
                                'employees_required': employees_required,
                                'employee_role': role
                            }
                        )
                self.stdout.write(f'✓ Created production time for {sku_code}')
            else:
                self.stdout.write(f'✓ Production time already exists for {sku_code}')

    def _create_overhead_data(self):
        """Create overhead categories and costs."""
        overhead_categories = [
            {
                'name': 'Tien thue mat bang (Rent)',
                'allocation_method': 'per_unit_produced',
                'amount': Decimal('30000000')
            },
            {
                'name': 'Dien nuoc (Utilities)',
                'allocation_method': 'per_unit_produced',
                'amount': Decimal('8000000')
            },
            {
                'name': 'Bao tri thiet bi (Equipment Maintenance)',
                'allocation_method': 'percentage_of_prime_cost',
                'allocation_percentage': Decimal('5'),
                'amount': None
            },
            {
                'name': 'Chi phi khac (Other expenses)',
                'allocation_method': 'per_unit_produced',
                'amount': Decimal('5000000')
            }
        ]

        current_month = date.today().month
        current_year = date.today().year

        for cat_data in overhead_categories:
            amount = cat_data.pop('amount')
            allocation_pct = cat_data.pop('allocation_percentage', Decimal('0'))

            category, created = OverheadCategory.objects.get_or_create(
                name=cat_data['name'],
                defaults={**cat_data, 'allocation_percentage': allocation_pct}
            )

            # Create overhead cost record
            if amount:
                OverheadCost.objects.get_or_create(
                    category=category,
                    month=current_month,
                    year=current_year,
                    defaults={'amount': amount}
                )

            action = 'Created' if created else 'Already exists'
            self.stdout.write(f'✓ {action}: {category.name}')

    def _create_monthly_production_volume(self):
        """Create monthly production volume."""
        current_month = date.today().month
        current_year = date.today().year

        volume, created = MonthlyProductionVolume.objects.get_or_create(
            month=current_month,
            year=current_year,
            defaults={
                'total_units_produced': Decimal('15000'),
                'notes': 'Current month production volume'
            }
        )

        action = 'Created' if created else 'Already exists'
        self.stdout.write(f'✓ {action}: Monthly production volume')

    def _create_purchase_orders(self, suppliers, ingredients):
        """Create sample purchase orders."""
        po_data = [
            {
                'po_number': 'PO-2025-001',
                'supplier': 'Mekong Flour Mill',
                'status': 'received',
                'order_date': date.today() - timedelta(days=30),
                'expected_delivery_date': date.today() - timedelta(days=25),
                'lines': [
                    ('Bot mi da dung (All-purpose flour)', Decimal('100'), Decimal('18500')),
                    ('Bot mi lam banh mi (Bread flour)', Decimal('100'), Decimal('22500')),
                ]
            },
            {
                'po_number': 'PO-2025-002',
                'supplier': 'Vinamilk Dairy',
                'status': 'received',
                'order_date': date.today() - timedelta(days=15),
                'expected_delivery_date': date.today() - timedelta(days=10),
                'lines': [
                    ('Sua tuoi (Fresh milk)', Decimal('50'), Decimal('32500')),
                    ('Bo (Butter)', Decimal('20'), Decimal('185000')),
                ]
            },
            {
                'po_number': 'PO-2025-003',
                'supplier': 'Saigon Sugar Co.',
                'status': 'confirmed',
                'order_date': date.today(),
                'expected_delivery_date': date.today() + timedelta(days=5),
                'lines': [
                    ('Duong trang (White sugar)', Decimal('50'), Decimal('25500')),
                    ('Duong nau (Brown sugar)', Decimal('30'), Decimal('28500')),
                ]
            }
        ]

        for po_info in po_data:
            supplier = suppliers[po_info['supplier']]

            po, created = PurchaseOrder.objects.get_or_create(
                po_number=po_info['po_number'],
                defaults={
                    'supplier': supplier,
                    'status': po_info['status'],
                    'order_date': po_info['order_date'],
                    'expected_delivery_date': po_info['expected_delivery_date'],
                    'total_amount': Decimal('0')
                }
            )

            if created:
                # Create line items and calculate total
                total_amount = Decimal('0')
                for ingredient_name, quantity, unit_price in po_info['lines']:
                    ingredient = ingredients[ingredient_name]
                    line = PurchaseOrderLine.objects.create(
                        purchase_order=po,
                        ingredient=ingredient,
                        quantity=quantity,
                        unit_price=unit_price
                    )
                    total_amount += line.line_total
                    if po_info['status'] == 'received':
                        line.received_quantity = quantity
                        line.save()

                po.total_amount = total_amount
                po.save()

                self.stdout.write(f'✓ Created PO: {po.po_number}')
            else:
                self.stdout.write(f'✓ PO already exists: {po_info["po_number"]}')

    def _calculate_sku_costs(self, products):
        """Calculate SKU costs for all products."""
        aggregator = SKUCostAggregator()

        for sku_code, product in products.items():
            try:
                sku_cost = aggregator.calculate_sku_cost(
                    product,
                    calculated_by='seed_data',
                    notes='Initial cost calculation from seed data'
                )
                self.stdout.write(f'✓ Calculated SKU cost for {sku_code}')
            except Exception as e:
                self.stdout.write(
                    self.style.WARNING(f'⚠ Could not calculate cost for {sku_code}: {str(e)}')
                )

    def _print_summary(self):
        """Print summary of created data."""
        self.stdout.write('\n' + self.style.SUCCESS('='*60))
        self.stdout.write(self.style.SUCCESS('SEED DATA SUMMARY'))
        self.stdout.write(self.style.SUCCESS('='*60))

        from apps.inventory.models import Supplier, Ingredient, PurchaseOrder
        from apps.products.models import Product
        from apps.labor.models import Employee
        from apps.overhead.models import OverheadCategory

        summary = {
            'Suppliers': Supplier.objects.count(),
            'Ingredients': Ingredient.objects.count(),
            'Products': Product.objects.count(),
            'Purchase Orders': PurchaseOrder.objects.count(),
            'Employees': Employee.objects.count(),
            'Overhead Categories': OverheadCategory.objects.count(),
        }

        for name, count in summary.items():
            self.stdout.write(f'{name}: {count}')

        self.stdout.write(self.style.SUCCESS('='*60))
        self.stdout.write(self.style.SUCCESS('Admin user: admin / admin123'))
        self.stdout.write(self.style.SUCCESS('='*60 + '\n'))

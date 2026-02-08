# BMQ AI SKU - Vietnamese Bakery Cost Management System

A comprehensive Django-based cost management and accounting system designed specifically for Vietnamese bakery operations. This application helps manage SKU (Stock Keeping Unit) costs, labor, overhead, and ingredients while providing detailed cost analysis and production tracking.

## Features

- **SKU Cost Management**: Calculate and track detailed costs for each bakery product including ingredients, labor, and overhead
- **Bill of Materials (BOM)**: Define and manage product recipes with ingredient quantities and waste percentages
- **Labor Costing**: Track employee wages, benefits, and production time allocation across different production phases
- **Overhead Allocation**: Manage overhead costs using multiple allocation methods (per unit, percentage of prime cost, direct assignment)
- **Inventory Management**: Track ingredients, suppliers, and purchase orders with historical price tracking
- **Production Planning**: Define production processes, batch sizes, and labor requirements for each product
- **Cost Analysis**: Generate reports comparing ingredient, labor, and overhead costs with inflation tracking
- **Multi-language Support**: Built with Vietnamese bakery terminology and local pricing conventions

## Tech Stack

- **Backend Framework**: Django 4.2+
- **Database**: PostgreSQL / SQLite (configurable)
- **ORM**: Django ORM with custom managers
- **API**: Django REST Framework
- **Frontend**: HTML/CSS with Django Templates
- **Task Queue**: Celery (optional, for async cost calculations)
- **Testing**: pytest-django
- **Environment Management**: python-decouple

## Quick Start

### Prerequisites

- Python 3.10+
- pip and virtualenv
- PostgreSQL (optional, SQLite works for development)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd bmq_ai_sku
   ```

2. **Create and activate virtual environment**
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your database credentials and settings
   ```

5. **Run migrations**
   ```bash
   python manage.py migrate
   ```

6. **Seed database with sample data**
   ```bash
   python manage.py seed_data
   ```
   This creates:
   - Admin superuser (username: `admin`, password: `admin123`)
   - 4 Vietnamese suppliers (Vinamilk, Mekong Flour Mill, Saigon Sugar, BMQ Packaging)
   - 18 ingredients with realistic Vietnamese pricing
   - 5 bakery products (Baguette, Croissant, Sponge Cake, Cookie, Cheesecake)
   - Bills of Materials with detailed recipes
   - 5 employees with wage information
   - Production time schedules with labor phases
   - Overhead categories and costs
   - Sample purchase orders

7. **Create superuser (if not using seed data)**
   ```bash
   python manage.py createsuperuser
   ```

8. **Run development server**
   ```bash
   python manage.py runserver
   ```

9. **Access the application**
   - Admin interface: http://localhost:8000/admin
   - Dashboard: http://localhost:8000/dashboard (after login)

## Project Structure

```
bmq_ai_sku/
├── config/                           # Django settings and configuration
│   ├── settings/
│   │   ├── base.py                  # Common settings
│   │   ├── development.py           # Development environment settings
│   │   └── __init__.py
│   ├── urls.py                      # Root URL configuration
│   ├── wsgi.py                      # WSGI application
│   └── asgi.py                      # ASGI application
│
├── apps/                            # Django applications
│   ├── accounts/                    # User authentication and management
│   │   ├── models.py               # Custom User model with roles
│   │   ├── views.py
│   │   ├── urls.py
│   │   └── templates/
│   │
│   ├── core/                        # Core utilities and base models
│   │   ├── models.py               # TimestampedModel, ActiveModel
│   │   └── managers.py
│   │
│   ├── inventory/                   # Ingredient and supplier management
│   │   ├── models.py               # Supplier, Ingredient, PurchaseOrder
│   │   ├── admin.py
│   │   ├── views.py
│   │   ├── serializers.py
│   │   └── urls.py
│   │
│   ├── products/                    # Product and BOM management
│   │   ├── models.py               # Product, BillOfMaterials, BOMLineItem
│   │   ├── admin.py
│   │   ├── views.py
│   │   ├── serializers.py
│   │   └── urls.py
│   │
│   ├── labor/                       # Employee and production management
│   │   ├── models.py               # Employee, EmployeeWage, ProductionTime, ProductionPhase
│   │   ├── admin.py
│   │   ├── views.py
│   │   ├── serializers.py
│   │   └── urls.py
│   │
│   ├── overhead/                    # Overhead cost management
│   │   ├── models.py               # OverheadCategory, OverheadCost, MonthlyProductionVolume
│   │   ├── admin.py
│   │   ├── views.py
│   │   ├── serializers.py
│   │   └── urls.py
│   │
│   ├── costs/                       # Cost calculation and analysis
│   │   ├── models.py               # SKUCost, CostComponent, InflationTracking
│   │   ├── admin.py
│   │   ├── views.py
│   │   ├── serializers.py
│   │   ├── urls.py
│   │   ├── signals.py              # Cost update triggers
│   │   ├── calculators/
│   │   │   ├── __init__.py
│   │   │   ├── ingredient_cost_calculator.py
│   │   │   ├── labor_cost_calculator.py
│   │   │   ├── overhead_cost_calculator.py
│   │   │   └── sku_cost_aggregator.py  # Main cost orchestrator
│   │   └── services.py
│   │
│   └── dashboard/                   # Dashboard and analytics
│       ├── views.py
│       ├── urls.py
│       └── templates/
│
├── management/
│   └── commands/
│       └── seed_data.py             # Database seeding command
│
├── templates/                       # HTML templates
├── static/                          # Static files (CSS, JS, images)
├── manage.py                        # Django management script
├── requirements.txt                 # Project dependencies
└── README.md                        # This file
```

## API Endpoints Summary

### Products
- `GET /api/products/` - List all products
- `POST /api/products/` - Create new product
- `GET /api/products/{id}/` - Get product details
- `PATCH /api/products/{id}/` - Update product
- `GET /api/products/{id}/costs/` - Get product costs

### Ingredients
- `GET /api/ingredients/` - List all ingredients
- `POST /api/ingredients/` - Create new ingredient
- `GET /api/ingredients/{id}/price-history/` - Get price history
- `PATCH /api/ingredients/{id}/` - Update ingredient price

### Employees
- `GET /api/employees/` - List all employees
- `POST /api/employees/` - Create new employee
- `GET /api/employees/{id}/wages/` - Get wage history
- `POST /api/employees/{id}/wages/` - Add wage record

### Suppliers
- `GET /api/suppliers/` - List all suppliers
- `POST /api/suppliers/` - Create new supplier
- `GET /api/suppliers/{id}/purchase-orders/` - Get supplier's POs

### Purchase Orders
- `GET /api/purchase-orders/` - List all purchase orders
- `POST /api/purchase-orders/` - Create new PO
- `PATCH /api/purchase-orders/{id}/` - Update PO status
- `POST /api/purchase-orders/{id}/receive/` - Receive PO items

### Costs
- `GET /api/sku-costs/` - List all SKU costs
- `GET /api/sku-costs/{id}/` - Get cost details with components
- `POST /api/sku-costs/calculate/` - Trigger cost calculation
- `GET /api/sku-costs/{id}/inflation-tracking/` - Get cost changes

## Cost Calculation Methodology

The BMQ AI SKU system calculates product costs using a three-component approach:

### 1. Ingredient Cost

**Formula:**
```
Ingredient Cost = Sum of (Ingredient Quantity × Ingredient Unit Cost)
```

Each ingredient in the Bill of Materials (BOM) is multiplied by its current unit cost. Waste percentages are factored in to calculate the effective quantity needed.

**Example (Banh Mi - Vietnamese Baguette):**
- Bread flour: 0.15 kg @ 22,000 VND/kg = 3,300 VND
- Yeast: 0.003 kg @ 85,000 VND/kg = 255 VND
- Salt: 0.003 kg @ 8,000 VND/kg = 24 VND
- Total Ingredient Cost = ~3,700 VND per piece

### 2. Labor Cost

**Formula:**
```
Labor Cost = Sum of (Production Phase Duration × Employees Required × Hourly Rate with Benefits)
```

Labor costs are calculated based on:
- Production phases defined for the product
- Hourly wage rates with benefits multiplier
- Duration of each production phase
- Number of employees required per phase

**Calculation Steps:**
1. Get employee wage and benefits multiplier
2. Convert monthly salary to hourly rate (22 working days × 8 hours/day = 176 hours/month)
3. Apply benefits multiplier for fully-loaded rate
4. Multiply by phase duration and number of employees
5. Allocate per unit based on batch size

**Example (Banh Mi batch of 20):**
- Mixing: 15 min × 1 baker @ 318.18 VND/min = 4,773 VND
- Shaping: 20 min × 2 bakers @ 318.18 VND/min = 12,727 VND
- Total Phase Labor: 130 min
- Labor Cost per piece = Total Labor Cost / 20 pieces

### 3. Overhead Cost

**Formula:**
```
Overhead Cost = Allocated Overhead / Total Production Volume
```

Overhead is allocated using one of three methods:

1. **Per Unit Produced**: Fixed cost divided by monthly production units
   - Rent, Utilities, Other expenses use this method
   - Monthly Rent: 30,000,000 VND ÷ 15,000 units = 2,000 VND per unit

2. **Percentage of Prime Cost**: Applied as percentage of (Ingredient + Labor)
   - Equipment Maintenance: 5% of prime cost
   - If prime cost = 5,000 VND, overhead = 250 VND

3. **Direct Assignment**: Fixed allocation per product (rarely used)

**Example Monthly Overhead (assuming 15,000 total units):**
- Rent: 30,000,000 VND ÷ 15,000 = 2,000 VND/unit
- Utilities: 8,000,000 VND ÷ 15,000 = 533 VND/unit
- Maintenance: 5% of prime cost = varies by product
- Other: 5,000,000 VND ÷ 15,000 = 333 VND/unit

### 4. Total Cost Per Unit

**Formula:**
```
Total Cost = Ingredient Cost + Labor Cost + Overhead Cost
```

This represents the full cost to produce one unit of the product, including all materials, labor, and proportional overhead allocation.

### 5. Profit Margin Calculation

**Formula:**
```
Margin = Selling Price - Total Cost
Margin % = (Margin / Selling Price) × 100
```

Example (Banh Mi):
- Selling Price: 15,000 VND
- Total Cost: ~6,000 VND (estimated)
- Margin: 9,000 VND (60% margin)

### 6. Inflation Tracking

When costs are recalculated, the system tracks changes:
- Absolute change in each cost component
- Percentage change from previous calculation
- Identifies cost drivers (ingredient vs labor vs overhead inflation)

This information helps with:
- Price adjustment decisions
- Cost trend analysis
- Supplier and process optimization

## Database Models

### Core Models

**Supplier**
- Tracks bakery ingredient suppliers with contact information
- Relations: Multiple purchase orders

**Ingredient**
- Stores ingredient details, current cost, and stock levels
- Categories: flour, sugar, dairy, eggs, oils_fats, leavening, flavoring, chocolate, packaging
- Relations: Price history, BOM line items, purchase order lines

**Product**
- Represents bakery products with selling prices
- Categories: bread, pastry, cake, cookie, pie
- Relations: BOMs, costs, production times

**Employee**
- Stores employee information and role
- Roles: baker, assistant, decorator, packer, supervisor
- Relations: Wage history, production phases

### Cost Calculation Models

**BillOfMaterials (BOM)**
- Defines product recipes with version control
- Status: draft, active, archived
- Relations: Line items, product

**BOMLineItem**
- Individual ingredients in a BOM with quantities and waste percentages
- Includes waste percentage to account for material loss

**ProductionTime**
- Batch size and total time to produce a batch
- Relations: Production phases

**ProductionPhase**
- Individual production steps (mixing, baking, decorating, etc.)
- Specifies required labor and duration

**SKUCost**
- Final cost calculation per product
- Stores ingredient, labor, overhead, and total costs
- Version controlled with status tracking

**CostComponent**
- Breakdown of individual cost items within an SKU cost
- Tracks percentage contribution to total cost

**InflationTracking**
- Compares consecutive cost calculations
- Identifies cost changes and trends

## Management Commands

### seed_data
Populates the database with realistic Vietnamese bakery data for development and testing.

```bash
python manage.py seed_data
```

**Creates:**
- 4 suppliers
- 18 ingredients with VND pricing
- 5 bakery products
- Bills of Materials with recipes
- 5 employees with wages
- Production schedules
- Overhead categories
- Monthly production volume
- Sample purchase orders
- Initial SKU cost calculations
- Admin user (username: admin, password: admin123)

The command is idempotent - running it multiple times won't create duplicates.

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
DEBUG=True
SECRET_KEY=your-secret-key-here
ALLOWED_HOSTS=localhost,127.0.0.1

# Database
DATABASE_URL=sqlite:///db.sqlite3
# Or for PostgreSQL:
# DATABASE_URL=postgresql://user:password@localhost:5432/bmq_ai_sku

# Email (optional)
EMAIL_BACKEND=django.core.mail.backends.console.EmailBackend
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_HOST_USER=your-email@gmail.com
EMAIL_HOST_PASSWORD=your-password

# Currency
CURRENCY_CODE=VND
CURRENCY_SYMBOL=₫
```

### Database Setup

**For SQLite (Development):**
```bash
python manage.py migrate
```

**For PostgreSQL (Production):**
```bash
# Create database
createdb bmq_ai_sku

# Update DATABASE_URL in .env
python manage.py migrate
```

## Development

### Creating a New App Feature

1. **Create models** in `apps/<feature>/models.py`
2. **Register in admin** in `apps/<feature>/admin.py`
3. **Create serializers** in `apps/<feature>/serializers.py`
4. **Create views/viewsets** in `apps/<feature>/views.py`
5. **Add URLs** in `apps/<feature>/urls.py`
6. **Write tests** in `apps/<feature>/tests/`
7. **Create migrations**: `python manage.py makemigrations <feature>`

### Running Tests

```bash
# Run all tests
pytest

# Run specific app tests
pytest apps/products/

# Run with coverage
pytest --cov=apps
```

### Database Migrations

```bash
# Create migrations for changes
python manage.py makemigrations

# View migration SQL
python manage.py sqlmigrate app_name 0001

# Apply migrations
python manage.py migrate

# Rollback to previous state
python manage.py migrate app_name 0001
```

## Screenshots

### Dashboard
[Dashboard overview with key metrics and charts - Coming soon]

### Product Cost Analysis
[Detailed cost breakdown by component - Coming soon]

### Inventory Management
[Ingredient stock levels and supplier orders - Coming soon]

### Labor Tracking
[Employee hours and cost allocation - Coming soon]

## Troubleshooting

### No module named 'apps'
Ensure the project root is in your Python path. Run from the project directory:
```bash
python manage.py runserver
```

### Database locked errors (SQLite)
Close other connections and ensure only one process accesses the database.

### Seed data fails
Ensure all migrations have been applied:
```bash
python manage.py migrate
```

### Cost calculations seem incorrect
Check that all products have:
- An active BOM with line items
- A ProductionTime record with phases
- Employee wage records with current effective_date

## Contributing

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make changes and test: `pytest`
3. Commit with clear messages: `git commit -m "Add feature description"`
4. Push to branch: `git push origin feature/your-feature`
5. Create a Pull Request with description of changes

### Code Style

- Follow PEP 8 using `black` formatter
- Run linting: `flake8 apps/`
- Type hints encouraged for new code

## License

MIT License - See LICENSE file for details

## Support

For issues, feature requests, or questions:
- Open an issue on the repository
- Contact: support@bmq-bakery.vn

## Changelog

### Version 1.0.0 (Initial Release)
- Core cost calculation system
- SKU cost management
- Labor tracking and costing
- Overhead allocation
- Ingredient and supplier management
- Purchase order management
- Admin interface and API endpoints

## Related Documentation

- [Cost Calculation Details](COSTS_APP_SUMMARY.md)
- [Implementation Details](IMPLEMENTATION_SUMMARY.md)
- [Django Documentation](https://docs.djangoproject.com/)
- [Django REST Framework](https://www.django-rest-framework.org/)

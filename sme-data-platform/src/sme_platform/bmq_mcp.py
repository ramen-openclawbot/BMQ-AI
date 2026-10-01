"""Read-only MCP Streamable HTTP surface for the BMQ dealer storefront.

The module is deliberately split in two layers:

* :class:`WarehouseCatalog` loads the latest reconciled bronze snapshot and
  resolves one authenticated dealer's effective prices (customer override
  first, then the current ``selling_price``). It never writes.
* :func:`dispatch` is pure protocol plus tools over any injected catalog
  object exposing ``provider``, ``data_as_of``, ``customer``, ``search`` and
  ``get``. It performs no I/O and never inserts or submits an order.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import threading

from .bmq_customer import effective_prices, normalized
from .supabase_sync import TENANT

PROTOCOL_VERSION = '2025-06-18'
SERVER_NAME = 'bmq-storefront'
SERVER_VERSION = '1.0.0'
PROVIDER_NAME = 'Bánh Mì Que'
UI_THEMES = ('bakery', 'street', 'minimal')
DEFAULT_UI_THEME = 'bakery'
QUANTITY_STEP = 10
MAX_ITEMS = 50
MAX_SEARCH = 50
DEFAULT_SEARCH = 20
MAX_TEXT = 120
MAX_BODY_BYTES = 64 * 1024
CATALOG_TABLES = ('product_skus', 'mini_crm_customer_price_list',
                  'mini_crm_customers', 'product_label_specs')

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
UNAUTHORIZED = -32001


class McpUnauthorized(Exception):
    """The key or its dealer is not allowed to use the catalog."""


class CatalogUnavailable(RuntimeError):
    """No fresh, reconciled, complete bronze snapshot is available."""


class McpInvalidParams(Exception):
    """The JSON-RPC params or tool arguments are structurally invalid."""


class ToolError(Exception):
    """A well-formed tool call that cannot be satisfied."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _clean(value):
    """Return a JSON-serializable copy; Decimals stay exact as strings."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: _clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item) for item in value]
    return value


def _label_spec(label):
    if not isinstance(label, dict):
        return None
    return {'shelf_life_days': label.get('shelf_life_days'),
            'net_weight_value': label.get('net_weight_value'),
            'net_weight_unit': label.get('net_weight_unit'),
            'barcode_value': label.get('barcode_value'),
            'partner_product_code': label.get('partner_product_code')}


class WarehouseCatalog:
    """Read-only catalog scoped to exactly one authenticated customer."""

    def __init__(self, warehouse, customer_term: str, ui_theme: str = DEFAULT_UI_THEME):
        theme = ui_theme if ui_theme in UI_THEMES else DEFAULT_UI_THEME
        self.provider = {'name': PROVIDER_NAME, 'ui_theme': theme}
        self._load(warehouse, customer_term)

    def _load(self, warehouse, customer_term):
        settings = warehouse.settings
        with warehouse.lock(write=False), warehouse.connect(read_only=True) as con:
            con.execute('SET enable_external_access=false')
            timer = threading.Timer(settings.query_timeout, con.interrupt)
            timer.start()
            try:
                latest = con.execute('SELECT run_id,observed_at,manifest FROM meta_supabase_sync_runs '
                                     'ORDER BY observed_at DESC LIMIT 1').fetchone()
                if not latest:
                    raise CatalogUnavailable('Snapshot unavailable')
                manifest = json.loads(latest[2])
                now = datetime.now(timezone.utc)
                if manifest.get('tenant') != TENANT or not -60 <= (now - latest[1]).total_seconds() <= 1800:
                    raise CatalogUnavailable('Snapshot unavailable or stale')
                tables = manifest.get('tables', {})
                if not all(t in tables and tables[t].get('reconciled') is True for t in CATALOG_TABLES):
                    raise CatalogUnavailable('Required source unavailable')

                def source(table):
                    return [json.loads(row[0], parse_float=Decimal) for row in con.execute(
                        'SELECT payload FROM bronze.supabase_current WHERE tenant_id=? AND source_table=? '
                        'ORDER BY source_id', [TENANT, table]).fetchall()]

                customers = source('mini_crm_customers')
                term = normalized(customer_term)
                matches = [c for c in customers if term in {
                    normalized(str(c.get(k) or '')) for k in ('id', 'customer_code', 'customer_name')}]
                if len(matches) != 1:
                    raise McpUnauthorized('Unknown customer')
                customer = matches[0]
                if customer.get('is_active') is not True:
                    raise McpUnauthorized('Inactive customer')

                products = {p['id']: p for p in source('product_skus')}
                prices = [p for p in source('mini_crm_customer_price_list')
                          if p.get('customer_id') == customer['id'] and p.get('is_active') is True]
                if len({p.get('sku_id') for p in prices}) != len(prices):
                    raise CatalogUnavailable('Ambiguous active price rows')
                rows, status = effective_prices(products, prices, '')
                if status != 'ok':
                    raise CatalogUnavailable('Catalog unavailable')
                labels = {label.get('sku_id'): label for label in source('product_label_specs')}
            finally:
                timer.cancel()

        self.customer = {key: customer.get(key) for key in
                         ('id', 'customer_code', 'customer_name', 'is_active')}
        self.data_as_of = latest[1].isoformat()
        by_code = {}
        for sku in products.values():
            by_code.setdefault(sku.get('sku_code'), sku)
        self._products = []
        for row in rows:
            sku = by_code.get(row['sku_code']) or {}
            amount = row.get('price')
            integral = amount is not None and amount == amount.to_integral_value()
            available = row.get('price_status') == 'available' and integral
            image = sku.get('image_url')
            self._products.append({
                'sku_code': row['sku_code'],
                'product_name': row['product_name'],
                'unit': row['unit'],
                'unit_price_vnd': int(amount) if available else None,
                'price_source': row['price_source'],
                'price_available': available,
                'image_url': image if isinstance(image, str) and image else None,
                'label_spec': _label_spec(labels.get(sku.get('id'))),
            })
        self._by_code = {}
        for product in self._products:
            self._by_code.setdefault(product['sku_code'].casefold(), []).append(product)

    def search(self, query: str, limit: int) -> list[dict]:
        term = normalized(query) if query else ''
        matched = [p for p in self._products
                   if not term or term in normalized(p['sku_code']) or term in normalized(p['product_name'])]
        return matched[:limit]

    def get(self, sku: str) -> dict | None:
        matches = self._by_code.get(sku.strip().casefold(), [])
        return matches[0] if len(matches) == 1 else None


def _initialize_result() -> dict:
    return {'protocolVersion': PROTOCOL_VERSION,
            'capabilities': {'tools': {'listChanged': False}},
            'serverInfo': {'name': SERVER_NAME, 'version': SERVER_VERSION},
            'instructions': ('Read-only BMQ dealer catalog. call quote_cart to price an order and '
                             'prepare_order_draft to build a UI draft; nothing is ever submitted.')}


def _cart_items_schema() -> dict:
    return {'type': 'array', 'minItems': 1, 'maxItems': MAX_ITEMS,
            'items': {'type': 'object', 'additionalProperties': False,
                      'properties': {'sku': {'type': 'string', 'minLength': 1, 'maxLength': MAX_TEXT},
                                     'quantity': {'type': 'integer', 'minimum': QUANTITY_STEP,
                                                  'multipleOf': QUANTITY_STEP}},
                      'required': ['sku', 'quantity']}}


_TOOL_SCHEMAS = [
    {'name': 'search_products',
     'description': 'Search this dealer\'s priced finished-goods catalog by SKU code or product name.',
     'inputSchema': {'type': 'object', 'additionalProperties': False,
                     'properties': {'query': {'type': 'string', 'maxLength': MAX_TEXT},
                                    'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_SEARCH}}}},
    {'name': 'get_product',
     'description': 'Return one product with its this-dealer price and label specification.',
     'inputSchema': {'type': 'object', 'additionalProperties': False,
                     'properties': {'sku': {'type': 'string', 'minLength': 1, 'maxLength': MAX_TEXT}},
                     'required': ['sku']}},
    {'name': 'quote_cart',
     'description': 'Price a cart of finished goods. Quantities are positive multiples of 10; VND totals are integers.',
     'inputSchema': {'type': 'object', 'additionalProperties': False,
                     'properties': {'items': _cart_items_schema()}, 'required': ['items']}},
    {'name': 'prepare_order_draft',
     'description': ('Build an idempotent order draft and a <vnagent-order> UI payload. It never inserts '
                     'or submits an order.'),
     'inputSchema': {'type': 'object', 'additionalProperties': False,
                     'properties': {'items': _cart_items_schema(),
                                    'key': {'type': 'string', 'minLength': 1, 'maxLength': MAX_TEXT}},
                     'required': ['items', 'key']}},
]
for _schema in _TOOL_SCHEMAS:
    _schema['annotations'] = {'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True}


def _valid_text(value, name: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_TEXT or any(ord(c) < 32 for c in value):
        raise McpInvalidParams('Invalid ' + name)
    return value


def _price_cart(loader, items):
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        raise McpInvalidParams('Invalid items')
    lines = []
    total = 0
    for item in items:
        if not isinstance(item, dict) or set(item) != {'sku', 'quantity'}:
            raise McpInvalidParams('Invalid item')
        sku = _valid_text(item['sku'], 'sku')
        quantity = item['quantity']
        if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0 \
                or quantity % QUANTITY_STEP != 0:
            raise ToolError('invalid_quantity', 'Quantity must be a positive multiple of 10')
        product = loader.get(sku)
        if product is None:
            raise ToolError('unknown_sku', 'Unknown SKU')
        unit_price = product.get('unit_price_vnd')
        if not product.get('price_available') or unit_price is None:
            raise ToolError('price_unavailable', 'SKU has no positive integer VND price')
        lines.append({'sku_code': product['sku_code'], 'product_name': product['product_name'],
                      'unit': product['unit'], 'quantity': quantity,
                      'unit_price_vnd': unit_price, 'line_total_vnd': unit_price * quantity,
                      'image_url': product['image_url']})
        total += unit_price * quantity
    return lines, total


def _tool_search(loader, arguments):
    query = arguments.get('query', '')
    if not isinstance(query, str) or len(query) > MAX_TEXT or any(ord(c) < 32 for c in query):
        raise McpInvalidParams('Invalid query')
    limit = arguments.get('limit', DEFAULT_SEARCH)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_SEARCH:
        raise McpInvalidParams('Invalid limit')
    extras = set(arguments) - {'query', 'limit'}
    if extras:
        raise McpInvalidParams('Unknown argument')
    products = loader.search(query, limit)
    return {'products': products, 'count': len(products)}


def _tool_get(loader, arguments):
    if set(arguments) != {'sku'}:
        raise McpInvalidParams('Invalid arguments')
    sku = _valid_text(arguments['sku'], 'sku')
    product = loader.get(sku)
    if product is None:
        raise ToolError('unknown_sku', 'Unknown SKU')
    return {'product': product}


def _tool_quote(loader, arguments):
    if set(arguments) != {'items'}:
        raise McpInvalidParams('Invalid arguments')
    lines, total = _price_cart(loader, arguments['items'])
    return {'lines': lines, 'total_vnd': total, 'currency': 'VND', 'item_count': len(lines)}


def _tool_prepare_order_draft(loader, arguments):
    if set(arguments) != {'items', 'key'}:
        raise McpInvalidParams('Invalid arguments')
    key = _valid_text(arguments['key'], 'key')
    lines, total = _price_cart(loader, arguments['items'])
    customer = loader.customer
    draft_id = 'draft-' + hashlib.sha256(f"{customer['id']}:{key}".encode()).hexdigest()[:20]
    order = {'draft_id': draft_id,
             'customer': {'customer_code': customer['customer_code'],
                          'customer_name': customer['customer_name']},
             'lines': lines, 'total_vnd': total, 'currency': 'VND', 'status': 'draft',
             'submitted': False}
    ui_payload = '<vnagent-order>' + json.dumps(order, ensure_ascii=False, separators=(',', ':')) + '</vnagent-order>'
    # Deterministic draft id: repeating a customer + key returns the same draft.
    return {'draft_id': draft_id, 'lines': lines, 'total_vnd': total, 'currency': 'VND',
            'ui_payload': ui_payload, 'ui': order, 'submitted': False, 'order_created': False}


_TOOLS = {'search_products': _tool_search, 'get_product': _tool_get,
          'quote_cart': _tool_quote, 'prepare_order_draft': _tool_prepare_order_draft}


def _result(message_id, result):
    return {'jsonrpc': '2.0', 'id': message_id, 'result': result}


def error_response(message_id, code, message):
    return {'jsonrpc': '2.0', 'id': message_id, 'error': {'code': code, 'message': message}}


def unauthorized_response(message_id):
    return error_response(message_id, UNAUTHORIZED, 'Unauthorized')


def _tool_success(loader, data):
    payload = _clean({'provider': loader.provider, 'data_as_of': loader.data_as_of, **data})
    return {'content': [{'type': 'text', 'text': json.dumps(payload, ensure_ascii=False)}],
            'structuredContent': payload, 'isError': False}


def _tool_error(loader, code, message):
    payload = _clean({'provider': loader.provider, 'data_as_of': loader.data_as_of,
                      'error': code, 'message': message})
    return {'content': [{'type': 'text', 'text': json.dumps(payload, ensure_ascii=False)}],
            'structuredContent': payload, 'isError': True}


def dispatch(message, loader):
    """Handle one JSON-RPC message. Returns ``(http_status, payload_or_None)``."""
    if not isinstance(message, dict) or message.get('jsonrpc') != '2.0' \
            or not isinstance(message.get('method'), str):
        return 200, error_response(None, INVALID_REQUEST, 'Invalid Request')
    method = message['method']
    message_id = message.get('id')
    if message_id is None:
        # Notifications (including notifications/initialized) are acknowledged only.
        return 202, None
    if method == 'initialize':
        return 200, _result(message_id, _initialize_result())
    if method == 'ping':
        return 200, _result(message_id, {})
    if method == 'tools/list':
        return 200, _result(message_id, {'tools': _TOOL_SCHEMAS})
    if method == 'tools/call':
        params = message.get('params')
        if not isinstance(params, dict) or not isinstance(params.get('name'), str):
            return 200, error_response(message_id, INVALID_PARAMS, 'Invalid params')
        tool = _TOOLS.get(params['name'])
        if tool is None:
            return 200, error_response(message_id, INVALID_PARAMS, 'Unknown tool')
        arguments = params.get('arguments', {})
        if not isinstance(arguments, dict):
            return 200, error_response(message_id, INVALID_PARAMS, 'Invalid arguments')
        try:
            data = tool(loader, arguments)
        except McpInvalidParams as error:
            return 200, error_response(message_id, INVALID_PARAMS, str(error))
        except ToolError as error:
            return 200, _result(message_id, _tool_error(loader, error.code, error.message))
        return 200, _result(message_id, _tool_success(loader, data))
    return 200, error_response(message_id, METHOD_NOT_FOUND, 'Method not found')

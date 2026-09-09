"""Versioned canonical schema. Monetary values use exact decimal, UTC timestamps."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from uuid import uuid5, NAMESPACE_URL
from zoneinfo import ZoneInfo

ENTITY_FIELDS = {
'customers': 'customer_id external_customer_id full_name email phone customer_type status first_order_at last_order_at',
'products': 'product_id external_product_id sku name category subcategory brand unit list_price standard_cost status',
'locations': 'location_id external_location_id name location_type address city region country timezone status',
'orders': 'order_id external_order_id customer_id location_id channel status currency subtotal discount_amount tax_amount service_fee shipping_amount gross_amount net_amount cost_amount gross_profit ordered_at completed_at cancelled_at',
'order_items': 'order_item_id order_id product_id quantity unit_price discount_amount net_amount unit_cost cost_amount gross_profit',
'payments': 'payment_id external_payment_id order_id customer_id payment_method status currency amount paid_at refunded_amount',
'inventory_movements': 'inventory_movement_id product_id location_id movement_type quantity unit_cost reference_type reference_id event_at',
'inventory_snapshots': 'snapshot_id product_id location_id quantity_on_hand quantity_reserved quantity_available snapshot_at',
'suppliers': 'supplier_id external_supplier_id name email phone status',
'purchases': 'purchase_id supplier_id location_id status currency subtotal tax_amount total_amount ordered_at received_at',
'employees': 'employee_id external_employee_id location_id full_name role status hire_date termination_date',
'expenses': 'expense_id location_id category subcategory vendor currency amount expense_at description',
'conversations': 'conversation_id customer_id channel external_thread_id status started_at last_message_at',
'messages': 'message_id conversation_id sender_type sender_id direction content sent_at',
}
MONEY = set('list_price standard_cost subtotal discount_amount tax_amount service_fee shipping_amount gross_amount net_amount cost_amount gross_profit unit_price unit_cost amount refunded_amount total_amount'.split())
NUMBERS = MONEY | set('quantity quantity_on_hand quantity_reserved quantity_available'.split())
PII = {'full_name': 'pii', 'email': 'pii', 'phone': 'pii', 'address': 'pii', 'content': 'pii', 'description': 'confidential'}
COMMON = 'tenant_id source_system source_record_id source_timezone created_at updated_at metadata is_deleted deleted_at'.split()
SCHEMAS = {e: dict.fromkeys(dict.fromkeys(fields.split()+COMMON)) for e,fields in ENTITY_FIELDS.items()}
for fields in SCHEMAS.values():
    for f in fields:
        fields[f] = 'DECIMAL(24,6)' if f in NUMBERS else 'TIMESTAMPTZ' if f.endswith('_at') or f in {'hire_date','termination_date'} else 'BOOLEAN' if f == 'is_deleted' else 'VARCHAR'
PK = {e: fs.split()[0] for e, fs in ENTITY_FIELDS.items()}
REFS = {'customer_id':'customers','product_id':'products','location_id':'locations','order_id':'orders','supplier_id':'suppliers','conversation_id':'conversations'}
REQUIRED = {'orders':['status','currency','ordered_at','net_amount'], 'order_items':['order_id','product_id','quantity','net_amount'], 'payments':['currency','amount','paid_at'], 'inventory_snapshots':['product_id','location_id','snapshot_at','quantity_on_hand'], 'inventory_movements':['product_id','location_id','event_at','quantity'], 'expenses':['currency','amount','expense_at'], 'purchases':['currency','total_amount','ordered_at']}

def canonical_id(tenant, source, entity, external):
    return str(uuid5(NAMESPACE_URL, '\x1f'.join([tenant, source, entity, str(external)])))

def timestamp(value, tz):
    dt = datetime.fromisoformat(str(value).replace('Z','+00:00'))
    return (dt.replace(tzinfo=ZoneInfo(tz)) if dt.tzinfo is None else dt).astimezone(timezone.utc)

def normalize(entity, row, tenant, source, tz, ingested_at):
    import json
    if entity not in SCHEMAS: raise ValueError('Unknown entity')
    pk = PK[entity]
    external = row.get('external_'+pk) or row.get(pk) or row.get('id')
    if external is None or str(external).strip() == '': raise ValueError('Missing source primary ID')
    result = dict.fromkeys(SCHEMAS[entity])
    for f in result:
        value = row.get(f)
        if value is None or value == '': continue
        if f in NUMBERS:
            try: value = Decimal(str(value))
            except InvalidOperation: raise ValueError('Invalid decimal: '+f)
            if not value.is_finite() or abs(value) >= Decimal('1e18'): raise ValueError('Out-of-range decimal: '+f)
        elif SCHEMAS[entity][f] == 'TIMESTAMPTZ': value = timestamp(value,tz)
        elif f == 'is_deleted':
            if value not in (True, False, 'true','false','0','1',0,1): raise ValueError('Invalid deletion flag')
            value = value in (True,'true','1',1)
        elif f == 'metadata': value = json.dumps(value if isinstance(value,dict) else json.loads(value),ensure_ascii=False)
        else: value = str(value)
        result[f] = value
    result.update(tenant_id=tenant,source_system=source,source_record_id=str(external),source_timezone=tz)
    result[pk] = canonical_id(tenant,source,entity,external)
    if 'external_'+pk in result: result['external_'+pk] = str(external)
    for f,target in REFS.items():
        if f != pk and result.get(f): result[f] = canonical_id(tenant,source,target,result[f])
    result['created_at'] = result['created_at'] or ingested_at
    result['updated_at'] = result['updated_at'] or ingested_at
    result['is_deleted'] = result['is_deleted'] or False
    if result['is_deleted']: result['deleted_at'] = result['deleted_at'] or ingested_at
    result['metadata'] = result['metadata'] or '{}'
    if entity=='locations' and result.get('timezone'):
        try:ZoneInfo(result['timezone'])
        except (KeyError,ValueError):raise ValueError('Invalid location timezone')
    if result.get('currency') and (len(result['currency']) != 3 or not result['currency'].isalpha()): raise ValueError('Invalid ISO currency')
    if result.get('currency'): result['currency'] = result['currency'].upper()
    if not result['is_deleted']:
        for f in REQUIRED.get(entity,[]):
            if result[f] is None: raise ValueError('Missing required field: '+f)
    if entity == 'order_items' and result.get('quantity') is not None and result['quantity'] < 0: raise ValueError('Negative sale quantity')
    if entity == 'orders' and result.get('subtotal') is not None and result.get('net_amount') is not None:
        expected = result['subtotal'] - (result['discount_amount'] or 0) + (result['tax_amount'] or 0) + (result['service_fee'] or 0) + (result['shipping_amount'] or 0)
        if abs(expected-result['net_amount']) > Decimal('.01'): raise ValueError('Net amount inconsistent with source components')
    return result

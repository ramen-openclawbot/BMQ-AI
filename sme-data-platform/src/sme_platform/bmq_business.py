"""Reviewed BMQ source contracts; fixed SQL over one authenticated raw snapshot.

These are source-record measures, not a new accounting policy. No document URLs,
customer contact information, document contents, or arbitrary SQL are exposed.
"""
from datetime import datetime, timezone
import json
import threading
from .supabase_sync import TENANT

VERSION = 'bmq-business-v2'


def descriptor(label, vi, description, description_vi, tables, dimensions, unit='count', snapshot=False):
    return dict(label=label, label_vi=vi, description=description, description_vi=description_vi,
                tables=tables, source='Supabase.' + ' + '.join(tables), dimensions=dimensions,
                unit=unit, snapshot_only=snapshot)


METRICS = {
    'controlled_revenue': descriptor('Controlled revenue', 'Doanh thu đã kiểm soát',
        'Sum approved gross_revenue joined to controlled/trusted source documents. Not net or audited revenue. Never add dealer orders or kiosk reports to this ledger.',
        'Tổng gross_revenue của dòng approved, chứng từ controlled/trusted; không phải doanh thu thuần hay đã kiểm toán. Không cộng thêm đơn đại lý hoặc báo cáo điểm bán.',
        ['revenue_ledger_lines','revenue_source_documents'], ['date','channel'], 'VND'),
    'purchase_order_count': descriptor('Purchase order count', 'Số đơn mua hàng',
        'Count purchase_orders by order_date, all statuses; not sales orders.',
        'Đếm PO theo order_date, mọi trạng thái như báo cáo nhập hàng; không phải đơn bán.',
        ['purchase_orders'], ['date','status']),
    'low_stock_count': descriptor('Current low-stock items', 'Số mặt hàng tồn thấp hiện tại',
        'Count inventory_items where quantity <= coalesce(min_stock,0). Current snapshot only; excludes specialist warehouse ledgers. No mixed-unit sum.',
        'Đếm inventory_items có quantity <= (min_stock hoặc 0). Chỉ snapshot hiện tại, không bao quát sổ kho chuyên biệt, không cộng lẫn đơn vị.',
        ['inventory_items'], ['category'], snapshot=True),
    'supplier_debt': descriptor('Current supplier payables', 'Công nợ phải trả NCC hiện tại',
        'Unpaid/partial payment requests: sum max(total_amount - summed payment_allocations,0), same useDebtStats policy. One consistent source snapshot, not distributor receivables.',
        'Phiếu chi unpaid/partial: tổng max(total_amount - tổng phân bổ,0), theo useDebtStats. Một snapshot nguồn nhất quán, không phải phải thu NPP.',
        ['payment_requests','payment_allocations'], ['payment_method'], 'VND', True),
    'production_order_count': descriptor('Production orders created', 'Số lệnh sản xuất được tạo',
        'Count production_orders by created_at in Vietnam time, all statuses; not completed output or units manufactured.',
        'Đếm lệnh sản xuất theo ngày tạo giờ Việt Nam, mọi trạng thái; không phải sản lượng hoàn thành.',
        ['production_orders'], ['date','status','location']),
    'goods_receipt_count': descriptor('Goods receipt record count', 'Số phiếu nhập hàng',
        'Count goods_receipts by receipt_date, all statuses; not a total quantity or finalized receipt count.',
        'Đếm phiếu goods_receipts theo receipt_date, mọi trạng thái; không phải tổng lượng hàng hoặc số phiếu đã hoàn tất.',
        ['goods_receipts'], ['date','status']),
    'warehouse_dispatch_count': descriptor('Warehouse dispatch records', 'Số phiếu xuất giao hàng',
        'Count warehouse_dispatches by dispatch_date, all statuses; not delivered customer orders. Excludes specialist dispatch ledgers.',
        'Đếm warehouse_dispatches theo dispatch_date, mọi trạng thái; không phải đơn khách đã giao, không bao quát sổ xuất kho chuyên biệt.',
        ['warehouse_dispatches'], ['date','status']),
    'active_customer_count': descriptor('Active CRM customers', 'Số khách hàng CRM đang hoạt động',
        'Current mini_crm_customers with is_active=true, including all customer groups; not customers who purchased in a period.',
        'Snapshot khách CRM is_active=true, gồm các nhóm khách; không phải khách có mua hàng trong kỳ.',
        ['mini_crm_customers'], ['customer_group'], snapshot=True),
    'product_sku_count': descriptor('Registered product SKUs', 'Số SKU trong danh mục',
        'Current count of product_skus, including non-portal SKUs. Not stock quantity or active-sale availability.',
        'Đếm danh mục product_skus hiện tại, gồm SKU không hiển thị portal; không phải số lượng tồn hay khả năng bán.',
        ['product_skus'], ['category'], snapshot=True),
    'active_contract_file_count': descriptor('Active contract file records', 'Số bản ghi file hợp đồng đang bật',
        'Count active mini_crm_customer_contracts metadata records, not unique agreements or legally effective contracts. File contents and terms are NOT indexed by this measure.',
        'Đếm bản ghi file mini_crm_customer_contracts is_active=true; không phải số hợp đồng duy nhất hoặc còn hiệu lực pháp lý. Chưa đọc nội dung hay điều khoản.',
        ['mini_crm_customer_contracts'], [], snapshot=True),
}

COMMON = "WITH src AS (SELECT source_table,source_id,payload::JSON AS p FROM bronze.supabase_current WHERE tenant_id=?)"


def facts(metric):
    """Return fixed facts relation plus optional data-quality check; never user SQL."""
    if metric == 'controlled_revenue':
        return """, facts AS (SELECT CAST(l.p->>'revenue_date' AS DATE) AS date,
            l.p->>'channel' AS channel, coalesce(CAST(l.p->>'gross_revenue' AS DECIMAL(28,5)),0) AS amount
            FROM src l JOIN src d ON d.source_table='revenue_source_documents' AND d.source_id=(l.p->>'source_document_id')
            WHERE l.source_table='revenue_ledger_lines' AND (l.p->>'approval_status')='approved'
            AND (d.p->>'status') IN ('controlled','trusted'))""", """SELECT count(*) FROM src l
            WHERE l.source_table='revenue_ledger_lines' AND (l.p->>'approval_status')='approved'
            AND NOT EXISTS(SELECT 1 FROM src d WHERE d.source_table='revenue_source_documents' AND d.source_id=(l.p->>'source_document_id'))"""
    if metric == 'supplier_debt':
        return """, allocated AS (SELECT p->>'payment_request_id' AS request_id,
            SUM(coalesce(CAST(p->>'amount' AS DECIMAL(28,5)),0)) AS paid FROM src
            WHERE source_table='payment_allocations' GROUP BY 1), facts AS (
            SELECT r.p->>'payment_method' AS payment_method,
            greatest(coalesce(CAST(r.p->>'total_amount' AS DECIMAL(28,5)),0)-coalesce(a.paid,0),0) AS amount
            FROM src r LEFT JOIN allocated a ON a.request_id=r.source_id
            WHERE r.source_table='payment_requests' AND (r.p->>'payment_status') IN ('unpaid','partial'))""", None
    if metric == 'low_stock_count':
        return """, facts AS (SELECT p->>'category' AS category,1 AS amount FROM src
            WHERE source_table='inventory_items' AND coalesce(CAST(p->>'quantity' AS DECIMAL(28,5)),0)
            <=coalesce(CAST(p->>'min_stock' AS DECIMAL(28,5)),0))""", None
    mapping = {
        'purchase_order_count': ('purchase_orders', "CAST(p->>'order_date' AS DATE)", None),
        'production_order_count': ('production_orders', "CAST(CAST(p->>'created_at' AS TIMESTAMPTZ) AT TIME ZONE 'Asia/Ho_Chi_Minh' AS DATE)", None),
        'goods_receipt_count': ('goods_receipts', "CAST(p->>'receipt_date' AS DATE)", None),
        'warehouse_dispatch_count': ('warehouse_dispatches', "CAST(p->>'dispatch_date' AS DATE)", None),
        'active_customer_count': ('mini_crm_customers', None, "CAST(p->>'is_active' AS BOOLEAN)=true"),
        'product_sku_count': ('product_skus', None, None),
        'active_contract_file_count': ('mini_crm_customer_contracts', None, "CAST(p->>'is_active' AS BOOLEAN)=true"),
    }
    table, date, condition = mapping[metric]
    fields = [f'{date} AS date'] if date else []
    for dim in METRICS[metric]['dimensions']:
        if dim != 'date':
            column = 'location_code' if dim == 'location' else dim
            fields.append(f"p->>'{column}' AS {dim}")
    fields.append('1 AS amount')
    return f", facts AS (SELECT {','.join(fields)} FROM src WHERE source_table='{table}'" + (f' AND {condition}' if condition else '') + ')', None


def execute(engine, dsl, tenant, permission):
    if tenant != TENANT or not (permission == 'owner' or permission.startswith('owner:')):
        raise PermissionError('Owner required')
    if set(dsl) - {'metric','time_range','dimensions','limit'}:
        raise ValueError('Unsupported business DSL')
    metric = dsl['metric']; spec = METRICS[metric]
    dims = dsl.get('dimensions',[]); limit = dsl.get('limit',20)
    if not isinstance(dims,list) or any(not isinstance(d,str) or d not in spec['dimensions'] for d in dims) or len(dims)>2 or len(dims)!=len(set(dims)):
        raise ValueError('Incompatible dimensions')
    if type(limit)!=int or not 1<=limit<=500:
        raise ValueError('Invalid limit')
    start,end = engine._period(dsl.get('time_range','today'))
    if spec['snapshot_only'] and (start,end)!=engine._period('today'):
        raise ValueError('Current snapshot only; historical balance unavailable')
    w=engine.warehouse
    with w.lock(write=False),w.connect(read_only=True) as con:
        latest=con.execute('SELECT run_id,observed_at,manifest FROM meta_supabase_sync_runs ORDER BY observed_at DESC LIMIT 1').fetchone()
        if not latest:
            raise RuntimeError('Supabase snapshot not available')
        manifest=json.loads(latest[2]); now=datetime.now(timezone.utc)
        if manifest.get('tenant')!=tenant or not all(t in manifest.get('tables',{}) and manifest['tables'][t].get('reconciled') is True for t in spec['tables']):
            raise RuntimeError('Required source tables not synchronized')
        if not -60 <= (now-latest[1]).total_seconds() <= 1800:
            raise RuntimeError('Supabase snapshot is stale')
        relations,check=facts(metric)
        con.execute('SET enable_external_access=false')
        timer=threading.Timer(w.settings.query_timeout,con.interrupt);timer.start()
        try:
            if check and con.execute(COMMON+' '+check,[tenant]).fetchone()[0]:
                raise RuntimeError('Incomplete source references')
            if not spec['snapshot_only'] and con.execute(COMMON+relations+' SELECT count(*) FROM facts WHERE date IS NULL',[tenant]).fetchone()[0]:
                raise RuntimeError('Incomplete source dates')
            columns=[f"coalesce(CAST({d} AS VARCHAR),'Unspecified') AS {d}" for d in dims]
            columns += ["'VND' AS currency", f"coalesce(SUM(amount),0) AS {metric}"]
            params=[tenant]
            where=''
            if not spec['snapshot_only']:
                where=' WHERE date BETWEEN ? AND ?';params += [start,end]
            sql=COMMON+relations+' SELECT '+','.join(columns)+' FROM facts'+where+' GROUP BY ALL ORDER BY '+metric+' DESC'+(' ,'+','.join(dims) if dims else '')+' LIMIT ?'
            cur=con.execute(sql,params+[limit+1]);names=[c[0] for c in cur.description]
            rows=[dict(zip(names,r)) for r in cur.fetchall()]
        finally:
            timer.cancel()
    return dict(metric=metric, rows=rows[:limit], truncated=len(rows)>limit,
        period={'start':str(start),'end':str(end)}, source=spec['source'], definition=spec['description'],
        definition_vi=spec['description_vi'],unit=spec['unit'],semantic_version=VERSION,cache_hit=False,
        source_observed_at=latest[1].isoformat(),snapshot_id=latest[0],read_at=now.isoformat())

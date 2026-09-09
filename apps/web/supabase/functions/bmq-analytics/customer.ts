import { AnalyticsError } from './core.ts';
// Only bounded typed lookup inputs cross the owner-authenticated warehouse bridge.
export function customerRequest(q: any) {
  if (!q || typeof q !== 'object' || Object.keys(q).sort().join() !== 'customer,kind,limit,product,time_range' || !['prices','orders'].includes(q.kind)
      || [q.customer,q.product].some(x=>typeof x!=='string'||x.length>120||/[\x00-\x1f]/.test(x)) || !q.customer.trim()
      || (q.kind==='orders' && q.product.trim()) || !Number.isInteger(q.limit)||q.limit<1||q.limit>20
      || typeof q.time_range!=='string' || !/^(today|yesterday|this_week|previous_week|this_month|previous_month|\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2})$/.test(q.time_range)
      || (q.kind==='prices' && q.time_range!=='today')) throw new AnalyticsError('invalid_query');
  return {...q,time_range:q.time_range.includes('/')?{start:q.time_range.split('/')[0],end:q.time_range.split('/')[1]}:q.time_range};
}
export function customerAnswer(r:any, kind:string, language:string) {
  const en=language==='en';
  if(!r || r.kind!==kind || !['ok','choose_customer','not_found','inactive_customer','product_not_unique'].includes(r.status)
    || !Array.isArray(r.rows)||r.rows.length>20 || JSON.stringify(r).length>16000
    || typeof r.source!=='string'||typeof r.source_observed_at!=='string'||!Number.isFinite(Date.parse(r.source_observed_at))||typeof r.snapshot_id!=='string') throw new AnalyticsError('invalid_result');
  const clean=(v:unknown,max=200)=>{
    if(typeof v!=='string'||v.length>max||/[\x00-\x1f]/.test(v))throw new AnalyticsError('invalid_result');
    return v.replace(/[\\`*_{}\[\]()<>#!|]/g,' ').trim();
  };
  const customer=(c:any)=>`${clean(c?.customer_name)} (${clean(c?.customer_code)})`;
  let text='';
  if(r.status==='choose_customer') {
    if(!Array.isArray(r.candidates)||!r.candidates.length||r.candidates.length>5)throw new AnalyticsError('invalid_result');
    text=(en?'Please specify the exact customer code:':'Vui lòng chọn mã khách hàng chính xác:')+'\n'+r.candidates.map(customer).join('\n');
  } else if(r.status==='not_found') text=en?'No matching customer found. Please provide the customer code.':'Không tìm thấy khách phù hợp. Vui lòng cung cấp mã khách hàng.';
  else if(r.status==='inactive_customer') text=(en?'Inactive customer: ':'Khách hàng ngừng hoạt động: ')+customer(r.customer);
  else if(r.status==='product_not_unique') text=en?'Product could not be uniquely identified. Please provide the exact SKU code.':'Chưa xác định duy nhất sản phẩm. Vui lòng cung cấp mã SKU chính xác.';
  else {
    text=customer(r.customer)+'\n';
    for(const row of r.rows) {
      const amount=kind==='prices'?row.price:row.amount;
      if(!['string','number'].includes(typeof amount)||!Number.isFinite(Number(amount))||row.currency!=='VND')throw new AnalyticsError('invalid_result');
      text+=kind==='prices'?`${clean(row.sku_code)} · ${clean(row.product_name)}: ${amount} VND / ${clean(row.unit)}\n`:`${clean(row.order_number)} · ${clean(row.submitted_at)}: ${amount} VND\n`;
    }
    if(!r.rows.length)text+=kind==='prices'?(en?'No explicit active customer price found; no default price substituted.':'Chưa có giá riêng đang hoạt động; không tự thay bằng giá mặc định.'):(en?'No matching submitted orders in this period.':'Không có đơn đã gửi phù hợp trong kỳ này.');
    text+='\n'+(kind==='prices'?(en?'Current explicit customer price list only, not a checkout quote. Tax and contract terms are not inferred.':'Chỉ là bảng giá riêng hiện tại, không phải báo giá chốt đơn. Không suy ra thuế hay điều khoản hợp đồng.'):(en?'Submitted non-test orders owned by this customer; excludes cancellations. Not downstream delivery orders, revenue or receivables.':'Đơn đã gửi, không test, do khách này đứng tên; loại đơn hủy. Không phải đơn tuyến giao bên dưới, doanh thu hay công nợ.'));
    if(kind==='orders')text+=`\n${clean(r.period?.start)} → ${clean(r.period?.end)}`;
  }
  if(r.truncated)text+='\n'+(en?'Partial list; not all matching records.':'Danh sách rút gọn, chưa phải toàn bộ bản ghi phù hợp.');
  return text+`\n${en?'Source':'Nguồn'}: ${clean(r.source,300)}\n${en?'Synced':'Đồng bộ lúc'}: ${clean(r.source_observed_at)}`;
}

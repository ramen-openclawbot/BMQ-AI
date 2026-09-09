import { AnalyticsError } from './core.ts';
// Only bounded typed lookup inputs cross the owner-authenticated warehouse bridge.
export function customerRequest(q: any) {
  if (!q || typeof q !== 'object' || Object.keys(q).sort().join() !== 'customer,kind,limit,product,time_range' || !['prices','orders','npp_receivable'].includes(q.kind)
      || [q.customer,q.product].some(x=>typeof x!=='string'||x.length>120||/[\x00-\x1f]/.test(x)) || !q.customer.trim()
      || (q.kind!=='prices' && q.product.trim()) || !Number.isInteger(q.limit)||q.limit<1||q.limit>20
      || typeof q.time_range!=='string' || !/^(today|yesterday|this_week|previous_week|this_month|previous_month|\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2})$/.test(q.time_range)
      || (q.kind==='prices' && q.time_range!=='today')) throw new AnalyticsError('invalid_query');
  return {...q,time_range:q.time_range.includes('/')?{start:q.time_range.split('/')[0],end:q.time_range.split('/')[1]}:q.time_range};
}
export function customerAnswer(r:any, kind:string, language:string) {
  const en=language==='en';
  if(!r || r.kind!==kind || !['ok','choose_customer','not_found','inactive_customer','product_not_unique','not_npp'].includes(r.status)
    || !Array.isArray(r.rows)||r.rows.length>20 || JSON.stringify(r).length>16000
    || typeof r.source!=='string'||typeof r.source_observed_at!=='string'||!Number.isFinite(Date.parse(r.source_observed_at))||typeof r.snapshot_id!=='string') throw new AnalyticsError('invalid_result');
  const clean=(v:unknown,max=200)=>{
    if(typeof v!=='string'||v.length>max||/[\x00-\x1f]/.test(v))throw new AnalyticsError('invalid_result');
    return v.replace(/[\\`*_{}\[\]()<>#!|]/g,' ').trim();
  };
  const customer=(c:any)=>`${clean(c?.customer_name)} (${clean(c?.customer_code || c?.id)})`;
  let text='';
  if(r.status==='choose_customer') {
    if(!Array.isArray(r.candidates)||!r.candidates.length||r.candidates.length>5)throw new AnalyticsError('invalid_result');
    text=(en?'Please confirm a customer name or code:':'Vui lòng xác nhận tên hoặc mã khách hàng:')+'\n'+r.candidates.map(customer).join('\n');
  } else if(r.status==='not_found') text=en?'No matching customer found. Please provide the customer code.':'Không tìm thấy khách phù hợp. Vui lòng cung cấp mã khách hàng.';
  else if(r.status==='inactive_customer') text=(en?'Inactive customer: ':'Khách hàng ngừng hoạt động: ')+customer(r.customer);
  else if(r.status==='product_not_unique') text=en?'Product could not be uniquely identified. Please provide the exact SKU code.':'Chưa xác định duy nhất sản phẩm. Vui lòng cung cấp mã SKU chính xác.';
  else if(r.status==='not_npp') text=en?'This customer is not a distributor (NPP). Direct-customer balances use a different contract and are not available in this lookup.':'Khách này không phải NPP. Công nợ khách trực tiếp dùng công thức khác, chưa có trong tra cứu này.';
  else if(kind==='npp_receivable') {
    if(r.definition!=='npp_debt_screen_period_v1'||!r.totals||r.totals.currency!=='VND')throw new AnalyticsError('invalid_result');
    const amount=(x:any)=>{if(!['number','string'].includes(typeof x)||!Number.isFinite(Number(x)))throw new AnalyticsError('invalid_result');return String(x);};
    text=customer(r.customer)+`\n${clean(r.period?.start)} → ${clean(r.period?.end)}\n`;
    text+=(en?'Approved gross revenue: ':'Doanh thu đã duyệt: ')+amount(r.totals.gross)+' VND\n';
    text+=(en?'Management fee: ':'Phí quản lý: ')+amount(r.totals.management_fee)+' VND\n';
    text+=(en?'Period payable (NPP debt screen): ':'Phải thu trong kỳ (theo màn hình công nợ NPP): ')+amount(r.totals.period_payable)+' VND\n';
    for(const row of r.rows){
      if(row.currency!=='VND')throw new AnalyticsError('invalid_result');
      text+=`${clean(row.customer_code)} · ${clean(row.customer_name)}: ${amount(row.gross)} − ${amount(row.management_fee)} = ${amount(row.period_payable)} VND\n`;
    }
    text+=en?'Uses current active agency mappings and one management fee per agency for the selected period, including agencies without sales. No opening balance or collections deducted; NOT a settled outstanding balance. No historical fee reconstruction.':'Dùng liên kết đại lý đang hoạt động và phí quản lý hiện tại, trừ một lần/đại lý trong kỳ kể cả đại lý không phát sinh. Chưa cộng số dư đầu kỳ hay trừ tiền đã thu; KHÔNG phải số dư còn nợ sau thanh toán. Không phục dựng phí lịch sử.';
    if(r.unmapped_line_count)text+='\n'+(en?'Includes unmapped revenue lines; review agency allocation.':'Có dòng doanh thu chưa map đại lý; cần đối soát phân bổ.');
    if(r.truncated)text+='\n'+(en?'Totals cover all matching agencies; detail list is capped.':'Tổng bao gồm toàn bộ đại lý phù hợp; danh sách chi tiết bị giới hạn.');
  }
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

// Continuation is a bounded query hint, NEVER identity/permission authority.
// The authenticated warehouse resolves the selected code/id again against live data.
export function customerSelection(result:any, request:any) {
  if(result.status!=='choose_customer') return undefined;
  customerRequest(request);
  const candidates=result.candidates.map((c:any)=>({name:c.customer_name,code:c.customer_code || c.id}));
  const time_range=request.kind==='prices'?'today':`${result.period?.start}/${result.period?.end}`;
  customerRequest({...request,time_range});
  return {request:{...request,time_range},candidates};
}
export function customerContinuation(question:string, history:{role:string;text:string;customerSelection?:unknown}[]) {
  // Only the immediately preceding assistant response may offer a selection.
  const last=history.at(-1);
  if(last?.role!=='assistant'||!last.customerSelection) return null;
  try {
    const state:any=last.customerSelection;
    if(Object.keys(state).sort().join()!=='candidates,request'||!Array.isArray(state.candidates)||!state.candidates.length||state.candidates.length>5) return null;
    customerRequest(state.request);
    if(state.request.kind!=='prices'&&!/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/.test(state.request.time_range))return null;
    const normalize=(s:string)=>s.normalize('NFC').toLocaleLowerCase().replace(/[‐‑‒–—]/g,'-').replace(/\s+/g,' ').trim();
    const text=normalize(question).replace(/[.!]+$/,'');
    const terms=[text,text.replace(/^(?:đúng là|đúng|chọn|vâng|yes|select|choose)\s*[, :]*\s+/,'')];
    if(state.candidates.some((c:any)=>!c||Object.keys(c).sort().join()!=='code,name'||[c.name,c.code].some(v=>typeof v!=='string'||!v.trim()||v.length>120||/[\x00-\x1f]/.test(v)))) return null;
    const matches=state.candidates.filter((c:any)=>terms.some(t=>t===normalize(c.name)||t===normalize(c.code)||t===normalize(`${c.name} (${c.code})`)));
    if(matches.length!==1)return null;
    const request={...state.request,customer:matches[0].code};
    customerRequest(request);
    return request;
  } catch { return null; }
}

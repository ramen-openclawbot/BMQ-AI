#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
MIGRATION=ROOT/'supabase/migrations/20260818143000_task9_material_master_shadow_rollout.sql'
REPORT=ROOT/'scripts/material_master/shadow_resolution_report.py'
SMOKE=ROOT/'scripts/material_master/shadow_rollout_rollback_smoke.sql'
PROTECTED=('sku_cogs_materials','sku_cogs_material_aliases','material_scoped_aliases','material_resolution_requests','sku_formulations','sku_cogs_versions','sku_cogs_version_formulations','kitchen_inventory_items','q7_material_issue_material_mappings','q7_inventory_movements','q7_inventory_openings','q7_inventory_opening_audit_logs','kitchen_inventory_movements')
def read(p:Path)->str: assert p.exists(),f'Missing required Task9 file: {p.relative_to(ROOT)}'; return p.read_text(encoding='utf-8')
def uncommented(t:str)->str: t=re.sub(r'/\*[\s\S]*?\*/','',t); return '\n'.join(l for l in t.splitlines() if not l.lstrip().startswith('--'))
def assert_no_dml(sql:str)->None:
 b=uncommented(sql).lower()
 for table in PROTECTED:
  ref=rf'(?:public\.)?{re.escape(table)}'
  for pat in (rf'\binsert\s+into\s+{ref}\b',rf'\bupdate\s+{ref}\b',rf'\bdelete\s+from\s+{ref}\b',rf'\btruncate\s+(?:table\s+)?{ref}\b'):
   assert not re.search(pat,b), f'Task9 rollout migration must not write protected table {table}'
def load_report():
 spec=importlib.util.spec_from_file_location('shadow_resolution_report',REPORT); assert spec and spec.loader; m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
def test_task9_migration_is_additive_readonly_dashboard_and_preserves_existing_modes():
 sql=read(MIGRATION); low=sql.lower(); assert_no_dml(sql)
 assert 'public.sku_cogs_materials' in low
 assert "q7'" not in low and "'q7" not in low
 assert "('kitchen_inventory', 'shadow')" in low
 assert 'on conflict (source_type) do nothing' in low
 assert 'on conflict (source_type) do update' not in low
 assert "('sku_cogs', 'enforced')" not in low and "scan_sku_cost_sheet', 'enforced'" not in low
 assert re.search(r'create\s+or\s+replace\s+view\s+public\.material_master_shadow_rollout_dashboard',low,re.S)
 assert re.search(r'create\s+or\s+replace\s+function\s+public\.get_material_master_rollout_dashboard\s*\(\s*\)',low,re.S)
 assert 'language plpgsql' in low
 assert "if not public.can_view_material_master() then" in low
 assert "raise exception 'insufficient_privilege' using errcode = '42501'" in low
 for f in ('source_type','mode','queue_total_count','queue_pending_count','queue_resolved_count','queue_blocked_count','queue_buckets','oldest_queue_created_at','latest_queue_created_at','ready_for_enforcement','blockers','pending','confirmation_needed','ambiguous','not_found','unit_unmapped','supplier_unmapped','controller_error','resolved_exact','fail-closed'): assert f in low
 assert "coalesce(req.queue_buckets, jsonb_build_object" in low
 assert re.search(r"case[\s\S]+when[\s\S]+mode\s*=\s*'disabled'[\s\S]+then\s+false", low)
 assert "queue_blocked_count = 0" in low
 assert "rejected_resolution_queue" in low
 assert re.search(r"when[\s\S]+queue_pending_count\s*=\s*0[\s\S]+then\s+true", low)
def test_task9_report_script_is_offline_safe_and_renders_json_markdown_without_raw_payloads(tmp_path,capsys):
 r=load_report(); d=tmp_path/'export'; d.mkdir(); (d/'material_master_shadow_rollout_dashboard.json').write_text(json.dumps([{'source_type':'kitchen_inventory','mode':'shadow','queue_total_count':3,'queue_pending_count':2,'queue_resolved_count':1,'queue_blocked_count':0,'queue_buckets':{'pending':2,'resolved_exact':1},'oldest_queue_created_at':'2026-08-01T00:00:00Z','latest_queue_created_at':'2026-08-02T00:00:00Z','ready_for_enforcement':False,'blockers':['pending_resolution_queue'],'raw_payload':{'secret':'must-not-print'}},{'source_type':'sku_cogs','mode':'enforced','queue_total_count':1,'queue_pending_count':0,'queue_resolved_count':1,'queue_blocked_count':0,'queue_buckets':{},'oldest_queue_created_at':None,'latest_queue_created_at':'2026-08-02T00:00:00Z','ready_for_enforcement':True,'blockers':[]}]),encoding='utf-8')
 safe=r.sanitize_rows(r.load_local_dashboard(d)); assert 'raw_payload' not in safe[0] and 'secret' not in json.dumps(safe).lower()
 assert r.main(['--export-dir',str(d),'--format','json'])==0; out=capsys.readouterr().out; assert 'kitchen_inventory' in out and 'secret' not in out and 'raw_payload' not in out
 assert r.main(['--export-dir',str(d),'--format','markdown'])==0; md=capsys.readouterr().out; assert '| source_type | mode | ready_for_enforcement | oldest_queue_created_at | latest_queue_created_at | queue_buckets | blockers |' in md and 'pending_resolution_queue' in md and 'secret' not in md
def test_task9_report_linked_reads_require_two_explicit_flags_and_sanitize_failures(monkeypatch,tmp_path):
 r=load_report()
 for args in (['--linked'], ['--linked','--allow-linked-read']):
  try: r.parse_args(args)
  except SystemExit as e: assert e.code!=0
  else: raise AssertionError('linked flags not enforced')
 assert r.parse_args(['--linked','--allow-linked-read','--i-understand-linked-read']).linked is True
 def failing_run(*a,**k): return r.subprocess.CompletedProcess(a[0],1,stdout='[{"raw":"secret-db-row"}]',stderr='SUPABASE_ACCESS_TOKEN=secret')
 monkeypatch.setattr(r.subprocess,'run',failing_run)
 try: r.load_linked_dashboard(tmp_path)
 except RuntimeError as e: msg=str(e)
 else: raise AssertionError('linked failure must raise')
 assert 'Supabase CLI exited with code 1' in msg and 'secret' not in msg and 'SUPABASE_ACCESS_TOKEN' not in msg
def test_task9_rollback_smoke_is_executable_config_only_zero_residue_contract():
 s=read(SMOKE); e=uncommented(s).lower(); m=read(MIGRATION).lower()
 for mark in ('begin;','rollback;','task9_shadow_rollout_config_rollback','synthetic pending queue rows','protected_table_counts_unchanged','post_rollback_zero_residue','rollout_dashboard_permission_denial'): assert mark in e
 assert 'insert into public.material_resolution_requests' in e and 'on conflict (source_type) do nothing' in e and 'update public.material_master_enforcement_config' in e
 assert 'update public.material_master_enforcement_config' not in m
 for table in PROTECTED: assert table in e
 assert re.search(r"raise\s+exception\s+'protected table counts changed", e)
 assert re.search(r'select[\s\S]+post_rollback_zero_residue', e)
if __name__=='__main__': raise SystemExit('Run with pytest')

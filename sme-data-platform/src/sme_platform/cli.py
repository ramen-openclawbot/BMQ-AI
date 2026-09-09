import argparse,json
from pathlib import Path
from .config import Settings
from .warehouse import Warehouse,json_default,RESOURCE_ROOT
from .query import QueryEngine

def main(action=None):
    p=argparse.ArgumentParser(description='BMQ local-first warehouse. Writes require verified SSD.')
    if action is None:p.add_argument('action',choices=['init','ingest','silver','gold','validate','status','query'])
    p.add_argument('--source',default='sample');p.add_argument('--tenant',default='bmq');p.add_argument('--entity',default='orders');p.add_argument('--file',type=Path);p.add_argument('--timezone',default='Asia/Ho_Chi_Minh');p.add_argument('--dsl')
    args=p.parse_args();action=action or args.action
    w=Warehouse(Settings.from_env())
    if action=='init':result=w.initialize()
    elif action=='ingest':
        if args.file:result=w.ingest_file(args.file,args.tenant,args.source,args.entity,args.timezone)
        elif args.source=='sample':
            result=[]
            for entity in ['customers','locations','products','orders','order_items','payments']:
                result.append(w.ingest_file(RESOURCE_ROOT/'fixtures'/(entity+'.json'),args.tenant,'sample',entity,args.timezone))
        else:p.error('--file required for non-sample source')
        w.rebuild_gold()
    elif action=='silver':result=w.rebuild_silver()
    elif action=='gold':result=w.rebuild_gold()
    elif action=='validate':result=w.validate(args.tenant)
    elif action=='status':result=w.status()
    else:
        if not args.dsl:p.error('--dsl JSON required')
        result=QueryEngine(w).execute(json.loads(args.dsl),args.tenant)
    print(json.dumps(result,default=json_default,ensure_ascii=False,indent=2))

if __name__=='__main__':main()

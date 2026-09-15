"""Prepare separate Background media timer from a clean committed checkout.
Does not change or restart scalar sync, Gateway, Supabase or web services.
"""
import argparse,os,plistlib,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);args=p.parse_args()
repo=args.repo.resolve()
if subprocess.check_output(['git','status','--porcelain','--','sme-data-platform'],cwd=repo).strip():
 raise SystemExit('Commit media source before installation')
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
os.umask(0o077)
base=Path.home()/'.local/share/bmq-warehouse';runtime=base/'runtime/bin/python'
if not runtime.exists():raise SystemExit('Existing warehouse runtime required')
release=base/('media-'+sha[:12]);package=release/'sme-data-platform'
if not package.exists():
 shutil.copytree(repo/'sme-data-platform',package,ignore=shutil.ignore_patterns('__pycache__','.pytest_cache','*.pyc','.venv'))
project=release/'project';linked=project/'supabase/.temp';linked.mkdir(parents=True,exist_ok=True)
(linked/'project-ref').write_text('cxntbdvfsikwmitapony\n')
(project/'supabase/config.toml').write_text('project_id = "cxntbdvfsikwmitapony"\n')
label='ai.vnagent.bmq-finance-media';logs=base/'media-logs';logs.mkdir(exist_ok=True)
config={'Label':label,'ProgramArguments':[str(runtime),'-m','sme_platform.finance_media','--workdir',str(project)],
 'WorkingDirectory':str(release),'EnvironmentVariables':{'PYTHONPATH':str(package/'src'),'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','PYTHONUNBUFFERED':'1'},
 'LimitLoadToSessionType':'Background','RunAtLoad':True,'StartInterval':900,'ThrottleInterval':60,
 'StandardOutPath':str(logs/'status.log'),'StandardErrorPath':str(logs/'stderr.log')}
plist=Path.home()/'Library/LaunchAgents'/f'{label}.plist'
if plist.exists() and plistlib.loads(plist.read_bytes())!=config:
 raise SystemExit('Existing media configuration differs; unload/review this job first')
plist.write_bytes(plistlib.dumps(config));plist.chmod(0o600)
print(f'Prepared media-only Background job; source {sha}')
print(f'launchctl bootstrap user/{os.getuid()} {plist}')

"""Install an approved, clean committed connector as a per-user macOS LaunchAgent.
Existing host-managed Supabase CLI login is reused; no secrets are copied.
"""
import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
import os

parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
args = parser.parse_args()
repo = args.repo.resolve()
if subprocess.check_output(['git', 'status', '--porcelain', '--', 'sme-data-platform'], cwd=repo).strip():
    raise SystemExit('Commit connector source before installing the recurring job')
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
os.umask(0o077)
base = Path.home() / '.local/share/bmq-warehouse'
python = base / 'runtime/bin/python'
if not python.exists():
    raise SystemExit('Install the existing warehouse Python runtime first')
release = base / ('sync-' + sha[:12])
release.mkdir(parents=True, exist_ok=True)
package = release / 'sme-data-platform'
if not package.exists():
    shutil.copytree(repo / 'sme-data-platform', package,
                    ignore=shutil.ignore_patterns('__pycache__', '.pytest_cache', '*.pyc', '.venv'))
project = release / 'project'
linked = project / 'supabase/.temp'
linked.mkdir(parents=True, exist_ok=True)
(linked / 'project-ref').write_text('cxntbdvfsikwmitapony\n')
(project / 'supabase/config.toml').write_text('project_id = "cxntbdvfsikwmitapony"\n')
label = 'ai.vnagent.bmq-supabase-sync'
plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
plist.parent.mkdir(parents=True, exist_ok=True)
logs = base / 'sync-logs'
logs.mkdir(exist_ok=True)
config = {
    'Label': label,
    'ProgramArguments': [str(python), '-m', 'sme_platform.supabase_sync', '--workdir', str(project)],
    'WorkingDirectory': str(release),
    'EnvironmentVariables': {'PYTHONPATH': str(package / 'src'),
                             'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
                             'PYTHONUNBUFFERED': '1'},
    'RunAtLoad': True, 'StartInterval': 900, 'ThrottleInterval': 60,
    'StandardOutPath': str(logs / 'status.log'),
    'StandardErrorPath': str(logs / 'stderr.log'),
}
if plist.exists():
    existing = plistlib.loads(plist.read_bytes())
    if existing != config:
        raise SystemExit('Existing job differs; unload the exact sync job before replacing its plist')
else:
    plist.write_bytes(plistlib.dumps(config))
    plist.chmod(0o600)
print('Prepared ' + str(plist) + ' at source ' + sha)
print('Load with launchctl bootstrap in the user GUI domain; do not restart Gateway.')

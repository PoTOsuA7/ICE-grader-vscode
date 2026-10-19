"""Build the Thonny plug-in (thonny/) and upload it to PyPI, where Thonny's Tools > Manage plug-ins finds it.

Needs twine (python -m pip install twine) and a PyPI API token, read from the PYPI_TOKEN environment variable or
from the file ~/.pypi_token (keep that file out of the repo). The wheel goes up first: Thonny's plug-in manager
reads the requirements from it.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
plugin = os.path.join(root, 'thonny')
meta = tomllib.load(open(os.path.join(plugin, 'pyproject.toml'), 'rb'))['project']
name, version = meta['name'], meta['version']


def token():
    t = os.environ.get('PYPI_TOKEN')
    if not t:
        path = os.path.join(os.path.expanduser('~'), '.pypi_token')
        if os.path.exists(path):
            t = open(path, encoding='utf-8').read()
    if not t or not t.strip():
        sys.exit('No token: set PYPI_TOKEN or save it in ~/.pypi_token')
    return t.strip()


try:
    with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/json', timeout=30) as res:
        if version in json.load(res)['releases']:
            sys.exit(f'{name} {version} is already on PyPI - bump version in thonny/pyproject.toml')
except urllib.error.HTTPError as e:
    if e.code != 404:  # 404: the first upload
        raise

dist = os.path.join(plugin, 'dist')
shutil.rmtree(dist, ignore_errors=True)
subprocess.run([sys.executable, '-m', 'pip', 'wheel', '.', '--no-deps', '-w', dist, '-q'], cwd=plugin, check=True)
shutil.rmtree(os.path.join(plugin, 'build'), ignore_errors=True)
for d in glob.glob(os.path.join(plugin, '*.egg-info')):
    shutil.rmtree(d, ignore_errors=True)
wheels = glob.glob(os.path.join(dist, '*.whl'))
env = dict(os.environ, TWINE_USERNAME='__token__', TWINE_PASSWORD=token())
subprocess.run([sys.executable, '-m', 'twine', 'upload', '--non-interactive', *wheels], env=env, check=True)
print(f'published {name} {version}: https://pypi.org/project/{name}/')

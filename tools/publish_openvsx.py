"""Publish nattee-grader.vsix to Open VSX (the store used by Cursor, Windsurf and VSCodium). No node/ovsx needed.

Needs an Open VSX access token, read from the OVSX_PAT environment variable or from the file ~/.ovsx_token
(keep that file out of the repo). Build first with: python tools/build_vsix.py
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

REGISTRY = 'https://open-vsx.org'
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pkg = json.load(open(os.path.join(root, 'extension', 'package.json'), encoding='utf-8'))
vsix = os.path.join(root, f"{pkg['name']}.vsix")


def token():
    t = os.environ.get('OVSX_PAT')
    if not t:
        path = os.path.join(os.path.expanduser('~'), '.ovsx_token')
        if os.path.exists(path):
            t = open(path, encoding='utf-8').read()
    if not t or not t.strip():
        sys.exit('No token: set OVSX_PAT or save it in ~/.ovsx_token')
    return t.strip()


def post(path, data, content_type):
    # The token goes in the query string, the same way the official ovsx tool sends it (over HTTPS).
    url = f'{REGISTRY}/api/-/{path}?' + urllib.parse.urlencode({'token': token()})
    req = urllib.request.Request(url, data=data, method='POST', headers={'Content-Type': content_type})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except ValueError:
            return e.code, {'error': body.decode('utf-8', 'replace')[:300]}


if not os.path.exists(vsix):
    sys.exit(f'{vsix} not found - run python tools/build_vsix.py first')

ns = pkg['publisher']
status, body = post('namespace/create', json.dumps({'name': ns}).encode(), 'application/json')
if status < 300:
    print(f'created namespace "{ns}"')
elif 'already exists' not in json.dumps(body).lower():
    sys.exit(f'could not create namespace "{ns}" ({status}): {body.get("error", body)}')

status, body = post('publish', open(vsix, 'rb').read(), 'application/octet-stream')
if status >= 300 or body.get('error'):
    sys.exit(f'publish failed ({status}): {body.get("error", body)}')
for w in body.get('warnings') or []:
    print('warning:', w)
print(f"published {ns}.{pkg['name']} {pkg['version']}: {REGISTRY}/extension/{ns}/{pkg['name']}")

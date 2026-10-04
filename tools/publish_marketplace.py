"""Upload nattee-grader.vsix to the VS Code Marketplace as a new version (the extension must already exist there).
No node/vsce needed.

Needs an Azure DevOps personal access token with the "Marketplace: Manage" scope and "All accessible
organizations", read from the VSCE_PAT environment variable or from the file ~/.vsce_token (keep it out of the repo).
Build first with: python tools/build_vsix.py
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pkg = json.load(open(os.path.join(root, 'extension', 'package.json'), encoding='utf-8'))
vsix = os.path.join(root, f"{pkg['name']}.vsix")


def token():
    t = os.environ.get('VSCE_PAT')
    if not t:
        path = os.path.join(os.path.expanduser('~'), '.vsce_token')
        if os.path.exists(path):
            t = open(path, encoding='utf-8').read()
    if not t or not t.strip():
        sys.exit('No token: set VSCE_PAT or save it in ~/.vsce_token')
    return t.strip()


if not os.path.exists(vsix):
    sys.exit(f'{vsix} not found - run python tools/build_vsix.py first')

url = (f"https://marketplace.visualstudio.com/_apis/gallery/publishers/{pkg['publisher']}"
       f"/extensions/{pkg['name']}?api-version=7.1-preview.1")
auth = base64.b64encode(f':{token()}'.encode()).decode()
req = urllib.request.Request(url, data=open(vsix, 'rb').read(), method='PUT', headers={
    'Authorization': f'Basic {auth}', 'Content-Type': 'application/octet-stream', 'Accept': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=300) as res:
        status, body = res.status, res.read()
except urllib.error.HTTPError as e:
    status, body = e.code, e.read()

if status in (401, 403) or (status < 400 and body.lstrip().startswith(b'<')):
    # A bad token gets a 401/403, or a sign-in web page instead of JSON.
    sys.exit(f'token rejected ({status}): it needs the "Marketplace: Manage" scope and "All accessible organizations"')
if status >= 300:
    try:
        msg = json.loads(body).get('message', body[:300])
    except ValueError:
        msg = body[:300]
    sys.exit(f'upload failed ({status}): {msg}')
print(f"uploaded {pkg['publisher']}.{pkg['name']} {pkg['version']} - the Marketplace checks it for a few minutes, then it goes live:\n"
      f"https://marketplace.visualstudio.com/items?itemName={pkg['publisher']}.{pkg['name']}")

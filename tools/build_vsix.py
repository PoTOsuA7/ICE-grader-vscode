"""Package extension/ into nattee-grader.vsix (no node/vsce needed). The same file installs locally and uploads
to the VS Code Marketplace. Install with:
    code --install-extension nattee-grader.vsix
"""
import json
import mimetypes
import os
import zipfile
from xml.sax.saxutils import escape

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ext_dir = os.path.join(root, 'extension')
pkg = json.load(open(os.path.join(ext_dir, 'package.json'), encoding='utf-8'))
out = os.path.join(root, f"{pkg['name']}.vsix")

# Repo-root files the Marketplace page needs, copied into the package the way vsce does.
extra = {'extension/README.md': 'README.md', 'extension/LICENSE.txt': 'LICENSE',
         'extension/THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md'}

repo = pkg['repository']['url']
banner = pkg.get('galleryBanner', {})
props = {
    'Microsoft.VisualStudio.Code.Engine': pkg['engines']['vscode'],
    'Microsoft.VisualStudio.Code.ExtensionDependencies': '',
    'Microsoft.VisualStudio.Code.ExtensionPack': '',
    'Microsoft.VisualStudio.Code.ExtensionKind': 'workspace',
    'Microsoft.VisualStudio.Code.LocalizedLanguages': '',
    'Microsoft.VisualStudio.Services.Links.Source': repo + '.git',
    'Microsoft.VisualStudio.Services.Links.Getstarted': repo + '.git',
    'Microsoft.VisualStudio.Services.Links.GitHub': repo + '.git',
    'Microsoft.VisualStudio.Services.Links.Support': pkg['bugs']['url'],
    'Microsoft.VisualStudio.Services.Links.Learn': pkg['homepage'],
    'Microsoft.VisualStudio.Services.Branding.Color': banner.get('color', '#1e1e1e'),
    'Microsoft.VisualStudio.Services.Branding.Theme': banner.get('theme', 'dark'),
    'Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown': 'true',
    'Microsoft.VisualStudio.Services.Content.Pricing': 'Free',
}
prop_xml = '\n'.join(f'      <Property Id="{k}" Value="{escape(v, {chr(34): "&quot;"})}" />' for k, v in props.items())

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(','.join(pkg.get('keywords', [])))}</Tags>
    <Categories>{escape(','.join(pkg.get('categories', [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
{prop_xml}
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/{pkg['icon']}</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{pkg['icon']}" Addressable="true" />
  </Assets>
</PackageManifest>
'''

entries = {}  # path in zip -> path on disk
for base, dirs, files in os.walk(ext_dir):
    dirs[:] = [d for d in dirs if d != 'tests']  # tests are for the repo, not the installed extension
    for f in files:
        p = os.path.join(base, f)
        entries['extension/' + os.path.relpath(p, ext_dir).replace(os.sep, '/')] = p
for name, src in extra.items():
    entries[name] = os.path.join(root, src)

types = {'.vsixmanifest': 'text/xml', '.json': 'application/json', '.js': 'application/javascript',
         '.md': 'text/markdown', '.txt': 'text/plain', '.png': 'image/png'}
for name in entries:
    e = os.path.splitext(name)[1].lower()
    types.setdefault(e, mimetypes.guess_type(name)[0] or 'application/octet-stream')
content_types = ('<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
                 + ''.join(f'  <Default Extension="{e}" ContentType="{t}" />\n' for e, t in types.items()) + '</Types>\n')

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('extension.vsixmanifest', manifest)
    for name, src in sorted(entries.items()):
        z.write(src, name)
print('wrote', out)

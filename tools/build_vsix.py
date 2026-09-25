"""Package extension/ into nattee-grader.vsix (no node/vsce needed). Install with:
    code --install-extension nattee-grader.vsix
"""
import json
import os
import sys
import zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ext_dir = os.path.join(root, 'extension')
pkg = json.load(open(os.path.join(ext_dir, 'package.json'), encoding='utf-8'))
out = os.path.join(root, f"{pkg['name']}.vsix")

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}" />
    <DisplayName>{pkg['displayName']}</DisplayName>
    <Description xml:space="preserve">{pkg['description']}</Description>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types>
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
'''
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('extension.vsixmanifest', manifest)
    for base, dirs, files in os.walk(ext_dir):
        dirs[:] = [d for d in dirs if d != 'tests']  # tests are for the repo, not the installed extension
        for f in files:
            p = os.path.join(base, f)
            z.write(p, 'extension/' + os.path.relpath(p, ext_dir).replace(os.sep, '/'))
print('wrote', out)

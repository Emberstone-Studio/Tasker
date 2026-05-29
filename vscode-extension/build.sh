#!/bin/bash
set -e
cd "$(dirname "$0")"

BUILD=/tmp/tasker-vsix-build
rm -rf "$BUILD"
mkdir -p "$BUILD/extension/tasker"

# Extension source
cp package.json extension.js "$BUILD/extension/"
sips -z 128 128 ../tasker.png --out "$BUILD/extension/tasker-icon.png"

# README for extension panel
cp ../README.md "$BUILD/extension/"

# Bundled Tasker files (from project root)
cp ../tasker.js ../tasker.html ../README.md "$BUILD/extension/tasker/"

# VSIX manifest
cat > "$BUILD/extension.vsixmanifest" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="tasker" Version="1.2.1" Publisher="emberstone-studio" />
    <DisplayName>Tasker</DisplayName>
    <Description xml:space="preserve">AI task queue manager for Claude Code</Description>
    <Tags/>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties/>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/tasker-icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
EOF

# Content types
cat > "$BUILD/[Content_Types].xml" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".html" ContentType="text/html" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
EOF

cd "$BUILD"
rm -f "$OLDPWD/../tasker.vsix"
zip -r "$OLDPWD/../tasker.vsix" . --exclude "*.DS_Store"
echo "Built: $(dirname "$0")/../tasker.vsix"

#!/bin/zsh
set -eu

if [[ $# -ne 1 ]]; then
  print -u2 "Usage: $0 /absolute/path/to/disposable-zotero-profile"
  exit 64
fi

profile_dir="$1"
if [[ "$profile_dir" != /* ]]; then
  print -u2 "The Zotero profile path must be absolute."
  exit 64
fi

project_dir="${0:A:h:h}"
dist_dir="$project_dir/dist"
extension_file="$profile_dir/extensions/zotero-library-reconciler@cchizinski2.local"

if [[ ! -f "$dist_dir/manifest.json" || ! -f "$dist_dir/bootstrap.js" ]]; then
  print -u2 "Build the plugin first: just build"
  exit 1
fi

mkdir -p "$profile_dir/extensions"
print -r -- "$dist_dir" > "$extension_file"
prefs_file="$profile_dir/prefs.js"
if [[ -f "$prefs_file" ]]; then
  sed -i.bak '/extensions\.lastAppBuildId/d; /extensions\.lastAppVersion/d' "$prefs_file"
fi
print "Linked Zotero Library Reconciler to $profile_dir"
print "Cleared Zotero's extension-discovery cache; restart Zotero to load the plugin."
print "Start Zotero with that disposable profile; never link a production profile."

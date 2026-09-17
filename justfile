default:
    @just --list

install:
    npm install

check:
    npm run typecheck
    npm test

build:
    npm run build

package:
    just build
    cd dist && zip -rFS zotero-library-reconciler.xpi bootstrap.js manifest.json chrome.manifest chrome/content/runtime.js chrome/content/report.xhtml

test:
    npm test

link-dev profile:
    ./scripts/link-dev-plugin.zsh "{{profile}}"

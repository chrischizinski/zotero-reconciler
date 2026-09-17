# Zotero Library Reconciler

Read-only cross-library matching groundwork for Zotero 10.0.x. The initial implementation
contains no import, metadata write, or reconciliation action.

## Development

```sh
just install
just check
just build
```

The generated plugin files are written to `dist/`. Use a separate Zotero development profile
when loading the plugin; do not test against a production library. After a build, link the
generated bundle only to that disposable profile:

```sh
just link-dev /absolute/path/to/disposable-zotero-profile
```

## Current scope

- pure item normalization, blocking, and matching;
- tier-restricted Scholarly Work clustering (§8.2) with whole-cluster denial checks;
- executable regression tests for the §46 fixture table;
- a read-only Zotero adapter and two item-menu commands: **Find Copies in Other Libraries**
  and **Audit Cross-Library Coverage**.

The command scans only other libraries, excludes trashed and child records through Zotero's
`getAll(libraryID, true, false)` API, and displays match evidence. It makes no Zotero writes.

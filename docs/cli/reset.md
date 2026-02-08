---
summary: "CLI reference for `openclaw reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `openclaw reset`

Reset local config/state (keeps the CLI installed).

```bash
freeclaw reset
freeclaw reset --dry-run
freeclaw reset --scope config+creds+sessions --yes --non-interactive
```

## Plan: migrate settings to TOML

**Goal:** replace `settings.json` with `settings.toml` without breaking existing users.

### Steps

1. Add `toml` crate and a `Settings::load` that accepts both formats.
2. On first launch, convert JSON → TOML and keep a backup:
   ```bash
   cp settings.json settings.json.bak
   ```
3. Update docs in `docs/settings.md`.

### Risks

- Comments in TOML will be lost if we round-trip through `serde`.  
  Mitigation: use `toml_edit` for writes.
- Windows paths need escaping: `C:\\Users\\me`.

### Verification

Run:

    cargo test -p settings
    cargo run -- --print-settings

Expected output contains `theme = "paper"`.

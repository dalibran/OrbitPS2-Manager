# Local deployment and dependency review

Reviewed 2026-11-09 from npm audit reports supplied by the developer's terminal.
Reports are ignored by Git. Findings can change as advisories are published;
zero known findings is not a guarantee of security.

## Current findings

- `web`: **0 known vulnerabilities**, following the targeted update to
  `adm-zip` 0.6.1. This fixes the upstream 0.5.x dependency's ZIP allocation and
  extraction advisories. ZIP import remains disabled in the web adapter because
  decompression adds additional resource and archive-validation concerns.
- `angular`: **16 moderate affected-package entries; no high or critical
  entries** after updating within the existing package ranges. These entries
  derive from two advisories in Angular CLI's package-management dependency
  tree: [minimatch globparts amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249)
  and [glob cancellation bypass](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4).
  They are build tooling and are not installed in the Pi runtime described here.
  Builds should use trusted project sources and configuration. Track compatible
  upstream fixes; do not downgrade Angular CLI to 17 or force a transitive major
  override merely to obtain a zero audit count.
- Root Electron/desktop dependencies are preserved from upstream and are not
  installed by the web workflow. This is not a claim that the desktop tree has
  no vulnerabilities.

Run `npm --prefix web audit` and `npm --prefix angular audit` before updates.
Use targeted compatible fixes, preserve lockfiles, and rebuild/test afterward.
Avoid `npm audit fix --force`. Re-run the audit after upstream merges. Install
only `web` production dependencies on the Pi, with `npm --prefix web ci --omit=dev`.

## Application boundary

The default listener is loopback. LAN access is explicit and assumes everyone
on that network is trusted to manage the library. Session tokens prevent
cross-origin API use; they are **not authentication**. The server rejects public
remote IPs, unexpected Host headers and cross-origin requests. It does not
trust reverse-proxy forwarding headers. Do not publish or port-forward it.

RPC operations use a deny-by-default list with path validation, filesystem
containment and checks for symlinks leaving the configured roots. Browser
uploads stream to exclusive temporary files, enforce a per-file size/disk-space
limit, and publish without overwriting another upload. Conversion outputs must
not already exist. Library mutations are serialized within the web service.

These checks do not isolate the service from other programs modifying the
same disk. Run under the provided unprivileged systemd account and filesystem
restrictions. Only trusted users should have filesystem write access to the
library and inbox. Malformed disc images and very large libraries have not been
exhaustively tested. Back up CFG/VMC data before testing maintenance operations.

The cover gallery sends game-title searches to its selected providers. API keys
remain on the server. Downloads are limited to fixed provider hosts over HTTPS,
reject redirects, and have request deadlines/byte limits. Selections use opaque,
expiring result IDs rather than accepting arbitrary client-supplied URLs.
Uploaded/remote covers are restricted to PNG, JPEG or WebP with dimension and
byte limits. Originals are stored independently of OPL files. Image decoding
occurs in the browser; the service does not run a native image converter.

Samba is separate. Standard OPL requires SMBv1, so keep Samba on the PS2-facing
Ethernet interface and use a dedicated share/account. Do not enable legacy SMB
on unrelated shares or expose it to the internet. Playing through Samba while
the manager changes those same game files is not coordinated.

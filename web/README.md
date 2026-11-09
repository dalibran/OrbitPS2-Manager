# OrbitPS2 Web — local network adapter

This fork adds browser access to OrbitPS2 Manager while retaining upstream's
Angular interface, preload API, IPC handlers, services, assets, and workers.
Electron is retained in source for upstream merges, but is neither installed
nor launched by the web workflow.

## Build and run on your computer

Use a currently patched Node.js 22 LTS or 24 LTS release (minimum 22.12).
From the repository root:

```sh
npm --prefix web ci
npm --prefix angular ci
npm --prefix web run build
npm --prefix web test
ORBIT_LIBRARY_ROOT=/absolute/path/to/your/OPL npm --prefix web start
```

Open `http://localhost:3000`. The library directory must already exist. Mount
Directory selects this configured server directory; the browser cannot choose
arbitrary directories on the server. The server creates missing standard OPL
folders at startup, so imports work with an initially empty library.
Imports also recheck these folders and add any that have gone missing. An
existing file that obstructs an OPL folder produces an error; it is never
overwritten. DVD imports require `.iso` or `.zso` source files and preserve
that extension under either OPL naming convention.

For LAN access, explicitly bind to the Pi's LAN address or all its interfaces:

```sh
ORBIT_LIBRARY_ROOT=/srv/ps2 ORBIT_HOST=0.0.0.0 npm --prefix web start
```

Then visit `http://<Pi-LAN-IP>:3000` from your phone or computer. No external
hosting or internet connection is needed for browsing or local management.
Artwork downloads and online metadata still need internet access.

The web build stages a generated copy of Angular, disables its build cache,
and removes its Google Fonts import. System font fallbacks work offline. The
tracked desktop styles and Angular workspace configuration remain unchanged.

## Raspberry Pi 3B+ deployment

The baseline target is Raspberry Pi OS Lite **64-bit** on a Pi 3B+. Its
[1 GB RAM and 64-bit processor](https://www.raspberrypi.com/products/raspberry-pi-3-model-b-plus/)
make building the frontend on your laptop preferable. Runtime dependencies are
JavaScript packages; there is no Electron binary or architecture-specific
conversion executable in this runtime. Other ARM64 Pis should use the same
steps; hardware performance and 32-bit systems have not been verified.

1. Build on your laptop using the commands above.
2. Copy the repository to `/opt/orbitps2-manager` on the Pi, including the
   normally ignored `web/dist/` and `dist/angular/` build directories. Include
   root `assets/` and `package.json`. Exclude `node_modules`, `web/.data`,
   `web/.build-ui`, audit reports, and your game library.
3. On the Pi, install Node.js and run
   `npm --prefix /opt/orbitps2-manager/web ci --omit=dev`.
   **Do not copy laptop node_modules to the Pi.**
4. Mount your game drive at `/srv/ps2`. Create `/srv/ps2-inbox` on storage with
   sufficient space. Create an `orbitps2` system account and grant that account
   read/write access to both directories. Do not recursively change permissions
   on an existing drive without checking its mount options and ownership.
5. Copy `deploy/orbitps2-web.env.example` to `/etc/orbitps2-web.env` and adjust
   paths, hostnames, and port. Copy `deploy/orbitps2-web.service` to
   `/etc/systemd/system/orbitps2-web.service`. Adjust its working directory,
   `ExecStart`, `RequiresMountsFor`, and `ReadWritePaths` if paths differ.
   The example expects the Node executable at `/usr/bin/node`; check `command -v node`.
6. Run `sudo systemctl daemon-reload` and
   `sudo systemctl enable --now orbitps2-web`.
   Inspect logs with `journalctl -u orbitps2-web -f`.

One compression worker and one mutating library operation at a time are the
defaults. Uploads stream to disk one at a time and leave 256 MiB free. Artwork
is streamed individually instead of returning the entire folder as base64.
Browser tiles are capped at 230 CSS pixels wide (180 on narrow screens), show
the full cover without cropping/hover enlargement, and place captions below
the image. PS2 covers use a 7:10 area; PS1/App covers use a square area.
Existing OPL cover resolution remains unchanged: display styling cannot add
detail absent from a low-resolution source image.
Measure memory and loading performance with your own library before increasing
`ORBIT_WORKERS`. Avoid compression or bulk maintenance while the PS2 is playing.

## PS2 connection

The web manager and PS2 file sharing are separate services operating on the
same directory. The PS2 needs a working OPL setup and an Ethernet connection.
[Standard OPL reads SMBv1 shares](https://github.com/ps2homebrew/Open-PS2-Loader#readme).

- **Router:** connect Pi Ethernet and PS2 Ethernet to your router/switch.
  Browsers access the manager over Wi-Fi or Ethernet. Configure OPL with the
  Pi's Ethernet IP and the `PS2SMB` share.
- **Direct:** connect Pi Ethernet to PS2 Ethernet. Assign, for example,
  `192.168.50.1/24` to Pi Ethernet and `192.168.50.2/24` to the PS2, using a
  subnet distinct from your Wi-Fi network. Connect Pi Wi-Fi to your home router
  and browse to the Pi's Wi-Fi IP. No internet forwarding is needed to read games.

`deploy/smb.conf.example` is a starting configuration for a dedicated Pi, not
an automatically applied system change. Install Samba, configure the share,
and create a Samba password for `orbitps2` with `sudo smbpasswd -a orbitps2`.
Enter that username/password in OPL. Check the configuration with `testparm`
before restarting Samba. Authentication compatibility depends on your OPL
build; inspect Samba logs if authentication fails before changing its security
settings. See [Samba's configuration reference](https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html).

SMBv1 is a legacy protocol: keep it on the PS2-facing network, and do not expose
it through router port forwarding. The example binds Samba to Ethernet and
loopback, while the web manager can also be accessed over Wi-Fi.

Automatic hotspot creation, DHCP, routing and OS network configuration are not
implemented by the manager. Direct Ethernet plus existing Wi-Fi is the initial
direct-connect workflow.

## Imports, progress, and limitations

### High-resolution web covers

Open a game's menu in grid or list view and choose **Choose cover…**. Search by
title across Libretro and, when configured, SteamGridDB. Edit the title or
select a source to refine results. Each result shows its source, edition/title
and dimensions; click the image to open an original-size preview, then choose
**Use this cover**. Local PNG, JPEG and WebP uploads are also supported, with a
10 MiB/16 megapixel limit. Close the gallery to refresh the library. **Use OPL
artwork** removes the web preference and returns to the original cover.

Libretro requires no API key. Its title index is cached for 24 hours; PS2
searches include the `Named_Boxarts_1024` collection where available. Searches
can return regional editions and similarly named games, so compare the title
and preview. SteamGridDB provides community covers that may represent other
platforms; results are not automatically assumed to be the PS2 edition.

For SteamGridDB, obtain a personal API key from your account's API preferences
and set `STEAMGRIDDB_API_KEY` in the server environment (or systemd environment
file), then restart the service. The key is never sent to the browser. Without
it, Libretro and local uploads still work. A failed source is shown as a warning
while other sources remain usable. No additional npm dependency is needed.

The full selected image and its source metadata are stored under
`ORBIT_DATA_DIR/web-covers/`, separately for each library root. The tile and
details page use this full-resolution copy, which works offline after saving.
OPL's existing `ART/` images and dimensions are unchanged. Include this data
directory in backups. Changing selections retains previously downloaded image
files in that cache; it does not modify disc images or OPL artwork.

The existing import buttons open a browser picker for uploads or files already
in the server inbox. Upload a CUE sheet and all referenced BIN files together;
they are stored in one batch directory. Files already on the Pi can be placed
in `ORBIT_INBOX` or one child directory. Inbox listings show up to 500 entries.
The inbox is staging storage, not automatically cleaned: remove unused source
files after confirming successful imports and backups.

Library scans, OPL settings, artwork, VMCs, renaming/deletion, PS2 ISO/ZSO,
CUE/BIN conversion, PS1 launchers and homebrew imports reuse upstream handlers.
Native optical-drive ripping and ZIP imports are unavailable in this initial
web adapter. Extract ZIPs before import. Ember directory overrides must remain
within the configured library.

Progress uses server-sent events. An already accepted operation continues if
its browser disconnects; `/api/jobs` exposes the last 32 operation states to a
current browser session. The upstream **batch queue remains in the browser**:
keep the tab open for the whole batch. Restarting the server does not resume
operations. There is no cross-client lock with Samba/OPL, so do not rename,
delete, or convert files currently in use by the PS2.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORBIT_LIBRARY_ROOT` | Required | Existing OPL root on the server |
| `ORBIT_HOST` | `127.0.0.1` | Listening address; set explicitly for LAN |
| `PORT` | `3000` | HTTP port |
| `ORBIT_DATA_DIR` | `web/.data` | Settings and cache directory |
| `ORBIT_INBOX` | `<data>/inbox` | Import staging directory |
| `ORBIT_WORKERS` | `1` | Compression worker count, 1–8 |
| `ORBIT_MAX_UPLOAD_GIB` | `16` | Maximum size per uploaded file |
| `ORBIT_ALLOWED_HOSTS` | Empty | Extra local hostnames, comma-separated |

Private IP clients only; IP addresses of local interfaces, localhost, and the
machine's hostname/`.local` hostname are accepted. Set extra hostnames when
needed and restart after network address changes. No proxy forwarding headers
are trusted. The manager is intended for a trusted home LAN; it has CSRF/origin
checks, but **no user login or per-user permissions**. Every allowed LAN client
can manage the configured library. See [security notes](SECURITY.md).

## Integrating upstream

Keep this fork's changes committed before integrating a release:

```sh
git fetch upstream
git merge upstream/main
npm --prefix web ci
npm --prefix angular ci
npm --prefix web run build
npm --prefix web test
```

Prefer release tags when you want a stable integration point. The server build
transpiles upstream files into `web/dist/src`, substituting the local Electron
adapter only in generated output. It preserves worker/resource paths and
recompiles `src/preload.ts` into the browser bridge, so existing API methods do
not need duplicate implementations. New upstream operations require an explicit
entry in `policy.cjs` before becoming accessible over HTTP. Review new Electron
API usage and runtime dependencies when merging; the bridge is deliberately
small and cannot implement arbitrary Electron APIs automatically.

Tracked frontend differences are limited to hiding desktop controls in a
browser and preferring an optional artwork URL over base64. The Angular lockfile
also includes reviewed updates within upstream's declared dependency ranges.
Root desktop dependencies, services and IPC handlers remain unchanged.

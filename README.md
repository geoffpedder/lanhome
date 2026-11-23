# LAN Home

A self-hosted home page for your local network that looks like [Mafl](https://github.com/hywax/mafl)'s dark theme, with an editor built into the page. Add, edit, reorder and group your links in the browser instead of hand-editing YAML.

It reads and writes Mafl's `config.yml` format, so you can point it at an existing Mafl config and switch between the two.

## Features

- Mafl-style layout: groups of tiles with icon, title and description, responsive column counts
- In-page editor (pencil button, bottom right):
  - edit a tile in a form with a live preview
  - search the [Iconify](https://iconify.design) icon library, or use an image URL
  - colour picker and tile-background toggle per icon
  - drag tiles to reorder them or move them between groups
  - add, rename, reorder and delete groups
  - page title and columns per row
  - appearance: a header with logo, greeting, clock and gradient or image background; accent colour; glass-card tiles
  - raw YAML editor with validation
- Changes are staged until you click **Save** (or press Ctrl+S)
- Every save keeps a timestamped backup of the previous file (last 30 by default)
- Refuses to save over a file that was changed elsewhere since you opened the page
- Optional password for editing
- Icons are fetched from Iconify once and cached on disk
- One small dependency (`yaml`), no build step

## Requirements

Node.js 18 or newer.

## Quick start

```sh
npm ci --omit=dev
CONFIG=./config.yml PORT=3000 node server.js
```

Open `http://<host>:3000` and click the pencil in the bottom-right corner to start editing. If the config file doesn't exist yet, it is created on the first save.

## Configuration

All settings are environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Port to listen on |
| `CONFIG` | `/opt/mafl/data/config.yml` | Path to the config file |
| `BACKUP_DIR` | `backups/` next to the config file | Where backups of previous versions go |
| `KEEP_BACKUPS` | `30` | How many backups to keep |
| `ICON_CACHE` | `./icon-cache` | Where downloaded icons are cached |
| `EDIT_PASSWORD` | *(unset)* | If set, editing and saving require this password |

Without `EDIT_PASSWORD`, anyone who can reach the page can edit it. Set one if the page is reachable by people you don't want editing it.

## Running as a service

`lanhome.service` is an example systemd unit that expects the app in `/opt/lanhome`:

```sh
sudo mkdir -p /opt/lanhome
sudo cp -r package.json package-lock.json server.js public /opt/lanhome/
cd /opt/lanhome && sudo npm ci --omit=dev
sudo cp lanhome.service /etc/systemd/system/
# edit PORT, CONFIG and optionally EDIT_PASSWORD in the unit, then:
sudo systemctl daemon-reload
sudo systemctl enable --now lanhome
```

## Config format

The same as Mafl's. A minimal example:

```yaml
title: Home
grid:
  small: 2
  medium: 2
  large: 3
  xlarge: 4
services:
  Media:
    - title: Plex
      description: media server
      link: http://192.168.1.10:32400/web
      icon:
        name: simple-icons:plex
        wrap: true
        color: "#52b54b"
  Websites:
    - title: Example
      link: https://example.com
      icon:
        url: https://example.com/logo.png
```

- `icon.name` is an Iconify icon name (`prefix:name`); browse them at [icon-sets.iconify.design](https://icon-sets.iconify.design).
- `icon.url` uses an image instead.
- `icon.wrap` draws the tile background behind the icon.
- `icon.color` colours single-colour icons.

### Appearance

The **Appearance** button in edit mode opens a panel that previews changes live. Settings are stored under `appearance` (Mafl ignores this key):

```yaml
appearance:
  header:
    enabled: true
    subtitle: Everything on the home network
    greeting: true          # "Good evening"
    clock: true             # time and date on the right
    size: compact           # compact | tall
    style: aurora           # aurora | sunset | ocean | forest | ember | mono | image
    image: https://example.com/banner.jpg   # used when style is image
    animate: true           # slow drifting background
    logo:
      name: ph:house-line-duotone           # or url: https://…/logo.png, or logo: false for none
  accent: "#8b5cf6"         # glows and highlights
  background: glow          # plain | glow
  tiles: classic            # classic | glass
```

Without an `appearance` section the page uses these defaults (an Aurora header with a house logo, greeting and clock).

Keys the editor doesn't know about are kept when saving. Saving rewrites the file, so comments and custom formatting in it are not preserved.

## API

| Method and path | Purpose |
|---|---|
| `GET /api/config` | Parsed config and file version |
| `PUT /api/config` | Save a config object (`{ config, version }`) |
| `GET /api/raw`, `PUT /api/raw` | Read or save the YAML text (`{ raw, version }`) |
| `POST /api/auth` | Check the edit password (`X-Edit-Password` header) |
| `GET /api/icon-search?q=` | Search Iconify |
| `GET /icon/<prefix>/<name>.svg` | Cached Iconify icon |

Saving requests send the password in the `X-Edit-Password` header when one is set.

## License

[MIT](LICENSE)

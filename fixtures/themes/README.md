# Theme fixtures

One terminal theme in each format `@iirc/frontend/theme-import` reads, laid out as its upstream file is, with the upstream colours. `packages/frontend/src/theme-import.test.ts` reads each.

| File | Format | Palette | Source | Licence |
| --- | --- | --- | --- | --- |
| `gruvbox-dark-medium.yaml` | base16 | Gruvbox dark, medium | [tinted-theming/schemes](https://github.com/tinted-theming/schemes/blob/spec-0.11/base16/gruvbox-dark-medium.yaml) | MIT |
| `dracula-base24.yaml` | base24 | Dracula | [tinted-theming/schemes](https://github.com/tinted-theming/schemes/blob/spec-0.11/base24/dracula.yaml) | MIT |
| `Nord.itermcolors` | iTerm2 | Nord | [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/schemes/Nord.itermcolors) | MIT |
| `nord.toml` | Alacritty | Nord | [alacritty/alacritty-theme](https://github.com/alacritty/alacritty-theme/blob/master/themes/nord.toml) | Apache-2.0 |
| `dracula.conf` | Kitty | Dracula | [dracula/kitty](https://github.com/dracula/kitty/blob/master/dracula.conf) | MIT |
| `ghostty-nord` | Ghostty | Nord | [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/ghostty/Nord) | MIT |
| `dracula.json` | Windows Terminal | Dracula | [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/windowsterminal/Dracula.json) | MIT |

The palettes themselves are Nord's (MIT, Arctic Ice Studio, [licence](https://gh.ali360.cloudns.ch/nordtheme/nord/blob/develop/license)), Dracula's (MIT, Dracula Theme, [licence](https://github.com/dracula/dracula-theme/blob/main/LICENSE)), and Gruvbox's (MIT/X11, Pavel Pertsev, [licence](https://github.com/morhetz/gruvbox#license)).

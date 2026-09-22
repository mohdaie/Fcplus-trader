# FC+ Trader

Phone-first userscript for the EA SPORTS FC Ultimate Team Web App.

## Install once

Install Violentmonkey in Firefox Android, then open:

https://raw.githubusercontent.com/mohdaie/Fcplus-trader/main/fcplus.user.js

Violentmonkey should offer to install the userscript.

## Automatic updates

The installed script contains `@updateURL` and `@downloadURL` metadata pointing back to this repository.

When a newer `@version` is committed to `main`, Violentmonkey can detect and install the update. You no longer need to copy/paste the full script for each change.

Current version: **0.3.1**

## Current features

- Visible market listing scan
- Stable BIN estimation
- Minimum bid detection
- Max-bid calculation using 5% sale tax and minimum-profit target
- Auto bid / rebid flow
- Optional Auto Buy Now
- Auto relist after a won item
- Session time limit
- Maximum trades limit
- Daily estimated-profit target
- Emergency stop
- Dry-run mode

## Testing

Keep **Dry run** enabled after major updates until the market and bid controls are detected correctly.

The daily profit counter currently tracks estimated profit when an item is listed, not confirmed realized profit after sale.

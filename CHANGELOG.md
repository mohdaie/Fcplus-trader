# Changelog

## 0.3.2

- Added full-market multi-page scan from the current Search Results page.
- Added absolute **MIN BIN**, stable BIN, global minimum bid, and calculated max bid.
- Added **SCAN ALL PAGES** control with a configurable page cap (default 40, max 100).
- Full-market valuation is cached for five minutes so the trading loop does not immediately overwrite it with one page.
- Scan stops if Next disappears, results stop changing, or the configured page cap is reached.

## 0.3.1

- Moved FC+ distribution to GitHub.
- Added Violentmonkey automatic update metadata.
- Kept the mobile market scanner, bid/rebid flow, auto relist, and hard session controls.
- Default remains Dry Run enabled for safer testing.

## 0.3.0

- Added stable BIN and minimum bid scanning.
- Added calculated maximum bid.
- Added auto bid/rebid logic.
- Added won-item detection and relisting flow.
- Added session, trade-count, and daily target controls.

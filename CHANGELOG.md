# Changelog

## 0.3.4

- Added **Smart Price** mode.
- Uses FUT.GG structured per-card pricing when its signed price endpoint is available.
- Does not bypass FUT.GG challenges; if FUT.GG returns a challenge, rate limit, or other failure, FC+ automatically falls back to EA.
- Added direct read-only EA market validation through the Web App's own market search service, avoiding UI scrolling for price discovery.
- Added direct EA binary price probing for minimum BIN.
- Added FUT.GG reference, price source, and confidence indicators in the FC+ panel.
- Existing EA UI Fast BIN and full-page scan remain available as fallbacks.
- Fixed sell-form detection so auto-relist can continue after a won-item screen expands into the listing form.

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

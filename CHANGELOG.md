# Changelog

## 0.4.0

- Rebuilt FC+ as an **integrated EA Web App UI** instead of a floating overlay.
- Added an **FC+ bottom navigation item** alongside the Web App tabs.
- Added a full-screen native-styled **FC+ Trader** page for market tools, settings, limits, logs, and start/stop controls.
- Added **FC+ Smart Price** as an action on supported Player Details / Item Details views.
- Existing trading logic continues to run while the FC+ page is hidden.
- Smart Price can also run from a market item-detail screen when the active EA search context is available.
- The old floating FC+ card is removed from normal browsing.

## 0.3.5

- Fixed **EA Fast BIN** and **Smart Price** unexpectedly leaving the FC Web App.
- Removed browser-history navigation from price scanning.
- EA Fast BIN now uses the Web App's in-place read-only market search service.
- Improved current search-criteria detection by supporting both `viewmodel` and `_viewmodel`.
- If direct EA pricing is unavailable, FC+ stays on Search Results and uses visible listings as a low-confidence fallback instead of navigating away.

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

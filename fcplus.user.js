// ==UserScript==
// @name         FC+ Auto Trader Mobile
// @namespace    https://fcplus.local/
// @version      0.9.0
// @description  FC+ market scout, SBC candidate bridge, card pricing and diagnostics for manual EA FC sniping.
// @homepageURL  https://github.com/mohdaie/Fcplus-trader
// @updateURL    https://raw.githubusercontent.com/mohdaie/Fcplus-trader/main/fcplus.user.js
// @downloadURL  https://raw.githubusercontent.com/mohdaie/Fcplus-trader/main/fcplus.user.js
// @match        https://ea.com/*
// @match        https://*.ea.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      www.fut.gg
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  var APP_ID = 'fcplus-scout-v090';
  if (document.getElementById(APP_ID)) return;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function text(v) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim(); }
  function lower(v) { return text(v).toLowerCase(); }
  function coin(v) { return Number(String(v || '').replace(/[^\d]/g, '')) || 0; }
  function today() { return new Date().toISOString().slice(0, 10); }

  var DEFAULTS = {
    dryRun: true,
    autoBid: true,
    autoBuyNow: true,
    autoSell: true,
    minProfit: 300,
    maxBidCap: 0,
    maxBinBuy: 0,
    maxTrades: 10,
    sessionMinutes: 60,
    dailyTarget: 100000,
    pollMs: 2500,
    undercutSteps: 1,
    maxScanPages: 40,
    scanPageDelayMs: 1200,
    showAltPositions: true,
    showCardPrices: true,
    quickFlipQuality: 'silver',
    quickFlipPreferredProfit: 500
  };

  var stored = GM_getValue('fcplus_settings_v031', {}) || {};
  var dailyStored = GM_getValue('fcplus_daily_v031', {}) || {};
  var state = Object.assign({}, DEFAULTS, stored, {
    running: false,
    busy: false,
    timer: null,
    sessionStarted: 0,
    trades: 0,
    lastBidPlaced: 0,
    currentTarget: null,
    lastWinKey: '',
    scanningAll: false,
    fastScanning: false,
    smartScanning: false,
    silverScanning: false,
    quickFlipPreferredProfit: Number(stored.quickFlipPreferredProfit) || 500,
    quickFlipPreferredMs: 45000,
    quickFlipRotateMs: 75000,
    quickFlip: {
      candidate: null,
      scoutResults: [],
      scannedAt: 0,
      scannedListings: 0,
      uniquePlayers: 0,
      checkedPlayers: 0,
      status: 'Ready to scan selected Quick Flip quality'
    },
    logHistory: [],
    lastQuickFlipDecision: '',
    lastQuickFlipDecisionAt: 0,
    liveTrade: null,
    liveBusy: false,
    sbc: {
      scanning: false,
      sets: [],
      selectedSetId: 0,
      challenges: [],
      selectedChallengeId: 0,
      requirements: [],
      scanParams: null,
      playerResults: [],
      selectionSeq: 0,
      status: 'Scan EA SBCs to begin'
    },
    market: {
      absMinBIN: 0,
      stableBIN: 0,
      minBid: 0,
      listings: 0,
      pages: 0,
      probes: 0,
      scannedAt: 0,
      fullScan: false,
      fastScan: false,
      smartScan: false,
      definitionId: 0,
      futggPrice: 0,
      futggSalesMedian: 0,
      futggStatus: 'not checked',
      priceSource: 'PAGE',
      confidence: '—'
    },
    daily: dailyStored.date === today() ? dailyStored : { date: today(), estimatedProfit: 0, realizedProfit: 0, won: 0, listed: 0, sold: 0 }
  });

  state.daily.estimatedProfit = Number(state.daily.estimatedProfit) || 0;
  state.daily.realizedProfit = Number(state.daily.realizedProfit) || 0;
  state.daily.won = Number(state.daily.won) || 0;
  state.daily.listed = Number(state.daily.listed) || 0;
  state.daily.sold = Number(state.daily.sold) || 0;

  // One-time migration: Quick Flip uses both cheap BIN and bid opportunities automatically.
  if (!GM_getValue('fcplus_silver_quickflip_v060_defaults', false)) {
    state.autoBid = true;
    state.autoBuyNow = true;
    state.autoSell = true;
    GM_setValue('fcplus_silver_quickflip_v060_defaults', true);
  }

  GM_setValue('fcplus_daily_v031', state.daily);

  function saveSettings() {
    GM_setValue('fcplus_settings_v031', {
      dryRun: state.dryRun,
      autoBid: state.autoBid,
      autoBuyNow: state.autoBuyNow,
      autoSell: state.autoSell,
      minProfit: state.minProfit,
      maxBidCap: state.maxBidCap,
      maxBinBuy: state.maxBinBuy,
      maxTrades: state.maxTrades,
      sessionMinutes: state.sessionMinutes,
      dailyTarget: state.dailyTarget,
      pollMs: state.pollMs,
      undercutSteps: state.undercutSteps,
      maxScanPages: state.maxScanPages,
      scanPageDelayMs: state.scanPageDelayMs,
      showAltPositions: state.showAltPositions,
      showCardPrices: state.showCardPrices,
      quickFlipQuality: state.quickFlipQuality,
      quickFlipPreferredProfit: state.quickFlipPreferredProfit
    });
  }

  function saveDaily() { GM_setValue('fcplus_daily_v031', state.daily); }

  function visible(el) {
    if (!el || (el.closest && el.closest('#' + APP_ID))) return false;
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function pageText() { return lower(document.body ? document.body.innerText : ''); }

  function pageType() {
    var t = pageText();
    // The expanded sell form still contains the old "congratulations" text.
    // Detect the sell form first so auto-relist can continue.
    if (t.indexOf('list on transfer market') >= 0 && t.indexOf('start price') >= 0 && t.indexOf('buy now price') >= 0) return 'sell';
    if (t.indexOf("congratulations, you've won this item for") >= 0) return 'won';
    if (t.indexOf('search results') >= 0) return 'results';
    if (t.indexOf('item details') >= 0) return 'details';
    if (t.indexOf('player details') >= 0) return 'playerdetails';
    return 'other';
  }

  function timeSeconds(raw) {
    var s = lower(raw), m;
    m = s.match(/(\d+)\s*seconds?/); if (m) return Number(m[1]);
    m = s.match(/(\d+)\s*minutes?/); if (m) return Number(m[1]) * 60;
    m = s.match(/(\d+)\s*hours?/); if (m) return Number(m[1]) * 3600;
    if (s.indexOf('<5 seconds') >= 0) return 4;
    return 999999;
  }

  function parseListing(raw) {
    var s = text(raw);
    var start = s.match(/Start Price:\s*([\d,]+)/i);
    var bid = s.match(/Bid\s*([\d,]+|---)/i);
    var bin = s.match(/Buy Now:\s*([\d,]+)/i);
    var tm = s.match(/Time\s*([^]+)$/i);
    var name = s.split(/Start Price:/i)[0].trim().replace(/^\d+\s*[A-Z]{1,5}\s*/i, '').trim() || 'Item';
    return {
      name: name,
      startPrice: start ? coin(start[1]) : 0,
      currentBid: bid && bid[1] !== '---' ? coin(bid[1]) : 0,
      buyNow: bin ? coin(bin[1]) : 0,
      timeSeconds: tm ? timeSeconds(tm[1]) : 999999
    };
  }

  function listingCards() {
    var found = [], seen = {};
    var nodes = document.querySelectorAll('li,article,section,div');

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      var t = text(el.innerText || '');
      if (!/Start Price:/i.test(t) || !/Buy Now:/i.test(t) || !/\bTime\b/i.test(t)) continue;

      var r = el.getBoundingClientRect();
      if (r.width < 220 || r.height < 70 || r.height > 270) continue;

      var p = parseListing(t);
      if (!p.buyNow) continue;

      var key = Math.round(r.top / 10) + ':' + p.buyNow + ':' + p.startPrice + ':' + p.currentBid;
      if (seen[key]) continue;
      seen[key] = true;

      p.el = el;
      p.top = r.top;
      p.area = r.width * r.height;
      found.push(p);
    }

    found.sort(function (a, b) { return a.area - b.area; });
    var out = [];

    found.forEach(function (item) {
      var duplicate = out.some(function (x) {
        return Math.abs(x.top - item.top) < 30 && x.buyNow === item.buyNow && x.startPrice === item.startPrice;
      });
      if (!duplicate) out.push(item);
    });

    return out;
  }

  function stableBIN(values) {
    var clean = values.filter(Boolean).sort(function (a, b) { return a - b; });
    if (!clean.length) return 0;
    if (clean.length === 1) return clean[0];
    if (clean[1] > clean[0] * 1.15) return clean[1];
    var sample = clean.slice(0, Math.min(5, clean.length));
    return sample[Math.floor((sample.length - 1) / 2)];
  }

  function priceStep(price) {
    if (price <= 1000) return 50;
    if (price <= 10000) return 100;
    if (price <= 50000) return 250;
    if (price <= 100000) return 500;
    return 1000;
  }

  function legalDown(price) {
    var p = Math.max(150, Number(price) || 150);
    var step = priceStep(p);
    return Math.max(150, Math.floor(p / step) * step);
  }

  function maxBidFor(bin) {
    if (!bin) return 0;
    var net = Math.floor(bin * 0.95);
    var maxBid = legalDown(net - state.minProfit);
    if (state.maxBidCap > 0) maxBid = Math.min(maxBid, state.maxBidCap);
    return Math.max(0, maxBid);
  }

  function isSpecialMarketRow(row) {
    var item = row && row.rawItem;
    try {
      if (item && typeof item.isSpecial === 'function') return !!item.isSpecial();
    } catch (e) {}
    return lower(row && row.level).indexOf('special') >= 0;
  }

  function fallbackBaseCardFloor(row) {
    if (!row || isSpecialMarketRow(row)) return 0;

    var rating = Number(row.rating) || 0;
    var rare = !!row.rare;
    var quality = lower(playerQuality(row));

    if (quality === 'bronze') return 150;

    if (quality === 'silver') {
      if (!rare) return 150;
      return rating >= 72 ? 300 : 250;
    }

    if (quality === 'gold') {
      if (!rare) return rating <= 75 ? 300 : 350;
      if (rating <= 75) return 600;
      if (rating <= 81) return 650;
      if (rating <= 84) return 700;
      return 800;
    }

    return 0;
  }

  function effectiveEaPriceFloor(rows) {
    var exact = eaPriceFloor(rows);
    if (exact > 0) return { value: exact, source: 'EA exact' };

    var samples = rows || [];
    var fallbackFloors = samples.map(fallbackBaseCardFloor).filter(function (v) { return v > 0; });
    if (!fallbackFloors.length) return { value: 0, source: 'unavailable' };

    return {
      value: Math.max.apply(Math, fallbackFloors),
      source: 'base-card fallback'
    };
  }

  function eaPriceFloor(rows) {
    var floors = (rows || []).map(function (row) {
      return Number(row && row.priceMin) || 0;
    }).filter(function (value) { return value > 0; });
    return floors.length ? Math.max.apply(Math, floors) : 0;
  }

  function eaPriceCeiling(rows) {
    var ceilings = (rows || []).map(function (row) {
      return Number(row && row.priceMax) || 0;
    }).filter(function (value) { return value > 0; });
    return ceilings.length ? Math.min.apply(Math, ceilings) : 0;
  }

  function quickFlipEntryFor(bin, profitTarget, priceFloor) {
    if (!bin) return 0;
    var net = Math.floor(bin * 0.95);
    var target = Math.max(state.minProfit, Number(profitTarget) || state.minProfit);
    var floor = Math.max(0, Number(priceFloor) || 0);
    var ceiling = legalDown(net - target);

    if (state.maxBidCap > 0) ceiling = Math.min(ceiling, state.maxBidCap);

    // If the profit target requires a price below EA's legal minimum price
    // range, that target is impossible for this card.
    if (floor > 0 && ceiling < floor) return 0;

    return Math.max(floor || 0, ceiling);
  }

  function bestQuickFlipTarget(bin, rows) {
    var net = Math.floor(Number(bin || 0) * 0.95);
    var floorInfo = effectiveEaPriceFloor(rows);
    var floor = floorInfo.value;
    var ceiling = eaPriceCeiling(rows);
    var special = (rows || []).some(isSpecialMarketRow);
    var floorKnown = floor > 0;
    var preferred = Math.max(state.minProfit, state.quickFlipPreferredProfit);
    var maxPossibleProfit = floorKnown ? net - floor : 0;
    var preferredEntry = floorKnown ? quickFlipEntryFor(bin, preferred, floor) : 0;
    var floorEntry = floorKnown ? quickFlipEntryFor(bin, state.minProfit, floor) : 0;

    return {
      priceFloor: floor,
      priceCeiling: ceiling,
      priceFloorSource: floorInfo.source,
      special: special,
      floorKnown: floorKnown,
      netSale: net,
      maxPossibleProfit: maxPossibleProfit,
      preferredTarget: preferred,
      preferredEntry: preferredEntry,
      floorEntry: floorEntry,
      preferredPossible: floorKnown && preferredEntry > 0,
      floorPossible: floorKnown && floorEntry > 0
    };
  }

  function scanMarket() {
    var listings = listingCards();
    if (!listings.length) return [];

    // Preserve an explicit smart / probe / all-pages valuation for five minutes.
    var referenceFresh = (state.market.smartScan || state.market.fastScan || state.market.fullScan) &&
      state.market.scannedAt && (Date.now() - state.market.scannedAt < 5 * 60 * 1000);

    if (!referenceFresh) {
      var bins = listings.map(function (x) { return x.buyNow; }).filter(Boolean).sort(function (a, b) { return a - b; });
      var bids = listings.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean).sort(function (a, b) { return a - b; });

      state.market = {
        absMinBIN: bins[0] || 0,
        stableBIN: stableBIN(bins),
        minBid: bids[0] || 0,
        listings: listings.length,
        pages: 1,
        scannedAt: Date.now(),
        fullScan: false,
        fastScan: false,
        smartScan: false,
        probes: 0,
        definitionId: 0,
        futggPrice: 0,
        futggSalesMedian: 0,
        futggStatus: 'not checked',
        priceSource: 'PAGE',
        confidence: 'LOW'
      };
    }

    renderMarket();
    return listings;
  }

  function listingSignature(listings) {
    return listings.slice(0, 8).map(function (x) {
      return [x.name, x.startPrice, x.currentBid, x.buyNow, x.timeSeconds].join(':');
    }).join('|');
  }

  function nextPageControl() {
    var next = findControl([/^Next(?:\s*[›»>])?$/i, /^Next\b/i]);
    if (!next) return null;
    if (next.disabled || next.getAttribute('aria-disabled') === 'true') return null;
    return next;
  }

  async function waitForNewResults(oldSignature) {
    var deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(250);
      var now = listingCards();
      if (now.length && listingSignature(now) !== oldSignature) return now;
    }
    return null;
  }

  function applyFullMarketAggregate(allListings, pages) {
    var bins = allListings.map(function (x) { return x.buyNow; }).filter(Boolean).sort(function (a, b) { return a - b; });
    var bids = allListings.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean).sort(function (a, b) { return a - b; });

    state.market = {
      absMinBIN: bins[0] || 0,
      stableBIN: stableBIN(bins),
      minBid: bids[0] || 0,
      listings: allListings.length,
      pages: pages,
      scannedAt: Date.now(),
      fullScan: true,
      fastScan: false,
      smartScan: false,
      probes: 0,
      definitionId: 0,
      futggPrice: 0,
      futggSalesMedian: 0,
      futggStatus: 'not checked',
      priceSource: 'EA FULL',
      confidence: 'HIGH'
    };

    renderMarket();
  }

  function medianNumber(values) {
    var list = (values || []).map(Number).filter(function (x) { return Number.isFinite(x) && x > 0; })
      .sort(function (a, b) { return a - b; });
    if (!list.length) return 0;
    var mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
  }

  function pageWindow() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
    } catch (e) {}
    return window;
  }

  function getActiveSearchCriteria() {
    var w = pageWindow();

    // Fast path used by the EA Web App market controllers.
    try {
      var direct = w.getAppMain()
        .getRootViewController()
        .getPresentedViewController()
        .getCurrentViewController()
        .getCurrentController();
      if (direct) {
        if (direct.viewmodel && direct.viewmodel.searchCriteria) return direct.viewmodel.searchCriteria;
        if (direct._viewmodel && direct._viewmodel.searchCriteria) return direct._viewmodel.searchCriteria;
        if (direct.leftController) {
          if (direct.leftController.viewmodel && direct.leftController.viewmodel.searchCriteria) return direct.leftController.viewmodel.searchCriteria;
          if (direct.leftController._viewmodel && direct.leftController._viewmodel.searchCriteria) return direct.leftController._viewmodel.searchCriteria;
        }
      }
    } catch (e) {}

    var app;
    try { app = w.getAppMain && w.getAppMain(); } catch (e) { app = null; }
    if (!app) return null;

    var root;
    try { root = app.getRootViewController && app.getRootViewController(); } catch (e) { root = null; }
    if (!root) return null;

    var queue = [root];
    var seen = [];
    var methodNames = ['getPresentedViewController', 'getCurrentViewController', 'getCurrentController'];

    while (queue.length && seen.length < 80) {
      var node = queue.shift();
      if (!node || seen.indexOf(node) >= 0) continue;
      seen.push(node);

      try {
        if (node.viewmodel && node.viewmodel.searchCriteria) return node.viewmodel.searchCriteria;
      } catch (e) {}
      try {
        if (node._viewmodel && node._viewmodel.searchCriteria) return node._viewmodel.searchCriteria;
      } catch (e) {}

      for (var m = 0; m < methodNames.length; m++) {
        try {
          if (typeof node[methodNames[m]] === 'function') {
            var child = node[methodNames[m]]();
            if (child) queue.push(child);
          }
        } catch (e) {}
      }

      var props = ['leftController', 'rightController', 'currentController', 'presentedViewController'];
      for (var p = 0; p < props.length; p++) {
        try {
          if (node[props[p]]) queue.push(node[props[p]]);
        } catch (e) {}
      }
    }

    return null;
  }

  function currentEaController() {
    var w = pageWindow();
    try {
      return w.getAppMain()
        .getRootViewController()
        .getPresentedViewController()
        .getCurrentViewController()
        .getCurrentController();
    } catch (e) {
      return null;
    }
  }

  function looksLikePlayerItem(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var id = Number(obj.definitionId) || 0;
    if (!id) return false;
    if (obj.type === 'player') return true;
    if (obj._staticData && (obj._staticData.name || obj._staticData.commonName)) return true;
    if (obj._rating || obj.rating || obj.preferredPosition) return true;
    return false;
  }

  function getCurrentPlayerItem() {
    var root = currentEaController();
    if (!root) return null;

    var queue = [{ value: root, depth: 0 }];
    var seen = [];
    var preferredKeys = [
      'data', '_data', 'item', '_item', 'player', '_player',
      'selectedItem', '_selectedItem', 'entity', '_entity',
      'viewmodel', '_viewmodel', 'leftController', 'rightController'
    ];

    while (queue.length && seen.length < 220) {
      var entry = queue.shift();
      var obj = entry.value;
      if (!obj || typeof obj !== 'object' || seen.indexOf(obj) >= 0) continue;
      seen.push(obj);

      if (looksLikePlayerItem(obj)) return obj;
      if (entry.depth >= 4) continue;

      for (var k = 0; k < preferredKeys.length; k++) {
        try {
          var child = obj[preferredKeys[k]];
          if (child && typeof child === 'object') queue.push({ value: child, depth: entry.depth + 1 });
        } catch (e) {}
      }

      // Limited own-property scan catches controller-specific item names without walking the whole app.
      var keys = [];
      try { keys = Object.keys(obj).slice(0, 40); } catch (e) {}
      for (var i = 0; i < keys.length; i++) {
        try {
          var v = obj[keys[i]];
          if (v && typeof v === 'object') queue.push({ value: v, depth: entry.depth + 1 });
        } catch (e) {}
      }
    }

    return null;
  }

  function criteriaForDefinitionId(definitionId, maxBuy) {
    var w = pageWindow();
    var id = Number(definitionId) || 0;
    if (!id || !w.UTSearchCriteriaDTO) return null;

    var criteria = new w.UTSearchCriteriaDTO();
    try { criteria.count = 20; } catch (e) {}
    try { criteria.offset = 0; } catch (e) {}
    try { criteria.maskedDefId = id; } catch (e) {}
    try { criteria.defId = [id]; } catch (e) {}
    try { criteria.isExactSearch = true; } catch (e) {}
    try { criteria.type = (w.SearchType && w.SearchType.PLAYER) || 'player'; } catch (e) {}
    if (maxBuy !== undefined && maxBuy !== null) {
      try { criteria.maxBuy = Math.max(0, Number(maxBuy) || 0); } catch (e) {}
    }
    return criteria;
  }

  function cloneEaCriteria(source, maxBuy) {
    var w = pageWindow();
    if (!source || !w.UTSearchCriteriaDTO) return null;

    var criteria = new w.UTSearchCriteriaDTO();
    var keys = [
      'count', 'offset', 'maskedDefId', 'defId', 'excludeDefIds',
      'league', 'club', 'nation', 'level', 'rarities', 'playStyle',
      'minBid', 'maxBid', 'minBuy', 'maxBuy', 'ovrMin', 'ovrMax',
      'sortBy', 'evolutionStatus', 'icontraits', 'isExactSearch',
      'academyOnly', 'type', 'sort', 'authenticity', 'category',
      'position', 'subtypes', 'zone', 'untradeables', 'cacheable'
    ];

    keys.forEach(function (key) {
      try {
        var value = source[key];
        if (Array.isArray(value)) value = Array.prototype.slice.call(value);
        if (value !== undefined) criteria[key] = value;
      } catch (e) {}
    });

    try { criteria.count = 20; } catch (e) {}
    try { criteria.offset = 0; } catch (e) {}
    if (maxBuy !== undefined && maxBuy !== null) {
      try { criteria.maxBuy = Math.max(0, Number(maxBuy) || 0); } catch (e) {}
    }

    return criteria;
  }

  function normalizeEaItems(items) {
    return Array.prototype.slice.call(items || []).map(function (item) {
      var auction = item && item._auction;
      return {
        auctionId: String(auction && auction.tradeId || ''),
        itemId: String(item && (item.id || item.idStr) || ''),
        definitionId: Number(item && item.definitionId) || 0,
        name: text(item && item._staticData && item._staticData.name),
        rating: Number(item && (item._rating || item.rating)) || 0,
        buyNow: Number(auction && auction.buyNowPrice) || 0,
        startPrice: Number(auction && auction.startingBid) || 0,
        currentBid: Number(auction && auction.currentBid) || 0,
        timeSeconds: Number(auction && auction.expires) || 999999,
        marketAverage: Number(item && item._marketAverage) || 0,
        priceMin: Number(item && item._itemPriceLimits && item._itemPriceLimits.minimum) || 0,
        priceMax: Number(item && item._itemPriceLimits && item._itemPriceLimits.maximum) || 0,
        discardValue: Number(item && (item.discardValue || item._discardValue)) || 0,
        leagueId: Number(item && (item.leagueId || (item._staticData && (item._staticData.leagueId || item._staticData.league)))) || 0,
        clubId: Number(item && (item.teamId || item.clubId || (item._staticData && (item._staticData.teamId || item._staticData.clubId || item._staticData.team)))) || 0,
        nationId: Number(item && (item.nationId || (item._staticData && (item._staticData.nationId || item._staticData.nation)))) || 0,
        rare: !!(item && (item.rareflag || item._rareflag || (item._staticData && item._staticData.rareflag))),
        level: String(item && (item.level || item._level || item.quality || '') || '').toLowerCase(),
        rawItem: item
      };
    }).filter(function (x) { return x.buyNow > 0 || x.startPrice > 0; });
  }

  function eaDirectSearch(maxBuy, definitionIdOverride) {
    return new Promise(function (resolve, reject) {
      var w = pageWindow();
      var services;
      try { services = w.services; } catch (e) { services = null; }

      if (!services || !services.Item || typeof services.Item.searchTransferMarket !== 'function') {
        reject(new Error('EA market service unavailable'));
        return;
      }

      var source = getActiveSearchCriteria();
      var definitionId = Number(definitionIdOverride) || 0;
      var criteria = definitionId
        ? criteriaForDefinitionId(definitionId, maxBuy)
        : (source ? cloneEaCriteria(source, maxBuy) : null);
      if (!criteria) {
        reject(new Error(definitionId ? 'Could not build player market search' : 'Current EA search criteria not found'));
        return;
      }

      try {
        if (typeof services.Item.clearTransferMarketCache === 'function') {
          services.Item.clearTransferMarketCache();
        }
      } catch (e) {}

      var finished = false;
      var timer = setTimeout(function () {
        if (!finished) {
          finished = true;
          reject(new Error('EA direct search timed out'));
        }
      }, 9000);

      function done(response) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        try {
          var data = response && (response.data || response.response);
          var items = data && (data.items || data.itemData);
          if (response && response.success === false) {
            reject(new Error('EA direct search status ' + (response.status || 'failed')));
            return;
          }
          resolve(normalizeEaItems(items || []));
        } catch (e) {
          reject(e);
        }
      }

      try {
        var request = services.Item.searchTransferMarket(criteria, 1);
        if (request && typeof request.observe === 'function') {
          var observer = {};
          request.observe(observer, function (sender, response) {
            try { if (sender && typeof sender.unobserve === 'function') sender.unobserve(observer); } catch (e) {}
            done(response);
          });
        } else if (request && typeof request.then === 'function') {
          request.then(done).catch(function (e) {
            if (!finished) {
              finished = true;
              clearTimeout(timer);
              reject(e);
            }
          });
        } else {
          clearTimeout(timer);
          reject(new Error('Unexpected EA search response'));
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }


  function quickFlipQualityLabel(value) {
    var q = lower(value || state.quickFlipQuality || 'silver');
    if (q === 'bronze') return 'Bronze';
    if (q === 'gold') return 'Gold';
    if (q === 'special') return 'Special';
    return 'Silver';
  }

  function criteriaForQuickFlip() {
    var w = pageWindow();
    if (!w.UTSearchCriteriaDTO) return null;

    var criteria = new w.UTSearchCriteriaDTO();
    var quality = lower(state.quickFlipQuality || 'silver');

    try { criteria.count = 20; } catch (e) {}
    try { criteria.offset = 0; } catch (e) {}
    try { criteria.type = (w.SearchType && w.SearchType.PLAYER) || 'player'; } catch (e) {}
    try { criteria.level = quality === 'special' ? 'any' : quality; } catch (e) {}
    try { criteria.position = 'any'; } catch (e) {}
    try { criteria.nation = -1; } catch (e) {}
    try { criteria.league = -1; } catch (e) {}
    try { criteria.club = -1; } catch (e) {}
    try { criteria.playStyle = -1; } catch (e) {}
    try { criteria.minBid = 0; } catch (e) {}
    try { criteria.maxBid = 0; } catch (e) {}
    try { criteria.minBuy = 0; } catch (e) {}
    try { criteria.maxBuy = 0; } catch (e) {}
    try { criteria.maskedDefId = 0; } catch (e) {}
    try { criteria.isExactSearch = false; } catch (e) {}
    return criteria;
  }

  function matchesQuickFlipQuality(row, quality) {
    return lower(playerQuality(row)) === lower(quality || state.quickFlipQuality || 'silver');
  }

  function eaSearchWithCriteria(criteria, page) {
    return new Promise(function (resolve, reject) {
      var w = pageWindow();
      var services;
      try { services = w.services; } catch (e) { services = null; }

      if (!services || !services.Item || typeof services.Item.searchTransferMarket !== 'function') {
        reject(new Error('EA market service unavailable'));
        return;
      }
      if (!criteria) {
        reject(new Error('EA search criteria unavailable'));
        return;
      }

      try {
        if (typeof services.Item.clearTransferMarketCache === 'function') {
          services.Item.clearTransferMarketCache();
        }
      } catch (e) {}

      var finished = false;
      var timer = setTimeout(function () {
        if (!finished) {
          finished = true;
          reject(new Error('EA silver search timed out'));
        }
      }, 10000);

      function done(response) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          var data = response && (response.data || response.response);
          var items = data && (data.items || data.itemData);
          if (response && response.success === false) {
            reject(new Error('EA silver search status ' + (response.status || 'failed')));
            return;
          }
          resolve(normalizeEaItems(items || []));
        } catch (e) {
          reject(e);
        }
      }

      try {
        var request = services.Item.searchTransferMarket(criteria, Math.max(1, Number(page) || 1));
        if (request && typeof request.observe === 'function') {
          var observer = {};
          request.observe(observer, function (sender, response) {
            try { if (sender && typeof sender.unobserve === 'function') sender.unobserve(observer); } catch (e) {}
            done(response);
          });
        } else if (request && typeof request.then === 'function') {
          request.then(done).catch(function (e) {
            if (!finished) {
              finished = true;
              clearTimeout(timer);
              reject(e);
            }
          });
        } else {
          clearTimeout(timer);
          reject(new Error('Unexpected EA silver search response'));
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }


  function observeEaRequest(request, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!request) {
        reject(new Error('EA service returned no request'));
        return;
      }

      var finished = false;
      var timer = setTimeout(function () {
        if (!finished) {
          finished = true;
          reject(new Error('EA service request timed out'));
        }
      }, timeoutMs || 10000);

      function done(error, response) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        if (response && response.success === false) {
          reject(new Error('EA service status ' + (response.status || (response.error && response.error.code) || 'failed')));
          return;
        }
        resolve(response || {});
      }

      try {
        if (typeof request.observe === 'function') {
          var observer = {};
          request.observe(observer, function (sender, response) {
            try {
              if (sender && typeof sender.unobserve === 'function') sender.unobserve(observer);
            } catch (e) {}
            done(null, response);
          });
        } else if (typeof request.then === 'function') {
          request.then(function (response) { done(null, response); }).catch(function (error) { done(error); });
        } else {
          done(null, request);
        }
      } catch (e) {
        done(e);
      }
    });
  }

  function ownedItemFromResponse(response, fallback) {
    var payload = response && (response.response || response.data || response);
    if (!payload) return fallback || null;
    return payload.item ||
      payload.itemData ||
      (Array.isArray(payload.items) && payload.items[0]) ||
      fallback ||
      null;
  }

  function eaItemId(item) {
    if (!item) return '';
    var direct = item.id || item.idStr;
    if (direct) return String(direct);
    try {
      if (typeof item.getId === 'function') {
        var id = item.getId();
        if (id) return String(id);
      }
    } catch (e) {}
    var nested = item._item || item.itemData || item.data;
    return nested && (nested.id || nested.idStr) ? String(nested.id || nested.idStr) : '';
  }

  function eaAuction(item) {
    if (!item) return null;
    try {
      if (typeof item.getAuctionData === 'function') return item.getAuctionData();
    } catch (e) {}
    return item._auction || null;
  }

  function auctionIsWon(item) {
    var auction = eaAuction(item);
    if (!auction) return false;
    try { if (typeof auction.isWon === 'function') return !!auction.isWon(); } catch (e) {}
    return auction._bidState === 'highest' && (auction._tradeState === 'closed' || Number(auction.expires) <= 0);
  }

  function auctionIsSold(item) {
    var auction = eaAuction(item);
    if (!auction) return false;
    try { if (typeof auction.isSold === 'function') return !!auction.isSold(); } catch (e) {}
    return auction._tradeState === 'closed' && Number(auction.currentBid || 0) > 0;
  }

  function auctionIsExpired(item) {
    var auction = eaAuction(item);
    if (!auction) return false;
    try { if (typeof auction.isExpired === 'function') return !!auction.isExpired(); } catch (e) {}
    return Number(auction.expires) <= 0;
  }

  function auctionIsOutbid(item) {
    var auction = eaAuction(item);
    return !!auction && auction._bidState === 'outbid' && auction._tradeState === 'active';
  }

  async function directEaBid(item, price) {
    var w = pageWindow();
    var services;
    try { services = w.services; } catch (e) { services = null; }
    if (!services || !services.Item || typeof services.Item.bid !== 'function') {
      throw new Error('EA bid service unavailable');
    }
    return observeEaRequest(services.Item.bid(item, price), 12000);
  }

  async function directEaList(item, sellBIN) {
    var w = pageWindow();
    var services;
    try { services = w.services; } catch (e) { services = null; }
    if (!services || !services.Item || typeof services.Item.list !== 'function') {
      throw new Error('EA listing service unavailable');
    }

    var limits = item && item._itemPriceLimits || {};
    var floor = Math.max(0, Number(limits.minimum) || 0);
    var ceiling = Math.max(0, Number(limits.maximum) || 0);
    if (!floor || !ceiling || ceiling < floor) {
      throw new Error('EA price floor unavailable for owned card');
    }

    var requestedBIN = legalDown(sellBIN);
    var legalBIN = Math.max(floor || 150, requestedBIN);
    if (ceiling > 0) legalBIN = Math.min(legalBIN, ceiling);

    var step = priceStep(legalBIN);
    var start = legalDown(Math.max(floor || 150, legalBIN - step));
    if (ceiling > 0) start = Math.min(start, ceiling);
    if (start > legalBIN) start = legalBIN;

    var response = await observeEaRequest(services.Item.list(item, start, legalBIN, 3600), 12000);
    return {
      start: start,
      bin: legalBIN,
      duration: 3600,
      priceFloor: floor,
      priceCeiling: ceiling,
      response: response
    };
  }

  async function requestWatchedItemsDirect() {
    var w = pageWindow();
    var services;
    try { services = w.services; } catch (e) { services = null; }
    if (!services || !services.Item || typeof services.Item.requestWatchedItems !== 'function') return [];
    var response = await observeEaRequest(services.Item.requestWatchedItems(), 10000);
    var payload = response && (response.response || response.data || response);
    return payload && Array.isArray(payload.items) ? payload.items : [];
  }

  async function requestTransferItemsDirect() {
    var w = pageWindow();
    var services;
    try { services = w.services; } catch (e) { services = null; }
    if (!services || !services.Item || typeof services.Item.requestTransferItems !== 'function') return [];
    var response = await observeEaRequest(services.Item.requestTransferItems(), 10000);
    var payload = response && (response.response || response.data || response);
    return payload && Array.isArray(payload.items) ? payload.items : [];
  }

  function sameTrackedItem(item, trade) {
    if (!item || !trade) return false;
    var itemId = eaItemId(item);
    if (trade.itemId && itemId && String(trade.itemId) === String(itemId)) return true;
    var auction = eaAuction(item);
    if (trade.auctionId && auction && String(auction.tradeId || '') === String(trade.auctionId)) return true;
    var definitionId = Number(item.definitionId) || 0;
    return !!trade.definitionId && definitionId === Number(trade.definitionId);
  }

  async function listWonQuickFlipItem(item, trade) {
    var market = Number(trade.market || state.market.stableBIN) || 0;
    if (!market) throw new Error('No sell market price available');

    var step = priceStep(market);
    var sellBIN = legalDown(market - Math.max(0, state.undercutSteps) * step);
    var listed = await directEaList(item, sellBIN);

    trade.itemId = eaItemId(item) || trade.itemId || '';
    trade.sellPrice = listed.bin;
    trade.listedAt = Date.now();
    trade.status = 'listed';
    state.daily.listed++;
    saveDaily();

    log(
      'LISTED · ' + trade.name +
      ' · ' + listed.bin.toLocaleString() +
      ' · 1 hour · bought ' + Number(trade.buyPrice || 0).toLocaleString()
    );
  }

  async function processQuickFlipLiveTrade() {
    var trade = state.liveTrade;
    if (!trade || state.liveBusy) return false;

    state.liveBusy = true;
    try {
      if (trade.status === 'buying' || trade.status === 'submitting_bin') {
        var pendingWatched = await requestWatchedItemsDirect();
        var pendingWon = pendingWatched.find(function (item) {
          return sameTrackedItem(item, trade) && auctionIsWon(item);
        }) || null;

        if (pendingWon) {
          trade.buyPrice = Number(eaAuction(pendingWon) && (eaAuction(pendingWon).currentBid || eaAuction(pendingWon).buyNowPrice)) || trade.buyPrice;
          trade.itemId = eaItemId(pendingWon) || trade.itemId || '';
          trade.status = 'won';
          state.daily.won++;
          saveDaily();
          log('RECOVERED BUY · ' + trade.name + ' @ ' + Number(trade.buyPrice || 0).toLocaleString());
          await listWonQuickFlipItem(pendingWon, trade);
          return true;
        }

        if (Date.now() - Number(trade.startedAt || 0) > 15000) {
          log('BUY NOT CONFIRMED · clearing pending state so FC+ can retry a fresh listing');
          state.liveTrade = null;
          return true;
        }

        log('BUY PENDING · waiting for EA confirmation');
        return true;
      }

      if (trade.status === 'bid') {
        var watched = await requestWatchedItemsDirect();
        var bidItem = watched.find(function (item) { return sameTrackedItem(item, trade); });

        if (!bidItem) {
          log('BID · waiting for Transfer Targets update');
          return true;
        }

        var auction = eaAuction(bidItem);
        var currentBid = Number(auction && (auction.currentBid || auction.startingBid)) || 0;

        if (auctionIsWon(bidItem)) {
          trade.buyPrice = currentBid || trade.buyPrice;
          trade.itemId = eaItemId(bidItem) || trade.itemId || '';
          trade.status = 'won';
          state.daily.won++;
          saveDaily();
          log('WON · ' + trade.name + ' @ ' + Number(trade.buyPrice || 0).toLocaleString());
          await listWonQuickFlipItem(bidItem, trade);
          return true;
        }

        if (auctionIsOutbid(bidItem)) {
          var next = currentBid ? currentBid + priceStep(currentBid) : 0;
          if (next > 0 && next <= trade.maxEntry) {
            log('REBID · ' + trade.name + ' @ ' + next.toLocaleString());
            await directEaBid(bidItem, next);
            trade.buyPrice = next;
          } else {
            log('LOST · ' + trade.name + ' · next bid ' + (next ? next.toLocaleString() : '—') + ' above max ' + trade.maxEntry.toLocaleString());
            state.liveTrade = null;
          }
          return true;
        }

        if (auctionIsExpired(bidItem) && !auctionIsWon(bidItem)) {
          log('LOST · ' + trade.name + ' · auction expired');
          state.liveTrade = null;
          return true;
        }

        log('BID · leading/active @ ' + currentBid.toLocaleString());
        return true;
      }

      if (trade.status === 'listed') {
        var transfer = await requestTransferItemsDirect();
        var listedItem = transfer.find(function (item) { return sameTrackedItem(item, trade); });

        if (!listedItem) {
          log('LISTED · waiting for Transfer List update');
          return true;
        }

        if (auctionIsSold(listedItem)) {
          var auctionData = eaAuction(listedItem);
          var salePrice = Number(auctionData && (auctionData.currentBid || auctionData.buyNowPrice)) || Number(trade.sellPrice) || 0;
          var net = Math.floor(salePrice * 0.95);
          var realized = net - Number(trade.buyPrice || 0);

          state.daily.realizedProfit += realized;
          state.daily.sold++;
          state.trades++;
          saveDaily();

          log(
            'SOLD · ' + trade.name +
            ' · ' + salePrice.toLocaleString() +
            ' · profit ' + (realized >= 0 ? '+' : '') + realized.toLocaleString()
          );

          state.liveTrade = null;
          render();
          return true;
        }

        if (auctionIsExpired(listedItem)) {
          var marketNow = Number(state.market.stableBIN || trade.market) || Number(trade.sellPrice) || 0;
          var relistStep = priceStep(marketNow);
          var relistBIN = legalDown(marketNow - Math.max(0, state.undercutSteps) * relistStep);
          log('RELIST · ' + trade.name + ' · ' + relistBIN.toLocaleString() + ' · 1 hour');
          await directEaList(listedItem, relistBIN);
          trade.sellPrice = relistBIN;
          trade.listedAt = Date.now();
          return true;
        }

        log('LISTED · ' + trade.name + ' · waiting for sale');
        return true;
      }

      return false;
    } finally {
      state.liveBusy = false;
    }
  }

  async function executeQuickFlipDecision(decision, candidate, stable, maxEntry) {
    if (!decision || !decision.row || !decision.row.rawItem) {
      log('LIVE BLOCKED · exact EA item is unavailable for this listing');
      return;
    }

    var price = Number(decision.price) || 0;
    var legalFloor = Number(candidate.priceFloor) ||
      Number(decision.row.priceMin) ||
      fallbackBaseCardFloor(decision.row) ||
      0;

    if (!legalFloor) {
      log('LIVE BLOCKED · minimum price unavailable for exact card');
      return;
    }

    // This is an existing EA market listing. A missing maximum price-range field
    // must not block the purchase: EA has already validated the auction price.
    if (!price || price > maxEntry || price < legalFloor) {
      log(
        'LIVE BLOCKED · entry ' + price.toLocaleString() +
        ' outside strategy range ' + legalFloor.toLocaleString() +
        '–' + maxEntry.toLocaleString()
      );
      return;
    }

    var trade = {
      type: decision.type.toLowerCase(),
      name: candidate.name,
      rating: candidate.rating,
      definitionId: candidate.definitionId,
      auctionId: String(decision.row.auctionId || ''),
      itemId: String(decision.row.itemId || ''),
      buyPrice: price,
      market: stable,
      maxEntry: maxEntry,
      priceFloor: legalFloor,
      priceFloorSource: candidate.priceFloorSource || (decision.row.priceMin ? 'EA exact' : 'base-card fallback'),
      startedAt: Date.now(),
      status: decision.type === 'BIN' ? 'submitting_bin' : 'submitting_bid'
    };

    state.liveTrade = trade;
    log(decision.type + ' SUBMIT · ' + candidate.name + ' @ ' + price.toLocaleString());

    var response;
    try {
      response = await directEaBid(decision.row.rawItem, price);
    } catch (e) {
      log(decision.type + ' ERROR · ' + (e && e.message ? e.message : String(e)));

      if (decision.type === 'BIN') {
        try {
          var watchedAfterError = await requestWatchedItemsDirect();
          var recovered = watchedAfterError.find(function (item) {
            return sameTrackedItem(item, trade) && auctionIsWon(item);
          }) || null;

          if (recovered) {
            trade.itemId = eaItemId(recovered) || trade.itemId || '';
            trade.status = 'won';
            state.daily.won++;
            saveDaily();
            log('RECOVERED BUY · ' + candidate.name + ' @ ' + price.toLocaleString());
            await listWonQuickFlipItem(recovered, trade);
            return;
          }
        } catch (ignore) {}
      }

      state.liveTrade = null;
      log(decision.type + ' FAILED · no EA confirmation; waiting for a fresh listing');
      return;
    }

    if (decision.type === 'BIN') {
      var owned = ownedItemFromResponse(response, null);

      if (!owned) {
        try {
          var watched = await requestWatchedItemsDirect();
          owned = watched.find(function (item) {
            return sameTrackedItem(item, trade) && auctionIsWon(item);
          }) || null;
        } catch (e) {}
      }

      if (!owned) {
        trade.status = 'buying';
        trade.startedAt = Date.now();
        log('BUY ACK · EA accepted request; waiting for owned-card confirmation');
        return;
      }

      trade.itemId = eaItemId(owned) || trade.itemId;
      trade.status = 'won';
      state.daily.won++;
      saveDaily();

      log('BOUGHT · ' + candidate.name + ' @ ' + price.toLocaleString());
      await listWonQuickFlipItem(owned, trade);
    } else {
      trade.status = 'bid';
      log('BID PLACED · ' + candidate.name + ' @ ' + price.toLocaleString());
    }
  }


  function safeArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      if (typeof value.values === 'function') return Array.from(value.values());
    } catch (e) {}
    try {
      if (typeof value.toArray === 'function') return value.toArray();
    } catch (e) {}
    try {
      if (typeof value.length === 'number') return Array.prototype.slice.call(value);
    } catch (e) {}
    return [];
  }

  function sbcService() {
    var w = pageWindow();
    try { return w.services && w.services.SBC; } catch (e) { return null; }
  }

  function sbcEntityId(entity) {
    return Number(entity && (entity.id || entity.setId || entity.challengeId || entity._id)) || 0;
  }

  function sbcEntityName(entity, fallback) {
    return text(entity && (entity.name || entity.localizedName || entity.description || entity._name)) || fallback || 'Unnamed SBC';
  }

  function sbcIsComplete(entity) {
    try { if (entity && typeof entity.isComplete === 'function') return !!entity.isComplete(); } catch (e) {}
    try { if (entity && typeof entity.challengesComplete === 'function') return !!entity.challengesComplete(); } catch (e) {}
    return !!(entity && (entity.complete || entity.completed || entity.status === 'COMPLETED'));
  }

  async function requestSbcSetsDirect() {
    var service = sbcService();
    if (!service || !service.repository) throw new Error('EA SBC service unavailable');

    var sets = [];
    try { sets = safeArray(service.repository.getSets && service.repository.getSets()); } catch (e) {}
    if (!sets.length && typeof service.requestSets === 'function') {
      await observeEaRequest(service.requestSets(), 12000);
      try { sets = safeArray(service.repository.getSets && service.repository.getSets()); } catch (e) {}
    }
    return sets;
  }

  function extractChallengeRequirements(challenge) {
    if (!challenge) return [];
    var sources = [
      challenge.eligibilityRequirements,
      challenge.requirements,
      challenge._eligibilityRequirements,
      challenge._requirements,
      challenge.data && challenge.data.eligibilityRequirements,
      challenge.data && challenge.data.requirements,
      challenge.challengeSquad && challenge.challengeSquad.requirements
    ];
    for (var i = 0; i < sources.length; i++) {
      var rows = safeArray(sources[i]);
      if (rows.length) return rows;
    }
    return [];
  }

  function readRequirementValue(req, keys) {
    for (var i = 0; i < keys.length; i++) {
      try {
        var value = req && req[keys[i]];
        if (value !== undefined && value !== null && value !== '') return value;
      } catch (e) {}
    }
    return null;
  }

  function normalizePredicateValues(raw) {
    var values = safeArray(raw);
    if (!values.length && raw !== undefined && raw !== null && raw !== '') values = [raw];
    return values.map(function (value) {
      if (value && typeof value === 'object') {
        return readRequirementValue(value, ['id','value','assetId','definitionId','leagueId','clubId','nationId','name']) || '';
      }
      return value;
    }).filter(function (value) { return value !== '' && value !== null && value !== undefined; });
  }

  function sbcEligibilityKeyName(key) {
    var w = pageWindow();
    var map = w && w.SBCEligibilityKey;
    if (map && typeof map === 'object') {
      for (var name in map) {
        try { if (map[name] === key) return name; } catch (e) {}
      }
    }
    return text(key);
  }

  function scalarValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.length === 1 ? scalarValue(value[0]) : value.map(scalarValue);
    if (typeof value === 'object') {
      var candidate = readRequirementValue(value, [
        'value','id','count','name','type','key','assetId','leagueId','clubId','nationId','quality','rating'
      ]);
      if (candidate !== null && candidate !== value) return scalarValue(candidate);
    }
    return text(value);
  }

  function qualityFromEligibilityValue(value) {
    var raw = scalarValue(value);
    var n = Number(raw);
    if (n === 1) return 'Bronze';
    if (n === 2) return 'Silver';
    if (n === 3) return 'Gold';
    var s = lower(raw);
    if (s.indexOf('bronze') >= 0) return 'Bronze';
    if (s.indexOf('silver') >= 0) return 'Silver';
    if (s.indexOf('gold') >= 0) return 'Gold';
    return text(raw);
  }

  function normalizeSbcRequirement(req, index) {
    var ctor = '';
    try { ctor = req && req.constructor && req.constructor.name || ''; } catch (e) {}

    var firstKey = null;
    var firstValue = null;
    try {
      if (req && typeof req.getFirstKey === 'function') {
        firstKey = req.getFirstKey();
        if (typeof req.getFirstValue === 'function') firstValue = req.getFirstValue(firstKey);
      }
    } catch (e) {}

    if (firstKey !== null && firstKey !== undefined) {
      var keyName = sbcEligibilityKeyName(firstKey);
      var value = scalarValue(firstValue);
      var row = {
        index: index,
        type: keyName || ctor || ('Requirement ' + (index + 1)),
        scope: '',
        count: 0,
        overall: 0,
        chemistry: 0,
        quality: '',
        predicateType: keyName,
        predicateValues: [],
        value: value,
        raw: req
      };

      if (keyName === 'PLAYER_QUALITY') row.quality = qualityFromEligibilityValue(value);
      else if (keyName === 'TEAM_RATING') row.overall = Number(value) || 0;
      else if (keyName === 'CHEMISTRY_POINTS') row.chemistry = Number(value) || 0;
      else if (/COUNT$/.test(keyName)) row.count = Math.abs(Number(value) || 0);
      else if (keyName === 'LEAGUE_ID' || keyName === 'CLUB_ID' || keyName === 'NATION_ID') {
        row.predicateValues = normalizePredicateValues(value);
      } else if (value !== '') {
        row.predicateValues = normalizePredicateValues(value);
      }
      return row;
    }

    var typeValue = scalarValue(readRequirementValue(req, [
      'challengeTypeName','requirementType','typeName','className','type','_type'
    ]));
    var scopeValue = scalarValue(readRequirementValue(req, ['scope','operation','comparison','_scope']));
    var qualityValue = scalarValue(readRequirementValue(req, ['playerQuality','quality','level']));
    var predicateValue = scalarValue(readRequirementValue(req, ['predicateType','predicate','filterType','_predicateType']));

    return {
      index: index,
      type: text(typeValue || ctor || ('Requirement ' + (index + 1))),
      scope: text(scopeValue || ''),
      count: Number(readRequirementValue(req, ['count','requiredCount','minCount','valueCount'])) || 0,
      overall: Number(readRequirementValue(req, ['overallValue','overall','rating','minRating'])) || 0,
      chemistry: Number(readRequirementValue(req, ['chemistryValue','chemistry','minChemistry'])) || 0,
      quality: text(qualityValue || ''),
      predicateType: text(predicateValue || ''),
      predicateValues: normalizePredicateValues(
        readRequirementValue(req, ['predicateValues','values','value','ids','_predicateValues'])
      ),
      raw: req
    };
  }

  function eaRepositoryEntity(kind, id) {
    id = Number(id) || 0;
    if (!id) return null;

    var w = pageWindow();
    var repos = w && w.repositories;
    if (!repos) return null;

    var names = kind === 'league' ? ['League','TeamConfig'] :
      kind === 'club' ? ['Team','Club','TeamConfig'] :
      ['Nation','Nationality','TeamConfig'];

    var methods = kind === 'league'
      ? ['getLeagueById','getById','get','findById']
      : kind === 'club'
        ? ['getTeamById','getClubById','getById','get','findById']
        : ['getNationById','getNationalityById','getById','get','findById'];

    for (var n = 0; n < names.length; n++) {
      var repo = repos[names[n]];
      if (!repo) continue;

      if (kind === 'league' && typeof repo.getLeagues === 'function') {
        try {
          var leagues = safeArray(repo.getLeagues());
          var league = leagues.find(function (x) { return Number(x && x.id) === id; });
          if (league) return league;
        } catch (e) {}
      }

      if (kind === 'club' && typeof repo.getTeams === 'function') {
        try {
          var teams = safeArray(repo.getTeams());
          var team = teams.find(function (x) { return Number(x && x.id) === id; });
          if (team) return team;
        } catch (e) {}
      }

      if (kind === 'nation' && typeof repo.getNations === 'function') {
        try {
          var nations = safeArray(repo.getNations());
          var nation = nations.find(function (x) { return Number(x && x.id) === id; });
          if (nation) return nation;
        } catch (e) {}
      }

      for (var m = 0; m < methods.length; m++) {
        try {
          if (typeof repo[methods[m]] === 'function') {
            var found = repo[methods[m]](id);
            if (found) return found;
          }
        } catch (e) {}
      }

      try {
        var collection = repo._collection || repo.items || repo.data;
        if (collection) {
          if (collection[id]) return collection[id];
          if (typeof collection.get === 'function') {
            var got = collection.get(id);
            if (got) return got;
          }
          var values = safeArray(collection);
          var match = values.find(function (x) { return Number(x && x.id) === id; });
          if (match) return match;
        }
      } catch (e) {}
    }

    return null;
  }

  function localizeEaLabel(value) {
    var label = text(value);
    if (!label) return '';
    var w = pageWindow();
    try {
      var service = w.services && w.services.Localization;
      if (service && typeof service.localize === 'function') {
        var localized = service.localize(label);
        if (localized && localized !== label) return text(localized);
      }
    } catch (e) {}
    return label;
  }

  function entityName(kind, id) {
    var entity = eaRepositoryEntity(kind, id);
    if (!entity) return id ? (kind + ' ' + id) : '—';

    var candidates = [
      entity.name,
      entity.localizedName,
      entity.displayName,
      entity.fullName,
      entity.abbreviation,
      entity.abbrName,
      entity._name
    ];
    for (var i = 0; i < candidates.length; i++) {
      var value = localizeEaLabel(candidates[i]);
      if (value && value !== '[object Object]') return value;
    }
    return id ? (kind + ' ' + id) : '—';
  }

  function countryFlag(name, entity) {
    var code = '';
    var candidates = entity ? [
      entity.countryCode, entity.isoCode, entity.iso2, entity.alpha2,
      entity.abbreviation, entity.abbrName
    ] : [];
    for (var i = 0; i < candidates.length; i++) {
      var candidate = text(candidates[i]).toUpperCase();
      if (/^[A-Z]{2}$/.test(candidate)) { code = candidate; break; }
    }

    if (!code) {
      var map = {
        'argentina':'AR','australia':'AU','austria':'AT','belgium':'BE','brazil':'BR',
        'canada':'CA','chile':'CL','china pr':'CN','china':'CN','colombia':'CO','croatia':'HR',
        'czech republic':'CZ','czechia':'CZ','denmark':'DK','ecuador':'EC','england':'GB',
        'finland':'FI','france':'FR','germany':'DE','ghana':'GH','greece':'GR','hungary':'HU',
        'iceland':'IS','india':'IN','ireland':'IE','italy':'IT','japan':'JP','korea republic':'KR',
        'south korea':'KR','malaysia':'MY','mexico':'MX','morocco':'MA','netherlands':'NL',
        'new zealand':'NZ','nigeria':'NG','norway':'NO','paraguay':'PY','peru':'PE','poland':'PL',
        'portugal':'PT','romania':'RO','saudi arabia':'SA','scotland':'GB','senegal':'SN',
        'serbia':'RS','singapore':'SG','slovakia':'SK','slovenia':'SI','south africa':'ZA',
        'spain':'ES','sweden':'SE','switzerland':'CH','tunisia':'TN','turkey':'TR','türkiye':'TR',
        'ukraine':'UA','united states':'US','usa':'US','uruguay':'UY','wales':'GB'
      };
      code = map[lower(name)] || '';
    }

    if (!code) return '';
    return code.replace(/./g, function (char) {
      return String.fromCodePoint(127397 + char.charCodeAt(0));
    });
  }

  function playerQuality(row) {
    var item = row && row.rawItem;
    try { if (item && typeof item.isSpecial === 'function' && item.isSpecial()) return 'Special'; } catch (e) {}
    try { if (item && typeof item.isGoldRating === 'function' && item.isGoldRating()) return 'Gold'; } catch (e) {}
    try { if (item && typeof item.isSilverRating === 'function' && item.isSilverRating()) return 'Silver'; } catch (e) {}
    try { if (item && typeof item.isBronzeRating === 'function' && item.isBronzeRating()) return 'Bronze'; } catch (e) {}

    var level = lower(row && row.level);
    if (level.indexOf('gold') >= 0) return 'Gold';
    if (level.indexOf('silver') >= 0) return 'Silver';
    if (level.indexOf('bronze') >= 0) return 'Bronze';

    var rating = Number(row && row.rating) || 0;
    if (rating >= 75) return 'Gold';
    if (rating >= 65) return 'Silver';
    return 'Bronze';
  }

  function enrichPlayerMetadata(row) {
    var staticData = row && row.rawItem && row.rawItem._staticData || {};
    if (!row.clubId) row.clubId = Number(row.rawItem && (row.rawItem.teamId || row.rawItem.clubId) || staticData.teamId || staticData.clubId) || 0;
    if (!row.leagueId) row.leagueId = Number(row.rawItem && row.rawItem.leagueId || staticData.leagueId) || 0;
    if (!row.nationId) row.nationId = Number(row.rawItem && row.rawItem.nationId || staticData.nationId) || 0;

    row.qualityLabel = playerQuality(row);
    row.clubName = entityName('club', row.clubId);
    row.leagueName = entityName('league', row.leagueId);
    row.nationName = entityName('nation', row.nationId);
    row.nationFlag = countryFlag(row.nationName, eaRepositoryEntity('nation', row.nationId));
    return row;
  }

  function requirementEntityLabel(kind, values) {
    if (!values || values.length !== 1) return values && values.length ? values.join(', ') : '';
    var id = Number(values[0]) || 0;
    return id ? entityName(kind, id) : text(values[0]);
  }

  function sbcRequirementText(row) {
    var key = text(row.predicateType || row.type).toUpperCase();

    if (key === 'PLAYER_QUALITY') return 'Player quality · ' + (row.quality || text(row.value) || 'Any');
    if (key === 'LEAGUE_ID') return 'League · ' + requirementEntityLabel('league', row.predicateValues);
    if (key === 'CLUB_ID') return 'Club · ' + requirementEntityLabel('club', row.predicateValues);
    if (key === 'NATION_ID') return 'Nation · ' + requirementEntityLabel('nation', row.predicateValues);
    if (key === 'TEAM_RATING') return 'Squad rating · ' + (row.overall || row.value || '—');
    if (key === 'CHEMISTRY_POINTS') return 'Squad chemistry · ' + (row.chemistry || row.value || '—');
    if (key === 'SAME_CLUB_COUNT') return 'Players from same club · ' + (row.count || row.value || '—');
    if (key === 'SAME_LEAGUE_COUNT') return 'Players from same league · ' + (row.count || row.value || '—');
    if (key === 'SAME_NATION_COUNT') return 'Players from same nation · ' + (row.count || row.value || '—');
    if (key === 'LEAGUE_COUNT') return 'Leagues in squad · ' + (row.count || row.value || '—');
    if (key === 'CLUB_COUNT') return 'Clubs in squad · ' + (row.count || row.value || '—');
    if (key === 'NATION_COUNT') return 'Nations in squad · ' + (row.count || row.value || '—');
    if (key === 'PLAYER_COUNT') return 'Player count · ' + (row.count || row.value || '—');

    var parts = [text(row.type || 'Requirement')];
    if (row.scope) parts.push(row.scope);
    if (row.count) parts.push('count ' + row.count);
    if (row.overall) parts.push('rating ' + row.overall);
    if (row.chemistry) parts.push('chem ' + row.chemistry);
    if (row.quality) parts.push(row.quality);
    if (row.predicateValues && row.predicateValues.length) parts.push(row.predicateValues.join(', '));
    return parts.join(' · ');
  }

  function deriveSbcScanParams(requirements) {
    var params = {
      level: 'any',
      minRating: 0,
      maxRating: 0,
      nationId: -1,
      leagueId: -1,
      clubId: -1,
      rareOnly: false,
      mapped: [],
      unmapped: []
    };

    requirements.forEach(function (row) {
      var key = text(row.predicateType || row.type).toUpperCase();
      var mapped = false;

      if (key === 'PLAYER_QUALITY') {
        var q = lower(row.quality || row.value);
        if (q.indexOf('bronze') >= 0) params.level = 'bronze';
        else if (q.indexOf('silver') >= 0) params.level = 'silver';
        else if (q.indexOf('gold') >= 0) params.level = 'gold';
        if (params.level !== 'any') mapped = true;
      }

      if (row.predicateValues && row.predicateValues.length === 1) {
        var id = Number(row.predicateValues[0]) || 0;
        if (key === 'LEAGUE_ID' && id) { params.leagueId = id; mapped = true; }
        if (key === 'NATION_ID' && id) { params.nationId = id; mapped = true; }
        if (key === 'CLUB_ID' && id) { params.clubId = id; mapped = true; }
      }

      // EA's own Squad Builder applies only CLUB_ID, LEAGUE_ID, NATION_ID and PLAYER_QUALITY
      // as individual-player search filters. Rating, chemistry and count rules remain squad-level.
      (mapped ? params.mapped : params.unmapped).push(sbcRequirementText(row));
    });

    return params;
  }

  function criteriaForSbcScan(params) {
    var w = pageWindow();
    if (!w.UTSearchCriteriaDTO) return null;
    var criteria = new w.UTSearchCriteriaDTO();

    try { criteria.count = 20; } catch (e) {}
    try { criteria.offset = 0; } catch (e) {}
    try { criteria.type = (w.SearchType && w.SearchType.PLAYER) || 'player'; } catch (e) {}
    try { criteria.level = params.level && params.level !== 'any' ? params.level : 'any'; } catch (e) {}
    try { criteria.position = 'any'; } catch (e) {}
    try { criteria.nation = params.nationId > 0 ? params.nationId : -1; } catch (e) {}
    try { criteria.league = params.leagueId > 0 ? params.leagueId : -1; } catch (e) {}
    try { criteria.club = params.clubId > 0 ? params.clubId : -1; } catch (e) {}
    try { criteria.ovrMin = params.minRating > 0 ? params.minRating : 0; } catch (e) {}
    try { criteria.ovrMax = params.maxRating > 0 ? params.maxRating : 0; } catch (e) {}
    try { criteria.minBid = 0; criteria.maxBid = 0; criteria.minBuy = 0; criteria.maxBuy = 0; } catch (e) {}
    try { criteria.maskedDefId = 0; criteria.isExactSearch = false; } catch (e) {}
    return criteria;
  }

  function playerMatchesSbcParams(row, params) {
    if (!row) return false;
    if (params.minRating && row.rating < params.minRating) return false;
    if (params.maxRating && row.rating > params.maxRating) return false;
    if (params.nationId > 0 && row.nationId && row.nationId !== params.nationId) return false;
    if (params.leagueId > 0 && row.leagueId && row.leagueId !== params.leagueId) return false;
    if (params.clubId > 0 && row.clubId && row.clubId !== params.clubId) return false;
    if (params.rareOnly && !row.rare) return false;
    return true;
  }

  function renderSbcPanel() {
    var sbc = state.sbc || {};
    var status = document.querySelector('#fcp-sbc-status');
    var setsBox = document.querySelector('#fcp-sbc-sets');
    var challengesBox = document.querySelector('#fcp-sbc-challenges');
    var reqBox = document.querySelector('#fcp-sbc-reqs');
    var playersBox = document.querySelector('#fcp-sbc-players');
    var scanReq = document.querySelector('#fcp-sbc-scanplayers');

    if (status) status.textContent = sbc.status || 'Scan EA SBCs to begin';

    if (setsBox) {
      setsBox.innerHTML = '';
      (sbc.sets || []).forEach(function (set) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'fcp-sbc-choice' + (Number(sbc.selectedSetId) === Number(set.id) ? ' selected' : '');
        button.textContent = set.name + (set.complete ? ' · complete' : '');
        button.disabled = !!set.complete;
        button.addEventListener('click', function () { selectSbcSet(set.id); });
        setsBox.appendChild(button);
      });
    }

    if (challengesBox) {
      challengesBox.innerHTML = '';
      (sbc.challenges || []).forEach(function (challenge) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'fcp-sbc-choice small' + (Number(sbc.selectedChallengeId) === Number(challenge.id) ? ' selected' : '');
        button.textContent = challenge.name;
        button.addEventListener('click', function () { selectSbcChallenge(challenge.id); });
        challengesBox.appendChild(button);
      });
    }

    if (reqBox) {
      reqBox.innerHTML = '';
      if (!(sbc.requirements || []).length) {
        var empty = document.createElement('div');
        empty.className = 'fcp-sbc-empty';
        empty.textContent = sbc.selectedChallengeId ? 'No requirements loaded yet' : 'Choose an SBC challenge';
        reqBox.appendChild(empty);
      } else {
        sbc.requirements.forEach(function (row) {
          var div = document.createElement('div');
          div.className = 'fcp-sbc-req';
          div.textContent = sbcRequirementText(row);
          reqBox.appendChild(div);
        });
      }
    }

    if (scanReq) scanReq.disabled = !sbc.selectedChallengeId || !(sbc.requirements || []).length || !!sbc.scanning;

    if (playersBox) {
      playersBox.innerHTML = '';
      (sbc.playerResults || []).slice(0, 12).forEach(function (row) {
        enrichPlayerMetadata(row);

        var div = document.createElement('div');
        div.className = 'fcp-sbc-player';

        var details = document.createElement('b');
        var nation = (row.nationFlag ? row.nationFlag + ' ' : '') + (row.nationName || '—');
        details.textContent =
          row.name + ' · ' + row.rating +
          ' | ' + (row.qualityLabel || '—') +
          ' | ' + (row.clubName || '—') +
          ' | ' + (row.leagueName || '—') +
          ' | ' + nation;

        var actions = document.createElement('div');
        actions.className = 'fcp-sbc-player-actions';

        var price = document.createElement('span');
        price.textContent = (row.buyNow ? row.buyNow.toLocaleString() : '—') + ' BIN';

        var scan = document.createElement('button');
        scan.type = 'button';
        scan.className = 'fcp-sbc-quickscan';
        scan.textContent = 'SCAN';
        scan.addEventListener('click', function () {
          scanSbcPlayerForQuickFlip(row, scan);
        });

        actions.appendChild(price);
        actions.appendChild(scan);
        div.appendChild(details);
        div.appendChild(actions);
        playersBox.appendChild(div);
      });
    }
  }

  async function scanSbcSets() {
    if (state.sbc.scanning) return;
    state.sbc.scanning = true;
    state.sbc.status = 'Scanning EA SBC list…';
    renderSbcPanel();
    log('SBC · scanning available SBCs');

    try {
      var sets = await requestSbcSetsDirect();
      state.sbc.sets = sets.map(function (entity) {
        return {
          id: sbcEntityId(entity),
          name: sbcEntityName(entity, 'SBC'),
          complete: sbcIsComplete(entity),
          entity: entity
        };
      }).filter(function (set) { return set.id && set.name; })
        .sort(function (a, b) {
          if (a.complete !== b.complete) return a.complete ? 1 : -1;
          return a.name.localeCompare(b.name);
        });

      state.sbc.status = state.sbc.sets.length + ' SBCs found · choose one';
      log('SBC · found ' + state.sbc.sets.length + ' sets');
    } catch (e) {
      state.sbc.status = 'SBC scan failed · ' + (e && e.message ? e.message : String(e));
      log(state.sbc.status);
    } finally {
      state.sbc.scanning = false;
      renderSbcPanel();
    }
  }

  async function requestChallengesForSbcSet(setEntity) {
    var service = sbcService();
    if (!service || typeof service.requestChallengesForSet !== 'function') {
      throw new Error('EA SBC challenge service unavailable');
    }
    var response = await observeEaRequest(service.requestChallengesForSet(setEntity), 12000);
    var payload = response && (response.data || response.response || response);
    return safeArray(payload && payload.challenges);
  }

  async function selectSbcSet(setId) {
    var selected = (state.sbc.sets || []).find(function (set) { return Number(set.id) === Number(setId); });
    if (!selected) return;

    state.sbc.selectionSeq++;
    state.sbc.selectedSetId = selected.id;
    state.sbc.selectedChallengeId = 0;
    state.sbc.challenges = [];
    state.sbc.requirements = [];
    state.sbc.playerResults = [];
    state.sbc.status = 'Scanning requirements · ' + selected.name;
    renderSbcPanel();
    log('SBC · selected ' + selected.name);

    try {
      var challenges = await requestChallengesForSbcSet(selected.entity);
      state.sbc.challenges = challenges.map(function (challenge, index) {
        return {
          id: sbcEntityId(challenge) || (index + 1),
          name: sbcEntityName(challenge, 'Challenge ' + (index + 1)),
          entity: challenge
        };
      });
      state.sbc.status = state.sbc.challenges.length + ' challenge(s) · choose one';
      renderSbcPanel();

      if (state.sbc.challenges.length === 1) {
        await selectSbcChallenge(state.sbc.challenges[0].id);
      }
    } catch (e) {
      state.sbc.status = 'Requirement scan failed · ' + (e && e.message ? e.message : String(e));
      log(state.sbc.status);
      renderSbcPanel();
    }
  }

  async function loadSbcChallengeDetails(challenge) {
    var requirements = extractChallengeRequirements(challenge);
    if (requirements.length) return challenge;

    var service = sbcService();
    if (!service) return challenge;

    try {
      if (typeof service.loadChallenge === 'function') {
        var response = await observeEaRequest(service.loadChallenge(challenge), 12000);
        var payload = response && (response.data || response.response || response);
        if (payload && typeof challenge.update === 'function') {
          try { challenge.update(payload); } catch (e) {}
        }
        if (extractChallengeRequirements(payload).length) return payload;
      }
    } catch (e) {}

    try {
      if (typeof service.loadChallengeData === 'function') {
        var response2 = await observeEaRequest(service.loadChallengeData(challenge), 12000);
        var payload2 = response2 && (response2.data || response2.response || response2);
        if (extractChallengeRequirements(payload2).length) return payload2;
      }
    } catch (e) {}

    return challenge;
  }

  async function selectSbcChallenge(challengeId) {
    var selected = (state.sbc.challenges || []).find(function (challenge) {
      return Number(challenge.id) === Number(challengeId);
    });
    if (!selected) return;

    var selectionSeq = ++state.sbc.selectionSeq;
    state.sbc.selectedChallengeId = selected.id;
    state.sbc.requirements = [];
    state.sbc.playerResults = [];
    state.sbc.status = 'Reading requirements · ' + selected.name;
    renderSbcPanel();
    log('SBC · challenge ' + selected.name);

    try {
      var detailed = await loadSbcChallengeDetails(selected.entity);
      if (selectionSeq !== state.sbc.selectionSeq) return;
      var requirements = extractChallengeRequirements(detailed).map(normalizeSbcRequirement);
      state.sbc.requirements = requirements;
      state.sbc.scanParams = deriveSbcScanParams(requirements);
      state.sbc.status = requirements.length
        ? requirements.length + ' requirement(s) loaded'
        : 'EA returned no readable requirements for this challenge';
      log('SBC · ' + selected.name + ' · ' + requirements.length + ' requirements');
    } catch (e) {
      if (selectionSeq !== state.sbc.selectionSeq) return;
      state.sbc.status = 'Requirement read failed · ' + (e && e.message ? e.message : String(e));
      log(state.sbc.status);
    }

    if (selectionSeq === state.sbc.selectionSeq) renderSbcPanel();
  }


  async function scanSbcPlayerForQuickFlip(row, button) {
    if (!row || !row.definitionId) {
      log('SBC → QUICK FLIP · player ID unavailable');
      return;
    }

    if (state.liveTrade) {
      log('SBC → QUICK FLIP · finish the active trade before switching player');
      return;
    }

    if (state.running) stop('Switching Quick Flip candidate from SBC');

    enrichPlayerMetadata(row);
    var quality = lower(row.qualityLabel || playerQuality(row) || 'silver');
    if (['bronze','silver','gold','special'].indexOf(quality) < 0) quality = 'silver';

    state.quickFlipQuality = quality;
    saveSettings();
    state.quickFlip.candidate = null;
    state.quickFlip.status = 'Scanning ' + row.name + ' exact market…';
    state.quickFlip.scannedAt = 0;
    state.quickFlip.scannedListings = 0;
    state.quickFlip.uniquePlayers = 1;
    state.quickFlip.checkedPlayers = 0;
    render();

    var oldText = button && button.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = 'SCANNING…';
    }

    log(
      'SBC → QUICK FLIP · ' + row.name + ' ' + row.rating +
      ' · quality ' + quickFlipQualityLabel()
    );

    try {
      var rows = await eaDirectSearch(0, row.definitionId);
      var bins = rows.map(function (x) { return x.buyNow; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });

      if (bins.length < 2) {
        throw new Error('Not enough live listings to price this player safely');
      }

      var stable = stableBIN(bins);
      var minBin = bins[0] || 0;
      var minBid = rows.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean)
        .sort(function (a, b) { return a - b; })[0] || 0;
      var targetInfo = bestQuickFlipTarget(stable, rows);
      var netSale = targetInfo.netSale;

      if (!targetInfo.floorKnown) {
        throw new Error('EA price floor unavailable for this card');
      }

      if (!targetInfo.floorPossible) {
        throw new Error(
          'EA price range ' + targetInfo.priceFloor.toLocaleString() + '–' + targetInfo.priceCeiling.toLocaleString() +
          ' leaves only ' + (targetInfo.maxPossibleProfit >= 0 ? '+' : '') +
          targetInfo.maxPossibleProfit.toLocaleString() +
          ' max profit; below floor +' + state.minProfit.toLocaleString()
        );
      }

      var activeTarget = targetInfo.preferredPossible
        ? targetInfo.preferredTarget
        : state.minProfit;
      var maxBid = targetInfo.preferredPossible
        ? targetInfo.preferredEntry
        : targetInfo.floorEntry;

      var immediate = rows.filter(function (x) {
        var bid = x.currentBid || x.startPrice;
        return (x.buyNow > 0 && (!targetInfo.priceFloor || x.buyNow >= targetInfo.priceFloor) && x.buyNow <= maxBid) ||
          (bid > 0 && (!targetInfo.priceFloor || bid >= targetInfo.priceFloor) && bid <= maxBid && x.timeSeconds <= 120);
      }).sort(function (a, b) {
        var ae = Math.min(a.buyNow || Infinity, a.currentBid || a.startPrice || Infinity);
        var be = Math.min(b.buyNow || Infinity, b.currentBid || b.startPrice || Infinity);
        return ae - be;
      })[0] || null;

      var currentEntry = immediate
        ? Math.min(immediate.buyNow || Infinity, immediate.currentBid || immediate.startPrice || Infinity)
        : minBin;
      if (!Number.isFinite(currentEntry)) currentEntry = 0;

      var candidate = {
        definitionId: row.definitionId,
        name: row.name,
        rating: row.rating,
        qualityLabel: row.qualityLabel,
        clubName: row.clubName,
        leagueName: row.leagueName,
        nationName: row.nationName,
        nationFlag: row.nationFlag,
        sightings: rows.length,
        sample: rows.length,
        minBin: minBin,
        stableBIN: stable,
        minBid: minBid,
        maxBid: maxBid,
        priceFloor: targetInfo.priceFloor,
        priceCeiling: targetInfo.priceCeiling,
        priceFloorSource: targetInfo.priceFloorSource,
        activeTargetProfit: activeTarget,
        netSale: netSale,
        expectedProfit: maxBid ? netSale - maxBid : 0,
        currentEntryProfit: currentEntry ? netSale - currentEntry : 0,
        immediate: !!immediate,
        source: 'sbc'
      };

      state.quickFlip.candidate = candidate;
      state.quickFlip.scoutResults = [candidate];
      state.quickFlip.scannedAt = Date.now();
      state.quickFlip.scannedListings = rows.length;
      state.quickFlip.uniquePlayers = 1;
      state.quickFlip.checkedPlayers = 1;
      state.quickFlip.status = candidate.immediate
        ? 'SBC player opportunity · manual snipe ≤ ' + maxBid.toLocaleString()
        : 'SBC player scouted · manual snipe ≤ ' + maxBid.toLocaleString();

      state.market = {
        absMinBIN: minBin,
        stableBIN: stable,
        minBid: minBid,
        listings: rows.length,
        pages: 1,
        probes: 0,
        scannedAt: Date.now(),
        fullScan: false,
        fastScan: false,
        smartScan: false,
        definitionId: row.definitionId,
        futggPrice: 0,
        futggSalesMedian: 0,
        futggStatus: 'not checked',
        priceSource: 'EA SBC → QUICK FLIP',
        confidence: rows.length >= 8 ? 'HIGH' : 'MEDIUM'
      };

      render();
      log(
        'SBC → QUICK FLIP READY · ' + row.name +
        ' · market ' + stable.toLocaleString() +
        ' · max entry ' + maxBid.toLocaleString() +
        ' · target +' + Math.max(0, candidate.expectedProfit).toLocaleString()
      );
    } catch (e) {
      state.quickFlip.status = 'SBC player scan failed · ' + (e && e.message ? e.message : String(e));
      log(state.quickFlip.status);
      renderQuickFlip();
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || 'SCAN';
      }
    }
  }


  async function scanPlayersForSelectedSbc() {
    if (state.sbc.scanning) return;
    if (!state.sbc.selectedChallengeId || !(state.sbc.requirements || []).length) {
      log('SBC · choose a challenge first');
      return;
    }

    var params = state.sbc.scanParams || deriveSbcScanParams(state.sbc.requirements);
    var criteria = criteriaForSbcScan(params);
    if (!criteria) {
      log('SBC · could not build EA player search');
      return;
    }

    state.sbc.scanning = true;
    state.sbc.playerResults = [];
    state.sbc.status = 'Scanning players from SBC requirements…';
    renderSbcPanel();
    log('SBC PLAYER SCAN · mapped ' + params.mapped.length + '/' + state.sbc.requirements.length + ' requirements');

    try {
      var rows = [];
      for (var page = 1; page <= 3; page++) {
        var pageRows = await eaSearchWithCriteria(criteria, page);
        rows = rows.concat(pageRows);
        if (page < 3) await sleep(450);
      }

      var filtered = rows.filter(function (row) { return playerMatchesSbcParams(row, params); });
      var unique = {};
      filtered.forEach(function (row) {
        var key = String(row.definitionId || row.name + ':' + row.rating);
        if (!unique[key] || (row.buyNow && row.buyNow < unique[key].buyNow)) unique[key] = row;
      });

      state.sbc.playerResults = Object.keys(unique).map(function (key) {
        return enrichPlayerMetadata(unique[key]);
      }).sort(function (a, b) {
          return (a.buyNow || Infinity) - (b.buyNow || Infinity) || b.rating - a.rating;
        });

      state.sbc.status = state.sbc.playerResults.length
        ? state.sbc.playerResults.length + ' matching market players found'
        : 'No market players matched the mapped requirements';

      log(
        'SBC PLAYER SCAN · ' + state.sbc.playerResults.length + ' candidates' +
        (params.unmapped.length ? ' · ' + params.unmapped.length + ' squad-level requirement(s) need solver logic' : '')
      );
    } catch (e) {
      state.sbc.status = 'Player scan failed · ' + (e && e.message ? e.message : String(e));
      log(state.sbc.status);
    } finally {
      state.sbc.scanning = false;
      renderSbcPanel();
    }
  }


  async function scanQuickFlipPlayers(options) {
    options = options || {};
    if (state.silverScanning) return;
    if (state.running && !options.rotate) {
      log('Stop Auto Trade before scanning a new FC+ Quick Flip candidate');
      return;
    }

    if (!state.running) readUI();
    var qualityLabel = quickFlipQualityLabel();
    state.silverScanning = true;
    state.quickFlip.status = options.rotate
      ? 'Rotating candidate · scanning ' + qualityLabel + ' market…'
      : 'Scanning EA ' + qualityLabel + ' market…';
    state.quickFlip.candidate = null;
    renderQuickFlip();
    log((options.rotate ? 'ROTATE · ' : 'SCAN · ') + 'FC+ Quick Flip · ' + qualityLabel + ' market');

    var scanButton = document.querySelector('#fcp-scanplayer');
    if (scanButton) {
      scanButton.disabled = true;
      scanButton.textContent = 'SCANNING…';
    }

    try {
      var criteria = criteriaForQuickFlip();
      if (!criteria) throw new Error('EA Quick Flip search is not available on this screen yet');

      var broadRows = [];
      for (var page = 1; page <= 3; page++) {
        log('SCAN · ' + qualityLabel + ' market page ' + page + '/3');
        var pageRows = await eaSearchWithCriteria(criteria, page);
        broadRows = broadRows.concat(pageRows.filter(function (row) {
          return matchesQuickFlipQuality(row, state.quickFlipQuality);
        }));
        if (page < 3) await sleep(550);
      }

      var grouped = {};
      broadRows.forEach(function (row) {
        var id = Number(row.definitionId) || 0;
        if (!id || !row.name || !row.rating) return;
        if (!grouped[id]) {
          grouped[id] = {
            definitionId: id,
            name: row.name,
            rating: row.rating,
            sightings: 0,
            cheapestSeen: 0
          };
        }
        grouped[id].sightings++;
        if (row.buyNow > 0 && (!grouped[id].cheapestSeen || row.buyNow < grouped[id].cheapestSeen)) {
          grouped[id].cheapestSeen = row.buyNow;
        }
      });

      var seeds = Object.keys(grouped).map(function (id) { return grouped[id]; })
        .sort(function (a, b) {
          return b.sightings - a.sightings || a.cheapestSeen - b.cheapestSeen;
        })
        .slice(0, 8);

      state.quickFlip.scannedListings = broadRows.length;
      state.quickFlip.uniquePlayers = Object.keys(grouped).length;
      state.quickFlip.checkedPlayers = 0;
      renderQuickFlip();

      if (!seeds.length) throw new Error('No ' + qualityLabel + ' players were returned by EA');

      var evaluated = [];
      for (var i = 0; i < seeds.length; i++) {
        var seed = seeds[i];
        state.quickFlip.status = 'Checking ' + seed.name + ' (' + (i + 1) + '/' + seeds.length + ')';
        renderQuickFlip();
        log('CHECK · ' + seed.name + ' ' + seed.rating);

        var rows = await eaDirectSearch(0, seed.definitionId);
        state.quickFlip.checkedPlayers++;
        var bins = rows.map(function (x) { return x.buyNow; }).filter(Boolean)
          .sort(function (a, b) { return a - b; });
        if (bins.length < 4) {
          await sleep(350);
          continue;
        }

        var stable = stableBIN(bins);
        var minBin = bins[0] || 0;
        var minBid = rows.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean)
          .sort(function (a, b) { return a - b; })[0] || 0;
        var targetInfo = bestQuickFlipTarget(stable, rows);
        var netSale = targetInfo.netSale;

        if (!targetInfo.floorKnown) {
          log('SKIP · ' + seed.name + ' · EA PRICE FLOOR unavailable');
          await sleep(250);
          continue;
        }

        if (!targetInfo.floorPossible) {
          log(
            'SKIP · ' + seed.name +
            ' · floor ' + targetInfo.priceFloor.toLocaleString() + ' (' + targetInfo.priceFloorSource + ')' +
            ' · max possible profit ' + (targetInfo.maxPossibleProfit >= 0 ? '+' : '') + targetInfo.maxPossibleProfit.toLocaleString() +
            ' < floor +' + state.minProfit.toLocaleString()
          );
          await sleep(250);
          continue;
        }

        var activeTarget = targetInfo.preferredPossible
          ? targetInfo.preferredTarget
          : state.minProfit;
        var maxBid = targetInfo.preferredPossible
          ? targetInfo.preferredEntry
          : targetInfo.floorEntry;

        var immediate = rows.filter(function (x) {
          var entry = x.currentBid || x.startPrice;
          return (x.buyNow > 0 && x.buyNow >= targetInfo.priceFloor && x.buyNow <= maxBid) ||
            (entry > 0 && entry >= targetInfo.priceFloor && entry <= maxBid && x.timeSeconds <= 120);
        }).sort(function (a, b) {
          var ae = Math.min(a.buyNow || Infinity, a.currentBid || a.startPrice || Infinity);
          var be = Math.min(b.buyNow || Infinity, b.currentBid || b.startPrice || Infinity);
          return ae - be;
        })[0] || null;

        var entryPrice = immediate
          ? Math.min(immediate.buyNow || Infinity, immediate.currentBid || immediate.startPrice || Infinity)
          : Math.min(minBin || Infinity, minBid || Infinity);
        if (!Number.isFinite(entryPrice)) entryPrice = 0;

        var currentEntryProfit = entryPrice ? netSale - entryPrice : 0;
        var expectedProfit = maxBid ? netSale - maxBid : 0;
        var spread = stable && minBin ? Math.max(0, stable - minBin) : 0;
        var score = (immediate ? 100000 : 0) +
          seed.sightings * 500 +
          rows.length * 50 +
          Math.max(0, expectedProfit) * 8 +
          Math.max(0, currentEntryProfit) * 2 -
          spread;

        evaluated.push({
          definitionId: seed.definitionId,
          name: seed.name,
          rating: seed.rating,
          sightings: seed.sightings,
          sample: rows.length,
          minBin: minBin,
          stableBIN: stable,
          minBid: minBid,
          maxBid: maxBid,
          priceFloor: targetInfo.priceFloor,
          priceCeiling: targetInfo.priceCeiling,
          priceFloorSource: targetInfo.priceFloorSource,
          activeTargetProfit: activeTarget,
          netSale: netSale,
          expectedProfit: expectedProfit,
          currentEntryProfit: currentEntryProfit,
          immediate: !!immediate,
          score: score
        });

        await sleep(400);
      }

      evaluated.sort(function (a, b) {
        return b.score - a.score || b.expectedProfit - a.expectedProfit;
      });

      var best = evaluated[0];
      if (!best) throw new Error('No ' + qualityLabel + ' player had enough live listings to price safely');

      state.quickFlip.scoutResults = evaluated.slice(0, 8);
      state.quickFlip.candidate = best;
      state.quickFlip.scannedAt = Date.now();
      state.quickFlip.status = best.immediate
        ? 'Opportunity now · manual snipe ≤ ' + best.maxBid.toLocaleString()
        : 'Best ' + qualityLabel + ' candidate · manual snipe ≤ ' + best.maxBid.toLocaleString();

      state.market = {
        absMinBIN: best.minBin,
        stableBIN: best.stableBIN,
        minBid: best.minBid,
        listings: best.sample,
        pages: 1,
        probes: 0,
        scannedAt: Date.now(),
        fullScan: false,
        fastScan: false,
        smartScan: false,
        definitionId: best.definitionId,
        futggPrice: 0,
        futggSalesMedian: 0,
        futggStatus: 'not checked',
        priceSource: 'EA ' + qualityLabel.toUpperCase() + ' QUICK FLIP',
        confidence: best.sample >= 8 ? 'HIGH' : 'MEDIUM'
      };

      renderMarket();
      renderQuickFlip();
      log(
        'FOUND · ' + qualityLabel + ' · ' + best.name + ' ' + best.rating +
        ' · market ' + best.stableBIN.toLocaleString() +
        ' · EA min ' + (best.priceFloor ? best.priceFloor.toLocaleString() : '—') +
        ' · max entry ' + best.maxBid.toLocaleString() +
        ' · target profit ' + (best.expectedProfit >= 0 ? '+' : '') + best.expectedProfit.toLocaleString()
      );
    } catch (e) {
      state.quickFlip.status = 'Scan failed · ' + (e && e.message ? e.message : String(e));
      log(state.quickFlip.status);
      renderQuickFlip();
    } finally {
      state.silverScanning = false;
      if (scanButton) {
        scanButton.disabled = false;
        scanButton.textContent = 'SCAN MARKET';
      }
    }
  }


  function gmJsonRequest(method, url, payload) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest unavailable'));
        return;
      }

      GM_xmlhttpRequest({
        method: method,
        url: url,
        data: payload == null ? undefined : JSON.stringify(payload),
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 9000,
        onload: function (r) {
          var parsed = null;
          try { parsed = JSON.parse(r.responseText || '{}'); } catch (e) {}
          resolve({ status: Number(r.status) || 0, json: parsed, text: r.responseText || '' });
        },
        ontimeout: function () { reject(new Error('FUT.GG request timed out')); },
        onerror: function () { reject(new Error('FUT.GG request failed')); }
      });
    });
  }

  async function futggCardPrice(definitionId) {
    var id = Number(definitionId) || 0;
    if (!id) return { ok: false, reason: 'no definition id' };

    var protectedPath = '/api/fut/player-prices/27/' + id + '/';
    var sign = await gmJsonRequest(
      'POST',
      'https://www.fut.gg/api/fut/price-access/sign/',
      { url: protectedPath }
    );

    if (sign.status === 429) return { ok: false, reason: 'rate limited' };
    if (sign.status !== 200 || !sign.json) return { ok: false, reason: 'HTTP ' + sign.status };

    var signData = sign.json.data || {};
    if (signData.challengeRequired) {
      // Do not attempt to work around a challenge. EA-side validation remains the fallback.
      return { ok: false, reason: 'challenge required' };
    }

    var signedUrl = signData.url;
    if (!signedUrl) return { ok: false, reason: 'no signed URL' };
    if (signedUrl.indexOf('http') !== 0) signedUrl = 'https://www.fut.gg' + signedUrl;

    var detail = await gmJsonRequest('GET', signedUrl, null);
    if (detail.status === 429) return { ok: false, reason: 'rate limited' };
    if (detail.status !== 200 || !detail.json) return { ok: false, reason: 'HTTP ' + detail.status };

    var data = detail.json.data || {};
    var current = data.currentPrice;
    if (current && typeof current === 'object') current = current.price;
    current = Number(current) || 0;

    var sales = Array.isArray(data.completedAuctions) ? data.completedAuctions : [];
    var soldPrices = sales.slice(-30).map(function (a) {
      return Number(a && (a.soldPrice || a.price)) || 0;
    }).filter(Boolean);

    return {
      ok: true,
      current: current,
      salesMedian: medianNumber(soldPrices),
      salesCount: soldPrices.length
    };
  }

  function nextLegalEaPrice(price) {
    var p = Math.max(150, Number(price) || 150);
    return legalDown(p) + priceStep(p);
  }

  async function eaDirectMinBin(initialRows, definitionIdOverride) {
    var rows = initialRows || [];
    var bins = rows.map(function (x) { return x.buyNow; }).filter(Boolean)
      .sort(function (a, b) { return a - b; });
    if (!bins.length) return { minBin: 0, probes: 0 };

    var low = 150;
    var high = bins[0];
    var best = high;
    var probes = 0;

    while (low < high && probes < 9) {
      var mid = legalDown(Math.floor((low + high) / 2));
      if (mid < low) mid = low;
      if (mid >= high) mid = legalDown(high - priceStep(high));
      if (mid < low) break;

      probes++;
      log('EA probe ' + probes + ': ≤ ' + mid.toLocaleString());
      await sleep(850);

      var result = await eaDirectSearch(mid, definitionIdOverride);
      var found = result.map(function (x) { return x.buyNow; }).filter(function (x) { return x > 0 && x <= mid; })
        .sort(function (a, b) { return a - b; });

      if (found.length) {
        best = Math.min(best, found[0]);
        high = Math.min(mid, found[0]);
      } else {
        low = nextLegalEaPrice(mid);
        if (low > high) low = high;
      }
    }

    await sleep(850);
    var finalRows = await eaDirectSearch(high, definitionIdOverride);
    var finalBins = finalRows.map(function (x) { return x.buyNow; }).filter(function (x) { return x > 0; })
      .sort(function (a, b) { return a - b; });
    if (finalBins.length) best = Math.min(best, finalBins[0]);

    return { minBin: best, probes: probes + 1 };
  }

  async function smartPriceScan() {
    if (state.running) {
      log('Stop AUTO before Smart Price scan');
      return;
    }
    if (state.smartScanning || state.fastScanning || state.scanningAll) return;

    var smartPage = pageType();
    if (smartPage !== 'results' && smartPage !== 'details' && smartPage !== 'playerdetails') {
      log('Open Search Results or Player Details first');
      return;
    }

    var item = getCurrentPlayerItem();
    var definitionId = Number(item && item.definitionId) || 0;
    var hasSearch = !!getActiveSearchCriteria();

    if (!hasSearch && !definitionId) {
      log('FC+ could not identify this player');
      return;
    }

    state.smartScanning = true;
    var smartBtn = document.querySelector('#fcp-smartprice');
    var fastBtn = document.querySelector('#fcp-fastbin');
    var fullBtn = document.querySelector('#fcp-scanall');
    [smartBtn, fastBtn, fullBtn].forEach(function (b) { if (b) b.disabled = true; });
    if (smartBtn) smartBtn.textContent = 'SMART SCAN…';

    try {
      log('Smart Price: checking FUT.GG + EA');

      var futPromise = definitionId
        ? futggCardPrice(definitionId).catch(function (e) {
            return { ok: false, reason: e && e.message ? e.message : String(e) };
          })
        : Promise.resolve({ ok: false, reason: 'definition id unavailable' });

      var rows = [];
      var eaError = '';
      try {
        rows = await eaDirectSearch(0, definitionId);
      } catch (e) {
        eaError = e && e.message ? e.message : String(e);
      }

      var fut = await futPromise;

      if (!rows.length && !fut.ok) {
        throw new Error('EA: ' + (eaError || 'no listings') + ' · FUT.GG: ' + (fut.reason || 'unavailable'));
      }

      var bins = rows.map(function (x) { return x.buyNow; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });
      var bids = rows.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });
      var marketAverages = rows.map(function (x) { return x.marketAverage; }).filter(Boolean);
      if (!definitionId) definitionId = rows.map(function (x) { return x.definitionId; }).filter(Boolean)[0] || 0;

      var pageStable = stableBIN(bins);
      var eaAverage = medianNumber(marketAverages);
      var direct = { minBin: bins[0] || 0, probes: 0 };

      if (rows.length) {
        try {
          direct = await eaDirectMinBin(rows, definitionId);
        } catch (e) {
          eaError = e && e.message ? e.message : String(e);
        }
      }

      var futReference = fut.ok ? (fut.salesMedian || fut.current || 0) : 0;
      var referenceCandidates = [];
      if (fut.ok && fut.salesMedian) referenceCandidates.push(fut.salesMedian);
      if (fut.ok && fut.current) referenceCandidates.push(fut.current);
      if (eaAverage) referenceCandidates.push(eaAverage);
      if (pageStable) referenceCandidates.push(pageStable);

      var reference = medianNumber(referenceCandidates);
      if (!reference) reference = direct.minBin || futReference || pageStable || 0;
      if (direct.minBin && reference < direct.minBin) reference = direct.minBin;

      var confidence = 'MEDIUM';
      if (futReference && direct.minBin) {
        var diff = Math.abs(futReference - direct.minBin) / Math.max(futReference, direct.minBin);
        confidence = diff <= 0.15 ? 'HIGH' : (diff <= 0.30 ? 'MEDIUM' : 'LOW');
      } else if (direct.minBin && eaAverage) {
        confidence = 'HIGH';
      } else if (futReference && !rows.length) {
        confidence = 'MEDIUM';
      } else if (rows.length) {
        confidence = 'MEDIUM';
      }

      var source = fut.ok && rows.length ? 'EA + FUT.GG' : (fut.ok ? 'FUT.GG' : 'EA DIRECT');

      state.market = {
        absMinBIN: direct.minBin || bins[0] || fut.current || 0,
        stableBIN: reference,
        minBid: bids[0] || 0,
        listings: rows.length,
        pages: 0,
        probes: direct.probes || 0,
        scannedAt: Date.now(),
        fullScan: false,
        fastScan: false,
        smartScan: true,
        definitionId: definitionId,
        futggPrice: fut.ok ? (fut.current || 0) : 0,
        futggSalesMedian: fut.ok ? (fut.salesMedian || 0) : 0,
        futggStatus: fut.ok
          ? ('live · ' + (fut.salesCount || 0) + ' sales')
          : ('fallback · ' + (fut.reason || 'unavailable')),
        priceSource: source,
        confidence: confidence
      };

      renderMarket();
      log(
        'SMART PRICE · ' + source +
        ' · min ' + (state.market.absMinBIN ? state.market.absMinBIN.toLocaleString() : '—') +
        ' · ref ' + (state.market.stableBIN ? state.market.stableBIN.toLocaleString() : '—') +
        (eaError ? ' · EA note: ' + eaError : '')
      );
    } catch (e) {
      var visibleRows = listingCards();
      var binsFallback = visibleRows.map(function (x) { return x.buyNow; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });
      var bidsFallback = visibleRows.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });

      state.market = {
        absMinBIN: binsFallback[0] || 0,
        stableBIN: stableBIN(binsFallback),
        minBid: bidsFallback[0] || 0,
        listings: visibleRows.length,
        pages: visibleRows.length ? 1 : 0,
        probes: 0,
        scannedAt: Date.now(),
        fullScan: false,
        fastScan: false,
        smartScan: true,
        definitionId: definitionId,
        futggPrice: 0,
        futggSalesMedian: 0,
        futggStatus: 'fallback · unavailable',
        priceSource: visibleRows.length ? 'PAGE FALLBACK' : 'UNAVAILABLE',
        confidence: visibleRows.length ? 'LOW' : '—'
      };

      renderMarket();
      log('Smart Price unavailable · ' + (e && e.message ? e.message : String(e)));
    } finally {
      state.smartScanning = false;
      [smartBtn, fastBtn, fullBtn].forEach(function (b) { if (b) b.disabled = false; });
      if (smartBtn) smartBtn.textContent = 'SMART PRICE';
      render();
    }
  }

  function waitUntil(test, timeoutMs) {
    timeoutMs = timeoutMs || 6000;
    return new Promise(function (resolve) {
      var started = Date.now();
      var timer = setInterval(function () {
        var ok = false;
        try { ok = !!test(); } catch (e) {}
        if (ok) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 150);
    });
  }

  function findMaxBuyNowInput() {
    var input = findInputNear(['max buy now', 'max. buy now', 'buy now max', 'maximum buy now']);
    if (input) return input;

    var inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    for (var i = 0; i < inputs.length; i++) {
      var a = lower(
        (inputs[i].getAttribute('aria-label') || '') + ' ' +
        (inputs[i].getAttribute('placeholder') || '') + ' ' +
        (inputs[i].name || '')
      );
      if (a.indexOf('buy') >= 0 && a.indexOf('max') >= 0) return inputs[i];
    }
    return null;
  }

  function noResultsVisible() {
    var t = pageText();
    return t.indexOf('no results') >= 0 ||
      t.indexOf('no items found') >= 0 ||
      t.indexOf('no auctions found') >= 0;
  }

  async function goBackToSearchForm() {
    // Deprecated in v0.3.5. Browser history navigation could leave the EA Web App.
    // Kept only for compatibility with old helper code; never changes route.
    return pageType() !== 'results' && !!findMaxBuyNowInput();
  }

  async function submitPriceProbe(maxPrice) {
    var input = findMaxBuyNowInput();
    var search = findControl([/^Search$/i]);

    if (!input || !search) return { ok: false, hasResults: false, listings: [] };

    setInput(input, maxPrice);
    clickLikeUser(search);

    var loaded = await waitUntil(function () {
      return pageType() === 'results' || noResultsVisible();
    }, 7000);

    if (!loaded) return { ok: false, hasResults: false, listings: [] };

    await sleep(250);
    var listings = listingCards();

    return {
      ok: true,
      hasResults: listings.length > 0,
      listings: listings
    };
  }

  function nextLegalAbove(price) {
    var p = Math.max(150, Number(price) || 150);
    return p + priceStep(p);
  }

  async function fastMinBinScan() {
    if (state.running) {
      log('Stop AUTO before EA Fast BIN scan');
      return;
    }
    if (state.fastScanning || state.smartScanning || state.scanningAll) return;
    if (pageType() !== 'results') {
      log('Open Search Results first');
      return;
    }

    var visibleRows = listingCards();
    if (!visibleRows.length) {
      log('No visible listings detected');
      return;
    }

    state.fastScanning = true;
    var fastBtn = document.querySelector('#fcp-fastbin');
    var smartBtn = document.querySelector('#fcp-smartprice');
    var fullBtn = document.querySelector('#fcp-scanall');
    [fastBtn, smartBtn, fullBtn].forEach(function (b) { if (b) b.disabled = true; });
    if (fastBtn) fastBtn.textContent = 'EA SCANNING…';

    try {
      log('EA Fast BIN: direct market query · screen stays here');

      var rows = await eaDirectSearch(0);
      if (!rows.length) throw new Error('EA direct search returned no listings');

      var bins = rows.map(function (x) { return x.buyNow; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });
      var bids = rows.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });

      var direct = await eaDirectMinBin(rows);
      var reference = stableBIN(bins) || direct.minBin || 0;

      state.market = {
        absMinBIN: direct.minBin || bins[0] || 0,
        stableBIN: reference,
        minBid: bids[0] || 0,
        listings: rows.length,
        pages: 0,
        probes: direct.probes || 0,
        scannedAt: Date.now(),
        fullScan: false,
        fastScan: true,
        smartScan: false,
        definitionId: rows.map(function (x) { return x.definitionId; }).filter(Boolean)[0] || 0,
        futggPrice: 0,
        futggSalesMedian: 0,
        futggStatus: 'not checked',
        priceSource: 'EA DIRECT',
        confidence: 'HIGH'
      };

      renderMarket();
      log('EA FAST BIN ' + state.market.absMinBIN.toLocaleString() +
        ' · ' + state.market.probes + ' direct probes · no navigation');
    } catch (e) {
      // Never navigate away from the market page as a fallback.
      var binsFallback = visibleRows.map(function (x) { return x.buyNow; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });
      var bidsFallback = visibleRows.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean)
        .sort(function (a, b) { return a - b; });

      state.market = {
        absMinBIN: binsFallback[0] || 0,
        stableBIN: stableBIN(binsFallback),
        minBid: bidsFallback[0] || 0,
        listings: visibleRows.length,
        pages: 1,
        probes: 0,
        scannedAt: Date.now(),
        fullScan: false,
        fastScan: false,
        smartScan: false,
        definitionId: 0,
        futggPrice: 0,
        futggSalesMedian: 0,
        futggStatus: 'not checked',
        priceSource: 'PAGE FALLBACK',
        confidence: 'LOW'
      };

      renderMarket();
      log('EA direct scan unavailable · stayed on page · using visible listings (' +
        (e && e.message ? e.message : String(e)) + ')');
    } finally {
      state.fastScanning = false;
      [fastBtn, smartBtn, fullBtn].forEach(function (b) { if (b) b.disabled = false; });
      if (fastBtn) fastBtn.textContent = 'EA FAST BIN';
      render();
    }
  }

  async function scanAllMarketPages() {
    if (state.running) {
      log('Stop AUTO before full-market scan');
      return;
    }
    if (state.scanningAll) return;
    if (pageType() !== 'results') {
      log('Open the first Search Results page first');
      return;
    }

    state.scanningAll = true;
    var scanBtn = document.querySelector('#fcp-scanall');
    if (scanBtn) {
      scanBtn.disabled = true;
      scanBtn.textContent = 'SCANNING…';
    }

    var all = [];
    var seen = {};
    var pages = 0;

    try {
      while (pages < state.maxScanPages) {
        var listings = listingCards();
        if (!listings.length) break;

        var sig = listingSignature(listings);
        if (seen[sig]) break;
        seen[sig] = true;

        pages++;
        listings.forEach(function (x) {
          all.push({
            name: x.name,
            startPrice: x.startPrice,
            currentBid: x.currentBid,
            buyNow: x.buyNow,
            timeSeconds: x.timeSeconds
          });
        });

        applyFullMarketAggregate(all, pages);
        log('Scan page ' + pages + ' · ' + all.length + ' listings · min BIN ' +
          (state.market.absMinBIN ? state.market.absMinBIN.toLocaleString() : '—'));

        var next = nextPageControl();
        if (!next) break;

        clickLikeUser(next);
        await sleep(state.scanPageDelayMs);

        var changed = await waitForNewResults(sig);
        if (!changed) {
          log('Next page did not change; scan stopped');
          break;
        }
      }

      applyFullMarketAggregate(all, pages);
      log('FULL SCAN · ' + pages + ' pages · ' + all.length + ' listings · MIN BIN ' +
        (state.market.absMinBIN ? state.market.absMinBIN.toLocaleString() : '—'));
    } catch (e) {
      log('Full scan error: ' + (e && e.message ? e.message : String(e)));
    } finally {
      state.scanningAll = false;
      if (scanBtn) {
        scanBtn.disabled = false;
        scanBtn.textContent = 'SCAN ALL PAGES';
      }
      render();
    }
  }

  function clickable(el) {
    var node = el;
    for (var i = 0; i < 6 && node; i++, node = node.parentElement) {
      var role = node.getAttribute ? node.getAttribute('role') : '';
      if (node.tagName === 'BUTTON' || node.tagName === 'A' || role === 'button') return node;
    }
    return el;
  }

  function clickLikeUser(el) {
    if (!el || !visible(el)) return false;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
    el.click();
    return true;
  }

  function controls(root) {
    root = root || document;
    return Array.from(root.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]')).filter(visible);
  }

  function findControl(patterns, root) {
    var list = Array.isArray(patterns) ? patterns : [patterns];
    var els = controls(root || document);
    for (var i = 0; i < els.length; i++) {
      var s = text(els[i].innerText || els[i].textContent || els[i].value || els[i].getAttribute('aria-label') || '');
      if (list.some(function (re) { return re.test(s); })) return els[i];
    }
    return null;
  }

  function findInputNear(labels) {
    var wanted = labels.map(lower);
    var els = Array.from(document.querySelectorAll('label,div,span,p')).filter(visible);

    for (var i = 0; i < els.length; i++) {
      var t = lower(els[i].textContent || '');
      if (!wanted.some(function (x) { return t.indexOf(x) >= 0; })) continue;

      var p = els[i];
      for (var j = 0; j < 5 && p; j++, p = p.parentElement) {
        var input = p.querySelector ? p.querySelector('input') : null;
        if (input && visible(input)) return input;
      }
    }
    return null;
  }

  function setInput(input, value) {
    if (!input) return false;
    var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  async function setSellDurationOneHour() {
    var hourPattern = /^1\s*(hour|hr)$/i;

    // Native select, if EA exposes one.
    var selects = Array.from(document.querySelectorAll('select')).filter(visible);
    for (var i = 0; i < selects.length; i++) {
      var select = selects[i];
      var options = Array.from(select.options || []);
      var oneHour = options.find(function (option) {
        return hourPattern.test(text(option.textContent || option.label || option.value || ''));
      });
      if (!oneHour) continue;
      select.value = oneHour.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(120);
      return true;
    }

    // EA mobile normally renders duration as a custom button/row.
    var durationControl = findControl([
      /^Duration$/i,
      /^List Duration$/i,
      /^1\s*(Hour|Hr)$/i,
      /^(3|6|12)\s*(Hours?|Hrs?)$/i,
      /^1\s*Day$/i
    ]);

    if (!durationControl) {
      var durationLabel = exactTextNode('Duration') || exactTextNode('List Duration');
      if (durationLabel) durationControl = clickableAncestor(durationLabel);
    }

    if (durationControl) {
      var currentText = text(durationControl.innerText || durationControl.textContent || '');
      if (hourPattern.test(currentText)) return true;

      clickLikeUser(durationControl);
      await sleep(180);

      var option = findControl([/^1\s*(Hour|Hr)$/i]);
      if (!option) {
        var hourNode = exactTextNode('1 Hour') || exactTextNode('1 Hr');
        if (hourNode) option = clickableAncestor(hourNode);
      }
      if (option) {
        clickLikeUser(option);
        await sleep(180);
        return true;
      }
    }

    // Some EA builds show the selected duration as plain text rather than a button.
    var nodes = Array.from(document.querySelectorAll('div,span,p,label')).filter(visible);
    return nodes.some(function (node) {
      return hourPattern.test(text(node.textContent || ''));
    });
  }

  function numberNear(labelRegex) {
    var els = Array.from(document.querySelectorAll('div,span,p')).filter(visible);
    for (var i = 0; i < els.length; i++) {
      var s = text(els[i].innerText || els[i].textContent || '');
      if (!labelRegex.test(s)) continue;
      var nums = s.match(/([\d,]+)/g);
      if (nums && nums.length) return coin(nums[nums.length - 1]);
      var parent = text(els[i].parentElement ? els[i].parentElement.innerText : '');
      nums = parent.match(/([\d,]+)/g);
      if (nums && nums.length) return coin(nums[nums.length - 1]);
    }
    return 0;
  }

  function bidInput() {
    var button = findControl([/^Make Bid$/i]);
    if (!button) return null;
    var p = button.parentElement;
    for (var i = 0; i < 6 && p; i++, p = p.parentElement) {
      var inputs = Array.from(p.querySelectorAll('input')).filter(visible);
      if (inputs.length) return inputs[0];
    }
    return Array.from(document.querySelectorAll('input')).filter(visible)[0] || null;
  }

  function log(message) {
    var line = new Date().toLocaleTimeString() + '  ' + message;
    state.logHistory = state.logHistory || [];
    state.logHistory.unshift(line);
    if (state.logHistory.length > 120) state.logHistory.length = 120;

    var action = document.querySelector('#fcp-action');
    if (action) action.textContent = message;

    var box = document.querySelector('#fcp-log');
    if (box) {
      box.innerHTML = '';
      state.logHistory.forEach(function (entry) {
        var row = document.createElement('div');
        row.textContent = entry;
        box.appendChild(row);
      });
    }
  }

  function renderMarket() {
    var minBin = document.querySelector('#fcp-minbin');
    var stable = document.querySelector('#fcp-bin');
    var bid = document.querySelector('#fcp-bid');
    var max = document.querySelector('#fcp-maxbid');
    var scanInfo = document.querySelector('#fcp-scaninfo');
    var futgg = document.querySelector('#fcp-futgg');
    var source = document.querySelector('#fcp-source');
    var confidence = document.querySelector('#fcp-confidence');
    if (minBin) minBin.textContent = state.market.absMinBIN ? state.market.absMinBIN.toLocaleString() : '—';
    if (stable) stable.textContent = state.market.stableBIN ? state.market.stableBIN.toLocaleString() : '—';
    if (bid) bid.textContent = state.market.minBid ? state.market.minBid.toLocaleString() : '—';
    if (max) {
      var m = maxBidFor(state.market.stableBIN);
      max.textContent = m ? m.toLocaleString() : '—';
    }
    if (futgg) {
      var fp = state.market.futggSalesMedian || state.market.futggPrice || 0;
      futgg.textContent = fp ? fp.toLocaleString() : '—';
    }
    if (source) source.textContent = state.market.priceSource || 'PAGE';
    if (confidence) confidence.textContent = state.market.confidence || '—';
    if (scanInfo) {
      scanInfo.textContent = state.market.smartScan
        ? ('Smart · ' + state.market.probes + ' EA probes · FUT.GG ' + (state.market.futggStatus || 'not checked'))
        : state.market.fastScan
          ? ('EA direct · ' + state.market.probes + ' price probes')
          : state.market.fullScan
            ? ('Full market · ' + state.market.pages + ' pages · ' + state.market.listings + ' listings')
            : (state.market.listings ? ('Current page · ' + state.market.listings + ' listings') : 'Not scanned');
    }
  }


  function renderQuickFlip() {
    var q = state.quickFlip || {};
    var candidate = q.candidate;
    var status = document.querySelector('#fcp-result-status');
    var player = document.querySelector('#fcp-result-player');
    var market = document.querySelector('#fcp-result-market');
    var priceRange = document.querySelector('#fcp-result-range');
    var maxBid = document.querySelector('#fcp-result-maxbid');
    var profit = document.querySelector('#fcp-result-profit');
    var scanMeta = document.querySelector('#fcp-result-meta');

    if (status) status.textContent = q.status || ('Ready to scan ' + quickFlipQualityLabel() + ' players');
    if (player) player.textContent = candidate ? (candidate.name + ' · ' + candidate.rating) : '—';
    if (market) market.textContent = candidate && candidate.stableBIN ? candidate.stableBIN.toLocaleString() : '—';
    if (priceRange) {
      if (candidate && candidate.priceFloor) {
        priceRange.textContent = candidate.priceCeiling
          ? candidate.priceFloor.toLocaleString() + '–' + candidate.priceCeiling.toLocaleString()
          : candidate.priceFloor.toLocaleString() + '+';
        priceRange.title = candidate.priceFloorSource || '';
      } else {
        priceRange.textContent = '—';
        priceRange.title = '';
      }
    }
    if (maxBid) maxBid.textContent = candidate && candidate.maxBid ? candidate.maxBid.toLocaleString() : '—';
    if (profit) {
      if (candidate && Number.isFinite(candidate.expectedProfit)) {
        profit.textContent = (candidate.expectedProfit >= 0 ? '+' : '') + candidate.expectedProfit.toLocaleString();
      } else {
        profit.textContent = '—';
      }
    }
    if (scanMeta) {
      scanMeta.textContent = q.scannedListings
        ? (q.scannedListings + ' listings · ' + q.uniquePlayers + ' players · ' + q.checkedPlayers + ' checked')
        : 'No scan yet';
    }

    var scoutCount = document.querySelector('#fcp-scout-count');
    var scoutList = document.querySelector('#fcp-scout-results');
    var scoutRows = q.scoutResults || [];
    if (scoutCount) scoutCount.textContent = scoutRows.length + ' candidate' + (scoutRows.length === 1 ? '' : 's');

    if (scoutList) {
      scoutList.innerHTML = '';
      scoutRows.forEach(function (row, index) {
        var card = document.createElement('div');
        card.className = 'fcp-scout-card' + (index === 0 ? ' best' : '');

        var top = document.createElement('div');
        top.className = 'fcp-scout-card-top';

        var identity = document.createElement('div');
        identity.className = 'fcp-scout-identity';
        var title = document.createElement('b');
        title.textContent = row.name + ' · ' + row.rating;
        var meta = document.createElement('small');
        meta.textContent = (index === 0 ? 'BEST · ' : '') + (row.sample || 0) + ' live listings';
        identity.appendChild(title);
        identity.appendChild(meta);

        var target = document.createElement('div');
        target.className = 'fcp-scout-target';
        var targetLabel = document.createElement('small');
        targetLabel.textContent = 'SNIPE ≤';
        var targetValue = document.createElement('b');
        targetValue.textContent = row.maxBid ? row.maxBid.toLocaleString() : '—';
        target.appendChild(targetLabel);
        target.appendChild(targetValue);

        top.appendChild(identity);
        top.appendChild(target);

        var metrics = document.createElement('div');
        metrics.className = 'fcp-scout-metrics';

        [
          ['Market', row.stableBIN],
          ['Min BIN', row.minBin],
          ['Profit', row.expectedProfit, true]
        ].forEach(function (entry) {
          var box = document.createElement('span');
          var l = document.createElement('small');
          l.textContent = entry[0];
          var v = document.createElement('b');
          var value = Number(entry[1]) || 0;
          v.textContent = value
            ? ((entry[2] && value >= 0 ? '+' : '') + value.toLocaleString())
            : '—';
          box.appendChild(l);
          box.appendChild(v);
          metrics.appendChild(box);
        });

        card.appendChild(top);
        card.appendChild(metrics);
        scoutList.appendChild(card);
      });

      if (!scoutRows.length) {
        var empty = document.createElement('div');
        empty.className = 'fcp-scout-empty';
        empty.textContent = 'Run Scan Market to find manual snipe targets.';
        scoutList.appendChild(empty);
      }
    }

    var cQuality = document.querySelector('#fcp-cond-quality');
    var cMin = document.querySelector('#fcp-cond-profit');
    var cBid = document.querySelector('#fcp-cond-bid');
    var cBuy = document.querySelector('#fcp-cond-buy');
    var cRelist = document.querySelector('#fcp-cond-relist');
    var cMode = document.querySelector('#fcp-cond-mode');
    var modeButton = document.querySelector('#fcp-mode-toggle');
    var cTrades = document.querySelector('#fcp-cond-trades');
    if (cQuality) cQuality.textContent = quickFlipQualityLabel() + ' only';
    if (cMin) cMin.textContent = 'Target +' + state.quickFlipPreferredProfit.toLocaleString() + ' · floor +' + state.minProfit.toLocaleString();
    if (cBid) cBid.textContent = state.autoBid ? 'Auto bid / rebid' : 'Bid off';
    if (cBuy) cBuy.textContent = state.autoBuyNow ? 'Auto Buy Now' : 'Buy Now off';
    if (cRelist) cRelist.textContent = state.autoSell ? 'Auto relist' : 'Relist off';
    if (cMode) cMode.textContent = state.dryRun ? 'Dry run' : 'Live';
    if (modeButton) {
      modeButton.textContent = state.dryRun ? 'DRY RUN' : 'LIVE';
      modeButton.dataset.live = state.dryRun ? '0' : '1';
      modeButton.disabled = !!state.running;
    }
    if (cTrades) cTrades.textContent = 'Max ' + state.maxTrades + ' trades';

    Array.from(document.querySelectorAll('input[name="fcp-quality"]')).forEach(function (radio) {
      radio.checked = lower(radio.value) === lower(state.quickFlipQuality || 'silver');
    });
  }


  function render() {
    var status = document.querySelector('#fcp-state');
    var headState = document.querySelector('#fcp-headstate');

    if (status) {
      status.textContent = state.silverScanning ? 'SCANNING' : 'MANUAL';
      status.dataset.on = state.silverScanning ? '1' : '0';
    }
    if (headState) headState.textContent = 'SCOUT';

    renderMarket();
    renderQuickFlip();
  }

  function readUI() {
    function val(id) {
      var el = document.querySelector(id);
      return coin(el ? el.value : 0);
    }

    // v0.9 Scout mode is deliberately read-only.
    state.running = false;
    state.busy = false;
    state.liveTrade = null;
    state.dryRun = true;
    state.autoBid = false;
    state.autoBuyNow = false;
    state.autoSell = false;

    var alt = document.querySelector('#fcp-altpositions');
    var prices = document.querySelector('#fcp-cardprices');
    if (alt) state.showAltPositions = !!alt.checked;
    if (prices) state.showCardPrices = !!prices.checked;

    var qualityRadio = document.querySelector('input[name="fcp-quality"]:checked');
    if (qualityRadio) state.quickFlipQuality = lower(qualityRadio.value || 'silver');

    state.quickFlipPreferredProfit = Math.max(0, val('#fcp-targetprofit') || 500);
    state.minProfit = Math.max(0, val('#fcp-minprofit') || 300);
    state.maxBidCap = 0;
    state.maxBinBuy = 0;

    var pageCap = document.querySelector('#fcp-maxscanpages');
    if (pageCap) {
      state.maxScanPages = Math.max(1, Math.min(100, coin(pageCap.value) || 40));
    }

    saveSettings();
    render();
  }

  function stopReason() {
    if (!state.running) return true;

    if (state.trades >= state.maxTrades) {
      stop('Max trades reached');
      return true;
    }

    if (state.sessionStarted && Date.now() - state.sessionStarted >= state.sessionMinutes * 60000) {
      stop('Session time limit reached');
      return true;
    }

    if (state.dailyTarget > 0 && state.daily.realizedProfit >= state.dailyTarget) {
      stop('Daily profit target reached');
      return true;
    }

    var t = pageText();
    var hardStop = ['captcha', 'too many actions', 'temporarily unavailable', 'try again later', 'access has been restricted'];
    if (hardStop.some(function (x) { return t.indexOf(x) >= 0; })) {
      stop('EA warning detected');
      return true;
    }

    return false;
  }


  async function monitorQuickFlipCandidate() {
    var candidate = state.quickFlip && state.quickFlip.candidate;
    if (!candidate || !candidate.definitionId) {
      log('AUTO · no FC+ Quick Flip candidate selected');
      return;
    }

    if (!state.dryRun && state.liveTrade) {
      var handled = await processQuickFlipLiveTrade();
      if (handled) return;
    }

    var rows = await eaDirectSearch(0, candidate.definitionId);
    if (!rows.length) {
      state.quickFlip.status = 'Monitoring ' + candidate.name + ' · no listings returned';
      renderQuickFlip();
      return;
    }

    var bins = rows.map(function (x) { return x.buyNow; }).filter(Boolean)
      .sort(function (a, b) { return a - b; });
    var stable = stableBIN(bins);
    var targetInfo = bestQuickFlipTarget(stable, rows);
    var candidateAge = Math.max(0, Date.now() - (state.quickFlip.scannedAt || Date.now()));
    var preferredPhase = candidateAge < state.quickFlipPreferredMs && targetInfo.preferredPossible;
    var activeProfitTarget = preferredPhase
      ? targetInfo.preferredTarget
      : state.minProfit;
    var maxEntry = preferredPhase ? targetInfo.preferredEntry : targetInfo.floorEntry;
    var minBin = bins[0] || 0;

    candidate.priceFloor = targetInfo.priceFloor;
    candidate.priceCeiling = targetInfo.priceCeiling;
    candidate.priceFloorSource = targetInfo.priceFloorSource;

    if (!targetInfo.floorKnown) {
      candidate.maxBid = 0;
      candidate.expectedProfit = 0;
      state.quickFlip.status = 'Skip ' + candidate.name + ' · EA price floor unavailable';
      renderQuickFlip();
      log('ROTATE · ' + candidate.name + ' · EA PRICE FLOOR unavailable');
      await scanQuickFlipPlayers({ rotate: true });
      return;
    }

    if (!targetInfo.floorPossible) {
      candidate.maxBid = 0;
      candidate.expectedProfit = targetInfo.maxPossibleProfit;
      candidate.currentEntryProfit = minBin ? targetInfo.netSale - minBin : 0;
      state.quickFlip.status =
        'Skip ' + candidate.name +
        ' · floor ' + targetInfo.priceFloor.toLocaleString() + ' (' + targetInfo.priceFloorSource + ')' +
        ' only allows ' + (targetInfo.maxPossibleProfit >= 0 ? '+' : '') + targetInfo.maxPossibleProfit.toLocaleString();

      renderQuickFlip();
      log(
        'ROTATE · ' + candidate.name +
        ' · EA min ' + (targetInfo.priceFloor ? targetInfo.priceFloor.toLocaleString() : 'unknown') +
        ' · max possible ' + (targetInfo.maxPossibleProfit >= 0 ? '+' : '') + targetInfo.maxPossibleProfit.toLocaleString() +
        ' < floor +' + state.minProfit.toLocaleString()
      );

      await scanQuickFlipPlayers({ rotate: true });
      return;
    }
    var minBid = rows.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean)
      .sort(function (a, b) { return a - b; })[0] || 0;

    candidate.minBin = minBin;
    candidate.stableBIN = stable;
    candidate.minBid = minBid;
    candidate.maxBid = maxEntry;
    candidate.sample = rows.length;
    candidate.netSale = Math.floor(stable * 0.95);

    state.market.absMinBIN = minBin;
    state.market.stableBIN = stable;
    state.market.minBid = minBid;
    state.market.listings = rows.length;
    state.market.scannedAt = Date.now();
    state.market.definitionId = candidate.definitionId;
    state.market.priceSource = 'EA QUICKFLIP LIVE';
    state.market.confidence = rows.length >= 8 ? 'HIGH' : 'MEDIUM';

    var buy = rows.filter(function (row) {
      return row.buyNow > 0 &&
        (!targetInfo.priceFloor || row.buyNow >= targetInfo.priceFloor) &&
        row.buyNow <= maxEntry;
    }).sort(function (a, b) {
      return a.buyNow - b.buyNow || a.timeSeconds - b.timeSeconds;
    })[0] || null;

    var bid = rows.map(function (row) {
      row.effectiveBid = row.currentBid || row.startPrice;
      return row;
    }).filter(function (row) {
      return row.effectiveBid > 0 &&
        (!targetInfo.priceFloor || row.effectiveBid >= targetInfo.priceFloor) &&
        row.effectiveBid <= maxEntry &&
        row.timeSeconds <= 120;
    }).sort(function (a, b) {
      return a.timeSeconds - b.timeSeconds || a.effectiveBid - b.effectiveBid;
    })[0] || null;

    var decision = null;
    if (state.autoBuyNow && buy) {
      decision = {
        type: 'BIN',
        price: buy.buyNow,
        row: buy
      };
    } else if (state.autoBid && bid) {
      decision = {
        type: 'BID',
        price: bid.effectiveBid,
        row: bid
      };
    }

    if (decision) {
      candidate.currentEntryProfit = Math.floor(stable * 0.95) - decision.price;
      candidate.expectedProfit = targetInfo.netSale - maxEntry;
      state.quickFlip.status = 'Monitoring ' + candidate.name + ' · entry found';
    } else {
      candidate.currentEntryProfit = minBin ? Math.floor(stable * 0.95) - minBin : 0;
      candidate.expectedProfit = targetInfo.netSale - maxEntry;
      state.quickFlip.status = 'Monitoring ' + candidate.name + ' · target +' + activeProfitTarget.toLocaleString() + ' · entry ≤ ' + maxEntry.toLocaleString();
    }

    renderMarket();
    renderQuickFlip();

    var signature = decision
      ? (decision.type + ':' + decision.price + ':' + String(decision.row.auctionId || decision.row.itemId || '') + ':' + decision.row.timeSeconds)
      : ('WAIT:' + minBin + ':' + minBid + ':' + maxEntry);

    var now = Date.now();
    if (signature !== state.lastQuickFlipDecision || now - state.lastQuickFlipDecisionAt > 15000) {
      state.lastQuickFlipDecision = signature;
      state.lastQuickFlipDecisionAt = now;

      if (decision) {
        var estimated = Math.floor(stable * 0.95) - decision.price;
        log(
          (state.dryRun ? 'DRY · would ' : 'READY · ') + decision.type +
          ' ' + candidate.name +
          ' @ ' + decision.price.toLocaleString() +
          ' · market ' + stable.toLocaleString() +
          ' · est ' + (estimated >= 0 ? '+' : '') + estimated.toLocaleString()
        );
      } else {
        log(
          'MONITOR · ' + candidate.name +
          ' · market ' + stable.toLocaleString() +
          ' · floor ' + targetInfo.priceFloor.toLocaleString() + ' (' + targetInfo.priceFloorSource + ')' +
          ' · target +' + activeProfitTarget.toLocaleString() +
          ' · max entry ' + maxEntry.toLocaleString() +
          ' · cheapest BIN ' + (minBin ? minBin.toLocaleString() : '—')
        );
      }
    }

    if (!decision && !state.liveTrade && state.quickFlip.scannedAt &&
        Date.now() - state.quickFlip.scannedAt >= state.quickFlipRotateMs) {
      log('ROTATE · ' + candidate.name + ' · no qualifying entry after 75s');
      await scanQuickFlipPlayers({ rotate: true });
      return;
    }

    state.currentTarget = {
      strategy: 'fcplus_quick_flip',
      definitionId: candidate.definitionId,
      name: candidate.name,
      rating: candidate.rating,
      stableBIN: stable,
      maxBid: maxEntry,
      decision: decision ? decision.type.toLowerCase() : 'wait',
      price: decision ? decision.price : 0,
      auctionId: decision && decision.row ? decision.row.auctionId : ''
    };

    if (!state.dryRun && decision && !state.liveTrade) {
      await executeQuickFlipDecision(decision, candidate, stable, maxEntry);
    }
  }


  async function handleResults() {
    var listings = scanMarket();
    if (!listings.length) {
      log('No listings detected');
      return;
    }

    var maxBid = maxBidFor(state.market.stableBIN);
    log('BIN ' + state.market.stableBIN.toLocaleString() + ' · MaxBid ' + maxBid.toLocaleString());

    if (state.autoBuyNow && state.maxBinBuy > 0) {
      var bins = listings.filter(function (x) { return x.buyNow <= state.maxBinBuy; })
        .sort(function (a, b) { return a.buyNow - b.buyNow || a.timeSeconds - b.timeSeconds; });

      if (bins.length) {
        var b = bins[0];
        b.el.style.outline = '4px solid #00ee88';
        log('BIN target ' + b.name + ' ' + b.buyNow.toLocaleString());

        if (!state.dryRun) {
          state.currentTarget = { type: 'bin', name: b.name, buyNow: b.buyNow, stableBIN: state.market.stableBIN, maxBid: maxBid };
          clickLikeUser(clickable(b.el));
          await sleep(800);
        }
        return;
      }
    }

    if (!state.autoBid || maxBid <= 0) return;

    var auctions = listings.map(function (x) {
      x.effectiveBid = x.currentBid || x.startPrice;
      return x;
    }).filter(function (x) {
      return x.effectiveBid > 0 && x.effectiveBid <= maxBid;
    }).sort(function (a, b) {
      return a.timeSeconds - b.timeSeconds || a.effectiveBid - b.effectiveBid;
    });

    if (!auctions.length) {
      log('No auction under Max Bid');
      return;
    }

    var target = auctions[0];
    target.el.style.outline = '4px solid #00ee88';
    log('Auction ' + target.effectiveBid.toLocaleString() + ' · ' + target.timeSeconds + 's');

    if (state.dryRun) return;

    state.currentTarget = { type: 'bid', name: target.name, stableBIN: state.market.stableBIN, maxBid: maxBid };
    state.lastBidPlaced = 0;
    clickLikeUser(clickable(target.el));
    await sleep(800);
  }

  async function handleDetails() {
    if (pageText().indexOf("congratulations, you've won this item for") >= 0) {
      await handleWon();
      return;
    }

    var buy = findControl([/^Buy Now for\s*[\d,]+/i]);

    if (state.currentTarget && state.currentTarget.type === 'bin' && buy) {
      var p = coin(text(buy.innerText || buy.textContent || ''));
      if (p > 0 && p <= state.maxBinBuy) {
        log('Buy Now ' + p.toLocaleString());
        if (!state.dryRun) {
          clickLikeUser(buy);
          await sleep(500);
          var confirm = findControl([/^Buy Now$/i, /^Confirm$/i, /^Yes$/i, /^OK$/i]);
          if (confirm) clickLikeUser(confirm);
        }
      }
      return;
    }

    if (!state.autoBid || !state.currentTarget || !state.currentTarget.maxBid) {
      log('Item Details · waiting');
      return;
    }

    var currentBid = numberNear(/Current Bid/i);
    var input = bidInput();
    var makeBid = findControl([/^Make Bid$/i]);

    if (!input || !makeBid) {
      log('Bid controls not found');
      return;
    }

    var nextBid = coin(input.value);
    var maxBid = state.currentTarget.maxBid;

    if (!nextBid) {
      log('Next bid unavailable');
      return;
    }

    if (nextBid > maxBid) {
      log('Stop: next ' + nextBid.toLocaleString() + ' > max ' + maxBid.toLocaleString());
      if (!state.dryRun) {
        navigateEaBack('trader');
        await sleep(900);
      }
      return;
    }

    if (state.lastBidPlaced && currentBid === state.lastBidPlaced) {
      log('Leading at ' + currentBid.toLocaleString());
      return;
    }

    if (!state.lastBidPlaced || currentBid > state.lastBidPlaced) {
      log((state.lastBidPlaced ? 'Outbid → ' : 'Bid → ') + nextBid.toLocaleString());

      if (!state.dryRun) {
        clickLikeUser(makeBid);
        state.lastBidPlaced = nextBid;
        await sleep(500);
        var confirmBid = findControl([/^Confirm$/i, /^Yes$/i, /^OK$/i]);
        if (confirmBid) clickLikeUser(confirmBid);
      }
    }
  }

  function wonPrice() {
    var m = text(document.body ? document.body.innerText : '').match(/Congratulations,\s*you've won this item for\s*([\d,]+)/i);
    return m ? coin(m[1]) : 0;
  }

  async function handleWon() {
    var price = wonPrice();

    if (price && state.lastWinKey !== 'won:' + price) {
      state.lastWinKey = 'won:' + price;
      state.daily.won++;
      saveDaily();
    }

    log('WON ' + (price ? price.toLocaleString() : ''));

    if (!state.autoSell) {
      stop('Won item · auto relist disabled');
      return;
    }

    var list = findControl([/^List on Transfer Market$/i]);
    if (!list) {
      log('List on Transfer Market not found');
      return;
    }

    if (state.dryRun) {
      log('DRY RUN: would open sell form');
      return;
    }

    clickLikeUser(list);
    await sleep(700);
  }

  async function handleSell() {
    var stable = (state.currentTarget && state.currentTarget.stableBIN) || state.market.stableBIN;
    var boughtFor = wonPrice() || numberNear(/Bought For/i);

    if (!stable) {
      log('Sell: no stored BIN');
      return;
    }

    var step = priceStep(stable);
    var sellBIN = legalDown(stable - Math.max(0, state.undercutSteps) * step);
    var sellStart = legalDown(Math.max(150, sellBIN - step));

    var startInput = findInputNear(['start price']);
    var binInput = findInputNear(['buy now price']);
    var submit = findControl([/^List for Transfer$/i]);

    if (!startInput || !binInput || !submit) {
      log('Sell controls not fully detected');
      return;
    }

    log('List ' + sellStart.toLocaleString() + ' / ' + sellBIN.toLocaleString() + ' · 1 hour');

    if (state.dryRun) {
      log('DRY RUN: would list for 1 hour');
      return;
    }

    setInput(startInput, sellStart);
    setInput(binInput, sellBIN);

    var durationSet = await setSellDurationOneHour();
    if (!durationSet) {
      log('Sell paused · could not confirm 1 hour listing duration');
      return;
    }

    log('Sell duration · 1 hour');
    await sleep(250);
    clickLikeUser(submit);

    var estimatedNet = Math.floor(sellBIN * 0.95);
    var estProfit = Math.max(0, estimatedNet - boughtFor);

    state.daily.estimatedProfit += estProfit;
    state.daily.listed++;
    state.trades++;
    saveDaily();

    log('Listed · est +' + estProfit.toLocaleString());
    render();

    state.currentTarget = null;
    state.lastBidPlaced = 0;

    await sleep(900);
    navigateEaBack('trader');
    await sleep(900);
  }

  async function cycle() {
    if (stopReason() || state.busy) return;

    state.busy = true;
    render();

    try {
      var candidate = state.quickFlip && state.quickFlip.candidate;
      if (candidate && candidate.definitionId) {
        await monitorQuickFlipCandidate();
      } else {
        var p = pageType();
        if (p === 'results') await handleResults();
        else if (p === 'details') await handleDetails();
        else if (p === 'won') await handleWon();
        else if (p === 'sell') await handleSell();
        else log('Open Transfer Market search/results');
      }
    } catch (e) {
      log('Error: ' + (e && e.message ? e.message : String(e)));
    } finally {
      state.busy = false;
      render();

      if (state.running && !stopReason()) {
        clearTimeout(state.timer);
        state.timer = setTimeout(cycle, state.pollMs);
      }
    }
  }

  function start() {
    readUI();

    var candidate = state.quickFlip && state.quickFlip.candidate;
    if (!candidate || !candidate.definitionId) {
      log('AUTO · Scan Player first');
      return;
    }

    state.running = true;
    state.busy = false;
    state.trades = 0;
    state.sessionStarted = Date.now();
    state.lastBidPlaced = 0;
    state.lastQuickFlipDecision = '';
    state.lastQuickFlipDecisionAt = 0;
    state.currentTarget = {
      strategy: 'fcplus_quick_flip',
      definitionId: candidate.definitionId,
      name: candidate.name,
      rating: candidate.rating,
      stableBIN: candidate.stableBIN,
      maxBid: candidate.maxBid
    };

    state.quickFlip.status = 'Locked to ' + candidate.name + ' · monitoring exact EA player market';
    log(
      'LOCKED · ' + candidate.name + ' ' + candidate.rating +
      ' · EA ID ' + candidate.definitionId +
      ' · max entry ' + (candidate.maxBid || 0).toLocaleString()
    );
    if (!state.dryRun && state.liveTrade) {
      log('LIVE RESUME · reconciling pending ' + String(state.liveTrade.status || 'trade') + ' state first');
    }
    log(state.dryRun ? 'AUTO started · DRY RUN · exact candidate monitor' : 'AUTO started · LIVE · exact candidate trader');
    render();
    cycle();
  }

  function stop(reason) {
    state.running = false;
    state.busy = false;
    clearTimeout(state.timer);
    state.timer = null;
    log(reason || 'Stopped by user');
    render();
  }

  function positionLabel(value) {
    var w = pageWindow();
    if (value == null) return '';

    if (typeof value === 'string') {
      var s = value.trim();
      if (/^[A-Za-z]{1,4}$/.test(s)) return s.toUpperCase();
    }

    try {
      if (w.UTLocalizationUtil && typeof w.UTLocalizationUtil.positionIdToName === 'function' &&
          w.services && w.services.Localization) {
        var localized = w.UTLocalizationUtil.positionIdToName(value, w.services.Localization);
        if (localized) return String(localized).toUpperCase();
      }
    } catch (e) {}

    var fallback = String(value == null ? '' : value).trim();
    return /^[A-Za-z]{1,4}$/.test(fallback) ? fallback.toUpperCase() : '';
  }

  function alternatePositionLabels(player) {
    if (!player) return [];

    var raw = [];
    try {
      if (Array.isArray(player.possiblePositions)) raw = player.possiblePositions.slice();
      else if (Array.isArray(player.basePossiblePositions)) raw = player.basePossiblePositions.slice();
    } catch (e) {}

    var preferred = '';
    try { preferred = positionLabel(player.preferredPosition); } catch (e) {}

    var labels = [];
    raw.forEach(function (value) {
      var label = positionLabel(value);
      if (!label || label === preferred || labels.indexOf(label) >= 0) return;
      labels.push(label);
    });

    return labels.slice(0, 6);
  }

  var cardPriceCache = {};
  var cardPriceQueue = [];
  var cardPriceBusy = 0;
  var CARD_PRICE_TTL = 5 * 60 * 1000;

  function compactPrice(value) {
    var n = Number(value) || 0;
    if (!n) return '—';
    if (n >= 1000000) {
      var m = n / 1000000;
      return (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + 'M';
    }
    if (n >= 1000) {
      var k = n / 1000;
      return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'K';
    }
    return n.toLocaleString();
  }

  function removeCardExtras(view) {
    try {
      if (view && view._fcplusAltPositions && view._fcplusAltPositions.parentNode) {
        view._fcplusAltPositions.parentNode.removeChild(view._fcplusAltPositions);
      }
      if (view && view._fcplusCardPrice && view._fcplusCardPrice.parentNode) {
        view._fcplusCardPrice.parentNode.removeChild(view._fcplusCardPrice);
      }
      if (view) {
        view._fcplusAltPositions = null;
        view._fcplusCardPrice = null;
        view._fcplusPlayerName = '';
      }
    } catch (e) {}
  }

  function cachedCardPrice(definitionId) {
    var id = Number(definitionId) || 0;
    var hit = cardPriceCache[id];
    if (!hit) return 0;
    if (Date.now() - hit.at > CARD_PRICE_TTL) {
      delete cardPriceCache[id];
      return 0;
    }
    return Number(hit.price) || 0;
  }

  function setCardPriceBadge(view, price, source) {
    if (!view || !view._fcplusCardPrice) return;
    var badge = view._fcplusCardPrice;
    var n = Number(price) || 0;
    var playerName = text(view._fcplusPlayerName || 'Player');

    badge.classList.toggle('fcplus-price-loading', !n);
    badge.textContent = '';

    var name = document.createElement('b');
    name.className = 'fcplus-card-price-name';
    name.textContent = playerName;

    var sep = document.createElement('span');
    sep.className = 'fcplus-card-price-sep';
    sep.textContent = ' - ';

    badge.appendChild(name);
    badge.appendChild(sep);

    if (n) {
      var value = document.createElement('strong');
      value.className = 'fcplus-card-price-value';
      value.textContent = compactPrice(n);
      badge.appendChild(value);
    } else {
      var dots = document.createElement('span');
      dots.className = 'fcplus-price-dots';
      dots.textContent = '•••';
      badge.appendChild(dots);
    }

    badge.title = n
      ? (playerName + ' · Min BIN ' + n.toLocaleString() + ' coins · ' + (source || 'market'))
      : (playerName + ' · Min BIN loading');
  }

  function drainCardPriceQueue() {
    while (cardPriceBusy < 2 && cardPriceQueue.length) {
      var job = cardPriceQueue.shift();
      if (!job) continue;

      var id = Number(job.definitionId) || 0;
      if (!id) {
        job.resolve({ price: 0, source: 'none' });
        continue;
      }

      cardPriceBusy++;
      (async function (task) {
        var price = 0;
        var source = 'none';

        try {
          var fut = await futggCardPrice(task.definitionId);
          if (fut && fut.ok) {
            price = Number(fut.current || fut.salesMedian) || 0;
            source = 'FUT.GG';
          }
        } catch (e) {}

        // If FUT.GG is unavailable, use EA's card market-average field when available.
        if (!price && task.fallbackPrice) {
          price = Number(task.fallbackPrice) || 0;
          source = 'EA avg';
        }

        cardPriceCache[task.definitionId] = {
          price: price,
          source: source,
          at: Date.now()
        };

        task.resolve({ price: price, source: source });
      })(job).finally(function () {
        cardPriceBusy = Math.max(0, cardPriceBusy - 1);
        setTimeout(drainCardPriceQueue, 180);
      });
    }
  }

  function requestCardPrice(definitionId, fallbackPrice) {
    var id = Number(definitionId) || 0;
    if (!id) return Promise.resolve({ price: Number(fallbackPrice) || 0, source: 'EA avg' });

    var hit = cardPriceCache[id];
    if (hit && Date.now() - hit.at <= CARD_PRICE_TTL) {
      return Promise.resolve({ price: Number(hit.price) || 0, source: hit.source || 'cache' });
    }

    return new Promise(function (resolve) {
      cardPriceQueue.push({
        definitionId: id,
        fallbackPrice: Number(fallbackPrice) || 0,
        resolve: resolve
      });
      drainCardPriceQueue();
    });
  }

  function decoratePlayerCard(view, player) {
    if (!view || !player) return;
    removeCardExtras(view);

    var isPlayer = false;
    try {
      isPlayer = typeof player.isPlayer === 'function' ? player.isPlayer() : player.type === 'player';
    } catch (e) {
      isPlayer = player.type === 'player';
    }
    if (!isPlayer) return;

    var root = view.__root || (typeof view.getRootElement === 'function' ? view.getRootElement() : null);
    if (!root) return;

    // All FC+ card UI is anchored to UTPlayerItemView.__root so it stays with
    // the card artwork in Club, Squads, Transfer Market, SBC and other lists.
    var host = root;
    try {
      host.classList.add('fcplus-card-host');
      var computed = getComputedStyle(host);
      if (computed.position === 'static') host.style.position = 'relative';
      host.style.overflow = 'visible';
      host.style.zIndex = host.style.zIndex || '1';
      if (host.parentElement) host.parentElement.style.overflow = 'visible';
    } catch (e) {}

    if (state.showAltPositions) {
      var positions = alternatePositionLabels(player);
      if (positions.length) {
        var stack = document.createElement('div');
        stack.className = 'fcplus-alt-pos-stack';
        stack.setAttribute('data-fcplus-defid', String(Number(player.definitionId) || 0));

        positions.forEach(function (pos) {
          var chip = document.createElement('span');
          chip.textContent = pos;
          stack.appendChild(chip);
        });

        host.appendChild(stack);
        view._fcplusAltPositions = stack;
      }
    }

    var playerName = '';
    try {
      playerName = text(
        (player._staticData && (player._staticData.name || player._staticData.commonName || player._staticData.lastName)) ||
        player.name ||
        ''
      );
    } catch (e) {}
    view._fcplusPlayerName = playerName || 'Player';

    if (state.showCardPrices) {
      var badge = document.createElement('div');
      badge.className = 'fcplus-card-price fcplus-price-loading';
      badge.setAttribute('data-fcplus-defid', String(Number(player.definitionId) || 0));
      badge.textContent = (view._fcplusPlayerName || 'Player') + ' - •••';
      host.appendChild(badge);
      view._fcplusCardPrice = badge;

      var fallback = 0;
      try { fallback = Number(player._marketAverage || player.marketAverage) || 0; } catch (e) {}

      var cached = cachedCardPrice(player.definitionId);
      if (cached) {
        var cachedSource = cardPriceCache[Number(player.definitionId)] && cardPriceCache[Number(player.definitionId)].source;
        setCardPriceBadge(view, cached, cachedSource || 'cache');
      } else {
        requestCardPrice(player.definitionId, fallback).then(function (result) {
          if (!view || !view._fcplusCardPrice || !view._fcplusCardPrice.isConnected) return;
          setCardPriceBadge(view, result.price, result.source);
        });
      }
    }
  }

  function installPlayerCardEnhancer() {
    var w = pageWindow();
    var Ctor;
    try { Ctor = w.UTPlayerItemView; } catch (e) { Ctor = null; }
    if (!Ctor || !Ctor.prototype || typeof Ctor.prototype.renderItem !== 'function') return false;

    var current = Ctor.prototype.renderItem;
    if (current.__fcplusCardDecor085) return true;

    var wrapped = function (player, template) {
      var result = current.apply(this, arguments);
      var view = this;
      setTimeout(function () {
        try { decoratePlayerCard(view, player); } catch (e) {}
      }, 0);
      return result;
    };

    try {
      Object.defineProperty(wrapped, '__fcplusCardDecor085', { value: true });
    } catch (e) {
      wrapped.__fcplusCardDecor085 = true;
    }

    Ctor.prototype.renderItem = wrapped;
    return true;
  }

  function refreshVisibleAltPositions() {
    if (!state.showAltPositions) {
      Array.from(document.querySelectorAll('.fcplus-alt-pos-stack')).forEach(function (el) { el.remove(); });
    }
    if (!state.showCardPrices) {
      Array.from(document.querySelectorAll('.fcplus-card-price')).forEach(function (el) { el.remove(); });
    }
  }

  function openNativePanel() {
    var root = document.getElementById(APP_ID);
    if (!root) return;
    root.classList.add('fcp-open');
    root.style.setProperty('display', 'block', 'important');
    root.style.setProperty('pointer-events', 'auto', 'important');
    var body = root.querySelector('#fcp-body');
    if (body) body.style.display = '';
    render();
  }

  function closeNativePanel() {
    var root = document.getElementById(APP_ID);
    if (!root) return;
    root.classList.remove('fcp-open');
    root.style.removeProperty('display');
    root.style.removeProperty('pointer-events');
  }

  var backGuardInstalled = false;
  var backGuardBusy = false;
  var backGuardStateKey = '__fcplusBackGuard086';

  function fcPlusPanelOpen() {
    var root = document.getElementById(APP_ID);
    return !!(root && root.classList.contains('fcp-open'));
  }

  function eaNavigationController() {
    var w = pageWindow();
    var candidates = [];

    try {
      var controller = currentEaController();
      if (controller) {
        if (typeof controller.getNavigationController === 'function') {
          candidates.push(controller.getNavigationController());
        }
        if (controller.rootController && typeof controller.rootController.getRootNavigationController === 'function') {
          candidates.push(controller.rootController.getRootNavigationController());
        }
      }
    } catch (e) {}

    try {
      if (typeof w.getCurrentViewController === 'function') {
        var current = w.getCurrentViewController();
        if (current) {
          if (typeof current.getNavigationController === 'function') {
            candidates.push(current.getNavigationController());
          }
          if (current.rootController && typeof current.rootController.getRootNavigationController === 'function') {
            candidates.push(current.rootController.getRootNavigationController());
          }
        }
      }
    } catch (e) {}

    try {
      var app = w.getAppMain && w.getAppMain();
      var root = app && app.getRootViewController && app.getRootViewController();
      var presented = root && root.getPresentedViewController && root.getPresentedViewController();
      var currentView = presented && presented.getCurrentViewController && presented.getCurrentViewController();
      if (currentView) {
        if (typeof currentView.getNavigationController === 'function') {
          candidates.push(currentView.getNavigationController());
        }
        if (currentView.rootController && typeof currentView.rootController.getRootNavigationController === 'function') {
          candidates.push(currentView.rootController.getRootNavigationController());
        }
      }
    } catch (e) {}

    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && typeof candidates[i].popViewController === 'function') return candidates[i];
    }
    return null;
  }

  function eaNavigationDepth(nav) {
    if (!nav) return null;
    var props = [
      'viewControllers','_viewControllers','controllers','_controllers',
      'stack','_stack','viewControllerStack','_viewControllerStack'
    ];
    for (var i = 0; i < props.length; i++) {
      try {
        var value = nav[props[i]];
        if (Array.isArray(value)) return value.length;
        if (value && typeof value.length === 'number') return Number(value.length);
      } catch (e) {}
    }
    try {
      if (typeof nav.getViewControllers === 'function') {
        var list = nav.getViewControllers();
        if (Array.isArray(list)) return list.length;
      }
    } catch (e) {}
    return null;
  }

  function visibleEaBackControl() {
    var nodes = Array.from(document.querySelectorAll(
      'button,a,[role="button"],[aria-label],[title],[class*="back"],[class*="Back"]'
    )).filter(visible);

    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].closest && nodes[i].closest('#' + APP_ID)) continue;
      var hint = lower(
        (nodes[i].getAttribute && (nodes[i].getAttribute('aria-label') || '')) + ' ' +
        (nodes[i].getAttribute && (nodes[i].getAttribute('title') || '')) + ' ' +
        (nodes[i].className || '') + ' ' +
        (nodes[i].textContent || '')
      );
      if (/(^|\s|[-_])back($|\s|[-_])/.test(hint) || hint === 'back') return nodes[i];
    }
    return null;
  }

  function navigateEaBack(reason) {
    if (fcPlusPanelOpen()) {
      closeNativePanel();
      return true;
    }

    var nav = eaNavigationController();
    var depth = eaNavigationDepth(nav);
    var nativeBack = visibleEaBackControl();

    // If EA exposes a native back control, prefer the same UI action the user
    // would tap. It preserves controller-specific cleanup.
    if (nativeBack) {
      try {
        clickLikeUser(nativeBack);
        return true;
      } catch (e) {}
    }

    // Fall back to EA's internal navigation controller. If the stack depth is
    // known and already at root, do not pop out of the authenticated app.
    if (nav && (depth === null || depth > 1)) {
      try {
        nav.popViewController();
        return true;
      } catch (e) {}
    }

    // Root screen: intentionally stay inside EA instead of letting Firefox
    // navigate away to the login/previous browser page.
    if (reason === 'gesture') {
      var action = document.querySelector('#fcp-action');
      if (action) action.textContent = 'Back · already at EA root';
    }
    return false;
  }

  function armBackGuard() {
    if (backGuardInstalled) return;
    backGuardInstalled = true;

    try {
      var base = Object.assign({}, history.state || {});
      base[backGuardStateKey] = 'base';
      history.replaceState(base, document.title, location.href);

      var guard = Object.assign({}, base);
      guard[backGuardStateKey] = 'guard';
      history.pushState(guard, document.title, location.href);
    } catch (e) {
      backGuardInstalled = false;
      return;
    }

    window.addEventListener('popstate', function () {
      if (backGuardBusy) return;
      backGuardBusy = true;

      try {
        // Restore a same-document guard immediately so Android/Firefox Back
        // cannot leave the EA Web App and trigger a login/session restart.
        var next = Object.assign({}, history.state || {});
        next[backGuardStateKey] = 'guard';
        history.pushState(next, document.title, location.href);
      } catch (e) {}

      try {
        navigateEaBack('gesture');
      } finally {
        setTimeout(function () { backGuardBusy = false; }, 180);
      }
    }, true);
  }

  function exactTextNode(label) {
    var nodes = Array.from(document.querySelectorAll('span,div,p,label,a,button'));
    var wanted = lower(label);
    for (var i = 0; i < nodes.length; i++) {
      if (!visible(nodes[i])) continue;
      if (lower(nodes[i].textContent || '') === wanted) return nodes[i];
    }
    return null;
  }

  function clickableAncestor(el) {
    var node = el;
    for (var i = 0; i < 6 && node; i++, node = node.parentElement) {
      if (!node || !node.getBoundingClientRect) continue;
      var role = node.getAttribute ? node.getAttribute('role') : '';
      if (node.tagName === 'BUTTON' || node.tagName === 'A' || role === 'button') return node;
      var r = node.getBoundingClientRect();
      if (r.height >= 44 && r.height <= 100 && r.width >= 45 && r.width <= 180) return node;
    }
    return el;
  }

  function findBottomNav() {
    var labels = ['Home', 'Squads', 'Transfers', 'Store', 'Club'];
    var hits = labels.map(exactTextNode).filter(Boolean);
    if (hits.length < 3) return null;

    var node = hits[0];
    for (var depth = 0; depth < 7 && node; depth++, node = node.parentElement) {
      var txt = lower(node.textContent || '');
      var count = labels.filter(function (x) { return txt.indexOf(lower(x)) >= 0; }).length;
      var r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (count >= 3 && r && r.top > window.innerHeight * 0.70 && r.height < 150) return node;
    }
    return null;
  }

  function installNativeNav() {
    if (document.getElementById('fcp-native-nav')) return;

    var nav = findBottomNav();
    if (!nav) return;

    var item = document.createElement('button');
    item.id = 'fcp-native-nav';
    item.type = 'button';
    item.innerHTML =
      '<span class="fcp-nav-icon">F+</span>' +
      '<span class="fcp-nav-label">FC+</span>';
    item.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openNativePanel();
    });

    nav.appendChild(item);
  }

  function nativeActionAnchor() {
    var bio = exactTextNode('Player Bio');
    if (bio) return clickableAncestor(bio);
    var compare = exactTextNode('Compare Price');
    if (compare) return clickableAncestor(compare);
    var list = exactTextNode('List on Transfer Market');
    if (list) return clickableAncestor(list);
    return null;
  }

  function installPlayerAction() {
    if (document.getElementById('fcp-player-smart')) return;

    var t = pageText();
    if (t.indexOf('player details') < 0 && t.indexOf('item details') < 0) return;

    var anchor = nativeActionAnchor();
    if (!anchor || !anchor.parentElement) return;

    var row = document.createElement('button');
    row.id = 'fcp-player-smart';
    row.type = 'button';
    row.className = 'fcp-native-action';
    row.innerHTML =
      '<span>FC+ Smart Price</span>' +
      '<small>FUT.GG + EA live validation</small>' +
      '<b>›</b>';

    row.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openNativePanel();
      setTimeout(function () {
        smartPriceScan();
      }, 80);
    });

    anchor.parentElement.insertBefore(row, anchor);
  }

  var lastNativeActionAt = 0;

  function handleNativeAction(target, e) {
    if (!target || !target.closest) return false;

    var nav = target.closest('#fcp-native-nav');
    var smart = target.closest('#fcp-player-smart');
    if (!nav && !smart) return false;

    var now = Date.now();
    if (now - lastNativeActionAt < 350) return true;
    lastNativeActionAt = now;

    if (e) {
      try { e.preventDefault(); } catch (x) {}
      try { e.stopPropagation(); } catch (x) {}
      try { e.stopImmediatePropagation(); } catch (x) {}
    }

    if (nav) {
      openNativePanel();
      return true;
    }

    if (smart) {
      openNativePanel();
      setTimeout(function () { smartPriceScan(); }, 120);
      return true;
    }

    return false;
  }

  function installNativeInteractionBridge() {
    if (window.__fcplusNativeBridge041) return;
    window.__fcplusNativeBridge041 = true;

    document.addEventListener('pointerup', function (e) {
      handleNativeAction(e.target, e);
    }, true);

    document.addEventListener('click', function (e) {
      handleNativeAction(e.target, e);
    }, true);

    document.addEventListener('touchend', function (e) {
      handleNativeAction(e.target, e);
    }, { capture: true, passive: false });
  }

  function nativeUiHeartbeat() {
    armBackGuard();
    installNativeNav();
    installPlayerAction();
    installPlayerCardEnhancer();
  }

  function createUI() {
    state.running = false;
    state.busy = false;
    state.liveTrade = null;
    state.dryRun = true;
    state.autoBid = false;
    state.autoBuyNow = false;
    state.autoSell = false;

    var root = document.createElement('section');
    root.id = APP_ID;
    root.innerHTML =
      '<div class="fcp-native-head">' +
        '<button id="fcp-close" type="button">‹</button>' +
        '<div><b>FC+ Scout</b><small>v0.9.0 · Market Scout</small></div>' +
        '<span id="fcp-headstate">SCOUT</span>' +
      '</div>' +
      '<div id="fcp-body" class="fcp-native-body">' +

        '<section class="fcp-section fcp-method-card">' +
          '<div class="fcp-eyebrow">MARKET SCOUT</div>' +
          '<div class="fcp-method-title-row">' +
            '<div><h2>FC+ Scout</h2><p>FC+ finds opportunities. You decide when to search and snipe manually.</p></div>' +
            '<span id="fcp-state" data-on="0">MANUAL</span>' +
          '</div>' +
          '<div class="fcp-quality-picker" role="radiogroup" aria-label="Scout card quality">' +
            '<label><input type="radio" name="fcp-quality" value="bronze"' + (state.quickFlipQuality === 'bronze' ? ' checked' : '') + '><span>Bronze</span></label>' +
            '<label><input type="radio" name="fcp-quality" value="silver"' + (state.quickFlipQuality === 'silver' ? ' checked' : '') + '><span>Silver</span></label>' +
            '<label><input type="radio" name="fcp-quality" value="gold"' + (state.quickFlipQuality === 'gold' ? ' checked' : '') + '><span>Gold</span></label>' +
            '<label><input type="radio" name="fcp-quality" value="special"' + (state.quickFlipQuality === 'special' ? ' checked' : '') + '><span>Special</span></label>' +
          '</div>' +
          '<button id="fcp-scanplayer" class="fcp-primary" type="button" >SCAN MARKET</button>' +
        '</section>' +

        '<section class="fcp-section">' +
          '<div class="fcp-section-title"><h3>Best Opportunity</h3><span id="fcp-scout-count">0 candidates</span></div>' +
          '<div id="fcp-result-status" class="fcp-result-status">Ready to scan ' + quickFlipQualityLabel() + ' players</div>' +
          '<div class="fcp-result-grid">' +
            '<div class="fcp-result-player"><small>PLAYER</small><b id="fcp-result-player">—</b></div>' +
            '<div><small>MARKET</small><b id="fcp-result-market">—</b></div>' +
            '<div><small>PRICE RANGE</small><b id="fcp-result-range">—</b></div>' +
            '<div><small>SNIPE ≤</small><b id="fcp-result-maxbid">—</b></div>' +
            '<div><small>TARGET PROFIT</small><b id="fcp-result-profit">—</b></div>' +
          '</div>' +
          '<div id="fcp-result-meta" class="fcp-result-meta">No scan yet</div>' +
          '<div class="fcp-scout-list-title">SCOUTING RESULTS</div>' +
          '<div id="fcp-scout-results" class="fcp-scout-results"></div>' +
        '</section>' +

        '<section class="fcp-section">' +
          '<div class="fcp-section-title"><h3>Scout Rules</h3><button id="fcp-edit-conditions" class="fcp-link-btn" type="button">EDIT</button></div>' +
          '<div class="fcp-condition-chips">' +
            '<span id="fcp-cond-quality">' + quickFlipQualityLabel() + ' only</span>' +
            '<span id="fcp-cond-profit">Target +' + state.quickFlipPreferredProfit + ' · floor +' + state.minProfit + '</span>' +
            '<span>Manual snipe</span>' +
            '<span>No automatic buying</span>' +
          '</div>' +
        '</section>' +

        '<details class="fcp-fold">' +
          '<summary><span>SBC Scanner</span><b>›</b></summary>' +
          '<div class="fcp-fold-body">' +
            '<div class="fcp-settings-block">' +
              '<div class="fcp-section-title"><h3>SBC</h3><span id="fcp-sbc-status">Scan EA SBCs to begin</span></div>' +
              '<button id="fcp-sbc-scan" class="fcp-primary fcp-secondary-green" type="button">SCAN SBC</button>' +
              '<div class="fcp-sbc-label">AVAILABLE SBC</div>' +
              '<div id="fcp-sbc-sets" class="fcp-sbc-list"></div>' +
              '<div class="fcp-sbc-label">CHALLENGES</div>' +
              '<div id="fcp-sbc-challenges" class="fcp-sbc-list"></div>' +
              '<div class="fcp-sbc-label">REQUIREMENTS</div>' +
              '<div id="fcp-sbc-reqs" class="fcp-sbc-reqs"><div class="fcp-sbc-empty">Choose an SBC challenge</div></div>' +
              '<button id="fcp-sbc-scanplayers" class="fcp-primary fcp-sbc-player-btn" type="button" disabled>SCAN PLAYERS FROM REQUIREMENTS</button>' +
              '<div class="fcp-sbc-label">PLAYER CANDIDATES</div>' +
              '<div id="fcp-sbc-players" class="fcp-sbc-players"></div>' +
            '</div>' +
          '</div>' +
        '</details>' +

        '<details class="fcp-fold">' +
          '<summary><span>Smart Price</span><b>›</b></summary>' +
          '<div class="fcp-fold-body">' +
            '<div class="fcp-market">' +
              '<div><small>MIN BIN</small><b id="fcp-minbin">—</b></div>' +
              '<div><small>STABLE BIN</small><b id="fcp-bin">—</b></div>' +
              '<div><small>MIN BID</small><b id="fcp-bid">—</b></div>' +
              '<div><small>MAX ENTRY</small><b id="fcp-maxbid">—</b></div>' +
            '</div>' +
            '<div class="fcp-sourcebar">' +
              '<span>FUT.GG <b id="fcp-futgg">—</b></span>' +
              '<span>SOURCE <b id="fcp-source">PAGE</b></span>' +
              '<span>CONF <b id="fcp-confidence">—</b></span>' +
            '</div>' +
            '<div id="fcp-scaninfo" class="fcp-scaninfo">Not scanned</div>' +
            '<button id="fcp-smartprice" class="fcp-smartprice" type="button">SMART PRICE</button>' +
            '<div class="fcp-fastrow">' +
              '<button id="fcp-fastbin" type="button">EA FAST BIN</button>' +
              '<button id="fcp-scanall" type="button">FULL PAGE SCAN</button>' +
            '</div>' +
          '</div>' +
        '</details>' +

        '<details id="fcp-settings-fold" class="fcp-fold">' +
          '<summary><span>Settings</span><b>›</b></summary>' +
          '<div class="fcp-fold-body">' +
            '<div class="fcp-settings-block">' +
              '<h3>Scout</h3>' +
              '<div class="fcp-grid three">' +
                '<label>TARGET PROFIT<input id="fcp-targetprofit" type="number" inputmode="numeric" value="' + state.quickFlipPreferredProfit + '"></label>' +
                '<label>MIN PROFIT<input id="fcp-minprofit" type="number" inputmode="numeric" value="' + state.minProfit + '"></label>' +
              '</div>' +
            '</div>' +

            '<div class="fcp-settings-block">' +
              '<h3>Player Cards</h3>' +
              '<div class="fcp-switches fcp-display-switches">' +
                '<label><span><b>Alternate positions</b><small>FUTBIN-style position tabs attached to the right edge of each card.</small></span><input id="fcp-altpositions" type="checkbox"' + (state.showAltPositions ? ' checked' : '') + '></label>' +
                '<label><span><b>Min BIN price</b><small>Show a compact market-price badge below every player card.</small></span><input id="fcp-cardprices" type="checkbox"' + (state.showCardPrices ? ' checked' : '') + '></label>' +
              '</div>' +
            '</div>' +

            '<div class="fcp-settings-block">' +
              '<h3>Scan</h3>' +
              '<div class="fcp-grid">' +
                '<label>FULL SCAN PAGE CAP<input id="fcp-maxscanpages" type="number" inputmode="numeric" min="1" max="100" value="' + state.maxScanPages + '"></label>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</details>' +

        '<section class="fcp-section fcp-diagnostics">' +
          '<div class="fcp-section-title"><h3>Diagnostic</h3><span>latest first</span></div>' +
          '<div id="fcp-log"></div>' +
        '</section>' +
      '</div>';

    document.documentElement.appendChild(root);

    root.querySelector('#fcp-close').addEventListener('click', closeNativePanel);

    root.querySelector('#fcp-scanplayer').addEventListener('click', function () {
      scanQuickFlipPlayers();
    });

    root.querySelector('#fcp-edit-conditions').addEventListener('click', function () {
      var fold = root.querySelector('#fcp-settings-fold');
      if (!fold) return;
      fold.open = true;
      setTimeout(function () {
        try { fold.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { fold.scrollIntoView(); }
      }, 40);
    });

    root.querySelector('#fcp-sbc-scan').addEventListener('click', function () {
      scanSbcSets();
    });

    root.querySelector('#fcp-sbc-scanplayers').addEventListener('click', function () {
      scanPlayersForSelectedSbc();
    });

    root.querySelector('#fcp-smartprice').addEventListener('click', function () {
      readUI();
      smartPriceScan();
    });

    root.querySelector('#fcp-fastbin').addEventListener('click', function () {
      readUI();
      fastMinBinScan();
    });

    root.querySelector('#fcp-scanall').addEventListener('click', function () {
      readUI();
      scanAllMarketPages();
    });

    Array.from(root.querySelectorAll('input')).forEach(function (input) {
      input.addEventListener('change', function () {
        if (input.name === 'fcp-quality') {
          state.quickFlipQuality = lower(input.value || 'silver');
          state.quickFlip.candidate = null;
          state.quickFlip.scoutResults = [];
          state.quickFlip.scannedAt = 0;
          state.quickFlip.scannedListings = 0;
          state.quickFlip.uniquePlayers = 0;
          state.quickFlip.checkedPlayers = 0;
          state.quickFlip.status = 'Ready to scan ' + quickFlipQualityLabel() + ' players';
          saveSettings();
          render();
          log('SCOUT · quality changed to ' + quickFlipQualityLabel());
          return;
        }

        readUI();
        if (input.id === 'fcp-altpositions' || input.id === 'fcp-cardprices') refreshVisibleAltPositions();
        renderQuickFlip();
      });
    });

    render();
    renderSbcPanel();
    log('Ready · FC+ Market Scout · manual trading only');

    installNativeInteractionBridge();
    installPlayerCardEnhancer();
    nativeUiHeartbeat();
    setInterval(nativeUiHeartbeat, 350);
  }

  GM_addStyle(
    '#' + APP_ID + '{display:none;pointer-events:auto!important;position:fixed;inset:0 0 68px 0;z-index:2147483000;background:#1f2d3b;color:#f4f7f9;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:12px;overflow:hidden}' +
    '#' + APP_ID + '.fcp-open{display:block}' +
    '#' + APP_ID + ' *{box-sizing:border-box}' +
    '#' + APP_ID + ' .fcp-native-head{height:74px;display:grid;grid-template-columns:44px 1fr auto;gap:10px;align-items:center;padding:12px 16px;background:#101b29;border-bottom:1px solid #ffffff18}' +
    '#' + APP_ID + ' #fcp-close{width:40px;height:40px;border:0;background:transparent;color:#fff;font-size:34px;line-height:1}' +
    '#' + APP_ID + ' .fcp-native-head b{font-size:22px;font-weight:600}' +
    '#' + APP_ID + ' .fcp-native-head small{display:block;margin-top:2px;color:#ffffff70;font-size:10px}' +
    '#' + APP_ID + ' #fcp-headstate{padding:5px 8px;border-radius:5px;background:#ffffff13;color:#fff;font-size:9px;font-weight:800}' +
    '#' + APP_ID + ' .fcp-native-body{height:calc(100% - 74px);overflow:auto;padding:16px 14px 28px;background:linear-gradient(180deg,#233748,#182a38)}' +
    '#' + APP_ID + ' .fcp-section{margin-bottom:14px;padding:14px;border-radius:15px;background:#263746;border:1px solid #ffffff12;box-shadow:0 10px 28px #0002}' +
    '#' + APP_ID + ' .fcp-section h3{margin:0 0 10px;font-size:17px;font-weight:600}' +
    '#' + APP_ID + ' .fcp-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}' +
    '#' + APP_ID + ' #fcp-state{padding:5px 9px;border-radius:99px;background:#ffffff12;color:#ffffff80;font-weight:900;font-size:10px}' +
    '#' + APP_ID + ' #fcp-state[data-on="1"]{background:#00ef8830;color:#83ffc3}' +
    '#' + APP_ID + ' .fcp-market{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}' +
    '#' + APP_ID + ' .fcp-market>div{padding:11px;border-radius:10px;background:#172431;min-width:0}' +
    '#' + APP_ID + ' .fcp-market small{display:block;color:#ffffff70;font-size:9px}' +
    '#' + APP_ID + ' .fcp-market b{display:block;margin-top:3px;font-size:18px;overflow:hidden;text-overflow:ellipsis}' +
    '#' + APP_ID + ' .fcp-sourcebar{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:8px}' +
    '#' + APP_ID + ' .fcp-sourcebar span{padding:7px;border-radius:8px;background:#172431;color:#ffffff65;font-size:8px;min-width:0}' +
    '#' + APP_ID + ' .fcp-sourcebar b{display:block;margin-top:2px;color:#fff;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#' + APP_ID + ' .fcp-scaninfo{padding:8px 9px;border-radius:8px;background:#172431;color:#ffffff75;font-size:9px}' +
    '#' + APP_ID + ' .fcp-smartprice{width:100%;height:44px;margin-top:9px;border:0;border-radius:9px;background:#00d978;color:#07150e;font-size:12px;font-weight:900}' +
    '#' + APP_ID + ' .fcp-smartprice:disabled{opacity:.55}' +
    '#' + APP_ID + ' .fcp-fastrow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}' +
    '#' + APP_ID + ' .fcp-fastrow button{height:40px;border:1px solid #ffffff18;border-radius:9px;background:#172431;color:#fff;font-size:10px;font-weight:800}' +
    '#' + APP_ID + ' .fcp-fastrow button:disabled{opacity:.55}' +
    '#' + APP_ID + ' .fcp-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}' +
    '#' + APP_ID + ' .fcp-grid.three{grid-template-columns:1fr 1fr 1fr}' +
    '#' + APP_ID + ' label{font-size:9px;color:#ffffff75;min-width:0}' +
    '#' + APP_ID + ' input:not([type="checkbox"]){width:100%;margin-top:4px;padding:10px;border-radius:8px;border:1px solid #ffffff1a;background:#101a24;color:#fff;font-size:13px;outline:none}' +
    '#' + APP_ID + ' .fcp-switches{margin-top:10px;border-top:1px solid #ffffff10}' +
    '#' + APP_ID + ' .fcp-switches label{display:flex;justify-content:space-between;align-items:center;min-height:52px;border-bottom:1px solid #ffffff10;color:#fff;font-size:14px}' +
    '#' + APP_ID + ' .fcp-switches input{width:22px;height:22px;accent-color:#00df7a}' +
    '#' + APP_ID + ' .fcp-profit{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:9px;border-radius:9px;background:#172431;font-size:10px;color:#ffffff80}' +
    '#' + APP_ID + ' .fcp-profit b{color:#fff;font-size:11px;text-align:right}' +
    '#' + APP_ID + ' #fcp-action{margin-top:9px;padding:9px;border-radius:9px;background:#172431;color:#dce4e9;font-size:10px}' +
    '#' + APP_ID + ' .fcp-start{width:100%;margin-top:9px;padding:13px;border:0;border-radius:10px;background:#00d978;color:#06150d;font-weight:900;font-size:13px}' +
    '#' + APP_ID + ' .fcp-start[data-on="1"]{background:#ff5865;color:#fff}' +
    '#' + APP_ID + ' .fcp-scout-list-title{margin:13px 0 7px;color:#ffffff60;font-size:8px;font-weight:900;letter-spacing:.11em}' +
    '#' + APP_ID + ' .fcp-scout-results{display:flex;flex-direction:column;gap:8px}' +
    '#' + APP_ID + ' .fcp-scout-card{padding:10px;border-radius:11px;background:#172431;border:1px solid #ffffff10}' +
    '#' + APP_ID + ' .fcp-scout-card.best{border-color:#00d97866;background:#173229}' +
    '#' + APP_ID + ' .fcp-scout-card-top{display:flex;align-items:center;justify-content:space-between;gap:10px}' +
    '#' + APP_ID + ' .fcp-scout-identity{min-width:0}' +
    '#' + APP_ID + ' .fcp-scout-identity b{display:block;color:#fff;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#' + APP_ID + ' .fcp-scout-identity small{display:block;margin-top:2px;color:#ffffff60;font-size:8px}' +
    '#' + APP_ID + ' .fcp-scout-target{flex:0 0 auto;text-align:right}' +
    '#' + APP_ID + ' .fcp-scout-target small{display:block;color:#ffffff55;font-size:7px}' +
    '#' + APP_ID + ' .fcp-scout-target b{display:block;color:#7dffc0;font-size:14px}' +
    '#' + APP_ID + ' .fcp-scout-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}' +
    '#' + APP_ID + ' .fcp-scout-metrics span{padding:7px;border-radius:8px;background:#101a24;min-width:0}' +
    '#' + APP_ID + ' .fcp-scout-metrics small{display:block;color:#ffffff55;font-size:7px}' +
    '#' + APP_ID + ' .fcp-scout-metrics b{display:block;margin-top:2px;color:#fff;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#' + APP_ID + ' .fcp-scout-empty{padding:11px;border-radius:9px;background:#172431;color:#ffffff60;font-size:9px}' +
    '#' + APP_ID + ' #fcp-log{margin-top:9px;max-height:112px;overflow:auto;padding:8px;border-radius:8px;background:#0d1720;color:#ffffff70;font:9px/1.45 ui-monospace,monospace}' +
    '#' + APP_ID + ' #fcp-log div{padding:2px 0;border-bottom:1px solid #ffffff08}' +

    '#fcp-native-nav{appearance:none!important;-webkit-appearance:none!important;pointer-events:auto!important;touch-action:manipulation!important;position:relative!important;z-index:20!important;flex:1 1 0;min-width:52px;height:64px;border:0;background:transparent;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:0;margin:0}' +
    '#fcp-native-nav .fcp-nav-icon{width:29px;height:29px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:#00d978;color:#07150e;font-weight:950;font-size:13px}' +
    '#fcp-native-nav .fcp-nav-label{font-size:10px;color:#fff}' +

    '.fcp-native-action{position:relative!important;z-index:20!important;pointer-events:auto!important;touch-action:manipulation!important;width:100%;min-height:62px;padding:10px 42px 10px 18px;border:0;border-top:1px solid #ffffff16;border-bottom:1px solid #ffffff16;background:transparent;color:#fff;text-align:left;font-family:system-ui,-apple-system,Segoe UI,sans-serif}' +
    '.fcp-native-action span{display:block!important;font-size:18px!important;line-height:1.25!important}' +
    '.fcp-native-action small{display:block!important;margin-top:4px!important;font-size:11px!important;line-height:1.25!important;color:#ffffff70!important}' +
    '.fcp-native-action b{position:absolute;right:18px;top:50%;transform:translateY(-50%);font-size:30px;font-weight:300}' +
    '#' + APP_ID + ' .fcp-display-switches label>span{display:flex;flex-direction:column;gap:3px}' +
    '#' + APP_ID + ' .fcp-display-switches label>span>b{font-size:14px;font-weight:600}' +
    '#' + APP_ID + ' .fcp-display-switches label>span>small{font-size:10px;line-height:1.3;color:#ffffff6f;max-width:230px}' +
    '.fcplus-card-host{overflow:visible!important}' +
    '.fcplus-alt-pos-stack{position:absolute!important;right:-5px!important;top:7px!important;z-index:45!important;display:flex!important;flex-direction:column!important;gap:2px!important;pointer-events:none!important;filter:drop-shadow(0 1px 2px rgba(0,0,0,.38))!important}' +
    '.fcplus-alt-pos-stack span{display:flex!important;align-items:center!important;justify-content:center!important;min-width:25px!important;height:16px!important;padding:0 4px!important;border-radius:4px!important;background:rgba(18,26,36,.90)!important;color:#f6f0d5!important;border:1px solid rgba(239,224,169,.72)!important;font:800 8px/1 system-ui,-apple-system,Segoe UI,sans-serif!important;letter-spacing:-.1px!important;box-shadow:inset 2px 0 0 rgba(239,224,169,.75)!important}' +
    '.phone .fcplus-alt-pos-stack{right:-4px!important;top:6px!important}' +
    '.phone .fcplus-alt-pos-stack span{min-width:23px!important;height:15px!important;padding:0 3px!important;font-size:7px!important}' +

    '.fcplus-card-price{position:absolute!important;left:50%!important;bottom:2px!important;transform:translateX(-50%)!important;z-index:47!important;max-width:94%!important;min-width:78px!important;height:20px!important;padding:0 7px!important;border-radius:6px!important;display:flex!important;align-items:center!important;justify-content:center!important;background:rgba(13,22,31,.96)!important;border:1px solid rgba(242,213,76,.78)!important;color:#fff!important;box-shadow:0 2px 5px rgba(0,0,0,.45)!important;white-space:nowrap!important;overflow:hidden!important;pointer-events:none!important;font:800 8px/1 system-ui,-apple-system,Segoe UI,sans-serif!important}' +
    '.fcplus-card-price-name{min-width:0!important;max-width:58px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;color:#fff!important;font:800 8px/1 system-ui,-apple-system,Segoe UI,sans-serif!important}' +
    '.fcplus-card-price-sep{flex:0 0 auto!important;color:rgba(255,255,255,.55)!important}' +
    '.fcplus-card-price-value{flex:0 0 auto!important;color:#ffe26b!important;font:900 9px/1 system-ui,-apple-system,Segoe UI,sans-serif!important}' +
    '.fcplus-card-price.fcplus-price-loading{border-color:rgba(255,255,255,.22)!important;color:#ffffff9c!important}' +
    '.fcplus-card-price .fcplus-price-dots{flex:0 0 auto!important;font-size:8px!important;letter-spacing:1px!important}' +
    '.phone .fcplus-card-price{bottom:2px!important;max-width:94%!important;min-width:74px!important;height:19px!important;padding:0 6px!important;border-radius:5px!important;font-size:8px!important}'
  );


  GM_addStyle(
    '#' + APP_ID + ' .fcp-eyebrow{margin-bottom:6px;color:#75d8ff;font-size:9px;font-weight:900;letter-spacing:.12em}' +
    '#' + APP_ID + ' .fcp-method-card{background:linear-gradient(145deg,#2a4051,#233545)}' +
    '#' + APP_ID + ' .fcp-method-title-row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}' +
    '#' + APP_ID + ' .fcp-method-title-row h2{margin:0;color:#fff;font-size:22px;line-height:1.15}' +
    '#' + APP_ID + ' .fcp-method-title-row p{margin:5px 0 0;max-width:340px;color:#ffffff78;font-size:11px;line-height:1.4}' +
    '#' + APP_ID + ' .fcp-quality-picker{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:13px}' +
    '#' + APP_ID + ' .fcp-quality-picker label{position:relative;min-width:0}' +
    '#' + APP_ID + ' .fcp-quality-picker input{position:absolute;opacity:0;pointer-events:none}' +
    '#' + APP_ID + ' .fcp-quality-picker span{display:flex;align-items:center;justify-content:center;min-height:36px;padding:7px 4px;border-radius:10px;border:1px solid #ffffff18;background:#172431;color:#d8e1e7;font-size:9px;font-weight:850}' +
    '#' + APP_ID + ' .fcp-quality-picker input:checked+span{border-color:#00d978;background:#123d2c;color:#fff;box-shadow:inset 0 0 0 1px #00d97855}' +
    '#' + APP_ID + ' .fcp-quality-picker label:nth-child(1) input:checked+span{border-color:#cd7f32;background:#46311f}' +
    '#' + APP_ID + ' .fcp-quality-picker label:nth-child(2) input:checked+span{border-color:#cbd5df;background:#33404d}' +
    '#' + APP_ID + ' .fcp-quality-picker label:nth-child(3) input:checked+span{border-color:#f2cf5b;background:#4a4020}' +
    '#' + APP_ID + ' .fcp-quality-picker label:nth-child(4) input:checked+span{border-color:#b886ff;background:#34264a}' +
    '#' + APP_ID + ' .fcp-primary{width:100%;height:48px;margin-top:13px;border:0;border-radius:11px;background:#00d978;color:#07150e;font-size:13px;font-weight:950}' +
    '#' + APP_ID + ' .fcp-primary:disabled{opacity:.55}' +
    '#' + APP_ID + ' .fcp-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}' +
    '#' + APP_ID + ' .fcp-section-title h3{margin:0}' +
    '#' + APP_ID + ' .fcp-section-title>span{color:#ffffff6c;font-size:9px}' +
    '#' + APP_ID + ' .fcp-result-status{margin-bottom:9px;padding:9px 10px;border-radius:9px;background:#172431;color:#dce6ed;font-size:10px}' +
    '#' + APP_ID + ' .fcp-result-grid{display:grid;grid-template-columns:1.6fr 1fr;gap:8px}' +
    '#' + APP_ID + ' .fcp-result-grid>div{min-width:0;padding:10px;border-radius:10px;background:#172431}' +
    '#' + APP_ID + ' .fcp-result-grid small{display:block;color:#ffffff65;font-size:8px}' +
    '#' + APP_ID + ' .fcp-result-grid b{display:block;margin-top:3px;color:#fff;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#' + APP_ID + ' .fcp-result-player{grid-column:1/-1}' +
    '#' + APP_ID + ' .fcp-result-player b{font-size:17px}' +
    '#' + APP_ID + ' .fcp-result-meta{margin-top:8px;color:#ffffff62;font-size:9px}' +
    '#' + APP_ID + ' .fcp-link-btn{border:0;background:transparent;color:#75d8ff;font-size:9px;font-weight:900}' +
    '#' + APP_ID + ' .fcp-mode-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px;padding:10px;border-radius:11px;background:#172431}' +
    '#' + APP_ID + ' .fcp-mode-row>span{min-width:0}' +
    '#' + APP_ID + ' .fcp-mode-row b{display:block;color:#fff;font-size:11px}' +
    '#' + APP_ID + ' .fcp-mode-row small{display:block;margin-top:2px;color:#ffffff65;font-size:8px;line-height:1.35}' +
    '#' + APP_ID + ' .fcp-mode-toggle{min-width:82px;height:34px;border:1px solid #ffffff20;border-radius:9px;background:#293849;color:#fff;font-size:9px;font-weight:950}' +
    '#' + APP_ID + ' .fcp-mode-toggle[data-live="1"]{border-color:#00d978;background:#123d2c;color:#8fffc5}' +
    '#' + APP_ID + ' .fcp-mode-toggle:disabled{opacity:.5}' +
    '#' + APP_ID + ' .fcp-condition-chips{display:flex;flex-wrap:wrap;gap:7px}' +
    '#' + APP_ID + ' .fcp-condition-chips span{padding:7px 9px;border-radius:99px;background:#172431;border:1px solid #ffffff12;color:#eaf1f5;font-size:9px}' +
    '#' + APP_ID + ' .fcp-auto-card{background:#223847}' +
    '#' + APP_ID + ' .fcp-fold{margin-bottom:14px;border-radius:15px;background:#263746;border:1px solid #ffffff12;overflow:hidden;box-shadow:0 10px 28px #0002}' +
    '#' + APP_ID + ' .fcp-fold summary{list-style:none;display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:0 14px;color:#fff;font-size:15px;font-weight:800;cursor:pointer;user-select:none}' +
    '#' + APP_ID + ' .fcp-fold summary::-webkit-details-marker{display:none}' +
    '#' + APP_ID + ' .fcp-fold summary b{color:#ffffff70;font-size:24px;font-weight:400;transition:transform .18s ease}' +
    '#' + APP_ID + ' .fcp-fold[open] summary b{transform:rotate(90deg)}' +
    '#' + APP_ID + ' .fcp-fold-body{padding:0 14px 14px;border-top:1px solid #ffffff0e}' +
    '#' + APP_ID + ' .fcp-fold-body>.fcp-market{margin-top:14px}' +
    '#' + APP_ID + ' .fcp-secondary-green{margin-top:4px;background:#0fcf82}' +
    '#' + APP_ID + ' .fcp-sbc-label{margin:14px 0 7px;color:#ffffff66;font-size:8px;font-weight:900;letter-spacing:.11em}' +
    '#' + APP_ID + ' .fcp-sbc-list{display:flex;flex-direction:column;gap:7px}' +
    '#' + APP_ID + ' .fcp-sbc-choice{width:100%;padding:10px 11px;border:1px solid #ffffff14;border-radius:10px;background:#172431;color:#eaf1f5;text-align:left;font-size:10px;font-weight:750}' +
    '#' + APP_ID + ' .fcp-sbc-choice.small{padding:8px 10px;font-size:9px}' +
    '#' + APP_ID + ' .fcp-sbc-choice.selected{border-color:#00d978;background:#183329;color:#fff}' +
    '#' + APP_ID + ' .fcp-sbc-choice:disabled{opacity:.38}' +
    '#' + APP_ID + ' .fcp-sbc-reqs{display:flex;flex-direction:column;gap:6px}' +
    '#' + APP_ID + ' .fcp-sbc-req{padding:8px 9px;border-radius:9px;background:#172431;color:#dce6ed;font-size:9px;line-height:1.4}' +
    '#' + APP_ID + ' .fcp-sbc-empty{padding:9px;color:#ffffff58;font-size:9px}' +
    '#' + APP_ID + ' .fcp-sbc-player-btn{margin-top:12px}' +
    '#' + APP_ID + ' .fcp-sbc-players{display:flex;flex-direction:column;gap:6px}' +
    '#' + APP_ID + ' .fcp-sbc-player{display:flex;justify-content:space-between;gap:8px;padding:8px 9px;border-radius:9px;background:#172431}' +
    '#' + APP_ID + ' .fcp-sbc-player b{color:#fff;font-size:10px;line-height:1.45;white-space:normal;overflow-wrap:anywhere}' +
    '#' + APP_ID + ' .fcp-sbc-player-actions{display:flex;align-items:center;gap:7px;flex:0 0 auto}' +
    '#' + APP_ID + ' .fcp-sbc-player-actions span{color:#75d8ff;font-size:9px;white-space:nowrap}' +
    '#' + APP_ID + ' .fcp-sbc-quickscan{min-width:48px;height:28px;padding:0 8px;border:1px solid #00d97866;border-radius:8px;background:#123d2c;color:#8fffc5;font-size:8px;font-weight:900}' +
    '#' + APP_ID + ' .fcp-sbc-quickscan:disabled{opacity:.5}' +
    '#' + APP_ID + ' .fcp-sbc-player span{color:#75d8ff;font-size:9px;white-space:nowrap}' +
    '#' + APP_ID + ' .fcp-settings-block{padding:14px 0;border-bottom:1px solid #ffffff0e}' +
    '#' + APP_ID + ' .fcp-settings-block:last-child{border-bottom:0;padding-bottom:0}' +
    '#' + APP_ID + ' .fcp-settings-block h3{margin:0 0 10px}' +
    '#' + APP_ID + ' .fcp-diagnostics #fcp-log{max-height:300px;min-height:120px;margin-top:0}' +
    '#' + APP_ID + ' .fcp-diagnostics #fcp-log div{padding:6px 2px;line-height:1.45}'
  );


  function boot() {
    if (!document.body) {
      setTimeout(boot, 100);
      return;
    }
    createUI();
  }

  window.addEventListener('beforeunload', function () { stop('Page unloading'); });
  boot();
})();
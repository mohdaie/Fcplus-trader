// ==UserScript==
// @name         FC+ Auto Trader Mobile
// @namespace    https://fcplus.local/
// @version      0.5.1
// @description  FC+ Silver Quickflip market scanner, auto trader, card pricing and diagnostics for the EA FC Web App.
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
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var APP_ID = 'fcplus-auto-v051';
  if (document.getElementById(APP_ID)) return;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function text(v) { return (v || '').replace(/\s+/g, ' ').trim(); }
  function lower(v) { return text(v).toLowerCase(); }
  function coin(v) { return Number(String(v || '').replace(/[^\d]/g, '')) || 0; }
  function today() { return new Date().toISOString().slice(0, 10); }

  var DEFAULTS = {
    dryRun: true,
    autoBid: true,
    autoBuyNow: false,
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
    showCardPrices: true
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
    quickFlip: {
      candidate: null,
      scannedAt: 0,
      scannedListings: 0,
      uniquePlayers: 0,
      checkedPlayers: 0,
      status: 'Ready to scan silver players'
    },
    logHistory: [],
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
    daily: dailyStored.date === today() ? dailyStored : { date: today(), estimatedProfit: 0, won: 0, listed: 0 }
  });

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
      showCardPrices: state.showCardPrices
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
        marketAverage: Number(item && item._marketAverage) || 0
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


  function criteriaForSilverQuickFlip() {
    var w = pageWindow();
    if (!w.UTSearchCriteriaDTO) return null;

    var criteria = new w.UTSearchCriteriaDTO();
    try { criteria.count = 20; } catch (e) {}
    try { criteria.offset = 0; } catch (e) {}
    try { criteria.type = (w.SearchType && w.SearchType.PLAYER) || 'player'; } catch (e) {}
    try { criteria.level = 'silver'; } catch (e) {}
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

  async function scanSilverQuickFlipPlayers() {
    if (state.silverScanning) return;
    if (state.running) {
      log('Stop Auto Trade before scanning a new Silver Quickflip candidate');
      return;
    }

    readUI();
    state.silverScanning = true;
    state.quickFlip.status = 'Scanning EA silver market…';
    state.quickFlip.candidate = null;
    renderQuickFlip();
    log('SCAN · Silver Quickflip · searching EA silver market');

    var scanButton = document.querySelector('#fcp-scanplayer');
    if (scanButton) {
      scanButton.disabled = true;
      scanButton.textContent = 'SCANNING…';
    }

    try {
      var criteria = criteriaForSilverQuickFlip();
      if (!criteria) throw new Error('EA silver search is not available on this screen yet');

      var broadRows = [];
      for (var page = 1; page <= 3; page++) {
        log('SCAN · Silver market page ' + page + '/3');
        var pageRows = await eaSearchWithCriteria(criteria, page);
        broadRows = broadRows.concat(pageRows);
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

      if (!seeds.length) throw new Error('No silver players were returned by EA');

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
        var maxBid = maxBidFor(stable);
        var netSale = Math.floor(stable * 0.95);
        var immediate = rows.filter(function (x) {
          var entry = x.currentBid || x.startPrice;
          return (x.buyNow > 0 && x.buyNow <= maxBid) ||
            (entry > 0 && entry <= maxBid && x.timeSeconds <= 120);
        }).sort(function (a, b) {
          var ae = Math.min(a.buyNow || Infinity, a.currentBid || a.startPrice || Infinity);
          var be = Math.min(b.buyNow || Infinity, b.currentBid || b.startPrice || Infinity);
          return ae - be;
        })[0] || null;

        var entryPrice = immediate
          ? Math.min(immediate.buyNow || Infinity, immediate.currentBid || immediate.startPrice || Infinity)
          : Math.min(minBin || Infinity, minBid || Infinity);
        if (!Number.isFinite(entryPrice)) entryPrice = 0;

        var expectedProfit = entryPrice ? netSale - entryPrice : 0;
        var spread = stable && minBin ? Math.max(0, stable - minBin) : 0;
        var score = (immediate ? 100000 : 0) +
          seed.sightings * 500 +
          rows.length * 50 +
          Math.max(0, expectedProfit) * 3 -
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
          netSale: netSale,
          expectedProfit: expectedProfit,
          immediate: !!immediate,
          score: score
        });

        await sleep(400);
      }

      evaluated.sort(function (a, b) {
        return b.score - a.score || b.expectedProfit - a.expectedProfit;
      });

      var best = evaluated[0];
      if (!best) throw new Error('No silver player had enough live listings to price safely');

      state.quickFlip.candidate = best;
      state.quickFlip.scannedAt = Date.now();
      state.quickFlip.status = best.immediate
        ? 'Opportunity found'
        : 'Best liquid silver found · waiting for cheaper entry';

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
        priceSource: 'EA SILVER SCAN',
        confidence: best.sample >= 8 ? 'HIGH' : 'MEDIUM'
      };

      renderMarket();
      renderQuickFlip();
      log(
        'FOUND · ' + best.name + ' ' + best.rating +
        ' · market ' + best.stableBIN.toLocaleString() +
        ' · max bid ' + best.maxBid.toLocaleString() +
        ' · est ' + (best.expectedProfit >= 0 ? '+' : '') + best.expectedProfit.toLocaleString()
      );
    } catch (e) {
      state.quickFlip.status = 'Scan failed · ' + (e && e.message ? e.message : String(e));
      log(state.quickFlip.status);
      renderQuickFlip();
    } finally {
      state.silverScanning = false;
      if (scanButton) {
        scanButton.disabled = false;
        scanButton.textContent = 'SCAN PLAYER';
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
    var maxBid = document.querySelector('#fcp-result-maxbid');
    var profit = document.querySelector('#fcp-result-profit');
    var scanMeta = document.querySelector('#fcp-result-meta');

    if (status) status.textContent = q.status || 'Ready to scan silver players';
    if (player) player.textContent = candidate ? (candidate.name + ' · ' + candidate.rating) : '—';
    if (market) market.textContent = candidate && candidate.stableBIN ? candidate.stableBIN.toLocaleString() : '—';
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

    var cMin = document.querySelector('#fcp-cond-profit');
    var cBid = document.querySelector('#fcp-cond-bid');
    var cRelist = document.querySelector('#fcp-cond-relist');
    var cMode = document.querySelector('#fcp-cond-mode');
    var cTrades = document.querySelector('#fcp-cond-trades');
    if (cMin) cMin.textContent = 'Profit ≥ ' + state.minProfit.toLocaleString();
    if (cBid) cBid.textContent = state.autoBid ? 'Auto bid / rebid' : 'Bid off';
    if (cRelist) cRelist.textContent = state.autoSell ? 'Auto relist' : 'Relist off';
    if (cMode) cMode.textContent = state.dryRun ? 'Dry run' : 'Live';
    if (cTrades) cTrades.textContent = 'Max ' + state.maxTrades + ' trades';
  }


  function render() {
    var status = document.querySelector('#fcp-state');
    var start = document.querySelector('#fcp-start');
    var trades = document.querySelector('#fcp-trades');
    var profit = document.querySelector('#fcp-profit');

    if (status) {
      status.textContent = state.running ? (state.busy ? 'WORKING' : 'AUTO') : 'STOPPED';
      status.dataset.on = state.running ? '1' : '0';
    }

    if (start) {
      start.textContent = state.running ? 'STOP AUTO TRADE' : 'AUTO TRADE';
      start.dataset.on = state.running ? '1' : '0';
    }

    if (trades) trades.textContent = state.trades + '/' + state.maxTrades;
    if (profit) profit.textContent = state.daily.estimatedProfit.toLocaleString();
    var headState = document.querySelector('#fcp-headstate');
    var dry = document.querySelector('#fcp-dry');
    if (headState && dry) headState.textContent = dry.checked ? 'DRY' : 'LIVE';
    renderMarket();
    renderQuickFlip();
  }

  function readUI() {
    function val(id) { return coin(document.querySelector(id) ? document.querySelector(id).value : 0); }
    function checked(id) { return !!(document.querySelector(id) && document.querySelector(id).checked); }

    state.dryRun = checked('#fcp-dry');
    state.autoBid = checked('#fcp-autobid');
    state.autoBuyNow = checked('#fcp-autobin');
    state.autoSell = checked('#fcp-autosell');
    state.showAltPositions = checked('#fcp-altpositions');
    state.showCardPrices = checked('#fcp-cardprices');
    state.minProfit = Math.max(0, val('#fcp-minprofit'));
    state.maxBidCap = Math.max(0, val('#fcp-bidcap'));
    state.maxBinBuy = Math.max(0, val('#fcp-maxbin'));
    state.maxTrades = Math.max(1, val('#fcp-maxtrades') || 10);
    state.sessionMinutes = Math.max(1, Number(document.querySelector('#fcp-session').value || 60));
    state.dailyTarget = Math.max(0, val('#fcp-dailytarget') || 100000);
    state.pollMs = Math.max(1800, Number(document.querySelector('#fcp-delay').value || 2.5) * 1000);
    state.maxScanPages = Math.max(1, Math.min(100, coin(document.querySelector('#fcp-maxscanpages').value) || 40));
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

    if (state.dailyTarget > 0 && state.daily.estimatedProfit >= state.dailyTarget) {
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
        history.back();
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
    history.back();
    await sleep(900);
  }

  async function cycle() {
    if (stopReason() || state.busy) return;

    state.busy = true;
    render();

    try {
      var p = pageType();
      if (p === 'results') await handleResults();
      else if (p === 'details') await handleDetails();
      else if (p === 'won') await handleWon();
      else if (p === 'sell') await handleSell();
      else log('Open Transfer Market search/results');
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
    state.running = true;
    state.busy = false;
    state.trades = 0;
    state.sessionStarted = Date.now();
    state.lastBidPlaced = 0;
    log(state.dryRun ? 'AUTO started · DRY RUN' : 'AUTO started · LIVE');
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
    badge.classList.toggle('fcplus-price-loading', !n);
    badge.innerHTML = n
      ? '<span class="fcplus-coin">●</span><b>' + compactPrice(n) + '</b>'
      : '<span class="fcplus-price-dots">•••</span>';
    badge.title = n
      ? ('FC+ market price · ' + n.toLocaleString() + ' coins · ' + (source || 'market'))
      : 'FC+ price loading';
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
    if (!root || !root.parentElement) return;

    var host = root.parentElement;
    try {
      var computed = getComputedStyle(host);
      if (computed.position === 'static') host.style.position = 'relative';
      host.style.overflow = 'visible';
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

    if (state.showCardPrices) {
      var badge = document.createElement('div');
      badge.className = 'fcplus-card-price fcplus-price-loading';
      badge.setAttribute('data-fcplus-defid', String(Number(player.definitionId) || 0));
      badge.innerHTML = '<span class="fcplus-price-dots">•••</span>';
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
    if (current.__fcplusCardDecor043) return true;

    var wrapped = function (player, template) {
      var result = current.apply(this, arguments);
      var view = this;
      setTimeout(function () {
        try { decoratePlayerCard(view, player); } catch (e) {}
      }, 0);
      return result;
    };

    try {
      Object.defineProperty(wrapped, '__fcplusCardDecor043', { value: true });
    } catch (e) {
      wrapped.__fcplusCardDecor043 = true;
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
    installNativeNav();
    installPlayerAction();
    installPlayerCardEnhancer();
  }

  function createUI() {
    var root = document.createElement('section');
    root.id = APP_ID;
    root.innerHTML =
      '<div class="fcp-native-head">' +
        '<button id="fcp-close" type="button">‹</button>' +
        '<div><b>FC+ Trader</b><small>v0.5.0 · Silver Quickflip</small></div>' +
        '<span id="fcp-headstate">DRY</span>' +
      '</div>' +
      '<div id="fcp-body" class="fcp-native-body">' +

        '<section class="fcp-section fcp-method-card">' +
          '<div class="fcp-eyebrow">TRADING METHOD</div>' +
          '<div class="fcp-method-title-row">' +
            '<div><h2>Silver Quickflip</h2><p>FC+ finds the player. You do not need to key in a name.</p></div>' +
            '<span id="fcp-state" data-on="0">STOPPED</span>' +
          '</div>' +
          '<button id="fcp-scanplayer" class="fcp-primary" type="button">SCAN PLAYER</button>' +
        '</section>' +

        '<section class="fcp-section">' +
          '<div class="fcp-section-title"><h3>Result</h3><span>Trades <b id="fcp-trades">0/' + state.maxTrades + '</b></span></div>' +
          '<div id="fcp-result-status" class="fcp-result-status">Ready to scan silver players</div>' +
          '<div class="fcp-result-grid">' +
            '<div class="fcp-result-player"><small>PLAYER</small><b id="fcp-result-player">—</b></div>' +
            '<div><small>MARKET</small><b id="fcp-result-market">—</b></div>' +
            '<div><small>MAX BID</small><b id="fcp-result-maxbid">—</b></div>' +
            '<div><small>EST. PROFIT</small><b id="fcp-result-profit">—</b></div>' +
          '</div>' +
          '<div id="fcp-result-meta" class="fcp-result-meta">No scan yet</div>' +
        '</section>' +

        '<section class="fcp-section">' +
          '<h3>Condition</h3>' +
          '<div class="fcp-condition-chips">' +
            '<span>Silver only</span>' +
            '<span id="fcp-cond-profit">Profit ≥ ' + state.minProfit + '</span>' +
            '<span id="fcp-cond-bid">' + (state.autoBid ? 'Auto bid / rebid' : 'Bid off') + '</span>' +
            '<span id="fcp-cond-relist">' + (state.autoSell ? 'Auto relist' : 'Relist off') + '</span>' +
            '<span id="fcp-cond-mode">' + (state.dryRun ? 'Dry run' : 'Live') + '</span>' +
            '<span>List 1 hour</span>' +
            '<span id="fcp-cond-trades">Max ' + state.maxTrades + ' trades</span>' +
          '</div>' +
        '</section>' +

        '<section class="fcp-section fcp-auto-card">' +
          '<div class="fcp-profit"><span>Estimated listed profit today</span><b><span id="fcp-profit">' + state.daily.estimatedProfit.toLocaleString() + '</span> coins</b></div>' +
          '<div id="fcp-action">Ready · scan a player first</div>' +
          '<button id="fcp-start" class="fcp-start" data-on="0" type="button">AUTO TRADE</button>' +
        '</section>' +

        '<details class="fcp-fold">' +
          '<summary><span>Smart Price</span><b>›</b></summary>' +
          '<div class="fcp-fold-body">' +
            '<div class="fcp-market">' +
              '<div><small>MIN BIN</small><b id="fcp-minbin">—</b></div>' +
              '<div><small>STABLE BIN</small><b id="fcp-bin">—</b></div>' +
              '<div><small>MIN BID</small><b id="fcp-bid">—</b></div>' +
              '<div><small>MAX BID</small><b id="fcp-maxbid">—</b></div>' +
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

        '<details class="fcp-fold">' +
          '<summary><span>Settings</span><b>›</b></summary>' +
          '<div class="fcp-fold-body">' +
            '<div class="fcp-settings-block">' +
              '<h3>Trading</h3>' +
              '<div class="fcp-grid three">' +
                '<label>MIN PROFIT<input id="fcp-minprofit" type="number" inputmode="numeric" value="' + state.minProfit + '"></label>' +
                '<label>MAX BID CAP<input id="fcp-bidcap" type="number" inputmode="numeric" value="' + (state.maxBidCap || '') + '" placeholder="Auto"></label>' +
                '<label>MAX BIN BUY<input id="fcp-maxbin" type="number" inputmode="numeric" value="' + (state.maxBinBuy || '') + '" placeholder="Off"></label>' +
              '</div>' +
              '<div class="fcp-switches">' +
                '<label><span>Auto bid / rebid</span><input id="fcp-autobid" type="checkbox"' + (state.autoBid ? ' checked' : '') + '></label>' +
                '<label><span>Auto Buy Now</span><input id="fcp-autobin" type="checkbox"' + (state.autoBuyNow ? ' checked' : '') + '></label>' +
                '<label><span>Auto relist</span><input id="fcp-autosell" type="checkbox"' + (state.autoSell ? ' checked' : '') + '></label>' +
                '<label><span>Dry run</span><input id="fcp-dry" type="checkbox"' + (state.dryRun ? ' checked' : '') + '></label>' +
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
              '<h3>Limits</h3>' +
              '<div class="fcp-grid">' +
                '<label>SESSION MIN<input id="fcp-session" type="number" inputmode="numeric" value="' + state.sessionMinutes + '"></label>' +
                '<label>MAX TRADES<input id="fcp-maxtrades" type="number" inputmode="numeric" value="' + state.maxTrades + '"></label>' +
                '<label>DELAY SEC<input id="fcp-delay" type="number" inputmode="decimal" step="0.5" value="' + (state.pollMs / 1000) + '"></label>' +
                '<label>DAILY TARGET<input id="fcp-dailytarget" type="number" inputmode="numeric" value="' + state.dailyTarget + '"></label>' +
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
      scanSilverQuickFlipPlayers();
    });

    root.querySelector('#fcp-start').addEventListener('click', function () {
      if (state.running) {
        stop('Stopped by user');
      } else {
        if (!state.quickFlip || !state.quickFlip.candidate) {
          log('Scan Player first so FC+ can choose a Silver Quickflip candidate');
          return;
        }
        start();
      }
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
        if (!state.running) readUI();
        if (input.id === 'fcp-altpositions' || input.id === 'fcp-cardprices') refreshVisibleAltPositions();
        var hs = root.querySelector('#fcp-headstate');
        if (hs) hs.textContent = root.querySelector('#fcp-dry').checked ? 'DRY' : 'LIVE';
        renderQuickFlip();
      });
    });

    render();
    log('Ready · Silver Quickflip workflow loaded');

    installNativeInteractionBridge();
    installPlayerCardEnhancer();
    nativeUiHeartbeat();
    setInterval(nativeUiHeartbeat, 900);
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
    '.fcplus-alt-pos-stack{position:absolute!important;right:-10px!important;top:10%!important;z-index:45!important;display:flex!important;flex-direction:column!important;gap:0!important;pointer-events:none!important;filter:drop-shadow(0 1px 1px rgba(0,0,0,.42))!important}' +
    '.fcplus-alt-pos-stack span{display:flex!important;align-items:center!important;justify-content:center!important;min-width:27px!important;height:17px!important;padding:0 4px!important;border-radius:0!important;background:#e9dfbd!important;color:#171512!important;border:1px solid #8e8469!important;border-left:0!important;font:800 8px/1 system-ui,-apple-system,Segoe UI,sans-serif!important;letter-spacing:-.12px!important;margin-top:-1px!important}' +
    '.fcplus-alt-pos-stack span:first-child{border-radius:0 4px 0 0!important;margin-top:0!important}' +
    '.fcplus-alt-pos-stack span:last-child{border-radius:0 0 4px 0!important}' +
    '.phone .fcplus-alt-pos-stack{right:-8px!important;top:8%!important}' +
    '.phone .fcplus-alt-pos-stack span{min-width:24px!important;height:15px!important;padding:0 3px!important;font-size:7px!important}' +

    '.fcplus-card-price{position:absolute!important;left:50%!important;bottom:-16px!important;transform:translateX(-50%)!important;z-index:46!important;min-width:50px!important;height:17px!important;padding:0 7px!important;border-radius:5px!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:4px!important;background:linear-gradient(180deg,#f2d54c,#d9b91f)!important;border:1px solid rgba(71,57,2,.68)!important;color:#171400!important;box-shadow:0 1px 2px #0007!important;white-space:nowrap!important;pointer-events:none!important;font:800 9px/1 system-ui,-apple-system,Segoe UI,sans-serif!important}' +
    '.fcplus-card-price .fcplus-coin{font-size:8px!important;color:#725d00!important}' +
    '.fcplus-card-price.fcplus-price-loading{background:rgba(16,27,39,.88)!important;border-color:rgba(255,255,255,.22)!important;color:#ffffff9c!important;min-width:42px!important}' +
    '.fcplus-card-price .fcplus-price-dots{font-size:8px!important;letter-spacing:1px!important}' +
    '.phone .fcplus-card-price{bottom:-14px!important;min-width:46px!important;height:15px!important;padding:0 6px!important;border-radius:4px!important;font-size:8px!important}'
  );


  GM_addStyle(
    '#' + APP_ID + ' .fcp-eyebrow{margin-bottom:6px;color:#75d8ff;font-size:9px;font-weight:900;letter-spacing:.12em}' +
    '#' + APP_ID + ' .fcp-method-card{background:linear-gradient(145deg,#2a4051,#233545)}' +
    '#' + APP_ID + ' .fcp-method-title-row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}' +
    '#' + APP_ID + ' .fcp-method-title-row h2{margin:0;color:#fff;font-size:22px;line-height:1.15}' +
    '#' + APP_ID + ' .fcp-method-title-row p{margin:5px 0 0;max-width:340px;color:#ffffff78;font-size:11px;line-height:1.4}' +
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
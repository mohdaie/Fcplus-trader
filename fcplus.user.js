// ==UserScript==
// @name         FC+ Auto Trader Mobile
// @namespace    https://fcplus.local/
// @version      0.3.1
// @description  Mobile FC Web App market scanner, auto bid/rebid, auto relist, and hard trading limits.
// @homepageURL  https://github.com/mohdaie/Fcplus-trader
// @updateURL    https://raw.githubusercontent.com/mohdaie/Fcplus-trader/main/fcplus.user.js
// @downloadURL  https://raw.githubusercontent.com/mohdaie/Fcplus-trader/main/fcplus.user.js
// @match        https://ea.com/*
// @match        https://*.ea.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var APP_ID = 'fcplus-auto-v031';
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
    undercutSteps: 1
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
    market: { absMinBIN: 0, stableBIN: 0, minBid: 0, listings: 0 },
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
      undercutSteps: state.undercutSteps
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
    if (t.indexOf("congratulations, you've won this item for") >= 0) return 'won';
    if (t.indexOf('list on transfer market') >= 0 && t.indexOf('start price') >= 0 && t.indexOf('buy now price') >= 0) return 'sell';
    if (t.indexOf('search results') >= 0) return 'results';
    if (t.indexOf('item details') >= 0) return 'details';
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

    var bins = listings.map(function (x) { return x.buyNow; }).filter(Boolean).sort(function (a, b) { return a - b; });
    var bids = listings.map(function (x) { return x.currentBid || x.startPrice; }).filter(Boolean).sort(function (a, b) { return a - b; });

    state.market = {
      absMinBIN: bins[0] || 0,
      stableBIN: stableBIN(bins),
      minBid: bids[0] || 0,
      listings: listings.length
    };

    renderMarket();
    return listings;
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
    var action = document.querySelector('#fcp-action');
    if (action) action.textContent = message;
    var box = document.querySelector('#fcp-log');
    if (box) {
      var row = document.createElement('div');
      row.textContent = new Date().toLocaleTimeString() + '  ' + message;
      box.prepend(row);
      while (box.children.length > 7) box.lastElementChild.remove();
    }
  }

  function renderMarket() {
    var bin = document.querySelector('#fcp-bin');
    var bid = document.querySelector('#fcp-bid');
    var max = document.querySelector('#fcp-maxbid');
    if (bin) bin.textContent = state.market.stableBIN ? state.market.stableBIN.toLocaleString() : '—';
    if (bid) bid.textContent = state.market.minBid ? state.market.minBid.toLocaleString() : '—';
    if (max) {
      var m = maxBidFor(state.market.stableBIN);
      max.textContent = m ? m.toLocaleString() : '—';
    }
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
      start.textContent = state.running ? 'STOP EVERYTHING' : 'START AUTO';
      start.dataset.on = state.running ? '1' : '0';
    }

    if (trades) trades.textContent = state.trades + '/' + state.maxTrades;
    if (profit) profit.textContent = state.daily.estimatedProfit.toLocaleString();
    renderMarket();
  }

  function readUI() {
    function val(id) { return coin(document.querySelector(id) ? document.querySelector(id).value : 0); }
    function checked(id) { return !!(document.querySelector(id) && document.querySelector(id).checked); }

    state.dryRun = checked('#fcp-dry');
    state.autoBid = checked('#fcp-autobid');
    state.autoBuyNow = checked('#fcp-autobin');
    state.autoSell = checked('#fcp-autosell');
    state.minProfit = Math.max(0, val('#fcp-minprofit'));
    state.maxBidCap = Math.max(0, val('#fcp-bidcap'));
    state.maxBinBuy = Math.max(0, val('#fcp-maxbin'));
    state.maxTrades = Math.max(1, val('#fcp-maxtrades') || 10);
    state.sessionMinutes = Math.max(1, Number(document.querySelector('#fcp-session').value || 60));
    state.dailyTarget = Math.max(0, val('#fcp-dailytarget') || 100000);
    state.pollMs = Math.max(1800, Number(document.querySelector('#fcp-delay').value || 2.5) * 1000);
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

    log('List ' + sellStart.toLocaleString() + ' / ' + sellBIN.toLocaleString());

    if (state.dryRun) return;

    setInput(startInput, sellStart);
    setInput(binInput, sellBIN);
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

  function createUI() {
    var root = document.createElement('section');
    root.id = APP_ID;
    root.innerHTML =
      '<div class="fcp-head"><div><b>FC+ AUTO</b><small>v0.3.1 · auto-updating</small></div><button id="fcp-min" type="button">−</button></div>' +
      '<div id="fcp-body">' +
        '<div class="fcp-top"><span id="fcp-state" data-on="0">STOPPED</span><span>Trades <b id="fcp-trades">0/' + state.maxTrades + '</b></span></div>' +
        '<div class="fcp-market">' +
          '<div><small>STABLE BIN</small><b id="fcp-bin">—</b></div>' +
          '<div><small>MIN BID</small><b id="fcp-bid">—</b></div>' +
          '<div><small>MAX BID</small><b id="fcp-maxbid">—</b></div>' +
        '</div>' +
        '<div class="fcp-grid three">' +
          '<label>MIN PROFIT<input id="fcp-minprofit" type="number" inputmode="numeric" value="' + state.minProfit + '"></label>' +
          '<label>MAX BID CAP<input id="fcp-bidcap" type="number" inputmode="numeric" value="' + (state.maxBidCap || '') + '" placeholder="Auto"></label>' +
          '<label>MAX BIN BUY<input id="fcp-maxbin" type="number" inputmode="numeric" value="' + (state.maxBinBuy || '') + '" placeholder="Off"></label>' +
        '</div>' +
        '<div class="fcp-switches">' +
          '<label><input id="fcp-autobid" type="checkbox"' + (state.autoBid ? ' checked' : '') + '> Auto bid/rebid</label>' +
          '<label><input id="fcp-autobin" type="checkbox"' + (state.autoBuyNow ? ' checked' : '') + '> Auto Buy Now</label>' +
          '<label><input id="fcp-autosell" type="checkbox"' + (state.autoSell ? ' checked' : '') + '> Auto relist</label>' +
          '<label><input id="fcp-dry" type="checkbox"' + (state.dryRun ? ' checked' : '') + '> Dry run</label>' +
        '</div>' +
        '<div class="fcp-grid">' +
          '<label>SESSION MIN<input id="fcp-session" type="number" inputmode="numeric" value="' + state.sessionMinutes + '"></label>' +
          '<label>MAX TRADES<input id="fcp-maxtrades" type="number" inputmode="numeric" value="' + state.maxTrades + '"></label>' +
          '<label>DELAY SEC<input id="fcp-delay" type="number" inputmode="decimal" step="0.5" value="' + (state.pollMs / 1000) + '"></label>' +
          '<label>DAILY TARGET<input id="fcp-dailytarget" type="number" inputmode="numeric" value="' + state.dailyTarget + '"></label>' +
        '</div>' +
        '<div class="fcp-profit"><span>Estimated listed profit today</span><b><span id="fcp-profit">' + state.daily.estimatedProfit.toLocaleString() + '</span> coins</b></div>' +
        '<div id="fcp-action">Ready</div>' +
        '<button id="fcp-start" class="fcp-start" data-on="0" type="button">START AUTO</button>' +
        '<div id="fcp-log"></div>' +
      '</div>';

    document.documentElement.appendChild(root);

    root.querySelector('#fcp-start').addEventListener('click', function () {
      if (state.running) stop('Stopped by user'); else start();
    });

    root.querySelector('#fcp-min').addEventListener('click', function (e) {
      var body = root.querySelector('#fcp-body');
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      e.currentTarget.textContent = hidden ? '−' : '+';
    });

    Array.from(root.querySelectorAll('input')).forEach(function (input) {
      input.addEventListener('change', function () {
        if (!state.running) readUI();
      });
    });

    render();
    log('Ready · set EA player search first');
  }

  GM_addStyle(
    '#' + APP_ID + '{position:fixed;right:8px;bottom:82px;z-index:2147483647;width:min(350px,calc(100vw - 16px));background:#0b1014;color:#f4f7f9;border:1px solid #ffffff1f;border-radius:16px;box-shadow:0 18px 55px #0009;overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:12px}' +
    '#' + APP_ID + ' *{box-sizing:border-box}' +
    '#' + APP_ID + ' .fcp-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#151c22;border-bottom:1px solid #ffffff12}' +
    '#' + APP_ID + ' .fcp-head b{font-size:14px;letter-spacing:.06em}' +
    '#' + APP_ID + ' .fcp-head small{display:block;margin-top:2px;color:#ffffff69;font-size:9px}' +
    '#' + APP_ID + ' #fcp-min{width:32px;height:32px;border:0;border-radius:9px;background:#ffffff10;color:#fff;font-size:20px}' +
    '#' + APP_ID + ' #fcp-body{padding:10px}' +
    '#' + APP_ID + ' .fcp-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}' +
    '#' + APP_ID + ' #fcp-state{padding:4px 8px;border-radius:99px;background:#ffffff10;color:#ffffff80;font-weight:900;font-size:10px}' +
    '#' + APP_ID + ' #fcp-state[data-on="1"]{background:#00f58b22;color:#75ffb8}' +
    '#' + APP_ID + ' .fcp-market{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:9px}' +
    '#' + APP_ID + ' .fcp-market>div{padding:8px;border-radius:9px;background:#ffffff08;min-width:0}' +
    '#' + APP_ID + ' .fcp-market small{display:block;color:#ffffff65;font-size:8px}' +
    '#' + APP_ID + ' .fcp-market b{display:block;margin-top:2px;font-size:13px;overflow:hidden;text-overflow:ellipsis}' +
    '#' + APP_ID + ' .fcp-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}' +
    '#' + APP_ID + ' .fcp-grid.three{grid-template-columns:1fr 1fr 1fr}' +
    '#' + APP_ID + ' label{font-size:8px;color:#ffffff75;min-width:0}' +
    '#' + APP_ID + ' input:not([type="checkbox"]){width:100%;margin-top:3px;padding:8px;border-radius:8px;border:1px solid #ffffff16;background:#171d23;color:#fff;font-size:12px;outline:none}' +
    '#' + APP_ID + ' .fcp-switches{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}' +
    '#' + APP_ID + ' .fcp-switches label{display:flex;align-items:center;gap:6px;font-size:10px;color:#e6edf2}' +
    '#' + APP_ID + ' .fcp-profit{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:9px;padding:8px;border-radius:9px;background:#ffffff07;font-size:9px;color:#ffffff80}' +
    '#' + APP_ID + ' .fcp-profit b{color:#fff;font-size:10px;text-align:right}' +
    '#' + APP_ID + ' #fcp-action{margin-top:8px;padding:8px;border-radius:9px;background:#ffffff08;color:#dce4e9;font-size:10px}' +
    '#' + APP_ID + ' .fcp-start{width:100%;margin-top:8px;padding:12px;border:0;border-radius:10px;background:#00ef88;color:#03120b;font-weight:900;font-size:12px}' +
    '#' + APP_ID + ' .fcp-start[data-on="1"]{background:#ff5865;color:#fff}' +
    '#' + APP_ID + ' #fcp-log{margin-top:8px;max-height:96px;overflow:auto;padding:7px;border-radius:8px;background:#050708;color:#ffffff70;font:9px/1.4 ui-monospace,monospace}' +
    '#' + APP_ID + ' #fcp-log div{padding:2px 0;border-bottom:1px solid #ffffff08}'
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
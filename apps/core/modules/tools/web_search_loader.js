'use strict';
// Wrapper for web_search_fallback + web_search to avoid __dirname/module.filename
// issues when tools/index.js is loaded via eval / dynamic require.
const path = require('path');
const fs = require('fs');

// This file lives in modules/tools/, but web_search / web_search_fallback live in modules/
const _here = path.dirname(fs.realpathSync(__filename));
const _parent = path.dirname(_here);

function _load(name) {
  return require(path.join(_parent, name));
}

const _search = _load('web_search.js');
const _fallback = _load('web_search_fallback.js');

module.exports = {
  webSearch: _search.webSearch,
  bingSearch: _fallback.bingSearch,
  parseBingHtml: _fallback.parseBingHtml,
  parseSogouHtml: _fallback.parseSogouHtml,
  fetchUrl: _fallback.fetchUrl,
};
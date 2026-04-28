// ==UserScript==
// @name         Leitstellenspiel – Funkrufnamen-Generator
// @namespace    https://github.com/DEIN_GITHUB_USERNAME/lss-callsign-generator
// @version      1.0.0
// @description  Generiert Funkrufnamen nach konfigurierbarem Schema (pro Bundesland & Organisation).
// @author       DEIN_GITHUB_USERNAME
// @homepage     https://github.com/DEIN_GITHUB_USERNAME/lss-callsign-generator
// @supportURL   https://github.com/DEIN_GITHUB_USERNAME/lss-callsign-generator/issues
// @downloadURL  https://raw.githubusercontent.com/DEIN_GITHUB_USERNAME/lss-callsign-generator/main/lss-callsign-loader.user.js
// @updateURL    https://raw.githubusercontent.com/DEIN_GITHUB_USERNAME/lss-callsign-generator/main/lss-callsign-loader.user.js
// @match        https://www.leitstellenspiel.de/*
// @grant        GM_info
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      nominatim.openstreetmap.org
// @connect      www.googleapis.com
// @connect      googleapis.com
// @connect      accounts.google.com
// @connect      raw.githubusercontent.com
// @connect      api.lss-manager.de
// @run-at       document-idle
// ==/UserScript==

(function () {
  const CORE_URL = 'https://raw.githubusercontent.com/DEIN_GITHUB_USERNAME/lss-callsign-generator/main/lss-callsign-core.js';

  GM_xmlhttpRequest({
    method: 'GET',
    url: CORE_URL + '?_=' + Math.floor(Date.now() / 3e5), // Cache-Buster alle 5 Minuten
    onload: r => {
      if (r.status !== 200) {
        console.error('[LSS-Callsign] Core konnte nicht geladen werden:', r.status);
        return;
      }
      try {
        const fn = new Function(
          'GM_info', 'GM_addStyle', 'GM_getValue', 'GM_setValue',
          'GM_xmlhttpRequest', 'GM_addValueChangeListener', 'unsafeWindow',
          r.responseText
        );
        fn(
          GM_info, GM_addStyle, GM_getValue, GM_setValue,
          GM_xmlhttpRequest, GM_addValueChangeListener,
          typeof unsafeWindow !== 'undefined' ? unsafeWindow : window
        );
      } catch (e) {
        console.error('[LSS-Callsign] Fehler beim Ausführen des Core-Scripts:', e);
      }
    },
    onerror: e => console.error('[LSS-Callsign] Netzwerkfehler:', e),
  });
})();
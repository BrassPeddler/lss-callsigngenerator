// ==UserScript==
// @name         Leitstellenspiel – Funkrufnamen-Generator
// @namespace    https://www.leitstellenspiel.de/
// @version      5.9.4
// @description  Generiert Funkrufnamen nach konfigurierbarem Schema (pro Bundesland & Organisation).
// @author       lss-callsign-generator
// @match        https://www.leitstellenspiel.de/*
// @match        https://www.leitstellenspiel.de/buildings/*
// @match        https://www.leitstellenspiel.de/vehicles/*/edit
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      nominatim.openstreetmap.org
// @run-at       document-idle
// ==/UserScript==

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA-SYSTEM
// ─────────────────────────────────────────────────────────────────────────
// Schemas werden pro Kombination aus Bundesland + Organisation definiert.
// Schlüssel: BY/DRK, BW/DRK, Wildcard-Org: x/DRK, Wildcard-BL: BY/x (Fallback-Kette)
//
// Verfügbare Platzhalter:
//   {org}       Organisationskennung (aus Org-Mapping oder Gebäude-Override)
//   {ort}       Ortsname (aus Gebäudename extrahiert oder Gebäude-Override)
//   {tkz1}      1. TKZ (Standortkennzahl, aus Gebäude-Eigenschaften)
//   {tkz1/}     1. TKZ + "/" wenn gesetzt, sonst leer
//   {tkz1|1}    1. TKZ, Fallback "1" wenn nicht gesetzt
//   {tkz2}      2. TKZ (Fahrzeugkennzahl, aus 2. TKZ-Mapping)
//   {seq}       Sequenznummer ohne Auffüllung (1, 2, 3, ...)
//   {seq##}     Sequenznummer 2-stellig mit führenden Nullen (01, 02, ...)
//   {seq###}    Sequenznummer 3-stellig (001, 002, ...)
//   {typ}       Fahrzeugtyp-Name aus rv_vehicleTypeCatalogMap (z.B. RTW, HLF 20)
//   {alias}     Fahrzeugtyp-Alias (konfigurierbar), Fallback: {typ}
//   {ils}       ILS-Bereichsname (aus ILS-Mapping)
//
// Beispiele:
//   BY/DRK:  {org} {ort} {tkz2}/{seq}       -> Rotkreuz Augsburg 71/1
//   BW/DRK:  {org} {ort} {tkz1}/{tkz2}-{seq}  -> Rotkreuz Ulm 1/83-1
//
// GEBÄUDE-EIGENSCHAFTEN (in Script-Storage, verknüpft über Building-ID):
//   standort    Standortkennzahl  (z.B. 1)
//   org         Org-Override      (z.B. Rotkreuz) -- überschreibt Auto-Erkennung
//   ort         Ort-Override      (z.B. Ulm)      -- überschreibt Auto-Extraktion
//
// OFFIZIELLE APIs:
//   /api/vehicles/{id}            -> vehicle_type, building_id
//   /api/buildings/{id}           -> caption, latitude, longitude
//   /api/buildings/{id}/vehicles  -> Durchnummerierung
//   nominatim.openstreetmap.org   -> Koordinaten -> Bundesland
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // KONSTANTEN
  // ═══════════════════════════════════════════════════════════════════════════

  const SEL_FORM = 'form[id^="edit_vehicle_"]';
  const SEL_NAME_INPUT = '#vehicle_caption';
  const vehicleIdFromForm = f => (f.id.match(/edit_vehicle_(\d+)/) || [])[1] || null;

  // Gebäude-Formular
  const SEL_BUILDING_FORM = 'form[id^="edit_building_"]';
  const buildingIdFromForm = f => (f.id.match(/edit_building_(\d+)/) || [])[1] || null;

  const BUNDESLAENDER = {
    'BB':'Brandenburg', 'BE':'Berlin',
    'BW':'Baden-Württemberg', 'BY':'Bayern',
    'HB':'Bremen', 'HE':'Hessen',
    'HH':'Hamburg', 'MV':'Mecklenburg-Vorpommern',
    'NI':'Niedersachsen', 'NW':'Nordrhein-Westfalen',
    'RP':'Rheinland-Pfalz', 'SH':'Schleswig-Holstein',
    'SL':'Saarland', 'SN':'Sachsen',
    'ST':'Sachsen-Anhalt', 'TH':'Thüringen',
  };

  const BL_NAME_MAP = {
    'Bayern':'BY','Baden-Württemberg':'BW','Nordrhein-Westfalen':'NW',
    'Niedersachsen':'NI','Hessen':'HE','Sachsen':'SN','Rheinland-Pfalz':'RP',
    'Berlin':'BE','Schleswig-Holstein':'SH','Brandenburg':'BB',
    'Sachsen-Anhalt':'ST','Thüringen':'TH','Hamburg':'HH',
    'Mecklenburg-Vorpommern':'MV','Bremen':'HB','Saarland':'SL',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STANDARD-KONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  // Schemas: Schlüssel = "BL/Dienst" | "*/Dienst" | "BL/*" | "*/*"
  // Fallback-Kette beim Lookup: BL/Org → */Org → BL/* → */*
  const DEFAULT_SCHEMAS = {};

  // Org-Kennungen: Schlüsselwort im Gebäudenamen → interne OrgKey + Anzeigename
  // dienst wird für Schema-Lookup verwendet, name für {org}-Platzhalter
  const DEFAULT_ORG = {};

  // Organisations-Dropdown: { label: Anzeigename, value: Funkkennung }
  // Wird in cfg.orgLabels gespeichert → erweiterbar über Konfiguration
  const DEFAULT_ORG_LABELS = [
    { label: 'Feuerwehr', value: 'Florian' },
    { label: 'ASB', value: 'Sama' },
    { label: 'Bergwacht', value: 'Bergwacht' },
    { label: 'DLRG', value: 'Pelikan' },
    { label: 'DRK / BRK', value: 'Rotkreuz' },
    { label: 'Johanniter-Unfall-Hilfe', value: 'Akkon' },
    { label: 'Malteser Hilfsdienst', value: 'Johannes' },
    { label: 'Rettungshubschrauber', value: 'Christoph' },
    { label: 'Katastrophenschutz', value: 'Kater' },
    { label: 'THW', value: 'Heros' },
  ];

  // Kennzahlen: { 'BL': { Typname: Kennzahl }, '*': { ... } }
  const DEFAULT_KZ = {};

  // Fahrzeugtyp-Aliase: { typeId: alias } z.B. { '76': 'FRT' }
  const DEFAULT_ALIASES = {};

  // ILS-Mapping: { leitstelleBuildingId: bereichsname } z.B. { '12345': 'KRU' }
  const DEFAULT_ILS = {};

  // Feste Dienste für Schema-Lookup
  const DIENSTE = ['Feuerwehr', 'Rettung', 'Polizei', 'THW'];

  // Feste Standard-Organisation pro Dienst (nur Rettung nutzt das Dropdown)
  const DIENST_ORG_DEFAULT = {
    'Feuerwehr': 'Florian',
    'THW': 'Heros',
    'Polizei': '', // leer = kein Prefix, kann auf 'Peter' geändert werden
  };



  // Gebäudetyp-ID → Dienst (aus building_type-Feld der Buildings-API)
  // Quelle: LSS-Manager / Community-Dokumentation
  // Gebäudetyp-ID → Dienst (Quelle: building[building_type] Select im Spiel)
  const BUILDING_TYPE_DIENST = {
    7: null, // Leitstelle
    0: 'Feuerwehr', // Feuerwache
    18: 'Feuerwehr', // Feuerwache (Kleinwache)
    1: 'Feuerwehr', // Feuerwehrschule
    2: 'Rettung', // Rettungswache
    20: 'Rettung', // Rettungswache (Kleinwache)
    3: 'Rettung', // Rettungsschule
    4: 'Rettung', // Krankenhaus
    5: 'Rettung', // Rettungshubschrauber-Station
    12: 'Rettung', // Schnelleinsatzgruppe (SEG)
    6: 'Polizei', // Polizeiwache
    19: 'Polizei', // Polizeiwache (Kleinwache)
    11: 'Polizei', // Bereitschaftspolizei
    17: 'Polizei', // Polizei-Sondereinheiten
    24: 'Polizei', // Reiterstaffel
    13: 'Polizei', // Polizeihubschrauberstation
    8: 'Polizei', // Polizeischule
    9: 'THW', // THW
    10: 'THW', // THW Bundesschule
    14: null, // Bereitstellungsraum
    15: 'Rettung', // Wasserrettung
    21: 'Rettung', // Rettungshundestaffel
    25: 'Rettung', // Bergrettungswache
    26: 'Rettung', // Seenotrettungswache
    27: 'Rettung', // Schule für Seefahrt und Seenotrettung
    28: 'Rettung', // Hubschrauberstation (Seenotrettung)
  };


  // ═══════════════════════════════════════════════════════════════════════════
  // PERSISTENZ
  // ═══════════════════════════════════════════════════════════════════════════

  const STORE_KEY = 'lss_callsign_v4';
  const STORE_BUILDINGS_KEY = 'lss_callsign_buildings_v4';
  const STORE_GEO_KEY = 'lss_callsign_geo_v1'; // persistenter Nominatim-Cache

  function loadConfig() {
    try {
      const r = GM_getValue(STORE_KEY, null);
      if (r) {
        const parsed = JSON.parse(r);

        // Migration: orgLabels fehlt in älteren gespeicherten Configs
        if (!Array.isArray(parsed.orgLabels)) {
          parsed.orgLabels = JSON.parse(JSON.stringify(DEFAULT_ORG_LABELS));
        }
        if (!parsed.aliases) parsed.aliases = {};
        if (!parsed.ils) parsed.ils = {};
        return parsed;
      }
    } catch (_) {}
    return {
      schemas: { ...DEFAULT_SCHEMAS },
      org: JSON.parse(JSON.stringify(DEFAULT_ORG)),
      kz: JSON.parse(JSON.stringify(DEFAULT_KZ)),
      orgLabels: JSON.parse(JSON.stringify(DEFAULT_ORG_LABELS)),
      aliases: {},
    };
  }

  function saveConfig(c) {
    GM_setValue(STORE_KEY, JSON.stringify(c));

  }

  // Gebäude-Eigenschaften: { buildingId: { standort, org, ort } }
  function loadBuildingProps() {
    try {
      const r = GM_getValue(STORE_BUILDINGS_KEY, null);
      if (r) return JSON.parse(r);
    } catch (_) {}
    return {};
  }

  function saveBuildingProps(p) { GM_setValue(STORE_BUILDINGS_KEY, JSON.stringify(p)); }

  let cfg = loadConfig();
  let buildingProps = loadBuildingProps();

  // ═══════════════════════════════════════════════════════════════════════════
  // CACHES
  // ═══════════════════════════════════════════════════════════════════════════

  const cacheVehicle = new Map();
  const cacheBuilding = new Map();
  const cacheBL = new Map();
  const cacheOrt = new Map(); // buildingId → Ortsname aus Nominatim

  // Persistenten Geo-Cache laden
  (function loadGeoCache() {
    try {
      const raw = GM_getValue(STORE_GEO_KEY, null);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const [id, {bl, ort}] of Object.entries(saved)) {
        cacheBL.set(id, bl);
        cacheOrt.set(id, ort);
      }
    } catch (_) {}
  })();

  function saveGeoCache() {
    try {
      const obj = {};
      for (const [id, bl] of cacheBL.entries()) {
        obj[id] = { bl, ort: cacheOrt.get(id) || '' };
      }
      GM_setValue(STORE_GEO_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // API-ABRUFE
  // ═══════════════════════════════════════════════════════════════════════════

  async function apiFetch(path) {
    try {
      const r = await fetch(path, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!r.ok) return null;
      return r.json();
    } catch (_) { return null; }
  }

  async function getVehicle(id) {
    if (cacheVehicle.has(id)) return cacheVehicle.get(id);
    const d = await apiFetch(`/api/vehicles/${id}`);
    if (d) cacheVehicle.set(id, d);
    return d;
  }

  async function getBuilding(id) {
    const sid = String(id);
    if (cacheBuilding.has(sid)) return cacheBuilding.get(sid);
    const d = await apiFetch(`/api/buildings/${sid}`);
    if (d) cacheBuilding.set(sid, d);
    return d;
  }

  async function getBuildingVehicles(id) {
    const d = await apiFetch(`/api/buildings/${id}/vehicles`);
    return Array.isArray(d) ? d : (d?.result || []);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUNDESLAND
  // ═══════════════════════════════════════════════════════════════════════════

  // Ein Nominatim-Request bei zoom=10 liefert Bundesland UND Ortsname
  // Ergebnis wird sowohl in-memory als auch persistent gecacht
  let _lastNominatimRequest = 0;
  async function fetchGeoData(buildingId) {
    const id = String(buildingId);
    if (cacheBL.has(id)) return; // bereits in-memory (inkl. persistentem Cache)
    const b = await getBuilding(id);
    if (!b?.latitude) { cacheBL.set(id, null); cacheOrt.set(id, ''); return; }
    try {
      // Rate-Limiting: mindestens 150ms zwischen Requests
      const now = Date.now();
      const wait = _lastNominatimRequest + 1100 - now;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      _lastNominatimRequest = Date.now();

      // Retry-Logik: bei 429 bis zu 5x mit wachsendem Delay versuchen
      const nominatimFetch = (retryDelay = 2000, retries = 5) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `https://nominatim.openstreetmap.org/reverse?format=json&lat=${b.latitude}&lon=${b.longitude}&zoom=10&addressdetails=1`,
          headers: { 'User-Agent': 'lss-callsign-generator/5.7', 'Accept': 'application/json' },
          onload: r => {
            if (r.status === 429) {
              if (retries <= 0) { reject(new Error('429-max-retries')); return; }
              setTimeout(() => nominatimFetch(retryDelay * 2, retries - 1).then(resolve).catch(reject), retryDelay);
              return;
            }
            try { resolve(JSON.parse(r.responseText)); } catch(e) { reject(e); }
          },
          onerror: e => reject(e),
          ontimeout: () => reject(new Error('timeout')),
        });
      });
      const geo = await nominatimFetch();
      const addr = geo?.address || {};

      // Bundesland
      const state = addr.state || '';
      let bl = BL_NAME_MAP[state] || null;
      if (!bl) {
        for (const [name, kz] of Object.entries(BL_NAME_MAP)) {
          if (state.toLowerCase().includes(name.toLowerCase())) { bl = kz; break; }
        }
      }
      cacheBL.set(id, bl);

      // Ortsname: city > town > village > municipality > county
      const ort = addr.city || addr.town || addr.village || addr.municipality || addr.county || '';
      cacheOrt.set(id, ort);

      // Persistent speichern
      saveGeoCache();
    } catch (err) {
      // Bei 429 nicht cachen — beim nächsten Versuch nochmal probieren
      if (!String(err?.message).includes('429')) { // bei echtem Fehler cachen (nicht bei Rate-Limit)
        cacheBL.set(id, null);
        cacheOrt.set(id, '');
      }
    }
  }

  async function getBundesland(buildingId) {
    await fetchGeoData(buildingId);
    return cacheBL.get(String(buildingId)) ?? null;
  }

  async function getOrt(buildingId) {
    await fetchGeoData(buildingId);
    return cacheOrt.get(String(buildingId)) ?? '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FAHRZEUGTYP aus localStorage
  // ═══════════════════════════════════════════════════════════════════════════

  function getILS(leitstelleBuildingId) {
    if (!leitstelleBuildingId) return '';
    return cfg.ils[String(leitstelleBuildingId)] || '';
  }

  function getAlias(typeId) {
    if (typeId === null || typeId === undefined) return null;
    return cfg.aliases[String(typeId)] || null;
  }

  function getTypeName(typeId) {
    try {
      const cat = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}');
      const e = cat[typeId] ?? cat[String(typeId)];
      if (!e) return null;
      // Katalog kann String sein ("RTW") oder Objekt ({ caption: "RTW" })
      if (typeof e === 'string') return e;
      return e.caption || e.name || null;
    } catch (_) { return null; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEMA-LOOKUP
  // Schlüssel: BL/Dienst, z.B. BY/Rettung, BW/Feuerwehr
  // Fallback-Kette: BL/Dienst → */Dienst → BL/* → */*
  // ═══════════════════════════════════════════════════════════════════════════

  function getSchema(bl, dienst) {
    const s = cfg.schemas;
    const blk = bl || '*';
    const dk = dienst || '*';
    return s[`${blk}/${dk}`]
        || s[`*/${dk}`]
        || s[`${blk}/*`]
        || s['*/*']
        || '{org} {ort} {tkz2}/{seq}';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // KENNZAHL-LOOKUP
  // ═══════════════════════════════════════════════════════════════════════════

  function getKennzahl(typeId, bl) {
    if (typeId === null || typeId === undefined) return null;
    const id = String(typeId);
    const k = cfg.kz;
    // 1. Bundesland-spezifisch
    if (bl && k[bl]?.[id] !== undefined) return k[bl][id];
    // 2. Global
    if (k['*']?.[id] !== undefined) return k['*'][id];
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORG-ERKENNUNG & ORT-EXTRAKTION
  // ═══════════════════════════════════════════════════════════════════════════

  function detectOrgEntry(caption) {
    if (!caption) return null;
    const up = caption.toUpperCase();
    const keys = Object.keys(cfg.org).sort((a,b) => b.length - a.length);
    for (const k of keys) {
      if (up.includes(k.toUpperCase())) return { keyword: k, ...cfg.org[k] };
    }
    return null;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // DURCHNUMMERIERUNG
  // ═══════════════════════════════════════════════════════════════════════════

  async function getNextNr(buildingId, typeId, vehicleId) {
    const vehicles = await getBuildingVehicles(buildingId);
    const same = vehicles
      .filter(v => String(v.vehicle_type) === String(typeId))
      .sort((a, b) => Number(a.id) - Number(b.id));

    if (vehicleId === 'new') {
      // Neues Fahrzeug: nächste freie Nummer
      return same.length + 1;
    }

    // Bestehendes Fahrzeug: Position in der sortierten Liste (1-basiert)
    const pos = same.findIndex(v => String(v.id) === String(vehicleId));
    return pos >= 0 ? pos + 1 : same.length + 1;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RUFNAMEN-GENERATOR
  // ═══════════════════════════════════════════════════════════════════════════

  // Normalisiert Strings für Vergleich: trim + mehrfache Leerzeichen + non-breaking spaces
  function normStr(s) {
    return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function applySchema(schema, vars) {
    // {key/}        → value + "/" wenn nicht leer, sonst ""       (z.B. {tkz1/})
    // {key|fallback} → value wenn nicht leer, sonst fallback       (z.B. {tkz1|1})
    // {seq##}       → seq mit padStart(2,'0'), {seq###} → 3-stell.
    return schema
      .replace(/\{(\w+)\/\}/g, (_, key) => {
        const val = vars[key];
        return (val !== undefined && val !== null && String(val) !== '') ? String(val) + '/' : '';
      })
      .replace(/\{(\w+)\|([^}]*)\}/g, (_, key, fallback) => {
        const val = vars[key];
        return (val !== undefined && val !== null && String(val) !== '') ? String(val) : fallback;
      })
      .replace(/\{(\w+?)(#+)?\}/g, (_, key, hashes) => {
        const val = vars[key];
        if (val === undefined || val === null) return '';
        if (hashes && key === 'seq') return String(val).padStart(hashes.length, '0');
        return String(val);
      })
      .replace(/\s{2,}/g, ' ') // mehrfache Spaces → einfaches Space
      .trim();
  }


  // Ersetzt ein <select id=id> durch ein durchsuchbares Dropdown
  // options: [{value, label}], onSelect: (value) => void
  function makeSearchableSelect(container, id, options, currentValue, placeholder) {
    const wrap = document.createElement('div');
    wrap.className = 'lss-ss-wrap';
    wrap.id = id + '-ss';

    const display = document.createElement('div');
    display.className = 'lss-ss-display';
    const currentOpt = options.find(o => String(o.value) === String(currentValue));
    display.textContent = currentOpt ? currentOpt.label : (placeholder || '— wählen —');
    display.dataset.value = currentValue || '';

    const dropdown = document.createElement('div');
    dropdown.className = 'lss-ss-dropdown';
    dropdown.style.display = 'none';

    const searchInp = document.createElement('input');
    searchInp.type = 'text';
    searchInp.className = 'lss-ss-search';
    searchInp.placeholder = '🔍 Suche …';
    dropdown.appendChild(searchInp);

    const list = document.createElement('div');
    list.className = 'lss-ss-list';

    const renderList = (q) => {
      list.innerHTML = '';
      const filtered = q
        ? options.filter(o => o.label.toLowerCase().includes(q.toLowerCase()))
        : options;
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'lss-ss-empty';
        empty.textContent = 'Keine Treffer';
        list.appendChild(empty);
        return;
      }
      filtered.forEach(o => {
        const item = document.createElement('div');
        item.className = 'lss-ss-item';
        if (String(o.value) === String(display.dataset.value)) item.classList.add('lss-ss-selected');
        item.textContent = o.label;
        item.dataset.value = o.value;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          display.textContent = o.label;
          display.dataset.value = o.value;
          dropdown.style.display = 'none';
          wrap.dispatchEvent(new CustomEvent('ss-change', { detail: { value: o.value } }));
        });
        list.appendChild(item);
      });
    };
    renderList('');
    dropdown.appendChild(list);
    wrap.appendChild(display);
    wrap.appendChild(dropdown);

    display.addEventListener('click', () => {
      const open = dropdown.style.display !== 'none';
      // Alle anderen schließen
      document.querySelectorAll('.lss-ss-dropdown').forEach(d => d.style.display = 'none');
      if (!open) {
        dropdown.style.display = 'block';
        searchInp.value = '';
        renderList('');
        searchInp.focus();
      }
    });
    searchInp.addEventListener('input', () => renderList(searchInp.value));
    const _closeHandler = e => {
      if (!wrap.contains(e.target)) dropdown.style.display = 'none';
    };
    // Alten Handler entfernen falls vorhanden (bei Re-Init)
    wrap._closeHandler && document.removeEventListener('click', wrap._closeHandler, true);
    wrap._closeHandler = _closeHandler;
    document.addEventListener('click', _closeHandler, true);

    container.appendChild(wrap);
    return wrap;
  }

  // Erstellt <option>-HTML für das Fahrzeugtyp-Dropdown aus dem Spielkatalog
  function buildVehicleTypeOptions(selectedId) {
    try {
      const cat = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}');
      const entries = Object.entries(cat).sort((a, b) => {
        const na = typeof a[1] === 'string' ? a[1] : (a[1].caption || '');
        const nb = typeof b[1] === 'string' ? b[1] : (b[1].caption || '');
        return na.localeCompare(nb, 'de');
      });
      const opts = entries.map(([id, val]) => {
        const name = typeof val === 'string' ? val : (val.caption || val.name || id);
        const sel = String(id) === String(selectedId) ? ' selected' : '';
        return `<option value="${esc(id)}"${sel}>${esc(name)} (${esc(id)})</option>`;
      }).join('');
      return opts || '<option value="">Katalog nicht geladen</option>';
    } catch (_) {
      return '<option value="">Fehler beim Laden</option>';
    }
  }

  // Erstellt <option>-Elemente für das Org-Dropdown
  function buildOrgOptions(selectedValue) {
    const opts = [{ label: '— keine Auswahl —', value: '' }, ...cfg.orgLabels];
    return opts.map(o => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.value ? o.label + ' (' + o.value + ')' : o.label;
      if (o.value === selectedValue) opt.selected = true;
      return opt;
    });
  }

  // ortFromCoords: aus Nominatim, kann durch Gebäude-Override überschrieben werden
  function genCallsigns({ typeId, typeName, bl, buildingId, buildingCaption, ortFromCoords, dienst = null, startNr = 1, count = 1 }) {
    const kennzahl = getKennzahl(typeId, bl);
    if (!kennzahl) return [];

    const props = buildingProps[buildingId] || {};

    // Org: Gebäude-Override → Auto-Erkennung aus Gebäudename
    const orgEntry = detectOrgEntry(buildingCaption);
    // Feuerwehr/THW/Polizei: feste Org aus DIENST_ORG_DEFAULT
    // Rettung: Gebäude-Override → Auto-Erkennung aus Gebäudename
    const orgName = (dienst && dienst !== 'Rettung' && dienst in DIENST_ORG_DEFAULT)
      ? DIENST_ORG_DEFAULT[dienst]
      : (props.org || orgEntry?.name || '');
    // dienst kommt als Parameter (aus building_type), Fallback auf Org-Erkennung

    // Ort: Gebäude-Override → Nominatim-Koordinaten
    const ort = props.ort || ortFromCoords || '';

    // Standort: nur aus Gebäude-Eigenschaften
    const standort = props.standort || '';

    // Schema wählen: dienst-Parameter (aus building_type) hat Vorrang
    const schema = getSchema(bl, dienst || orgEntry?.dienst || null);

    return Array.from({ length: count }, (_, i) => {
      const seq = String(startNr + i);
      const alias = getAlias(typeId) || typeName;
      const leitstelleId = cacheBuilding.get(String(buildingId))?.leitstelle_building_id;
      const ils = getILS(leitstelleId);
      const result = applySchema(schema, { org: orgName, ort, tkz1: standort, tkz2: kennzahl, seq, typ: typeName, alias, ils });
      return result.trim().replace(/\s{2,}/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s*-\s*/g, '-');
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FORMULAR INJECTION
  // ═══════════════════════════════════════════════════════════════════════════

  const injectedForms = new WeakSet();

  async function handleForm(form) {
    if (injectedForms.has(form)) return;
    const vehicleId = vehicleIdFromForm(form);
    if (!vehicleId) return;
    const nameInput = form.querySelector(SEL_NAME_INPUT);
    if (!nameInput || form.querySelector('#lss-suggest-box')) return;
    injectedForms.add(form);

    const vehicle = await getVehicle(vehicleId);
    if (!vehicle) return;

    const buildingId = vehicle.building_id;
    const typeId = vehicle.vehicle_type;
    const typeName = getTypeName(typeId) || String(typeId);

    let bl = null, buildingCaption = '', startNr = 1;

    let ortFromCoords = '';
    if (buildingId) {
      const [blResult, building, ortResult, nr] = await Promise.all([
        getBundesland(buildingId),
        getBuilding(buildingId),
        getOrt(buildingId),
        getNextNr(buildingId, typeId, vehicleId),
      ]);
      bl = blResult;
      buildingCaption = building?.caption || '';
      ortFromCoords = ortResult;
      startNr = nr;
    }

    // Dienst aus building_type ermitteln (für Schema-Lookup)
    const orgEntry = detectOrgEntry(buildingCaption);
    const buildingType = (await getBuilding(buildingId))?.building_type ?? null;
    const dienst = (buildingType !== null ? BUILDING_TYPE_DIENST[buildingType] : null)
                        || orgEntry?.dienst || null;
    const activeSchema = getSchema(bl, dienst);
    const schemaKey = findSchemaKey(bl, dienst);

    const callsigns = genCallsigns({ typeId, typeName, bl, buildingId, buildingCaption, ortFromCoords, dienst, startNr, count: 1 });

    const blLabel = bl
      ? `${bl} · ${BUNDESLAENDER[bl]}`
      : '<span style="color:#c55;">BL nicht erkannt</span>';

    const box = document.createElement('div');
    box.id = 'lss-suggest-box';
    box.innerHTML = `
      <div class="lss-sb-header">
        <span class="lss-sb-icon">📻</span>
        <span class="lss-sb-title">Funkrufname</span>
        <span class="lss-sb-meta">
          <span class="lss-sb-tag">${esc(typeName)}</span>
          <span class="lss-sb-tag">${bl ? esc(bl) : '?'}</span>
          <span class="lss-sb-tag lss-sb-tag-schema" title="${esc(activeSchema)}">${esc(schemaKey)}</span>
        </span>
      </div>
      <div class="lss-sb-body">
        <div class="lss-sb-suggestion">
          ${callsigns.length
            ? callsigns.map(cs =>
                `<button class="lss-chip" data-cs="${esc(cs)}" title="Klicken um zu übernehmen">${esc(cs)}</button>`
              ).join('')
            : `<span class="lss-chip-warn">Kein Mapping für „${esc(typeName)}" ${bl ? 'in ' + esc(bl) : ''} —
               <a href="#" class="lss-cfg-a">Kennzahl konfigurieren</a></span>`
          }
        </div>

      </div>
    `;

    // Chip → Name übernehmen
    box.querySelectorAll('.lss-chip[data-cs]').forEach(chip => {
      chip.addEventListener('click', () => {
        nameInput.value = chip.dataset.cs;
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
        chip.classList.add('lss-chip-ok');
        setTimeout(() => chip.classList.remove('lss-chip-ok'), 900);
      });
    });

    box.querySelectorAll('.lss-cfg-a').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); openModal('kz'); });
    });

    // Box direkt nach dem Input einfügen — passt sich so der Inputbreite an
    nameInput.insertAdjacentElement('afterend', box);
  }

  function findSchemaKey(bl, dienst) {
    const s = cfg.schemas;
    const blk = bl || '*';
    const dk = dienst || '*';
    if (s[`${blk}/${dk}`]) return `${blk}/${dk}`;
    if (s[`*/${dk}`]) return `*/${dk}`;
    if (s[`${blk}/*`]) return `${blk}/*`;
    return '*/*';
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // GEBÄUDE-FORMULAR INJECTION
  // Fügt Org + Standortkennzahl-Felder in /buildings/<id>/edit ein
  // Formular: edit_building_<id>  |  Name-Input: #building_name
  // ═══════════════════════════════════════════════════════════════════════════


  function startObserver() {
    // Fahrzeug-Formulare
    document.querySelectorAll(SEL_FORM).forEach(handleForm);
    // Gebäude-Formulare (inline oder direkt im DOM)
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(SEL_FORM)) { handleForm(node); continue; }
          node.querySelectorAll?.(SEL_FORM).forEach(handleForm);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIG-MODAL
  // ═══════════════════════════════════════════════════════════════════════════

  function initAliasTypSelect(ov) {
    let cat = {};
    try { cat = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}'); } catch(_) {}
    const opts = Object.entries(cat)
      .map(([id, v]) => ({ value: id, label: (typeof v === 'string' ? v : (v.caption || v.name || id)) + ' (' + id + ')' }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de'));
    const cont = ov.querySelector('#alias-typ-container');
    if (!cont || !opts.length) return;
    const prevVal = cont.dataset.selectedValue || cont.querySelector('.lss-ss-display')?.dataset.value || '';
    cont.innerHTML = '';
    const ss = makeSearchableSelect(cont, 'alias-typ', opts, prevVal, '— Fahrzeugtyp wählen —');
    cont.dataset.selectedValue = prevVal;
    ss.addEventListener('ss-change', e => { cont.dataset.selectedValue = e.detail.value; });
  }

  function initKzTypSelect(ov) {
    let cat = {};
    try { cat = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}'); } catch(_) {}
    const opts = Object.entries(cat)
      .map(([id, v]) => ({
        value: id,
        label: (typeof v === 'string' ? v : (v.caption || v.name || id)) + ' (' + id + ')'
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de'));
    const kzTypCont = ov.querySelector('#kz-typ-container');
    if (!kzTypCont || !opts.length) return;
    // Wert VOR dem Rebuild merken
    const prevVal = kzTypCont.dataset.selectedValue
      || kzTypCont.querySelector('.lss-ss-display')?.dataset.value
      || '';
    kzTypCont.innerHTML = '';
    const ss = makeSearchableSelect(kzTypCont, 'kz-typ', opts, prevVal, '— Fahrzeugtyp wählen —');
    // Wert sofort in dataset schreiben damit kz-add ihn findet
    kzTypCont.dataset.selectedValue = prevVal;
    ss.addEventListener('ss-change', e => {
      kzTypCont.dataset.selectedValue = e.detail.value;
    });
  }

  function openModal(activeTab = 'kz') {
    if (document.getElementById('lss-modal-overlay')) {
      // Tab wechseln falls Modal schon offen
      document.querySelector(`.lss-tab[data-t="t-${activeTab}"]`)?.click();
      return;
    }

    const ov = document.createElement('div');
    ov.id = 'lss-modal-overlay';
    ov.innerHTML = `
      <div id="lss-modal">
        <div id="lss-modal-hdr">
          <h2>📻 Funkrufnamen-Generator · Konfiguration</h2>
          <button id="lss-modal-x">✕</button>
        </div>
        <div id="lss-modal-bdy">
          <div class="lss-tabs">
            <button class="lss-tab" data-t="t-kz">2. TKZ-Mapping</button>
            <button class="lss-tab" data-t="t-schemas">Schemas</button>
            <button class="lss-tab" data-t="t-org">Org-Kennungen</button>
            <button class="lss-tab" data-t="t-orglabels">Org-Liste</button>
            <button class="lss-tab" data-t="t-aliases">Aliase</button>
            <button class="lss-tab" data-t="t-ils">ILS</button>
            <button class="lss-tab" data-t="t-buildings">Gebäude-Eigenschaften</button>
            <button class="lss-tab" data-t="t-bulk">Massen-Umbenennung</button>
            <button class="lss-tab" data-t="t-io">Import / Export</button>
            <button class="lss-tab" data-t="t-help">Hilfe</button>
          </div>

          <!-- SCHEMAS -->
          <div class="lss-tp" id="t-schemas">
            <div class="lss-note">
              <div style="margin-bottom:6px;">
                <strong>Platzhalter</strong>
                <span style="font-size:11px;color:#5a8a9f;margin-left:6px;">Klicken zum Einfügen an Cursor-Position</span>
              </div>
              <div class="lss-ph-chips">
                ${[
                  ['{org}', 'Organisation'],
                  ['{ort}', 'Ortsname'],
                  ['{ils}', 'ILS-Bereichsname'],
                  ['{tkz1}', '1. TKZ'],
                  ['{tkz1/}', '1. TKZ (bedingt)'],
                  ['{tkz1|1}', '1. TKZ (Fallback 1)'],
                  ['{tkz2}', '2. TKZ'],
                  ['{seq}', 'Sequenz'],
                  ['{seq##}', 'Seq. 2-stellig'],
                  ['{seq###}', 'Seq. 3-stellig'],
                  ['{typ}', 'Fahrzeugtyp'],
                  ['{alias}', 'Typ-Alias'],
                ].map(([ph, label]) =>
                  `<button class="lss-ph-chip" data-ph="${ph}" type="button" title="${label}">${ph}</button>`
                ).join('')}
              </div>
              <div style="margin-top:7px;font-size:12px;color:#5a8a9f;">
                <strong>Schlüssel:</strong> <code>BL/Dienst</code> z.B. <code>BY/Rettung</code> ·
                Wildcard: <code>*</code> · Fallback: BL/Dienst → */Dienst → BL/* → */*
              </div>
            </div>
            <div class="lss-row">
              <div>
                <label>Bundesland</label>
                <select id="sc-bl" style="min-width:130px;">
                  <option value="*">* (alle)</option>
                  ${Object.entries(BUNDESLAENDER).map(([k,v]) =>
                    `<option value="${k}">${k} – ${v}</option>`).join('')}
                </select>
              </div>
              <div>
                <label>Dienst</label>
                <select id="sc-org" style="min-width:130px;">
                  <option value="*">* (alle)</option>
                  ${DIENSTE.map(d => `<option value="${d}">${d}</option>`).join('')}
                </select>
              </div>
              <div style="flex:1;">
                <label>Schema</label>
                <input id="sc-val" type="text" placeholder="{org} {ort} {tkz2}/{seq##}"
                       style="width:100%;min-width:250px;">
              </div>
              <button class="lss-btn lss-btn-ok" id="sc-add">+ Hinzufügen</button>
            </div>
            <div id="sc-tbl">${buildSchemaTable()}</div>

          </div>

          <!-- KENNZAHLEN -->
          <div class="lss-tp" id="t-kz">
            <div class="lss-note">
              2. TKZ pro Fahrzeugtyp-ID und Bundesland.
              <strong>*</strong> = globaler Fallback für alle Bundesländer.
            </div>
            <div class="lss-row">
              <div><label>Bundesland</label>
                <select id="kz-bl" style="min-width:140px;">
                  <option value="*">* (global)</option>
                  ${Object.entries(BUNDESLAENDER).map(([k,v]) =>
                    `<option value="${k}">${k} – ${v}</option>`).join('')}
                </select></div>
              <div><label>Fahrzeugtyp</label>
                <div id="kz-typ-container" style="min-width:220px;position:relative;"></div>
              </div>
              <div><label>2. TKZ</label>
                <input id="kz-val" type="text" placeholder="z.B. 71" style="width:80px;"></div>
              <button class="lss-btn lss-btn-ok" id="kz-add">+ Hinzufügen</button>
            </div>
            <div id="kz-tbl">${buildKzTable()}</div>
          </div>

          <!-- ORG-KENNUNGEN -->
          <div class="lss-tp" id="t-org">
            <div class="lss-note">
              Schlüsselwort im Gebäudenamen → Dienst (für Schema-Lookup) + Anzeigename (für <code>{org}</code>).
            </div>
            <div class="lss-row">
              <div><label>Schlüsselwort</label>
                <input id="org-kw" type="text" placeholder="z.B. DRK" style="width:110px;"></div>
              <div><label>Dienst</label>
                <select id="org-dienst" style="min-width:120px;">
                  ${DIENSTE.map(d => `<option value="${d}">${d}</option>`).join('')}
                </select></div>
              <div><label>Anzeigename ({org})</label>
                <input id="org-name" type="text" placeholder="z.B. Rotkreuz" style="width:140px;"></div>
              <button class="lss-btn lss-btn-ok" id="org-add">+ Hinzufügen</button>
            </div>
            <div id="org-tbl">${buildOrgTable()}</div>
          </div>

          <!-- ORG-LISTE -->
          <div class="lss-tp" id="t-orglabels">
            <div class="lss-note">
              Diese Liste befüllt das Organisations-Dropdown in den Gebäude-Eigenschaften.
              <strong>Label</strong> = Anzeigename im Dropdown · <strong>Funkkennung</strong> = Wert für <code>{org}</code>.
            </div>
            <div class="lss-row">
              <div><label>Label (Anzeige)</label>
                <input id="ol-label" type="text" placeholder="z.B. DRK / BRK" style="width:180px;"></div>
              <div><label>Funkkennung ({org})</label>
                <input id="ol-value" type="text" placeholder="z.B. Rotkreuz" style="width:140px;"></div>
              <button class="lss-btn lss-btn-ok" id="ol-add">+ Hinzufügen</button>
            </div>
            <div id="ol-tbl">${buildOrgLabelsTable()}</div>
          </div>

          <!-- ALIASE -->
          <div class="lss-tp" id="t-aliases">
            <div class="lss-note">
              Fahrzeugtyp-Aliase für den Platzhalter <code>{alias}</code>.
              Ist kein Alias gesetzt, wird der Typname (<code>{typ}</code>) verwendet.
            </div>
            <div class="lss-row">
              <div><label>Fahrzeugtyp</label>
                <div id="alias-typ-container" style="min-width:220px;position:relative;"></div>
              </div>
              <div><label>Alias</label>
                <input id="alias-val" type="text" placeholder="z.B. FRT" style="width:120px;"></div>
              <button class="lss-btn lss-btn-ok" id="alias-add">+ Hinzufügen</button>
            </div>
            <div id="alias-tbl">${buildAliasTable()}</div>
          </div>

          <!-- ILS -->
          <div class="lss-tp" id="t-ils">
            <div class="lss-note">
              Ordnet einer Leitstelle (Building-ID) einen Bereichsnamen zu. Verwendbar als Platzhalter <code>{ils}</code> im Schema.
            </div>
            <div class="lss-row">
              <div><label>Leitstelle</label>
                <div id="ils-building-container" style="min-width:220px;position:relative;"></div>
              </div>
              <div><label>Bereichsname</label>
                <input id="ils-val" type="text" placeholder="z.B. KRU" style="width:120px;"></div>
              <button class="lss-btn lss-btn-ok" id="ils-add">+ Hinzufügen</button>
            </div>
            <div id="ils-tbl">${buildILSTable()}</div>
          </div>

          <!-- GEBÄUDE-EIGENSCHAFTEN -->
          <div class="lss-tp" id="t-buildings">
            <div class="lss-note">
              Hier kannst du für jedes Gebäude manuelle Overrides pflegen.
              Diese werden auch direkt im Vorschlagsbereich gespeichert.
            </div>
            <div id="buildings-tbl">${buildBuildingsTable()}</div>
          </div>

          <!-- MASSEN-UMBENENNUNG -->
          <div class="lss-tp" id="t-bulk">
            <div class="lss-note">
              Lädt alle Fahrzeuge deines Accounts und generiert Vorschläge anhand der konfigurierten Schemas und 2. TKZ-Mappings.
              Nur Fahrzeuge mit einem gültigen Mapping werden vorgeschlagen. Alle Namen sind vor dem Speichern bearbeitbar.
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center;">
              <div id="bulk-dienst-btns" style="display:flex;gap:4px;flex-wrap:wrap;">
                <button class="bulk-db bulk-db-active" data-d="">Alle</button>
                ${['Feuerwehr','Rettung','Polizei','THW'].map(d =>
                  `<button class="bulk-db" data-d="${d.toLowerCase()}">${d}</button>`
                ).join('')}
              </div>
              <input id="bulk-filter-pre" type="text" placeholder="🔍 Wache, Typ, Name …"
                style="border:1px solid #c5cad8;border-radius:6px;padding:4px 10px;font-size:12px;width:200px;">
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
              <button class="lss-btn lss-btn-blue" id="bulk-load">🔄 Fahrzeuge laden &amp; Vorschläge generieren</button>
              <span id="bulk-status" style="font-size:12px;color:#667;"></span>
            </div>
            <div id="bulk-preview"></div>
          </div>

          <!-- IMPORT / EXPORT -->
          <div class="lss-tp" id="t-io">
            <p style="font-size:13px;color:#444;">
              Exportiert werden 2. TKZ-Mapping, Schemas und Org-Kennungen (nicht Gebäude-Eigenschaften).
            </p>
            <button class="lss-btn lss-btn-blue" id="io-exp">⬇ Konfiguration exportieren</button>
            <button class="lss-btn lss-btn-blue" id="io-exp-b" style="margin-left:6px;">⬇ Gebäude-Eigenschaften exportieren</button>
            <button class="lss-btn lss-btn-gray" id="io-rst" style="margin-left:6px;">↺ Standard</button>
            <hr style="margin:14px 0;border:none;border-top:1px solid #dde;">
            <textarea id="io-ta" rows="9"
              style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;
                     border:1px solid #c5cad8;border-radius:6px;padding:8px;"
              placeholder="JSON hier einfügen..."></textarea>
            <div style="margin-top:8px;display:flex;gap:8px;">
              <button class="lss-btn lss-btn-ok" id="io-imp">⬆ Konfiguration importieren</button>
              <button class="lss-btn lss-btn-ok" id="io-imp-b">⬆ Gebäude-Eigenschaften importieren</button>
            </div>
            <div id="io-fb" style="margin-top:10px;"></div>
          </div>

          <!-- HILFE -->
          <div class="lss-tp" id="t-help">
            <div class="lss-note">
              <strong>Schema-Platzhalter:</strong><br>
              <code>{org}</code> → Organisationskennung (z.B. „Rotkreuz")<br>
              <code>{ort}</code> → Ortsname (aus Gebäudename extrahiert oder Override)<br>
              <code>{tkz1}</code> → 1. TKZ (aus Gebäude-Eigenschaften)<br>
              <code>{tkz1/}</code> → 1. TKZ + "/" wenn gesetzt, sonst leer<br>
              <code>{tkz1|1}</code> → 1. TKZ, Fallback "1" wenn nicht gesetzt<br>
              <code>{typ}</code> → Fahrzeugtyp-Name (z.B. RTW, HLF 20)<br>
              <code>{alias}</code> → Alias des Fahrzeugtyps (z.B. FRT), Fallback: Typname<br>
              <code>{tkz2}</code> → 2. TKZ (aus 2. TKZ-Mapping)<br>
              <code>{seq}</code> → Sequenznummer (1, 2, 3 …)
            </div>
            <p style="font-size:13px;line-height:1.8;">
              <strong>Beispiel BY/Rettung:</strong><br>
              Schema: <code>{org} {ort} {tkz2}/{seq}</code><br>
              → <code>Rotkreuz Augsburg 71/1</code><br><br>
              <strong>Beispiel BW/Rettung:</strong><br>
              Schema: <code>{org} {ort} {tkz1}/{tkz2}-{seq}</code><br>
              Gebäude-Eigenschaften: tkz1 = <code>1</code>, ort-Override = <code>Ulm</code><br>
              → <code>Rotkreuz Ulm 1/83-1</code>
            </p>
            <p style="font-size:12px;color:#666;margin-top:12px;">
              API-Changelog:
              <a href="https://www.leitstellenspiel.de/api-infos" target="_blank" style="color:#1d5f9e;">
                leitstellenspiel.de/api-infos
              </a>
            </p>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(ov);

    // Aktiven Tab setzen
    const activateTab = tabId => {
      ov.querySelectorAll('.lss-tab').forEach(t => t.classList.remove('active'));
      ov.querySelectorAll('.lss-tp').forEach(t => t.classList.remove('active'));
      ov.querySelector(`.lss-tab[data-t="${tabId}"]`)?.classList.add('active');
      document.getElementById(tabId)?.classList.add('active');
    };
    activateTab(`t-${activeTab}`);

    ov.querySelectorAll('.lss-tab').forEach(tab => {
      tab.addEventListener('click', () => activateTab(tab.dataset.t));
    });

    ov.querySelector('#lss-modal-x').addEventListener('click', () => ov.remove());
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });

    // Schema add
    ov.querySelector('#sc-add').addEventListener('click', () => {
      const bl = ov.querySelector('#sc-bl').value;
      const org = ov.querySelector('#sc-org').value;
      const val = ov.querySelector('#sc-val').value.trim();
      if (!val) return;
      cfg.schemas[`${bl}/${org}`] = val;
      saveConfig(cfg);
      ov.querySelector('#sc-tbl').innerHTML = buildSchemaTable();
      bindSchemaEvents(ov);
      ov.querySelector('#sc-val').value = '';
    });
    bindSchemaEvents(ov);

    // Fahrzeugtyp-Searchable-Select initialisieren
    initKzTypSelect(ov);

    // Kennzahl add
    ov.querySelector('#kz-add').addEventListener('click', () => {
      const bl = ov.querySelector('#kz-bl').value;
      const cont = ov.querySelector('#kz-typ-container');
      const typ = cont?.dataset.selectedValue
             || cont?.querySelector('.lss-ss-display')?.dataset.value || '';
      const val = ov.querySelector('#kz-val').value.trim();
      if (!typ || !val) {
        if (!typ) { cont && (cont.style.outline = '2px solid #dc3545'); setTimeout(() => cont && (cont.style.outline = ''), 1500); }
        return;
      }
      if (!cfg.kz[bl]) cfg.kz[bl] = {};
      cfg.kz[bl][typ] = val;
      saveConfig(cfg);
      ov.querySelector('#kz-tbl').innerHTML = buildKzTable();
      bindKzEvents(ov);
      initKzTypSelect(ov);
      // Nach Hinzufügen: Select zurücksetzen
      const resetCont = ov.querySelector('#kz-typ-container');
      if (resetCont) {
        resetCont.dataset.selectedValue = '';
        const disp = resetCont.querySelector('.lss-ss-display');
        if (disp) { disp.textContent = '— Fahrzeugtyp wählen —'; disp.dataset.value = ''; }
      }
      ov.querySelector('#kz-val').value = '';
      // Visuelles Feedback
      const added = ov.querySelector(`#kz-tbl .kz-row[data-bl="${bl}"][data-typ="${typ}"]`);
      if (added) {
        added.style.background = '#e6f9ee';
        setTimeout(() => { added.style.background = ''; }, 1500);
        // Gruppe aufklappen
        const grp = ov.querySelector(`#kz-tbl .kz-group[data-bl="${bl}"]`);
        if (grp) {
          const body = grp.querySelector('.kz-group-body');
          const arrow = grp.querySelector('.kz-group-arrow');
          if (body) body.style.display = 'table';
          if (arrow) { arrow.textContent = '▼'; arrow.style.color = '#1d5f9e'; }
        }
      }
    });
    bindKzEvents(ov);

    // Org add
    ov.querySelector('#org-add').addEventListener('click', () => {
      const kw = ov.querySelector('#org-kw').value.trim();
      const dienst = ov.querySelector('#org-dienst').value;
      const name = ov.querySelector('#org-name').value.trim();
      if (!kw || !name) return;
      cfg.org[kw] = { dienst, name };
      saveConfig(cfg);
      ov.querySelector('#org-tbl').innerHTML = buildOrgTable();
      bindOrgEvents(ov);
      ov.querySelector('#org-kw').value = ov.querySelector('#org-name').value = '';
    });
    bindOrgEvents(ov);
    // Org-Liste add
    ov.querySelector('#ol-add').addEventListener('click', () => {
      const label = ov.querySelector('#ol-label').value.trim();
      const value = ov.querySelector('#ol-value').value.trim();
      if (!label || !value) return;
      cfg.orgLabels.push({ label, value });
      saveConfig(cfg);
      ov.querySelector('#ol-tbl').innerHTML = buildOrgLabelsTable();
      bindOrgLabelsEvents(ov);
      ov.querySelector('#ol-label').value = '';
      ov.querySelector('#ol-value').value = '';
    });
    bindOrgLabelsEvents(ov);
    // ILS add
    initILSBuildingSelect(ov);
    ov.querySelector('#ils-add').addEventListener('click', () => {
      const cont  = ov.querySelector('#ils-building-container');
      const bid   = cont?.dataset.selectedValue || cont?.querySelector('.lss-ss-display')?.dataset.value || '';
      const val   = ov.querySelector('#ils-val').value.trim();
      if (!bid || !val) {
        if (!bid) { cont && (cont.style.outline = '2px solid #dc3545'); setTimeout(() => cont && (cont.style.outline = ''), 1500); }
        return;
      }
      if (!cfg.ils) cfg.ils = {};
      cfg.ils[bid] = val;
      saveConfig(cfg);
      ov.querySelector('#ils-tbl').innerHTML = buildILSTable();
      bindILSEvents(ov);
      ov.querySelector('#ils-val').value = '';
      const resetCont = ov.querySelector('#ils-building-container');
      if (resetCont) {
        resetCont.dataset.selectedValue = '';
        const disp = resetCont.querySelector('.lss-ss-display');
        if (disp) { disp.textContent = '— Leitstelle wählen —'; disp.dataset.value = ''; }
      }
    });
    bindILSEvents(ov);

    // Alias add
    initAliasTypSelect(ov);
    ov.querySelector('#alias-add').addEventListener('click', () => {
      const cont = ov.querySelector('#alias-typ-container');
      const typId = cont?.dataset.selectedValue || cont?.querySelector('.lss-ss-display')?.dataset.value || '';
      const val = ov.querySelector('#alias-val').value.trim();
      if (!typId || !val) {
        if (!typId) { cont && (cont.style.outline = '2px solid #dc3545'); setTimeout(() => cont && (cont.style.outline = ''), 1500); }
        return;
      }
      if (!cfg.aliases) cfg.aliases = {};
      cfg.aliases[typId] = val;
      saveConfig(cfg);
      ov.querySelector('#alias-tbl').innerHTML = buildAliasTable();
      bindAliasEvents(ov);
      ov.querySelector('#alias-val').value = '';
      const resetCont = ov.querySelector('#alias-typ-container');
      if (resetCont) {
        resetCont.dataset.selectedValue = '';
        const disp = resetCont.querySelector('.lss-ss-display');
        if (disp) { disp.textContent = '— Fahrzeugtyp wählen —'; disp.dataset.value = ''; }
      }
    });
    bindAliasEvents(ov);
    bindBuildingsEvents(ov);

    // Massen-Umbenennung — Dienst-Buttons sofort aktiv (vor dem Laden)
    let bulkActiveDienst = '';
    ov.querySelectorAll('.bulk-db').forEach(btn => {
      btn.addEventListener('click', () => {
        ov.querySelectorAll('.bulk-db').forEach(b => b.classList.remove('bulk-db-active'));
        btn.classList.add('bulk-db-active');
        bulkActiveDienst = btn.dataset.d;
        // Falls Tabelle bereits geladen: sofort filtern
        ov.querySelector('#bulk-preview')?.querySelectorAll?.('tbody tr').forEach(tr => {
          const d = tr.dataset.dienst || '';
          const q = ov.querySelector('#bulk-filter-pre')?.value.toLowerCase().trim() || '';
          const dienstMatch = !bulkActiveDienst || d === bulkActiveDienst;
          const textMatch = !q || d.includes(q)
            || (tr.dataset.building||'').includes(q)
            || (tr.dataset.typ||'').includes(q)
            || (tr.dataset.current||'').includes(q);
          tr.style.display = dienstMatch && textMatch ? '' : 'none';
        });
      });
    });
    ov.querySelector('#bulk-filter-pre')?.addEventListener('input', () => {
      const q = ov.querySelector('#bulk-filter-pre').value.toLowerCase().trim();
      ov.querySelector('#bulk-preview')?.querySelectorAll?.('tbody tr').forEach(tr => {
        const dienstMatch = !bulkActiveDienst || (tr.dataset.dienst||'') === bulkActiveDienst;
        const textMatch = !q
          || (tr.dataset.building||'').includes(q)
          || (tr.dataset.typ||'').includes(q)
          || (tr.dataset.current||'').includes(q);
        tr.style.display = dienstMatch && textMatch ? '' : 'none';
      });
    });

    ov.querySelector('#bulk-load').addEventListener('click', async () => {
      const statusEl = ov.querySelector('#bulk-status');
      const previewEl = ov.querySelector('#bulk-preview');
      const loadBtn = ov.querySelector('#bulk-load');
      loadBtn.disabled = true;
      statusEl.textContent = 'Lade Fahrzeuge …';
      previewEl.innerHTML = '';

      try {
        // Caches leeren damit aktuelle Daten geladen werden
        cacheBuilding.clear();
        cacheVehicle.clear();

        // Alle Fahrzeuge laden
        const allVehicles = await apiFetch('/api/vehicles');
        if (!Array.isArray(allVehicles) || !allVehicles.length) {
          statusEl.textContent = 'Keine Fahrzeuge gefunden.';
          loadBtn.disabled = false;
          return;
        }

        // Dienst-Filter: direkt beim Laden aus aktivem Button lesen
        const dienstFilter = (ov.querySelector('.bulk-db-active')?.dataset.d || '').toLowerCase();

        statusEl.textContent = allVehicles.length + ' Fahrzeuge geladen, lade Gebäude …';

        // Schritt 1: Alle unique Gebäude-IDs laden (nur building-API, kein Nominatim)
        const buildingIds = [...new Set(allVehicles.map(v => v.building_id).filter(Boolean))];
        await Promise.all(buildingIds.map(id => getBuilding(id)));

        // Schritt 2: Gebäude nach Dienst filtern
        const relevantBuildingIds = new Set();
        for (const bid of buildingIds) {
          const b = await getBuilding(bid);
          const bt = b?.building_type;
          const d = bt != null ? (BUILDING_TYPE_DIENST[bt] || '') : '';
          if (!dienstFilter || d.toLowerCase() === dienstFilter) {
            relevantBuildingIds.add(String(bid));
          }
        }

        statusEl.textContent = relevantBuildingIds.size + ' Gebäude gefiltert, generiere Vorschläge …';

        // Schritt 3: Koordinaten nur für relevante Gebäude sequentiell laden
        const relevantArr = [...relevantBuildingIds];
        const uncachedIds = relevantArr.filter(id => !cacheBL.has(String(id)));
        if (uncachedIds.length > 0) {
          statusEl.textContent = `0 / ${uncachedIds.length} Koordinaten laden … (${relevantArr.length - uncachedIds.length} aus Cache)`;
          let done = 0;
          for (const id of uncachedIds) {
            await fetchGeoData(id);
            done++;
            statusEl.textContent = `${done} / ${uncachedIds.length} Koordinaten geladen … (ca. ${Math.round((uncachedIds.length - done) * 1.1)}s verbleibend)`;
          }
        } else {
          statusEl.textContent = `Alle ${relevantArr.length} Koordinaten aus Cache geladen.`;
        }

        // Pro Gebäude Fahrzeuge sortieren und Vorschläge generieren
        statusEl.textContent = 'Generiere Vorschläge …';
        const rows = [];
        const byBuilding = {};
        for (const v of allVehicles) {
          const bid = String(v.building_id);
          if (!relevantBuildingIds.has(bid)) continue;
          if (!byBuilding[bid]) byBuilding[bid] = [];
          byBuilding[bid].push(v);
        }

        let processedBuildings = 0;
        const totalBuildings = Object.keys(byBuilding).length;
        for (const [bid, bVehicles] of Object.entries(byBuilding)) {
          const building = await getBuilding(bid);
          const bl = await getBundesland(bid);
          const ortCoords = await getOrt(bid);
          const buildingCap = building?.caption || '';
          const dienst = building?.building_type != null
            ? BUILDING_TYPE_DIENST[building.building_type] || null : null;

          processedBuildings++;
          if (processedBuildings % 10 === 0 || processedBuildings === totalBuildings) {
            statusEl.textContent = `Vorschläge: ${processedBuildings} / ${totalBuildings} Wachen …`;
          }

          for (const v of bVehicles.sort((a,b) => Number(a.id)-Number(b.id))) {
            const typeId = v.vehicle_type;
            const typeName = getTypeName(typeId) || String(typeId);
            const same = bVehicles
              .filter(x => String(x.vehicle_type) === String(typeId))
              .sort((a,b) => Number(a.id)-Number(b.id));
            const pos = same.findIndex(x => String(x.id) === String(v.id));
            const startNr = pos >= 0 ? pos + 1 : same.length + 1;
            const suggested = genCallsigns({
              typeId, typeName, bl, buildingId: bid,
              buildingCaption: buildingCap,
              ortFromCoords: ortCoords,
              dienst, startNr, count: 1,
            });
            rows.push({
              id: v.id,
              current: v.caption || '',
              suggested: suggested[0] || '',
              typeName,
              buildingCap,
              dienst: dienst || '',
            });
          }
        }

        const withSuggestion = rows.filter(r => r.suggested);
        const withChange = rows.filter(r => r.suggested && normStr(r.suggested) !== normStr(r.current));
        statusEl.textContent = withChange.length + ' von ' + rows.length + ' Fahrzeugen umzubenennen'
          + (withChange.length === 0 && withSuggestion.length > 0 ? ' · alle ' + withSuggestion.length + ' Namen bereits korrekt ✓' : '');

        // Tabelle rendern
        const inputMap = {};
        const tableHtml = `
          <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
            <label style="font-size:12px;display:flex;align-items:center;gap:5px;">
              <input type="checkbox" id="bulk-all-chk" checked>
              Alle mit Vorschlag
            </label>
            <input id="bulk-filter" type="text" placeholder="🔍 Filter …"
              style="border:1px solid #c5cad8;border-radius:6px;padding:4px 10px;font-size:12px;width:220px;">
            <button class="lss-btn lss-btn-ok" id="bulk-apply" style="margin-left:auto;">
              ✓ Ausgewählte umbenennen
            </button>
          </div>
          <div style="max-height:420px;overflow-y:auto;border:1px solid #e2eaf4;border-radius:8px;">
            <table class="lss-tbl" id="bulk-table" style="font-size:12px;">
              <thead style="position:sticky;top:0;z-index:1;background:#eef2fa;">
                <tr>
                  <th style="width:32px;padding:7px 10px;"></th>
                  <th style="padding:7px 10px;">Wache</th>
                  <th style="padding:7px 10px;">Typ</th>
                  <th style="padding:7px 10px;">Aktueller Name</th>
                  <th style="padding:7px 10px;">Neuer Name</th>
                </tr>
              </thead>
              <tbody id="bulk-tbody"></tbody>
            </table>
          </div>`;

        previewEl.innerHTML = tableHtml;
        const tbody = previewEl.querySelector('#bulk-tbody');

        // Sortieren: erst Änderungen ausstehend, dann keine Änderung, dann kein Mapping
        rows.sort((a, b) => {
          const aChanged = a.suggested && normStr(a.suggested) !== normStr(a.current);
          const bChanged = b.suggested && normStr(b.suggested) !== normStr(b.current);
          if (aChanged && !bChanged) return -1;
          if (!aChanged && bChanged) return 1;
          if (a.suggested && !b.suggested) return -1;
          if (!a.suggested && b.suggested) return 1;
          return 0;
        });

        let lastSection = null;
        rows.forEach((row, idx) => {
          const tr = document.createElement('tr');
          tr.dataset.vehicleId = String(row.id);
          tr.dataset.building = row.buildingCap.toLowerCase();
          tr.dataset.typ = row.typeName.toLowerCase();
          tr.dataset.current = row.current.toLowerCase();
          tr.dataset.dienst = (row.dienst || '').toLowerCase();

          // Sektions-Trenner
          const section = !row.suggested ? 'none'
            : normStr(row.suggested) !== normStr(row.current) ? 'changed' : 'same';
          tr.dataset.section = section;
          if (section !== lastSection) {
            lastSection = section;
            const sep = document.createElement('tr');
            sep.className = 'bulk-section-hdr';
            sep.dataset.section = section;
            const sectionStyles = {
              changed: { bg: '#fff3f3', color: '#b00020', border: '#f5c6cb', label: '⚠ Änderungen ausstehend' },
              same: { bg: '#e6f9ee', color: '#1a6b35', border: '#b8e8cc', label: '✓ Keine Änderung notwendig' },
              none: { bg: '#f5f5f5', color: '#888', border: '#e0e0e0', label: '— Kein Mapping' },
            };
            const st = sectionStyles[section];
            sep.innerHTML = `<td colspan="5" style="padding:6px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:${st.bg};color:${st.color};border-top:2px solid ${st.border};">${st.label}</td>`;
            tbody.appendChild(sep);
          }

          tr.style.background = idx % 2 === 0 ? '#fff' : '#fafbfd';

          const tdCb = document.createElement('td');
          tdCb.style.cssText = 'padding:4px 10px;';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!row.suggested && normStr(row.suggested) !== normStr(row.current);
          cb.disabled = !row.suggested;
          tdCb.appendChild(cb);
          tr.appendChild(tdCb);

          const tdB = document.createElement('td');
          tdB.style.cssText = 'padding:4px 10px;color:#778;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          tdB.textContent = row.buildingCap;
          tdB.title = row.buildingCap;
          tr.appendChild(tdB);

          const tdT = document.createElement('td');
          tdT.style.cssText = 'padding:4px 10px;color:#556;white-space:nowrap;';
          tdT.textContent = row.typeName;
          tr.appendChild(tdT);

          const tdC = document.createElement('td');
          tdC.style.cssText = 'padding:4px 10px;color:#999;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          tdC.textContent = row.current;
          tdC.title = row.current;
          tr.appendChild(tdC);

          const tdN = document.createElement('td');
          tdN.style.cssText = 'padding:3px 6px;';
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.value = row.suggested || row.current;
          inp.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid #c5cad8;border-radius:5px;padding:3px 7px;font-size:12px;';
          if (!row.suggested) { inp.style.background = '#f5f5f5'; inp.style.color = '#aaa'; }
          inp.addEventListener('input', () => {
            cb.checked = inp.value.trim() !== '' && normStr(inp.value) !== normStr(row.current);
          });
          tdN.appendChild(inp);
          tr.appendChild(tdN);

          tr.dataset.vehicleId = String(row.id);
          tbody.appendChild(tr);
          inputMap[row.id] = { cb, inp, current: row.current };
        });

        // Filter-Funktion (Dienst + Freitext kombiniert)
        // Variablen aus dem äußeren Scope verwenden
        let activeDienst = bulkActiveDienst;
        const applyFilter = () => {
          activeDienst = bulkActiveDienst;
          const q = ov.querySelector('#bulk-filter-pre')?.value.toLowerCase().trim() || '';
          const sectionVisible = {};
          tbody.querySelectorAll('tr:not(.bulk-section-hdr)').forEach(tr => {
            const dienstMatch = !activeDienst || tr.dataset.dienst === activeDienst;
            const textMatch = !q
              || tr.dataset.building?.includes(q)
              || tr.dataset.typ?.includes(q)
              || tr.dataset.current?.includes(q);
            const visible = dienstMatch && textMatch;
            tr.style.display = visible ? '' : 'none';
            if (visible) sectionVisible[tr.dataset.section] = true;
          });
          tbody.querySelectorAll('tr.bulk-section-hdr').forEach(tr => {
            tr.style.display = sectionVisible[tr.dataset.section] ? '' : 'none';
          });
        };

        // Sofort filtern mit vorgewähltem Dienst/Text
        applyFilter();

        // Alle-Toggle (nur sichtbare)
        previewEl.querySelector('#bulk-all-chk').addEventListener('change', e => {
          tbody.querySelectorAll('tr:not(.bulk-section-hdr):not([style*="display: none"])').forEach(tr => {
            const row = inputMap[tr.dataset.vehicleId];
            if (row && !row.cb.disabled) row.cb.checked = e.target.checked;
          });
        });

        // Freitext-Filter aktualisiert nach Laden ebenfalls via äußerem Listener
        // (bulk-filter-pre ist bereits gebunden)

        // Umbenennen
        previewEl.querySelector('#bulk-apply').addEventListener('click', async () => {
          const toRename = Object.entries(inputMap)
            .filter(([, {cb, inp, current}]) => cb.checked && inp.value.trim())
            .map(([id, {inp}]) => ({ id, name: inp.value.trim() }));

          if (!toRename.length) { statusEl.textContent = 'Keine Änderungen ausgewählt.'; return; }

          const applyBtn = previewEl.querySelector('#bulk-apply');
          applyBtn.disabled = true;
          applyBtn.textContent = '…';
          let done = 0, errors = 0;
          statusEl.textContent = '0 / ' + toRename.length;

          for (const { id, name } of toRename) {
            try {
              const token = document.querySelector('meta[name="csrf-token"]')?.content
                || document.querySelector('input[name="authenticity_token"]')?.value || '';
              const resp = await fetch('/vehicles/' + id, {
                method: 'POST', credentials: 'same-origin', redirect: 'manual',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token },
                body: new URLSearchParams({ 'authenticity_token': token, 'vehicle[caption]': name, '_method': 'patch' }),
              });
              if (resp.ok || resp.redirected || resp.status === 0 || resp.status < 500) {
                done++;
                const row = inputMap[id];
                if (row) {
                  row.current = name;
                  row.inp.style.background = '#e6f9ee';
                  row.inp.style.color = '#1a6b35';
                  row.cb.checked = false;
                  // Zeile in Sektion "Keine Änderung notwendig" verschieben
                  const tr = tbody.querySelector(`tr[data-vehicle-id="${id}"]`);
                  if (tr) {
                    tr.dataset.section = 'same';
                    // Sektions-Header "same" suchen oder erstellen
                    let sameHdr = tbody.querySelector('.bulk-section-hdr[data-section="same"]');
                    if (!sameHdr) {
                      sameHdr = document.createElement('tr');
                      sameHdr.className = 'bulk-section-hdr';
                      sameHdr.dataset.section = 'same';
                      sameHdr.innerHTML = `<td colspan="5" style="padding:6px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:#e6f9ee;color:#1a6b35;border-top:2px solid #b8e8cc;">✓ Keine Änderung notwendig</td>`;
                      tbody.appendChild(sameHdr);
                    }
                    sameHdr.insertAdjacentElement('afterend', tr);
                    // "Änderungen ausstehend"-Header ausblenden wenn keine Rows mehr
                    const changedHdr = tbody.querySelector('.bulk-section-hdr[data-section="changed"]');
                    if (changedHdr) {
                      const hasChanged = [...tbody.querySelectorAll('tr[data-section="changed"]')].some(r => r.style.display !== 'none');
                      changedHdr.style.display = hasChanged ? '' : 'none';
                    }
                  }
                }
              } else { errors++; }
            } catch (_) { errors++; }
            statusEl.textContent = done + ' / ' + toRename.length + (errors ? ', ' + errors + ' Fehler' : '');
          }

          applyBtn.disabled = false;
          applyBtn.textContent = '✓ Ausgewählte umbenennen';
          statusEl.textContent = '✓ ' + done + ' umbenannt' + (errors ? ', ' + errors + ' Fehler' : '');
        });

      } catch(e) {
        statusEl.textContent = 'Fehler: ' + e.message;
      }
      loadBtn.disabled = false;
    });

    // Export Konfiguration
    ov.querySelector('#io-exp').addEventListener('click', () => dl(cfg, 'lss_callsign_config.json'));
    // Export Gebäude
    ov.querySelector('#io-exp-b').addEventListener('click', () => dl(buildingProps, 'lss_callsign_buildings.json'));

    // Reset
    ov.querySelector('#io-rst').addEventListener('click', () => {
      if (!confirm('Konfiguration auf Standard zurücksetzen?')) return;
      cfg = { schemas: { ...DEFAULT_SCHEMAS }, org: JSON.parse(JSON.stringify(DEFAULT_ORG)), kz: JSON.parse(JSON.stringify(DEFAULT_KZ)), orgLabels: JSON.parse(JSON.stringify(DEFAULT_ORG_LABELS)), aliases: {}, ils: {} };
      saveConfig(cfg);
      ov.querySelector('#sc-tbl').innerHTML = buildSchemaTable();
      ov.querySelector('#kz-tbl').innerHTML = buildKzTable();
      ov.querySelector('#org-tbl').innerHTML = buildOrgTable();
      ov.querySelector('#ol-tbl').innerHTML = buildOrgLabelsTable();
      ov.querySelector('#alias-tbl').innerHTML = buildAliasTable();
      ov.querySelector('#ils-tbl').innerHTML = buildILSTable();
      bindSchemaEvents(ov); bindKzEvents(ov); bindOrgEvents(ov); bindOrgLabelsEvents(ov); bindAliasEvents(ov); bindILSEvents(ov);
      initKzTypSelect(ov); initAliasTypSelect(ov); initILSBuildingSelect(ov);
    });

    // Import Konfiguration
    ov.querySelector('#io-imp').addEventListener('click', () => {
      const fb = ov.querySelector('#io-fb');
      try {
        const p = JSON.parse(ov.querySelector('#io-ta').value);
        if (!p.schemas || !p.org || !p.kz) throw new Error('Fehlende Schlüssel.');
        if (!p.orgLabels) p.orgLabels = JSON.parse(JSON.stringify(DEFAULT_ORG_LABELS));
        if (!p.aliases) p.aliases = {};
        if (!p.ils) p.ils = {};
        cfg = p; saveConfig(cfg);
        ov.querySelector('#sc-tbl').innerHTML = buildSchemaTable();
        ov.querySelector('#kz-tbl').innerHTML = buildKzTable();
        ov.querySelector('#org-tbl').innerHTML = buildOrgTable();
        ov.querySelector('#ol-tbl').innerHTML = buildOrgLabelsTable();
        ov.querySelector('#alias-tbl').innerHTML = buildAliasTable();
        ov.querySelector('#ils-tbl').innerHTML = buildILSTable();
        bindSchemaEvents(ov); bindKzEvents(ov); bindOrgEvents(ov); bindOrgLabelsEvents(ov); bindAliasEvents(ov); bindILSEvents(ov);
        initKzTypSelect(ov); initAliasTypSelect(ov); initILSBuildingSelect(ov);
        fb.innerHTML = '<div class="lss-note lss-note-ok">✓ Import erfolgreich.</div>';
      } catch (e) {
        fb.innerHTML = `<div class="lss-note lss-note-err">✕ ${esc(e.message)}</div>`;
      }
    });

    // Import Gebäude
    ov.querySelector('#io-imp-b').addEventListener('click', () => {
      const fb = ov.querySelector('#io-fb');
      try {
        buildingProps = JSON.parse(ov.querySelector('#io-ta').value);
        saveBuildingProps(buildingProps);
        ov.querySelector('#buildings-tbl').innerHTML = buildBuildingsTable();
        bindBuildingsEvents(ov);
        fb.innerHTML = '<div class="lss-note lss-note-ok">✓ Gebäude-Eigenschaften importiert.</div>';
      } catch (e) {
        fb.innerHTML = `<div class="lss-note lss-note-err">✕ ${esc(e.message)}</div>`;
      }
    });
  }

  // ─── Tabellen ─────────────────────────────────────────────────────────────

  function buildSchemaTable() {
    const rows = Object.entries(cfg.schemas).map(([key, schema]) =>
      `<tr data-key="${esc(key)}">
        <td><code>${esc(key)}</code></td>
        <td><input class="sc-v" type="text" value="${esc(schema)}" style="width:100%;min-width:250px;font-family:monospace;"></td>
        <td><button class="lss-btn lss-btn-del sc-d" style="padding:3px 9px;">✕</button></td>
      </tr>`
    );
    if (!rows.length) return '<p style="color:#888;font-size:13px;">Keine Schemas.</p>';
    return `<table class="lss-tbl"><thead><tr>
      <th style="min-width:130px;">Schlüssel (BL/Dienst)</th><th>Schema</th><th></th>
    </tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function bindSchemaEvents(ov) {
    ov.querySelectorAll('#sc-tbl .sc-d').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.closest('tr').dataset.key;
        if (key === '*/*' && !confirm('Den globalen Fallback löschen?')) return;
        delete cfg.schemas[key];
        saveConfig(cfg);
        ov.querySelector('#sc-tbl').innerHTML = buildSchemaTable();
        bindSchemaEvents(ov);
      });
    });
    ov.querySelectorAll('#sc-tbl .sc-v').forEach(inp => {
      inp.addEventListener('change', () => {
        cfg.schemas[inp.closest('tr').dataset.key] = inp.value.trim();
        saveConfig(cfg);
      });
    });

    // Chips auch für Tabellen-Inputs: letztes fokussiertes sc-v merken
    let _lastScV = null;
    ov.addEventListener('focusin', e => {
      if (e.target.matches('#sc-tbl .sc-v') || e.target.matches('#sc-val')) {
        _lastScV = e.target;
      }
    });
    ov.querySelectorAll('.lss-ph-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const inp = _lastScV || ov.querySelector('#sc-val');
        if (!inp) return;
        const ph = chip.dataset.ph;
        const start = inp.selectionStart ?? inp.value.length;
        const end = inp.selectionEnd ?? inp.value.length;
        inp.value = inp.value.slice(0, start) + ph + inp.value.slice(end);
        const pos = start + ph.length;
        inp.focus();
        inp.setSelectionRange(pos, pos);
        if (inp.matches('#sc-tbl .sc-v')) {
          cfg.schemas[inp.closest('tr').dataset.key] = inp.value.trim();
          saveConfig(cfg);
        }
      });
    });
  }

  function buildKzTable() {
    let cat = {};
    try { cat = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}'); } catch (_) {}
    const typLabel = id => {
      const e = cat[id] ?? cat[String(id)];
      return e ? (typeof e === 'string' ? e : (e.caption || e.name || id)) : id;
    };

    if (!Object.keys(cfg.kz).length)
      return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';

    // Filter-Input + Accordion-Gruppen
    const groups = Object.entries(cfg.kz).map(([bl, types]) => {
      const blLabel = bl === '*' ? '* (global)' : `${bl} – ${BUNDESLAENDER[bl]||bl}`;
      const count = Object.keys(types).length;
      const rows = Object.entries(types).map(([typ, val]) => `
        <tr class="kz-row" data-bl="${esc(bl)}" data-typ="${esc(typ)}"
            data-search="${esc(typLabel(typ).toLowerCase())} ${esc(val.toLowerCase())} ${esc(blLabel.toLowerCase())}">
          <td style="font-size:12px;color:#667;">${esc(typLabel(typ))}
            <span style="color:#aaa;font-size:10px;">(${esc(typ)})</span>
          </td>
          <td><input class="kz-v" type="text" value="${esc(val)}"
               style="width:72px;border:1px solid #c5cad8;border-radius:5px;padding:3px 7px;font-size:12px;"></td>
          <td><button class="lss-btn lss-btn-del kz-d" style="padding:2px 8px;font-size:12px;">✕</button></td>
        </tr>`).join('');
      return `
        <div class="kz-group" data-bl="${esc(bl)}">
          <div class="kz-group-hdr" data-bl="${esc(bl)}">
            <span class="kz-group-arrow">▶</span>
            <strong>${esc(blLabel)}</strong>
            <span class="kz-group-count">${count}</span>
          </div>
          <table class="lss-tbl kz-group-body" style="display:none;">
            <thead><tr>
              <th>Fahrzeugtyp</th><th style="width:80px;">2. TKZ</th><th style="width:36px;"></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');

    return `
      <div style="margin-bottom:8px;">
        <input id="kz-filter" type="text" placeholder="🔍 Filter: Typname, Kennzahl, Bundesland …"
          style="width:100%;box-sizing:border-box;border:1px solid #c5cad8;border-radius:6px;
                 padding:6px 10px;font-size:13px;">
      </div>
      <div id="kz-accordion">${groups}</div>`;
  }

  function bindKzEvents(ov) {
    const wrap = ov.querySelector('#kz-tbl');
    if (!wrap) return;

    // Accordion: Gruppe auf-/zuklappen
    wrap.querySelectorAll('.kz-group-hdr').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const body = hdr.nextElementSibling;
        const arrow = hdr.querySelector('.kz-group-arrow');
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'table';
        arrow.textContent = open ? '▶' : '▼';
        arrow.style.color = open ? '' : '#1d5f9e';
        hdr.style.background = open ? '' : '#f0f5fb';
      });
    });

    // Filter
    const filterInp = wrap.querySelector('#kz-filter');
    if (filterInp) {
      filterInp.addEventListener('input', () => {
        const q = filterInp.value.toLowerCase().trim();
        wrap.querySelectorAll('.kz-group').forEach(grp => {
          let anyVisible = false;
          grp.querySelectorAll('.kz-row').forEach(row => {
            const match = !q || row.dataset.search.includes(q);
            row.style.display = match ? '' : 'none';
            if (match) anyVisible = true;
          });
          // Gruppe anzeigen/verstecken
          grp.style.display = anyVisible || !q ? '' : 'none';
          // Bei aktivem Filter: alle passenden Gruppen aufklappen
          if (q && anyVisible) {
            const body = grp.querySelector('.kz-group-body');
            const arrow = grp.querySelector('.kz-group-arrow');
            if (body) body.style.display = 'table';
            if (arrow) { arrow.textContent = '▼'; arrow.style.color = '#1d5f9e'; }
            grp.querySelector('.kz-group-hdr').style.background = '#f0f5fb';
          }
        });
      });
    }

    // Löschen
    wrap.querySelectorAll('.kz-d').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = btn.closest('tr');
        delete cfg.kz[r.dataset.bl][r.dataset.typ];
        if (!Object.keys(cfg.kz[r.dataset.bl]).length) delete cfg.kz[r.dataset.bl];
        saveConfig(cfg);
        ov.querySelector('#kz-tbl').innerHTML = buildKzTable();
        bindKzEvents(ov);
        initKzTypSelect(ov);
      });
    });

    // Kennzahl bearbeiten
    wrap.querySelectorAll('.kz-v').forEach(inp => {
      inp.addEventListener('change', () => {
        const r = inp.closest('tr');
        cfg.kz[r.dataset.bl][r.dataset.typ] = inp.value.trim();
        saveConfig(cfg);
      });
    });
  }

  function buildOrgTable() {
    const dienstOpts = DIENSTE.map(d => `<option value="${d}">${d}</option>`).join('');
    const rows = Object.entries(cfg.org).map(([kw, entry]) => {
      const dienst = entry.dienst || entry.key || '';
      const name = entry.name || '';
      const opts = DIENSTE.map(d =>
        `<option value="${d}"${d === dienst ? ' selected' : ''}>${d}</option>`
      ).join('');
      return `<tr data-kw="${esc(kw)}">
        <td><strong>${esc(kw)}</strong></td>
        <td><select class="org-d-sel">${opts}</select></td>
        <td><input class="org-n" type="text" value="${esc(name)}"></td>
        <td><button class="lss-btn lss-btn-del org-d" style="padding:3px 9px;">✕</button></td>
      </tr>`;
    });
    if (!rows.length) return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';
    return `<table class="lss-tbl"><thead><tr>
      <th>Schlüsselwort</th><th>Dienst</th><th>Anzeigename ({org})</th><th></th>
    </tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function bindOrgEvents(ov) {
    ov.querySelectorAll('#org-tbl .org-d').forEach(btn => {
      btn.addEventListener('click', () => {
        delete cfg.org[btn.closest('tr').dataset.kw];
        saveConfig(cfg);
        ov.querySelector('#org-tbl').innerHTML = buildOrgTable();
        bindOrgEvents(ov);
      });
    });
    ov.querySelectorAll('#org-tbl .org-d-sel, #org-tbl .org-n').forEach(inp => {
      inp.addEventListener('change', () => {
        const r = inp.closest('tr');
        cfg.org[r.dataset.kw] = {
          dienst: r.querySelector('.org-d-sel').value,
          name: r.querySelector('.org-n').value.trim(),
        };
        saveConfig(cfg);
      });
    });
  }

  function buildOrgLabelsTable() {
    if (!cfg.orgLabels.length) return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';
    const rows = cfg.orgLabels.map((o, i) =>
      `<tr data-idx="${i}">
        <td><input class="ol-lbl" type="text" value="${esc(o.label)}"></td>
        <td><input class="ol-val" type="text" value="${esc(o.value)}" style="max-width:140px;"></td>
        <td><button class="lss-btn lss-btn-del ol-d" style="padding:3px 9px;">✕</button></td>
      </tr>`
    ).join('');
    return `<table class="lss-tbl"><thead><tr>
      <th>Label (Anzeige)</th><th>Funkkennung ({org})</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function bindOrgLabelsEvents(ov) {
    ov.querySelectorAll('#ol-tbl .ol-d').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.closest('tr').dataset.idx);
        cfg.orgLabels.splice(idx, 1);
        saveConfig(cfg);
        ov.querySelector('#ol-tbl').innerHTML = buildOrgLabelsTable();
        bindOrgLabelsEvents(ov);
      });
    });
    ov.querySelectorAll('#ol-tbl .ol-lbl, #ol-tbl .ol-val').forEach(inp => {
      inp.addEventListener('change', () => {
        const r = inp.closest('tr');
        const idx = Number(r.dataset.idx);
        cfg.orgLabels[idx] = {
          label: r.querySelector('.ol-lbl').value.trim(),
          value: r.querySelector('.ol-val').value.trim(),
        };
        saveConfig(cfg);
      });
    });
  }

  function buildILSTable() {
    const entries = Object.entries(cfg.ils || {});
    if (!entries.length) return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';
    const rows = entries.map(([id, name]) =>
      `<tr data-id="${esc(id)}">
        <td style="font-size:12px;">Leitstelle <code>${esc(id)}</code></td>
        <td><input class="ils-v" type="text" value="${esc(name)}" style="width:140px;border:1px solid #c5cad8;border-radius:5px;padding:3px 7px;font-size:13px;"></td>
        <td><button class="lss-btn lss-btn-del ils-d" style="padding:3px 9px;">✕</button></td>
      </tr>`
    ).join('');
    return `<table class="lss-tbl"><thead><tr>
      <th>Leitstelle (Building-ID)</th><th>Bereichsname</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function bindILSEvents(ov) {
    ov.querySelectorAll('#ils-tbl .ils-d').forEach(btn => {
      btn.addEventListener('click', () => {
        delete cfg.ils[btn.closest('tr').dataset.id];
        saveConfig(cfg);
        ov.querySelector('#ils-tbl').innerHTML = buildILSTable();
        bindILSEvents(ov);
      });
    });
    ov.querySelectorAll('#ils-tbl .ils-v').forEach(inp => {
      inp.addEventListener('change', () => {
        cfg.ils[inp.closest('tr').dataset.id] = inp.value.trim();
        saveConfig(cfg);
      });
    });
  }

  function initILSBuildingSelect(ov) {
    const cont = ov.querySelector('#ils-building-container');
    if (!cont) return;
    cont.innerHTML = '<span style="font-size:12px;color:#888;">Lade Leitstellen …</span>';
    // Leitstellen direkt aus API laden
    apiFetch('/api/buildings').then(buildings => {
      const leitstellen = Array.isArray(buildings)
        ? buildings.filter(b => b.building_type === 7)
        : [];
      const opts = leitstellen
        .map(b => ({ value: String(b.id), label: (b.caption || b.id) + ' (' + b.id + ')' }))
        .sort((a, b) => a.label.localeCompare(b.label, 'de'));
      cont.innerHTML = '';
      if (!opts.length) {
        cont.innerHTML = '<span style="font-size:12px;color:#888;">Keine Leitstellen gefunden</span>';
        return;
      }
      const prevVal = cont.dataset.selectedValue || '';
      const ss = makeSearchableSelect(cont, 'ils-building', opts, prevVal, '— Leitstelle wählen —');
      cont.dataset.selectedValue = prevVal;
      ss.addEventListener('ss-change', e => { cont.dataset.selectedValue = e.detail.value; });
    }).catch(() => {
      cont.innerHTML = '<span style="font-size:12px;color:#c00;">Fehler beim Laden</span>';
    });
  }

  function buildAliasTable() {
    let cat = {};
    try { cat = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}'); } catch(_) {}
    const typLabel = id => {
      const e = cat[id] ?? cat[String(id)];
      return e ? (typeof e === 'string' ? e : (e.caption || e.name || id)) : id;
    };
    const entries = Object.entries(cfg.aliases || {});
    if (!entries.length) return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';
    const rows = entries.map(([id, alias]) =>
      `<tr data-id="${esc(id)}">
        <td style="font-size:12px;">${esc(typLabel(id))} <span style="color:#aaa;font-size:10px;">(${esc(id)})</span></td>
        <td><input class="alias-v" type="text" value="${esc(alias)}" style="width:120px;border:1px solid #c5cad8;border-radius:5px;padding:3px 7px;font-size:13px;"></td>
        <td><button class="lss-btn lss-btn-del alias-d" style="padding:3px 9px;">✕</button></td>
      </tr>`
    ).join('');
    return `<table class="lss-tbl"><thead><tr>
      <th>Fahrzeugtyp</th><th>Alias</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function bindAliasEvents(ov) {
    ov.querySelectorAll('#alias-tbl .alias-d').forEach(btn => {
      btn.addEventListener('click', () => {
        delete cfg.aliases[btn.closest('tr').dataset.id];
        saveConfig(cfg);
        ov.querySelector('#alias-tbl').innerHTML = buildAliasTable();
        bindAliasEvents(ov);
      });
    });
    ov.querySelectorAll('#alias-tbl .alias-v').forEach(inp => {
      inp.addEventListener('change', () => {
        cfg.aliases[inp.closest('tr').dataset.id] = inp.value.trim();
        saveConfig(cfg);
      });
    });
  }

  function buildBuildingsTable() {
    const entries = Object.entries(buildingProps);
    if (!entries.length) return '<p style="color:#888;font-size:13px;">Keine Gebäude-Eigenschaften gespeichert.</p>';
    const rows = entries.map(([bid, props]) =>
      `<tr data-bid="${esc(bid)}">
        <td style="font-size:12px;">${esc(bid)}</td>
        <td><select class="bp-org">
          <option value="">— keine —</option>
          ${cfg.orgLabels.map(o =>
            `<option value="${esc(o.value)}"${(props.org||'') === o.value ? ' selected' : ''}>${esc(o.label)} (${esc(o.value)})</option>`
          ).join('')}
        </select></td>
        <td><input class="bp-ort" type="text" value="${esc(props.ort||'')}" placeholder="Ort-Override"></td>
        <td><input class="bp-st" type="text" value="${esc(props.standort||'')}" placeholder="Standort" style="max-width:80px;"></td>
        <td><button class="lss-btn lss-btn-ok bp-save" style="padding:3px 9px;">✓</button>
            <button class="lss-btn lss-btn-del bp-del" style="padding:3px 9px;margin-left:4px;">✕</button></td>
      </tr>`
    );
    return `<table class="lss-tbl"><thead><tr>
      <th>Gebäude-ID</th><th>Org-Override</th><th>Ort-Override</th><th>1. TKZ</th><th></th>
    </tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  function bindBuildingsEvents(ov) {
    ov.querySelectorAll('#buildings-tbl .bp-save').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = btn.closest('tr');
        const bid = r.dataset.bid;
        buildingProps[bid] = {
          org: r.querySelector('.bp-org').value.trim(),
          ort: r.querySelector('.bp-ort').value.trim(),
          standort: r.querySelector('.bp-st').value.trim(),
        };
        saveBuildingProps(buildingProps);
        btn.textContent = '✓ Gespeichert';
        setTimeout(() => btn.textContent = '✓', 1200);
      });
    });
    ov.querySelectorAll('#buildings-tbl .bp-del').forEach(btn => {
      btn.addEventListener('click', () => {
        delete buildingProps[btn.closest('tr').dataset.bid];
        saveBuildingProps(buildingProps);
        ov.querySelector('#buildings-tbl').innerHTML = buildBuildingsTable();
        bindBuildingsEvents(ov);
      });
    });
  }

  // ─── Hilfsfunction Download ───────────────────────────────────────────────
  function dl(data, filename) {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:'application/json'})),
      download: filename,
    });
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════════════════

  GM_addStyle(`
    /* ── Suggest-Box ── */
    #lss-suggest-box {
      background:#fff;border:1px solid #d0dff0;border-radius:10px;
      margin:6px 0 4px;overflow:hidden;
      font-family:system-ui,-apple-system,sans-serif;font-size:13px;
      box-shadow:0 2px 8px rgba(29,95,158,.08);
      display:block;width:100%;box-sizing:border-box;
    }
    .lss-sb-header {
      display:flex;align-items:center;gap:8px;
      background:linear-gradient(135deg,#1d5f9e 0%,#2278c8 100%);
      padding:9px 14px;color:#fff;
    }
    .lss-sb-icon { font-size:15px;line-height:1; }
    .lss-sb-title { font-weight:600;font-size:13px;flex:1; }
    .lss-sb-meta { display:flex;gap:5px;align-items:center;flex-wrap:wrap; }
    .lss-sb-tag {
      background:rgba(255,255,255,.18);color:#fff;
      padding:2px 8px;border-radius:12px;font-size:11px;font-weight:500;
    }
    .lss-sb-tag-schema {
      background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.3);
      font-family:monospace;cursor:help;
    }
    .lss-sb-body { padding:12px 14px 14px; }
    .lss-sb-suggestion { margin-bottom:12px; }
    .lss-chips { display:flex;flex-wrap:wrap;gap:6px; }
    .lss-chip {
      padding:6px 18px;background:#f0f6ff;border:1.5px solid #7ab0e0;
      border-radius:24px;cursor:pointer;font-size:14px;font-weight:600;
      color:#1a4d7a;letter-spacing:.01em;
      transition:all .15s;user-select:none;
    }
    .lss-chip:hover {
      background:#1d5f9e;color:#fff;border-color:#1d5f9e;
      transform:translateY(-1px);box-shadow:0 3px 8px rgba(29,95,158,.25);
    }
    .lss-chip-ok { background:#28a745!important;color:#fff!important;border-color:#28a745!important; }
    .lss-chip-warn { font-size:12px;color:#a00;padding:4px 0;display:block; }
    .lss-chip-warn a { color:#1d5f9e; }


    #lss-modal-overlay {
      position:fixed;inset:0;background:rgba(0,0,0,.52);
      z-index:99999;display:flex;align-items:center;justify-content:center;
    }
    #lss-modal {
      background:#fff;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.28);
      width:900px;max-width:96vw;max-height:90vh;
      display:flex;flex-direction:column;overflow:hidden;
      font-family:system-ui,-apple-system,sans-serif;font-size:14px;
    }
    #lss-modal-hdr {
      padding:12px 18px;background:#1d5f9e;color:#fff;
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
    }
    #lss-modal-hdr h2 { margin:0;font-size:15px;font-weight:600; }
    #lss-modal-hdr button { background:none;border:none;color:#fff;font-size:20px;cursor:pointer; }
    #lss-modal-bdy { padding:16px 18px;overflow-y:auto;flex:1; }

    .lss-tabs { display:flex;gap:3px;border-bottom:2px solid #dde;margin-bottom:14px;flex-wrap:wrap; }
    .lss-tab {
      padding:7px 13px;cursor:pointer;border:none;background:none;
      font-size:13px;color:#555;border-bottom:2px solid transparent;margin-bottom:-2px;
    }
    .lss-tab.active { color:#1d5f9e;border-bottom-color:#1d5f9e;font-weight:600; }
    .lss-tp { display:none; } .lss-tp.active { display:block; }

    .lss-tbl { width:100%;border-collapse:collapse;font-size:13px; }
    .lss-tbl th {
      background:#eef2fa;text-align:left;padding:7px 10px;
      border-bottom:2px solid #ccd6ea;font-weight:600;color:#334;
    }
    .lss-tbl td { padding:5px 9px;border-bottom:1px solid #eaecf0;vertical-align:middle; }
    .lss-tbl tr:hover td { background:#f7f9fc; }
    .lss-tbl input {
      border:1px solid #c5cad8;border-radius:5px;padding:3px 7px;
      font-size:13px;width:100%;box-sizing:border-box;
    }

    .lss-btn {
      display:inline-flex;align-items:center;padding:6px 13px;
      border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500;
      white-space:nowrap;
    }
    .lss-btn+.lss-btn { margin-left:6px; }
    .lss-btn-ok { background:#28a745;color:#fff; } .lss-btn-ok:hover { background:#1e863a; }
    .lss-btn-del { background:#dc3545;color:#fff; } .lss-btn-del:hover { background:#b82b38; }
    .lss-btn-blue { background:#1d5f9e;color:#fff; } .lss-btn-blue:hover { background:#154a7c; }
    .lss-btn-gray { background:#e2e6ed;color:#333; } .lss-btn-gray:hover { background:#cdd2db; }

    .lss-row { display:flex;gap:8px;margin-bottom:10px;align-items:flex-end;flex-wrap:wrap; }
    .lss-row label { font-size:12px;color:#556;display:block;margin-bottom:3px; }
    .lss-row input, .lss-row select {
      border:1px solid #c5cad8;border-radius:5px;padding:5px 8px;font-size:13px;
    }
    .bulk-db {
      padding:3px 10px;font-size:12px;border:1px solid #c5cad8;border-radius:20px;
      background:#fff;color:#556;cursor:pointer;transition:all .12s;
    }
    .bulk-db:hover { border-color:#1d5f9e;color:#1d5f9e; }
    .bulk-db-active { background:#1d5f9e;color:#fff;border-color:#1d5f9e;font-weight:500; }

    .lss-ph-chips { display:flex;flex-wrap:wrap;gap:5px;margin-top:2px; }
    .lss-ph-chip {
      background:#d4e8f8;color:#1d4f7a;border:1px solid #9ac4e0;
      border-radius:5px;padding:3px 9px;font-size:12px;font-family:monospace;
      cursor:pointer;user-select:none;transition:background .1s,transform .1s;
    }
    .lss-ph-chip:hover { background:#1d5f9e;color:#fff;border-color:#1d5f9e;transform:translateY(-1px); }
    .lss-ph-chip:active { transform:translateY(0); }

    .lss-ss-wrap { position:relative;display:inline-block; }
    .lss-ss-display {
      min-width:220px;border:1px solid #c5cad8;border-radius:6px;
      padding:5px 28px 5px 10px;font-size:13px;cursor:pointer;background:#fff;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      user-select:none;position:relative;
    }
    .lss-ss-display::after {
      content:'▾';position:absolute;right:8px;top:50%;transform:translateY(-50%);
      color:#888;font-size:12px;pointer-events:none;
    }
    .lss-ss-dropdown {
      position:absolute;top:100%;left:0;z-index:9999;
      background:#fff;border:1px solid #c5cad8;border-radius:6px;
      box-shadow:0 4px 16px rgba(0,0,0,.12);min-width:260px;
      margin-top:2px;overflow:hidden;
    }
    .lss-ss-search {
      width:100%;box-sizing:border-box;padding:7px 10px;
      border:none;border-bottom:1px solid #eee;font-size:13px;outline:none;
    }
    .lss-ss-list { max-height:220px;overflow-y:auto; }
    .lss-ss-item {
      padding:6px 12px;font-size:13px;cursor:pointer;
    }
    .lss-ss-item:hover { background:#f0f5ff; }
    .lss-ss-selected { background:#e8f0fa;font-weight:500; }
    .lss-ss-empty { padding:8px 12px;color:#aaa;font-size:13px; }

    .kz-group { margin-bottom:3px; }
    .kz-group-hdr {
      display:flex;align-items:center;gap:8px;
      padding:7px 10px;background:#f4f6fa;border:1px solid #dde3ee;
      border-radius:6px;cursor:pointer;user-select:none;
      font-size:13px;transition:background .12s;
    }
    .kz-group-hdr:hover { background:#e8edf7; }
    .kz-group-arrow { font-size:10px;color:#888;transition:color .12s; }
    .kz-group-count {
      margin-left:auto;background:#e2e8f4;color:#446;
      padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;
    }
    .kz-group-body { margin-top:0;border-top:none;border-radius:0 0 6px 6px; }
    .kz-group-body td { padding:4px 9px;font-size:12px; }

    .lss-note {
      padding:9px 12px;border-radius:6px;font-size:13px;margin-bottom:12px;
      background:#e8f3fb;border:1px solid #9ad0f0;color:#1a5f7a;line-height:1.6;
    }
    .lss-note-ok { background:#e6f9ee;border-color:#8ed8aa;color:#1a6635; }
    .lss-note-err { background:#fdecea;border-color:#f5a0a0;color:#7a1a1a; }


    /* ── Gebäude-Eigenschaften Box ── */
    #lss-building-props-box {
      background:#f5f0ff;border:1px solid #c8b4ee;border-radius:8px;
      padding:12px 14px;margin:0 0 16px;
      font-family:system-ui,-apple-system,sans-serif;font-size:13px;
    }
    #lss-building-props-box h4 {
      margin:0 0 6px;font-size:13px;font-weight:600;color:#4a1d96;
    }
    .lss-bp-hint { margin:0 0 10px;font-size:12px;color:#665;line-height:1.5; }
    .lss-bp-fields {
      display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;
    }
    .lss-bp-fields label {
      display:flex;flex-direction:column;gap:3px;font-size:12px;color:#445;
    }
    .lss-bp-fields label span { font-weight:500; }
    .lss-bp-fields label small { font-weight:400;color:#888; }
    .lss-bp-inp {
      border:1px solid #c5b4e0;border-radius:5px;padding:5px 8px;
      font-size:13px;width:180px;box-sizing:border-box;
      background:#fff;
    }
    .lss-bp-inp:focus { outline:none;border-color:#7c3aed;box-shadow:0 0 0 2px #7c3aed25; }
    .lss-bp-actions { display:flex;align-items:center;flex-wrap:wrap;gap:6px; }

    #lss-profile-menu-entry a {
      display:flex;align-items:center;gap:6px;
    }
  `);

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // GEBÄUDE-ÜBERSICHT: neuer Tab "Funkrufnamen"
  // ═══════════════════════════════════════════════════════════════════════════

  async function handleBuildingTab(doc, buildingId) {
    if (doc.getElementById('lss-tab-link')) return;

    const navTabs = doc.querySelector('.nav-tabs');
    const tabContent = doc.querySelector('.tab-content');
    if (!navTabs || !tabContent) return;

    // Bundesland + Props laden
    const bl = await getBundesland(buildingId);
    const ortCoords = await getOrt(buildingId);
    const props = buildingProps[buildingId] || {};
    const blText = bl ? (bl + ' · ' + (BUNDESLAENDER[bl] || bl)) : 'Bundesland nicht erkannt';
    // Dienst aus building_type ermitteln (für Org-Feld)
    const building = await getBuilding(buildingId);
    const bl_dienst = building?.building_type != null
      ? BUILDING_TYPE_DIENST[building.building_type] || null
      : null;

    // ── „Alle umbenennen"-Button im Fahrzeuge-Tab ─────────────────────────────
    const vehicleTabPane = doc.getElementById('tab_vehicles') || doc.querySelector('.tab-pane.active');
    if (vehicleTabPane) {
      const bulkBtn = doc.createElement('button');
      bulkBtn.type = 'button';
      bulkBtn.id = 'lss-bulk-btn';
      bulkBtn.textContent = '📻 Alle umbenennen';
      bulkBtn.style.cssText = `
        background:linear-gradient(135deg,#1d5f9e,#2278c8);color:#fff;
        border:none;border-radius:6px;padding:6px 14px;font-size:13px;
        font-weight:500;cursor:pointer;margin:10px 0 4px;
        box-shadow:0 2px 6px rgba(29,95,158,.25);
      `;
      bulkBtn.addEventListener('click', () => openBulkRenameModal(doc, buildingId));
      vehicleTabPane.insertAdjacentElement('afterbegin', bulkBtn);
    }

    // ── Tab-Link ──────────────────────────────────────────────────────────────
    const li = doc.createElement('li');
    li.innerHTML = '<a id="lss-tab-link" href="#lss-tab-pane" data-toggle="tab">📻 Funkrufnamen</a>';
    navTabs.appendChild(li);

    // ── Tab-Pane ──────────────────────────────────────────────────────────────
    const pane = doc.createElement('div');
    pane.id = 'lss-tab-pane';
    pane.className = 'tab-pane';
    pane.style.cssText = 'padding:20px;';

    // Titel
    const title = doc.createElement('h4');
    title.style.cssText = 'margin:0 0 4px;font-size:14px;font-weight:600;color:#1d4f7a;';
    title.textContent = '📻 Gebäude-Eigenschaften für Funkrufnamen';
    pane.appendChild(title);

    const sub = doc.createElement('p');
    sub.style.cssText = 'font-size:12px;color:#667;margin:0 0 16px;';
    sub.innerHTML = 'Bundesland: <strong>' + esc(blText) + '</strong>'
      + (ortCoords ? ' &nbsp;·&nbsp; Ort (Koordinaten): <strong>' + esc(ortCoords) + '</strong>' : '');
    pane.appendChild(sub);

    // Felder
    const fieldDefs = [
      { field: 'org', label: 'Organisation', hint: 'Platzhalter {org}', type: 'select' },
      { field: 'ort', label: 'Ortsname', hint: 'Platzhalter {ort}', type: 'text', placeholder: 'z.B. Ulm' },
      { field: 'standort', label: '1. TKZ', hint: 'Platzhalter {standort}', type: 'text', placeholder: 'z.B. 1' },
    ];

    const grid = doc.createElement('div');
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:16px;margin-bottom:16px;';

    const inputs = {};
    for (const def of fieldDefs) {
      const wrap = doc.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

      const lbl = doc.createElement('label');
      lbl.style.cssText = 'font-size:11px;font-weight:700;color:#667;text-transform:uppercase;letter-spacing:.04em;';
      lbl.textContent = def.label + ' ';
      const small = doc.createElement('small');
      small.style.cssText = 'font-weight:400;color:#999;text-transform:none;';
      small.textContent = '(' + def.hint + ')';
      lbl.appendChild(small);
      wrap.appendChild(lbl);

      let inp;
      if (def.type === 'select') {
        // Nur bei Rettung: Dropdown; sonst: readonly mit festem Wert
        if (bl_dienst && bl_dienst !== 'Rettung' && bl_dienst in DIENST_ORG_DEFAULT) {
          inp = doc.createElement('input');
          inp.type = 'text';
          inp.readOnly = true;
          inp.value = DIENST_ORG_DEFAULT[bl_dienst];
          inp.style.cssText = 'border:1px solid #e0e0e0;border-radius:6px;padding:6px 10px;font-size:13px;width:200px;background:#f5f5f5;color:#888;cursor:not-allowed;';
          inp.title = 'Fest für diesen Diensttyp';
        } else {
          inp = doc.createElement('select');
          inp.style.cssText = 'border:1px solid #c5cad8;border-radius:6px;padding:6px 10px;font-size:13px;min-width:200px;background:#fff;';
          const emptyOpt = doc.createElement('option');
          emptyOpt.value = ''; emptyOpt.textContent = '— keine Auswahl —';
          inp.appendChild(emptyOpt);
          for (const o of cfg.orgLabels) {
            const opt = doc.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label + ' (' + o.value + ')';
            if (o.value === (props.org || '')) opt.selected = true;
            inp.appendChild(opt);
          }
        }
      } else {
        inp = doc.createElement('input');
        inp.type = 'text';
        inp.placeholder = def.placeholder || '';
        inp.value = props[def.field] || '';
        inp.style.cssText = 'border:1px solid #c5cad8;border-radius:6px;padding:6px 10px;font-size:13px;width:180px;background:#fff;';
        if (def.field === 'standort') inp.style.width = '100px';
      }
      inp.dataset.field = def.field;
      inputs[def.field] = inp;
      lbl.htmlFor = 'lss-tab-inp-' + def.field;
      inp.id = 'lss-tab-inp-' + def.field;
      wrap.appendChild(inp);
      grid.appendChild(wrap);
    }
    pane.appendChild(grid);

    // Speichern-Button
    const actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:12px;';

    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '✓ Speichern';
    saveBtn.style.cssText = 'background:#28a745;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:500;cursor:pointer;';
    saveBtn.addEventListener('mouseover', () => saveBtn.style.background = '#1e863a');
    saveBtn.addEventListener('mouseout', () => saveBtn.style.background = '#28a745');

    const savedMsg = doc.createElement('span');
    savedMsg.style.cssText = 'font-size:12px;color:#28a745;display:none;';
    savedMsg.textContent = '✓ Gespeichert';

    saveBtn.addEventListener('click', () => {
      buildingProps[buildingId] = buildingProps[buildingId] || {};
      for (const [field, el] of Object.entries(inputs)) {
        buildingProps[buildingId][field] = el.value.trim();
      }
      saveBuildingProps(buildingProps);
      savedMsg.style.display = 'inline';
      setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
    });

    actions.appendChild(saveBtn);
    actions.appendChild(savedMsg);
    pane.appendChild(actions);
    tabContent.appendChild(pane);

    // Tab-Klick aktivieren (Bootstrap data-toggle="tab" funktioniert nur wenn
    // Bootstrap im iframe-Kontext geladen ist — sicherheitshalber manuell)
    li.querySelector('a').addEventListener('click', e => {
      e.preventDefault();
      // Alle Tabs deaktivieren
      doc.querySelectorAll('.nav-tabs li').forEach(l => l.classList.remove('active'));
      doc.querySelectorAll('.tab-content .tab-pane').forEach(p => p.classList.remove('active'));
      // Diesen aktivieren
      li.classList.add('active');
      pane.classList.add('active');
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // BULK-RENAME MODAL
  // ═══════════════════════════════════════════════════════════════════════════

  async function openBulkRenameModal(doc, buildingId) {
    if (doc.getElementById('lss-bulk-overlay')) return;

    // Alle nötigen Daten laden
    const [vehicles, building, bl, ortCoords] = await Promise.all([
      getBuildingVehicles(buildingId),
      getBuilding(buildingId),
      getBundesland(buildingId),
      getOrt(buildingId),
    ]);

    const dienst = building?.building_type != null
      ? BUILDING_TYPE_DIENST[building.building_type] || null : null;
    const props = buildingProps[buildingId] || {};
    const buildingCap = building?.caption || '';

    // Vorschläge für alle Fahrzeuge generieren
    const rows = [];
    for (const v of vehicles.sort((a, b) => Number(a.id) - Number(b.id))) {
      const typeId = v.vehicle_type;
      const typeName = getTypeName(typeId) || String(typeId);
      // Position in nach-ID sortierter Liste gleichen Typs
      const same = vehicles
        .filter(x => String(x.vehicle_type) === String(typeId))
        .sort((a, b) => Number(a.id) - Number(b.id));
      const pos = same.findIndex(x => String(x.id) === String(v.id));
      const startNr = pos >= 0 ? pos + 1 : same.length + 1;
      const suggested = genCallsigns({
        typeId, typeName, bl, buildingId,
        buildingCaption: buildingCap,
        ortFromCoords: ortCoords,
        dienst, startNr, count: 1,
      });
      rows.push({
        id: v.id,
        current: v.caption || '',
        suggested: suggested[0] || '',
        typeName,
      });
    }

    // Overlay bauen
    const overlay = doc.createElement('div');
    overlay.id = 'lss-bulk-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);
      z-index:99999;display:flex;align-items:center;justify-content:center;
      font-family:system-ui,-apple-system,sans-serif;
    `;

    const modal = doc.createElement('div');
    modal.style.cssText = `
      background:#fff;border-radius:10px;width:780px;max-width:96vw;
      max-height:88vh;display:flex;flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,.28);overflow:hidden;
    `;

    // Header
    const hdr = doc.createElement('div');
    hdr.style.cssText = 'background:linear-gradient(135deg,#1d5f9e,#2278c8);color:#fff;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
    hdr.innerHTML = '<strong style="font-size:14px;">📻 Fahrzeuge umbenennen — ' + esc(buildingCap) + '</strong>';
    const closeBtn = doc.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0 4px;';
    closeBtn.addEventListener('click', () => overlay.remove());
    hdr.appendChild(closeBtn);
    modal.appendChild(hdr);

    // Info
    const info = doc.createElement('div');
    info.style.cssText = 'padding:10px 18px;font-size:12px;color:#667;background:#f7f9fc;border-bottom:1px solid #e2eaf4;flex-shrink:0;';
    info.textContent = rows.length + ' Fahrzeuge · Namen sind bearbeitbar · Häkchen = umbenennen';
    modal.appendChild(info);

    // Tabelle
    const tableWrap = doc.createElement('div');
    tableWrap.style.cssText = 'overflow-y:auto;flex:1;padding:0;';

    const table = doc.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
    table.innerHTML = `<thead><tr style="background:#eef2fa;position:sticky;top:0;z-index:1;">
      <th style="padding:8px 12px;text-align:left;width:36px;">
        <input type="checkbox" id="lss-bulk-all" checked title="Alle aus/abwählen">
      </th>
      <th style="padding:8px 12px;text-align:left;color:#334;font-weight:600;">Fahrzeugtyp</th>
      <th style="padding:8px 12px;text-align:left;color:#334;font-weight:600;">Aktueller Name</th>
      <th style="padding:8px 12px;text-align:left;color:#334;font-weight:600;">Neuer Name</th>
    </tr></thead>`;

    const tbody = doc.createElement('tbody');
    const inputMap = {}; // vehicleId → {checkbox, input}

    rows.forEach((row, idx) => {
      const tr = doc.createElement('tr');
      tr.style.cssText = idx % 2 === 0 ? 'background:#fff;' : 'background:#fafbfd;';

      // Checkbox
      const tdCb = doc.createElement('td');
      tdCb.style.cssText = 'padding:6px 12px;';
      const cb = doc.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!row.suggested;
      cb.disabled = !row.suggested;
      tdCb.appendChild(cb);
      tr.appendChild(tdCb);

      // Typname
      const tdTyp = doc.createElement('td');
      tdTyp.style.cssText = 'padding:6px 12px;color:#556;font-size:12px;white-space:nowrap;';
      tdTyp.textContent = row.typeName;
      tr.appendChild(tdTyp);

      // Aktueller Name
      const tdCur = doc.createElement('td');
      tdCur.style.cssText = 'padding:6px 12px;color:#888;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      tdCur.textContent = row.current;
      tdCur.title = row.current;
      tr.appendChild(tdCur);

      // Neuer Name (editierbar)
      const tdNew = doc.createElement('td');
      tdNew.style.cssText = 'padding:4px 8px;';
      const inp = doc.createElement('input');
      inp.type = 'text';
      inp.value = row.suggested || row.current;
      inp.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid #c5cad8;border-radius:5px;padding:4px 8px;font-size:13px;';
      if (!row.suggested) {
        inp.style.background = '#f5f5f5';
        inp.style.color = '#aaa';
        inp.title = 'Kein Schema-Mapping für diesen Typ';
      }
      inp.addEventListener('input', () => {
        cb.checked = inp.value.trim() !== '' && normStr(inp.value) !== normStr(row.current);
      });
      tdNew.appendChild(inp);
      tr.appendChild(tdNew);

      tbody.appendChild(tr);
      inputMap[row.id] = { cb, inp, current: row.current };
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    modal.appendChild(tableWrap);

    // Alle-auswählen Toggle
    table.querySelector('#lss-bulk-all').addEventListener('change', e => {
      Object.values(inputMap).forEach(({ cb }) => { if (!cb.disabled) cb.checked = e.target.checked; });
    });

    // Footer
    const footer = doc.createElement('div');
    footer.style.cssText = 'padding:12px 18px;display:flex;align-items:center;gap:12px;border-top:1px solid #e2eaf4;flex-shrink:0;background:#fff;';

    const applyBtn = doc.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = '✓ Ausgewählte umbenennen';
    applyBtn.style.cssText = 'background:#28a745;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:500;cursor:pointer;';

    const statusSpan = doc.createElement('span');
    statusSpan.style.cssText = 'font-size:12px;color:#667;';

    footer.appendChild(applyBtn);
    footer.appendChild(statusSpan);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    doc.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    // Umbenennen per PATCH /vehicles/<id>
    applyBtn.addEventListener('click', async () => {
      const toRename = Object.entries(inputMap)
        .filter(([, {cb, inp, current}]) => cb.checked && inp.value.trim())
        .map(([id, {inp}]) => ({ id, name: inp.value.trim() }));

      if (!toRename.length) {
        statusSpan.textContent = 'Keine Änderungen ausgewählt.';
        return;
      }

      applyBtn.disabled = true;
      applyBtn.textContent = '…';
      statusSpan.textContent = '0 / ' + toRename.length + ' umbenannt';

      let done = 0, errors = 0;
      for (const { id, name } of toRename) {
        try {
          const token = doc.querySelector('meta[name="csrf-token"]')?.content
            || doc.querySelector('input[name="authenticity_token"]')?.value
            || window.top?.document?.querySelector('meta[name="csrf-token"]')?.content
            || window.top?.document?.querySelector('input[name="authenticity_token"]')?.value
            || '';
          const body = new URLSearchParams({
            'authenticity_token': token,
            'vehicle[caption]': name,
            '_method': 'patch',
          });
          const resp = await fetch('/vehicles/' + id, {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'manual',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With':'XMLHttpRequest',
              'X-CSRF-Token': token,
            },
            body,
          });
          if (resp.ok || resp.redirected || resp.status === 302 || resp.status === 0 || resp.status < 500) {
            done++;
            // Input grün markieren
            const row = inputMap[id];
            if (row) { row.inp.style.background = '#e6f9ee'; row.cb.checked = false; }
          } else {
            errors++;
          }
        } catch (_) { errors++; }
        statusSpan.textContent = done + ' / ' + toRename.length + ' umbenannt' + (errors ? ', ' + errors + ' Fehler' : '');
      }

      applyBtn.disabled = false;
      applyBtn.textContent = '✓ Fertig';
      applyBtn.style.background = '#1e863a';
      if (!errors) {
        statusSpan.textContent = '✓ ' + done + ' Fahrzeuge umbenannt';
        setTimeout(() => { overlay.remove(); doc.location.reload(); }, 1500);
      }
    });
  }

  function addProfileMenuEntry() {
    if (document.getElementById('lss-cfg-menu-entry')) return;
    // Dropdown noch nicht da → warten
    const profileMenu = document.querySelector('#menu_profile + .dropdown-menu');
    if (!profileMenu) {
      const obs = new MutationObserver(() => {
        const m = document.querySelector('#menu_profile + .dropdown-menu');
        if (m) { obs.disconnect(); insertEntry(m); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return;
    }
    insertEntry(profileMenu);
  }

  function insertEntry(profileMenu) {
    if (document.getElementById('lss-cfg-menu-entry')) return;
    const li = document.createElement('li');
    li.id = 'lss-profile-menu-entry';
    li.setAttribute('role', 'presentation');
    li.innerHTML = '<a id="lss-cfg-menu-entry" href="#"><span class="glyphicon glyphicon-signal" aria-hidden="true"></span> Funkrufnamen-Generator</a>';
    li.querySelector('a').addEventListener('click', e => {
      e.preventDefault();
      openModal('kz');
    });
    profileMenu.appendChild(li);
  }

  function init() {
    // Iframe-Kontext: /vehicles/<id>/edit, /buildings/<id>/edit, oder /buildings/<id>
    if (window !== window.top) {
      // Gebäude-Übersicht (Tabs) — URL ohne /edit
      const pathMatch = location.pathname.match(/^\/buildings\/(\d+)$/);
      if (pathMatch) {
        const buildingId = pathMatch[1];
        // Einmalig aufrufen sobald .nav-tabs da ist
        if (document.querySelector('.nav-tabs')) {
          handleBuildingTab(document, buildingId);
        } else {
          const obs = new MutationObserver(() => {
            if (document.querySelector('.nav-tabs')) {
              obs.disconnect();
              handleBuildingTab(document, buildingId);
            }
          });
          obs.observe(document.body, { childList: true, subtree: true });
        }
        return;
      }

      // Bearbeitungs-Formulare
      document.querySelectorAll(SEL_FORM).forEach(handleForm);
        const obs = new MutationObserver(muts => {
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.matches?.(SEL_FORM)) { handleForm(node); continue; }
              node.querySelectorAll?.(SEL_FORM).forEach(handleForm);
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return;
    }

    // Haupt-Dokument: Menüeintrag im Profil-Dropdown + Observer
    addProfileMenuEntry();
    startObserver();
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();

})();

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

  // THW Extension → TKZ1: { extensionTypeId: tkz1 }
  const DEFAULT_THW_EXT_TKZ1 = {};

  // THW Fahrzeugtyp → Standard-Fachgruppe: { vehicleTypeId: extensionTypeId }
  const DEFAULT_THW_DEFAULT_FGR = {};

  const STORE_VEHICLE_PROPS_KEY = 'lss_callsign_vehicles_v1';

  // Fahrzeugtyp-Aliase: { typeId: alias } z.B. { '76': 'FRT' }
  const DEFAULT_ALIASES = {};

  // ILS-Mapping: { leitstelleBuildingId: bereichsname } z.B. { '12345': 'KRU' }
  const DEFAULT_ILS = {};

  // ILS-Wachen-Nummerierung: { leitstelleId: { buildingId: nr } }
  const DEFAULT_ILS_NR = {};

  // Gebäude-Typ-Aliase: { buildingType: alias } z.B. { '0': 'FW', '2': 'RW' }
  const DEFAULT_BUILDING_ALIASES = {};

  // Gebäude-Schemas pro Dienst: { dienst: schema } + '*' als Fallback
  const DIENST_LIST = ['Feuerwehr', 'Rettung', 'Polizei', 'THW'];
  const DEFAULT_BUILDING_SCHEMAS = { '*': '{balias} {ils} {ilsnr} ({ort}) {org}' };

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
  const GDRIVE_CLIENT_ID_KEY = 'lss_gdrive_client_id';
  const GDRIVE_TOKEN_KEY = 'lss_gdrive_token';
  const GDRIVE_FILE_NAME = 'lss-callsign-backup.json';
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
        if (!parsed.ilsNr) parsed.ilsNr = {};
        if (!parsed.thwExtTkz1) parsed.thwExtTkz1 = {};
        if (!parsed.thwDefaultFgr) parsed.thwDefaultFgr = {};
        if (!parsed.buildingAliases) parsed.buildingAliases = {};
        // Migration: alter Key-Separator ':' → '-'
        for (const key of Object.keys(parsed.buildingAliases)) {
          if (key.includes(':')) {
            parsed.buildingAliases[key.replace(':', '-')] = parsed.buildingAliases[key];
            delete parsed.buildingAliases[key];
          }
        }
        if (!parsed.buildingSchemas) parsed.buildingSchemas = { ...DEFAULT_BUILDING_SCHEMAS };
        // Migration alter Einzel-Schema
        if (parsed.buildingSchema && !parsed.buildingSchemas) parsed.buildingSchemas = { '*': parsed.buildingSchema };
        delete parsed.buildingSchema;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // GOOGLE DRIVE BACKUP
  // ═══════════════════════════════════════════════════════════════════════════

  function getGDriveToken() {
    try { return GM_getValue(GDRIVE_TOKEN_KEY, null); } catch (_) { return null; }
  }
  function setGDriveToken(t) {
    try { GM_setValue(GDRIVE_TOKEN_KEY, t); } catch (_) {}
  }
  function getGDriveClientId() {
    try { return GM_getValue(GDRIVE_CLIENT_ID_KEY, ''); } catch (_) { return ''; }
  }

  async function gdriveRequest(url, opts = {}) {
    const token = getGDriveToken();
    if (!token) throw new Error('Nicht autorisiert');
    const resp = await new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url,
        headers: { 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) },
        data: opts.body || null,
        onload: r => res(r),
        onerror: e => rej(e),
      });
    });
    if (resp.status === 401) { setGDriveToken(null); throw new Error('Token abgelaufen'); }
    return resp;
  }

  async function gdriveFindFile() {
    const resp = await gdriveRequest(
      'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(
        `name="${GDRIVE_FILE_NAME}" and trashed=false`
      ) + '&fields=files(id,name,modifiedTime)'
    );
    if (resp.status >= 400) {
      console.error('[LSS-GDrive] FindFile error:', resp.status, resp.responseText);
      throw new Error('Drive API Fehler: ' + resp.status + ' — ' + (JSON.parse(resp.responseText)?.error?.message || resp.responseText));
    }
    const data = JSON.parse(resp.responseText);
    return data.files?.[0] || null;
  }

  async function gdriveSaveBackup() {
    const token = getGDriveToken();
    if (!token) throw new Error('Nicht autorisiert');
    const payload = JSON.stringify({ cfg, buildingProps, vehicleProps, _backupAt: new Date().toISOString() }, null, 2);
    const existing = await gdriveFindFile();
    const boundary = '-------LSS_BACKUP_BOUNDARY';
    const body = [
      '--' + boundary,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ name: GDRIVE_FILE_NAME, mimeType: 'application/json' }),
      '--' + boundary,
      'Content-Type: application/json',
      '',
      payload,
      '--' + boundary + '--',
    ].join('\r\n');

    let url, method;
    if (existing) {
      url = 'https://www.googleapis.com/upload/drive/v3/files/' + existing.id + '?uploadType=multipart';
      method = 'PATCH';
    } else {
      url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
      method = 'POST';
    }
    const resp = await gdriveRequest(url, {
      method,
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body,
    });
    if (resp.status >= 400) {
      console.error('[LSS-GDrive] API Error:', resp.status, resp.responseText);
      throw new Error('Fehler: ' + resp.status + ' — ' + (JSON.parse(resp.responseText)?.error?.message || resp.responseText));
    }
    return JSON.parse(resp.responseText);
  }

  async function gdriveLoadBackup() {
    const file = await gdriveFindFile();
    if (!file) throw new Error('Keine Backup-Datei gefunden');
    const resp = await gdriveRequest(
      'https://www.googleapis.com/drive/v3/files/' + file.id + '?alt=media'
    );
    if (resp.status >= 400) {
      console.error('[LSS-GDrive] Load error:', resp.status, resp.responseText);
      throw new Error('Fehler beim Laden: ' + resp.status);
    }
    let data;
    try {
      data = JSON.parse(resp.responseText);
    } catch (e) {
      console.error('[LSS-GDrive] JSON Parse Fehler:', e, resp.responseText?.slice(0, 200));
      throw new Error('JSON Parse Fehler: ' + e.message);
    }
    return { data, file };
  }

  function gdriveAuthorize(clientId) {
    return new Promise((resolve, reject) => {
      const doAuth = () => {
        try {
          const g = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).google;
          if (!g?.accounts?.oauth2) { reject(new Error('GIS nicht verfügbar')); return; }
          const tokenClient = g.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'https://www.googleapis.com/auth/drive.file',
            callback: (resp) => {
              if (resp.error) reject(new Error(resp.error));
              else resolve(resp.access_token);
            },
          });
          tokenClient.requestAccessToken({ prompt: 'consent' });
        } catch (e) { reject(e); }
      };

      // GIS bereits geladen?
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (w.google?.accounts?.oauth2) {
        doAuth();
      } else {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => setTimeout(doAuth, 200);
        script.onerror = () => reject(new Error('GIS konnte nicht geladen werden'));
        document.head.appendChild(script);
      }
    });
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

  function loadVehicleProps() {
    try {
      const r = GM_getValue(STORE_VEHICLE_PROPS_KEY, null);
      if (r) return JSON.parse(r);
    } catch (_) {}
    return {};
  }
  function saveVehicleProps() { GM_setValue(STORE_VEHICLE_PROPS_KEY, JSON.stringify(vehicleProps)); }
  let vehicleProps = loadVehicleProps();

  // Sync zwischen Tabs (gleicher Prozess)
  try {
    GM_addValueChangeListener(STORE_KEY, (_key, _oldVal, newVal, remote) => {
      if (!remote) return;
      try {
        const updated = JSON.parse(newVal);
        Object.keys(cfg).forEach(k => delete cfg[k]);
        Object.assign(cfg, updated);
        showSyncNotice();
      } catch (_) {}
    });
  } catch (_) {}

  // Sync zwischen Fenstern (gleicher Browser, via localStorage)
  window.addEventListener('storage', e => {
    if (e.key !== 'lss_callsign_sync') return;
    try {
      const raw = GM_getValue(STORE_KEY, null);
      if (!raw) return;
      const updated = JSON.parse(raw);
      // Nur laden wenn neuer als aktueller Stand
      if (updated._savedAt && cfg._savedAt && updated._savedAt <= cfg._savedAt) return;
      Object.keys(cfg).forEach(k => delete cfg[k]);
      Object.assign(cfg, updated);
      showSyncNotice();
    } catch (_) {}
  });

  function showSyncNotice() {
    const ov = document.getElementById('lss-cfg-overlay');
    if (!ov) return;
    const notice = ov.querySelector('#lss-sync-notice');
    if (notice) {
      notice.style.display = 'block';
      clearTimeout(notice._hideTimer);
      notice._hideTimer = setTimeout(() => { notice.style.display = 'none'; }, 3000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CACHES
  // ═══════════════════════════════════════════════════════════════════════════

  const cacheVehicle = new Map();
  const cacheBuilding = new Map();
  const cacheBL = new Map();
  const cacheOrt = new Map(); // buildingId → Ortsname aus Nominatim
  let _vehicleTypeCatalog = null;

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

  async function getVehicleTypeCatalog() {
    if (_vehicleTypeCatalog !== null) return _vehicleTypeCatalog;
    const data = await apiFetch('/api/vehicle_types');
    if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length) {
      _vehicleTypeCatalog = data;
    } else {
      try {
        _vehicleTypeCatalog = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}');
      } catch (_) {
        _vehicleTypeCatalog = {};
      }
    }
    return _vehicleTypeCatalog;
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

  function getTHWExtTkz1(vehicleId) {
    // Kein Eintrag → 'default' verwenden
    const fgr = vehicleProps[String(vehicleId)]?.fgr ?? 'default';
    const entry = cfg.thwExtTkz1?.[String(fgr)];
    if (entry === undefined) return null;
    return typeof entry === 'object' ? (entry.tkz1 || '') : String(entry);
  }

  function getILSNr(leitstelleId, buildingId) {
    if (!leitstelleId || !buildingId) return '';
    return String(cfg.ilsNr?.[String(leitstelleId)]?.[String(buildingId)] || '');
  }

  function getBuildingAlias(buildingType, extensions) {
    if (buildingType === null || buildingType === undefined) return '';
    // Spezifischerer Key: buildingType-extensionTypeId (erste aktive Extension)
    if (Array.isArray(extensions)) {
      for (const ext of extensions) {
        if (ext.enabled && ext.available) {
          const specificKey = String(buildingType) + '-' + String(ext.type_id);
          if (cfg.buildingAliases[specificKey]) return cfg.buildingAliases[specificKey];
        }
      }
    }
    return cfg.buildingAliases[String(buildingType)] || '';
  }

  function applyBuildingSchema(vars, dienst) {
    const schemas = cfg.buildingSchemas || DEFAULT_BUILDING_SCHEMAS;
    const schema = (dienst && schemas[dienst]) ? schemas[dienst] : (schemas['*'] || '{balias} {ils} {ilsnr} ({ort}) {org}');
    return schema
      .replace(/\{(\w+?)(#+)\}/g, (_, key, hashes) => {
        const val = vars[key];
        if (val === undefined || val === null || String(val) === '') return '';
        if (key === 'ilsnr') return String(val).padStart(hashes.length + 1, '0');
        return String(val).slice(0, hashes.length);
      })
      .replace(/\{(\w+)\}/g, (_, key) => {
        const val = vars[key];
        if (val === undefined || val === null) return '';
        return String(val);
      })
      .replace(/\([\s]*\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function getILS(leitstelleBuildingId, dienst) {
    if (!leitstelleBuildingId) return '';
    const entry = cfg.ils?.[String(leitstelleBuildingId)];
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    if (dienst && entry[dienst]) return entry[dienst];
    return entry['*'] || Object.values(entry).find(v => v) || '';
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

    // Bundesland für TKZ-Lookup ermitteln
    const bl = await getBundesland(buildingId);
    const kennzahl = getKennzahl(typeId, bl);

    // Alle Fahrzeugtypen im Gebäude mit derselben TKZ ermitteln
    const sameKz = kennzahl
      ? vehicles.filter(v => getKennzahl(v.vehicle_type, bl) === kennzahl)
      : vehicles.filter(v => String(v.vehicle_type) === String(typeId));

    const sorted = sameKz.sort((a, b) => Number(a.id) - Number(b.id));

    if (vehicleId === 'new') {
      return sorted.length + 1;
    }

    const pos = sorted.findIndex(v => String(v.id) === String(vehicleId));
    return pos >= 0 ? pos + 1 : sorted.length + 1;
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
        if (hashes && key === 'ilsnr') return String(val).padStart(hashes.length + 1, '0');
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
  function genCallsigns({ typeId, typeName, bl, buildingId, buildingCaption, ortFromCoords, dienst = null, startNr = 1, count = 1, vehicleId = null }) {
    const kennzahl = getKennzahl(typeId, bl);
    if (!kennzahl) return [];

    const props = buildingProps[buildingId] || {};

    // Org: Gebäude-Override → Auto-Erkennung aus Gebäudename
    const orgEntry = detectOrgEntry(buildingCaption);
    // Feuerwehr/THW/Polizei: feste Org aus DIENST_ORG_DEFAULT
    // Rettung: Gebäude-Override → Auto-Erkennung aus Gebäudename
    // props.org ist jetzt das Keyword (z.B. 'BRK'), früher war es der Rufname
    // props.org ist das Label (z.B. 'BRK') → Rufname via orgLabels
    const _propsOrgLabel = props.org ? cfg.orgLabels?.find(o => o.label === props.org) : null;
    const _propsOrgEntry = props.org ? cfg.org[props.org] : null;
    const _propsOrgName = _propsOrgEntry?.name || _propsOrgLabel?.value || null;
    const orgName = (dienst && dienst !== 'Rettung' && dienst in DIENST_ORG_DEFAULT)
      ? DIENST_ORG_DEFAULT[dienst]
      : (_propsOrgName || orgEntry?.name || '');
    // orgname: props.orgname (manuell) → cfg.org[keyword].label → orgLabels → orgName
    // _orgKeyword ist jetzt das Label (z.B. 'BRK') — direkt als orgname verwendbar
    const _orgKeyword = props.org || orgEntry?.keyword;
    const orgname = props.orgname
      || (_orgKeyword && cfg.org[_orgKeyword]?.label)
      || _orgKeyword
      || cfg.orgLabels?.find(o => o.value === orgName)?.label
      || orgName;
    // dienst kommt als Parameter (aus building_type), Fallback auf Org-Erkennung

    // Ort: Gebäude-Override → Nominatim-Koordinaten
    const ort = props.ort || ortFromCoords || '';

    // Standort: THW FGr TKZ1-Override → Gebäude-Eigenschaften
    const _thwTkz1 = (dienst === 'THW') ? getTHWExtTkz1(vehicleId) : null;
    const standort = _thwTkz1 !== null ? (_thwTkz1 || '') : (props.standort || '');

    // Schema wählen: dienst-Parameter (aus building_type) hat Vorrang
    const schema = getSchema(bl, dienst || orgEntry?.dienst || null);

    return Array.from({ length: count }, (_, i) => {
      const seq = String(startNr + i);
      const alias = getAlias(typeId) || typeName;
      const leitstelleId = cacheBuilding.get(String(buildingId))?.leitstelle_building_id;
      const ils = getILS(leitstelleId, dienst);
      const ilsnr = getILSNr(leitstelleId, buildingId);
      const _ortsteil = (props.ortsteil || '').trim();
      const ortsteil = _ortsteil ? ' ' + _ortsteil : '';
      const result = applySchema(schema, { org: orgName, orgname, ort, tkz1: standort, tkz2: kennzahl, seq, typ: typeName, alias, ils, ilsnr, ortsteil });
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

    // THW: vehicleProps vorbelegen BEVOR genCallsigns aufgerufen wird
    if (dienst === 'THW' && vehicleProps[String(vehicleId)]?.fgr === undefined) {
      if (!vehicleProps[String(vehicleId)]) vehicleProps[String(vehicleId)] = {};
      // Standard-FGr aus Konfiguration, Fallback: default
      vehicleProps[String(vehicleId)].fgr = cfg.thwDefaultFgr?.[String(typeId)] ?? 'default';
      saveVehicleProps();
    }

    const callsigns = genCallsigns({ typeId, typeName, bl, buildingId, buildingCaption, ortFromCoords, dienst, startNr, count: 1, vehicleId });

    const blLabel = bl
      ? `${bl} · ${BUNDESLAENDER[bl]}`
      : '<span style="color:#c55;">BL nicht erkannt</span>';

    // THW: Fachgruppen-Dropdown
    let fgrSelect = null;
    if (dienst === 'THW') {
      try {
        const building = await getBuilding(buildingId);
        const extensions = (building?.extensions || []).filter(e => e.available);
        if (extensions.length) {
          const fgrWrap = document.createElement('div');
          fgrWrap.style.cssText = 'margin:6px 0;display:flex;align-items:center;gap:8px;';
          const fgrLbl = document.createElement('label');
          fgrLbl.textContent = 'Fachgruppe:';
          fgrLbl.style.cssText = 'font-size:12px;font-weight:600;color:#445;white-space:nowrap;';
          fgrSelect = document.createElement('select');
          fgrSelect.style.cssText = 'border:1px solid #c5cad8;border-radius:6px;padding:4px 8px;font-size:12px;background:#fff;';
          // Default-Eintrag (Basis-Einheit ohne Extension)
          const defaultEntry = cfg.thwExtTkz1?.['default'];
          const defaultOpt = document.createElement('option');
          defaultOpt.value = 'default';
          const defaultName = defaultEntry?.name || '1. Technischer Zug - Bergungsgruppe';
          const defaultTkz1 = defaultEntry?.tkz1 || '';
          defaultOpt.textContent = defaultName + ' (default)' + (defaultTkz1 ? ' · TKZ1: ' + defaultTkz1 : '');
          if ((vehicleProps[String(vehicleId)]?.fgr ?? 'default') === 'default') defaultOpt.selected = true;
          fgrSelect.appendChild(defaultOpt);
          // Extensions expandieren: z.B. 7 → 7a + 7b falls konfiguriert
          const expandedExts = [];
          for (const ext of extensions) {
            const sid = String(ext.type_id);
            if (cfg.thwExtTkz1?.[sid + 'a'] || cfg.thwExtTkz1?.[sid + 'b']) {
              if (cfg.thwExtTkz1?.[sid + 'a']) expandedExts.push({ ...ext, _virtualId: sid + 'a' });
              if (cfg.thwExtTkz1?.[sid + 'b']) expandedExts.push({ ...ext, _virtualId: sid + 'b' });
            } else {
              expandedExts.push({ ...ext, _virtualId: sid });
            }
          }
          expandedExts.sort((a, b) => {
            const na = cfg.thwExtTkz1?.[a._virtualId]?.name || a.caption || '';
            const nb = cfg.thwExtTkz1?.[b._virtualId]?.name || b.caption || '';
            return na.localeCompare(nb, 'de');
          });
          for (const ext of expandedExts) {
            const vid = ext._virtualId;
            const extName = cfg.thwExtTkz1?.[vid]?.name || ext.caption || ('Extension ' + vid);
            const tkz1 = cfg.thwExtTkz1?.[vid]?.tkz1 || '';
            const opt = document.createElement('option');
            opt.value = vid;
            opt.textContent = extName + ' (' + vid + ')' + (tkz1 ? ' · TKZ1: ' + tkz1 : '');
            if (String(vehicleProps[String(vehicleId)]?.fgr) === vid) opt.selected = true;
            fgrSelect.appendChild(opt);
          }
          fgrSelect.addEventListener('change', () => {
            const newFgr = fgrSelect.value;
            if (!vehicleProps[String(vehicleId)]) vehicleProps[String(vehicleId)] = {};
            vehicleProps[String(vehicleId)].fgr = newFgr;
            saveVehicleProps();
            const newCallsigns = genCallsigns({ typeId, typeName, bl, buildingId, buildingCaption, ortFromCoords, dienst, startNr, count: 1, vehicleId });
            if (newCallsigns[0]) {
              form.querySelectorAll('.lss-chip').forEach((chip, i) => {
                if (i === 0) {
                  chip.textContent = newCallsigns[0];
                  chip.dataset.cs = newCallsigns[0];
                }
              });
            }
          });
          fgrWrap.appendChild(fgrLbl);
          fgrWrap.appendChild(fgrSelect);
          // Nach dem Name-Input einfügen
          const nameInp = form.querySelector(SEL_NAME_INPUT);
          if (nameInp) {
            nameInp.insertAdjacentElement('afterend', fgrWrap);
          } else {
            form.prepend(fgrWrap);
          }
        }
      } catch (e) {
        console.warn('[LSS] FGr-Dropdown Fehler:', e);
      }
    }

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
            : `<span class="lss-chip-warn">Kein Mapping für „${esc(typeName)}" (ID: ${esc(String(typeId))}) ${bl ? 'in ' + esc(bl) : ''} —
               <a href="#" class="lss-cfg-a">Kennzahl konfigurieren</a></span>`
          }
        </div>

      </div>
    `;

    // Chip → Name übernehmen
    box.querySelectorAll('.lss-chip[data-cs]').forEach(chip => {
      chip.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        nameInput.value = chip.dataset.cs;
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

  async function initAliasTypSelect(ov) {
    const cont = ov.querySelector('#alias-typ-container');
    if (!cont) return;
    const prevVal = cont.dataset.selectedValue || cont.querySelector('.lss-ss-display')?.dataset.value || '';
    cont.innerHTML = '<span style="font-size:12px;color:#888;">Lade …</span>';
    const cat = await getVehicleTypeCatalog();
    if (!ov.isConnected) return;
    const opts = Object.entries(cat)
      .map(([id, v]) => ({ value: id, label: (typeof v === 'string' ? v : (v.caption || v.name || id)) + ' (' + id + ')' }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de'));
    cont.innerHTML = '';
    if (!opts.length) return;
    const ss = makeSearchableSelect(cont, 'alias-typ', opts, prevVal, '— Fahrzeugtyp wählen —');
    cont.dataset.selectedValue = prevVal;
    ss.addEventListener('ss-change', e => { cont.dataset.selectedValue = e.detail.value; });
  }

  async function initKzTypSelect(ov) {
    const kzTypCont = ov.querySelector('#kz-typ-container');
    if (!kzTypCont) return;
    // Wert VOR dem Rebuild merken
    const prevVal = kzTypCont.dataset.selectedValue
      || kzTypCont.querySelector('.lss-ss-display')?.dataset.value
      || '';
    kzTypCont.innerHTML = '<span style="font-size:12px;color:#888;">Lade …</span>';
    const cat = await getVehicleTypeCatalog();
    if (!ov.isConnected) return;
    const opts = Object.entries(cat)
      .map(([id, v]) => ({
        value: id,
        label: (typeof v === 'string' ? v : (v.caption || v.name || id)) + ' (' + id + ')'
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de'));
    kzTypCont.innerHTML = '';
    if (!opts.length) return;
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
            <button class="lss-tab" data-t="t-thw">THW</button>
            <button class="lss-tab" data-t="t-baliases">Gebäude-Aliase</button>
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
                  ['{orgname}', 'Org-Kurzname'],
                  ['{ort}', 'Ortsname'],
                  ['{ils}', 'ILS-Bereichsname'],
                  ['{ilsnr}', 'ILS-Wachennummer'],
                  ['{ilsnr#}', 'ILS-Nr. 1-stellig'],
                  ['{ilsnr##}', 'ILS-Nr. 2-stellig'],
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
                <input id="ol-label" type="text" placeholder="z.B. BRK" style="width:140px;"></div>
              <div><label>Rufname ({org})</label>
                <input id="ol-value" type="text" placeholder="z.B. Rotkreuz" style="width:130px;"></div>
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

          <!-- THW -->
          <div class="lss-tp" id="t-thw">
            <div class="lss-note">
              Ordnet THW-Extensions (Fachgruppen) eine 1. TKZ zu. Im Fahrzeug-Formular kann dann die Fachgruppe ausgewählt werden.<br>
              Tipp: Extension-ID <code>default</code> = Fallback ohne Extension. Für Untertypen: <code>7a</code> + <code>7b</code> eingeben — werden automatisch als „FGr Ortung Typ A" / „FGr Ortung Typ B" angezeigt wenn Extension 7 vorhanden ist.
            </div>
            <div class="lss-row">
              <div><label>Extension-ID</label>
                <input id="thw-ext-id" type="text" placeholder="z.B. 5 oder default" style="width:110px;"></div>
              <div><label>Extension-Name <small style="font-weight:400;color:#999;">(optional)</small></label>
                <input id="thw-ext-name" type="text" placeholder="z.B. FGr E" style="width:140px;"></div>
              <div><label>1. TKZ</label>
                <input id="thw-ext-tkz1" type="text" placeholder="z.B. 28" style="width:80px;"></div>
              <button class="lss-btn lss-btn-ok" id="thw-ext-add">+ Hinzufügen</button>
            </div>
            <div id="thw-ext-tbl">${buildThwExtTable()}</div>

            <div style="margin-top:20px;border-top:2px solid #e2eaf4;padding-top:16px;">
              <div class="lss-note" style="margin-bottom:10px;">
                <strong>Standard-Fachgruppe pro Fahrzeugtyp</strong> — wird beim ersten Öffnen eines Fahrzeugs automatisch gesetzt.
              </div>
              <div class="lss-row" style="margin-bottom:8px;">
                <div><label>Fahrzeugtyp</label>
                  <div id="thw-dfgr-typ-container" style="min-width:200px;"></div></div>
                <div><label>Standard-Fachgruppe</label>
                  <select id="thw-dfgr-val" style="border:1px solid #c5cad8;border-radius:5px;padding:4px 8px;font-size:13px;min-width:200px;">
                    <option value="default">1. Technischer Zug - Bergungsgruppe (default)</option>
                    ${Object.entries(cfg.thwExtTkz1||{}).filter(([k])=>k!=='default').map(([k,v])=>
                      `<option value="${esc(k)}">${esc(typeof v==='object'?v.name||k:k)} (${esc(k)})</option>`
                    ).join('')}
                  </select></div>
                <button class="lss-btn lss-btn-ok" id="thw-dfgr-add">+ Hinzufügen</button>
              </div>
              <div id="thw-dfgr-tbl">${buildThwDefaultFgrTable()}</div>
            </div>
          </div>

          <!-- GEBÄUDE-ALIASE -->
          <div class="lss-tp" id="t-baliases">
            <div class="lss-note">
              Kurzbezeichnungen für Gebäudetypen (<code>{balias}</code>) und das Schema für automatische Gebäudebenennung.
            </div>
            <div style="margin-bottom:12px;">
              <table class="lss-tbl" style="width:100%;">
                <thead><tr>
                  <th style="width:120px;">Dienst</th>
                  <th>Schema</th>
                </tr></thead>
                <tbody>
                  ${['*','Feuerwehr','Rettung','Polizei','THW'].map(d => `
                  <tr>
                    <td style="font-size:12px;font-weight:600;color:#445;">${d === '*' ? '* (Fallback)' : d}</td>
                    <td><input class="bschema-row" data-dienst="${d}" type="text"
                      value="${esc((cfg.buildingSchemas || DEFAULT_BUILDING_SCHEMAS)[d] || '')}"
                      style="width:100%;font-family:monospace;border:1px solid #c5cad8;border-radius:5px;padding:4px 8px;font-size:13px;"
                      placeholder="${d === '*' ? '{balias} {ils} {ilsnr} ({ort}) {org}' : '(leer = Fallback verwenden)'}">
                    </td>
                  </tr>`).join('')}
                </tbody>
              </table>
              <button class="lss-btn lss-btn-ok" id="bschema-save" style="margin-top:8px;">✓ Schemas speichern</button>
            </div>
            <div class="lss-note" style="font-size:11px;margin-bottom:12px;">
              <strong style="font-size:11px;">Platzhalter</strong> <span style="color:#888;font-size:11px;">Klicken zum Einfügen an Cursor-Position</span><br>
              <div class="lss-ph-chips" style="margin-top:6px;">
                ${[
                  ['{balias}','Gebäudetyp-Alias'],
                  ['{ils}','ILS-Name'],
                  ['{ilsnr}','ILS-Wachennummer'],
                  ['{ilsnr#}','ILS-Nr. 1-stellig'],
                  ['{ilsnr##}','ILS-Nr. 2-stellig'],
                  ['{ort}','Ortsname'],
                  ['{ortsteil}','Ortsteil'],
                  ['{org}','Organisation'],
                  ['{orgname}','Org-Kurzname (Label)'],
                  ['{tkz1}','1. TKZ'],
                ].map(([ph,label]) =>
                  `<button class="lss-ph-chip lss-bschema-chip" data-ph="${ph}" type="button" title="${label}">${ph}</button>`
                ).join('')}
              </div>
            </div>
            <div class="lss-row">
              <div><label>Gebäudetyp-ID</label>
                <input id="balias-type" type="number" min="0" placeholder="z.B. 6" style="width:80px;"></div>
              <div><label>Extension-ID <small style="font-weight:400;color:#999;">(optional)</small></label>
                <input id="balias-ext" type="number" min="0" placeholder="z.B. 11" style="width:80px;"></div>
              <div><label>Alias</label>
                <input id="balias-val" type="text" placeholder="z.B. PI" style="width:120px;"></div>
              <button class="lss-btn lss-btn-ok" id="balias-add">+ Hinzufügen</button>
            </div>

            <div id="balias-tbl">${buildBAliasTable()}</div>
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

            <hr style="margin:16px 0;border:none;border-top:2px solid #dde;">
            <div style="margin-bottom:10px;">
              <strong style="font-size:13px;">☁ Google Drive Backup</strong>
              <span style="font-size:11px;color:#888;margin-left:8px;">Sichert Konfiguration, Gebäude- und Fahrzeug-Eigenschaften</span>
            </div>
            <div class="lss-row" style="margin-bottom:10px;flex-wrap:wrap;gap:6px;">
              <div style="display:flex;align-items:center;gap:6px;">
                <label style="font-size:12px;white-space:nowrap;">Client-ID:</label>
                <input id="gdrive-client-id" type="text"
                  value="${esc(getGDriveClientId())}"
                  placeholder="xxxx.apps.googleusercontent.com"
                  style="width:280px;font-size:12px;border:1px solid #c5cad8;border-radius:5px;padding:4px 8px;">
              </div>
              <button class="lss-btn lss-btn-blue" id="gdrive-auth">🔑 Autorisieren</button>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="lss-btn lss-btn-ok" id="gdrive-save">☁ Auf Drive sichern</button>
              <button class="lss-btn lss-btn-blue" id="gdrive-load">⬇ Von Drive laden</button>
            </div>
            <div id="gdrive-fb" style="margin-top:8px;font-size:12px;"></div>
            <div style="margin-top:8px;font-size:11px;color:#888;">
              Benötigt eine Google Cloud OAuth 2.0 Client-ID (Typ: Web).
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#1d5f9e;">Google Cloud Console</a>
            </div>
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
    // Google Drive
    const gdriveClientIdInp = ov.querySelector('#gdrive-client-id');
    const gdriveFb = ov.querySelector('#gdrive-fb');
    const setGdriveFb = (msg, ok) => {
      gdriveFb.textContent = msg;
      gdriveFb.style.color = ok ? '#1a6b35' : '#b00020';
    };
    gdriveClientIdInp?.addEventListener('change', () => {
      GM_setValue(GDRIVE_CLIENT_ID_KEY, gdriveClientIdInp.value.trim());
    });
    ov.querySelector('#gdrive-auth')?.addEventListener('click', async () => {
      const clientId = gdriveClientIdInp?.value.trim() || getGDriveClientId();
      if (!clientId) { setGdriveFb('Bitte Client-ID eingeben.', false); return; }
      GM_setValue(GDRIVE_CLIENT_ID_KEY, clientId);
      setGdriveFb('Öffne Autorisierungs-Fenster…', true);
      try {
        const token = await gdriveAuthorize(clientId);
        setGDriveToken(token);
            setGdriveFb('✓ Autorisiert', true);
      } catch (e) { setGdriveFb('✕ ' + (e?.message || String(e)), false); }
    });
    ov.querySelector('#gdrive-save')?.addEventListener('click', async () => {
      if (!getGDriveToken()) { setGdriveFb('Zuerst autorisieren.', false); return; }
      setGdriveFb('Speichere…', true);
      try {
        const f = await gdriveSaveBackup();
        setGdriveFb('✓ Gespeichert: ' + (f.name || GDRIVE_FILE_NAME) + ' · ' + new Date().toLocaleTimeString(), true);
      } catch (e) {
        console.error('[LSS-GDrive] Save error:', e);
        setGdriveFb('✕ ' + (e?.message || JSON.stringify(e) || 'Unbekannter Fehler'), false);
      }
    });
    ov.querySelector('#gdrive-load')?.addEventListener('click', async () => {
      if (!getGDriveToken()) { setGdriveFb('Zuerst autorisieren.', false); return; }
      setGdriveFb('Lade…', true);
      try {
        const { data, file } = await gdriveLoadBackup();
        if (data.cfg) { Object.keys(cfg).forEach(k => delete cfg[k]); Object.assign(cfg, data.cfg); saveConfig(cfg); }
        if (data.buildingProps) { Object.assign(buildingProps, data.buildingProps); saveBuildingProps(buildingProps); }
        if (data.vehicleProps) { Object.assign(vehicleProps, data.vehicleProps); saveVehicleProps(); }
        setGdriveFb('✓ Geladen: ' + (data._backupAt || file.modifiedTime || '') + ' — Seite neu laden um Änderungen zu sehen.', true);
      } catch (e) {
        console.error('[LSS-GDrive] Load error:', e);
        setGdriveFb('✕ ' + (e?.message || JSON.stringify(e) || 'Unbekannter Fehler'), false);
      }
    });

    // THW Standard-FGr
    const thwDfgrTypCont = ov.querySelector('#thw-dfgr-typ-container');
    if (thwDfgrTypCont) {
      try {
        const cat = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}');
        const opts = Object.entries(cat).map(([id, v]) => ({
          value: id,
          label: (typeof v === 'string' ? v : (v.caption || v.name || id)) + ' (' + id + ')'
        })).sort((a, b) => a.label.localeCompare(b.label, 'de'));
        makeSearchableSelect(thwDfgrTypCont, 'thw-dfgr-typ', opts, '', '— Fahrzeugtyp wählen —');
      } catch (_) {}
    }
    ov.querySelector('#thw-dfgr-add')?.addEventListener('click', () => {
      const cont = ov.querySelector('#thw-dfgr-typ-container');
      const tid = cont?.querySelector('.lss-ss-display')?.dataset.value || '';
      const val = ov.querySelector('#thw-dfgr-val')?.value || '';
      if (!tid || !val) return;
      if (!cfg.thwDefaultFgr) cfg.thwDefaultFgr = {};
      cfg.thwDefaultFgr[tid] = val;
      saveConfig(cfg);
      ov.querySelector('#thw-dfgr-tbl').innerHTML = buildThwDefaultFgrTable();
      bindThwDefaultFgrEvents(ov);
      ov.querySelector('#thw-dfgr-val').selectedIndex = 0;
      const disp = cont?.querySelector('.lss-ss-display');
      if (disp) { disp.textContent = '— Fahrzeugtyp wählen —'; disp.dataset.value = ''; }
    });
    bindThwDefaultFgrEvents(ov);

    // THW Extension TKZ1
    ov.querySelector('#thw-ext-add')?.addEventListener('click', () => {
      const extId = ov.querySelector('#thw-ext-id').value.trim();
      const name = ov.querySelector('#thw-ext-name').value.trim();
      const tkz1 = ov.querySelector('#thw-ext-tkz1').value.trim();
      if (!extId || !tkz1) return;
      if (!cfg.thwExtTkz1) cfg.thwExtTkz1 = {};
      cfg.thwExtTkz1[extId] = { name, tkz1 };
      saveConfig(cfg);
      ov.querySelector('#thw-ext-tbl').innerHTML = buildThwExtTable();
      bindThwExtEvents(ov);
      ov.querySelector('#thw-ext-id').value = '';
      ov.querySelector('#thw-ext-name').value = '';
      ov.querySelector('#thw-ext-tkz1').value = '';
    });
    bindThwExtEvents(ov);

    // Gebäude-Aliase
    ov.querySelector('#bschema-save').addEventListener('click', () => {
      if (!cfg.buildingSchemas) cfg.buildingSchemas = {};
      ov.querySelectorAll('.bschema-row').forEach(inp => {
        const val = inp.value.trim();
        if (val) cfg.buildingSchemas[inp.dataset.dienst] = val;
        else delete cfg.buildingSchemas[inp.dataset.dienst];
      });
      saveConfig(cfg);
    });

    // Gebäude-Schema Cursor-Tracking + Badge-Einfügen
    let _lastBSchemaInp = null;
    ov.querySelectorAll('.bschema-row').forEach(inp => {
      inp.addEventListener('focus', () => { _lastBSchemaInp = inp; });
      inp.addEventListener('click', () => { _lastBSchemaInp = inp; });
    });
    ov.querySelectorAll('.lss-bschema-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const inp = _lastBSchemaInp || ov.querySelector('.bschema-row');
        if (!inp) return;
        const ph = chip.dataset.ph;
        const start = inp.selectionStart ?? inp.value.length;
        const end = inp.selectionEnd ?? inp.value.length;
        inp.value = inp.value.slice(0, start) + ph + inp.value.slice(end);
        inp.focus();
        inp.selectionStart = inp.selectionEnd = start + ph.length;
        _lastBSchemaInp = inp;
      });
    });
    ov.querySelector('#balias-add').addEventListener('click', () => {
      const type = ov.querySelector('#balias-type').value.trim();
      const ext = ov.querySelector('#balias-ext').value.trim();
      const val = ov.querySelector('#balias-val').value.trim();
      if (!type || !val) return;
      const key = ext ? type + '-' + ext : type;
      if (!cfg.buildingAliases) cfg.buildingAliases = {};
      cfg.buildingAliases[key] = val;
      saveConfig(cfg);
      ov.querySelector('#balias-tbl').innerHTML = buildBAliasTable();
      bindBAliasEvents(ov);
      ov.querySelector('#balias-type').value = '';
      ov.querySelector('#balias-ext').value = '';
      ov.querySelector('#balias-val').value = '';
    });
    bindBAliasEvents(ov);

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
      cfg.ils[bid] = { '*': val };
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
            const kzSeq1 = getKennzahl(typeId, bl);
            const sameKz1 = (kzSeq1
              ? bVehicles.filter(x => getKennzahl(x.vehicle_type, bl) === kzSeq1)
              : bVehicles.filter(x => String(x.vehicle_type) === String(typeId))
            ).sort((a,b) => Number(a.id)-Number(b.id));
            const pos = sameKz1.findIndex(x => String(x.id) === String(v.id));
            const startNr = pos >= 0 ? pos + 1 : sameKz1.length + 1;
            // THW: vehicleProps default vorbelegen falls noch nicht gesetzt
            if (dienst === 'THW' && vehicleProps[String(v.id)]?.fgr === undefined) {
              if (!vehicleProps[String(v.id)]) vehicleProps[String(v.id)] = {};
              vehicleProps[String(v.id)].fgr = cfg.thwDefaultFgr?.[String(typeId)] ?? 'default';
            }
            const suggested = genCallsigns({
              typeId, typeName, bl, buildingId: bid,
              buildingCaption: buildingCap,
              ortFromCoords: ortCoords,
              dienst, startNr, count: 1,
              vehicleId: v.id,
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
      cfg = { schemas: { ...DEFAULT_SCHEMAS }, org: JSON.parse(JSON.stringify(DEFAULT_ORG)), kz: JSON.parse(JSON.stringify(DEFAULT_KZ)), orgLabels: JSON.parse(JSON.stringify(DEFAULT_ORG_LABELS)), aliases: {}, thwExtTkz1: {}, thwDefaultFgr: {}, ils: {}, ilsNr: {}, buildingAliases: {}, buildingSchemas: { ...DEFAULT_BUILDING_SCHEMAS } };
      saveConfig(cfg);
      ov.querySelector('#sc-tbl').innerHTML = buildSchemaTable();
      ov.querySelector('#kz-tbl').innerHTML = buildKzTable();
      ov.querySelector('#org-tbl').innerHTML = buildOrgTable();
      ov.querySelector('#ol-tbl').innerHTML = buildOrgLabelsTable();
      ov.querySelector('#alias-tbl').innerHTML = buildAliasTable();
      ov.querySelector('#thw-ext-tbl').innerHTML = buildThwExtTable();
      ov.querySelector('#thw-dfgr-tbl').innerHTML = buildThwDefaultFgrTable();
      ov.querySelector('#balias-tbl').innerHTML = buildBAliasTable();
      ov.querySelector('#ils-tbl').innerHTML = buildILSTable();
      bindSchemaEvents(ov); bindKzEvents(ov); bindOrgEvents(ov); bindOrgLabelsEvents(ov); bindAliasEvents(ov); bindThwExtEvents(ov); bindThwDefaultFgrEvents(ov); bindBAliasEvents(ov); bindILSEvents(ov);
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
        if (!p.thwExtTkz1) p.thwExtTkz1 = {};
        if (!p.thwDefaultFgr) p.thwDefaultFgr = {};
        if (!p.ils) p.ils = {};
        if (!p.ilsNr) p.ilsNr = {};
        if (!p.buildingAliases) p.buildingAliases = {};
        if (!p.buildingSchemas) p.buildingSchemas = { ...DEFAULT_BUILDING_SCHEMAS };
        cfg = p; saveConfig(cfg);
        ov.querySelector('#sc-tbl').innerHTML = buildSchemaTable();
        ov.querySelector('#kz-tbl').innerHTML = buildKzTable();
        ov.querySelector('#org-tbl').innerHTML = buildOrgTable();
        ov.querySelector('#ol-tbl').innerHTML = buildOrgLabelsTable();
        ov.querySelector('#alias-tbl').innerHTML = buildAliasTable();
        ov.querySelector('#thw-ext-tbl').innerHTML = buildThwExtTable();
        ov.querySelector('#thw-dfgr-tbl').innerHTML = buildThwDefaultFgrTable();
        ov.querySelector('#balias-tbl').innerHTML = buildBAliasTable();
        ov.querySelector('#ils-tbl').innerHTML = buildILSTable();
        bindSchemaEvents(ov); bindKzEvents(ov); bindOrgEvents(ov); bindOrgLabelsEvents(ov); bindAliasEvents(ov); bindThwExtEvents(ov); bindThwDefaultFgrEvents(ov); bindBAliasEvents(ov); bindILSEvents(ov);
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

  function buildThwExtTable() {
    const entries = Object.entries(cfg.thwExtTkz1 || {});
    if (!entries.length) return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';
    const rows = entries.map(([extId, entry]) => {
      const name = typeof entry === 'object' ? (entry.name || '') : '';
      const tkz1 = typeof entry === 'object' ? (entry.tkz1 || '') : entry;
      return `<tr data-ext="${esc(extId)}">
        <td style="font-size:12px;"><code>${esc(extId)}</code></td>
        <td><input class="thw-ext-name-v" type="text" value="${esc(name)}"
          style="width:140px;border:1px solid #c5cad8;border-radius:5px;padding:3px 7px;font-size:13px;"
          placeholder="z.B. FGr E"></td>
        <td><input class="thw-ext-tkz1-v" type="text" value="${esc(tkz1)}"
          style="width:80px;border:1px solid #c5cad8;border-radius:5px;padding:3px 7px;font-size:13px;"
          placeholder="z.B. 28"></td>
        <td><button class="lss-btn lss-btn-del thw-ext-d" style="padding:3px 9px;">✕</button></td>
      </tr>`;
    }).join('');
    return `<table class="lss-tbl"><thead><tr>
      <th>Extension-ID</th><th>Name</th><th>1. TKZ</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function bindThwExtEvents(ov) {
    const tbl = ov.querySelector('#thw-ext-tbl');
    if (!tbl) return;
    tbl.querySelectorAll('.thw-ext-d').forEach(btn => {
      btn.addEventListener('click', () => {
        delete cfg.thwExtTkz1[btn.closest('tr').dataset.ext];
        saveConfig(cfg);
        tbl.innerHTML = buildThwExtTable();
        bindThwExtEvents(ov);
      });
    });
    tbl.querySelectorAll('.thw-ext-name-v').forEach(inp => {
      inp.addEventListener('change', () => {
        const ext = inp.closest('tr').dataset.ext;
        if (typeof cfg.thwExtTkz1[ext] !== 'object') cfg.thwExtTkz1[ext] = { tkz1: cfg.thwExtTkz1[ext] || '' };
        cfg.thwExtTkz1[ext].name = inp.value.trim();
        saveConfig(cfg);
      });
    });
    tbl.querySelectorAll('.thw-ext-tkz1-v').forEach(inp => {
      inp.addEventListener('change', () => {
        const ext = inp.closest('tr').dataset.ext;
        if (typeof cfg.thwExtTkz1[ext] !== 'object') cfg.thwExtTkz1[ext] = { name: '', tkz1: '' };
        cfg.thwExtTkz1[ext].tkz1 = inp.value.trim();
        saveConfig(cfg);
      });
    });
  }

  function buildThwDefaultFgrTable() {
    let cat = {};
    try { cat = JSON.parse(localStorage.getItem('rv_vehicleTypeCatalogMap') || '{}'); } catch (_) {}
    const typLabel = id => {
      const e = cat[id] ?? cat[String(id)];
      return e ? (typeof e === 'string' ? e : (e.caption || e.name || id)) : id;
    };
    const fgrLabel = extId => {
      if (extId === 'default') return '1. Technischer Zug - Bergungsgruppe (default)';
      const entry = cfg.thwExtTkz1?.[String(extId)];
      return entry ? (entry.name || extId) + ' (' + extId + ')' : extId;
    };
    const entries = Object.entries(cfg.thwDefaultFgr || {});
    if (!entries.length) return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';
    const rows = entries.map(([tid, extId]) => `
      <tr data-tid="${esc(tid)}">
        <td style="font-size:12px;color:#667;">${esc(typLabel(tid))} <span style="color:#aaa;font-size:10px;">(${esc(tid)})</span></td>
        <td style="font-size:12px;">${esc(fgrLabel(extId))}</td>
        <td><button class="lss-btn lss-btn-del thw-dfgr-d" style="padding:2px 8px;font-size:12px;">✕</button></td>
      </tr>`).join('');
    return `<table class="lss-tbl"><thead><tr>
      <th>Fahrzeugtyp</th><th>Standard-Fachgruppe</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function bindThwDefaultFgrEvents(ov) {
    const tbl = ov.querySelector('#thw-dfgr-tbl');
    if (!tbl) return;
    tbl.querySelectorAll('.thw-dfgr-d').forEach(btn => {
      btn.addEventListener('click', () => {
        delete cfg.thwDefaultFgr[btn.closest('tr').dataset.tid];
        saveConfig(cfg);
        tbl.innerHTML = buildThwDefaultFgrTable();
        bindThwDefaultFgrEvents(ov);
      });
    });
  }

  function buildBAliasTable() {
    const entries = Object.entries(cfg.buildingAliases || {});
    if (!entries.length) return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';
    const rows = entries.map(([type, alias]) => {
      const isExt = type.includes('-');
      const label = isExt ? `Typ <code>${esc(type.split('-')[0])}</code> + Ext <code>${esc(type.split('-')[1])}</code>` : `Typ <code>${esc(type)}</code>`;
      return `<tr data-type="${esc(type)}">
        <td style="font-size:12px;">${label}</td>
        <td><input class="balias-v" type="text" value="${esc(alias)}" style="width:120px;border:1px solid #c5cad8;border-radius:5px;padding:3px 7px;font-size:13px;"></td>
        <td><button class="lss-btn lss-btn-del balias-d" style="padding:3px 9px;">✕</button></td>
      </tr>`;
    }).join('');
    return `<table class="lss-tbl"><thead><tr>
      <th>Gebäudetyp / Extension</th><th>Alias</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function bindBAliasEvents(ov) {
    ov.querySelectorAll('#balias-tbl .balias-d').forEach(btn => {
      btn.addEventListener('click', () => {
        delete cfg.buildingAliases[btn.closest('tr').dataset.type];
        saveConfig(cfg);
        ov.querySelector('#balias-tbl').innerHTML = buildBAliasTable();
        bindBAliasEvents(ov);
      });
    });
    ov.querySelectorAll('#balias-tbl .balias-v').forEach(inp => {
      inp.addEventListener('change', () => {
        cfg.buildingAliases[inp.closest('tr').dataset.type] = inp.value.trim();
        saveConfig(cfg);
      });
    });
  }

  function buildILSTable() {
    const entries = Object.entries(cfg.ils || {});
    if (!entries.length) return '<p style="color:#888;font-size:13px;">Keine Einträge.</p>';
    return entries.map(([id, _name]) => {
      const name = typeof _name === 'string' ? { '*': _name } : (_name || {});
      return `
      <div class="ils-entry" data-id="${esc(id)}" style="border:1px solid #e2eaf4;border-radius:8px;margin-bottom:10px;overflow:hidden;">
        <div style="padding:8px 12px;background:#f7f9fc;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:12px;font-weight:600;color:#445;">Leitstelle <code>${esc(id)}</code></span>
            <button class="lss-btn ils-nr-toggle" data-id="${esc(id)}"
              style="font-size:11px;padding:3px 10px;margin-left:auto;">📋 Wachen-Nr.</button>
            <button class="lss-btn lss-btn-del ils-d" style="padding:3px 9px;">✕</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
            ${['*','Feuerwehr','Rettung','Polizei','THW'].map(d => {
              const val = typeof name === 'object' ? (name[d] || '') : (d === '*' ? name : '');
              return `<div style="display:flex;flex-direction:column;gap:2px;">
                <label style="font-size:10px;color:#888;font-weight:600;">${d === '*' ? '* Fallback' : d}</label>
                <input class="ils-v" type="text" value="${esc(val)}" placeholder="${d === '*' ? 'Bereichsname' : '(leer = Fallback)'}"
                  data-id="${esc(id)}" data-dienst="${d}"
                  style="border:1px solid #c5cad8;border-radius:5px;padding:4px 7px;font-size:12px;width:100%;box-sizing:border-box;">
              </div>`;
            }).join('')}
          </div>
        </div>
        <div class="ils-nr-panel" data-id="${esc(id)}" style="display:none;border-top:1px solid #e2eaf4;">
          <div style="display:flex;border-bottom:1px solid #e2eaf4;background:#f7f9fc;">
            ${['Feuerwehr','Rettung','Polizei','THW'].map((d,i) =>
              `<button class="ils-dienst-tab${i===0?' ils-dienst-tab-active':''}" data-id="${esc(id)}" data-dienst="${d}"
                style="padding:7px 14px;font-size:12px;border:none;background:none;cursor:pointer;border-bottom:2px solid ${i===0?'#1d5f9e':'transparent'};color:${i===0?'#1d5f9e':'#556'};">${d}</button>`
            ).join('')}
          </div>
          <div style="padding:10px 12px;">
            <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
              <button class="lss-btn lss-btn-blue ils-nr-auto" data-id="${esc(id)}" style="font-size:12px;padding:4px 12px;">
                🔄 Automatisch nummerieren
              </button>
            </div>
            ${['Feuerwehr','Rettung','Polizei','THW'].map((d,i) =>
              `<div class="ils-nr-list" data-id="${esc(id)}" data-dienst="${d}" style="display:${i===0?'block':'none'};">${buildILSNrList(id, d)}</div>`
            ).join('')}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function buildILSNrList(leitstelleId, dienst) {
    const nrMap = cfg.ilsNr?.[String(leitstelleId)] || {};
    const allEntries = Object.entries(nrMap);
    // Nach Dienst filtern falls angegeben
    const entries = dienst ? allEntries.filter(([bid]) => {
      const b = cacheBuilding.get(String(bid));
      return !b || (BUILDING_TYPE_DIENST[b.building_type] || null) === dienst;
    }) : allEntries;
    if (!entries.length) return '<p style="font-size:12px;color:#888;">Noch keine Nummern vergeben.</p>';
    const rows = entries.map(([bid, nr]) => {
      const b = cacheBuilding.get(String(bid));
      const label = b?.caption || ('Gebäude ' + bid);
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;" data-bid="${esc(bid)}">
        <span class="ils-nr-label" data-bid="${esc(bid)}" style="font-size:12px;color:#556;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(label)}">${esc(label)}</span>
        <input class="ils-nr-val" type="text" value="${esc(String(nr))}" data-lid="${esc(leitstelleId)}" data-bid="${esc(bid)}"
          style="width:60px;border:1px solid #c5cad8;border-radius:5px;padding:3px 6px;font-size:12px;text-align:center;">
        <button class="ils-nr-del lss-btn lss-btn-del" data-lid="${esc(leitstelleId)}" data-bid="${esc(bid)}" style="padding:2px 7px;font-size:11px;">✕</button>
      </div>`;
    }).join('');
    // Gebäudenamen nachladen falls noch nicht im Cache
    const missingIds = entries.map(([bid]) => bid).filter(bid => !cacheBuilding.has(String(bid)));
    if (missingIds.length) {
      Promise.all(missingIds.map(bid => getBuilding(bid))).then(() => {
        document.querySelectorAll('.ils-nr-label').forEach(span => {
          const b = cacheBuilding.get(String(span.dataset.bid));
          if (b?.caption) { span.textContent = b.caption; span.title = b.caption; }
        });
      });
    }
    return `<div>${rows}</div>`;
  }

  function bindILSEvents(ov) {
    const tbl = ov.querySelector('#ils-tbl');
    if (!tbl) return;

    // Löschen
    tbl.querySelectorAll('.ils-d').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.ils-entry').dataset.id;
        delete cfg.ils[id];
        delete cfg.ilsNr[id];
        saveConfig(cfg);
        tbl.innerHTML = buildILSTable();
        bindILSEvents(ov);
      });
    });

    // Bereichsname bearbeiten (pro Dienst)
    tbl.querySelectorAll('.ils-v').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = inp.dataset.id;
        const dienst = inp.dataset.dienst || '*';
        if (!cfg.ils[id] || typeof cfg.ils[id] === 'string') {
          cfg.ils[id] = typeof cfg.ils[id] === 'string' ? { '*': cfg.ils[id] } : {};
        }
        const val = inp.value.trim();
        if (val) cfg.ils[id][dienst] = val;
        else delete cfg.ils[id][dienst];
        saveConfig(cfg);
      });
    });

    // Panel togglen
    tbl.querySelectorAll('.ils-nr-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = tbl.querySelector(`.ils-nr-panel[data-id="${btn.dataset.id}"]`);
        if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
      });
    });

    // Dienst-Tabs
    tbl.querySelectorAll('.ils-dienst-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const lid = tab.dataset.id;
        const panel = tbl.querySelector(`.ils-nr-panel[data-id="${lid}"]`);
        panel.querySelectorAll('.ils-dienst-tab').forEach(t => {
          t.style.borderBottomColor = 'transparent';
          t.style.color = '#556';
          t.classList.remove('ils-dienst-tab-active');
        });
        tab.style.borderBottomColor = '#1d5f9e';
        tab.style.color = '#1d5f9e';
        tab.classList.add('ils-dienst-tab-active');
        panel.querySelectorAll('.ils-nr-list').forEach(l => l.style.display = 'none');
        const list = panel.querySelector(`.ils-nr-list[data-dienst="${tab.dataset.dienst}"]`);
        if (list) list.style.display = 'block';
      });
    });

    // Automatisch nummerieren
    tbl.querySelectorAll('.ils-nr-auto').forEach(btn => {
      btn.addEventListener('click', async () => {
        const lid = btn.dataset.id;
        const panel = btn.closest('.ils-nr-panel');
        const activeTab = panel.querySelector('.ils-dienst-tab-active');
        const dienst = activeTab?.dataset.dienst || 'Feuerwehr';
        btn.disabled = true;
        btn.textContent = '…';

        // Alle Gebäude laden und nach Dienst + ILS filtern
        const allBuildings = await apiFetch('/api/buildings');
        const relevant = (allBuildings || [])
          .filter(b => {
            const d = BUILDING_TYPE_DIENST[b.building_type] || null;
            return String(b.leitstelle_building_id) === String(lid) && d === dienst;
          })
          .sort((a, b) => Number(a.id) - Number(b.id));

        if (!cfg.ilsNr) cfg.ilsNr = {};
        if (!cfg.ilsNr[lid]) cfg.ilsNr[lid] = {};

        // Bestehende Einträge für diesen Dienst entfernen, neu nummerieren ab 1
        if (!cfg.ilsNr) cfg.ilsNr = {};
        if (!cfg.ilsNr[lid]) cfg.ilsNr[lid] = {};

        // Gebäude-IDs die zu diesem Dienst gehören ermitteln
        const relevantBids = new Set(relevant.map(b => String(b.id)));
        // Bestehende Einträge dieses Dienstes entfernen
        for (const bid of Object.keys(cfg.ilsNr[lid])) {
          const b = cacheBuilding.get(bid);
          if (b && (BUILDING_TYPE_DIENST[b.building_type] || null) === dienst) {
            delete cfg.ilsNr[lid][bid];
          }
        }

        let nextNr = 1;
        for (const b of relevant) {
          const bid = String(b.id);
          cfg.ilsNr[lid][bid] = nextNr++;
          if (!cacheBuilding.has(bid)) cacheBuilding.set(bid, b);
        }
        saveConfig(cfg);
        const activeList = panel.querySelector(`.ils-nr-list[data-dienst="${dienst}"]`);
            if (activeList) { activeList.innerHTML = buildILSNrList(lid, dienst); bindILSNrEvents(ov, lid, dienst); }
        bindILSNrEvents(ov, lid);
        btn.disabled = false;
        btn.textContent = '🔄 Automatisch nummerieren';
      });
    });

    // Nr-Events
    Object.keys(cfg.ils).forEach(lid => ['Feuerwehr','Rettung','Polizei','THW'].forEach(d => bindILSNrEvents(ov, lid, d)));
  }

  function bindILSNrEvents(ov, lid, dienst) {
    const tbl = ov.querySelector('#ils-tbl');
    if (!tbl) return;
    const selector = dienst ? `.ils-nr-list[data-id="${lid}"][data-dienst="${dienst}"]` : `.ils-nr-list[data-id="${lid}"]`;
    const list = tbl.querySelector(selector);
    if (!list) return;

    list.querySelectorAll('.ils-nr-val').forEach(inp => {
      inp.addEventListener('change', () => {
        if (!cfg.ilsNr[inp.dataset.lid]) cfg.ilsNr[inp.dataset.lid] = {};
        cfg.ilsNr[inp.dataset.lid][inp.dataset.bid] = inp.value.trim();
        saveConfig(cfg);
      });
    });

    list.querySelectorAll('.ils-nr-del').forEach(btn => {
      btn.addEventListener('click', () => {
        delete cfg.ilsNr[btn.dataset.lid]?.[btn.dataset.bid];
        saveConfig(cfg);
        list.innerHTML = buildILSNrList(lid);
        bindILSNrEvents(ov, lid);
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
      { field: 'orgname', label: 'Org-Kurzname', hint: 'Platzhalter {orgname}, leer = auto', type: 'text', placeholder: 'z.B. BRK' },
      { field: 'ort', label: 'Ortsname', hint: 'Platzhalter {ort}', type: 'text', placeholder: 'z.B. Ulm' },
      { field: 'standort', label: '1. TKZ', hint: 'Platzhalter {standort}', type: 'text', placeholder: 'z.B. 1' },
      { field: 'ortsteil', label: 'Ortsteil', hint: 'Platzhalter {ortsteil}', type: 'text', placeholder: 'z.B. Attenhausen' },
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
          // Optionen aus cfg.orgLabels, value = Keyword wenn eindeutig, sonst Rufname
          for (const o of cfg.orgLabels) {
            const opt = doc.createElement('option');
            // keyword aus orgLabels.keyword → sonst Keyword-Suche → sonst Rufname
            // Label ist immer das Keyword für {orgname}
            opt.value = o.label;
            opt.textContent = o.label + ' (' + o.value + ')';
            if (o.label === (props.org || '')) opt.selected = true;
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

    // ILS-Nr Feld (falls Gebäude einer ILS zugeordnet ist)
    const leitstelleId = building?.leitstelle_building_id ? String(building.leitstelle_building_id) : null;
    const _ilsRaw = leitstelleId ? cfg.ils?.[leitstelleId] : null;
    const ilsName = _ilsRaw || null;
    let ilsNrInp = null;
    if (leitstelleId && ilsName) {
      const ilsSection = doc.createElement('div');
      ilsSection.style.cssText = 'margin-bottom:16px;padding:10px 14px;background:#f0f5fb;border:1px solid #c8d8ee;border-radius:8px;';

      const displayIlsName = typeof ilsName === 'object' ? (ilsName['*'] || Object.values(ilsName)[0] || String(leitstelleId)) : (ilsName || String(leitstelleId));
      const ilsLbl = doc.createElement('div');
      ilsLbl.style.cssText = 'font-size:11px;font-weight:700;color:#667;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;';
      ilsLbl.textContent = 'ILS ' + displayIlsName + ' · Wachen-Nummer';
      ilsSection.appendChild(ilsLbl);

      const ilsRow = doc.createElement('div');
      ilsRow.style.cssText = 'display:flex;align-items:center;gap:10px;';

      ilsNrInp = doc.createElement('input');
      ilsNrInp.type = 'text';
      ilsNrInp.placeholder = 'z.B. 3';
      ilsNrInp.value = cfg.ilsNr?.[leitstelleId]?.[String(buildingId)] || '';
      ilsNrInp.style.cssText = 'border:1px solid #c5cad8;border-radius:6px;padding:6px 10px;font-size:13px;width:80px;background:#fff;';
      ilsNrInp.title = 'Platzhalter {ilsnr}';

      const ilsNrHint = doc.createElement('small');
      ilsNrHint.style.cssText = 'font-size:12px;color:#888;';
      ilsNrHint.textContent = 'Platzhalter {ilsnr}';

      const ilsNrAutoBtn = doc.createElement('button');
      ilsNrAutoBtn.type = 'button';
      ilsNrAutoBtn.textContent = '# Auto';
      ilsNrAutoBtn.style.cssText = 'border:1px solid #c5cad8;border-radius:6px;padding:5px 10px;font-size:12px;background:#f7f9fc;cursor:pointer;color:#1d5f9e;';
      ilsNrAutoBtn.title = 'Nächste freie Nummer für diesen Dienst vergeben';
      ilsNrAutoBtn.addEventListener('click', async () => {
        ilsNrAutoBtn.disabled = true;
        ilsNrAutoBtn.textContent = '…';
        // Alle Gebäude der ILS laden damit cacheBuilding befüllt ist
        const allBuildings = await apiFetch('/api/buildings');
        if (allBuildings) {
          for (const b of allBuildings) {
            if (String(b.leitstelle_building_id) === String(leitstelleId)) {
              cacheBuilding.set(String(b.id), b);
            }
          }
        }
        // Alle bereits vergebenen Nummern für diesen Dienst in dieser ILS ermitteln
        const existing = cfg.ilsNr?.[leitstelleId] || {};
        const usedNrs = new Set();
        for (const [bid, nr] of Object.entries(existing)) {
          if (bid === String(buildingId)) continue;
          const b = cacheBuilding.get(String(bid));
          const bDienst = b?.building_type != null ? (BUILDING_TYPE_DIENST[b.building_type] || null) : null;
          if (bDienst === bl_dienst) usedNrs.add(Number(nr));
        }
        let next = 1;
        while (usedNrs.has(next)) next++;
        ilsNrInp.value = String(next);
        ilsNrAutoBtn.disabled = false;
        ilsNrAutoBtn.textContent = '# Auto';
      });

      ilsRow.appendChild(ilsNrInp);
      ilsRow.appendChild(ilsNrAutoBtn);
      ilsRow.appendChild(ilsNrHint);
      ilsSection.appendChild(ilsRow);
      pane.appendChild(ilsSection);
    }

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

    // Gebäude umbenennen Button
    const renameBuildingBtn = doc.createElement('button');
    renameBuildingBtn.type = 'button';
    renameBuildingBtn.textContent = '🏠 Gebäude umbenennen';
    renameBuildingBtn.style.cssText = 'background:linear-gradient(135deg,#1d5f9e,#2278c8);color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:500;cursor:pointer;';
    renameBuildingBtn.addEventListener('click', async () => {
      const leitId = building?.leitstelle_building_id ? String(building.leitstelle_building_id) : null;
      const ils = leitId ? getILS(leitId, bl_dienst) : '';
      const ilsnr = leitId ? (cfg.ilsNr?.[leitId]?.[String(buildingId)] || '') : '';
      const ortVal = inputs['ort']?.value.trim() || ortCoords || '';
      const orgVal = inputs['org']?.value || '';
      const orgLabelVal = cfg.orgLabels?.find(o => o.value === orgVal)?.label || orgVal;
      const tkz1Val = inputs['standort']?.value.trim() || '';
      const ortsteilVal = inputs['ortsteil']?.value.trim() || '';
      const balias = getBuildingAlias(building?.building_type, building?.extensions);
      const _ortsteilB = ortsteilVal.trim();
      const ortsteilB = _ortsteilB ? ' ' + _ortsteilB : '';
      const name = applyBuildingSchema({ balias, ils, ilsnr, ort: ortVal, org: orgVal, orgname: orgLabelVal, tkz1: tkz1Val, ortsteil: ortsteilB }, bl_dienst);
      if (!name) { alert('Gebäudename konnte nicht generiert werden (Schema leer oder fehlende Werte).'); return; }
      const token = doc.querySelector('meta[name="csrf-token"]')?.content
        || doc.querySelector('input[name="authenticity_token"]')?.value
        || window.top?.document?.querySelector('meta[name="csrf-token"]')?.content || '';
      renameBuildingBtn.disabled = true;
      renameBuildingBtn.textContent = '…';
      try {
        const resp = await fetch('/buildings/' + buildingId, {
          method: 'POST', credentials: 'same-origin', redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': token },
          body: new URLSearchParams({ '_method': 'patch', 'building[name]': name, 'authenticity_token': token }),
        });
        if (resp.ok || resp.redirected || resp.status === 0 || resp.status < 500) {
          renameBuildingBtn.textContent = '✓ ' + name;
          renameBuildingBtn.style.background = '#1e863a';
        } else {
          renameBuildingBtn.textContent = '✕ Fehler';
          renameBuildingBtn.style.background = '#dc3545';
        }
      } catch (_) {
        renameBuildingBtn.textContent = '✕ Fehler';
        renameBuildingBtn.style.background = '#dc3545';
      }
      renameBuildingBtn.disabled = false;
    });
    actions.appendChild(renameBuildingBtn);

    saveBtn.addEventListener('click', () => {
      buildingProps[buildingId] = buildingProps[buildingId] || {};
      for (const [field, el] of Object.entries(inputs)) {
        buildingProps[buildingId][field] = el.value.trim();
      }
      saveBuildingProps(buildingProps);
      // ILS-Nr speichern
      if (ilsNrInp && leitstelleId) {
        if (!cfg.ilsNr) cfg.ilsNr = {};
        if (!cfg.ilsNr[leitstelleId]) cfg.ilsNr[leitstelleId] = {};
        const val = ilsNrInp.value.trim();
        if (val) {
          cfg.ilsNr[leitstelleId][String(buildingId)] = val;
        } else {
          delete cfg.ilsNr[leitstelleId][String(buildingId)];
        }
        saveConfig(cfg);
      }
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
        .filter(x => {
            const kzSeq2 = getKennzahl(typeId, bl);
            return kzSeq2
              ? getKennzahl(x.vehicle_type, bl) === kzSeq2
              : String(x.vehicle_type) === String(typeId);
          })
        .sort((a, b) => Number(a.id) - Number(b.id));
      const pos = same.findIndex(x => String(x.id) === String(v.id));
      const startNr = pos >= 0 ? pos + 1 : same.length + 1;
      // THW: vehicleProps default vorbelegen falls noch nicht gesetzt
      if (dienst === 'THW' && vehicleProps[String(v.id)]?.fgr === undefined) {
        if (!vehicleProps[String(v.id)]) vehicleProps[String(v.id)] = {};
        vehicleProps[String(v.id)].fgr = cfg.thwDefaultFgr?.[String(typeId)] ?? 'default';
      }
      const suggested = genCallsigns({
        typeId, typeName, bl, buildingId,
        buildingCaption: buildingCap,
        ortFromCoords: ortCoords,
        dienst, startNr, count: 1,
        vehicleId: v.id,
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

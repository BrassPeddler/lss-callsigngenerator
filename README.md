# Leitstellenspiel – Funkrufnamen-Generator

Ein Userscript für [Leitstellenspiel.de](https://www.leitstellenspiel.de), das Funkrufnamen für Fahrzeuge und Gebäude nach konfigurierbaren Schemata generiert.

## Installation

1. Browsererweiterung installieren: [Tampermonkey](https://www.tampermonkey.net/) (empfohlen) oder Greasemonkey
2. **Loader-Script installieren:** [`lss-callsign-loader.user.js`](lss-callsign-loader.user.js) öffnen und Tampermonkey bestätigen

Das Loader-Script lädt den Core (`lss-callsign-core.js`) automatisch aus diesem Repository und aktualisiert ihn alle 5 Minuten im Hintergrund — kein manuelles Update nötig.

## Funktionsübersicht

### Fahrzeug-Umbenennung

Im Fahrzeug-Bearbeitungs-Formular erscheint ein **„Funkrufname generieren"**-Button. Der generierte Name basiert auf:

- **Bundesland** (automatisch per Koordinaten via Nominatim ermittelt)
- **Dienst** (aus dem Gebäudetyp abgeleitet: Feuerwehr, Rettung, Polizei, THW oder benutzerdefiniert)
- **Organisation** (aus dem Gebäudenamen erkannt oder manuell konfiguriert)
- **Konfigurierbarem Schema** pro Bundesland/Dienst-Kombination

### Gebäude-Tab „Funkrufnamen"

In der Gebäude-Übersicht erscheint ein neuer Tab mit Feldern für:

| Feld | Platzhalter | Beschreibung |
|------|-------------|--------------|
| Organisation | `{org}` | Org-Keyword (z.B. `BRK`) |
| Org-Kurzname | `{orgname}` | Anzeigename (z.B. `Rotkreuz`) |
| Ortsname | `{ort}` | Stadtname |
| 1. TKZ | `{tkz1}` | Standortkennzahl |
| Ortsteil | `{ortsteil}` | Ortsteilname |
| ILS-Wachennummer | `{ilsnr}` | Nummer innerhalb der ILS |

Zusätzlich: **„Gebäude umbenennen"**-Button und **„Alle umbenennen"**-Button für Massen-Umbenennung aller Fahrzeuge des Gebäudes.

### Schema-System

Schemas sind Vorlagen für den Funkrufnamen. Der Schlüssel ist `BL/Dienst` — mit Wildcards für Fallbacks:

```
BL/Dienst  →  */Dienst  →  BL/*  →  */*
```

**Beispiele:**

| Schema | Ergebnis |
|--------|----------|
| `{org} {ort} {tkz2}/{seq}` | `Rotkreuz Augsburg 71/1` |
| `{org} {ort} {tkz1}/{tkz2}-{seq}` | `Rotkreuz Ulm 1/83-1` |
| `Florian {ort} {tkz2}/{seq##}` | `Florian München 1/01` |

**Alle Platzhalter:**

| Platzhalter | Bedeutung |
|-------------|-----------|
| `{org}` | Organisations-Funkkennung (z.B. `Rotkreuz`, `Florian`) |
| `{orgname}` | Org-Kurzname (z.B. `BRK`) |
| `{ort}` | Ortsname |
| `{tkz1}` | 1. TKZ (Standortkennzahl) |
| `{tkz1/}` | 1. TKZ + `/` wenn gesetzt, sonst leer |
| `{tkz1\|1}` | 1. TKZ, Fallback `1` wenn nicht gesetzt |
| `{tkz2}` | 2. TKZ (Fahrzeugkennzahl aus Mapping) |
| `{seq}` | Sequenznummer (1, 2, 3 …) |
| `{seq##}` | Sequenznummer 2-stellig (01, 02 …) |
| `{seq###}` | Sequenznummer 3-stellig (001, 002 …) |
| `{typ}` | Fahrzeugtyp-Name (z.B. `RTW`, `HLF 20`) |
| `{alias}` | Konfigurierter Fahrzeugtyp-Alias, Fallback: `{typ}` |
| `{ils}` | ILS-Bereichsname |
| `{ilsnr}` | ILS-Wachennummer |
| `{ilsnr#}` | ILS-Wachennummer 1-stellig |
| `{ilsnr##}` | ILS-Wachennummer 2-stellig |

### Gebäude-Schemas

Separate Vorlagen für die automatische **Gebäude-Umbenennung** pro Dienst:

```
{balias} {ils} {ilsnr} ({ort}) {org}   →   FW KRU 3 (Augsburg) Florian
```

Zusätzliche Platzhalter: `{balias}` (Gebäudetyp-Alias), `{ortsteil}`.

## Konfiguration

Über **Profil-Menü → Funkrufnamen-Generator** öffnet sich das Konfigurations-Modal mit folgenden Tabs:

### 2. TKZ-Mapping
Weist Fahrzeugtyp-IDs eine Kennzahl zu — bundeslandspezifisch oder global (`*`).

### Schemas
Definiert Callsign-Schemas pro `Bundesland/Dienst`-Kombination. Wildcards (`*`) möglich.

### Org-Kennungen
Schlüsselwörter im Gebäudenamen → Dienst + Anzeigename. Wird für automatische Org-Erkennung verwendet.

### Org-Liste
Dropdown-Optionen für den Rettungs-Org-Auswahl im Gebäude-Tab (Label → Funkkennung).

### Aliase
Überschreibt Fahrzeugtyp-Namen (z.B. `76` → `FRT`).

### THW
- **Erweiterungen**: Extension-Typ → 1. TKZ-Mapping
- **Standard-Fachgruppe**: Fahrzeugtyp → Standard-Extension

### Gebäude-Aliase
Überschreibt Gebäudetyp-Bezeichnungen für den `{balias}`-Platzhalter (z.B. Typ `0` → `FW`).

### Dienste
Verwaltet Dienste für die Schema-Auswahl:

- **Eingebaute Dienste** (schreibgeschützt): Feuerwehr, Rettung, Polizei, THW
- **Benutzerdefinierte Dienste**: Name, Org-Prefix und Org-per-Dropdown konfigurierbar
- **Gebäudetyp-Zuordnungen**: Einzelne LSS-Gebäudetypen einem anderen Dienst zuweisen (z.B. Typ 21 = RHS → eigener Dienst)

### ILS
Ordnet Leitstellen-Gebäude-IDs einen Bereichsnamen zu — dienstspezifisch oder als Fallback (`*`). Verwaltet ILS-Wachennummern pro Dienst mit automatischer Nummerierung.

### Gebäude-Eigenschaften
Übersicht und Bearbeitung aller gespeicherten Gebäude-Eigenschaften (Org, Ort, TKZ1 usw.).

### Massen-Umbenennung
Generiert Vorschau-Tabelle für alle Fahrzeuge aller Gebäude — filterbar nach Dienst und Suchbegriff. Ermöglicht selektive oder vollständige Umbenennung.

### Import / Export
- Export/Import der gesamten Konfiguration als JSON
- Export/Import der Gebäude-Eigenschaften als JSON
- Backup via **Google Drive** (OAuth2)
- Reset auf Standard-Konfiguration

## Technische Details

### Architektur

```
lss-callsign-loader.user.js   ← Tampermonkey-Entry-Point (stabile Installations-URL)
        ↓ lädt via GM_xmlhttpRequest
lss-callsign-core.js          ← Gesamte Logik (wird live aus GitHub geladen)
```

Der Loader-Ansatz erlaubt Updates des Core ohne Neuinstallation des Userscripts.

### Datenpersistenz

| Storage-Key | Inhalt |
|-------------|--------|
| `lss_callsign_v4` | Hauptkonfiguration (Schemas, Org, ILS, Dienste …) |
| `lss_callsign_buildings_v4` | Gebäude-Eigenschaften (Org, Ort, TKZ1 …) |
| `lss_callsign_vehicles_v1` | Fahrzeug-Eigenschaften (THW-Fachgruppe …) |
| `lss_callsign_vehicleTypes_v1` | Fahrzeugtyp-Katalog (localStorage, 24h-Cache) |

### Externe APIs

| API | Verwendung |
|-----|------------|
| `api.leitstellenspiel.de` | Fahrzeug- und Gebäudedaten |
| `nominatim.openstreetmap.org` | Koordinaten → Bundesland |
| `api.lss-manager.de` | Fahrzeugtyp-Katalog (24h-gecacht) |
| `googleapis.com` | Google Drive Backup (optional) |

## Versioning

Das Projekt folgt [Semantic Versioning](https://semver.org/):

- **MAJOR**: Inkompatible Änderungen (z.B. Config-Format-Bruch)
- **MINOR**: Neue Features, rückwärtskompatibel
- **PATCH**: Bugfixes

Die Loader-Version (`lss-callsign-loader.user.js`) und die Core-Version (`CORE_VERSION` in `lss-callsign-core.js`) werden unabhängig versioniert.

## Lizenz

MIT

# PV-Cockpit für Home Assistant

Eine eigenständige Home-Assistant-Lovelace-Karte (`custom:pv-cockpit-card`) für präzise PV-Ertragsprognosen, physikalische Verschattungskalibrierung pro Dachstring, historischen `Ist`-Abgleich und eine optional einblendbare Wetterradar-Karte — **komplett ohne Build-Prozess und ohne API-Keys**.

---

## Highlights

- **Pro-String-PV-Modell:** Beliebig viele Strings/Dachflächen mit individueller Modulanzahl, Modulleistung (`Wp`), Ausrichtung (`Azimut 0–360°`), Neigung (`0–90°`), eigenem `Ist`-Sensor und string-spezifischer Verschattung.
- **Unabhängige Idealkurve (`Ideal (klar)`):** Physikalische Clear-Sky-Referenzkurve (inkl. Temperatur-/Windeinfluss & Standortverschattung), unabhängig vom gewählten Prognose-Modus (`Pess` / `Neutral` / `Opt`).
- **Automatische Sonnentag-Kalibrierung:** Wähle im visuellen Editor ein klares Sonnentagsdatum (global oder pro String) – die Karte erkennt Baum-, Gebäude- und Horizontschatten inkl. Restlichtanteil automatisch aus deinen Home-Assistant-Messdaten.
- **Präziser Ist-Abgleich (`W`, `kW`, `Wh`, `kWh`):** Zeitgewichtete Wh-Integration direkt aus der Home-Assistant-History. Einzelne String-Sensoren werden automatisch summiert – auch bei gemischten Leistungs- (`W`/`kW`) und Energiezählern (`kWh`).
- **Tagesnavigation (`‹ Heute ›`):**
  - Bis zu **7 Tage voraus** (`Heute`, `Morgen`, `+6 Tage`)
  - Bis zu **30 Tage zurück** (inkl. historischem Wetter & Home-Assistant-`Ist`-Verlauf)
  - Strikte `00:00 – 24:00`-Darstellung synchron zwischen Verlaufsgraph und Stundenbalken
- **Multi-Modell-Wetterphysik:** Kombiniert Open-Meteo (`GHI`/`DNI`/`DHI`/Sonnenscheindauer/Nebel/Sichtweite), GeoSphere Austria / ZAMG (`1 km NWP` für Österreich & Nachbarregionen) sowie optional eine lokale `weather.*`-Entität (z. B. Met.no als Fallback & Abgleich).
- **Optionale Wetterradar-Karte:** RainViewer-Regenradar (animiert), DWD-Meteosat-Wolkenfilm, GeoSphere/ZAMG-Wetterwarnungen (Österreich), Ortsnamen-Layer und Vollbildmodus – per Klick direkt ein- und ausblendbar.

---

## Installation

### Variante 1: Manuelle Installation (empfohlen bis HACS-Aufnahme)

1. Lade die Datei [`pv-cockpit-card.js`](public/local/pv-cockpit-card.js) herunter und lege sie in Home Assistant unter:
   ```text
   /config/www/pv-cockpit-card.js
   ```
2. Füge in Home Assistant unter **Einstellungen → Dashboards → Ressourcen** (oben rechts ⋮) eine neue Ressource hinzu:
   - **URL:** `/local/pv-cockpit-card.js`
   - **Typ:** `JavaScript-Modul`
   *(Bei Updates eine Versionsnummer anhängen, z. B. `/local/pv-cockpit-card.js?v=2`, oder Cache mit `Strg+Shift+R` leeren.)*
3. Danach ist die Karte im Dashboard-Editor als **„PV-Cockpit“** verfügbar.

### Variante 2: HACS (Benutzerdefiniertes Repository)

1. Öffne **HACS → Frontend → ⋮ → Benutzerdefinierte Repositories**.
2. Füge die URL dieses GitHub-Repositories mit Kategorie **Dashboard** / **Lovelace** hinzu und installiere **PV-Cockpit**.
3. Lade das Frontend einmal neu (`Strg+Shift+R`).

---

## Konfiguration

Die Karte lässt sich vollständig über den **visuellen Lovelace-Editor** konfigurieren. Alternativ funktioniert auch direktes Dashboard-YAML:

### Beispiel-YAML (Multi-String-Anlage)

```yaml
type: custom:pv-cockpit-card
title: PV-Cockpit
pv_mode: neutral
show_pv_panel: true
show_map: false
hide_night: false
weather_entity: weather.forecast_home
pv_system:
  strings:
    - id: garage_vorne
      name: Garage Vorne
      count: 6
      watt: 440
      azimuth: 180
      tilt: 25
      actual_entity: sensor.inverter_pv1_power
    - id: dach_suedost
      name: Dach SO
      count: 10
      watt: 440
      azimuth: 135
      tilt: 30
      actual_entity: sensor.inverter_pv2_power
    - id: dach_nordwest
      name: Dach NW
      count: 5
      watt: 460
      azimuth: 315
      tilt: 25
      actual_entity: sensor.inverter_pv3_power
```

> **Hinweis zu `Ist`-Sensoren:** Am besten eignen sich **Leistungssensoren (`W` / `kW`)**, da diese zusätzlich die aktuelle Live-Leistung und fein aufgelöste Stundenkurven liefern – **Energiezähler (`Wh` / `kWh`)** werden aber ebenfalls automatisch erkannt (auch gemischt über mehrere Strings). Wenn pro String eigene `actual_entity`-Sensoren hinterlegt sind, summiert die Karte den Gesamtertrag automatisch; ist zusätzlich `pv_actual_entity` gesetzt, bildet dieser Gesamtsensor die Hauptlinie.

---

## Parameter-Referenz

### PV-Anlage & Sensoren

| Option | Typ | Standard | Beschreibung |
| --- | --- | --- | --- |
| `pv_mode` | `string` | `neutral` | Prognose-Charakter: `pessimistisch`, `neutral`, `optimistisch` |
| `pv_system.strings` | `list` | `[]` | Liste der PV-Strings (`id`, `name`, `count`, `watt`, `azimuth`, `tilt`, `actual_entity`, `shading`, `shading_date`) |
| `pv_actual_entity` | `string` | – | Optionaler globaler Leistungs- (`W`/`kW`) oder Energiezähler (`Wh`/`kWh`) als Haupt-Ist-Linie |
| `weather_entity` | `string` | – | Optionale HA-Wetterentität (z. B. `weather.forecast_home`) für lokalen Wolken-/Temp.-Abgleich & Offline-Fallback |
| `pv_shading` | `list` | `[]` | Globale Verschattungssektoren (`from_azimuth`, `to_azimuth`, `min_elevation`, `diffuse_transmission`), falls nicht pro String gesetzt |
| `pv_shading_date` | `string` | – | Datum (`YYYY-MM-DD`) der letzten globalen Sonnentag-Kalibrierung |
| `show_pv_panel` | `boolean` | `true` | PV-Diagnose, Verlaufsgraph und Stundenbalken anzeigen |
| `hide_night` | `boolean` | `false` | Nachtstunden ohne Einstrahlung im Chart und in den Balken ausblenden |

### Standort & optionale Wetterkarte

| Option | Typ | Standard | Beschreibung |
| --- | --- | --- | --- |
| `latitude` | `number` | *HA-Home* | Breitengrad des Standorts (Fallback ohne HA-Standort: `48.3003`) |
| `longitude` | `number` | *HA-Home* | Längengrad des Standorts (Fallback ohne HA-Standort: `14.2858`) |
| `show_map` | `boolean` | `true` | Wetterradar-Karte standardmäßig ausgeklappt anzeigen |
| `height` | `string` | `450px` | Höhe des Karten-Bereichs (z. B. `450px`) |
| `zoom` | `number` | `7` | Initialer Zoom-Faktor der Karte (`3–15`) |
| `auto_play` | `boolean` | `true` | Radar-Animation automatisch starten |
| `opacity` | `number` | `0.75` | Transparenz von Radar und Satellitenwolken (`0.0–1.0`) |
| `show_radar` | `boolean` | `true` | RainViewer-Regenradar beim Öffnen aktiv |
| `show_clouds` | `boolean` | `true` | DWD-Meteosat-Wolkenfilm beim Öffnen aktiv |
| `show_warnings` | `boolean` | `false` | GeoSphere/ZAMG-Wetterwarnungen anzeigen (nur Österreich) |
| `carto_api_key` | `string` | – | Optionaler CartoDB-Key für Dark-Matter-Basemap (Standard nutzt Esri Dark Gray kostenlos ohne Key) |

---

## Funktionsweise im Detail

### 1. Kalibrierung anhand eines klaren Sonnentags
1. Öffne den **visuellen Editor** der Karte.
2. Hinterlege pro String den zugehörigen Home-Assistant-Leistungs- oder Energiesensor (`actual_entity`).
3. Wähle im Bereich **Verschattung (Sonnentag-Kalibrierung)** (pro String oder global) ein Datum, an dem der Himmel weitgehend wolkenlos war, und klicke auf **„Aus Sonnentag kalibrieren“**.
4. Die Karte lädt die 15-Minuten-Messwerte aus deiner HA-History, vergleicht sie mit dem theoretischen Sonnenstand (Azimut & Elevation) für diesen Tag und erzeugt daraus passende Horizont- und Teilschatten-Sektoren (z. B. Nachbarsdach mit 0 % Restlicht vs. Baumkrone mit 25 % Restlicht).

### 2. Zentrierte Stundenfenster
Open-Meteo und GeoSphere/ZAMG liefern stündliche Strahlungs- und Sonnenscheindaten rückblickend für `[HH−1h, HH]`. **PV-Cockpit** richtet Strahlung, Sonnenstand und Home-Assistant-`Ist`-Integration einheitlich auf das **zentrierte Stundenfenster `[HH − 30 Min, HH + 30 Min]`** aus, sodass `Ideal`, `Prognose`, `Ist` und der `"Jetzt"`-Marker zeitlich exakt übereinanderliegen.

---

## Datenquellen & Lizenzen

Alle genutzten Dienste sind frei zugänglich und benötigen keinen API-Schlüssel:

- **Strahlung & Wettermodell:** [Open-Meteo](https://open-meteo.com/) (CC BY 4.0)
- **Alpenraum NWP (1 km) & Warnungen:** [GeoSphere Austria / ZAMG Data Hub](https://data.hub.geosphere.at/) (CC BY 4.0)
- **Satellitenwolken:** Deutscher Wetterdienst (DWD) – WMS (GeoNutzV)
- **Regenradar:** [RainViewer API](https://www.rainviewer.com/)
- **Kartenbasis & Orte:** Esri Dark Gray Canvas · [GeoNames](https://www.geonames.org/) (CC BY 4.0) · [Leaflet](https://leafletjs.com/) (BSD-2-Clause)

---

## Rechtlicher Hinweis

Die Nutzung externer Open-Data-Dienste (Open-Meteo, GeoSphere Austria, DWD, RainViewer) erfolgt direkt durch den Browser des Nutzers im Rahmen der jeweiligen nicht-kommerziellen / Open-Data-Nutzungsbedingungen der Anbieter.

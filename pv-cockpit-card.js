/**
 * PV-Cockpit for Home Assistant Lovelace
 * Standalone ES Module / Classic Script (no build tools required, no API keys)
 * Place at: /config/www/pv-cockpit-card.js -> /local/pv-cockpit-card.js
 *
 * Features:
 * - PV-Ertragsprognose & Idealkurve ("Ideal (klar)") mit Temperatur- & Wind-Einfluss (Open-Meteo, GeoSphere Austria / ZAMG 1km, Met.no)
 * - Automatische Sonnentag-Kalibrierung für Baum- & Horizontverschattung + Ist-Ertragsabgleich (zeitgewichtete Wh-Integration)
 * - Optionaler Karten-/Radar-Hintergrund (Esri Basemap, RainViewer Regenradar, DWD Meteosat-Wolken, ZAMG Wetterwarnungen, GeoNames)
 * - Integrierter visueller Karten-Editor (getConfigElement) für Home Assistant Lovelace
 *
 * Data Attributions (Open Data / Non-Commercial):
 * - Open-Meteo.com (CC BY 4.0) · GeoSphere Austria / ZAMG (CC BY 4.0) · DWD (GeoNutzV)
 * - RainViewer · Tiles © Esri · GeoNames (CC BY 4.0) · Leaflet (BSD-2-Clause)
 */

(function () {
  const CARD_TAG = 'pv-cockpit-card';
  const EDITOR_TAG = 'pv-cockpit-card-editor';
  const LEAFLET_VERSION = '1.9.4';
  const LEAFLET_JS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
  const LEAFLET_CSS_URL = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
  const RAINVIEWER_API_URL = 'https://api.rainviewer.com/public/weather-maps.json';
  const GEOSPHERE_NWP_URL = 'https://dataset.api.hub.geosphere.at/v1/timeseries/forecast/nwp-v2-1h-1km';
  const ZAMG_WARNSTATUS_URL = 'https://warnungen.zamg.at/wsapp/api/getWarnstatus?lang=de';
  const GEONAMES_CITIES_URL =
    'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/geonames-all-cities-with-a-population-1000/records';
  const DE_CITY_NAMES = {
    Vienna: 'Wien',
    Munich: 'München',
    Nuremberg: 'Nürnberg',
    Cologne: 'Köln',
    Prague: 'Prag',
    Zurich: 'Zürich',
    Geneva: 'Genf',
    Milan: 'Mailand',
    Venice: 'Venedig',
    Rome: 'Rom',
    Florence: 'Florenz',
    Naples: 'Neapel',
    Turin: 'Turin',
    Brussels: 'Brüssel',
    Warsaw: 'Warschau',
    Krakow: 'Krakau',
    Copenhagen: 'Kopenhagen',
  };
  const DWD_WMS_URL = 'https://maps.dwd.de/geoserver/dwd/wms';
  const DWD_CLOUD_LAYER = 'dwd:Satellite_meteosat_1km_euat_rgb_day_hrv_and_night_ir108_3h';
  const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const FRAME_INTERVAL_MS = 500; // 500ms animation speed

  // Unabhängiges physikalisches Referenzprofil für die Idealkurve ("Ideal (klar)")
  const PV_IDEAL_PROFILE = {
    iamFloor: 0.96,
    diffuseFactor: 1.0,
    albedo: 0.22,
    lowLightThreshold: 0,
    lowLightFloor: 1.0,
    systemEfficiency: 0.92,
    maxCap: 1.08,
  };

  const PV_MODE_PROFILES = {
    pessimistisch: {
      radMinWeight: 0.68,
      cloudMaxWeight: 0.68,
      overcastStart: 60,
      overcastMax: 0.56,
      overcastDrop: 0.28,
      clearBase: 980,
      partialSunCap: 0.90,
      partialCloudDamp: 0.30,
      fogFactor: 0.55,
      hazeFactor: 0.78,
      stratusFactor: 0.80,
      iamFloor: 0.84,
      diffuseFactor: 0.95,
      albedo: 0.15,
      lowLightThreshold: 140,
      lowLightFloor: 0.75,
      systemEfficiency: 0.765,
      maxCap: 0.94,
      zeroSunAllowThinDni: 0,
    },
    neutral: {
      radMinWeight: 0.45,
      cloudMaxWeight: 0.55,
      overcastStart: 70,
      overcastMax: 0.68,
      overcastDrop: 0.25,
      clearBase: 1030,
      partialSunCap: 1.02,
      partialCloudDamp: 0.18,
      fogFactor: 0.68,
      hazeFactor: 0.86,
      stratusFactor: 0.88,
      iamFloor: 0.90,
      diffuseFactor: 0.98,
      albedo: 0.18,
      lowLightThreshold: 110,
      lowLightFloor: 0.85,
      systemEfficiency: 0.816,
      maxCap: 1.0,
      zeroSunAllowThinDni: 0,
    },
    optimistisch: {
      radMinWeight: 0.25,
      cloudMaxWeight: 0.35,
      overcastStart: 95,
      overcastMax: 0.90,
      overcastDrop: 0.10,
      clearBase: 1100,
      partialSunCap: 1.15,
      partialCloudDamp: 0.05,
      fogFactor: 0.82,
      hazeFactor: 0.94,
      stratusFactor: 0.95,
      iamFloor: 0.95,
      diffuseFactor: 1.0,
      albedo: 0.20,
      lowLightThreshold: 0,
      lowLightFloor: 1.0,
      systemEfficiency: 0.867,
      maxCap: 1.05,
      zeroSunAllowThinDni: 0.35,
    },
  };

  function normalizePvModeValue(raw) {
    const val = String(raw || '').trim().toLowerCase();
    if (val === 'optimistisch' || val === 'optimistic') return 'optimistisch';
    if (val === 'pessimistisch' || val === 'pessimistic' || val === 'konservativ' || val === 'conservative') {
      return 'pessimistisch';
    }
    return 'neutral';
  }

  function normalizeAzimuthDeg(deg) {
    const d = Number(deg) % 360;
    return d < 0 ? d + 360 : d;
  }

  function slugifyStringKey(raw, fallbackIdx = 0) {
    const base = String(raw || '')
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return base || `string_${fallbackIdx + 1}`;
  }

  function azimuthToCardinalKey(azDeg) {
    const az = normalizeAzimuthDeg(azDeg);
    if (az >= 315 || az < 45) return 'nord';
    if (az >= 45 && az < 135) return 'ost';
    if (az >= 135 && az < 225) return 'sued';
    return 'west';
  }

  function normalizePvSystemConfig(raw) {
    const hasCustomPv = Boolean(raw && typeof raw === 'object');
    const src = hasCustomPv ? raw : {};
    const defaultTilt = Number.isFinite(Number(src.tilt))
      ? Math.min(90, Math.max(0, Number(src.tilt)))
      : 25;

    const parseSide = (side, sideKey, defTilt, defAzimuth, defLabel) => {
      const obj = side && typeof side === 'object' ? side : {};
      const count = Math.max(0, Number(obj.count) || 0);
      const watt = Math.max(0, Number(obj.watt) || 0);
      const hasCustomTilt =
        obj.tilt !== undefined &&
        obj.tilt !== null &&
        obj.tilt !== '' &&
        Number.isFinite(Number(obj.tilt));
      const tilt = hasCustomTilt ? Number(obj.tilt) : defTilt;
      const hasCustomAzimuth =
        obj.azimuth !== undefined &&
        obj.azimuth !== null &&
        obj.azimuth !== '' &&
        Number.isFinite(Number(obj.azimuth));
      const azimuth = hasCustomAzimuth
        ? normalizeAzimuthDeg(Number(obj.azimuth))
        : defAzimuth;
      const rawLabel =
        obj.name !== undefined && obj.name !== null
          ? String(obj.name).trim()
          : obj.label !== undefined && obj.label !== null
          ? String(obj.label).trim()
          : '';
      const actualEntity = String(obj.actual_entity ?? obj.actualEntity ?? '').trim();
      const shading = normalizePvShadingConfig(obj.shading);
      const shadingDate = obj.shading_date ? String(obj.shading_date).trim() : '';

      return {
        id: String(obj.id || sideKey),
        key: sideKey,
        label: rawLabel || defLabel,
        hasCustomLabel: Boolean(rawLabel),
        count,
        watt,
        wp: count * watt,
        tilt: Math.min(90, Math.max(0, tilt)),
        hasCustomTilt,
        azimuth,
        hasCustomAzimuth,
        actual_entity: actualEntity,
        shading,
        shading_date: shadingDate,
      };
    };

    if (Array.isArray(src.strings)) {
      const seenIds = new Set();
      const strings = src.strings.map((item, idx) => {
        const obj = item && typeof item === 'object' ? item : {};
        const rawLabel = String(obj.name ?? obj.label ?? '').trim();
        const rawId = String(obj.id || obj.key || '').trim();
        let id = rawId || slugifyStringKey(rawLabel, idx);
        while (seenIds.has(id)) {
          id = `${id}_${idx + 1}`;
        }
        seenIds.add(id);
        return parseSide(
          { ...obj, id },
          id,
          defaultTilt,
          180,
          rawLabel || `String ${idx + 1}`
        );
      });

      const aggregateCardinal = (cardKey, defAz, defLabel) => {
        const matching = strings.filter((s) => azimuthToCardinalKey(s.azimuth) === cardKey);
        const wp = matching.reduce((acc, s) => acc + s.wp, 0);
        const count = matching.reduce((acc, s) => acc + s.count, 0);
        const watt = count > 0 ? Math.round(wp / count) : 0;
        const avgTilt =
          wp > 0
            ? matching.reduce((acc, s) => acc + s.tilt * s.wp, 0) / wp
            : defaultTilt;
        return {
          id: cardKey,
          key: cardKey,
          label: defLabel,
          hasCustomLabel: false,
          count,
          watt,
          wp,
          tilt: avgTilt,
          hasCustomTilt: false,
          azimuth: defAz,
          hasCustomAzimuth: false,
          actual_entity: matching.length === 1 ? matching[0].actual_entity : '',
          shading: matching.length === 1 ? matching[0].shading : [],
          shading_date: matching.length === 1 ? matching[0].shading_date : '',
        };
      };

      return {
        tilt: defaultTilt,
        isStringList: true,
        strings,
        ost: aggregateCardinal('ost', 90, 'Ost'),
        sued: aggregateCardinal('sued', 180, 'Süd'),
        west: aggregateCardinal('west', 270, 'West'),
        nord: aggregateCardinal('nord', 0, 'Nord'),
        totalWp: strings.reduce((acc, s) => acc + s.wp, 0),
      };
    }

    const ost = parseSide(src.ost || src.east, 'ost', defaultTilt, 90, 'Ost');
    const sued = parseSide(
      hasCustomPv ? src.sued || src['süd'] || src.south : { count: 22, watt: 430 },
      'sued',
      defaultTilt,
      180,
      'Süd'
    );
    const west = parseSide(src.west, 'west', defaultTilt, 270, 'West');
    const nord = parseSide(src.nord || src.north, 'nord', defaultTilt, 0, 'Nord');
    const legacySides = [ost, sued, west, nord];
    const activeLegacy = legacySides.filter(
      (s) => s.wp > 0 || Boolean(s.actual_entity) || s.shading.length > 0 || Boolean(s.shading_date)
    );

    return {
      tilt: defaultTilt,
      isStringList: false,
      strings: activeLegacy.length > 0 ? activeLegacy : [sued],
      ost,
      sued,
      west,
      nord,
      totalWp: ost.wp + sued.wp + west.wp + nord.wp,
    };
  }

  function formatAzimuthSectorLabel(fromAz, toAz) {
    const mid = fromAz <= toAz ? (fromAz + toAz) / 2 : normalizeAzimuthDeg((fromAz + toAz + 360) / 2);
    if (mid < 60 || mid >= 300) return 'Nord';
    if (mid < 115) return 'Ost';
    if (mid < 155) return 'Morgens (SO)';
    if (mid < 205) return 'Mittag (Süd)';
    if (mid < 250) return 'Nachmittag (SW)';
    return 'Abend (West)';
  }

  function normalizePvShadingConfig(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const fromAz = Number(item.from_azimuth ?? item.fromAzimuth ?? item.from ?? 0);
      const toAz = Number(item.to_azimuth ?? item.toAzimuth ?? item.to ?? 0);
      const minEl = Number(item.min_elevation ?? item.minElevation ?? item.elevation ?? 0);
      const trans = item.transmission !== undefined ? Number(item.transmission) : 0.15;
      if (!Number.isFinite(fromAz) || !Number.isFinite(toAz) || !Number.isFinite(minEl)) continue;
      if (minEl <= 0) continue;
      const f = Math.round(normalizeAzimuthDeg(fromAz) * 10) / 10;
      const t = Math.round(normalizeAzimuthDeg(toAz) * 10) / 10;
      const el = Math.min(85, Math.max(1, Math.round(minEl * 2) / 2));
      const tr = Number.isFinite(trans) ? Math.min(0.95, Math.max(0, Math.round(trans * 100) / 100)) : 0.15;
      const label = item.label ? String(item.label).trim() : formatAzimuthSectorLabel(f, t);
      out.push({
        from_azimuth: f,
        to_azimuth: t,
        min_elevation: el,
        transmission: tr,
        label,
      });
    }
    return out.sort((a, b) => a.from_azimuth - b.from_azimuth);
  }

  function azimuthInSector(azDeg, fromAz, toAz) {
    const az = normalizeAzimuthDeg(azDeg);
    const f = normalizeAzimuthDeg(fromAz);
    const t = normalizeAzimuthDeg(toAz);
    if (f <= t) return az >= f && az <= t;
    return az >= f || az <= t;
  }

  function computeShadingDirectFactor(elevationRad, azimuthRad, shadingSectors) {
    if (!Array.isArray(shadingSectors) || shadingSectors.length === 0) return 1;
    const elDeg = (elevationRad * 180) / Math.PI;
    if (elDeg <= 0) return 1;
    const azDeg = normalizeAzimuthDeg((azimuthRad * 180) / Math.PI);

    let minFactor = 1;
    const halfBand = 1.5;
    for (const sec of shadingSectors) {
      if (!azimuthInSector(azDeg, sec.from_azimuth, sec.to_azimuth)) continue;
      const minEl = sec.min_elevation;
      const trans = sec.transmission;
      if (elDeg >= minEl + halfBand) continue;
      if (elDeg <= minEl - halfBand) {
        minFactor = Math.min(minFactor, trans);
      } else {
        const u = (elDeg - (minEl - halfBand)) / (2 * halfBand);
        const smooth = u * u * (3 - 2 * u);
        const f = trans + (1 - trans) * smooth;
        minFactor = Math.min(minFactor, f);
      }
    }
    return minFactor;
  }

  function computeSolarPosition(isoTime, utcOffsetSec, latDeg, lonDeg) {
    const [datePart, timePart] = String(isoTime || '').split('T');
    const [y, m, d] = (datePart || '2026-01-01').split('-').map(Number);
    const [hh, mm] = (timePart || '12:00').split(':').map(Number);
    const utcMs =
      Date.UTC(y || 2026, (m || 1) - 1, d || 1, hh || 0, mm || 0) -
      (Number(utcOffsetSec) || 0) * 1000;
    const dt = new Date(utcMs);

    const startOfYear = Date.UTC(dt.getUTCFullYear(), 0, 0);
    const dayOfYear = Math.floor((utcMs - startOfYear) / 86400000);
    const utcMinutes = dt.getUTCHours() * 60 + dt.getUTCMinutes();

    const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcMinutes / 60 - 12) / 24);
    const eqTime =
      229.18 *
      (0.000075 +
        0.001868 * Math.cos(gamma) -
        0.032077 * Math.sin(gamma) -
        0.014615 * Math.cos(2 * gamma) -
        0.040849 * Math.sin(2 * gamma));

    const decl =
      0.006918 -
      0.399912 * Math.cos(gamma) +
      0.070257 * Math.sin(gamma) -
      0.006758 * Math.cos(2 * gamma) +
      0.000907 * Math.sin(2 * gamma) -
      0.002697 * Math.cos(3 * gamma) +
      0.00148 * Math.sin(3 * gamma);

    let tst = (utcMinutes + eqTime + 4 * lonDeg) % 1440;
    if (tst < 0) tst += 1440;

    const haDeg = tst / 4 - 180;
    const haRad = (haDeg * Math.PI) / 180;
    const latRad = (latDeg * Math.PI) / 180;

    const cosZenith = Math.min(
      1,
      Math.max(-1, Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(haRad))
    );
    const zenith = Math.acos(cosZenith);
    const elevation = Math.PI / 2 - zenith;

    let sunAzimuth = Math.PI;
    const denom = Math.cos(latRad) * Math.sin(zenith);
    if (Math.abs(denom) > 1e-5) {
      const cosAz = Math.min(
        1,
        Math.max(-1, (Math.sin(decl) - Math.sin(latRad) * cosZenith) / denom)
      );
      const azFromNorth = Math.acos(cosAz);
      sunAzimuth = haDeg > 0 ? 2 * Math.PI - azFromNorth : azFromNorth;
    }

    return { elevation, sunAzimuth, dayOfYear };
  }

  // Zentrierte 10-Minuten-Schritte rund um jeden Stundenpunkt HH:00 ([HH-30m, HH+30m]), passend zu Ist & zentrierter Strahlung
  const HOURLY_SUB_SHIFTS_MIN = [-25, -15, -5, 5, 15, 25];

  function shiftIsoTimeMinutes(isoTime, shiftMinutes) {
    const [datePart, timePart] = String(isoTime || '').split('T');
    const [y, m, d] = (datePart || '2026-01-01').split('-').map(Number);
    const [hh, mm] = (timePart || '12:00').split(':').map(Number);
    const ms =
      Date.UTC(y || 2026, (m || 1) - 1, d || 1, hh || 0, mm || 0) +
      (Number(shiftMinutes) || 0) * 60000;
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
      dt.getUTCDate()
    ).padStart(2, '0')}T${String(dt.getUTCHours()).padStart(2, '0')}:${String(
      dt.getUTCMinutes()
    ).padStart(2, '0')}`;
  }

  function computeHourlyEffectiveSolarPosition(isoHourEnd, utcOffsetSec, latDeg, lonDeg) {
    let weightedMin = 0;
    let totalWeight = 0;
    for (const sh of HOURLY_SUB_SHIFTS_MIN) {
      const pos = computeSolarPosition(
        shiftIsoTimeMinutes(isoHourEnd, sh),
        utcOffsetSec,
        latDeg,
        lonDeg
      );
      if (pos.elevation > 0.005) {
        const w = Math.max(0.01, Math.sin(pos.elevation));
        weightedMin += sh * w;
        totalWeight += w;
      }
    }
    const effectiveShift = totalWeight > 0 ? Math.round(weightedMin / totalWeight) : 0;
    return computeSolarPosition(
      shiftIsoTimeMinutes(isoHourEnd, effectiveShift),
      utcOffsetSec,
      latDeg,
      lonDeg
    );
  }

  function computeClearSkyIrradiance(elevationRad, dayOfYear = 180) {
    if (!Number.isFinite(elevationRad) || elevationRad <= 0.005) {
      return { ghi: 0, dni: 0, dhi: 0 };
    }
    const sinEl = Math.sin(elevationRad);
    const elDeg = (elevationRad * 180) / Math.PI;
    const doy = Number.isFinite(dayOfYear) ? dayOfYear : 180;
    const ecc = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
    const am = 1 / (sinEl + 0.50572 * Math.pow(elDeg + 6.07995, -1.6364));
    const dni = 1367 * ecc * Math.pow(0.73, Math.pow(am, 0.678));
    const dhi = 142 * ecc * Math.pow(sinEl, 0.5);
    const ghi = dni * sinEl + dhi;
    return { ghi, dni, dhi };
  }

  function computeHourlyClearSkyIrradiance(isoHourEnd, utcOffsetSec, latDeg, lonDeg) {
    let sumGhi = 0;
    let sumDni = 0;
    let sumDhi = 0;
    const n = HOURLY_SUB_SHIFTS_MIN.length;
    for (const sh of HOURLY_SUB_SHIFTS_MIN) {
      const pos = computeSolarPosition(
        shiftIsoTimeMinutes(isoHourEnd, sh),
        utcOffsetSec,
        latDeg,
        lonDeg
      );
      const irr = computeClearSkyIrradiance(pos.elevation, pos.dayOfYear);
      sumGhi += irr.ghi;
      sumDni += irr.dni;
      sumDhi += irr.dhi;
    }
    return {
      ghi: sumGhi / n,
      dni: sumDni / n,
      dhi: sumDhi / n,
    };
  }

  function computePoaWattsForSide(
    side,
    solarPos,
    ghi,
    dni,
    dhi,
    prof,
    directShadeFactor = 1,
    tempC = null,
    windMs = 1.5
  ) {
    if (!side || side.wp <= 0) return 0;
    if (ghi <= 0 && dni <= 0 && dhi <= 0) return 0;

    const beta = (side.tilt * Math.PI) / 180;
    const azPanel = (side.azimuth * Math.PI) / 180;

    let directOnTilt = 0;
    if (solarPos.elevation > 0.01) {
      const cosTheta = Math.max(
        0,
        Math.sin(solarPos.elevation) * Math.cos(beta) +
          Math.cos(solarPos.elevation) * Math.sin(beta) * Math.cos(solarPos.sunAzimuth - azPanel)
      );
      const iam =
        cosTheta < 0.4
          ? Math.max(prof.iamFloor, 1 - (1 - prof.iamFloor) * (1 - cosTheta / 0.4))
          : 1;
      directOnTilt = dni * cosTheta * iam * directShadeFactor;
    }

    const diffuseOnTilt = dhi * ((1 + Math.cos(beta)) / 2) * prof.diffuseFactor;
    const groundReflected = ghi * prof.albedo * ((1 - Math.cos(beta)) / 2);
    const poa = Math.max(0, directOnTilt + diffuseOnTilt + groundReflected);

    if (poa < 10) return 0;
    const lowLightFactor =
      prof.lowLightThreshold > 0 && poa < prof.lowLightThreshold
        ? prof.lowLightFloor + (1 - prof.lowLightFloor) * (poa / prof.lowLightThreshold)
        : 1;

    let tempFactor = 1;
    if (Number.isFinite(tempC)) {
      const windCool = Math.max(0, Math.min(8, Number.isFinite(windMs) ? windMs : 1.5));
      const noctDelta = Math.max(12, 26 - windCool * 1.4);
      const cellTemp = tempC + (poa / 800) * noctDelta;
      tempFactor = Math.min(1.12, Math.max(0.78, 1 - 0.0035 * (cellTemp - 25)));
    }

    const rawWatts = side.wp * (poa / 1000) * prof.systemEfficiency * lowLightFactor * tempFactor;
    return Math.round(Math.min(side.wp * prof.maxCap, rawWatts));
  }

  function getDirectShadeForSide(side, solarPos, globalShadingSectors) {
    if (Array.isArray(side?.shading) && side.shading.length > 0) {
      return computeShadingDirectFactor(solarPos.elevation, solarPos.sunAzimuth, side.shading);
    }
    if (side?.shading_date) {
      return 1;
    }
    return computeShadingDirectFactor(solarPos.elevation, solarPos.sunAzimuth, globalShadingSectors);
  }

  function getPvSystemStrings(pvSystem) {
    if (!pvSystem || typeof pvSystem !== 'object') return [];
    if (Array.isArray(pvSystem.strings) && pvSystem.strings.length > 0) {
      return pvSystem.strings;
    }
    return [pvSystem.ost, pvSystem.sued, pvSystem.west, pvSystem.nord].filter(Boolean);
  }

  function computeSideCosIncidence(side, solarPos) {
    if (!side || side.wp <= 0 || solarPos.elevation <= 0.01) return 0;
    const beta = (side.tilt * Math.PI) / 180;
    const azPanel = (side.azimuth * Math.PI) / 180;
    return Math.max(
      0,
      Math.sin(solarPos.elevation) * Math.cos(beta) +
        Math.cos(solarPos.elevation) * Math.sin(beta) * Math.cos(solarPos.sunAzimuth - azPanel)
    );
  }

  function computePvEstimateWithShading({
    pvSystem,
    pvMode,
    isoTime,
    utcOffsetSec,
    latDeg,
    lonDeg,
    ghi,
    dni,
    dhi,
    shadingSectors = [],
    tempC = null,
    windMs = 1.5,
  }) {
    if (!pvSystem || pvSystem.totalWp <= 0) {
      return {
        totalWp: 0,
        totalWatts: 0,
        ostWatts: 0,
        suedWatts: 0,
        westWatts: 0,
        nordWatts: 0,
        stringWatts: [],
        shadeFactor: 1,
      };
    }

    const prof = PV_MODE_PROFILES[pvMode] || PV_MODE_PROFILES.neutral;
    const solarPos = computeSolarPosition(isoTime, utcOffsetSec, latDeg, lonDeg);

    const strings = getPvSystemStrings(pvSystem);
    const stringWatts = [];
    const cardinal = { ost: 0, sued: 0, west: 0, nord: 0 };
    let totalWatts = 0;
    let shadeWeightSum = 0;
    let shadeValueSum = 0;

    for (let k = 0; k < strings.length; k++) {
      const s = strings[k];
      if (!s) continue;
      if (s.wp <= 0) {
        stringWatts.push({
          id: s.id || s.key,
          key: s.key || s.id,
          label: s.label,
          watts: 0,
          wp: 0,
          shadeFactor: 1,
          actual_entity: s.actual_entity || '',
        });
        continue;
      }
      const sf = getDirectShadeForSide(s, solarPos, shadingSectors);
      const watts = computePoaWattsForSide(s, solarPos, ghi, dni, dhi, prof, sf, tempC, windMs);
      totalWatts += watts;
      const cKey = azimuthToCardinalKey(s.azimuth);
      cardinal[cKey] += watts;
      stringWatts.push({
        id: s.id || s.key,
        key: s.key || s.id,
        label: s.label,
        watts,
        wp: s.wp,
        shadeFactor: sf,
        actual_entity: s.actual_entity || '',
      });
      const w = s.wp * Math.max(0.05, computeSideCosIncidence(s, solarPos));
      shadeValueSum += sf * w;
      shadeWeightSum += w;
    }

    const shadeFactor =
      shadeWeightSum > 0
        ? shadeValueSum / shadeWeightSum
        : computeShadingDirectFactor(solarPos.elevation, solarPos.sunAzimuth, shadingSectors);

    return {
      totalWp: pvSystem.totalWp,
      totalWatts,
      ostWatts: cardinal.ost,
      suedWatts: cardinal.sued,
      westWatts: cardinal.west,
      nordWatts: cardinal.nord,
      stringWatts,
      shadeFactor,
    };
  }

  function computeHourlyPvEstimateWithShading({
    pvSystem,
    pvMode,
    isoHourEnd,
    utcOffsetSec,
    latDeg,
    lonDeg,
    ghi,
    dni,
    dhi,
    shadingSectors = [],
    tempC = null,
    windMs = 1.5,
  }) {
    if (!pvSystem || pvSystem.totalWp <= 0) {
      return {
        totalWp: 0,
        totalWatts: 0,
        ostWatts: 0,
        suedWatts: 0,
        westWatts: 0,
        nordWatts: 0,
        stringWatts: [],
        shadeFactor: 1,
      };
    }

    const prof = PV_MODE_PROFILES[pvMode] || PV_MODE_PROFILES.neutral;
    const daySamples = [];
    for (const sh of HOURLY_SUB_SHIFTS_MIN) {
      const solarPos = computeSolarPosition(
        shiftIsoTimeMinutes(isoHourEnd, sh),
        utcOffsetSec,
        latDeg,
        lonDeg
      );
      if (solarPos.elevation > 0.005) {
        daySamples.push(solarPos);
      }
    }

    if (daySamples.length === 0) {
      return computePvEstimateWithShading({
        pvSystem,
        pvMode,
        isoTime: isoHourEnd,
        utcOffsetSec,
        latDeg,
        lonDeg,
        ghi,
        dni,
        dhi,
        shadingSectors,
        tempC,
        windMs,
      });
    }

    const strings = getPvSystemStrings(pvSystem);
    const stringSums = new Array(strings.length).fill(0);
    const stringShadeSums = new Array(strings.length).fill(0);
    let shadeValueSum = 0;
    let shadeWeightSum = 0;

    for (const solarPos of daySamples) {
      for (let k = 0; k < strings.length; k++) {
        const s = strings[k];
        if (!s || s.wp <= 0) continue;
        const sf = getDirectShadeForSide(s, solarPos, shadingSectors);
        stringSums[k] += computePoaWattsForSide(s, solarPos, ghi, dni, dhi, prof, sf, tempC, windMs);
        stringShadeSums[k] += sf;
        const w = s.wp * Math.max(0.05, computeSideCosIncidence(s, solarPos));
        shadeValueSum += sf * w;
        shadeWeightSum += w;
      }
    }

    const cnt = daySamples.length;
    const cardinal = { ost: 0, sued: 0, west: 0, nord: 0 };
    const stringWatts = [];
    let totalWatts = 0;

    for (let k = 0; k < strings.length; k++) {
      const s = strings[k];
      if (!s) continue;
      const watts = s.wp > 0 ? Math.round(stringSums[k] / cnt) : 0;
      const avgSf = s.wp > 0 ? stringShadeSums[k] / cnt : 1;
      totalWatts += watts;
      cardinal[azimuthToCardinalKey(s.azimuth)] += watts;
      stringWatts.push({
        id: s.id || s.key,
        key: s.key || s.id,
        label: s.label,
        watts,
        wp: s.wp,
        shadeFactor: avgSf,
        actual_entity: s.actual_entity || '',
      });
    }

    return {
      totalWp: pvSystem.totalWp,
      totalWatts,
      ostWatts: cardinal.ost,
      suedWatts: cardinal.sued,
      westWatts: cardinal.west,
      nordWatts: cardinal.nord,
      stringWatts,
      shadeFactor: shadeWeightSum > 0 ? shadeValueSum / shadeWeightSum : 1,
    };
  }

  function computeHourlyClearSkyPvEstimate({
    pvSystem,
    isoHourEnd,
    utcOffsetSec,
    latDeg,
    lonDeg,
    shadingSectors = [],
    tempC = null,
    windMs = 1.5,
  }) {
    const prof = PV_IDEAL_PROFILE;
    const hasPv = Boolean(pvSystem && pvSystem.totalWp > 0);
    const n = HOURLY_SUB_SHIFTS_MIN.length;
    const strings = hasPv ? getPvSystemStrings(pvSystem) : [];
    const stringSums = new Array(strings.length).fill(0);

    let ghiSum = 0;
    let dniSum = 0;
    let dhiSum = 0;
    let shadeValueSum = 0;
    let shadeWeightSum = 0;

    for (const sh of HOURLY_SUB_SHIFTS_MIN) {
      const solarPos = computeSolarPosition(
        shiftIsoTimeMinutes(isoHourEnd, sh),
        utcOffsetSec,
        latDeg,
        lonDeg
      );
      const irr = computeClearSkyIrradiance(solarPos.elevation, solarPos.dayOfYear);
      ghiSum += irr.ghi;
      dniSum += irr.dni;
      dhiSum += irr.dhi;

      if (solarPos.elevation > 0.005) {
        if (hasPv) {
          for (let k = 0; k < strings.length; k++) {
            const s = strings[k];
            if (!s || s.wp <= 0) continue;
            const sf = getDirectShadeForSide(s, solarPos, shadingSectors);
            stringSums[k] += computePoaWattsForSide(
              s,
              solarPos,
              irr.ghi,
              irr.dni,
              irr.dhi,
              prof,
              sf,
              tempC,
              windMs
            );
            const w = s.wp * Math.max(0.05, computeSideCosIncidence(s, solarPos));
            shadeValueSum += sf * w;
            shadeWeightSum += w;
          }
        } else {
          const sf = computeShadingDirectFactor(solarPos.elevation, solarPos.sunAzimuth, shadingSectors);
          shadeValueSum += sf;
          shadeWeightSum += 1;
        }
      }
    }

    const cardinal = { ost: 0, sued: 0, west: 0, nord: 0 };
    const stringWatts = [];
    let totalWatts = 0;

    if (hasPv) {
      for (let k = 0; k < strings.length; k++) {
        const s = strings[k];
        if (!s) continue;
        const watts = s.wp > 0 ? Math.round(stringSums[k] / n) : 0;
        totalWatts += watts;
        cardinal[azimuthToCardinalKey(s.azimuth)] += watts;
        stringWatts.push({
          id: s.id || s.key,
          key: s.key || s.id,
          label: s.label,
          watts,
          wp: s.wp,
          actual_entity: s.actual_entity || '',
        });
      }
    }

    return {
      totalWp: hasPv ? pvSystem.totalWp : 0,
      totalWatts,
      ostWatts: cardinal.ost,
      suedWatts: cardinal.sued,
      westWatts: cardinal.west,
      nordWatts: cardinal.nord,
      stringWatts,
      shadeFactor: shadeWeightSum > 0 ? shadeValueSum / shadeWeightSum : 1,
      clearGhi: ghiSum / n,
      clearDni: dniSum / n,
      clearDhi: dhiSum / n,
    };
  }

  function calibrateShadingFromDayBuckets({
    buckets,
    pvSystem,
    targetString = null,
    pvMode,
    latDeg,
    lonDeg,
    utcOffsetSec,
    bucketMinutes = 15,
  }) {
    if (!Array.isArray(buckets) || buckets.length < 4) {
      return { ok: false, error: 'Zu wenige Messpunkte für diesen Tag in Home Assistant.' };
    }
    const calibPvSystem =
      targetString && targetString.wp > 0
        ? {
            tilt: targetString.tilt,
            isStringList: true,
            strings: [{ ...targetString, shading: [], shading_date: '' }],
            totalWp: targetString.wp,
          }
        : pvSystem
        ? {
            ...pvSystem,
            strings: getPvSystemStrings(pvSystem).map((s) => ({
              ...s,
              shading: [],
              shading_date: '',
            })),
          }
        : null;

    if (!calibPvSystem || calibPvSystem.totalWp <= 0) {
      return { ok: false, error: 'Bitte zuerst PV-Module für diesen String konfigurieren.' };
    }

    const evaluated = [];
    let maxDayEl = 0;
    let maxActualWatts = 0;
    let clearPeakWatts = 0;

    for (const b of buckets) {
      if (!Number.isFinite(b.actualWatts) || b.actualWatts < 0) continue;
      const pos = computeSolarPosition(b.midIso, utcOffsetSec, latDeg, lonDeg);
      const elDeg = (pos.elevation * 180) / Math.PI;
      const azDeg = normalizeAzimuthDeg((pos.sunAzimuth * 180) / Math.PI);
      if (elDeg < 2.5) continue;

      const irr = computeClearSkyIrradiance(pos.elevation, pos.dayOfYear);
      const clearFull = computePvEstimateWithShading({
        pvSystem: calibPvSystem,
        pvMode,
        isoTime: b.midIso,
        utcOffsetSec,
        latDeg,
        lonDeg,
        ghi: irr.ghi,
        dni: irr.dni,
        dhi: irr.dhi,
        shadingSectors: [],
      }).totalWatts;
      const clearDiff = computePvEstimateWithShading({
        pvSystem: calibPvSystem,
        pvMode,
        isoTime: b.midIso,
        utcOffsetSec,
        latDeg,
        lonDeg,
        ghi: irr.dhi,
        dni: 0,
        dhi: irr.dhi,
        shadingSectors: [],
      }).totalWatts;

      maxDayEl = Math.max(maxDayEl, elDeg);
      maxActualWatts = Math.max(maxActualWatts, b.actualWatts);
      clearPeakWatts = Math.max(clearPeakWatts, clearFull);
      evaluated.push({
        midIso: b.midIso,
        elDeg,
        azDeg,
        actualWatts: b.actualWatts,
        clearFull,
        clearDiff,
      });
    }

    if (evaluated.length < 5 || clearPeakWatts < 60) {
      return { ok: false, error: 'Keine ausreichenden Tageslicht-Messwerte für diesen Tag gefunden.' };
    }
    if (maxActualWatts < clearPeakWatts * 0.30) {
      return {
        ok: false,
        error: `Peak lag nur bei ${(maxActualWatts / 1000).toFixed(2)} kW (erwartet ~${(clearPeakWatts / 1000).toFixed(1)} kW) – vermutlich stark bewölkter Tag. Bitte einen klaren Sonnentag wählen.`,
      };
    }

    // Unverschatteten String-Referenzmaßstab anhand der stärksten Einstrahlungsphasen berechnen (p90 für Strings mit engem Mittagsfenster)
    const strongRatios = evaluated
      .filter((p) => p.clearFull >= Math.max(90, clearPeakWatts * 0.55) && p.actualWatts >= 40)
      .map((p) => p.actualWatts / p.clearFull)
      .sort((a, b) => a - b);

    const allRatios = evaluated
      .filter((p) => p.clearFull >= 80 && p.actualWatts >= 35)
      .map((p) => p.actualWatts / p.clearFull)
      .sort((a, b) => a - b);

    const pickPercentile = (arr, q) => {
      if (!arr.length) return 1;
      const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * q)));
      return arr[idx];
    };

    const rawScale =
      strongRatios.length >= 4
        ? pickPercentile(strongRatios, 0.9)
        : allRatios.length >= 3
        ? pickPercentile(allRatios, 0.88)
        : 1;
    const scale = Math.min(1.75, Math.max(0.55, rawScale));

    const validPts = evaluated
      .map((p) => {
        const expFull = p.clearFull * scale;
        const expDiff = p.clearDiff * scale;
        const expDirect = Math.max(30, expFull - expDiff);
        const rawTrans = Math.min(1.15, Math.max(0, (p.actualWatts - expDiff) / expDirect));
        return {
          ...p,
          expDirect,
          rawTrans,
        };
      })
      .filter((p) => p.expDirect >= 45);

    if (validPts.length < 4) {
      return { ok: false, error: 'Zu wenige direkte Strahlungspunkte für eine Kalibrierung.' };
    }

    // Leicht glätten (3-Punkt), um einzelne Vögel/Wolkenfetzen zu ignorieren
    for (let i = 0; i < validPts.length; i++) {
      const prev = validPts[Math.max(0, i - 1)].rawTrans;
      const cur = validPts[i].rawTrans;
      const next = validPts[Math.min(validPts.length - 1, i + 1)].rawTrans;
      validPts[i].smoothTrans = prev * 0.25 + cur * 0.5 + next * 0.25;
      validPts[i].shaded = validPts[i].smoothTrans < 0.72;
    }

    const minRunLen = bucketMinutes <= 20 ? 2 : 1;
    const rawRuns = [];
    let curRun = null;
    for (let i = 0; i < validPts.length; i++) {
      if (validPts[i].shaded) {
        if (!curRun) curRun = { startIdx: i, endIdx: i };
        else curRun.endIdx = i;
      } else if (curRun) {
        if (curRun.endIdx - curRun.startIdx + 1 >= minRunLen) rawRuns.push(curRun);
        curRun = null;
      }
    }
    if (curRun && curRun.endIdx - curRun.startIdx + 1 >= minRunLen) {
      rawRuns.push(curRun);
    }

    // Stufen innerhalb eines Schattenbereichs (z. B. 0 % Gebäudeschatten -> 45 % Baumkrone) auftrennen
    const runs = [];
    for (const r of rawRuns) {
      const len = r.endIdx - r.startIdx + 1;
      let splitAt = -1;
      if (len >= 4) {
        let bestDiff = 0;
        for (let k = r.startIdx + 2; k <= r.endIdx - 1; k++) {
          let leftSum = 0;
          let rightSum = 0;
          for (let j = r.startIdx; j < k; j++) leftSum += validPts[j].rawTrans;
          for (let j = k; j <= r.endIdx; j++) rightSum += validPts[j].rawTrans;
          const meanL = leftSum / (k - r.startIdx);
          const meanR = rightSum / (r.endIdx - k + 1);
          const diff = Math.abs(meanR - meanL);
          const stepJump = Math.abs(validPts[k].rawTrans - validPts[k - 1].rawTrans);
          if (diff >= 0.24 && stepJump >= 0.16 && diff > bestDiff) {
            bestDiff = diff;
            splitAt = k;
          }
        }
      }
      if (splitAt > -1) {
        runs.push({ startIdx: r.startIdx, endIdx: splitAt - 1, splitLeft: true });
        runs.push({ startIdx: splitAt, endIdx: r.endIdx, splitRight: true });
      } else {
        runs.push(r);
      }
    }

    const sectors = [];
    for (const r of runs) {
      const first = validPts[r.startIdx];
      const last = validPts[r.endIdx];
      const touchesStart = r.startIdx === 0;
      const touchesEnd = r.endIdx === validPts.length - 1;
      const isRising = last.elDeg >= first.elDeg;

      let edgeEl = Math.max(first.elDeg, last.elDeg);
      if (isRising && r.endIdx + 1 < validPts.length) {
        edgeEl = (last.elDeg + validPts[r.endIdx + 1].elDeg) / 2;
      } else if (!isRising && r.startIdx - 1 >= 0) {
        edgeEl = (first.elDeg + validPts[r.startIdx - 1].elDeg) / 2;
      }

      const fromAz = touchesStart
        ? Math.max(25, Math.round(first.azDeg - 22))
        : r.splitRight
        ? Math.round((validPts[r.startIdx - 1].azDeg + first.azDeg) / 2)
        : Math.round(first.azDeg - 4);
      const toAz = touchesEnd
        ? Math.min(340, Math.round(last.azDeg + 25))
        : r.splitLeft
        ? Math.round((last.azDeg + validPts[r.endIdx + 1].azDeg) / 2)
        : Math.round(last.azDeg + 4);

      const coreSlices = validPts
        .slice(r.startIdx, r.endIdx + 1)
        .map((p) => p.rawTrans)
        .sort((a, b) => a - b);
      const medTrans = pickPercentile(coreSlices, 0.5);
      const transmission = Math.min(0.65, Math.max(0, Math.round(medTrans * 20) / 20));
      const minElevation = Math.min(75, Math.max(3, Math.round(edgeEl * 2) / 2));

      sectors.push({
        from_azimuth: normalizeAzimuthDeg(fromAz),
        to_azimuth: normalizeAzimuthDeg(toAz),
        min_elevation: minElevation,
        transmission,
        label: formatAzimuthSectorLabel(fromAz, toAz),
      });
    }

    return {
      ok: true,
      sectors: normalizePvShadingConfig(sectors),
      peakActualWatts: Math.round(maxActualWatts),
      scale: Math.round(scale * 100) / 100,
    };
  }


  function loadLeafletScript() {
    if (window.L) {
      return Promise.resolve(window.L);
    }
    if (window.__pvCockpitLeafletPromise) {
      return window.__pvCockpitLeafletPromise;
    }

    window.__pvCockpitLeafletPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${LEAFLET_JS_URL}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(window.L));
        existing.addEventListener('error', (err) => reject(err));
        return;
      }

      const script = document.createElement('script');
      script.src = LEAFLET_JS_URL;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => {
        if (window.L) {
          resolve(window.L);
        } else {
          reject(new Error('Leaflet geladen, aber window.L nicht verfügbar.'));
        }
      };
      script.onerror = () => reject(new Error('Leaflet.js konnte nicht vom CDN geladen werden.'));
      document.head.appendChild(script);
    });

    return window.__pvCockpitLeafletPromise;
  }

  let cachedLeafletCssText = null;
  async function fetchLeafletCss() {
    if (cachedLeafletCssText) return cachedLeafletCssText;
    try {
      const res = await fetch(LEAFLET_CSS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rawCss = await res.text();
      cachedLeafletCssText = rawCss.replace(
        /url\(["']?images\//g,
        `url("https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/images/`
      );
      return cachedLeafletCssText;
    } catch (_err) {
      return null;
    }
  }

  class PvCockpitCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });

      this._config = {
        zoom: 7,
        height: '450px',
        auto_play: true,
        opacity: 0.75,
        title: '',
        carto_api_key: '',
        show_radar: true,
        show_clouds: true,
        show_warnings: false,
        show_pv_panel: true,
        show_map: true,
        hide_night: false,
        pv_mode: 'neutral',
        pv_actual_entity: '',
        weather_entity: '',
        pv_shading: [],
        pv_shading_date: '',
        pv_system: {
          tilt: 25,
          ost: { count: 0, watt: 0 },
          sued: { count: 22, watt: 430 },
          west: { count: 0, watt: 0 },
          nord: { count: 0, watt: 0 },
        },
      };

      this._hass = null;
      this._map = null;
      this._baseLayers = [];
      this._cloudLayer = null;
      this._warningLayer = null;
      this._homeMarker = null;
      this._frames = [];
      this._frameLayers = [];
      this._currentIndex = 0;

      this._isPlaying = true;
      this._opacity = 0.75;
      this._radarEnabled = true;
      this._cloudsEnabled = true;
      this._warningsEnabled = false;
      this._mapVisible = true;
      this._mapInitializing = false;
      this._pseudoFullscreenTarget = null;
      this._pendingNativeTarget = null;
      this._fullscreenTarget = null;
      this._pseudoFullscreen = false;
      this._isFullscreen = false;
      this._onFullscreenChange = null;
      this._onFullscreenKeyDown = null;
      this._warningCount = null;
      this._pvMode = 'neutral';
      this._pvDayOffset = 0;
      this._pvActualHistory = null;
      this._pvEntityHistories = new Map();
      this._pvPastHistories = new Map();
      this._pvPastFetchingDates = new Set();
      this._pvOpenMeteoPastDays = 14;
      this._pvEntityLastUpdated = new Map();
      this._pvActualFetching = false;
      this._pvLastEntityUpdated = null;
      this._pvLastLiveRenderAt = 0;
      this._weatherForecast = null;
      this._weatherFetching = false;
      this._weatherLastEntityUpdated = null;
      this._pvChartModel = null;
      this._pvData = null;
      this._geosphereData = null;
      this._cityLabelsLayer = null;
      this._fallbackRefLayer = null;
      this._cityCache = new Map();
      this._cityQueryHistory = [];
      this._cityFetchTimer = null;

      this._animationTimer = null;
      this._refreshTimer = null;
      this._resizeObserver = null;
      this._initialized = false;
      this._hasCenteredOnHome = false;
      this._isDestroyed = false;
    }

    static getConfigElement() {
      return document.createElement(EDITOR_TAG);
    }

    static getStubConfig() {
      return {
        zoom: 7,
        height: '450px',
        auto_play: true,
        show_clouds: true,
        show_pv_panel: true,
        hide_night: true,
        pv_mode: 'neutral',
      };
    }

    setConfig(config) {
      if (!config || typeof config !== 'object') {
        throw new Error('Ungültige Kartenkonfiguration.');
      }

      const rawHeight = config.height !== undefined ? config.height : '450px';
      const normalizedHeight =
        typeof rawHeight === 'number' ? `${rawHeight}px` : String(rawHeight);

      const zoom = Number.isFinite(Number(config.zoom)) ? Number(config.zoom) : 7;
      const autoPlay = config.auto_play !== undefined ? Boolean(config.auto_play) : true;
      const opacity =
        config.opacity !== undefined && !Number.isNaN(Number(config.opacity))
          ? Math.min(1, Math.max(0, Number(config.opacity)))
          : 0.75;

      const showRadar = config.show_radar !== undefined ? Boolean(config.show_radar) : true;
      const showClouds = config.show_clouds !== undefined ? Boolean(config.show_clouds) : true;
      const showWarnings =
        config.show_warnings !== undefined ? Boolean(config.show_warnings) : false;
      const showPvPanel =
        config.show_pv_panel !== undefined ? Boolean(config.show_pv_panel) : true;
      const showMap = config.show_map !== undefined ? Boolean(config.show_map) : true;
      const hideNight =
        config.hide_night !== undefined ? Boolean(config.hide_night) : false;

      const prevZoom = this._config.zoom;
      const prevHeight = this._config.height;
      const prevLat = this._config.latitude;
      const prevLon = this._config.longitude;
      const prevCartoKey = this._config.carto_api_key;
      const prevActualKey = this._getConfiguredActualEntities().join(',');
      const prevWeatherEntity = this._config.weather_entity || '';
      const prevShowMap = this._config.show_map !== undefined ? Boolean(this._config.show_map) : true;
      const cartoApiKey = config.carto_api_key ? String(config.carto_api_key).trim() : '';

      const pvSystem = this._normalizePvSystem(config.pv_system);
      const pvMode = this._normalizePvMode(config.pv_mode);
      const pvActualEntity = String(
        config.pv_actual_entity ?? config.pv_system?.actual_entity ?? ''
      ).trim();
      const weatherEntity = String(config.weather_entity ?? '').trim();
      const pvShading = normalizePvShadingConfig(config.pv_shading);
      const pvShadingDate = config.pv_shading_date ? String(config.pv_shading_date).trim() : '';

      this._config = {
        ...config,
        zoom,
        height: normalizedHeight,
        auto_play: autoPlay,
        opacity,
        title: config.title ? String(config.title) : '',
        carto_api_key: cartoApiKey,
        show_radar: showRadar,
        show_clouds: showClouds,
        show_warnings: showWarnings,
        show_pv_panel: showPvPanel,
        show_map: showMap,
        hide_night: hideNight,
        pv_mode: pvMode,
        pv_actual_entity: pvActualEntity,
        weather_entity: weatherEntity,
        pv_shading: pvShading,
        pv_shading_date: pvShadingDate,
        pv_system: pvSystem,
      };

      this._opacity = opacity;
      this._isPlaying = autoPlay;
      this._radarEnabled = showRadar;
      this._cloudsEnabled = showClouds;
      this._warningsEnabled = showWarnings;
      if (prevShowMap !== showMap || !this._initialized) {
        this._mapVisible = showMap;
      }
      this._pvMode = pvMode;

      const nextActualEntities = this._getConfiguredActualEntities();
      const nextActualKey = nextActualEntities.join(',');
      if (prevActualKey !== nextActualKey) {
        this._pvActualHistory = null;
        this._pvPastHistories.clear();
        this._pvPastFetchingDates.clear();
        this._pvLastEntityUpdated = null;
        this._pvEntityLastUpdated.clear();
        if (nextActualEntities.length > 0) {
          this._fetchPvActualHistory(true);
        }
      }

      if (prevWeatherEntity !== weatherEntity) {
        this._weatherForecast = null;
        this._weatherLastEntityUpdated = null;
        if (weatherEntity) {
          this._fetchWeatherEntityForecast(true);
        }
      }

      if (this._initialized) {
        const shouldShowMap = this._mapVisible || !this._config.show_pv_panel;
        const activeTarget = this._getActiveFullscreenTarget();
        if (
          (activeTarget === 'map' && !shouldShowMap) ||
          (activeTarget === 'pv' && !this._config.show_pv_panel)
        ) {
          this._exitFullscreenIfActive();
        }
        this._applyDimensions();
        this._updateLayerButtonsUI();
        this._updatePvModeButtonsUI();
        this._updateControlBarUI();

        if (shouldShowMap && !this._map && !this._mapInitializing) {
          this._ensureMapInitialized();
        }

        this._syncOptionalOverlays();
        this._applyActiveLayerOpacity();
        if (this._pvData) {
          this._renderPvPanel();
        }

        if (this._map && prevCartoKey !== cartoApiKey) {
          this._applyBasemap();
        }

        const lat = this._getTargetLat();
        const lon = this._getTargetLon();
        if (this._map && (prevLat !== config.latitude || prevLon !== config.longitude)) {
          this._map.setView([lat, lon], zoom);
          this._updateHomeMarker(lat, lon);
          this._fetchPvAndFogForecast();
        } else if (!this._map && (prevLat !== config.latitude || prevLon !== config.longitude)) {
          this._fetchPvAndFogForecast();
        } else if (this._map && prevZoom !== zoom) {
          this._map.setZoom(zoom);
        }

        if (this._map && prevHeight !== normalizedHeight) {
          setTimeout(() => this._map && this._map.invalidateSize(), 60);
        }

        if (shouldShowMap && this._map && this._isPlaying && this._radarEnabled) {
          this._startAnimation();
        } else {
          this._stopAnimation();
        }
      }
    }

    set hass(hass) {
      const prevLat = this._hass?.config?.latitude;
      const prevLon = this._hass?.config?.longitude;
      this._hass = hass;

      const lat = this._getTargetLat();
      const lon = this._getTargetLon();

      if (this._map && lat !== null && lon !== null) {
        const coordsChanged =
          prevLat !== hass?.config?.latitude || prevLon !== hass?.config?.longitude;
        if (!this._hasCenteredOnHome || coordsChanged) {
          this._map.setView([lat, lon], this._config.zoom);
          this._hasCenteredOnHome = true;
          this._fetchPvAndFogForecast();
        }
        this._updateHomeMarker(lat, lon);
      }

      const configuredEntities = this._getConfiguredActualEntities();
      if (configuredEntities.length > 0) {
        let missingHistory = false;
        let stateUpdated = false;
        let newestFetchedAt = Infinity;
        for (const eid of configuredEntities) {
          const hist = this._pvEntityHistories.get(eid);
          if (!hist) {
            missingHistory = true;
          } else {
            newestFetchedAt = Math.min(newestFetchedAt, hist.fetchedAt || 0);
          }
          const updated = hass?.states?.[eid]?.last_updated || null;
          if (updated && updated !== this._pvEntityLastUpdated.get(eid)) {
            this._pvEntityLastUpdated.set(eid, updated);
            stateUpdated = true;
          }
        }
        if (missingHistory) {
          this._fetchPvActualHistory(true);
        } else if (stateUpdated) {
          const ageMs = Date.now() - (Number.isFinite(newestFetchedAt) ? newestFetchedAt : 0);
          if (ageMs > 60000) {
            this._fetchPvActualHistory(false);
          } else if (this._pvData && Date.now() - this._pvLastLiveRenderAt > 1500) {
            this._pvLastLiveRenderAt = Date.now();
            this._renderPvPanel();
          }
        }
      }

      const weatherEntity = this._config.weather_entity;
      if (weatherEntity) {
        const wState = hass?.states?.[weatherEntity];
        const wUpdated = wState?.last_updated || null;
        if (!this._weatherForecast || this._weatherForecast.entityId !== weatherEntity) {
          this._weatherLastEntityUpdated = wUpdated;
          this._fetchWeatherEntityForecast(true);
        } else if (wUpdated && wUpdated !== this._weatherLastEntityUpdated) {
          this._weatherLastEntityUpdated = wUpdated;
          const ageMs = Date.now() - (this._weatherForecast.fetchedAt || 0);
          if (ageMs > 600000) {
            this._fetchWeatherEntityForecast(false);
          } else if (this._pvData) {
            this._renderPvPanel();
          }
        }
      }
    }

    getCardSize() {
      const numericHeight = parseInt(this._config.height, 10) || 450;
      const mapShown = this._mapVisible || !this._config.show_pv_panel;
      const mapRows = mapShown ? Math.max(2, Math.round(numericHeight / 50)) : 0;
      const pvRows = this._config.show_pv_panel ? 6 : 0;
      return Math.max(2, mapRows + pvRows);
    }

    connectedCallback() {
      this._isDestroyed = false;
      this._attachFullscreenListeners();
      if (!this._initialized) {
        this._renderSkeleton();
        this._initMapAndData();
      } else {
        const mapShown = this._mapVisible || !this._config.show_pv_panel;
        if (mapShown && this._map && this._isPlaying && this._radarEnabled) this._startAnimation();
        this._startRefreshTimer();
      }
    }

    disconnectedCallback() {
      this._isDestroyed = true;
      this._detachFullscreenListeners();
      this._pseudoFullscreenTarget = null;
      this._pendingNativeTarget = null;
      this._fullscreenTarget = null;
      this._pseudoFullscreen = false;
      this._isFullscreen = false;
      this.classList?.remove('pvc-pseudo-fs');
      this._stopAnimation();
      this._stopRefreshTimer();
      if (this._cityFetchTimer) {
        clearTimeout(this._cityFetchTimer);
        this._cityFetchTimer = null;
      }
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
      if (this._map) {
        this._map.remove();
        this._map = null;
      }
      this._baseLayers = [];
      this._cloudLayer = null;
      this._warningLayer = null;
      this._cityLabelsLayer = null;
      this._fallbackRefLayer = null;
      this._frameLayers = [];
      this._homeMarker = null;
      this._initialized = false;
      this._hasCenteredOnHome = false;
    }

    _getTargetLat() {
      if (typeof this._config.latitude === 'number') return this._config.latitude;
      if (typeof this._hass?.config?.latitude === 'number') return this._hass.config.latitude;
      return 48.3003; // Standard-Fallback: Linzer Mariendom
    }

    _getTargetLon() {
      if (typeof this._config.longitude === 'number') return this._config.longitude;
      if (typeof this._hass?.config?.longitude === 'number') return this._hass.config.longitude;
      return 14.2858; // Standard-Fallback: Linzer Mariendom
    }

    _getConfiguredActualEntities() {
      const out = [];
      const seen = new Set();
      const add = (id) => {
        const clean = String(id || '').trim();
        if (clean && !seen.has(clean)) {
          seen.add(clean);
          out.push(clean);
        }
      };
      add(this._config?.pv_actual_entity);
      const strings = getPvSystemStrings(this._config?.pv_system);
      for (const s of strings) {
        add(s?.actual_entity);
      }
      return out;
    }

    _renderSkeleton() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            --pvc-radius: var(--ha-card-border-radius, 12px);
            --pvc-accent: var(--primary-color, #03a9f4);
            --pvc-text: var(--primary-text-color, #f1f5f9);
            --pvc-muted: var(--secondary-text-color, #94a3b8);
          }

          :host(.pvc-pseudo-fs) {
            position: relative;
            z-index: 2147483647 !important;
          }

          ha-card, .card-shell {
            position: relative;
            display: block;
            width: 100%;
            height: auto;
            border-radius: var(--pvc-radius);
            overflow: hidden;
            background: #0f1115;
            border: 1px solid var(--ha-card-border-color, rgba(255, 255, 255, 0.08));
            box-shadow: var(--ha-card-box-shadow, 0 4px 20px rgba(0, 0, 0, 0.35));
            font-family: var(--paper-font-body1_-_font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
            color: var(--pvc-text);
          }

          .card-shell.pseudo-fs {
            overflow: visible !important;
          }

          .map-stage {
            position: relative;
            width: 100%;
            height: ${this._config.height};
            overflow: hidden;
            background: #0f1115;
          }

          .map-stage.hidden {
            display: none;
          }

          .map-stage:fullscreen,
          .map-stage:-webkit-full-screen {
            width: 100vw !important;
            height: 100vh !important;
            height: 100dvh !important;
            border-radius: 0 !important;
          }

          .map-stage.pseudo-fullscreen {
            position: fixed !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            height: 100dvh !important;
            z-index: 2147483647 !important;
            border-radius: 0 !important;
            margin: 0 !important;
          }

          #map {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            background: #0f1115;
            z-index: 1;
          }

          .leaflet-container {
            width: 100%;
            height: 100%;
            background: #0f1115 !important;
            font-family: inherit !important;
          }

          .leaflet-control-attribution {
            background: rgba(15, 17, 21, 0.55) !important;
            color: rgba(255, 255, 255, 0.45) !important;
            font-size: 9px !important;
            padding: 1px 6px !important;
            border-top-left-radius: 6px;
          }

          .leaflet-control-attribution a {
            color: rgba(255, 255, 255, 0.6) !important;
          }

          .leaflet-top.leaflet-left {
            top: 8px;
            left: 8px;
          }

          .leaflet-bar {
            border: 1px solid rgba(255, 255, 255, 0.12) !important;
            border-radius: 8px !important;
            overflow: hidden;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35) !important;
          }

          .leaflet-bar a {
            background-color: rgba(24, 27, 34, 0.82) !important;
            color: #e2e8f0 !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
            backdrop-filter: blur(8px);
            width: 30px !important;
            height: 30px !important;
            line-height: 30px !important;
          }

          .leaflet-bar a:hover {
            background-color: rgba(38, 43, 54, 0.95) !important;
            color: #ffffff !important;
          }

          .top-right-stack {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 600;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 6px;
            max-width: calc(100% - 64px);
          }

          .card-title-overlay {
            padding: 5px 10px;
            border-radius: 8px;
            background: rgba(20, 23, 30, 0.78);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 12px;
            font-weight: 600;
            color: var(--pvc-text);
            pointer-events: none;
          }

          .top-right-row {
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }

          .layer-switcher {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px;
            border-radius: 9px;
            background: rgba(20, 23, 30, 0.78);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
          }

          .fullscreen-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 34px;
            height: 34px;
            padding: 0;
            border-radius: 9px;
            background: rgba(20, 23, 30, 0.78);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
            color: #cbd5e1;
            cursor: pointer;
            flex-shrink: 0;
            transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
          }

          .fullscreen-btn:hover {
            background: rgba(34, 39, 49, 0.92);
            border-color: rgba(255, 255, 255, 0.2);
            color: #ffffff;
          }

          .fullscreen-btn:active {
            transform: scale(0.96);
          }

          .fullscreen-btn.active {
            background: rgba(3, 169, 244, 0.24);
            border-color: rgba(56, 189, 248, 0.45);
            color: #e0f2fe;
          }

          .fullscreen-btn svg {
            width: 17px;
            height: 17px;
            display: block;
          }

          .layer-btn {
            border: 1px solid transparent;
            background: transparent;
            color: #94a3b8;
            font-size: 11px;
            font-weight: 600;
            padding: 5px 9px;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
            white-space: nowrap;
            font-family: inherit;
          }

          .layer-btn:hover {
            color: #f8fafc;
            background: rgba(255, 255, 255, 0.06);
          }

          .layer-btn.active {
            background: rgba(3, 169, 244, 0.22);
            border-color: rgba(56, 189, 248, 0.4);
            color: #e0f2fe;
          }

          .layer-btn.active-clouds {
            background: rgba(148, 163, 184, 0.24);
            border-color: rgba(226, 232, 240, 0.35);
            color: #f8fafc;
          }

          .layer-btn.active-warn {
            background: rgba(245, 158, 11, 0.22);
            border-color: rgba(251, 191, 36, 0.45);
            color: #fef3c7;
          }

          .home-marker-pin {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: rgba(3, 169, 244, 0.22);
            border: 2px solid var(--pvc-accent);
            box-shadow: 0 0 14px rgba(3, 169, 244, 0.55);
            color: #ffffff;
          }

          .pvc-city-label {
            background: transparent;
            border: none;
            pointer-events: none;
          }

          .pvc-city-pin {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            transform: translate(-3px, -50%);
            white-space: nowrap;
            color: rgba(241, 245, 249, 0.92);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.01em;
            text-shadow:
              -1px -1px 0 rgba(9, 12, 18, 0.92),
               1px -1px 0 rgba(9, 12, 18, 0.92),
              -1px  1px 0 rgba(9, 12, 18, 0.92),
               1px  1px 0 rgba(9, 12, 18, 0.92),
               0 1px 4px rgba(0, 0, 0, 0.95);
          }

          .pvc-city-pin.major {
            font-size: 12px;
            font-weight: 600;
            color: #f8fafc;
          }

          .pvc-city-dot {
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: rgba(226, 232, 240, 0.85);
            box-shadow: 0 0 0 1px rgba(9, 12, 18, 0.85);
            flex-shrink: 0;
          }

          .pvc-city-pin.major .pvc-city-dot {
            width: 5px;
            height: 5px;
            background: #f8fafc;
          }

          .pv-panel {
            background: rgba(var(--rgb-card-background-color, 16, 20, 28), 0.96);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding: 12px 14px;
            display: none;
          }

          .pv-panel.visible {
            display: block;
          }

          .pv-panel.map-hidden {
            border-bottom: none;
          }

          .pv-panel:fullscreen,
          .pv-panel:-webkit-full-screen {
            width: 100vw !important;
            height: 100vh !important;
            height: 100dvh !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 12px;
            padding: 18px 22px !important;
            box-sizing: border-box !important;
            border-bottom: none !important;
            border-radius: 0 !important;
            background: #0d1118 !important;
            overflow-y: auto !important;
          }

          .pv-panel.pseudo-fullscreen {
            position: fixed !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            height: 100dvh !important;
            z-index: 2147483647 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 12px;
            padding: 18px 22px !important;
            box-sizing: border-box !important;
            border-bottom: none !important;
            border-radius: 0 !important;
            margin: 0 !important;
            background: #0d1118 !important;
            overflow-y: auto !important;
          }

          .pv-panel:fullscreen .pv-chart-box,
          .pv-panel:-webkit-full-screen .pv-chart-box,
          .pv-panel.pseudo-fullscreen .pv-chart-box {
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
            min-height: 200px;
            margin-top: 0;
          }

          .pv-panel:fullscreen .pv-chart-stage,
          .pv-panel:-webkit-full-screen .pv-chart-stage,
          .pv-panel.pseudo-fullscreen .pv-chart-stage {
            flex: 1 1 auto;
            display: flex;
            align-items: center;
            min-height: 0;
          }

          .pv-panel:fullscreen .pv-chart-svg,
          .pv-panel:-webkit-full-screen .pv-chart-svg,
          .pv-panel.pseudo-fullscreen .pv-chart-svg {
            width: 100%;
            height: auto;
            max-height: 100%;
          }

          .pv-panel:fullscreen .pv-hourly-grid,
          .pv-panel:-webkit-full-screen .pv-hourly-grid,
          .pv-panel.pseudo-fullscreen .pv-hourly-grid {
            margin-top: 0;
            flex-shrink: 0;
          }

          .pv-panel:fullscreen .pv-hour-cell,
          .pv-panel:-webkit-full-screen .pv-hour-cell,
          .pv-panel.pseudo-fullscreen .pv-hour-cell {
            flex: 1 0 42px;
            max-width: 76px;
          }

          .pv-panel:fullscreen .pv-map-toggle-btn,
          .pv-panel:-webkit-full-screen .pv-map-toggle-btn,
          .pv-panel.pseudo-fullscreen .pv-map-toggle-btn {
            display: none;
          }

          .pv-summary-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            flex-wrap: wrap;
          }

          .pv-main {
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
            flex: 1 1 auto;
          }

          .pv-cause-line {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-weight: 600;
            color: #f8fafc;
            flex-wrap: wrap;
          }

          .pv-cause-warn {
            color: #fbbf24;
          }

          .pv-cause-good {
            color: #34d399;
          }

          .pv-metrics {
            font-size: 11px;
            font-weight: 400;
            color: #94a3b8;
            font-variant-numeric: tabular-nums;
          }

          .pv-trend {
            font-size: 11px;
            color: #cbd5e1;
            font-variant-numeric: tabular-nums;
          }

          .pv-trend strong {
            color: #38bdf8;
            font-weight: 600;
          }

          .pv-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
          }

          .pv-mode-switch {
            display: inline-flex;
            align-items: center;
            padding: 2px;
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            gap: 2px;
          }

          .pv-mode-btn {
            border: none;
            background: transparent;
            color: #94a3b8;
            font-size: 10px;
            font-weight: 500;
            padding: 3px 6px;
            border-radius: 4px;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.15s ease, color 0.15s ease;
          }

          .pv-mode-btn:hover {
            color: #f8fafc;
          }

          .pv-mode-btn.active {
            background: rgba(56, 189, 248, 0.22);
            color: #e0f2fe;
            font-weight: 600;
          }

          .pv-map-toggle-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(255, 255, 255, 0.05);
            color: #94a3b8;
            font-size: 10px;
            font-weight: 500;
            padding: 4px 8px;
            border-radius: 6px;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
          }

          .pv-map-toggle-btn:hover {
            color: #f8fafc;
            background: rgba(255, 255, 255, 0.09);
          }

          .pv-map-toggle-btn.active {
            background: rgba(56, 189, 248, 0.18);
            border-color: rgba(56, 189, 248, 0.35);
            color: #e0f2fe;
            font-weight: 600;
          }

          .pv-fullscreen-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            padding: 0;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(255, 255, 255, 0.06);
            color: #cbd5e1;
            cursor: pointer;
            flex-shrink: 0;
            transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
          }

          .pv-fullscreen-btn:hover {
            background: rgba(255, 255, 255, 0.12);
            border-color: rgba(255, 255, 255, 0.22);
            color: #ffffff;
          }

          .pv-fullscreen-btn:active {
            transform: scale(0.95);
          }

          .pv-fullscreen-btn.active {
            background: rgba(3, 169, 244, 0.22);
            border-color: rgba(56, 189, 248, 0.45);
            color: #e0f2fe;
          }

          .pv-fullscreen-btn svg {
            width: 14px;
            height: 14px;
            display: block;
          }

          .pv-chart-box {
            margin-top: 10px;
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(9, 13, 20, 0.72);
            padding: 10px 12px 8px;
          }

          .pv-chart-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 6px;
          }

          .pv-chart-left {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
          }

          .pv-chart-title {
            font-size: 11px;
            font-weight: 600;
            color: #e2e8f0;
            letter-spacing: 0.01em;
          }

          .pv-range-switch {
            display: inline-flex;
            align-items: center;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(255, 255, 255, 0.04);
            padding: 2px;
            gap: 2px;
          }

          .pv-range-btn {
            border: none;
            background: transparent;
            color: #94a3b8;
            font-size: 10px;
            font-weight: 500;
            padding: 2px 7px;
            border-radius: 4px;
            cursor: pointer;
            font-family: inherit;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            line-height: 1.3;
          }

          .pv-range-btn[hidden] {
            display: none;
          }

          .pv-range-btn:disabled {
            opacity: 0.35;
            cursor: default;
          }

          .pv-range-btn.pv-day-nav {
            padding: 2px 5px;
          }

          .pv-range-btn.pv-day-nav svg {
            width: 11px;
            height: 11px;
            display: block;
          }

          .pv-range-btn.active {
            background: rgba(56, 189, 248, 0.2);
            color: #e0f2fe;
            font-weight: 600;
          }

          .pv-range-btn.pv-day-current {
            min-width: 58px;
          }

          .pv-range-btn.pv-day-current.is-past {
            background: rgba(251, 191, 36, 0.18);
            color: #fde68a;
          }

          .pv-chart-legend {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
            font-size: 11px;
            color: #94a3b8;
          }

          .pv-legend-item {
            display: inline-flex;
            align-items: center;
            gap: 5px;
          }

          .pv-legend-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
          }

          .pv-legend-dot.forecast {
            background: #38bdf8;
            box-shadow: 0 0 6px rgba(56, 189, 248, 0.55);
          }

          .pv-legend-dot.actual {
            background: #fbbf24;
            box-shadow: 0 0 6px rgba(251, 191, 36, 0.55);
          }

          .pv-legend-dot.ideal {
            background: #34d399;
            box-shadow: 0 0 6px rgba(52, 211, 153, 0.45);
          }

          .pv-chart-totals {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 8px;
            font-size: 11px;
            font-variant-numeric: tabular-nums;
          }

          .pv-total-ideal {
            color: #6ee7b7;
            font-weight: 500;
          }

          .pv-total-forecast {
            color: #bae6fd;
            font-weight: 600;
          }

          .pv-total-actual {
            color: #fde68a;
            font-weight: 600;
          }

          .pv-delta-badge {
            font-size: 10px;
            font-weight: 600;
            padding: 1px 6px;
            border-radius: 4px;
            font-variant-numeric: tabular-nums;
          }

          .pv-delta-badge.pos {
            background: rgba(16, 185, 129, 0.16);
            color: #34d399;
          }

          .pv-delta-badge.neg {
            background: rgba(245, 158, 11, 0.16);
            color: #fbbf24;
          }

          .pv-chart-stage {
            position: relative;
            width: 100%;
            user-select: none;
            touch-action: pan-y;
          }

          .pv-chart-svg {
            display: block;
            width: 100%;
            height: auto;
            overflow: visible;
          }

          .pv-chart-tooltip {
            position: absolute;
            top: 8px;
            pointer-events: none;
            background: rgba(15, 23, 42, 0.94);
            border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 8px;
            padding: 6px 9px;
            font-size: 11px;
            line-height: 1.45;
            color: #e2e8f0;
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.55);
            backdrop-filter: blur(8px);
            opacity: 0;
            transition: opacity 0.12s ease;
            z-index: 10;
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
          }

          .pv-chart-tooltip.visible {
            opacity: 1;
          }

          .pv-hourly-grid {
            display: flex;
            gap: 6px;
            margin-top: 8px;
            padding-top: 8px;
            padding-bottom: 4px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            overflow-x: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
          }

          .pv-hourly-grid::-webkit-scrollbar {
            height: 5px;
          }

          .pv-hourly-grid::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.22);
            border-radius: 3px;
          }

          .pv-hour-cell {
            flex: 0 0 42px;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 3px;
            font-variant-numeric: tabular-nums;
          }

          .pv-hour-cell.new-day {
            padding-left: 6px;
            border-left: 1px solid rgba(56, 189, 248, 0.35);
          }

          .pv-bar-track {
            width: 100%;
            max-width: 22px;
            height: 28px;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.07);
            display: flex;
            align-items: flex-end;
            overflow: hidden;
          }

          .pv-bar-fill {
            width: 100%;
            border-radius: 2px;
            background: linear-gradient(180deg, #fbbf24 0%, #f59e0b 100%);
            transition: height 0.2s ease;
          }

          .pv-hour-watt {
            font-size: 10px;
            color: #e2e8f0;
            font-weight: 600;
          }

          .pv-hour-sun {
            font-size: 9px;
            color: #fde047;
            line-height: 1;
          }

          .pv-hour-sun.none {
            color: #475569;
          }

          .pv-hour-cloud {
            font-size: 9px;
            color: #94a3b8;
          }

          .pv-hour-cloud.fog {
            color: #fbbf24;
          }

          .pv-hour-time {
            font-size: 10px;
            color: #64748b;
          }

          .pv-hour-cell.new-day .pv-hour-time {
            color: #38bdf8;
            font-weight: 600;
          }

          .pv-hour-cell.is-now {
            background: rgba(56, 189, 248, 0.1);
            border-radius: 6px;
            padding: 2px 0;
          }

          .pv-hour-cell.is-now .pv-hour-time {
            color: #38bdf8;
            font-weight: 700;
          }

          .controls-bar {
            position: absolute;
            left: 10px;
            right: 10px;
            bottom: 10px;
            z-index: 600;
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 12px;
            border-radius: 10px;
            background: rgba(var(--rgb-card-background-color, 24, 27, 34), 0.82);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            box-sizing: border-box;
          }

          .controls-bar.dimmed {
            opacity: 0.6;
          }

          .play-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 34px;
            height: 34px;
            flex-shrink: 0;
            border: none;
            border-radius: 8px;
            background: var(--pvc-accent);
            color: #ffffff;
            cursor: pointer;
            transition: transform 0.12s ease, opacity 0.15s ease;
            padding: 0;
          }

          .play-btn:hover {
            opacity: 0.9;
          }

          .play-btn:active {
            transform: scale(0.95);
          }

          .play-btn svg {
            width: 16px;
            height: 16px;
            fill: currentColor;
          }

          .timeline-wrap {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 1 1 auto;
            min-width: 0;
          }

          .time-readout {
            display: flex;
            flex-direction: column;
            min-width: 58px;
            flex-shrink: 0;
            line-height: 1.15;
          }

          .time-value {
            font-size: 13px;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            color: #f8fafc;
          }

          .time-mode {
            font-size: 10px;
            color: #94a3b8;
            white-space: nowrap;
          }

          .time-mode.nowcast {
            color: #38bdf8;
          }

          input[type='range'].ha-slider {
            -webkit-appearance: none;
            appearance: none;
            height: 4px;
            border-radius: 2px;
            background: rgba(255, 255, 255, 0.18);
            outline: none;
            cursor: pointer;
          }

          input[type='range'].ha-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: #ffffff;
            border: 2px solid var(--pvc-accent);
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
            cursor: pointer;
            transition: transform 0.1s ease;
          }

          input[type='range'].ha-slider::-webkit-slider-thumb:hover {
            transform: scale(1.15);
          }

          input[type='range'].ha-slider::-moz-range-thumb {
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: #ffffff;
            border: 2px solid var(--pvc-accent);
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
            cursor: pointer;
          }

          .time-slider {
            width: 100%;
            min-width: 60px;
          }

          .opacity-wrap {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
            padding-left: 10px;
            border-left: 1px solid rgba(255, 255, 255, 0.1);
          }

          .opacity-icon {
            width: 15px;
            height: 15px;
            color: #94a3b8;
            flex-shrink: 0;
          }

          .opacity-slider {
            width: 64px;
          }

          .opacity-value {
            font-size: 11px;
            font-variant-numeric: tabular-nums;
            color: #cbd5e1;
            min-width: 30px;
            text-align: right;
          }

          .status-overlay {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 550;
            padding: 8px 14px;
            border-radius: 8px;
            background: rgba(15, 17, 21, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #cbd5e1;
            font-size: 12px;
            pointer-events: none;
            display: none;
          }

          .status-overlay.visible {
            display: block;
          }

          @media (max-width: 520px) {
            .controls-bar {
              flex-wrap: wrap;
              gap: 8px;
              padding: 8px 10px;
            }
            .opacity-wrap {
              width: 100%;
              padding-left: 0;
              padding-top: 6px;
              border-left: none;
              border-top: 1px solid rgba(255, 255, 255, 0.08);
            }
            .opacity-slider {
              flex: 1;
            }
          }
        </style>

        <ha-card class="card-shell" id="card-shell">
          <div class="pv-panel" id="pv-panel">
            <div class="pv-summary-row">
              <div class="pv-main">
                <div class="pv-cause-line">
                  <span id="pv-cause-text">PV-Diagnose wird geladen...</span>
                  <span class="pv-metrics" id="pv-metrics"></span>
                </div>
                <div class="pv-trend" id="pv-trend"></div>
              </div>
              <div class="pv-actions">
                <div class="pv-mode-switch" role="group" aria-label="PV-Prognosemodus">
                  <button type="button" class="pv-mode-btn" data-pv-mode="pessimistisch" title="Vorsichtige Prognose">
                    Pess
                  </button>
                  <button type="button" class="pv-mode-btn active" data-pv-mode="neutral" title="Ausgewogener Mittelweg">
                    Neutral
                  </button>
                  <button type="button" class="pv-mode-btn" data-pv-mode="optimistisch" title="Oberes Ertragspotenzial">
                    Opt
                  </button>
                </div>
                <button
                  type="button"
                  class="pv-map-toggle-btn active"
                  id="btn-toggle-map"
                  title="Wetterradar-Karte ein- oder ausblenden"
                >
                  Karte
                </button>
                <button
                  type="button"
                  class="pv-fullscreen-btn"
                  id="btn-pv-fullscreen"
                  aria-label="PV-Bereich Vollbild umschalten"
                  aria-pressed="false"
                  title="PV-Bereich Vollbild umschalten"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="pv-chart-box" id="pv-chart-box">
              <div class="pv-chart-header">
                <div class="pv-chart-left">
                  <span class="pv-chart-title">Ertragsverlauf</span>
                  <div class="pv-range-switch" role="group" aria-label="Tag wählen">
                    <button type="button" class="pv-range-btn pv-day-nav" id="btn-pv-prev-day" title="Einen Tag zurück" aria-label="Vorheriger Tag">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    <button type="button" class="pv-range-btn pv-day-current active" id="btn-pv-day-label" title="Heute">Heute</button>
                    <button type="button" class="pv-range-btn pv-day-nav" id="btn-pv-next-day" title="Einen Tag vor" aria-label="Nächster Tag">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  </div>
                  <div class="pv-chart-legend" id="pv-chart-legend"></div>
                </div>
                <div class="pv-chart-totals" id="pv-chart-totals"></div>
              </div>
              <div class="pv-chart-stage" id="pv-chart-stage">
                <svg class="pv-chart-svg" id="pv-chart-svg" viewBox="0 0 720 186" preserveAspectRatio="none"></svg>
                <div class="pv-chart-tooltip" id="pv-chart-tooltip"></div>
              </div>
            </div>
            <div class="pv-hourly-grid" id="pv-hourly-grid"></div>
          </div>

          <div class="map-stage" id="map-stage">
            <div id="map"></div>

            <div class="top-right-stack" id="top-right-stack">
              <div class="card-title-overlay" id="card-title" style="display: none;"></div>
              <div class="top-right-row">
                <div class="layer-switcher" role="group" aria-label="Kartenebenen">
                  <button type="button" class="layer-btn active" id="btn-radar" title="RainViewer Regenradar">
                    Radar
                  </button>
                  <button type="button" class="layer-btn active-clouds" id="btn-clouds" title="DWD Meteosat Satellitenwolken (Europa)">
                    Wolken
                  </button>
                  <button type="button" class="layer-btn" id="btn-warnings" title="GeoSphere Austria (ZAMG) Wetterwarnungen (nur Österreich)">
                    Warnungen
                  </button>
                </div>
                <button
                  type="button"
                  class="fullscreen-btn"
                  id="btn-fullscreen"
                  aria-label="Vollbild umschalten"
                  aria-pressed="false"
                  title="Vollbild umschalten"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                  </svg>
                </button>
              </div>
            </div>

            <div class="status-overlay visible" id="status-overlay">Lade Wetterdaten...</div>

            <div class="controls-bar" id="controls-bar">
              <button class="play-btn" id="play-btn" type="button" aria-label="Animation starten oder pausieren" title="Play / Pause">
                <svg id="play-icon" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              </button>
              <div class="timeline-wrap">
                <div class="time-readout">
                  <span class="time-value" id="time-value">--:--</span>
                  <span class="time-mode" id="time-mode">Radar</span>
                </div>
                <input
                  type="range"
                  id="time-slider"
                  class="ha-slider time-slider"
                  min="0"
                  max="0"
                  step="1"
                  value="0"
                  aria-label="Zeitpunkt auswählen"
                />
              </div>
              <div class="opacity-wrap" title="Deckkraft der Wetter-Layer">
                <svg class="opacity-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
                </svg>
                <input
                  type="range"
                  id="opacity-slider"
                  class="ha-slider opacity-slider"
                  min="0"
                  max="1"
                  step="0.05"
                  value="0.75"
                  aria-label="Transparenz anpassen"
                />
                <span class="opacity-value" id="opacity-value">75%</span>
              </div>
            </div>
          </div>
        </ha-card>
      `;

      this._bindUIEvents();
      this._applyDimensions();
      this._updateLayerButtonsUI();
      this._updatePvModeButtonsUI();
    }

    _bindUIEvents() {
      const playBtn = this.shadowRoot.getElementById('play-btn');
      const timeSlider = this.shadowRoot.getElementById('time-slider');
      const opacitySlider = this.shadowRoot.getElementById('opacity-slider');
      const btnRadar = this.shadowRoot.getElementById('btn-radar');
      const btnClouds = this.shadowRoot.getElementById('btn-clouds');
      const btnWarnings = this.shadowRoot.getElementById('btn-warnings');

      playBtn.addEventListener('click', () => {
        if (!this._radarEnabled) {
          this._radarEnabled = true;
          this._isPlaying = true;
          this._updateLayerButtonsUI();
          this._applyActiveLayerOpacity();
          this._startAnimation();
          this._updateControlBarUI();
          return;
        }
        this._isPlaying = !this._isPlaying;
        this._updateControlBarUI();
        if (this._isPlaying) {
          this._startAnimation();
        } else {
          this._stopAnimation();
        }
      });

      timeSlider.addEventListener('input', (e) => {
        const index = parseInt(e.target.value, 10);
        if (!Number.isNaN(index)) {
          this._showFrame(index);
          if (this._isPlaying && this._radarEnabled) {
            this._startAnimation();
          }
        }
      });

      opacitySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        if (!Number.isNaN(val)) {
          this._opacity = Math.min(1, Math.max(0, val));
          this._applyActiveLayerOpacity();
          this._updateControlBarUI();
        }
      });

      btnRadar.addEventListener('click', () => {
        this._radarEnabled = !this._radarEnabled;
        this._updateLayerButtonsUI();
        this._applyActiveLayerOpacity();
        if (this._radarEnabled && this._isPlaying) {
          this._startAnimation();
        } else if (!this._radarEnabled) {
          this._stopAnimation();
        }
      });

      btnClouds.addEventListener('click', () => {
        this._cloudsEnabled = !this._cloudsEnabled;
        this._updateLayerButtonsUI();
        this._syncOptionalOverlays();
      });

      btnWarnings.addEventListener('click', () => {
        this._warningsEnabled = !this._warningsEnabled;
        this._updateLayerButtonsUI();
        this._syncOptionalOverlays();
      });

      this.shadowRoot.querySelectorAll('[data-pv-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const nextMode = this._normalizePvMode(btn.getAttribute('data-pv-mode'));
          if (nextMode !== this._pvMode) {
            this._pvMode = nextMode;
            this._updatePvModeButtonsUI();
            if (this._pvData) {
              this._renderPvPanel();
            }
          }
        });
      });

      const btnPrevDay = this.shadowRoot.getElementById('btn-pv-prev-day');
      if (btnPrevDay) {
        btnPrevDay.addEventListener('click', () => {
          this._setPvDayOffset(this._pvDayOffset - 1);
        });
      }

      const btnDayLabel = this.shadowRoot.getElementById('btn-pv-day-label');
      if (btnDayLabel) {
        btnDayLabel.addEventListener('click', () => {
          if (this._pvDayOffset !== 0) {
            this._setPvDayOffset(0);
          }
        });
      }

      const btnNextDay = this.shadowRoot.getElementById('btn-pv-next-day');
      if (btnNextDay) {
        btnNextDay.addEventListener('click', () => {
          this._setPvDayOffset(this._pvDayOffset + 1);
        });
      }

      this._updatePvDayButtonsUI();

      const btnToggleMap = this.shadowRoot.getElementById('btn-toggle-map');
      if (btnToggleMap) {
        btnToggleMap.addEventListener('click', () => {
          this._mapVisible = !this._mapVisible;
          if (!this._mapVisible && this._getActiveFullscreenTarget() === 'map') {
            this._exitFullscreenIfActive();
          }
          this._applyDimensions();
          if (this._mapVisible) {
            if (!this._map && !this._mapInitializing) {
              this._ensureMapInitialized();
            } else if (this._map) {
              requestAnimationFrame(() => this._map && this._map.invalidateSize());
              setTimeout(() => this._map && this._map.invalidateSize(), 60);
              if (this._isPlaying && this._radarEnabled) {
                this._startAnimation();
              }
            }
          } else {
            this._stopAnimation();
          }
        });
      }

      const btnFullscreen = this.shadowRoot.getElementById('btn-fullscreen');
      if (btnFullscreen) {
        btnFullscreen.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleFullscreen('map');
        });
      }

      const btnPvFullscreen = this.shadowRoot.getElementById('btn-pv-fullscreen');
      if (btnPvFullscreen) {
        btnPvFullscreen.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleFullscreen('pv');
        });
      }

      this._attachFullscreenListeners();
      this._bindPvChartEvents();
    }

    _bindPvChartEvents() {
      const stage = this.shadowRoot?.getElementById('pv-chart-stage');
      if (!stage) return;

      const handleMove = (clientX) => {
        const model = this._pvChartModel;
        const tooltip = this.shadowRoot?.getElementById('pv-chart-tooltip');
        const crosshair = this.shadowRoot?.getElementById('pv-chart-crosshair');
        const dotIdeal = this.shadowRoot?.getElementById('pv-chart-dot-ideal');
        const dotForecast = this.shadowRoot?.getElementById('pv-chart-dot-forecast');
        const dotActual = this.shadowRoot?.getElementById('pv-chart-dot-actual');
        if (!model || !model.slots.length || !tooltip) return;

        const rect = stage.getBoundingClientRect();
        if (rect.width <= 0) return;

        const svgX = ((clientX - rect.left) / rect.width) * model.svgW;
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < model.slots.length; i++) {
          const d = Math.abs(model.slots[i].x - svgX);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }

        const slot = model.slots[bestIdx];
        if (crosshair) {
          crosshair.setAttribute('x1', slot.x.toFixed(1));
          crosshair.setAttribute('x2', slot.x.toFixed(1));
          crosshair.setAttribute('opacity', '1');
        }
        if (dotIdeal) {
          if (slot.yIdeal !== null && slot.yIdeal !== undefined) {
            dotIdeal.setAttribute('cx', slot.x.toFixed(1));
            dotIdeal.setAttribute('cy', slot.yIdeal.toFixed(1));
            dotIdeal.setAttribute('opacity', '0.9');
          } else {
            dotIdeal.setAttribute('opacity', '0');
          }
        }
        if (dotForecast) {
          dotForecast.setAttribute('cx', slot.x.toFixed(1));
          dotForecast.setAttribute('cy', slot.yForecast.toFixed(1));
          dotForecast.setAttribute('opacity', '1');
        }
        if (dotActual) {
          if (slot.yActual !== null) {
            dotActual.setAttribute('cx', slot.x.toFixed(1));
            dotActual.setAttribute('cy', slot.yActual.toFixed(1));
            dotActual.setAttribute('opacity', '1');
          } else {
            dotActual.setAttribute('opacity', '0');
          }
        }

        const unitLabel = model.hasPvSystem ? 'W' : 'W/m²';
        const fmtVal = (v) =>
          model.hasPvSystem && v >= 1000 ? `${(v / 1000).toFixed(2)} kW` : `${Math.round(v)} ${unitLabel}`;

        let deltaHtml = '';
        if (slot.actualVal !== null && slot.forecastVal > 20) {
          const pct = Math.round(((slot.actualVal - slot.forecastVal) / slot.forecastVal) * 100);
          const sign = pct > 0 ? '+' : '';
          const color = pct >= 0 ? '#34d399' : '#fbbf24';
          deltaHtml = ` <span style="color:${color}">(${sign}${pct}%)</span>`;
        }

        const shadeTxt =
          slot.shadeFactor !== undefined && slot.shadeFactor < 0.92
            ? ` · Schatten ${Math.round((1 - slot.shadeFactor) * 100)}%`
            : '';
        const tempTxt = Number.isFinite(slot.tempC) ? ` · ${Math.round(slot.tempC)}°C` : '';
        const stringLine =
          Array.isArray(slot.stringParts) && slot.stringParts.length > 1
            ? `<div style="color:#cbd5e1;font-size:10px">${slot.stringParts
                .map((sp) => {
                  const estStr = this._formatCompactWatts(sp.forecastWatts);
                  const actStr =
                    sp.actualWatts !== null && sp.actualWatts !== undefined
                      ? ` / Ist ${this._formatCompactWatts(sp.actualWatts)}`
                      : '';
                  return `${this._escapeHtml(sp.label)}: ${estStr}${actStr}`;
                })
                .join(' · ')}</div>`
            : '';

        tooltip.innerHTML =
          `<div style="font-weight:600;color:#f8fafc">${this._escapeHtml(slot.fullTimeLabel)} Uhr</div>` +
          (slot.idealVal !== undefined
            ? `<div><span style="color:#34d399">●</span> Ideal (klar): <strong>${fmtVal(slot.idealVal)}</strong></div>`
            : '') +
          `<div><span style="color:#38bdf8">●</span> Prognose: <strong>${fmtVal(slot.forecastVal)}</strong></div>` +
          (slot.actualVal !== null
            ? `<div><span style="color:#fbbf24">●</span> Ist: <strong>${fmtVal(slot.actualVal)}</strong>${deltaHtml}</div>`
            : '') +
          stringLine +
          `<div style="color:#94a3b8;font-size:10px">☀ ${slot.sunMin} min · Wolken ${slot.clouds}%${tempTxt}${shadeTxt}</div>`;

        const pxX = (slot.x / model.svgW) * rect.width;
        const placeRight = pxX < rect.width * 0.62;
        tooltip.style.left = placeRight ? `${Math.min(rect.width - 170, pxX + 12)}px` : 'auto';
        tooltip.style.right = placeRight ? 'auto' : `${Math.max(8, rect.width - pxX + 12)}px`;
        tooltip.classList.add('visible');
      };

      const hide = () => {
        const tooltip = this.shadowRoot?.getElementById('pv-chart-tooltip');
        const crosshair = this.shadowRoot?.getElementById('pv-chart-crosshair');
        const dotIdeal = this.shadowRoot?.getElementById('pv-chart-dot-ideal');
        const dotForecast = this.shadowRoot?.getElementById('pv-chart-dot-forecast');
        const dotActual = this.shadowRoot?.getElementById('pv-chart-dot-actual');
        if (tooltip) tooltip.classList.remove('visible');
        if (crosshair) crosshair.setAttribute('opacity', '0');
        if (dotIdeal) dotIdeal.setAttribute('opacity', '0');
        if (dotForecast) dotForecast.setAttribute('opacity', '0');
        if (dotActual) dotActual.setAttribute('opacity', '0');
      };

      stage.addEventListener('pointermove', (e) => handleMove(e.clientX));
      stage.addEventListener('pointerdown', (e) => handleMove(e.clientX));
      stage.addEventListener('pointerleave', hide);
    }

    _updatePvModeButtonsUI() {
      if (!this.shadowRoot) return;
      this.shadowRoot.querySelectorAll('[data-pv-mode]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-pv-mode') === this._pvMode);
      });
    }

    _updateLayerButtonsUI() {
      if (!this.shadowRoot) return;
      const btnRadar = this.shadowRoot.getElementById('btn-radar');
      const btnClouds = this.shadowRoot.getElementById('btn-clouds');
      const btnWarnings = this.shadowRoot.getElementById('btn-warnings');
      const controlsBar = this.shadowRoot.getElementById('controls-bar');

      if (btnRadar) btnRadar.classList.toggle('active', this._radarEnabled);
      if (btnClouds) btnClouds.classList.toggle('active-clouds', this._cloudsEnabled);
      if (btnWarnings) {
        btnWarnings.classList.toggle('active-warn', this._warningsEnabled);
        btnWarnings.textContent =
          this._warningsEnabled && this._warningCount !== null
            ? `Warnungen (${this._warningCount})`
            : 'Warnungen';
        btnWarnings.title =
          this._warningsEnabled && this._warningCount !== null
            ? `GeoSphere Austria (ZAMG) Warnungen (Österreich): ${this._warningCount} aktiv`
            : 'GeoSphere Austria (ZAMG) Wetterwarnungen (nur Österreich)';
      }
      if (controlsBar) controlsBar.classList.toggle('dimmed', !this._radarEnabled);
    }

    _attachFullscreenListeners() {
      if (!this._onFullscreenChange) {
        this._onFullscreenChange = () => {
          this._syncFullscreenState();
        };
        document.addEventListener('fullscreenchange', this._onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', this._onFullscreenChange);
      }
      if (!this._onFullscreenKeyDown) {
        this._onFullscreenKeyDown = (e) => {
          if (e.key === 'Escape' && this._pseudoFullscreenTarget) {
            this._pseudoFullscreenTarget = null;
            this._syncFullscreenState();
          }
        };
        document.addEventListener('keydown', this._onFullscreenKeyDown);
      }
    }

    _detachFullscreenListeners() {
      if (this._onFullscreenChange) {
        document.removeEventListener('fullscreenchange', this._onFullscreenChange);
        document.removeEventListener('webkitfullscreenchange', this._onFullscreenChange);
        this._onFullscreenChange = null;
      }
      if (this._onFullscreenKeyDown) {
        document.removeEventListener('keydown', this._onFullscreenKeyDown);
        this._onFullscreenKeyDown = null;
      }
    }

    _getFullscreenElementForTarget(target) {
      if (!this.shadowRoot) return null;
      if (target === 'pv') return this.shadowRoot.getElementById('pv-panel');
      if (target === 'map') return this.shadowRoot.getElementById('map-stage');
      return null;
    }

    _getNativeFullscreenTarget() {
      const mapStage = this.shadowRoot?.getElementById('map-stage');
      const pvPanel = this.shadowRoot?.getElementById('pv-panel');
      const shadowFs = this.shadowRoot?.fullscreenElement || null;
      if (shadowFs && shadowFs === mapStage) return 'map';
      if (shadowFs && shadowFs === pvPanel) return 'pv';

      const docFs =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        null;
      if (!docFs) return null;
      if (docFs === mapStage) return 'map';
      if (docFs === pvPanel) return 'pv';
      if (docFs === this) {
        return this._pendingNativeTarget || this._fullscreenTarget || 'map';
      }
      return null;
    }

    _getActiveFullscreenTarget() {
      return this._getNativeFullscreenTarget() || this._pseudoFullscreenTarget || null;
    }

    _isNativeFullscreen() {
      return Boolean(this._getNativeFullscreenTarget());
    }

    _isStageFullscreen() {
      return this._getActiveFullscreenTarget() === 'map';
    }

    async _exitFullscreenIfActive() {
      this._pseudoFullscreenTarget = null;
      this._pendingNativeTarget = null;
      if (this._isNativeFullscreen()) {
        try {
          if (typeof document.exitFullscreen === 'function') {
            await document.exitFullscreen();
          } else if (typeof document.webkitExitFullscreen === 'function') {
            document.webkitExitFullscreen();
          }
        } catch (_) {
          // Ignorieren
        }
      }
      this._syncFullscreenState();
    }

    async _toggleFullscreen(target = 'map') {
      const normalized = target === 'pv' ? 'pv' : 'map';
      const el = this._getFullscreenElementForTarget(normalized);
      if (!el) return;

      const currentTarget = this._getActiveFullscreenTarget();
      if (currentTarget === normalized) {
        await this._exitFullscreenIfActive();
        return;
      }

      if (currentTarget && currentTarget !== normalized) {
        await this._exitFullscreenIfActive();
      }

      let enteredNative = false;
      this._pendingNativeTarget = normalized;
      try {
        if (typeof el.requestFullscreen === 'function') {
          await el.requestFullscreen();
          enteredNative = this._getNativeFullscreenTarget() === normalized;
        } else if (typeof el.webkitRequestFullscreen === 'function') {
          el.webkitRequestFullscreen();
          enteredNative = true;
        }
      } catch (_) {
        enteredNative = false;
      }

      if (!enteredNative) {
        this._pendingNativeTarget = null;
        this._pseudoFullscreenTarget = normalized;
      }
      this._syncFullscreenState();
    }

    _syncFullscreenState() {
      const nativeTarget = this._getNativeFullscreenTarget();
      if (nativeTarget && this._pseudoFullscreenTarget) {
        this._pseudoFullscreenTarget = null;
      }
      if (!nativeTarget && !this._pseudoFullscreenTarget) {
        this._pendingNativeTarget = null;
      }

      const activeTarget = nativeTarget || this._pseudoFullscreenTarget || null;
      this._fullscreenTarget = activeTarget;
      this._pseudoFullscreen = Boolean(this._pseudoFullscreenTarget);
      this._isFullscreen = Boolean(activeTarget);

      const mapStage = this.shadowRoot?.getElementById('map-stage');
      const pvPanel = this.shadowRoot?.getElementById('pv-panel');
      const cardShell = this.shadowRoot?.getElementById('card-shell');

      if (mapStage) {
        mapStage.classList.toggle('pseudo-fullscreen', this._pseudoFullscreenTarget === 'map');
      }
      if (pvPanel) {
        pvPanel.classList.toggle('pseudo-fullscreen', this._pseudoFullscreenTarget === 'pv');
      }
      if (cardShell) {
        cardShell.classList.toggle('pseudo-fs', Boolean(this._pseudoFullscreenTarget));
      }
      this.classList?.toggle('pvc-pseudo-fs', Boolean(this._pseudoFullscreenTarget));

      this._applyDimensions();
      this._updateFullscreenUI(activeTarget);

      if (this._map) {
        requestAnimationFrame(() => this._map && this._map.invalidateSize());
        setTimeout(() => this._map && this._map.invalidateSize(), 120);
      }
    }

    _updateFullscreenUI(activeTarget = this._getActiveFullscreenTarget()) {
      const expandSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
      const collapseSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`;

      const btnMap = this.shadowRoot?.getElementById('btn-fullscreen');
      if (btnMap) {
        const isMapFs = activeTarget === 'map';
        btnMap.classList.toggle('active', isMapFs);
        btnMap.setAttribute('aria-pressed', isMapFs ? 'true' : 'false');
        const label = isMapFs ? 'Vollbild beenden' : 'Vollbild umschalten';
        btnMap.setAttribute('aria-label', label);
        btnMap.setAttribute('title', label);
        btnMap.innerHTML = isMapFs ? collapseSvg : expandSvg;
      }

      const btnPv = this.shadowRoot?.getElementById('btn-pv-fullscreen');
      if (btnPv) {
        const isPvFs = activeTarget === 'pv';
        btnPv.classList.toggle('active', isPvFs);
        btnPv.setAttribute('aria-pressed', isPvFs ? 'true' : 'false');
        const label = isPvFs ? 'PV-Vollbild beenden' : 'PV-Bereich Vollbild umschalten';
        btnPv.setAttribute('aria-label', label);
        btnPv.setAttribute('title', label);
        btnPv.innerHTML = isPvFs ? collapseSvg : expandSvg;
      }
    }

    _applyDimensions() {
      const mapStage = this.shadowRoot?.getElementById('map-stage');
      const mapShown = this._mapVisible || !this._config.show_pv_panel;
      if (mapStage) {
        mapStage.style.height = this._isStageFullscreen() ? '' : this._config.height;
        mapStage.classList.toggle('hidden', !mapShown);
      }
      const titleEl = this.shadowRoot?.getElementById('card-title');
      if (titleEl) {
        if (this._config.title) {
          titleEl.textContent = this._config.title;
          titleEl.style.display = 'block';
        } else {
          titleEl.style.display = 'none';
        }
      }
      const pvPanel = this.shadowRoot?.getElementById('pv-panel');
      if (pvPanel) {
        pvPanel.classList.toggle('visible', Boolean(this._config.show_pv_panel));
        pvPanel.classList.toggle('map-hidden', !mapShown);
      }
      const btnToggleMap = this.shadowRoot?.getElementById('btn-toggle-map');
      if (btnToggleMap) {
        btnToggleMap.classList.toggle('active', mapShown);
        btnToggleMap.textContent = mapShown ? 'Karte aus' : 'Karte ein';
        btnToggleMap.title = mapShown
          ? 'Wetterradar-Karte ausblenden'
          : 'Wetterradar-Karte einblenden';
      }
    }

    async _injectLeafletCssIntoShadowDom() {
      const cssText = await fetchLeafletCss();
      if (this._isDestroyed) return;

      if (cssText) {
        const styleEl = document.createElement('style');
        styleEl.textContent = cssText;
        this.shadowRoot.insertBefore(styleEl, this.shadowRoot.firstChild);
      } else {
        await new Promise((resolve) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = LEAFLET_CSS_URL;
          link.crossOrigin = 'anonymous';
          link.onload = resolve;
          link.onerror = resolve;
          this.shadowRoot.insertBefore(link, this.shadowRoot.firstChild);
          setTimeout(resolve, 1500);
        });
      }
    }

    async _ensureMapInitialized() {
      if (this._map || this._mapInitializing || this._isDestroyed) return;
      this._mapInitializing = true;
      try {
        await Promise.all([loadLeafletScript(), this._injectLeafletCssIntoShadowDom()]);
        if (this._isDestroyed || this._map) return;

        const L = window.L;
        const mapEl = this.shadowRoot.getElementById('map');
        const lat = this._getTargetLat();
        const lon = this._getTargetLon();

        this._map = L.map(mapEl, {
          center: [lat, lon],
          zoom: this._config.zoom,
          zoomControl: true,
          attributionControl: true,
        });
        this._hasCenteredOnHome = true;

        this._applyBasemap();
        this._syncOptionalOverlays();
        this._updateHomeMarker(lat, lon);

        this._map.on('zoomend', () => {
          this._renderVisibleCityLabels();
          this._scheduleCityLabelsUpdate(180);
        });
        this._map.on('moveend', () => {
          this._renderVisibleCityLabels();
          this._scheduleCityLabelsUpdate(240);
        });

        ['controls-bar', 'top-right-stack', 'pv-panel'].forEach((id) => {
          const el = this.shadowRoot.getElementById(id);
          if (el && L.DomEvent) {
            L.DomEvent.disableClickPropagation(el);
            L.DomEvent.disableScrollPropagation(el);
          }
        });

        this._resizeObserver = new ResizeObserver(() => {
          if (this._map) {
            this._map.invalidateSize();
          }
        });
        this._resizeObserver.observe(mapEl);

        requestAnimationFrame(() => {
          if (this._map) this._map.invalidateSize();
        });
        setTimeout(() => {
          if (this._map) this._map.invalidateSize();
        }, 250);

        await this._fetchAndBuildRadarLayers();
      } catch (err) {
        this._setStatus(`Fehler: ${err.message || 'Karte konnte nicht geladen werden.'}`, true);
      } finally {
        this._mapInitializing = false;
      }
    }

    async _initMapAndData() {
      this._initialized = true;
      this._applyDimensions();
      this._updateControlBarUI();

      const tasks = [this._fetchPvAndFogForecast()];
      if (this._mapVisible || !this._config.show_pv_panel) {
        tasks.push(this._ensureMapInitialized());
      }
      await Promise.all(tasks);
      this._startRefreshTimer();
    }

    _applyBasemap() {
      if (!this._map || !window.L) return;
      const L = window.L;

      this._baseLayers.forEach((layer) => {
        if (this._map.hasLayer(layer)) {
          this._map.removeLayer(layer);
        }
      });
      this._baseLayers = [];

      if (this._fallbackRefLayer && this._map.hasLayer(this._fallbackRefLayer)) {
        this._map.removeLayer(this._fallbackRefLayer);
      }
      this._fallbackRefLayer = null;

      if (this._cityLabelsLayer && this._map.hasLayer(this._cityLabelsLayer)) {
        this._map.removeLayer(this._cityLabelsLayer);
      }
      this._cityLabelsLayer = null;

      if (this._config.carto_api_key) {
        const cartoUrl = `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(
          this._config.carto_api_key
        )}`;
        const cartoLayer = L.tileLayer(cartoUrl, {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap &copy; CARTO',
        }).addTo(this._map);
        this._baseLayers.push(cartoLayer);
        return;
      }

      const baseLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        {
          maxNativeZoom: 16,
          maxZoom: 19,
          attribution: 'Tiles &copy; Esri · Orte &copy; GeoNames',
        }
      ).addTo(this._map);

      if (!this._map.getPane('awmLabels')) {
        const labelsPane = this._map.createPane('awmLabels');
        labelsPane.style.zIndex = '350';
        labelsPane.style.pointerEvents = 'none';
      }

      this._cityLabelsLayer = L.layerGroup().addTo(this._map);
      this._baseLayers.push(baseLayer);
      this._scheduleCityLabelsUpdate(40);
    }

    _attachFallbackReferenceLabels() {
      if (!this._map || !window.L || this._config.carto_api_key || this._fallbackRefLayer) return;
      const L = window.L;
      this._fallbackRefLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
        {
          maxNativeZoom: 16,
          maxZoom: 19,
          pane: 'awmLabels',
          opacity: 0.85,
        }
      ).addTo(this._map);
    }

    _scheduleCityLabelsUpdate(delayMs = 200) {
      if (this._config.carto_api_key) return;
      if (this._cityFetchTimer) {
        clearTimeout(this._cityFetchTimer);
      }
      this._cityFetchTimer = setTimeout(() => {
        this._cityFetchTimer = null;
        this._refreshCityLabels();
      }, delayMs);
    }

    _getCityTierForZoom(zoom) {
      if (zoom <= 5) return 1;
      if (zoom === 6) return 2;
      if (zoom === 7) return 3;
      if (zoom === 8) return 4;
      return 5;
    }

    _getCityPriorityScore(city) {
      const pop = Number(city.population) || 0;
      const fc = city.featureCode;
      if (fc === 'PPLC') return pop + 2000000;
      if (fc === 'PPLA') return pop + 500000;
      if (fc === 'PPLA2') return pop + 65000;
      if (fc === 'PPLA3') return pop + 5000;
      return pop;
    }

    _shouldShowCityAtZoom(city, zoom) {
      const pop = Number(city.population) || 0;
      const fc = city.featureCode;
      if (zoom <= 4) {
        return fc === 'PPLC' || (fc === 'PPLA' && pop >= 100000) || pop >= 350000;
      }
      if (zoom === 5) {
        return fc === 'PPLC' || (fc === 'PPLA' && pop >= 45000) || pop >= 150000;
      }
      if (zoom === 6) {
        return (
          fc === 'PPLC' ||
          fc === 'PPLA' ||
          (fc === 'PPLA2' && pop >= 15000) ||
          pop >= 45000
        );
      }
      if (zoom === 7) {
        return (
          fc === 'PPLC' ||
          fc === 'PPLA' ||
          (fc === 'PPLA2' && pop >= 12000) ||
          pop >= 11500
        );
      }
      if (zoom === 8) {
        return fc === 'PPLC' || fc === 'PPLA' || fc === 'PPLA2' || pop >= 6000;
      }
      if (zoom === 9) {
        return (
          fc === 'PPLC' ||
          fc === 'PPLA' ||
          fc === 'PPLA2' ||
          (fc === 'PPLA3' && pop >= 2500) ||
          pop >= 3500
        );
      }
      return true;
    }

    _renderVisibleCityLabels() {
      if (!this._map || !window.L || !this._cityLabelsLayer || this._config.carto_api_key) return;
      const L = window.L;
      const zoom = this._map.getZoom();
      const bounds = this._map.getBounds().pad(0.08);

      const candidates = [];
      this._cityCache.forEach((city) => {
        if (!bounds.contains([city.lat, city.lon])) return;
        if (!this._shouldShowCityAtZoom(city, zoom)) return;
        candidates.push(city);
      });

      candidates.sort((a, b) => this._getCityPriorityScore(b) - this._getCityPriorityScore(a));

      this._cityLabelsLayer.clearLayers();
      const placedBoxes = [];
      let count = 0;

      for (const city of candidates) {
        if (count >= 45) break;
        const pt = this._map.latLngToContainerPoint([city.lat, city.lon]);
        const estWidth = Math.max(30, city.name.length * 6.4 + 14);
        const box = {
          left: pt.x - 5,
          right: pt.x + estWidth,
          top: pt.y - 8,
          bottom: pt.y + 8,
        };

        const overlaps = placedBoxes.some(
          (b) =>
            box.left < b.right &&
            box.right > b.left &&
            box.top < b.bottom &&
            box.bottom > b.top
        );
        if (overlaps) continue;

        placedBoxes.push(box);
        count++;

        const isMajor =
          city.featureCode === 'PPLC' ||
          city.featureCode === 'PPLA' ||
          (city.featureCode === 'PPLA2' && city.population >= 15000) ||
          city.population >= 45000;

        const icon = L.divIcon({
          className: 'pvc-city-label',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
          html: `<div class="pvc-city-pin${isMajor ? ' major' : ''}"><span class="pvc-city-dot"></span><span>${this._escapeHtml(
            city.name
          )}</span></div>`,
        });

        L.marker([city.lat, city.lon], {
          icon,
          pane: 'awmLabels',
          interactive: false,
          keyboard: false,
        }).addTo(this._cityLabelsLayer);
      }
    }

    async _refreshCityLabels() {
      if (!this._map || this._isDestroyed || this._config.carto_api_key) return;

      const center = this._map.getCenter();
      const bounds = this._map.getBounds();
      const zoom = this._map.getZoom();
      const tier = this._getCityTierForZoom(zoom);
      const minRadiusForZoom =
        zoom <= 5 ? 360 : zoom === 6 ? 260 : zoom === 7 ? 170 : zoom === 8 ? 95 : 45;
      const radiusKm = Math.min(
        550,
        Math.max(
          minRadiusForZoom,
          Math.round((center.distanceTo(bounds.getNorthEast()) / 1000) * 1.2)
        )
      );

      const alreadyCovered = this._cityQueryHistory.some((q) => {
        if (q.tier < tier) return false;
        const distKm = center.distanceTo([q.lat, q.lon]) / 1000;
        return distKm + radiusKm <= q.radiusKm * 1.05;
      });
      if (alreadyCovered) {
        this._renderVisibleCityLabels();
        return;
      }

      const majorFilter =
        tier === 1
          ? "feature_code IN ('PPLC','PPLA') OR population >= 150000"
          : "feature_code IN ('PPLC','PPLA','PPLA2') OR population >= 35000";
      const majorWhere = `within_distance(coordinates, geom'POINT(${center.lng.toFixed(
        4
      )} ${center.lat.toFixed(4)})', ${radiusKm}km) AND (${majorFilter})`;

      const requests = [
        `${GEONAMES_CITIES_URL}?select=geoname_id,name,feature_code,population,coordinates` +
          `&where=${encodeURIComponent(majorWhere)}` +
          `&order_by=${encodeURIComponent('population DESC')}&limit=100`,
      ];

      if (zoom >= 7) {
        const localRadiusKm = zoom === 7 ? 105 : zoom === 8 ? 70 : 40;
        const localMinPop = zoom === 7 ? 10000 : zoom === 8 ? 4000 : 1000;
        const localWhere =
          `within_distance(coordinates, geom'POINT(${center.lng.toFixed(
            4
          )} ${center.lat.toFixed(4)})', ${localRadiusKm}km) AND ` +
          `feature_code IN ('PPLC','PPLA','PPLA2','PPLA3','PPL') AND population >= ${localMinPop}`;
        requests.push(
          `${GEONAMES_CITIES_URL}?select=geoname_id,name,feature_code,population,coordinates` +
            `&where=${encodeURIComponent(localWhere)}` +
            `&order_by=${encodeURIComponent('population DESC')}&limit=100`
        );
      }

      try {
        const responses = await Promise.all(
          requests.map((u) =>
            fetch(u).then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            })
          )
        );
        if (this._isDestroyed || !this._map) return;

        responses.forEach((data) => {
          const rows = Array.isArray(data?.results) ? data.results : [];
          rows.forEach((row) => {
            const lat = Number(row?.coordinates?.lat);
            const lon = Number(row?.coordinates?.lon);
            const rawName = String(row?.name || '').trim();
            const name = DE_CITY_NAMES[rawName] || rawName;
            if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const key = row.geoname_id
              ? String(row.geoname_id)
              : `${name}_${lat.toFixed(3)}_${lon.toFixed(3)}`;
            this._cityCache.set(key, {
              name,
              lat,
              lon,
              population: Number(row.population) || 0,
              featureCode: String(row.feature_code || 'PPL'),
            });
          });
        });

        this._cityQueryHistory.push({
          lat: center.lat,
          lon: center.lng,
          radiusKm,
          tier,
        });
        if (this._cityQueryHistory.length > 30) {
          this._cityQueryHistory.shift();
        }

        this._renderVisibleCityLabels();
      } catch (_err) {
        if (this._cityCache.size === 0) {
          this._attachFallbackReferenceLabels();
        }
      }
    }

    _syncOptionalOverlays() {
      if (!this._map || !window.L) return;
      const L = window.L;

      if (!this._map.getPane('awmClouds')) {
        const cloudPane = this._map.createPane('awmClouds');
        cloudPane.style.zIndex = '180';
        cloudPane.style.mixBlendMode = 'screen';
        cloudPane.style.pointerEvents = 'none';
      }

      if (!this._map.getPane('awmWarnings')) {
        const warnPane = this._map.createPane('awmWarnings');
        warnPane.style.zIndex = '220';
      }

      if (this._cloudsEnabled) {
        if (!this._cloudLayer) {
          this._cloudLayer = L.tileLayer.wms(DWD_WMS_URL, {
            layers: DWD_CLOUD_LAYER,
            format: 'image/png',
            transparent: true,
            version: '1.3.0',
            pane: 'awmClouds',
            opacity: Math.min(0.65, this._opacity * 0.75),
            attribution: '&copy; DWD Satellit',
          });
        }
        if (!this._map.hasLayer(this._cloudLayer)) {
          this._cloudLayer.addTo(this._map);
        }
      } else if (this._cloudLayer && this._map.hasLayer(this._cloudLayer)) {
        this._map.removeLayer(this._cloudLayer);
      }

      if (this._warningsEnabled) {
        if (this._warningLayer && !this._map.hasLayer(this._warningLayer)) {
          this._warningLayer.addTo(this._map);
        }
        if (!this._warningLayer) {
          this._fetchAndRenderAustrianWarnings();
        }
      } else if (this._warningLayer && this._map.hasLayer(this._warningLayer)) {
        this._map.removeLayer(this._warningLayer);
      }
    }

    _escapeHtml(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    _epsg31287ToWgs84(x, y) {
      if (Math.abs(x) <= 180 && Math.abs(y) <= 90) {
        return [x, y];
      }
      const a = 6377397.155;
      const f = 1 / 299.1528128;
      const e2 = 2 * f - f * f;
      const e = Math.sqrt(e2);
      const rad = Math.PI / 180;
      const phi1 = 49 * rad;
      const phi2 = 46 * rad;
      const phi0 = 47.5 * rad;
      const lam0 = (13 + 1 / 3) * rad;
      const x0 = 400000;
      const y0 = 400000;

      const mFn = (p) => Math.cos(p) / Math.sqrt(1 - e2 * Math.sin(p) * Math.sin(p));
      const tFn = (p) =>
        Math.tan(Math.PI / 4 - p / 2) /
        Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2);

      const m1 = mFn(phi1);
      const m2 = mFn(phi2);
      const t1 = tFn(phi1);
      const t2 = tFn(phi2);
      const t0 = tFn(phi0);
      const n = Math.log(m1 / m2) / Math.log(t1 / t2);
      const F = m1 / (n * Math.pow(t1, n));
      const rho0 = a * F * Math.pow(t0, n);

      const dx = x - x0;
      const dy = rho0 - (y - y0);
      const rho = Math.sign(n) * Math.sqrt(dx * dx + dy * dy);
      const t = Math.pow(rho / (a * F), 1 / n);
      const theta = Math.atan2(dx, dy);

      let phi = Math.PI / 2 - 2 * Math.atan(t);
      for (let i = 0; i < 6; i++) {
        phi =
          Math.PI / 2 -
          2 *
            Math.atan(
              t * Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2)
            );
      }
      const lam = lam0 + theta / n;

      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      const nu = a / Math.sqrt(1 - e2 * sinP * sinP);
      const X1 = nu * cosP * Math.cos(lam);
      const Y1 = nu * cosP * Math.sin(lam);
      const Z1 = nu * (1 - e2) * sinP;

      const tx = 577.326;
      const ty = 90.129;
      const tz = 463.919;
      const as2rad = Math.PI / (180 * 3600);
      const rx = 5.137 * as2rad;
      const ry = 1.474 * as2rad;
      const rz = 5.297 * as2rad;
      const s = 1 + 2.4232e-6;

      const X2 = tx + s * (X1 - rz * Y1 + ry * Z1);
      const Y2 = ty + s * (rz * X1 + Y1 - rx * Z1);
      const Z2 = tz + s * (-ry * X1 + rx * Y1 + Z1);

      const aw = 6378137.0;
      const fw = 1 / 298.257223563;
      const ew2 = 2 * fw - fw * fw;
      const p = Math.sqrt(X2 * X2 + Y2 * Y2);
      let latW = Math.atan2(Z2, p * (1 - ew2));
      for (let i = 0; i < 5; i++) {
        const nuW = aw / Math.sqrt(1 - ew2 * Math.sin(latW) * Math.sin(latW));
        latW = Math.atan2(Z2 + ew2 * nuW * Math.sin(latW), p);
      }
      const lonW = Math.atan2(Y2, X2);
      return [lonW / rad, latW / rad];
    }

    _reprojectCoords(coords) {
      if (!Array.isArray(coords)) return coords;
      if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
        return this._epsg31287ToWgs84(coords[0], coords[1]);
      }
      return coords.map((c) => this._reprojectCoords(c));
    }

    _reprojectGeoJsonToWgs84(fc) {
      const features = Array.isArray(fc?.features) ? fc.features : [];
      return {
        type: 'FeatureCollection',
        features: features
          .filter((f) => f && f.geometry)
          .map((f) => ({
            ...f,
            geometry: {
              ...f.geometry,
              coordinates: this._reprojectCoords(f.geometry.coordinates),
            },
          })),
      };
    }

    async _fetchAndRenderAustrianWarnings() {
      if (!this._map || !window.L) return;
      const L = window.L;

      try {
        const res = await fetch(ZAMG_WARNSTATUS_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        if (this._isDestroyed || !this._map) return;

        const wgs84Data = this._reprojectGeoJsonToWgs84(raw);
        this._warningCount = wgs84Data.features.length;
        this._updateLayerButtonsUI();

        if (this._warningLayer && this._map.hasLayer(this._warningLayer)) {
          this._map.removeLayer(this._warningLayer);
        }

        const levelColors = {
          1: '#facc15',
          2: '#fb923c',
          3: '#ef4444',
          4: '#a855f7',
        };
        const levelNames = {
          1: 'Gelb (Vorsicht)',
          2: 'Orange (Achtung)',
          3: 'Rot (Große Gefahr)',
          4: 'Violett (Extreme Gefahr)',
        };
        const typeNames = {
          1: 'Sturm / Wind',
          2: 'Regen',
          3: 'Schnee',
          4: 'Glatteis',
          5: 'Gewitter',
          6: 'Hitze',
          7: 'Kälte',
        };

        this._warningLayer = L.geoJSON(wgs84Data, {
          pane: 'awmWarnings',
          style: (feature) => {
            const props = feature?.properties || {};
            const list = Array.isArray(props.warnings) ? props.warnings : [props];
            const maxLevel = list.reduce(
              (acc, w) => Math.max(acc, Number(w?.warnstufeid ?? w?.level ?? 1) || 1),
              1
            );
            const color = levelColors[maxLevel] || '#facc15';
            return {
              color,
              weight: 1.5,
              opacity: 0.9,
              fillColor: color,
              fillOpacity: 0.32,
            };
          },
          onEachFeature: (feature, layer) => {
            const props = feature?.properties || {};
            const locName =
              props?.location?.properties?.name ||
              props?.name ||
              props?.bezirk ||
              'Österreich';
            const list = Array.isArray(props.warnings) ? props.warnings : [props];
            const lines = list.map((w) => {
              const p = w?.properties || w || {};
              const lvl = Number(p.warnstufeid ?? p.level ?? 1);
              const typ = Number(p.warntypid ?? 0);
              const title = p.text || typeNames[typ] || 'Wetterwarnung';
              const lvlLabel = levelNames[lvl] || `Stufe ${lvl}`;
              const desc = p.auswirkungen || p.rawinfo || '';
              return `<div><strong>${this._escapeHtml(title)}</strong> (${this._escapeHtml(
                lvlLabel
              )})${desc ? `<br><span style="opacity:0.85">${this._escapeHtml(desc)}</span>` : ''}</div>`;
            });
            layer.bindPopup(
              `<div style="font-size:12px;line-height:1.4;max-width:240px;"><strong>${this._escapeHtml(
                locName
              )}</strong>${lines.join('<hr style="margin:4px 0;opacity:0.2">')}</div>`
            );
          },
        });

        if (this._warningsEnabled) {
          this._warningLayer.addTo(this._map);
        }
      } catch (_err) {
        this._warningCount = null;
        this._updateLayerButtonsUI();
      }
    }

    _updateHomeMarker(lat, lon) {
      if (!this._map || !window.L) return;
      const L = window.L;

      if (this._homeMarker) {
        this._homeMarker.setLatLng([lat, lon]);
        return;
      }

      const homeIcon = L.divIcon({
        className: 'home-marker-wrapper',
        html: `
          <div class="home-marker-pin" title="Home-Position">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
            </svg>
          </div>
        `,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      this._homeMarker = L.marker([lat, lon], {
        icon: homeIcon,
        zIndexOffset: 1000,
        interactive: true,
      }).addTo(this._map);

      const locationName = this._hass?.config?.location_name || 'Home';
      this._homeMarker.bindTooltip(locationName, {
        direction: 'top',
        offset: [0, -14],
      });
    }

    _setStatus(text, visible) {
      const el = this.shadowRoot?.getElementById('status-overlay');
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('visible', Boolean(visible));
    }

    _normalizePvSystem(raw) {
      return normalizePvSystemConfig(raw);
    }

    _normalizePvMode(raw) {
      return normalizePvModeValue(raw);
    }

    _getPvProfile() {
      return PV_MODE_PROFILES[this._pvMode] || PV_MODE_PROFILES.neutral;
    }

    _getSolarPosition(isoTime, utcOffsetSec, latDeg, lonDeg) {
      return computeSolarPosition(isoTime, utcOffsetSec, latDeg, lonDeg);
    }

    _computePoaWatts(
      side,
      solarPos,
      ghi,
      dni,
      dhi,
      directShadeFactor = 1,
      tempC = null,
      windMs = 1.5
    ) {
      return computePoaWattsForSide(
        side,
        solarPos,
        ghi,
        dni,
        dhi,
        this._getPvProfile(),
        directShadeFactor,
        tempC,
        windMs
      );
    }

    _computePvEstimate(isoTime, utcOffsetSec, ghi, dni, dhi, tempC = null, windMs = 1.5) {
      return computePvEstimateWithShading({
        pvSystem: this._config.pv_system,
        pvMode: this._pvMode,
        isoTime,
        utcOffsetSec,
        latDeg: this._getTargetLat(),
        lonDeg: this._getTargetLon(),
        ghi,
        dni,
        dhi,
        shadingSectors: this._config.pv_shading || [],
        tempC,
        windMs,
      });
    }

    _computeHourlyPvEstimate(isoHourEnd, utcOffsetSec, ghi, dni, dhi, tempC = null, windMs = 1.5) {
      return computeHourlyPvEstimateWithShading({
        pvSystem: this._config.pv_system,
        pvMode: this._pvMode,
        isoHourEnd,
        utcOffsetSec,
        latDeg: this._getTargetLat(),
        lonDeg: this._getTargetLon(),
        ghi,
        dni,
        dhi,
        shadingSectors: this._config.pv_shading || [],
        tempC,
        windMs,
      });
    }

    _computeHourlyClearSkyPvEstimate(isoHourEnd, utcOffsetSec, tempC = null, windMs = 1.5) {
      return computeHourlyClearSkyPvEstimate({
        pvSystem: this._config.pv_system,
        isoHourEnd,
        utcOffsetSec,
        latDeg: this._getTargetLat(),
        lonDeg: this._getTargetLon(),
        shadingSectors: this._config.pv_shading || [],
        tempC,
        windMs,
      });
    }

    _getSiteTodayDateStr() {
      const curTime = this._pvData?.current?.time;
      if (curTime) return String(curTime).slice(0, 10);
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate()
      ).padStart(2, '0')}`;
    }

    _shiftDateStr(baseDateStr, dayOffset) {
      const [y, m, d] = String(baseDateStr || '').split('-').map(Number);
      if (!y || !m || !d) return baseDateStr;
      const dt = new Date(Date.UTC(y, m - 1, d + (Number(dayOffset) || 0)));
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
        dt.getUTCDate()
      ).padStart(2, '0')}`;
    }

    _formatShortPastDate(dateStr, offset) {
      if (offset === 0) return 'Heute';
      if (offset === 1) return 'Morgen';
      if (offset === -1) return 'Gestern';
      const [y, m, d] = String(dateStr || '').split('-').map(Number);
      if (!y || !m || !d) return String(dateStr || '');
      const wdNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
      const wd = wdNames[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] || '';
      return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
    }

    _getMaxFutureDayOffset() {
      return this._pvData?._fromFallback ? 1 : 6;
    }

    _updatePvDayButtonsUI() {
      if (!this.shadowRoot) return;
      const btnPrev = this.shadowRoot.getElementById('btn-pv-prev-day');
      const btnLabel = this.shadowRoot.getElementById('btn-pv-day-label');
      const btnNext = this.shadowRoot.getElementById('btn-pv-next-day');

      const off = this._pvDayOffset || 0;
      const maxFuture = this._getMaxFutureDayOffset();
      const todayStr = this._getSiteTodayDateStr();
      const targetStr = this._shiftDateStr(todayStr, off);

      if (btnLabel) {
        btnLabel.textContent = this._formatShortPastDate(targetStr, off);
        btnLabel.classList.add('active');
        btnLabel.classList.toggle('is-past', off < 0);
        btnLabel.title = off === 0 ? 'Heute' : 'Zurück zu Heute';
      }
      if (btnPrev) {
        btnPrev.disabled = off <= -30;
      }
      if (btnNext) {
        btnNext.disabled = off >= maxFuture;
      }
    }

    _setPvDayOffset(nextOffset) {
      const maxFuture = this._getMaxFutureDayOffset();
      const clamped = Math.max(-30, Math.min(maxFuture, Number(nextOffset) || 0));
      if (clamped === this._pvDayOffset) return;
      this._pvDayOffset = clamped;
      this._updatePvDayButtonsUI();

      if (clamped < 0 && -clamped > this._pvOpenMeteoPastDays) {
        this._pvOpenMeteoPastDays = Math.min(31, Math.max(31, -clamped + 1));
        this._fetchPvAndFogForecast();
      }

      if (clamped < 0 && this._getConfiguredActualEntities().length > 0) {
        const targetDateStr = this._shiftDateStr(this._getSiteTodayDateStr(), clamped);
        const entities = this._getConfiguredActualEntities();
        const missingPast = entities.some(
          (eid) => !this._pvPastHistories.has(`${eid}::${targetDateStr}`)
        );
        if (missingPast) {
          this._fetchPvPastHistory(targetDateStr);
        }
      }

      if (this._pvData) {
        this._renderPvPanel();
      }
    }

    _formatCompactWatts(watts) {
      if (watts >= 1000) {
        return `${(watts / 1000).toFixed(1)}kW`;
      }
      return `${watts}W`;
    }

    _isoLocalToUtcHourKey(isoTime, utcOffsetSec) {
      const [datePart, timePart] = String(isoTime || '').split('T');
      const [y, m, d] = (datePart || '2026-01-01').split('-').map(Number);
      const [hh, mm] = (timePart || '00:00').split(':').map(Number);
      const utcMs =
        Date.UTC(y || 2026, (m || 1) - 1, d || 1, hh || 0, mm || 0) -
        (Number(utcOffsetSec) || 0) * 1000;
      return Math.floor(utcMs / 3600000);
    }

    _buildGeosphereHourMap(geoJson) {
      const map = new Map();
      const timestamps = Array.isArray(geoJson?.timestamps) ? geoJson.timestamps : [];
      const params = geoJson?.features?.[0]?.properties?.parameters || {};
      const sundArr = params?.sund?.data || [];
      const ssrdArr = params?.ssrd?.data || [];
      const tccArr = params?.tcc?.data || [];

      for (let i = 0; i < timestamps.length; i++) {
        const ms = Date.parse(timestamps[i]);
        if (!Number.isFinite(ms)) continue;
        const hourKey = Math.floor(ms / 3600000);
        const sund = sundArr[i] != null && Number.isFinite(Number(sundArr[i])) ? Number(sundArr[i]) : null;
        const ssrd = ssrdArr[i] != null && Number.isFinite(Number(ssrdArr[i])) ? Number(ssrdArr[i]) : null;
        const tcc = tccArr[i] != null && Number.isFinite(Number(tccArr[i])) ? Number(tccArr[i]) : null;
        map.set(hourKey, { sund, ssrd, tcc });
      }
      return map;
    }

    _applySunshinePhysics({
      isoTime,
      utcOffsetSec,
      rad,
      dni,
      dhi,
      clouds,
      lowClouds = 0,
      visibility = 20000,
      sunSec,
      omSunSec,
      hasZAMG,
      hourlyInterval = false,
    }) {
      const prof = this._getPvProfile();
      let adjRad = Math.max(0, rad);
      let adjDni = Math.max(0, dni);
      let adjDhi = Math.max(0, dhi);

      const lat = this._getTargetLat();
      const lon = this._getTargetLon();
      const solarPos = hourlyInterval
        ? computeHourlyEffectiveSolarPosition(isoTime, utcOffsetSec, lat, lon)
        : this._getSolarPosition(isoTime, utcOffsetSec, lat, lon);

      if (solarPos.elevation > 0.01) {
        const sinEl = Math.sin(solarPos.elevation);
        if (sunSec <= 60) {
          adjDni =
            prof.zeroSunAllowThinDni > 0 && lowClouds < 40
              ? adjDni * prof.zeroSunAllowThinDni
              : 0;
          if (clouds >= prof.overcastStart) {
            const clearGhi = prof.clearBase * Math.pow(sinEl, 1.15);
            const span = Math.max(1, 100 - prof.overcastStart);
            const maxOvercastFrac =
              prof.overcastMax - prof.overcastDrop * ((Math.min(100, clouds) - prof.overcastStart) / span);
            adjRad = Math.min(adjRad, Math.round(clearGhi * maxOvercastFrac));
          }
          adjDhi = Math.max(0, adjRad - adjDni * sinEl);
        } else if (hasZAMG) {
          const sunRatio =
            omSunSec > 600
              ? Math.min(prof.partialSunCap, Math.max(0, sunSec / omSunSec))
              : Math.min(0.95, (sunSec / 3600) * 0.9);
          const cloudDamp =
            clouds >= 70 ? 1 - prof.partialCloudDamp * ((Math.min(100, clouds) - 70) / 30) : 1;

          if (omSunSec > 600) {
            adjDni = adjDni * sunRatio * cloudDamp;
            adjDhi = Math.max(0, adjRad - adjDni * sinEl);
          } else if (adjRad > 0 && adjDni < 100) {
            const directFrac = Math.min(0.75, (sunSec / 3600) * 0.7) * cloudDamp;
            adjDhi = adjRad * (1 - directFrac);
            adjDni = (adjRad * directFrac) / Math.max(0.18, sinEl);
          } else {
            adjDni = adjDni * sunRatio * cloudDamp;
            adjDhi = Math.max(0, adjRad - adjDni * sinEl);
          }
        } else if (clouds >= 70) {
          const cloudDamp = 1 - prof.partialCloudDamp * ((Math.min(100, clouds) - 70) / 30);
          adjDni = adjDni * cloudDamp;
          adjDhi = Math.max(0, adjRad - adjDni * sinEl);
        }

        if (visibility < 1000) {
          adjRad = Math.round(adjRad * prof.fogFactor);
          adjDni = 0;
          adjDhi = adjRad;
        } else if (visibility < 4000) {
          adjRad = Math.round(adjRad * prof.hazeFactor);
          adjDni = adjDni * 0.5;
          adjDhi = Math.max(0, adjRad - adjDni * sinEl);
        } else if (lowClouds >= 85 && sunSec <= 300) {
          adjRad = Math.round(adjRad * prof.stratusFactor);
          adjDni = adjDni * 0.5;
          adjDhi = Math.max(0, adjRad - adjDni * sinEl);
        }
      }

      return { rad: Math.round(adjRad), dni: adjDni, dhi: adjDhi };
    }

    _normalizeTempC(val, unit) {
      const n = Number(val);
      if (!Number.isFinite(n)) return null;
      const u = String(unit || '').toLowerCase();
      if (u.includes('f')) return ((n - 32) * 5) / 9;
      return n;
    }

    _normalizeWindMs(val, unit) {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0) return 1.5;
      const u = String(unit || 'km/h').toLowerCase();
      if (u.includes('km')) return n / 3.6;
      if (u.includes('mph') || u.includes('mi/h')) return n * 0.44704;
      if (u.includes('kn') || u.includes('kt')) return n * 0.514444;
      return n;
    }

    _conditionToWeatherDefaults(condition) {
      const c = String(condition || '').toLowerCase();
      if (c === 'sunny' || c === 'clear-night') return { clouds: 8, wmo: 0, vis: 24000 };
      if (c === 'partlycloudy') return { clouds: 45, wmo: 2, vis: 18000 };
      if (c === 'fog') return { clouds: 92, wmo: 45, vis: 500 };
      if (c === 'cloudy') return { clouds: 88, wmo: 3, vis: 12000 };
      if (c === 'rainy' || c === 'pouring' || c === 'lightning' || c === 'lightning-rainy') {
        return { clouds: 92, wmo: 63, vis: 6000 };
      }
      if (c === 'snowy' || c === 'snowy-rainy' || c === 'hail') {
        return { clouds: 90, wmo: 73, vis: 4000 };
      }
      if (c === 'windy' || c === 'windy-variant') return { clouds: 35, wmo: 2, vis: 18000 };
      return { clouds: 55, wmo: 2, vis: 15000 };
    }

    _getLiveWeatherEntitySnapshot() {
      const entityId = this._config.weather_entity;
      if (!entityId) return null;
      const stateObj = this._hass?.states?.[entityId];
      if (!stateObj) return null;
      const attrs = stateObj.attributes || {};
      const tempC = this._normalizeTempC(attrs.temperature, attrs.temperature_unit);
      const windMs = this._normalizeWindMs(attrs.wind_speed, attrs.wind_speed_unit);
      const rawClouds = Number(attrs.cloud_coverage);
      const condDefaults = this._conditionToWeatherDefaults(stateObj.state);
      const clouds = Number.isFinite(rawClouds)
        ? Math.min(100, Math.max(0, rawClouds))
        : condDefaults.clouds;
      return {
        entityId,
        condition: stateObj.state || '',
        tempC,
        windMs,
        clouds,
        wmo: condDefaults.wmo,
        vis: condDefaults.vis,
      };
    }

    _buildWeatherEntityHourMap() {
      const entityId = this._config.weather_entity;
      if (!entityId) return null;
      const map = new Map();
      const forecastArr =
        this._weatherForecast?.entityId === entityId && Array.isArray(this._weatherForecast.hourly)
          ? this._weatherForecast.hourly
          : Array.isArray(this._hass?.states?.[entityId]?.attributes?.forecast)
          ? this._hass.states[entityId].attributes.forecast
          : [];
      const stateAttrs = this._hass?.states?.[entityId]?.attributes || {};
      const tempUnit = stateAttrs.temperature_unit;
      const windUnit = stateAttrs.wind_speed_unit;

      for (const item of forecastArr) {
        const ms = Date.parse(item?.datetime || '');
        if (!Number.isFinite(ms)) continue;
        const hourKey = Math.floor(ms / 3600000);
        const tempC =
          item.temperature !== undefined && item.temperature !== null
            ? this._normalizeTempC(item.temperature, tempUnit)
            : null;
        const windMs =
          item.wind_speed !== undefined && item.wind_speed !== null
            ? this._normalizeWindMs(item.wind_speed, windUnit)
            : 1.5;
        const condDefaults = this._conditionToWeatherDefaults(item.condition);
        const rawClouds = Number(item.cloud_coverage);
        const clouds = Number.isFinite(rawClouds)
          ? Math.min(100, Math.max(0, rawClouds))
          : item.condition
          ? condDefaults.clouds
          : null;
        map.set(hourKey, {
          tempC,
          windMs,
          clouds,
          condition: item.condition || '',
          wmo: condDefaults.wmo,
          vis: condDefaults.vis,
        });
      }
      return map.size > 0 ? map : null;
    }

    async _fetchWeatherEntityForecast(force = false) {
      const entityId = this._config.weather_entity;
      if (!entityId || !this._hass || this._weatherFetching) return;
      const ageMs = Date.now() - (this._weatherForecast?.fetchedAt || 0);
      if (!force && this._weatherForecast?.entityId === entityId && ageMs < 480000) {
        return;
      }

      const stateObj = this._hass?.states?.[entityId];
      const attrForecast = Array.isArray(stateObj?.attributes?.forecast)
        ? stateObj.attributes.forecast
        : null;

      if (typeof this._hass.callWS !== 'function') {
        if (attrForecast) {
          this._weatherForecast = { entityId, fetchedAt: Date.now(), hourly: attrForecast };
          if (this._pvData) this._renderPvPanel();
        }
        return;
      }

      this._weatherFetching = true;
      try {
        const resp = await this._hass.callWS({
          type: 'call_service',
          domain: 'weather',
          service: 'get_forecasts',
          service_data: { type: 'hourly' },
          target: { entity_id: entityId },
          return_response: true,
        });
        if (this._isDestroyed) return;
        const fc =
          resp?.response?.[entityId]?.forecast ||
          resp?.[entityId]?.forecast ||
          attrForecast ||
          [];
        this._weatherForecast = {
          entityId,
          fetchedAt: Date.now(),
          hourly: Array.isArray(fc) ? fc : [],
        };
        if (this._pvData) {
          this._renderPvPanel();
        }
      } catch (_) {
        if (attrForecast) {
          this._weatherForecast = { entityId, fetchedAt: Date.now(), hourly: attrForecast };
          if (this._pvData) this._renderPvPanel();
        }
      } finally {
        this._weatherFetching = false;
      }
    }

    _buildFallbackPvDataFromWeatherEntity() {
      const snap = this._getLiveWeatherEntitySnapshot();
      const weatherMap = this._buildWeatherEntityHourMap();
      if (!snap && !weatherMap) return null;

      const lat = this._getTargetLat();
      const lon = this._getTargetLon();
      const now = new Date();
      const utcOffsetSec = -now.getTimezoneOffset() * 60;
      const toLocalIsoHour = (ms) => {
        const d = new Date(ms + utcOffsetSec * 1000);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        const h = String(d.getUTCHours()).padStart(2, '0');
        return `${y}-${m}-${day}T${h}:00`;
      };

      const nowLocalShiftMs = now.getTime() + utcOffsetSec * 1000;
      const nowLocal = new Date(nowLocalShiftMs);
      const localMidnightUtcMs =
        Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate(), 0, 0, 0) -
        utcOffsetSec * 1000;
      const curHourLocalIdx = Math.max(0, Math.min(23, nowLocal.getUTCHours()));
      const times = [];
      const cloud_cover = [];
      const cloud_cover_low = [];
      const shortwave_radiation = [];
      const direct_normal_irradiance = [];
      const diffuse_radiation = [];
      const sunshine_duration = [];
      const visibility = [];
      const weather_code = [];
      const is_day = [];

      for (let h = 0; h < 49; h++) {
        const ms = localMidnightUtcMs + h * 3600000;
        const iso = toLocalIsoHour(ms);
        const hk = Math.floor(ms / 3600000);
        const entry = weatherMap?.get(hk) || snap || {};
        const cld = Number.isFinite(entry.clouds) ? entry.clouds : 50;
        const wmo = entry.wmo ?? 2;
        const vis = entry.vis ?? 15000;
        const solarPos = computeHourlyEffectiveSolarPosition(iso, utcOffsetSec, lat, lon);
        const clear = computeHourlyClearSkyIrradiance(iso, utcOffsetSec, lat, lon);
        const dayFlag = clear.ghi > 0.5 || solarPos.elevation > 0.005 ? 1 : 0;
        const trans = Math.max(0.12, 1 - 0.72 * Math.pow(cld / 100, 1.5));
        const ghi = dayFlag ? Math.round(clear.ghi * trans) : 0;
        const directFrac = dayFlag ? Math.max(0, 1 - cld / 100) : 0;
        const dni = dayFlag ? Math.round(clear.dni * Math.pow(directFrac, 1.15)) : 0;
        const dhi = dayFlag ? Math.max(0, Math.round(ghi - dni * Math.sin(Math.max(0.01, solarPos.elevation)))) : 0;
        const sunSec = dayFlag ? Math.round(3600 * Math.max(0, 1 - cld / 100)) : 0;

        times.push(iso);
        cloud_cover.push(Math.round(cld));
        cloud_cover_low.push(wmo === 45 ? 90 : Math.round(cld * 0.45));
        shortwave_radiation.push(ghi);
        direct_normal_irradiance.push(dni);
        diffuse_radiation.push(dhi);
        sunshine_duration.push(sunSec);
        visibility.push(vis);
        weather_code.push(wmo);
        is_day.push(dayFlag);
      }

      return {
        utc_offset_seconds: utcOffsetSec,
        _fromFallback: 'Met.no',
        current: {
          time: times[curHourLocalIdx] || times[0],
          cloud_cover: cloud_cover[curHourLocalIdx] ?? cloud_cover[0],
          cloud_cover_low: cloud_cover_low[curHourLocalIdx] ?? cloud_cover_low[0],
          visibility: visibility[curHourLocalIdx] ?? visibility[0],
          shortwave_radiation: shortwave_radiation[curHourLocalIdx] ?? shortwave_radiation[0],
          direct_normal_irradiance: direct_normal_irradiance[curHourLocalIdx] ?? direct_normal_irradiance[0],
          diffuse_radiation: diffuse_radiation[curHourLocalIdx] ?? diffuse_radiation[0],
          weather_code: weather_code[curHourLocalIdx] ?? weather_code[0],
          is_day: is_day[curHourLocalIdx] ?? is_day[0],
        },
        hourly: {
          time: times,
          cloud_cover,
          cloud_cover_low,
          shortwave_radiation,
          direct_normal_irradiance,
          diffuse_radiation,
          sunshine_duration,
          visibility,
          weather_code,
          is_day,
        },
      };
    }

    _resolveHourlyWeather(i, arrays, geoMap, utcOffsetSec, sunArr, weatherMap = null, liveMet = null) {
      const prof = this._getPvProfile();
      const isFallback = Boolean(this._pvData?._fromFallback);
      const iNext = !isFallback && i + 1 < arrays.times.length ? i + 1 : i;
      const omRad0 = Math.max(0, Number(arrays.hRad[i] ?? 0));
      const omRad1 = Math.max(0, Number(arrays.hRad[iNext] ?? omRad0));
      const omRad = isFallback ? omRad0 : 0.5 * (omRad0 + omRad1);

      const omDni0 = Math.max(0, Number(arrays.hDni[i] ?? 0));
      const omDni1 = Math.max(0, Number(arrays.hDni[iNext] ?? omDni0));
      let dni = isFallback ? omDni0 : 0.5 * (omDni0 + omDni1);

      const omDhi0 = Math.max(0, Number(arrays.hDhi[i] ?? 0));
      const omDhi1 = Math.max(0, Number(arrays.hDhi[iNext] ?? omDhi0));
      let dhi = isFallback ? omDhi0 : 0.5 * (omDhi0 + omDhi1);

      const omCld = Number(arrays.hClouds[i] ?? 0);
      const lowClouds = Number(arrays.hLow?.[i] ?? 0);
      const visibility = Number(arrays.hVis?.[i] ?? 20000);
      const omSun0 = Math.max(0, Math.min(3600, Number(sunArr[i] ?? 0)));
      const omSun1 = Math.max(0, Math.min(3600, Number(sunArr[iNext] ?? omSun0)));
      const omSunSec = isFallback ? omSun0 : Math.round(0.5 * (omSun0 + omSun1));

      const hourKey = this._isoLocalToUtcHourKey(arrays.times[i], utcOffsetSec);
      const geoHour = geoMap ? geoMap.get(hourKey) : null;
      const geoNext = !isFallback && geoMap ? geoMap.get(hourKey + 1) : null;
      const metHour = weatherMap ? weatherMap.get(hourKey) : null;

      let rad = omRad;
      let clouds = omCld;
      let sunSec = omSunSec;
      let hasZAMG = false;

      const avgPair = (a, b) => {
        if (a !== null && b !== null) return 0.5 * (a + b);
        return a !== null ? a : b;
      };
      const geoSund = geoHour || geoNext ? avgPair(geoHour?.sund ?? null, geoNext?.sund ?? null) : null;
      const geoSsrd = geoHour || geoNext ? avgPair(geoHour?.ssrd ?? null, geoNext?.ssrd ?? null) : null;

      if (geoHour || geoNext) {
        if (geoSund !== null) {
          sunSec = Math.max(0, Math.min(3600, geoSund));
          hasZAMG = true;
        }
        if (geoSsrd !== null) {
          rad = Math.max(
            0,
            Math.round(
              Math.min(omRad, geoSsrd) * prof.radMinWeight +
                Math.max(omRad, geoSsrd) * (1 - prof.radMinWeight)
            )
          );
          if (omRad > 10) {
            const scale = Math.min(2.0, Math.max(0, rad / omRad));
            dni = dni * scale;
            dhi = dhi * scale;
          } else if (rad > 0) {
            const sunFrac = sunSec / 3600;
            const directFrac = Math.min(0.75, sunFrac * 0.7);
            dhi = rad * (1 - directFrac);
            const solarPos = computeHourlyEffectiveSolarPosition(
              arrays.times[i],
              utcOffsetSec,
              this._getTargetLat(),
              this._getTargetLon()
            );
            dni = (rad * directFrac) / Math.max(0.18, Math.sin(Math.max(0.05, solarPos.elevation)));
          }
          hasZAMG = true;
        }
        if (geoHour && geoHour.tcc !== null) {
          clouds = Math.round(
            Math.max(omCld, geoHour.tcc) * prof.cloudMaxWeight +
              Math.min(omCld, geoHour.tcc) * (1 - prof.cloudMaxWeight)
          );
        }
      }

      const metClouds =
        metHour && Number.isFinite(metHour.clouds) ? metHour.clouds : null;
      if (metClouds !== null && !this._pvData?._fromFallback) {
        clouds = Math.round(clouds * 0.78 + metClouds * 0.22);
      }

      const omTemp =
        arrays.hTemp && arrays.hTemp[i] != null && Number.isFinite(Number(arrays.hTemp[i]))
          ? Number(arrays.hTemp[i])
          : null;
      const omWind =
        arrays.hWind && arrays.hWind[i] != null && Number.isFinite(Number(arrays.hWind[i]))
          ? Number(arrays.hWind[i])
          : null;

      const tempC =
        metHour && Number.isFinite(metHour.tempC)
          ? metHour.tempC
          : omTemp !== null
          ? omTemp
          : liveMet && Number.isFinite(liveMet.tempC)
          ? liveMet.tempC
          : null;
      const windMs =
        metHour && Number.isFinite(metHour.windMs)
          ? metHour.windMs
          : omWind !== null
          ? omWind
          : liveMet && Number.isFinite(liveMet.windMs)
          ? liveMet.windMs
          : 1.5;

      const adjusted = this._applySunshinePhysics({
        isoTime: arrays.times[i],
        utcOffsetSec,
        rad,
        dni,
        dhi,
        clouds,
        lowClouds,
        visibility,
        sunSec,
        omSunSec,
        hasZAMG,
        hourlyInterval: true,
      });

      return {
        rad: adjusted.rad,
        dni: adjusted.dni,
        dhi: adjusted.dhi,
        clouds,
        sunSec,
        hasZAMG,
        tempC,
        windMs,
        metClouds,
      };
    }

    async _fetchPvAndFogForecast() {
      if (!this._config.show_pv_panel) return;
      const lat = this._getTargetLat();
      const lon = this._getTargetLon();

      const pastDays = Math.min(92, Math.max(14, Number(this._pvOpenMeteoPastDays) || 14));
      const openMeteoUrl =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${encodeURIComponent(lat)}` +
        `&longitude=${encodeURIComponent(lon)}` +
        `&current=temperature_2m,wind_speed_10m,cloud_cover,cloud_cover_low,visibility,shortwave_radiation,direct_normal_irradiance,diffuse_radiation,weather_code,is_day` +
        `&hourly=temperature_2m,wind_speed_10m,cloud_cover,cloud_cover_low,shortwave_radiation,direct_normal_irradiance,diffuse_radiation,sunshine_duration,visibility,weather_code,is_day` +
        `&wind_speed_unit=ms&past_days=${pastDays}&forecast_days=7&timezone=auto`;

      const inGeosphereDomain = lat >= 43 && lat <= 51 && lon >= 5 && lon <= 19;
      const geosphereUrl =
        `${GEOSPHERE_NWP_URL}?parameters=sund,ssrd,tcc&lat_lon=${encodeURIComponent(
          `${lat},${lon}`
        )}`;

      try {
        const omPromise = fetch(openMeteoUrl, { cache: 'no-store' }).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        });

        const geoPromise = inGeosphereDomain
          ? fetch(geosphereUrl, { cache: 'no-store' })
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null)
          : Promise.resolve(null);

        const [data, geoData] = await Promise.all([omPromise, geoPromise]);
        if (this._isDestroyed) return;
        this._pvData = data;
        this._geosphereData = geoData;
        if (this._getConfiguredActualEntities().length > 0) {
          this._fetchPvActualHistory(false);
        }
        if (this._config.weather_entity) {
          this._fetchWeatherEntityForecast(false);
        }
        this._renderPvPanel();
      } catch (_err) {
        if (this._config.weather_entity) {
          await this._fetchWeatherEntityForecast(false);
          const fallbackData = this._buildFallbackPvDataFromWeatherEntity();
          if (fallbackData && !this._isDestroyed) {
            this._pvData = fallbackData;
            this._renderPvPanel();
            return;
          }
        }
        const causeEl = this.shadowRoot?.getElementById('pv-cause-text');
        if (causeEl) causeEl.textContent = 'PV-Prognose aktuell nicht erreichbar';
      }
    }

    async _fetchSingleEntityHistory(entityId, startIso, endIso) {
      const stateObj = this._hass?.states?.[entityId];
      const hasAttrs = Boolean(stateObj?.attributes);
      const path =
        `history/period/${encodeURIComponent(startIso)}` +
        `?end_time=${encodeURIComponent(endIso)}` +
        `&filter_entity_id=${encodeURIComponent(entityId)}` +
        `&minimal_response&significant_changes_only=0` +
        (hasAttrs ? '&no_attributes' : '');

      try {
        const res = await this._hass.callApi('GET', path);
        if (this._isDestroyed) return null;

        const rawSeries = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : [];
        const firstAttrs = rawSeries[0]?.attributes || {};
        const attrs = stateObj?.attributes || firstAttrs;
        const unitRaw = String(attrs.unit_of_measurement || '').trim();
        const unitLow = unitRaw.toLowerCase();
        const devClass = String(attrs.device_class || '').toLowerCase();
        const isEnergy =
          devClass === 'energy' || unitLow === 'kwh' || unitLow === 'wh' || unitLow === 'mwh';

        let scale = 1;
        if (unitLow === 'kw' || unitLow === 'kwh') scale = 1000;
        else if (unitLow === 'mw' || unitLow === 'mwh') scale = 1000000;

        const points = [];
        for (const pt of rawSeries) {
          if (!pt || typeof pt !== 'object') continue;
          const rawState = pt.state !== undefined ? pt.state : pt.s;
          const num = parseFloat(rawState);
          const rawTs = pt.last_changed || pt.lc || pt.last_updated || pt.lu;
          const ts = Date.parse(rawTs);
          if (Number.isFinite(num) && Number.isFinite(ts)) {
            points.push({ t: ts, v: isEnergy ? num * scale : Math.max(0, num * scale) });
          }
        }
        points.sort((a, b) => a.t - b.t);

        return {
          entityId,
          friendlyName: String(attrs.friendly_name || entityId),
          unitType: isEnergy ? 'energy' : 'power',
          unitRaw,
          scale,
          points,
          fetchedAt: Date.now(),
        };
      } catch (_err) {
        if (!stateObj) return null;
        const attrs = stateObj.attributes || {};
        const unitRaw = String(attrs.unit_of_measurement || '').trim();
        const unitLow = unitRaw.toLowerCase();
        const devClass = String(attrs.device_class || '').toLowerCase();
        const isEnergy =
          devClass === 'energy' || unitLow === 'kwh' || unitLow === 'wh' || unitLow === 'mwh';
        const scale =
          unitLow === 'kw' || unitLow === 'kwh'
            ? 1000
            : unitLow === 'mw' || unitLow === 'mwh'
            ? 1000000
            : 1;
        return {
          entityId,
          friendlyName: String(attrs.friendly_name || entityId),
          unitType: isEnergy ? 'energy' : 'power',
          unitRaw,
          scale,
          points: [],
          fetchedAt: Date.now(),
        };
      }
    }

    async _fetchPvActualHistory(force = false) {
      const entityIds = this._getConfiguredActualEntities();
      if (
        entityIds.length === 0 ||
        !this._hass ||
        typeof this._hass.callApi !== 'function' ||
        this._pvActualFetching
      ) {
        return;
      }

      const now = Date.now();
      const toFetch = entityIds.filter((eid) => {
        if (force) return true;
        const existing = this._pvEntityHistories.get(eid);
        return !existing || now - (existing.fetchedAt || 0) >= 45000;
      });
      if (toFetch.length === 0) return;

      this._pvActualFetching = true;
      try {
        const utcOffset = Number(this._pvData?.utc_offset_seconds);
        let startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        if (this._pvData?.current?.time && Number.isFinite(utcOffset)) {
          const todayStr = String(this._pvData.current.time).slice(0, 10);
          const parsedMidnight = Date.parse(`${todayStr}T00:00:00Z`);
          if (Number.isFinite(parsedMidnight)) {
            startDate = new Date(parsedMidnight - utcOffset * 1000);
          }
        }

        const startIso = startDate.toISOString();
        const endIso = new Date().toISOString();
        const results = await Promise.all(
          toFetch.map((eid) => this._fetchSingleEntityHistory(eid, startIso, endIso))
        );
        if (this._isDestroyed) return;

        for (const item of results) {
          if (item && item.entityId) {
            this._pvEntityHistories.set(item.entityId, item);
          }
        }
        const primaryId = this._config.pv_actual_entity;
        this._pvActualHistory = primaryId ? this._pvEntityHistories.get(primaryId) || null : null;

        if (this._pvData) {
          this._renderPvPanel();
        }
      } finally {
        this._pvActualFetching = false;
      }
    }

    async _fetchPvPastHistory(targetDateStr) {
      const entityIds = this._getConfiguredActualEntities();
      if (
        !targetDateStr ||
        entityIds.length === 0 ||
        !this._hass ||
        typeof this._hass.callApi !== 'function' ||
        this._pvPastFetchingDates.has(targetDateStr)
      ) {
        return;
      }

      const utcOffset = Number(this._pvData?.utc_offset_seconds ?? 0);
      const parsedMidnight = Date.parse(`${targetDateStr}T00:00:00Z`);
      if (!Number.isFinite(parsedMidnight)) return;

      const dayStartMs = parsedMidnight - utcOffset * 1000;
      const startIso = new Date(dayStartMs - 3600000).toISOString();
      const endIso = new Date(dayStartMs + 86400000 + 1800000).toISOString();

      this._pvPastFetchingDates.add(targetDateStr);
      try {
        const results = await Promise.all(
          entityIds.map((eid) => this._fetchSingleEntityHistory(eid, startIso, endIso))
        );
        if (this._isDestroyed) return;
        for (const item of results) {
          if (item && item.entityId) {
            this._pvPastHistories.set(`${item.entityId}::${targetDateStr}`, item);
          }
        }
        if (this._pvData && this._pvDayOffset < 0) {
          this._renderPvPanel();
        }
      } finally {
        this._pvPastFetchingDates.delete(targetDateStr);
      }
    }

    _isoHourToUtcMs(isoHour, utcOffsetSec) {
      const prefix = String(isoHour || '').slice(0, 13);
      const parsed = Date.parse(`${prefix}:00:00Z`);
      if (Number.isFinite(parsed)) {
        return parsed - (Number(utcOffsetSec) || 0) * 1000;
      }
      return NaN;
    }

    _computeSingleEntityActualStats(
      entityId,
      slots,
      utcOffsetSec,
      todayDateStr,
      targetDateStr = todayDateStr
    ) {
      if (!entityId) return null;

      const isTargetToday = !targetDateStr || targetDateStr === todayDateStr;
      const hist = isTargetToday
        ? this._pvEntityHistories.get(entityId) ||
          (this._pvActualHistory && this._pvActualHistory.entityId === entityId
            ? this._pvActualHistory
            : null)
        : this._pvPastHistories.get(`${entityId}::${targetDateStr}`) || null;

      const stateObj = this._hass?.states?.[entityId];
      const attrs = stateObj?.attributes || {};
      const unitRaw = hist?.unitRaw || String(attrs.unit_of_measurement || '').trim();
      const unitLow = unitRaw.toLowerCase();
      const devClass = String(attrs.device_class || '').toLowerCase();
      const unitType =
        hist?.unitType ||
        (devClass === 'energy' || unitLow === 'kwh' || unitLow === 'wh' || unitLow === 'mwh'
          ? 'energy'
          : 'power');
      const scale =
        hist?.scale ||
        (unitLow === 'kw' || unitLow === 'kwh'
          ? 1000
          : unitLow === 'mw' || unitLow === 'mwh'
          ? 1000000
          : 1);

      const timeline = hist ? hist.points.slice() : [];
      const nowMs = Date.now();
      let livePowerWatts = null;

      if (isTargetToday && stateObj) {
        const liveNum = parseFloat(stateObj.state);
        if (Number.isFinite(liveNum)) {
          const liveScaled = unitType === 'energy' ? liveNum * scale : Math.max(0, liveNum * scale);
          if (unitType === 'power') {
            livePowerWatts = Math.round(liveScaled);
          }
          const liveTs = Date.parse(stateObj.last_updated || stateObj.last_changed || '') || nowMs;
          if (!timeline.length || liveTs >= timeline[timeline.length - 1].t) {
            timeline.push({ t: liveTs, v: liveScaled });
          }
        }
      }

      const hourlyMap = new Map();
      let totalTodayWh = 0;

      const integratePowerWindow = (startMs, endMs) => {
        if (!timeline.length || endMs <= startMs) return null;
        let idx = 0;
        let curVal = timeline[0].v;
        if (timeline[0].t > endMs) return null;
        while (idx < timeline.length && timeline[idx].t <= startMs) {
          curVal = timeline[idx].v;
          idx++;
        }
        let curT = Math.max(startMs, timeline[0].t);
        if (curT >= endMs) return null;
        let wattMs = 0;
        let coveredMs = 0;
        while (idx < timeline.length && timeline[idx].t < endMs) {
          const nextT = timeline[idx].t;
          if (nextT > curT) {
            const dt = nextT - curT;
            wattMs += curVal * dt;
            coveredMs += dt;
            curT = nextT;
          }
          curVal = timeline[idx].v;
          idx++;
        }
        if (endMs > curT) {
          const dt = endMs - curT;
          wattMs += curVal * dt;
          coveredMs += dt;
        }
        if (coveredMs <= 0) return null;
        return {
          avgWatts: Math.round(wattMs / coveredMs),
          wh: wattMs / 3600000,
        };
      };

      const computeEnergyWindow = (startMs, endMs) => {
        if (!timeline.length || endMs <= startMs) return null;
        let prevVal = null;
        let hasAny = false;
        let deltaWh = 0;
        for (const pt of timeline) {
          if (pt.t <= startMs) {
            prevVal = pt.v;
          } else if (pt.t <= endMs) {
            hasAny = true;
            if (prevVal !== null) {
              const diff = pt.v - prevVal;
              if (diff >= 0 && diff < 250000) {
                deltaWh += diff;
              }
            }
            prevVal = pt.v;
          } else {
            break;
          }
        }
        if (!hasAny) return null;
        const elapsedMs = Math.max(300000, endMs - startMs);
        const rateWatts = Math.round(deltaWh / (elapsedMs / 3600000));
        return { avgWatts: rateWatts, wh: deltaWh };
      };

      const effDateStr = targetDateStr || todayDateStr;
      const dayStartMs = this._isoHourToUtcMs(`${effDateStr}T00`, utcOffsetSec);
      const nextDayMidnightMs = Number.isFinite(dayStartMs) ? dayStartMs + 86400000 : NaN;
      const dayEndMs = isTargetToday ? nowMs : Math.min(nowMs, nextDayMidnightMs);

      if (Number.isFinite(dayStartMs) && Number.isFinite(dayEndMs) && dayEndMs > dayStartMs) {
        if (unitType === 'power') {
          const res = integratePowerWindow(dayStartMs, dayEndMs);
          if (res) totalTodayWh = res.wh;
        } else {
          const res = computeEnergyWindow(dayStartMs, dayEndMs);
          if (res) totalTodayWh = res.wh;
        }
      }

      const maxSlotEndMs = isTargetToday
        ? nowMs
        : Number.isFinite(nextDayMidnightMs)
        ? Math.min(nowMs, nextDayMidnightMs + 1800000)
        : nowMs;

      for (const slot of slots) {
        const hCenter = this._isoHourToUtcMs(slot.iso, utcOffsetSec);
        if (!Number.isFinite(hCenter)) continue;
        if (isTargetToday && hCenter > nowMs) continue;
        const wStart = hCenter - 1800000;
        if (wStart >= maxSlotEndMs) continue;
        const wEnd = Math.min(hCenter + 1800000, maxSlotEndMs);
        if (wEnd - wStart < 300000) continue;
        const res =
          unitType === 'power'
            ? integratePowerWindow(wStart, wEnd)
            : computeEnergyWindow(wStart, wEnd);
        if (res) {
          hourlyMap.set(slot.iso.slice(0, 13), res);
        }
      }

      let nowWatts = livePowerWatts;
      if (isTargetToday && nowWatts === null && Number.isFinite(dayStartMs) && nowMs > dayStartMs) {
        const recentStart = Math.max(dayStartMs, nowMs - 1800000);
        const recentRes =
          unitType === 'power'
            ? integratePowerWindow(recentStart, nowMs)
            : computeEnergyWindow(recentStart, nowMs);
        if (recentRes) nowWatts = recentRes.avgWatts;
      }

      return {
        entityId,
        friendlyName: hist?.friendlyName || String(attrs.friendly_name || entityId),
        unitType,
        livePowerWatts,
        nowWatts,
        totalTodayWh,
        hourlyMap,
        hasData: hourlyMap.size > 0 || (isTargetToday && livePowerWatts !== null),
      };
    }

    _computeActualStats(slots, utcOffsetSec, todayDateStr, targetDateStr = todayDateStr) {
      const strings = getPvSystemStrings(this._config.pv_system);
      const perString = new Map();
      const uniqueStringEntityStats = new Map();

      for (const s of strings) {
        const sid = s?.id || s?.key;
        const eid = String(s?.actual_entity || '').trim();
        if (!sid || !eid) continue;
        let st = uniqueStringEntityStats.get(eid);
        if (!st) {
          st = this._computeSingleEntityActualStats(
            eid,
            slots,
            utcOffsetSec,
            todayDateStr,
            targetDateStr
          );
          if (st) uniqueStringEntityStats.set(eid, st);
        }
        if (st) perString.set(sid, st);
      }

      const globalEntityId = String(this._config.pv_actual_entity || '').trim();
      if (globalEntityId) {
        const main = this._computeSingleEntityActualStats(
          globalEntityId,
          slots,
          utcOffsetSec,
          todayDateStr,
          targetDateStr
        );
        if (!main) return null;
        return {
          ...main,
          perString,
          isSummedStrings: false,
        };
      }

      if (uniqueStringEntityStats.size === 0) return null;

      const list = Array.from(uniqueStringEntityStats.values());
      if (list.length === 1) {
        return {
          ...list[0],
          perString,
          isSummedStrings: false,
        };
      }

      const hourlyMap = new Map();
      for (const slot of slots) {
        const hk = slot.iso.slice(0, 13);
        let sumWatts = 0;
        let sumWh = 0;
        let hasAny = false;
        for (const st of list) {
          const hit = st.hourlyMap.get(hk);
          if (hit) {
            sumWatts += hit.avgWatts;
            sumWh += hit.wh;
            hasAny = true;
          }
        }
        if (hasAny) {
          hourlyMap.set(hk, { avgWatts: Math.round(sumWatts), wh: sumWh });
        }
      }

      let liveSum = 0;
      let hasLive = false;
      let nowSum = 0;
      let hasNow = false;
      let totalTodayWh = 0;
      for (const st of list) {
        totalTodayWh += st.totalTodayWh || 0;
        if (st.livePowerWatts !== null && st.livePowerWatts !== undefined) {
          liveSum += st.livePowerWatts;
          hasLive = true;
        }
        if (st.nowWatts !== null && st.nowWatts !== undefined) {
          nowSum += st.nowWatts;
          hasNow = true;
        }
      }

      return {
        entityId: list.map((s) => s.entityId).join(','),
        friendlyName: `Summe (${list.length} Strings)`,
        unitType: 'mixed',
        livePowerWatts: hasLive ? Math.round(liveSum) : null,
        nowWatts: hasNow ? Math.round(nowSum) : null,
        totalTodayWh,
        hourlyMap,
        hasData: hourlyMap.size > 0 || hasLive,
        perString,
        isSummedStrings: true,
      };
    }

    _niceMaxWatts(rawMax) {
      const val = Math.max(200, rawMax);
      const steps = [
        300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 9000,
        10000, 12000, 15000, 20000, 25000, 30000, 50000,
      ];
      for (const s of steps) {
        if (val <= s) return s;
      }
      return Math.ceil(val / 5000) * 5000;
    }

    _buildMonotonePath(pts, baselineY = null) {
      if (!pts || pts.length === 0) return { line: '', area: '' };
      if (pts.length === 1) {
        const p = pts[0];
        const line = `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
        const area =
          baselineY !== null
            ? `${line} L ${p.x.toFixed(1)} ${baselineY.toFixed(1)} Z`
            : '';
        return { line, area };
      }

      const n = pts.length;
      const d = new Array(n - 1);
      const m = new Array(n).fill(0);

      for (let i = 0; i < n - 1; i++) {
        const dx = Math.max(1e-3, pts[i + 1].x - pts[i].x);
        d[i] = (pts[i + 1].y - pts[i].y) / dx;
      }

      m[0] = d[0];
      m[n - 1] = d[n - 2];
      for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] <= 0) {
          m[i] = 0;
        } else {
          m[i] = (d[i - 1] + d[i]) / 2;
        }
      }

      for (let i = 0; i < n - 1; i++) {
        if (Math.abs(d[i]) < 1e-6) {
          m[i] = 0;
          m[i + 1] = 0;
        } else {
          const a = m[i] / d[i];
          const b = m[i + 1] / d[i];
          const s = a * a + b * b;
          if (s > 9) {
            const tau = 3 / Math.sqrt(s);
            m[i] = tau * a * d[i];
            m[i + 1] = tau * b * d[i];
          }
        }
      }

      let line = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 0; i < n - 1; i++) {
        const dx = (pts[i + 1].x - pts[i].x) / 3;
        const cp1x = pts[i].x + dx;
        const cp1y = pts[i].y + m[i] * dx;
        const cp2x = pts[i + 1].x - dx;
        const cp2y = pts[i + 1].y - m[i + 1] * dx;
        line += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(
          1
        )}, ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
      }

      const area =
        baselineY !== null
          ? `${line} L ${pts[n - 1].x.toFixed(1)} ${baselineY.toFixed(
              1
            )} L ${pts[0].x.toFixed(1)} ${baselineY.toFixed(1)} Z`
          : '';
      return { line, area };
    }

    _renderPvChart({
      times,
      arrays,
      geoMap,
      weatherMap,
      liveMet,
      utcOffset,
      hSun,
      hDay,
      hCode = [],
      curTimeIso,
      startIdx,
      hasPvSystem,
      pvTotalWp,
    }) {
      const svgEl = this.shadowRoot?.getElementById('pv-chart-svg');
      const legendEl = this.shadowRoot?.getElementById('pv-chart-legend');
      const totalsEl = this.shadowRoot?.getElementById('pv-chart-totals');
      if (!svgEl || !legendEl || !totalsEl) return [];

      const todayDateStr = String(curTimeIso || times[startIdx] || '').slice(0, 10);
      const dayOffset = this._pvDayOffset || 0;
      const targetDateStr = this._shiftDateStr(todayDateStr, dayOffset);
      const dayLabel = this._formatShortPastDate(targetDateStr, dayOffset);
      const rawSlots = [];

      if (targetDateStr) {
        for (let i = 0; i < times.length; i++) {
          if (String(times[i]).slice(0, 10) === targetDateStr) {
            rawSlots.push(i);
          }
        }
      }

      if (rawSlots.length === 0) {
        svgEl.innerHTML = '';
        const emptyMsg = this._pvData?._fromFallback
          ? `Keine Verlaufsdaten für ${this._escapeHtml(dayLabel)} (Offline-Modus)`
          : `Lade Daten für ${this._escapeHtml(dayLabel)}…`;
        totalsEl.innerHTML = `<span style="color:#94a3b8;font-size:11px">${emptyMsg}</span>`;
        this._pvChartModel = null;
        return [];
      }

      const buildChartSlot = (i, overrideHh = null, isDayEndBoundary = false, syntheticIso = null) => {
        if (i !== null && i >= 0 && i < times.length) {
          const res = this._resolveHourlyWeather(i, arrays, geoMap, utcOffset, hSun, weatherMap, liveMet);
          const est = hasPvSystem
            ? this._computeHourlyPvEstimate(
                times[i],
                utcOffset,
                res.rad,
                res.dni,
                res.dhi,
                res.tempC,
                res.windMs
              )
            : { totalWatts: res.rad, shadeFactor: 1 };

          const idealEst = this._computeHourlyClearSkyPvEstimate(
            times[i],
            utcOffset,
            res.tempC,
            res.windMs
          );
          const forecastVal = hasPvSystem ? est.totalWatts : res.rad;
          const idealVal = hasPvSystem ? idealEst.totalWatts : Math.round(idealEst.clearGhi);

          return {
            idx: i,
            iso: String(times[i]),
            hh: overrideHh || String(times[i]).slice(11, 16),
            dateStr: targetDateStr,
            dayLabel,
            isDayEndBoundary,
            isDay: Number(hDay[i] ?? 0) === 1,
            forecastVal,
            idealVal,
            rad: res.rad,
            hasZAMG: res.hasZAMG,
            lowClouds: Math.round(Number(arrays.hLow?.[i] ?? 0)),
            visibility: Number(arrays.hVis?.[i] ?? 20000),
            wmo: Number(hCode?.[i] ?? 0),
            stringWatts: Array.isArray(est.stringWatts) ? est.stringWatts : [],
            shadeFactor: est.shadeFactor ?? 1,
            sunMin: Math.round(res.sunSec / 60),
            clouds: Math.round(res.clouds),
            tempC: res.tempC,
          };
        }
        const iso = syntheticIso || `${this._shiftDateStr(targetDateStr, 1)}T00:00`;
        const idealEst = this._computeHourlyClearSkyPvEstimate(iso, utcOffset, null, 1.5);
        return {
          idx: -1,
          iso,
          hh: overrideHh || '24:00',
          dateStr: targetDateStr,
          isDayEndBoundary: true,
          isDay: false,
          forecastVal: 0,
          idealVal: hasPvSystem ? idealEst.totalWatts : Math.round(idealEst.clearGhi),
          stringWatts: [],
          shadeFactor: 1,
          sunMin: 0,
          clouds: 0,
          tempC: null,
        };
      };

      const resolvedSlots = rawSlots.map((i) => buildChartSlot(i));
      const nextDateStr = this._shiftDateStr(targetDateStr, 1);
      const nextMidnightIso = `${nextDateStr}T00`;
      const nextMidnightIdx = times.findIndex((t) => String(t).slice(0, 13) === nextMidnightIso);
      if (rawSlots.length >= 20) {
        resolvedSlots.push(
          buildChartSlot(
            nextMidnightIdx >= 0 ? nextMidnightIdx : null,
            '24:00',
            true,
            `${nextDateStr}T00:00`
          )
        );
      }

      const showActualForDay = dayOffset <= 0 && this._getConfiguredActualEntities().length > 0;
      const actualStats = showActualForDay
        ? this._computeActualStats(resolvedSlots, utcOffset, todayDateStr, targetDateStr)
        : null;
      resolvedSlots.forEach((s) => {
        const hk = s.iso.slice(0, 13);
        const hit = actualStats?.hourlyMap.get(hk) || null;
        s.actualVal = hit ? hit.avgWatts : null;
        s.actualWh = hit ? hit.wh : null;
        s.stringParts = (s.stringWatts || [])
          .filter((sw) => sw.wp > 0)
          .map((sw) => {
            const sid = sw.id || sw.key;
            const stAct = actualStats?.perString?.get(sid) || null;
            const stHit = stAct?.hourlyMap?.get(hk) || null;
            return {
              label: sw.label,
              forecastWatts: sw.watts,
              actualWatts: stHit ? stHit.avgWatts : null,
            };
          });
      });

      let visibleSlots = resolvedSlots;
      if (this._config.hide_night && resolvedSlots.length > 4) {
        const activeIndices = [];
        resolvedSlots.forEach((s, k) => {
          if (
            s.isDay ||
            s.forecastVal > 0 ||
            s.idealVal > 0 ||
            (s.actualVal !== null && s.actualVal > 0) ||
            s.sunMin > 0
          ) {
            activeIndices.push(k);
          }
        });
        if (activeIndices.length > 0) {
          const first = Math.max(0, activeIndices[0] - 1);
          const last = Math.min(resolvedSlots.length - 1, activeIndices[activeIndices.length - 1] + 1);
          visibleSlots = resolvedSlots.slice(first, last + 1);
        }
      }

      if (visibleSlots.length === 0) {
        svgEl.innerHTML = '';
        this._pvChartModel = null;
        return [];
      }

      const svgW = 720;
      const svgH = 186;
      const padL = 46;
      const padR = 16;
      const padT = 18;
      const padB = 24;
      const plotW = svgW - padL - padR;
      const plotH = svgH - padT - padB;
      const baseY = padT + plotH;

      const nowMs = Date.now();
      const nowActualWatts =
        dayOffset === 0 &&
        actualStats &&
        actualStats.nowWatts !== null &&
        actualStats.nowWatts !== undefined
          ? actualStats.nowWatts
          : null;

      let rawMax = hasPvSystem ? Math.max(400, pvTotalWp * 0.22) : 200;
      for (const s of visibleSlots) {
        rawMax = Math.max(rawMax, s.forecastVal, s.idealVal || 0, s.actualVal || 0);
      }
      if (nowActualWatts !== null) {
        rawMax = Math.max(rawMax, nowActualWatts);
      }
      const yMax = this._niceMaxWatts(rawMax * 1.12);

      const n = visibleSlots.length;
      const mapX = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
      const mapY = (v) => baseY - (Math.min(yMax, Math.max(0, v)) / yMax) * plotH;

      const chartSlots = visibleSlots.map((s, i) => ({
        ...s,
        x: mapX(i),
        yIdeal: mapY(s.idealVal),
        yForecast: mapY(s.forecastVal),
        yActual: s.actualVal !== null ? mapY(s.actualVal) : null,
        fullTimeLabel: `${dayLabel} ${s.hh}`,
      }));

      const idealPts = chartSlots.map((s) => ({ x: s.x, y: s.yIdeal }));
      const idealPath = this._buildMonotonePath(idealPts, baseY);

      const forecastPts = chartSlots.map((s) => ({ x: s.x, y: s.yForecast }));
      const forecastPath = this._buildMonotonePath(forecastPts, baseY);

      // Aktuelle Zeitposition ("Jetzt"-Linie nur bei Heute)
      let nowX = null;
      if (dayOffset === 0) {
        const firstMs = this._isoHourToUtcMs(chartSlots[0].iso, utcOffset);
        const lastMs = this._isoHourToUtcMs(chartSlots[chartSlots.length - 1].iso, utcOffset);
        if (
          Number.isFinite(firstMs) &&
          Number.isFinite(lastMs) &&
          nowMs >= firstMs &&
          nowMs <= lastMs + 3600000
        ) {
          for (let i = 0; i < chartSlots.length; i++) {
            const hStart = this._isoHourToUtcMs(chartSlots[i].iso, utcOffset);
            const hEnd = hStart + 3600000;
            if (nowMs >= hStart && nowMs <= hEnd) {
              const frac = (nowMs - hStart) / 3600000;
              const nextX = i + 1 < chartSlots.length ? chartSlots[i + 1].x : chartSlots[i].x;
              nowX = chartSlots[i].x + (nextX - chartSlots[i].x) * frac;
              break;
            }
          }
        }
      }

      const actualPts = chartSlots
        .filter((s) => s.yActual !== null && (nowX === null || s.x <= nowX + 0.5))
        .map((s) => ({ x: s.x, y: s.yActual }));
      if (dayOffset === 0 && nowX !== null && nowActualWatts !== null) {
        const yNow = mapY(nowActualWatts);
        const lastPt = actualPts.length > 0 ? actualPts[actualPts.length - 1] : null;
        if (!lastPt || nowX > lastPt.x + 1.0) {
          actualPts.push({ x: nowX, y: yNow });
        } else if (Math.abs(nowX - lastPt.x) <= 1.0) {
          lastPt.x = nowX;
          lastPt.y = yNow;
        }
      }
      const actualPath = actualPts.length > 0 ? this._buildMonotonePath(actualPts, baseY) : null;

      // Y-Achsen-Rasterlinien
      const formatYTick = (val) => {
        if (val === 0) return '0';
        if (hasPvSystem && val >= 1000) {
          const kw = val / 1000;
          return `${Number.isInteger(kw) ? kw : kw.toFixed(1)} kW`;
        }
        return `${Math.round(val)}`;
      };
      const yGridHtml = [0, 1 / 3, 2 / 3, 1]
        .map((frac) => {
          const val = yMax * frac;
          const y = mapY(val);
          return (
            `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${svgW - padR}" y2="${y.toFixed(1)}" ` +
            `stroke="${frac === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)'}" ` +
            `${frac > 0 ? 'stroke-dasharray="3 3"' : ''} />` +
            `<text x="${padL - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="10" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${formatYTick(val)}</text>`
          );
        })
        .join('');

      // X-Achsen-Ticks
      const labelStep = n > 16 ? 3 : n > 9 ? 2 : 1;
      const xTicksHtml = chartSlots
        .map((s, i) => {
          const isBoundary = s.hh === '00:00' && i > 0;
          const showLabel = i % labelStep === 0 || i === n - 1 || isBoundary;
          if (!showLabel) return '';
          return (
            `<line x1="${s.x.toFixed(1)}" y1="${baseY}" x2="${s.x.toFixed(1)}" y2="${baseY + 4}" stroke="rgba(255,255,255,0.16)" />` +
            `<text x="${s.x.toFixed(1)}" y="${baseY + 16}" text-anchor="middle" fill="${
              isBoundary ? '#38bdf8' : '#64748b'
            }" font-size="10" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${s.hh.slice(
              0,
              5
            )}</text>`
          );
        })
        .join('');

      const hasActualLine = Boolean(actualPath && actualPts.length > 0);
      const nowLineHtml =
        nowX !== null
          ? `<line x1="${nowX.toFixed(1)}" y1="${padT - 2}" x2="${nowX.toFixed(1)}" y2="${baseY}" stroke="rgba(248,250,252,0.35)" stroke-dasharray="3 3" />` +
            `<rect x="${(nowX - 15).toFixed(1)}" y="1" width="30" height="13" rx="4" fill="rgba(30,41,59,0.92)" stroke="rgba(148,163,184,0.35)" />` +
            `<text x="${nowX.toFixed(1)}" y="10.5" text-anchor="middle" fill="#e2e8f0" font-size="8.5" font-weight="600">Jetzt</text>`
          : '';

      const actualSeriesHtml = hasActualLine
        ? `<path d="${actualPath.area}" fill="url(#pvActualGrad)" />` +
          (actualPts.length > 1
            ? `<path d="${actualPath.line}" fill="none" stroke="#fbbf24" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />`
            : '') +
          `<circle cx="${actualPts[actualPts.length - 1].x.toFixed(1)}" cy="${actualPts[
            actualPts.length - 1
          ].y.toFixed(1)}" r="3.6" fill="#fbbf24" stroke="#090c12" stroke-width="1.5" />`
        : '';

      svgEl.innerHTML = `
        <defs>
          <linearGradient id="pvIdealGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#34d399" stop-opacity="0.09" />
            <stop offset="100%" stop-color="#34d399" stop-opacity="0.00" />
          </linearGradient>
          <linearGradient id="pvForecastGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="${hasActualLine ? '0.16' : '0.28'}" />
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.01" />
          </linearGradient>
          <linearGradient id="pvActualGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.30" />
            <stop offset="100%" stop-color="#fbbf24" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        ${yGridHtml}
        ${xTicksHtml}
        <path d="${idealPath.area}" fill="url(#pvIdealGrad)" />
        <path d="${idealPath.line}" fill="none" stroke="#34d399" stroke-opacity="0.72" stroke-width="1.6" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round" />
        <path d="${forecastPath.area}" fill="url(#pvForecastGrad)" />
        <path d="${forecastPath.line}" fill="none" stroke="#38bdf8" stroke-width="${
          hasActualLine ? '2.1' : '2.3'
        }" stroke-linecap="round" stroke-linejoin="round" />
        ${actualSeriesHtml}
        ${nowLineHtml}
        <line id="pv-chart-crosshair" x1="0" y1="${padT}" x2="0" y2="${baseY}" stroke="rgba(255,255,255,0.38)" stroke-width="1" opacity="0" />
        <circle id="pv-chart-dot-ideal" cx="0" cy="0" r="3.4" fill="#34d399" stroke="#090c12" stroke-width="1.5" opacity="0" />
        <circle id="pv-chart-dot-forecast" cx="0" cy="0" r="4" fill="#38bdf8" stroke="#090c12" stroke-width="1.5" opacity="0" />
        <circle id="pv-chart-dot-actual" cx="0" cy="0" r="4.2" fill="#fbbf24" stroke="#090c12" stroke-width="1.5" opacity="0" />
      `;

      // Header Legend & Summen aktualisieren
      const hasConfiguredActual = showActualForDay;
      let legendHtml =
        `<span class="pv-legend-item"><span class="pv-legend-dot ideal"></span>Ideal (klar)</span>` +
        `<span class="pv-legend-item"><span class="pv-legend-dot forecast"></span>Prognose (${this._pvMode})</span>`;
      if (hasConfiguredActual) {
        const liveTxt =
          dayOffset === 0 &&
          actualStats?.livePowerWatts !== null &&
          actualStats?.livePowerWatts !== undefined
            ? ` · ${this._formatCompactWatts(actualStats.livePowerWatts)}`
            : '';
        legendHtml += `<span class="pv-legend-item"><span class="pv-legend-dot actual"></span>Ist: ${this._escapeHtml(
          actualStats?.friendlyName || this._config.pv_actual_entity || 'Strings'
        )}${liveTxt}</span>`;
      }
      legendEl.innerHTML = legendHtml;

      const idealTotalWh = resolvedSlots.reduce(
        (acc, s) => acc + (s.isDayEndBoundary ? 0 : s.idealVal),
        0
      );
      const forecastTotalWh = resolvedSlots.reduce(
        (acc, s) => acc + (s.isDayEndBoundary ? 0 : s.forecastVal),
        0
      );
      let totalsHtml = '';
      if (hasPvSystem) {
        totalsHtml += `<span class="pv-total-ideal" title="Theoretisches Optimum ohne Wolken (inkl. Temperatur &amp; Verschattung)">Ideal: ~${(
          idealTotalWh / 1000
        ).toFixed(1)} kWh</span>`;
        totalsHtml += `<span class="pv-total-forecast">${this._escapeHtml(dayLabel)}: ~${(
          forecastTotalWh / 1000
        ).toFixed(1)} kWh</span>`;
      }

      if (hasConfiguredActual && actualStats && actualStats.hasData) {
        const actualKwh = (actualStats.totalTodayWh / 1000).toFixed(2);
        totalsHtml += `<span class="pv-total-actual">Ist: ${actualKwh} kWh</span>`;

        let forecastRefWh = forecastTotalWh;
        if (dayOffset === 0) {
          // Prognose bis zur aktuellen Uhrzeit zum fairen Vergleich (zentrierte Stundenfenster)
          const todayStartMs = this._isoHourToUtcMs(`${todayDateStr}T00`, utcOffset);
          forecastRefWh = 0;
          for (const s of resolvedSlots) {
            if (s.isDayEndBoundary) continue;
            const hCenter = this._isoHourToUtcMs(s.iso, utcOffset);
            if (!Number.isFinite(hCenter)) continue;
            const wStart = Math.max(todayStartMs, hCenter - 1800000);
            const wEnd = Math.min(nowMs, hCenter + 1800000);
            if (wEnd > wStart) {
              forecastRefWh += s.forecastVal * ((wEnd - wStart) / 3600000);
            }
          }
        }
        if (hasPvSystem && forecastRefWh >= 150) {
          const diffPct = Math.round(
            ((actualStats.totalTodayWh - forecastRefWh) / forecastRefWh) * 100
          );
          const sign = diffPct > 0 ? '+' : '';
          totalsHtml += `<span class="pv-delta-badge ${diffPct >= 0 ? 'pos' : 'neg'}">${sign}${diffPct}%</span>`;
        }
      }
      totalsEl.innerHTML = totalsHtml;

      this._pvChartModel = {
        svgW,
        svgH,
        hasPvSystem,
        slots: chartSlots,
      };

      return visibleSlots.filter((s) => !s.isDayEndBoundary);
    }

    _getVisibilityLabel(meters) {
      if (typeof meters !== 'number' || Number.isNaN(meters)) return '';
      if (meters < 1000) return 'Nebel';
      if (meters < 4000) return 'Dunst';
      if (meters < 10000) return 'mäßig';
      if (meters < 20000) return 'gut';
      return 'sehr gut';
    }

    _formatVisibility(meters, withLabel = false) {
      if (typeof meters !== 'number' || Number.isNaN(meters)) return '–';
      const dist =
        meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
      if (!withLabel) return dist;
      const label = this._getVisibilityLabel(meters);
      return label ? `${dist} (${label})` : dist;
    }

    _renderPvPanel() {
      if (!this.shadowRoot || !this._pvData) return;
      this._updatePvDayButtonsUI();
      const causeEl = this.shadowRoot.getElementById('pv-cause-text');
      const metricsEl = this.shadowRoot.getElementById('pv-metrics');
      const trendEl = this.shadowRoot.getElementById('pv-trend');
      const gridEl = this.shadowRoot.getElementById('pv-hourly-grid');
      if (!causeEl || !metricsEl || !trendEl || !gridEl) return;

      const cur = this._pvData.current || {};
      const utcOffset = Number(this._pvData.utc_offset_seconds ?? 0);
      const clouds = Number(cur.cloud_cover ?? 0);
      const lowClouds = Number(cur.cloud_cover_low ?? 0);
      const visibility = Number(cur.visibility ?? 20000);
      const radiation = Math.round(Number(cur.shortwave_radiation ?? 0));
      const dni = Number(cur.direct_normal_irradiance ?? 0);
      const dhi = Number(cur.diffuse_radiation ?? 0);
      const code = Number(cur.weather_code ?? 0);
      const isDay = Number(cur.is_day ?? 1) === 1;

      const pv = this._config.pv_system;
      const hasPvSystem = pv && pv.totalWp > 0;

      const isFog = code === 45 || code === 48 || visibility < 1000;
      const isHighFog = !isFog && lowClouds >= 75;
      const isRain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

      causeEl.className = '';
      if (!isDay && radiation < 10) {
        causeEl.textContent = isFog ? 'Nacht · Nebel am Standort' : 'Nacht / kein Tageslicht';
      } else if (isFog) {
        causeEl.textContent = `Nebel bremst PV (Sicht ${this._formatVisibility(visibility)})`;
        causeEl.classList.add('pv-cause-warn');
      } else if (isRain) {
        causeEl.textContent = 'Regen / dichte Regenwolken';
        causeEl.classList.add('pv-cause-warn');
      } else if (isHighFog) {
        causeEl.textContent = `Hochnebel / tiefe Wolkendecke (${lowClouds}%)`;
        causeEl.classList.add('pv-cause-warn');
      } else if (clouds >= 70) {
        causeEl.textContent = `Dichte Bewölkung (${clouds}%)`;
      } else if (clouds >= 35) {
        causeEl.textContent = 'Aufgelockert bewölkt';
      } else {
        causeEl.textContent = 'Klar · Gute Sonneneinstrahlung';
        causeEl.classList.add('pv-cause-good');
      }

      const hourly = this._pvData.hourly || {};
      const times = Array.isArray(hourly.time) ? hourly.time : [];
      const hClouds = hourly.cloud_cover || [];
      const hLow = hourly.cloud_cover_low || [];
      const hRad = hourly.shortwave_radiation || [];
      const hDni = hourly.direct_normal_irradiance || [];
      const hDhi = hourly.diffuse_radiation || [];
      const hSun = hourly.sunshine_duration || [];
      const hVis = hourly.visibility || [];
      const hCode = hourly.weather_code || [];
      const hDay = hourly.is_day || [];
      const hTemp = hourly.temperature_2m || [];
      const hWind = hourly.wind_speed_10m || [];

      const geoMap = this._buildGeosphereHourMap(this._geosphereData);
      const liveMet = this._getLiveWeatherEntitySnapshot();
      const weatherMap = this._buildWeatherEntityHourMap();
      const arrays = { times, hClouds, hLow, hVis, hRad, hDni, hDhi, hTemp, hWind };

      const nowIsoPrefix = String(cur.time || '').slice(0, 13);
      let startIdx = times.findIndex((t) => String(t).slice(0, 13) >= nowIsoPrefix);
      if (startIdx < 0) startIdx = 0;

      // Aktuelle Stunde mit ZAMG-Sonnenscheindauer & Physik abgleichen
      const curResolved =
        startIdx < times.length
          ? this._resolveHourlyWeather(startIdx, arrays, geoMap, utcOffset, hSun, weatherMap, liveMet)
          : { sunSec: 0, hasZAMG: false, tempC: liveMet?.tempC ?? null, windMs: liveMet?.windMs ?? 1.5 };
      const curOmSunSec =
        startIdx < times.length
          ? Math.max(0, Math.min(3600, Number(hSun[startIdx] ?? 0)))
          : 0;
      const curTempC = Number.isFinite(liveMet?.tempC)
        ? liveMet.tempC
        : Number.isFinite(curResolved.tempC)
        ? curResolved.tempC
        : Number.isFinite(Number(cur.temperature_2m))
        ? Number(cur.temperature_2m)
        : null;
      const curWindMs = Number.isFinite(liveMet?.windMs)
        ? liveMet.windMs
        : Number.isFinite(curResolved.windMs)
        ? curResolved.windMs
        : Number.isFinite(Number(cur.wind_speed_10m))
        ? Number(cur.wind_speed_10m)
        : 1.5;
      const curAdj = this._applySunshinePhysics({
        isoTime: cur.time,
        utcOffsetSec: utcOffset,
        rad: radiation,
        dni,
        dhi,
        clouds,
        lowClouds,
        visibility,
        sunSec: curResolved.sunSec,
        omSunSec: curOmSunSec,
        hasZAMG: curResolved.hasZAMG,
      });
      const curEstimate = this._computePvEstimate(
        cur.time,
        utcOffset,
        curAdj.rad,
        curAdj.dni,
        curAdj.dhi,
        curTempC,
        curWindMs
      );
      const curSunMin = Math.round(curResolved.sunSec / 60);
      const curSunTag = isDay || curAdj.rad > 0 ? ` · ☀ ${curSunMin}m/h` : '';
      const curTempTag = Number.isFinite(curTempC) ? ` · ${Math.round(curTempC)}°C` : '';
      const curMetSpread =
        liveMet && Math.abs(liveMet.clouds - clouds) >= 35
          ? ` (Met.no ${Math.round(liveMet.clouds)}%)`
          : '';

      if (hasPvSystem) {
        const activeStrs = (curEstimate.stringWatts || []).filter((s) => s.wp > 0);
        const parts = activeStrs.map((s) => `${s.label}:${this._formatCompactWatts(s.watts)}`);
        const splitText = parts.length > 1 ? ` (${parts.join(' · ')})` : '';
        metricsEl.textContent = `PV ~${curEstimate.totalWatts} W${splitText}${curSunTag} · ${curAdj.rad} W/m² · Wolken ${clouds}%${curMetSpread}${curTempTag} · Sicht ${this._formatVisibility(visibility, true)}`;
      } else {
        metricsEl.textContent = `${curAdj.rad} W/m²${curSunTag} · Wolken ${clouds}%${curMetSpread} (Tief ${lowClouds}%)${curTempTag} · Sicht ${this._formatVisibility(visibility, true)}`;
      }

      // Besserung suchen in den nächsten 36 Stunden & 24h-kWh-Ertrag + Sonnenscheindauer berechnen
      let betterIdx = -1;
      let betterResolved = null;
      let peakIdx = -1;
      let peakMetric = -1;
      let total24hWh = 0;
      let total24hSunSec = 0;
      let usedZamg24h = false;

      const sliceEnd = Math.min(times.length, startIdx + 24);
      const hourlyResolved = [];
      const hourlyEstimates = [];

      for (let i = startIdx; i < sliceEnd; i++) {
        const res = this._resolveHourlyWeather(i, arrays, geoMap, utcOffset, hSun, weatherMap, liveMet);
        const est = this._computeHourlyPvEstimate(
          times[i],
          utcOffset,
          res.rad,
          res.dni,
          res.dhi,
          res.tempC,
          res.windMs
        );
        hourlyResolved.push(res);
        hourlyEstimates.push(est);
        total24hWh += est.totalWatts;
        total24hSunSec += res.sunSec;
        if (res.hasZAMG) usedZamg24h = true;
      }

      for (let i = startIdx + 1; i < Math.min(times.length, startIdx + 36); i++) {
        const res = this._resolveHourlyWeather(i, arrays, geoMap, utcOffset, hSun, weatherMap, liveMet);
        const vis = Number(hVis[i] ?? 20000);
        const wmo = Number(hCode[i] ?? 0);
        const day = Number(hDay[i] ?? 0) === 1;
        const noFog = wmo !== 45 && wmo !== 48 && vis >= 1500;

        const est = hasPvSystem
          ? this._computeHourlyPvEstimate(
              times[i],
              utcOffset,
              res.rad,
              res.dni,
              res.dhi,
              res.tempC,
              res.windMs
            ).totalWatts
          : res.rad;

        if (est > peakMetric) {
          peakMetric = est;
          peakIdx = i;
        }

        if (
          betterIdx === -1 &&
          day &&
          noFog &&
          (res.sunSec >= 1500 || res.rad >= 160 || res.clouds <= 55)
        ) {
          betterIdx = i;
          betterResolved = res;
        }
      }

      const formatHourLabel = (iso) => {
        const timePart = String(iso).slice(11, 16);
        const datePart = String(iso).slice(0, 10);
        const todayPart = String(cur.time || '').slice(0, 10);
        return datePart === todayPart ? `Heute ${timePart}` : `Morgen ${timePart}`;
      };

      const sunHours24 = (total24hSunSec / 3600).toFixed(1);
      const sunSourceLabel = this._pvData._fromFallback
        ? this._pvData._fromFallback
        : usedZamg24h
        ? 'ZAMG 1km'
        : 'Open-Meteo';
      const sunSuffix = ` · ☀ ${sunHours24} h Sonne (${sunSourceLabel})`;
      const yieldSuffix = hasPvSystem
        ? ` · 24h-Ertrag (${(pv.totalWp / 1000).toFixed(2)} kWp): ~${(total24hWh / 1000).toFixed(1)} kWh`
        : '';

      if (!isFog && !isHighFog && isDay && clouds <= 45 && radiation >= 150) {
        trendEl.innerHTML = `Prognose: <strong>Gute PV-Bedingungen</strong>${
          peakIdx > -1 ? ` · Max ~${Math.round(peakMetric)} ${hasPvSystem ? 'W' : 'W/m²'}` : ''
        }${sunSuffix}${yieldSuffix}`;
      } else if (betterIdx > -1 && betterResolved) {
        const betterEst = hasPvSystem
          ? this._computeHourlyPvEstimate(
              times[betterIdx],
              utcOffset,
              betterResolved.rad,
              betterResolved.dni,
              betterResolved.dhi,
              betterResolved.tempC,
              betterResolved.windMs
            ).totalWatts
          : Math.round(betterResolved.rad);
        const betterSunMin = Math.round(betterResolved.sunSec / 60);
        trendEl.innerHTML = `Besserung: <strong>${formatHourLabel(
          times[betterIdx]
        )} Uhr</strong> (Wolken ${Math.round(betterResolved.clouds)}%, ☀ ${betterSunMin}m, ~${betterEst} ${
          hasPvSystem ? 'W' : 'W/m²'
        })${sunSuffix}${yieldSuffix}`;
      } else if (peakIdx > -1 && peakMetric > 20) {
        trendEl.innerHTML = `Vorerst trüb · Maximum <strong>${formatHourLabel(
          times[peakIdx]
        )} Uhr</strong> (~${Math.round(peakMetric)} ${
          hasPvSystem ? 'W' : 'W/m²'
        })${sunSuffix}${yieldSuffix}`;
      } else {
        trendEl.textContent = `Vorerst anhaltend trüb / neblig.${sunSuffix}${yieldSuffix}`;
      }

      // 24-Stunden-Mini-Balken & Ertrags-Grafik synchron für denselben Kalendertag (00:00 - 24:00) befüllen
      const barSlots = this._renderPvChart({
        times,
        arrays,
        geoMap,
        weatherMap,
        liveMet,
        utcOffset,
        hSun,
        hDay,
        hCode,
        curTimeIso: cur.time,
        startIdx,
        hasPvSystem,
        pvTotalWp: pv?.totalWp || 0,
      });

      const cells = [];
      let maxSliceVal = hasPvSystem ? Math.max(300, pv.totalWp * 0.25) : 150;
      for (const s of barSlots) {
        maxSliceVal = Math.max(maxSliceVal, s.forecastVal);
      }

      const showNowHighlight = (this._pvDayOffset || 0) === 0;
      for (const s of barSlots) {
        const hh = s.hh;
        const cld = s.clouds;
        const low = s.lowClouds ?? 0;
        const vis = s.visibility ?? 20000;
        const wmo = s.wmo ?? 0;
        const fogHere = wmo === 45 || wmo === 48 || vis < 1000 || low >= 80;
        const sunMin = s.sunMin;
        const isNowCell = showNowHighlight && String(s.iso).slice(0, 13) === nowIsoPrefix;

        const barValue = s.forecastVal;
        const barLabel = hasPvSystem ? this._formatCompactWatts(s.forecastVal) : `${s.rad}W`;
        const pct = Math.min(100, Math.round((barValue / maxSliceVal) * 100));

        let pvTooltip = '';
        if (hasPvSystem) {
          const activeStrs = (s.stringWatts || []).filter((sw) => sw.wp > 0);
          const tipParts = activeStrs.map((sw) => `${sw.label}:${this._formatCompactWatts(sw.watts)}`);
          const tipSplit = tipParts.length > 1 ? ` (${tipParts.join(' · ')})` : '';
          pvTooltip = `PV ~${s.forecastVal} W${tipSplit} · `;
        }

        cells.push(`
          <div class="pv-hour-cell ${isNowCell ? 'is-now' : ''}" title="${this._escapeHtml(
          s.dayLabel
        )} ${hh} Uhr: ${pvTooltip}Sonne ${sunMin} min (${s.hasZAMG ? 'ZAMG' : 'OM'}), ${s.rad} W/m², Wolken ${cld}%, Tiefe Wolken ${low}%, Sicht ${this._formatVisibility(
          vis,
          true
        )}">
            <span class="pv-hour-watt">${barLabel}</span>
            <div class="pv-bar-track">
              <div class="pv-bar-fill" style="height:${pct}%"></div>
            </div>
            <span class="pv-hour-sun ${sunMin > 0 ? '' : 'none'}">☀${sunMin}m</span>
            <span class="pv-hour-cloud ${fogHere ? 'fog' : ''}">${fogHere ? 'Nebel' : `${cld}%`}</span>
            <span class="pv-hour-time">${hh}</span>
          </div>
        `);
      }

      gridEl.innerHTML = cells.join('');
    }

    async _fetchAndBuildRadarLayers() {
      if (!this._map || !window.L) return;
      const L = window.L;

      try {
        const response = await fetch(RAINVIEWER_API_URL, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`RainViewer API HTTP ${response.status}`);
        }
        const data = await response.json();
        if (this._isDestroyed || !this._map) return;

        const host = data.host || 'https://tilecache.rainviewer.com';
        const pastFrames = Array.isArray(data?.radar?.past)
          ? data.radar.past.map((f) => ({ ...f, kind: 'past' }))
          : [];
        const nowcastFrames = Array.isArray(data?.radar?.nowcast)
          ? data.radar.nowcast.map((f) => ({ ...f, kind: 'nowcast' }))
          : [];

        const allFrames = [...pastFrames, ...nowcastFrames];
        if (allFrames.length === 0) {
          this._setStatus('Keine Radar-Frames verfügbar', true);
          return;
        }

        this._clearRadarLayers();

        this._frames = allFrames;
        this._frameLayers = allFrames.map((frame) => {
          const tileUrl = `${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
          const layer = L.tileLayer(tileUrl, {
            tileSize: 256,
            opacity: 0,
            maxNativeZoom: 7,
            maxZoom: 19,
            zIndex: 200,
            attribution: 'Weather data &copy; RainViewer',
          });
          layer.addTo(this._map);
          return layer;
        });

        const startIdx = pastFrames.length > 0 ? pastFrames.length - 1 : 0;
        this._showFrame(startIdx);
        this._setStatus('', false);

        if (this._isPlaying && this._radarEnabled) {
          this._startAnimation();
        }
      } catch (err) {
        this._setStatus(`Radar-Fehler: ${err.message}`, true);
      }
    }

    _clearRadarLayers() {
      if (this._map) {
        this._frameLayers.forEach((layer) => {
          if (this._map.hasLayer(layer)) {
            this._map.removeLayer(layer);
          }
        });
      }
      this._frameLayers = [];
      this._frames = [];
    }

    _showFrame(index) {
      if (!this._frameLayers.length) return;
      const safeIndex =
        ((index % this._frameLayers.length) + this._frameLayers.length) %
        this._frameLayers.length;
      const prevIndex = this._currentIndex;
      this._currentIndex = safeIndex;

      const targetOpacity = this._radarEnabled ? this._opacity : 0;
      const nextLayer = this._frameLayers[safeIndex];
      const prevLayer = this._frameLayers[prevIndex];

      if (nextLayer) {
        nextLayer.setOpacity(targetOpacity);
      }
      if (prevLayer && prevIndex !== safeIndex) {
        prevLayer.setOpacity(0);
      }

      this._frameLayers.forEach((layer, idx) => {
        if (idx !== safeIndex && layer.options.opacity !== 0) {
          layer.setOpacity(0);
        }
      });

      this._updateControlBarUI();
    }

    _applyActiveLayerOpacity() {
      const activeLayer = this._frameLayers[this._currentIndex];
      if (activeLayer) {
        activeLayer.setOpacity(this._radarEnabled ? this._opacity : 0);
      }
      if (this._cloudLayer) {
        this._cloudLayer.setOpacity(Math.min(0.65, this._opacity * 0.75));
      }
    }

    _updateControlBarUI() {
      if (!this.shadowRoot) return;

      const playIcon = this.shadowRoot.getElementById('play-icon');
      const timeValue = this.shadowRoot.getElementById('time-value');
      const timeMode = this.shadowRoot.getElementById('time-mode');
      const timeSlider = this.shadowRoot.getElementById('time-slider');
      const opacitySlider = this.shadowRoot.getElementById('opacity-slider');
      const opacityValue = this.shadowRoot.getElementById('opacity-value');

      if (playIcon) {
        const playing = this._isPlaying && this._radarEnabled;
        playIcon.innerHTML = playing
          ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
          : '<path d="M8 5v14l11-7z"/>';
      }

      if (timeSlider) {
        timeSlider.max = String(Math.max(0, this._frames.length - 1));
        timeSlider.value = String(this._currentIndex);
      }

      const currentFrame = this._frames[this._currentIndex];
      if (currentFrame && timeValue && timeMode) {
        const date = new Date(currentFrame.time * 1000);
        timeValue.textContent = date.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });

        if (currentFrame.kind === 'nowcast') {
          const diffMin = Math.round((currentFrame.time * 1000 - Date.now()) / 60000);
          timeMode.textContent = diffMin > 0 ? `Vorschau +${diffMin}m` : 'Vorschau';
          timeMode.classList.add('nowcast');
        } else {
          timeMode.textContent = this._radarEnabled ? 'Radar' : 'Radar aus';
          timeMode.classList.remove('nowcast');
        }
      }

      if (opacitySlider && opacityValue) {
        opacitySlider.value = String(this._opacity);
        opacityValue.textContent = `${Math.round(this._opacity * 100)}%`;
      }
    }

    _startAnimation() {
      this._stopAnimation();
      if (!this._isPlaying || !this._radarEnabled) return;
      this._animationTimer = setInterval(() => {
        if (this._frames.length > 1) {
          this._showFrame(this._currentIndex + 1);
        }
      }, FRAME_INTERVAL_MS);
    }

    _stopAnimation() {
      if (this._animationTimer) {
        clearInterval(this._animationTimer);
        this._animationTimer = null;
      }
    }

    _startRefreshTimer() {
      this._stopRefreshTimer();
      this._refreshTimer = setInterval(() => {
        if (this._map) {
          this._fetchAndBuildRadarLayers();
          if (this._warningsEnabled) {
            this._fetchAndRenderAustrianWarnings();
          }
        }
        this._fetchPvAndFogForecast();
        if (this._getConfiguredActualEntities().length > 0) {
          this._fetchPvActualHistory(true);
        }
      }, REFRESH_INTERVAL_MS);
    }

    _stopRefreshTimer() {
      if (this._refreshTimer) {
        clearInterval(this._refreshTimer);
        this._refreshTimer = null;
      }
    }
  }

  const EDITOR_AZIMUTH_PRESETS = [
    { deg: 0, label: 'Nord (0°)' },
    { deg: 45, label: 'NO (45°)' },
    { deg: 90, label: 'Ost (90°)' },
    { deg: 135, label: 'SO (135°)' },
    { deg: 180, label: 'Süd (180°)' },
    { deg: 225, label: 'SW (225°)' },
    { deg: 270, label: 'West (270°)' },
    { deg: 315, label: 'NW (315°)' },
  ];

  class PvCockpitCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._config = {};
      this._hass = null;
      this._rendered = false;
      this._calibrating = false;
      this._calibStatus = '';
      this._calibError = false;
      this._stringCalibStates = {};
      this._openShadePanels = new Set();
      this._stringsRenderKey = '';
    }

    set hass(hass) {
      this._hass = hass;
      if (this._rendered) {
        this._syncCoordPlaceholders();
        this._syncEntityDatalist();
      }
    }

    setConfig(config) {
      if (config && typeof config === 'object') {
        try {
          this._config = JSON.parse(JSON.stringify(config));
        } catch (_err) {
          this._config = { ...config };
        }
      } else {
        this._config = {};
      }
      if (!this._rendered) {
        this._render();
      }
      this._syncInputs();
    }

    connectedCallback() {
      if (!this._rendered) {
        this._render();
      }
      this._syncInputs();
    }

    _getBool(key, fallback) {
      return this._config[key] !== undefined ? Boolean(this._config[key]) : fallback;
    }

    _getDefaultCalibDate() {
      if (this._config.pv_shading_date) return String(this._config.pv_shading_date);
      const dt = new Date(Date.now() - 86400000);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const d = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    _getStringsFromConfig() {
      const pvSys = normalizePvSystemConfig(this._config.pv_system);
      const rawStrings = getPvSystemStrings(pvSys);
      const list = rawStrings.length > 0
        ? rawStrings
        : [
            {
              id: 'sued',
              key: 'sued',
              label: 'Süd',
              count: 22,
              watt: 430,
              wp: 22 * 430,
              tilt: pvSys.tilt,
              azimuth: 180,
              actual_entity: '',
              shading: [],
              shading_date: '',
            },
          ];
      return {
        defaultTilt: pvSys.tilt,
        strings: list.map((s, idx) => ({
          id: s.id || slugifyStringKey(s.label, idx),
          name: s.label || `String ${idx + 1}`,
          count: Math.max(0, Math.round(Number(s.count) || 0)),
          watt: Math.max(0, Math.round(Number(s.watt) || 0)),
          azimuth: Math.round(normalizeAzimuthDeg(s.azimuth)),
          tilt: Math.min(90, Math.max(0, Math.round(Number(s.tilt) || 0))),
          actual_entity: String(s.actual_entity || '').trim(),
          shading: normalizePvShadingConfig(s.shading),
          shading_date: s.shading_date ? String(s.shading_date).trim() : '',
        })),
      };
    }

    _computeStringsRenderKey(strings) {
      return JSON.stringify(
        strings.map((s) => ({
          id: s.id,
          sc: s.shading.length,
          sd: s.shading_date,
          el: s.shading.map((sec) => `${sec.from_azimuth}-${sec.to_azimuth}-${sec.min_elevation}-${sec.transmission}`),
        }))
      );
    }

    _emitConfig(nextConfig) {
      this._config = nextConfig;
      this.dispatchEvent(
        new CustomEvent('config-changed', {
          detail: { config: nextConfig },
          bubbles: true,
          composed: true,
        })
      );
    }

    _updateRootField(key, value, deleteIfEmpty = false) {
      const next = { ...this._config };
      if (!next.type) next.type = `custom:${CARD_TAG}`;
      if (deleteIfEmpty && (value === '' || value === null || value === undefined)) {
        delete next[key];
      } else {
        next[key] = value;
      }
      this._emitConfig(next);
      this._syncInputs();
    }

    _saveStringsToConfig(strings, defaultTilt, rebuildDom = false) {
      const seenIds = new Set();
      const cleaned = strings.map((item, idx) => {
        const name = String(item.name || '').trim() || `String ${idx + 1}`;
        let id = String(item.id || '').trim() || slugifyStringKey(name, idx);
        while (seenIds.has(id)) {
          id = `${id}_${idx + 1}`;
        }
        seenIds.add(id);
        const count = Math.max(0, Math.round(Number(item.count) || 0));
        const watt = Math.max(0, Math.round(Number(item.watt) || 0));
        const azimuth = Math.round(normalizeAzimuthDeg(item.azimuth));
        const tilt = Math.min(90, Math.max(0, Math.round(Number(item.tilt) || 0)));
        const actualEntity = String(item.actual_entity || '').trim();
        const shading = normalizePvShadingConfig(item.shading);
        const shadingDate = String(item.shading_date || '').trim();

        const obj = {
          id,
          name,
          count,
          watt,
          azimuth,
          tilt,
        };
        if (actualEntity) obj.actual_entity = actualEntity;
        if (shading.length > 0) {
          obj.shading = shading;
          if (shadingDate) obj.shading_date = shadingDate;
        } else if (shadingDate) {
          obj.shading = [];
          obj.shading_date = shadingDate;
        }
        return obj;
      });

      const tiltVal = Math.min(90, Math.max(0, Math.round(Number(defaultTilt) || 0)));
      const next = {
        ...this._config,
        pv_system: {
          tilt: tiltVal,
          strings: cleaned,
        },
      };
      if (!next.type) next.type = `custom:${CARD_TAG}`;
      this._emitConfig(next);
      if (rebuildDom) {
        this._stringsRenderKey = '';
      }
      this._syncInputs();
    }

    _updateTotalKwpBadge(strings) {
      const totalEl = this.shadowRoot?.getElementById('ed-total-kwp');
      if (totalEl) {
        const totalWp = strings.reduce((acc, s) => acc + s.count * s.watt, 0);
        totalEl.textContent = `${(totalWp / 1000).toFixed(2)} kWp`;
      }
    }

    _syncCoordPlaceholders() {
      const latEl = this.shadowRoot?.getElementById('ed-lat');
      const lonEl = this.shadowRoot?.getElementById('ed-lon');
      if (latEl) {
        const haLat = this._hass?.config?.latitude;
        latEl.placeholder = typeof haLat === 'number' ? `HA: ${haLat.toFixed(4)}` : '48.3003';
      }
      if (lonEl) {
        const haLon = this._hass?.config?.longitude;
        lonEl.placeholder = typeof haLon === 'number' ? `HA: ${haLon.toFixed(4)}` : '14.2858';
      }
    }

    _syncEntityDatalist() {
      const listEl = this.shadowRoot?.getElementById('ed-pv-entities');
      if (listEl && this._hass?.states) {
        const entities = Object.keys(this._hass.states)
          .filter((id) => {
            if (!id.startsWith('sensor.')) return false;
            const st = this._hass.states[id];
            const u = String(st?.attributes?.unit_of_measurement || '').toLowerCase();
            const dc = String(st?.attributes?.device_class || '').toLowerCase();
            return (
              dc === 'power' ||
              dc === 'energy' ||
              u === 'w' ||
              u === 'kw' ||
              u === 'wh' ||
              u === 'kwh'
            );
          })
          .sort();
        listEl.innerHTML = entities
          .map((id) => {
            const fn = this._hass.states[id]?.attributes?.friendly_name || '';
            const escId = id.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            const escFn = String(fn).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            return `<option value="${escId}">${escFn}</option>`;
          })
          .join('');
      }

      const weatherListEl = this.shadowRoot?.getElementById('ed-weather-entities');
      if (weatherListEl && this._hass?.states) {
        const wEntities = Object.keys(this._hass.states)
          .filter((id) => id.startsWith('weather.'))
          .sort();
        weatherListEl.innerHTML = wEntities
          .map((id) => {
            const fn = this._hass.states[id]?.attributes?.friendly_name || '';
            const escId = id.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            const escFn = String(fn).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            return `<option value="${escId}">${escFn}</option>`;
          })
          .join('');
      }
    }

    _syncInputs() {
      if (!this.shadowRoot || !this._rendered) return;
      const zoom = Number.isFinite(Number(this._config.zoom)) ? Number(this._config.zoom) : 7;
      const rawHeight = this._config.height !== undefined ? this._config.height : '450px';
      const height = typeof rawHeight === 'number' ? `${rawHeight}px` : String(rawHeight);
      const opacity =
        this._config.opacity !== undefined && !Number.isNaN(Number(this._config.opacity))
          ? Math.min(1, Math.max(0, Number(this._config.opacity)))
          : 0.75;
      const pvMode = normalizePvModeValue(this._config.pv_mode);

      const setVal = (id, val) => {
        const el = this.shadowRoot.getElementById(id);
        if (el && this.shadowRoot.activeElement !== el) {
          el.value = val;
        }
      };
      const setChecked = (id, val) => {
        const el = this.shadowRoot.getElementById(id);
        if (el) el.checked = Boolean(val);
      };
      const setText = (id, val) => {
        const el = this.shadowRoot.getElementById(id);
        if (el) el.textContent = val;
      };

      setVal('ed-title', this._config.title || '');
      setVal('ed-zoom', String(zoom));
      setText('ed-zoom-val', String(zoom));
      setVal('ed-height', height);
      setVal('ed-opacity', String(opacity));
      setText('ed-opacity-val', opacity.toFixed(2));

      this.shadowRoot.querySelectorAll('[data-height-preset]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-height-preset') === height);
      });

      setChecked('ed-auto-play', this._getBool('auto_play', true));
      setChecked('ed-show-radar', this._getBool('show_radar', true));
      setChecked('ed-show-pv', this._getBool('show_pv_panel', true));
      setChecked('ed-show-map', this._getBool('show_map', true));
      setChecked('ed-hide-night', this._getBool('hide_night', false));
      setChecked('ed-show-clouds', this._getBool('show_clouds', true));
      setChecked('ed-show-warnings', this._getBool('show_warnings', false));

      const { defaultTilt, strings } = this._getStringsFromConfig();
      setVal('ed-tilt', String(defaultTilt));
      this._updateTotalKwpBadge(strings);

      const stringsContainer = this.shadowRoot.getElementById('ed-strings-list');
      const focusInsideStrings = Boolean(
        stringsContainer &&
          this.shadowRoot.activeElement &&
          stringsContainer.contains(this.shadowRoot.activeElement)
      );
      const nextKey = this._computeStringsRenderKey(strings);
      if (!focusInsideStrings && nextKey !== this._stringsRenderKey) {
        this._renderStringCards(strings, defaultTilt);
      } else {
        this._syncExistingStringCards(strings);
      }

      this.shadowRoot.querySelectorAll('[data-pv-mode]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-pv-mode') === pvMode);
      });

      const hasLat =
        this._config.latitude !== undefined &&
        this._config.latitude !== null &&
        this._config.latitude !== '' &&
        Number.isFinite(Number(this._config.latitude));
      const hasLon =
        this._config.longitude !== undefined &&
        this._config.longitude !== null &&
        this._config.longitude !== '' &&
        Number.isFinite(Number(this._config.longitude));

      setVal('ed-lat', hasLat ? String(this._config.latitude) : '');
      setVal('ed-lon', hasLon ? String(this._config.longitude) : '');
      setVal('ed-actual-entity', String(this._config.pv_actual_entity || ''));
      setVal('ed-weather-entity', String(this._config.weather_entity || ''));

      const defaultCalibDate = this._getDefaultCalibDate();
      const calibDateEl = this.shadowRoot.getElementById('ed-calib-date');
      if (calibDateEl && !calibDateEl.value) {
        calibDateEl.value = defaultCalibDate;
      } else if (
        calibDateEl &&
        this._config.pv_shading_date &&
        this.shadowRoot.activeElement !== calibDateEl
      ) {
        calibDateEl.value = String(this._config.pv_shading_date);
      }

      const globalSectors = normalizePvShadingConfig(this._config.pv_shading);
      const globalSummaryBadge = this.shadowRoot.getElementById('ed-global-shade-badge');
      if (globalSummaryBadge) {
        globalSummaryBadge.textContent =
          globalSectors.length > 0
            ? `${globalSectors.length} ${globalSectors.length === 1 ? 'Sektor' : 'Sektoren'} aktiv`
            : 'Inaktiv';
      }
      const globalDetails = this.shadowRoot.getElementById('ed-global-shading-details');
      if (globalDetails && globalSectors.length > 0 && !this._globalDetailsUserToggled) {
        globalDetails.open = true;
      }

      this._syncCoordPlaceholders();
      this._syncEntityDatalist();
      this._renderShadingSectors();
      this._syncCalibStatusUI();
    }

    _syncExistingStringCards(strings) {
      const listEl = this.shadowRoot?.getElementById('ed-strings-list');
      if (!listEl) return;
      const activeEl = this.shadowRoot.activeElement;
      strings.forEach((str, idx) => {
        const kwpBadge = listEl.querySelector(`[data-str-kwp="${idx}"]`);
        if (kwpBadge) {
          kwpBadge.textContent = `${((str.count * str.watt) / 1000).toFixed(2)} kWp`;
        }
        const presetSel = listEl.querySelector(`[data-str-az-preset="${idx}"]`);
        if (presetSel && activeEl !== presetSel) {
          const match = EDITOR_AZIMUTH_PRESETS.find((p) => p.deg === str.azimuth);
          presetSel.value = match ? String(match.deg) : 'custom';
        }
        const syncField = (selector, value) => {
          const el = listEl.querySelector(selector);
          if (el && el !== activeEl) {
            el.value = value;
          }
        };
        syncField(`[data-str-name="${idx}"]`, str.name);
        syncField(`[data-str-count="${idx}"]`, String(str.count));
        syncField(`[data-str-watt="${idx}"]`, String(str.watt));
        syncField(`[data-str-az="${idx}"]`, String(str.azimuth));
        syncField(`[data-str-tilt="${idx}"]`, String(str.tilt));
        syncField(`[data-str-entity="${idx}"]`, str.actual_entity || '');
        this._syncStringCalibUI(idx, str.id);
      });
    }

    _syncStringCalibUI(idx, strId) {
      const listEl = this.shadowRoot?.getElementById('ed-strings-list');
      if (!listEl) return;
      const state = this._stringCalibStates[strId] || {};
      const btn = listEl.querySelector(`[data-str-calib-btn="${idx}"]`);
      if (btn) {
        btn.disabled = Boolean(state.calibrating);
        btn.textContent = state.calibrating ? 'Analysiere...' : 'Kalibrieren';
      }
      const statusEl = listEl.querySelector(`[data-str-calib-status="${idx}"]`);
      if (statusEl) {
        statusEl.textContent = state.status || '';
        statusEl.className = `ed-calib-status${
          state.error ? ' error' : state.status ? ' ok' : ''
        }`;
        statusEl.style.display = state.status ? 'block' : 'none';
      }
    }

    _renderStringCards(strings, defaultTilt) {
      const listEl = this.shadowRoot?.getElementById('ed-strings-list');
      if (!listEl) return;
      this._stringsRenderKey = this._computeStringsRenderKey(strings);

      const esc = (s) =>
        String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

      const fallbackDate = this._getDefaultCalibDate();

      listEl.innerHTML = strings
        .map((str, idx) => {
          const kwp = ((str.count * str.watt) / 1000).toFixed(2);
          const presetMatch = EDITOR_AZIMUTH_PRESETS.find((p) => p.deg === str.azimuth);
          const presetVal = presetMatch ? String(presetMatch.deg) : 'custom';
          const shadeCount = str.shading.length;
          const shadeSummary =
            shadeCount > 0
              ? `${shadeCount} ${shadeCount === 1 ? 'Sektor' : 'Sektoren'}${
                  str.shading_date ? ` · ${str.shading_date}` : ''
                }`
              : str.shading_date
              ? `Unverschattet (${str.shading_date})`
              : 'Keine Verschattung';
          const isOpen = this._openShadePanels.has(str.id);
          const calibDateVal = str.shading_date || fallbackDate;
          const calibState = this._stringCalibStates[str.id] || {};
          const sectorsHtml =
            shadeCount === 0
              ? '<div class="ed-shading-empty">Keine Verschattung aktiv – volle Einstrahlung laut Sonnenstand.</div>'
              : str.shading
                  .map(
                    (sec, sIdx) => `
                  <div class="ed-shade-row">
                    <div class="ed-shade-head">
                      <span class="ed-shade-label">${esc(sec.label || 'Sektor')} · ${Math.round(
                        sec.from_azimuth
                      )}°–${Math.round(sec.to_azimuth)}°</span>
                      <button type="button" class="ed-shade-del" data-str-shade-del="${idx}:${sIdx}" title="Sektor entfernen">×</button>
                    </div>
                    <div class="ed-shade-inputs">
                      <label class="ed-mini-field">
                        <span>Schatten unter (°)</span>
                        <input type="number" min="1" max="85" step="0.5" value="${sec.min_elevation}" data-str-shade-el="${idx}:${sIdx}" />
                      </label>
                      <label class="ed-mini-field">
                        <span>Restlicht (%)</span>
                        <input type="number" min="0" max="95" step="5" value="${Math.round(
                          sec.transmission * 100
                        )}" data-str-shade-tr="${idx}:${sIdx}" />
                      </label>
                    </div>
                  </div>`
                  )
                  .join('');

          return `
            <div class="ed-str-card" data-str-idx="${idx}">
              <div class="ed-str-head">
                <input
                  type="text"
                  class="ed-str-name-inp"
                  data-str-name="${idx}"
                  value="${esc(str.name)}"
                  placeholder="String-Name (z. B. Deye PV2)"
                  aria-label="String-Name"
                />
                <span class="ed-str-kwp" data-str-kwp="${idx}">${kwp} kWp</span>
                ${
                  strings.length > 1
                    ? `<button type="button" class="ed-shade-del" data-str-del="${idx}" title="String entfernen">×</button>`
                    : ''
                }
              </div>

              <div class="ed-str-mod-row">
                <label class="ed-mini-field">
                  <span>Module</span>
                  <input type="number" min="0" max="200" value="${str.count}" data-str-count="${idx}" aria-label="Modulanzahl" />
                </label>
                <span class="ed-pv-sep">×</span>
                <label class="ed-mini-field">
                  <span>Watt / Modul</span>
                  <input type="number" min="0" max="2000" step="5" value="${str.watt}" data-str-watt="${idx}" aria-label="Modulleistung in Watt" />
                </label>
              </div>

              <div class="ed-str-orient-row">
                <label class="ed-mini-field">
                  <span>Richtung</span>
                  <select data-str-az-preset="${idx}" aria-label="Ausrichtungs-Preset">
                    ${EDITOR_AZIMUTH_PRESETS.map(
                      (p) =>
                        `<option value="${p.deg}"${
                          presetVal === String(p.deg) ? ' selected' : ''
                        }>${p.label}</option>`
                    ).join('')}
                    <option value="custom"${presetVal === 'custom' ? ' selected' : ''}>Eigene (°)</option>
                  </select>
                </label>
                <label class="ed-mini-field">
                  <span>Azimut (°)</span>
                  <input type="number" min="0" max="359" step="1" value="${str.azimuth}" data-str-az="${idx}" aria-label="Azimut in Grad" />
                </label>
                <label class="ed-mini-field">
                  <span>Neigung (°)</span>
                  <input type="number" min="0" max="90" step="1" value="${str.tilt}" data-str-tilt="${idx}" aria-label="Neigung in Grad" />
                </label>
              </div>

              <label class="ed-mini-field">
                <span>Ist-Sensor für diesen String (optional)</span>
                <input
                  type="text"
                  list="ed-pv-entities"
                  value="${esc(str.actual_entity)}"
                  data-str-entity="${idx}"
                  placeholder="z. B. sensor.deye_pv2_power (für Pro-String-Kalibrierung &amp; Ist)"
                />
              </label>

              <details class="ed-str-shade-details" data-str-shade-details="${idx}"${isOpen ? ' open' : ''}>
                <summary>
                  <span>Verschattung (Sonnentag-Kalibrierung)</span>
                  <span class="ed-str-shade-meta">${esc(shadeSummary)} ▾</span>
                </summary>
                <div class="ed-str-shade-body">
                  <div class="ed-calib-row">
                    <input type="date" value="${esc(calibDateVal)}" data-str-calib-date="${idx}" aria-label="Sonnentag für String-Kalibrierung" />
                    <button type="button" class="ed-action-btn" data-str-calib-btn="${idx}"${
                      calibState.calibrating ? ' disabled' : ''
                    }>${calibState.calibrating ? 'Analysiere...' : 'Kalibrieren'}</button>
                  </div>
                  <div class="ed-calib-status${
                    calibState.error ? ' error' : calibState.status ? ' ok' : ''
                  }" data-str-calib-status="${idx}" style="display:${calibState.status ? 'block' : 'none'}">${esc(
                    calibState.status || ''
                  )}</div>
                  <div class="ed-str-sectors">${sectorsHtml}</div>
                  <div class="ed-shade-footer">
                    <button type="button" class="ed-ghost-btn" data-str-add-shade="${idx}">+ Sektor</button>
                    <button type="button" class="ed-ghost-btn" data-str-clear-shade="${idx}">Zurücksetzen</button>
                  </div>
                </div>
              </details>
            </div>
          `;
        })
        .join('');

      const updateStringField = (idx, mutator, rebuildDom = false) => {
        const cur = this._getStringsFromConfig();
        if (!cur.strings[idx]) return;
        mutator(cur.strings[idx]);
        this._saveStringsToConfig(cur.strings, cur.defaultTilt, rebuildDom);
      };

      listEl.querySelectorAll('[data-str-name]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const idx = Number(inp.getAttribute('data-str-name'));
          updateStringField(idx, (s) => {
            s.name = e.target.value;
          });
        });
      });

      listEl.querySelectorAll('[data-str-count]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const idx = Number(inp.getAttribute('data-str-count'));
          const val = Math.max(0, Math.round(Number(e.target.value) || 0));
          updateStringField(idx, (s) => {
            s.count = val;
          });
        });
      });

      listEl.querySelectorAll('[data-str-watt]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const idx = Number(inp.getAttribute('data-str-watt'));
          const val = Math.max(0, Math.round(Number(e.target.value) || 0));
          updateStringField(idx, (s) => {
            s.watt = val;
          });
        });
      });

      listEl.querySelectorAll('[data-str-az-preset]').forEach((sel) => {
        sel.addEventListener('change', (e) => {
          const idx = Number(sel.getAttribute('data-str-az-preset'));
          const raw = e.target.value;
          if (raw === 'custom') return;
          const deg = Math.round(normalizeAzimuthDeg(Number(raw)));
          const azInp = listEl.querySelector(`[data-str-az="${idx}"]`);
          if (azInp) azInp.value = String(deg);
          updateStringField(idx, (s) => {
            s.azimuth = deg;
          });
        });
      });

      listEl.querySelectorAll('[data-str-az]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const idx = Number(inp.getAttribute('data-str-az'));
          const val = Math.round(normalizeAzimuthDeg(Number(e.target.value) || 0));
          updateStringField(idx, (s) => {
            s.azimuth = val;
          });
        });
      });

      listEl.querySelectorAll('[data-str-tilt]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const idx = Number(inp.getAttribute('data-str-tilt'));
          const val = Math.min(90, Math.max(0, Math.round(Number(e.target.value) || 0)));
          updateStringField(idx, (s) => {
            s.tilt = val;
          });
        });
      });

      listEl.querySelectorAll('[data-str-entity]').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const idx = Number(inp.getAttribute('data-str-entity'));
          const val = e.target.value.trim();
          updateStringField(idx, (s) => {
            s.actual_entity = val;
          });
        });
      });

      listEl.querySelectorAll('[data-str-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-str-del'));
          const cur = this._getStringsFromConfig();
          if (cur.strings.length <= 1) return;
          const removed = cur.strings[idx];
          if (removed) {
            this._openShadePanels.delete(removed.id);
            delete this._stringCalibStates[removed.id];
          }
          cur.strings.splice(idx, 1);
          this._saveStringsToConfig(cur.strings, cur.defaultTilt, true);
        });
      });

      listEl.querySelectorAll('[data-str-shade-details]').forEach((det) => {
        det.addEventListener('toggle', () => {
          const idx = Number(det.getAttribute('data-str-shade-details'));
          const cur = this._getStringsFromConfig();
          const str = cur.strings[idx];
          if (!str) return;
          if (det.open) this._openShadePanels.add(str.id);
          else this._openShadePanels.delete(str.id);
        });
      });

      listEl.querySelectorAll('[data-str-calib-btn]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-str-calib-btn'));
          this._runStringSunnyDayCalibration(idx);
        });
      });

      listEl.querySelectorAll('[data-str-add-shade]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-str-add-shade'));
          const cur = this._getStringsFromConfig();
          const str = cur.strings[idx];
          if (!str) return;
          this._openShadePanels.add(str.id);
          str.shading.push({
            from_azimuth: 105,
            to_azimuth: 165,
            min_elevation: 16,
            transmission: 0.15,
            label: 'Morgens (SO)',
          });
          this._saveStringsToConfig(cur.strings, cur.defaultTilt, true);
        });
      });

      listEl.querySelectorAll('[data-str-clear-shade]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-str-clear-shade'));
          const cur = this._getStringsFromConfig();
          const str = cur.strings[idx];
          if (!str) return;
          this._openShadePanels.add(str.id);
          delete this._stringCalibStates[str.id];
          str.shading = [];
          str.shading_date = '';
          this._saveStringsToConfig(cur.strings, cur.defaultTilt, true);
        });
      });

      listEl.querySelectorAll('[data-str-shade-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const [idxStr, sIdxStr] = String(btn.getAttribute('data-str-shade-del')).split(':');
          const idx = Number(idxStr);
          const sIdx = Number(sIdxStr);
          const cur = this._getStringsFromConfig();
          const str = cur.strings[idx];
          if (!str) return;
          this._openShadePanels.add(str.id);
          str.shading.splice(sIdx, 1);
          this._saveStringsToConfig(cur.strings, cur.defaultTilt, true);
        });
      });

      listEl.querySelectorAll('[data-str-shade-el]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const [idxStr, sIdxStr] = String(inp.getAttribute('data-str-shade-el')).split(':');
          const idx = Number(idxStr);
          const sIdx = Number(sIdxStr);
          const val = Math.min(85, Math.max(1, Number(e.target.value) || 1));
          const cur = this._getStringsFromConfig();
          const str = cur.strings[idx];
          if (!str || !str.shading[sIdx]) return;
          this._openShadePanels.add(str.id);
          str.shading[sIdx].min_elevation = Math.round(val * 2) / 2;
          this._saveStringsToConfig(cur.strings, cur.defaultTilt, true);
        });
      });

      listEl.querySelectorAll('[data-str-shade-tr]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const [idxStr, sIdxStr] = String(inp.getAttribute('data-str-shade-tr')).split(':');
          const idx = Number(idxStr);
          const sIdx = Number(sIdxStr);
          const val = Math.min(95, Math.max(0, Number(e.target.value) || 0));
          const cur = this._getStringsFromConfig();
          const str = cur.strings[idx];
          if (!str || !str.shading[sIdx]) return;
          this._openShadePanels.add(str.id);
          str.shading[sIdx].transmission = Math.round(val) / 100;
          this._saveStringsToConfig(cur.strings, cur.defaultTilt, true);
        });
      });
    }

    _syncCalibStatusUI() {
      const statusEl = this.shadowRoot?.getElementById('ed-calib-status');
      const btnEl = this.shadowRoot?.getElementById('ed-calib-btn');
      if (btnEl) {
        btnEl.disabled = this._calibrating;
        btnEl.textContent = this._calibrating ? 'Analysiere...' : 'Global kalibrieren';
      }
      if (statusEl) {
        statusEl.textContent = this._calibStatus || '';
        statusEl.className = `ed-calib-status${this._calibError ? ' error' : this._calibStatus ? ' ok' : ''}`;
        statusEl.style.display = this._calibStatus ? 'block' : 'none';
      }
    }

    _updateShadingSectors(nextSectors, shadingDate = undefined) {
      const normalized = normalizePvShadingConfig(nextSectors);
      const next = { ...this._config };
      if (!next.type) next.type = `custom:${CARD_TAG}`;
      if (normalized.length > 0) {
        next.pv_shading = normalized;
        if (shadingDate !== undefined) {
          if (shadingDate) next.pv_shading_date = shadingDate;
          else delete next.pv_shading_date;
        }
      } else {
        delete next.pv_shading;
        delete next.pv_shading_date;
      }
      this._emitConfig(next);
      this._syncInputs();
    }

    _renderShadingSectors() {
      const listEl = this.shadowRoot?.getElementById('ed-shading-list');
      if (!listEl) return;
      const sectors = normalizePvShadingConfig(this._config.pv_shading);
      if (sectors.length === 0) {
        listEl.innerHTML =
          '<div class="ed-shading-empty">Keine globale Fallback-Verschattung aktiv.</div>';
        return;
      }

      const esc = (s) =>
        String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

      listEl.innerHTML = sectors
        .map(
          (sec, idx) => `
          <div class="ed-shade-row" data-shade-idx="${idx}">
            <div class="ed-shade-head">
              <span class="ed-shade-label">${esc(sec.label || 'Sektor')} · ${Math.round(
                sec.from_azimuth
              )}°–${Math.round(sec.to_azimuth)}°</span>
              <button type="button" class="ed-shade-del" data-shade-del="${idx}" title="Sektor entfernen">×</button>
            </div>
            <div class="ed-shade-inputs">
              <label class="ed-mini-field">
                <span>Schatten unter (°)</span>
                <input type="number" min="1" max="85" step="0.5" value="${sec.min_elevation}" data-shade-el="${idx}" />
              </label>
              <label class="ed-mini-field">
                <span>Restlicht (%)</span>
                <input type="number" min="0" max="95" step="5" value="${Math.round(
                  sec.transmission * 100
                )}" data-shade-tr="${idx}" />
              </label>
            </div>
          </div>`
        )
        .join('');

      listEl.querySelectorAll('[data-shade-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-shade-del'));
          const cur = normalizePvShadingConfig(this._config.pv_shading);
          cur.splice(idx, 1);
          this._updateShadingSectors(cur);
        });
      });

      listEl.querySelectorAll('[data-shade-el]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const idx = Number(inp.getAttribute('data-shade-el'));
          const val = Math.min(85, Math.max(1, Number(e.target.value) || 1));
          const cur = normalizePvShadingConfig(this._config.pv_shading);
          if (cur[idx]) {
            cur[idx].min_elevation = Math.round(val * 2) / 2;
            this._updateShadingSectors(cur);
          }
        });
      });

      listEl.querySelectorAll('[data-shade-tr]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const idx = Number(inp.getAttribute('data-shade-tr'));
          const val = Math.min(95, Math.max(0, Number(e.target.value) || 0));
          const cur = normalizePvShadingConfig(this._config.pv_shading);
          if (cur[idx]) {
            cur[idx].transmission = Math.round(val) / 100;
            this._updateShadingSectors(cur);
          }
        });
      });
    }

    async _fetchCalibrationBucketsForEntity(entityId, dateStr) {
      const [yy, mm, dd] = dateStr.split('-').map(Number);
      const dayStart = new Date(yy, mm - 1, dd, 0, 0, 0, 0);
      const dayEnd = new Date(yy, mm - 1, dd, 23, 59, 59, 999);
      const utcOffsetSec = -new Date(yy, mm - 1, dd, 12, 0, 0).getTimezoneOffset() * 60;

      const stateObj = this._hass?.states?.[entityId];
      const attrs = stateObj?.attributes || {};
      const unitRaw = String(attrs.unit_of_measurement || '').trim();
      const unitLow = unitRaw.toLowerCase();
      const devClass = String(attrs.device_class || '').toLowerCase();
      const isEnergy =
        devClass === 'energy' || unitLow === 'kwh' || unitLow === 'wh' || unitLow === 'mwh';
      let scale = 1;
      if (unitLow === 'kw' || unitLow === 'kwh') scale = 1000;
      else if (unitLow === 'mw' || unitLow === 'mwh') scale = 1000000;

      const startIso = dayStart.toISOString();
      const endIso = dayEnd.toISOString();
      const path =
        `history/period/${encodeURIComponent(startIso)}` +
        `?end_time=${encodeURIComponent(endIso)}` +
        `&filter_entity_id=${encodeURIComponent(entityId)}` +
        `&minimal_response&significant_changes_only=0` +
        (stateObj?.attributes ? '&no_attributes' : '');

      const res = await this._hass.callApi('GET', path);
      const rawSeries = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : [];

      const points = [];
      for (const pt of rawSeries) {
        if (!pt || typeof pt !== 'object') continue;
        const rawState = pt.state !== undefined ? pt.state : pt.s;
        const num = parseFloat(rawState);
        const rawTs = pt.last_changed || pt.lc || pt.last_updated || pt.lu;
        const ts = Date.parse(rawTs);
        if (Number.isFinite(num) && Number.isFinite(ts)) {
          points.push({ t: ts, v: isEnergy ? num * scale : Math.max(0, num * scale) });
        }
      }
      points.sort((a, b) => a.t - b.t);

      const buckets = [];
      let bucketMinutes = 15;

      if (points.length >= 6) {
        const stepMs = 15 * 60 * 1000;
        const baseMs = dayStart.getTime();
        for (let m = 4 * 60; m < 21 * 60; m += 15) {
          const bStart = baseMs + m * 60 * 1000;
          const bEnd = bStart + stepMs;
          let avgWatts = null;

          if (!isEnergy) {
            if (points[0].t <= bEnd) {
              let idx = 0;
              let curVal = points[0].v;
              while (idx < points.length && points[idx].t <= bStart) {
                curVal = points[idx].v;
                idx++;
              }
              let curT = Math.max(bStart, points[0].t);
              let wattMs = 0;
              let covMs = 0;
              while (idx < points.length && points[idx].t < bEnd) {
                const nt = points[idx].t;
                if (nt > curT) {
                  const dt = nt - curT;
                  wattMs += curVal * dt;
                  covMs += dt;
                  curT = nt;
                }
                curVal = points[idx].v;
                idx++;
              }
              if (bEnd > curT) {
                const dt = bEnd - curT;
                wattMs += curVal * dt;
                covMs += dt;
              }
              if (covMs > 0) avgWatts = wattMs / covMs;
            }
          } else {
            let prevV = null;
            let hasAny = false;
            let deltaWh = 0;
            for (const pt of points) {
              if (pt.t <= bStart) prevV = pt.v;
              else if (pt.t <= bEnd) {
                hasAny = true;
                if (prevV !== null) {
                  const diff = pt.v - prevV;
                  if (diff >= 0 && diff < 250000) deltaWh += diff;
                }
                prevV = pt.v;
              } else break;
            }
            if (hasAny) avgWatts = deltaWh / 0.25;
          }

          if (avgWatts !== null) {
            const midDate = new Date(bStart + stepMs / 2);
            const midIso = `${dateStr}T${String(midDate.getHours()).padStart(2, '0')}:${String(
              midDate.getMinutes()
            ).padStart(2, '0')}`;
            buckets.push({ midIso, actualWatts: avgWatts });
          }
        }
      } else if (typeof this._hass.callWS === 'function') {
        bucketMinutes = 60;
        const wsRes = await this._hass.callWS({
          type: 'recorder/statistics_during_period',
          start_time: startIso,
          end_time: endIso,
          statistic_ids: [entityId],
          period: 'hour',
          types: ['mean', 'change', 'sum'],
        });
        const statRows = Array.isArray(wsRes?.[entityId]) ? wsRes[entityId] : [];
        for (const row of statRows) {
          const ts = typeof row.start === 'number' ? row.start : Date.parse(row.start);
          if (!Number.isFinite(ts)) continue;
          const rawVal = !isEnergy
            ? Number(row.mean)
            : row.change !== undefined && row.change !== null
            ? Number(row.change)
            : NaN;
          if (!Number.isFinite(rawVal)) continue;
          const midDate = new Date(ts + 1800000);
          const midIso = `${dateStr}T${String(midDate.getHours()).padStart(2, '0')}:30`;
          buckets.push({ midIso, actualWatts: Math.max(0, rawVal * scale) });
        }
      }

      return { buckets, bucketMinutes, utcOffsetSec };
    }

    _getCoordsForCalibration() {
      const latDeg =
        this._config.latitude !== undefined &&
        this._config.latitude !== null &&
        this._config.latitude !== '' &&
        Number.isFinite(Number(this._config.latitude))
          ? Number(this._config.latitude)
          : typeof this._hass?.config?.latitude === 'number'
          ? this._hass.config.latitude
          : 48.3003;
      const lonDeg =
        this._config.longitude !== undefined &&
        this._config.longitude !== null &&
        this._config.longitude !== '' &&
        Number.isFinite(Number(this._config.longitude))
          ? Number(this._config.longitude)
          : typeof this._hass?.config?.longitude === 'number'
          ? this._hass.config.longitude
          : 14.2858;
      return { latDeg, lonDeg };
    }

    async _runStringSunnyDayCalibration(strIdx) {
      const cur = this._getStringsFromConfig();
      const str = cur.strings[strIdx];
      if (!str) return;
      this._openShadePanels.add(str.id);

      const fallbackGlobal =
        cur.strings.length === 1 ? String(this._config.pv_actual_entity || '').trim() : '';
      const entityId = String(str.actual_entity || fallbackGlobal || '').trim();

      const setStrState = (nextState) => {
        this._stringCalibStates[str.id] = nextState;
        this._syncStringCalibUI(strIdx, str.id);
      };

      if (!entityId) {
        setStrState({
          calibrating: false,
          error: true,
          status:
            cur.strings.length > 1
              ? 'Bitte zuerst bei diesem String unter „Ist-Sensor“ den passenden String-Sensor eintragen.'
              : 'Bitte zuerst einen Ist-Sensor für diesen String oder unter pv_actual_entity eintragen.',
        });
        return;
      }
      if (!this._hass || typeof this._hass.callApi !== 'function') {
        setStrState({
          calibrating: false,
          error: true,
          status: 'Home Assistant API ist hier in der Editor-Vorschau nicht verbunden.',
        });
        return;
      }
      if (str.count * str.watt <= 0) {
        setStrState({
          calibrating: false,
          error: true,
          status: 'Bitte zuerst Module × Watt für diesen String konfigurieren.',
        });
        return;
      }

      const dateInput = this.shadowRoot?.querySelector(`[data-str-calib-date="${strIdx}"]`);
      const dateStr = String(dateInput?.value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        setStrState({
          calibrating: false,
          error: true,
          status: 'Bitte ein gültiges Sonnentags-Datum auswählen.',
        });
        return;
      }

      setStrState({
        calibrating: true,
        error: false,
        status: `Lade Verlauf von ${entityId}...`,
      });

      try {
        const { buckets, bucketMinutes, utcOffsetSec } =
          await this._fetchCalibrationBucketsForEntity(entityId, dateStr);
        const { latDeg, lonDeg } = this._getCoordsForCalibration();
        const pvCfg = normalizePvSystemConfig(this._config.pv_system);
        const pvMode = normalizePvModeValue(this._config.pv_mode);
        const targetString = {
          ...str,
          label: str.name,
          wp: str.count * str.watt,
          shading: [],
          shading_date: '',
        };

        const result = calibrateShadingFromDayBuckets({
          buckets,
          pvSystem: pvCfg,
          targetString,
          pvMode,
          latDeg,
          lonDeg,
          utcOffsetSec,
          bucketMinutes,
        });

        if (!result.ok) {
          setStrState({ calibrating: false, error: true, status: result.error });
        } else {
          const peakKw = (result.peakActualWatts / 1000).toFixed(2);
          const status =
            result.sectors.length === 0
              ? `✓ ${dateStr} geprüft (Peak ${peakKw} kW): keine Verschattung erkannt.`
              : `✓ ${dateStr} (Peak ${peakKw} kW): ${result.sectors.length} ${
                  result.sectors.length === 1 ? 'Schatten-Sektor' : 'Schatten-Sektoren'
                } übernommen.`;
          this._stringCalibStates[str.id] = { calibrating: false, error: false, status };
          const latest = this._getStringsFromConfig();
          if (latest.strings[strIdx]) {
            latest.strings[strIdx].shading = result.sectors;
            latest.strings[strIdx].shading_date = dateStr;
            this._saveStringsToConfig(latest.strings, latest.defaultTilt, true);
          }
        }
      } catch (err) {
        setStrState({
          calibrating: false,
          error: true,
          status: `Fehler beim Laden der History: ${err?.message || 'Unbekannt'}`,
        });
      }
    }

    async _runSunnyDayCalibration() {
      const entityId = String(this._config.pv_actual_entity || '').trim();
      if (!entityId) {
        this._calibError = true;
        this._calibStatus = 'Bitte zuerst oben bei pv_actual_entity deinen Ist-PV-Sensor eintragen.';
        this._syncCalibStatusUI();
        return;
      }
      if (!this._hass || typeof this._hass.callApi !== 'function') {
        this._calibError = true;
        this._calibStatus = 'Home Assistant API ist hier in der Editor-Vorschau nicht verbunden.';
        this._syncCalibStatusUI();
        return;
      }

      const dateInput = this.shadowRoot?.getElementById('ed-calib-date');
      const dateStr = String(dateInput?.value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        this._calibError = true;
        this._calibStatus = 'Bitte ein gültiges Sonnentags-Datum auswählen.';
        this._syncCalibStatusUI();
        return;
      }

      this._calibrating = true;
      this._calibError = false;
      this._calibStatus = 'Lade Tagesverlauf aus Home Assistant...';
      this._syncCalibStatusUI();

      try {
        const { buckets, bucketMinutes, utcOffsetSec } =
          await this._fetchCalibrationBucketsForEntity(entityId, dateStr);
        const { latDeg, lonDeg } = this._getCoordsForCalibration();
        const pvCfg = normalizePvSystemConfig(this._config.pv_system);
        const pvMode = normalizePvModeValue(this._config.pv_mode);
        const result = calibrateShadingFromDayBuckets({
          buckets,
          pvSystem: pvCfg,
          pvMode,
          latDeg,
          lonDeg,
          utcOffsetSec,
          bucketMinutes,
        });

        if (!result.ok) {
          this._calibError = true;
          this._calibStatus = result.error;
        } else {
          this._calibError = false;
          const peakKw = (result.peakActualWatts / 1000).toFixed(2);
          if (result.sectors.length === 0) {
            this._calibStatus = `✓ ${dateStr} geprüft (Peak ${peakKw} kW): keine nennenswerte Verschattung erkannt.`;
          } else {
            this._calibStatus = `✓ Kalibriert aus ${dateStr} (Peak ${peakKw} kW): ${result.sectors.length} Schatten-${
              result.sectors.length === 1 ? 'Sektor' : 'Sektoren'
            } übernommen.`;
          }
          this._updateShadingSectors(result.sectors, dateStr);
        }
      } catch (err) {
        this._calibError = true;
        this._calibStatus = `Fehler beim Laden der History: ${err?.message || 'Unbekannt'}`;
      } finally {
        this._calibrating = false;
        this._syncCalibStatusUI();
      }
    }

    _render() {
      this._rendered = true;
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            color: var(--primary-text-color, #e2e8f0);
            font-family: var(--paper-font-body1_-_font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            font-size: 13px;
          }
          .ed-wrap {
            display: flex;
            flex-direction: column;
            gap: 14px;
          }
          .ed-section {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding-top: 12px;
            border-top: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
          }
          .ed-section:first-child {
            padding-top: 0;
            border-top: none;
          }
          .ed-section-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            font-weight: 600;
            color: var(--primary-text-color, #f8fafc);
          }
          .ed-kwp {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            color: var(--primary-color, #38bdf8);
          }
          .ed-field {
            display: flex;
            flex-direction: column;
            gap: 5px;
          }
          .ed-label-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            color: var(--secondary-text-color, #cbd5e1);
          }
          .ed-val {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            color: var(--primary-color, #38bdf8);
            font-weight: 600;
          }
          input[type="text"],
          input[type="number"],
          select {
            width: 100%;
            box-sizing: border-box;
            border-radius: 8px;
            border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.14));
            background: var(--secondary-background-color, rgba(15, 23, 42, 0.65));
            color: var(--primary-text-color, #f8fafc);
            padding: 7px 10px;
            font-size: 12px;
            font-family: inherit;
          }
          input[type="number"] {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          }
          input:focus,
          select:focus {
            outline: none;
            border-color: var(--primary-color, #38bdf8);
          }
          input[type="range"] {
            width: 100%;
            accent-color: var(--primary-color, #38bdf8);
            cursor: pointer;
          }
          .ed-presets,
          .ed-modes {
            display: grid;
            gap: 6px;
          }
          .ed-presets {
            grid-template-columns: repeat(4, 1fr);
          }
          .ed-modes {
            grid-template-columns: repeat(3, 1fr);
          }
          .ed-pill-btn {
            border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.14));
            background: var(--secondary-background-color, rgba(255, 255, 255, 0.05));
            color: var(--primary-text-color, #cbd5e1);
            border-radius: 7px;
            padding: 6px 8px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            font-family: inherit;
          }
          .ed-pill-btn.active {
            background: var(--primary-color, #38bdf8);
            border-color: var(--primary-color, #38bdf8);
            color: #090c12;
            font-weight: 600;
          }
          .ed-toggle {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            cursor: pointer;
          }
          .ed-toggle-title {
            font-size: 12px;
            font-weight: 500;
            color: var(--primary-text-color, #e2e8f0);
          }
          .ed-toggle-sub {
            font-size: 11px;
            color: var(--secondary-text-color, #94a3b8);
            line-height: 1.4;
          }
          .ed-toggle input[type="checkbox"] {
            width: 17px;
            height: 17px;
            accent-color: var(--primary-color, #38bdf8);
            cursor: pointer;
            flex-shrink: 0;
          }
          .ed-pv-sep {
            text-align: center;
            color: var(--secondary-text-color, #94a3b8);
            padding-top: 16px;
          }
          .ed-str-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .ed-str-card {
            border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.12));
            background: rgba(15, 23, 42, 0.42);
            border-radius: 10px;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .ed-str-head {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .ed-str-name-inp {
            flex: 1;
            min-width: 0;
            font-weight: 600;
          }
          .ed-str-kwp {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 11px;
            font-weight: 600;
            color: var(--primary-color, #38bdf8);
            white-space: nowrap;
          }
          .ed-str-mod-row {
            display: grid;
            grid-template-columns: 1fr 14px 1fr;
            gap: 6px;
            align-items: center;
          }
          .ed-str-orient-row {
            display: grid;
            grid-template-columns: 1.25fr 1fr 1fr;
            gap: 6px;
          }
          details.ed-str-shade-details {
            border-top: 1px dashed rgba(255, 255, 255, 0.1);
            padding-top: 8px;
            margin-top: 2px;
          }
          details.ed-str-shade-details > summary {
            list-style: none;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 11px;
            font-weight: 600;
            color: #cbd5e1;
            cursor: pointer;
            user-select: none;
          }
          details.ed-str-shade-details > summary::-webkit-details-marker {
            display: none;
          }
          .ed-str-shade-meta {
            font-weight: 500;
            color: #94a3b8;
            font-size: 11px;
          }
          .ed-str-shade-body {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 8px;
          }
          .ed-str-sectors {
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
          .ed-add-str-btn {
            border: 1px dashed rgba(56, 189, 248, 0.45);
            background: rgba(56, 189, 248, 0.08);
            color: #7dd3fc;
            border-radius: 8px;
            padding: 7px 10px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            font-family: inherit;
          }
          .ed-add-str-btn:hover {
            background: rgba(56, 189, 248, 0.18);
            color: #e0f2fe;
          }
          .ed-grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
          }
          .ed-calib-row {
            display: grid;
            grid-template-columns: 135px 1fr;
            gap: 8px;
            align-items: center;
          }
          input[type="date"] {
            width: 100%;
            box-sizing: border-box;
            border-radius: 8px;
            border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.14));
            background: var(--secondary-background-color, rgba(15, 23, 42, 0.65));
            color: var(--primary-text-color, #f8fafc);
            padding: 6px 8px;
            font-size: 12px;
            font-family: inherit;
            color-scheme: dark;
          }
          .ed-action-btn {
            border: 1px solid rgba(56, 189, 248, 0.45);
            background: rgba(56, 189, 248, 0.16);
            color: #e0f2fe;
            border-radius: 8px;
            padding: 7px 10px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            font-family: inherit;
          }
          .ed-action-btn:hover:not(:disabled) {
            background: rgba(56, 189, 248, 0.28);
          }
          .ed-action-btn:disabled {
            opacity: 0.55;
            cursor: wait;
          }
          .ed-calib-status {
            font-size: 11px;
            line-height: 1.4;
            padding: 6px 9px;
            border-radius: 7px;
            display: none;
          }
          .ed-calib-status.ok {
            background: rgba(16, 185, 129, 0.14);
            border: 1px solid rgba(16, 185, 129, 0.35);
            color: #6ee7b7;
          }
          .ed-calib-status.error {
            background: rgba(245, 158, 11, 0.14);
            border: 1px solid rgba(245, 158, 11, 0.35);
            color: #fcd34d;
          }
          .ed-shading-empty {
            font-size: 11px;
            color: var(--secondary-text-color, #94a3b8);
          }
          .ed-shade-row {
            border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
            background: rgba(15, 23, 42, 0.55);
            border-radius: 8px;
            padding: 8px 10px;
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
          .ed-shade-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
          }
          .ed-shade-label {
            font-size: 11px;
            font-weight: 600;
            color: #f8fafc;
          }
          .ed-shade-del {
            border: none;
            background: rgba(255, 255, 255, 0.06);
            color: #cbd5e1;
            border-radius: 5px;
            width: 22px;
            height: 22px;
            line-height: 20px;
            text-align: center;
            cursor: pointer;
            font-size: 14px;
            flex-shrink: 0;
          }
          .ed-shade-del:hover {
            background: rgba(239, 68, 68, 0.25);
            color: #fecaca;
          }
          .ed-shade-inputs {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
          }
          .ed-mini-field {
            display: flex;
            flex-direction: column;
            gap: 3px;
            font-size: 10px;
            color: var(--secondary-text-color, #94a3b8);
            min-width: 0;
          }
          .ed-shade-footer {
            display: flex;
            gap: 8px;
          }
          .ed-ghost-btn {
            border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.14));
            background: transparent;
            color: var(--secondary-text-color, #cbd5e1);
            border-radius: 7px;
            padding: 5px 9px;
            font-size: 11px;
            cursor: pointer;
            font-family: inherit;
          }
          .ed-ghost-btn:hover {
            background: rgba(255, 255, 255, 0.06);
            color: #f8fafc;
          }
          details.ed-details {
            padding-top: 12px;
            border-top: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
          }
          details.ed-details > summary {
            list-style: none;
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            font-weight: 600;
            color: var(--primary-text-color, #f8fafc);
            cursor: pointer;
            user-select: none;
          }
          details.ed-details > summary::-webkit-details-marker {
            display: none;
          }
          .ed-details-chevron {
            font-size: 11px;
            color: var(--secondary-text-color, #94a3b8);
            transition: transform 0.15s ease;
          }
          details.ed-details[open] .ed-details-chevron {
            transform: rotate(180deg);
          }
          .ed-details-body {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-top: 10px;
          }
        </style>
        <div class="ed-wrap">
          <div class="ed-section">
            <div class="ed-section-head">
              <span>PV-Strings (Ausrichtung, Sensor &amp; Verschattung)</span>
              <span class="ed-kwp" id="ed-total-kwp">9.46 kWp</span>
            </div>

            <div class="ed-toggle-sub">
              Jeder String kann eigene Modulzahl, Ausrichtung, Neigung, einen optionalen Ist-Sensor und eine eigene Sonnentag-Verschattung haben.
            </div>

            <div class="ed-str-list" id="ed-strings-list"></div>

            <button type="button" class="ed-add-str-btn" id="ed-add-string">
              + String hinzufügen
            </button>

            <div class="ed-grid-2">
              <div class="ed-field">
                <div class="ed-label-row"><label for="ed-tilt">Standard-Neigung (°)</label></div>
                <input id="ed-tilt" type="number" min="0" max="90" />
              </div>
              <div class="ed-field">
                <div class="ed-label-row"><span>pv_mode</span></div>
                <div class="ed-modes">
                  <button type="button" class="ed-pill-btn" data-pv-mode="pessimistisch">Pess</button>
                  <button type="button" class="ed-pill-btn" data-pv-mode="neutral">Neutral</button>
                  <button type="button" class="ed-pill-btn" data-pv-mode="optimistisch">Opt</button>
                </div>
              </div>
            </div>
          </div>

          <div class="ed-section">
            <div class="ed-section-head">
              <span>Sensoren &amp; Wetterdaten</span>
            </div>

            <div class="ed-field">
              <div class="ed-label-row">
                <label for="ed-actual-entity">pv_actual_entity (Gesamt-Ist Sensor, optional)</label>
              </div>
              <input
                id="ed-actual-entity"
                type="text"
                list="ed-pv-entities"
                placeholder="Leer lassen = Summe der String-Sensoren"
              />
              <div class="ed-toggle-sub">
                Leer lassen, um automatisch die Summe aller oben gesetzten String-Sensoren als Ist-Kurve anzuzeigen.
              </div>
              <datalist id="ed-pv-entities"></datalist>
            </div>

            <div class="ed-field">
              <div class="ed-label-row">
                <label for="ed-weather-entity">weather_entity (Met.no für Temp. &amp; Wolken, optional)</label>
              </div>
              <input
                id="ed-weather-entity"
                type="text"
                list="ed-weather-entities"
                placeholder="z. B. weather.forecast_home"
              />
              <datalist id="ed-weather-entities"></datalist>
            </div>
          </div>

          <details class="ed-details" id="ed-global-shading-details">
            <summary>
              <span>Globale Verschattung (Fallback)</span>
              <span class="ed-str-shade-meta"><span id="ed-global-shade-badge">Inaktiv</span> ▼</span>
            </summary>
            <div class="ed-details-body">
              <div class="ed-toggle-sub">
                Greift nur für Strings ohne eigene Kalibrierung. Bei unterschiedlichen Schatten pro String bitte oben direkt im jeweiligen String kalibrieren.
              </div>
              <div class="ed-calib-row">
                <input id="ed-calib-date" type="date" aria-label="Sonnentag für globale Kalibrierung" />
                <button type="button" class="ed-action-btn" id="ed-calib-btn">
                  Global kalibrieren
                </button>
              </div>
              <div class="ed-calib-status" id="ed-calib-status"></div>
              <div id="ed-shading-list"></div>
              <div class="ed-shade-footer">
                <button type="button" class="ed-ghost-btn" id="ed-add-shade">+ Sektor manuell</button>
                <button type="button" class="ed-ghost-btn" id="ed-clear-shade">Alle löschen</button>
              </div>
            </div>
          </details>

          <div class="ed-section">
            <div class="ed-section-head">
              <span>PV-Anzeige &amp; Verlauf</span>
            </div>

            <label class="ed-toggle">
              <div>
                <div class="ed-toggle-title">show_pv_panel</div>
                <div class="ed-toggle-sub">PV-Prognose, Ertragsgraph &amp; 24h-Verlauf</div>
              </div>
              <input id="ed-show-pv" type="checkbox" />
            </label>

            <label class="ed-toggle">
              <div>
                <div class="ed-toggle-title">hide_night</div>
                <div class="ed-toggle-sub">Nachtstunden im 24h-Verlauf ausblenden</div>
              </div>
              <input id="ed-hide-night" type="checkbox" />
            </label>
          </div>

          <div class="ed-section">
            <div class="ed-section-head">
              <span>Standort (optional, sonst Home Assistant)</span>
            </div>
            <div class="ed-grid-2">
              <div class="ed-field">
                <div class="ed-label-row"><label for="ed-lat">latitude</label></div>
                <input id="ed-lat" type="number" step="0.0001" />
              </div>
              <div class="ed-field">
                <div class="ed-label-row"><label for="ed-lon">longitude</label></div>
                <input id="ed-lon" type="number" step="0.0001" />
              </div>
            </div>
          </div>

          <details class="ed-details">
            <summary>
              <span>Wetterkarte &amp; Radar (Hintergrund)</span>
              <span class="ed-details-chevron">▼</span>
            </summary>
            <div class="ed-details-body">
              <label class="ed-toggle">
                <div>
                  <div class="ed-toggle-title">show_map</div>
                  <div class="ed-toggle-sub">Wetterradar-Karte anzeigen (auch direkt in Karte umschaltbar)</div>
                </div>
                <input id="ed-show-map" type="checkbox" />
              </label>

              <div class="ed-field">
                <div class="ed-label-row"><label for="ed-title">title (optional)</label></div>
                <input id="ed-title" type="text" placeholder="z. B. PV-Cockpit" />
              </div>

              <div class="ed-field">
                <div class="ed-label-row">
                  <label for="ed-zoom">zoom</label>
                  <span class="ed-val" id="ed-zoom-val">7</span>
                </div>
                <input id="ed-zoom" type="range" min="4" max="12" step="1" />
              </div>

              <div class="ed-field">
                <div class="ed-label-row"><label for="ed-height">height</label></div>
                <div class="ed-presets">
                  <button type="button" class="ed-pill-btn" data-height-preset="320px">320px</button>
                  <button type="button" class="ed-pill-btn" data-height-preset="400px">400px</button>
                  <button type="button" class="ed-pill-btn" data-height-preset="480px">480px</button>
                  <button type="button" class="ed-pill-btn" data-height-preset="560px">560px</button>
                </div>
                <input id="ed-height" type="text" placeholder="450px" />
              </div>

              <div class="ed-field">
                <div class="ed-label-row">
                  <label for="ed-opacity">opacity</label>
                  <span class="ed-val" id="ed-opacity-val">0.75</span>
                </div>
                <input id="ed-opacity" type="range" min="0" max="1" step="0.05" />
              </div>

              <label class="ed-toggle">
                <div>
                  <div class="ed-toggle-title">auto_play</div>
                  <div class="ed-toggle-sub">Radar-Animation beim Laden starten</div>
                </div>
                <input id="ed-auto-play" type="checkbox" />
              </label>

              <label class="ed-toggle">
                <div>
                  <div class="ed-toggle-title">show_radar</div>
                  <div class="ed-toggle-sub">RainViewer-Regenradar anzeigen</div>
                </div>
                <input id="ed-show-radar" type="checkbox" />
              </label>

              <label class="ed-toggle">
                <div>
                  <div class="ed-toggle-title">show_clouds</div>
                  <div class="ed-toggle-sub">DWD Meteosat-Wolkenbild</div>
                </div>
                <input id="ed-show-clouds" type="checkbox" />
              </label>

              <label class="ed-toggle">
                <div>
                  <div class="ed-toggle-title">show_warnings</div>
                  <div class="ed-toggle-sub">ZAMG / GeoSphere Warnungen (nur Österreich)</div>
                </div>
                <input id="ed-show-warnings" type="checkbox" />
              </label>
            </div>
          </details>
        </div>
      `;

      const on = (id, evt, fn) => {
        const el = this.shadowRoot.getElementById(id);
        if (el) el.addEventListener(evt, fn);
      };

      on('ed-title', 'input', (e) => {
        const v = e.target.value.trim();
        this._updateRootField('title', v, true);
      });
      on('ed-zoom', 'input', (e) => {
        this._updateRootField('zoom', Number(e.target.value));
      });
      on('ed-height', 'change', (e) => {
        const v = e.target.value.trim() || '450px';
        this._updateRootField('height', v);
      });
      on('ed-opacity', 'input', (e) => {
        this._updateRootField('opacity', Number(e.target.value));
      });

      this.shadowRoot.querySelectorAll('[data-height-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this._updateRootField('height', btn.getAttribute('data-height-preset'));
        });
      });

      on('ed-auto-play', 'change', (e) => this._updateRootField('auto_play', e.target.checked));
      on('ed-show-radar', 'change', (e) => this._updateRootField('show_radar', e.target.checked));
      on('ed-show-pv', 'change', (e) => this._updateRootField('show_pv_panel', e.target.checked));
      on('ed-show-map', 'change', (e) => this._updateRootField('show_map', e.target.checked));
      on('ed-hide-night', 'change', (e) => this._updateRootField('hide_night', e.target.checked));
      on('ed-show-clouds', 'change', (e) => this._updateRootField('show_clouds', e.target.checked));
      on('ed-show-warnings', 'change', (e) => this._updateRootField('show_warnings', e.target.checked));

      on('ed-add-string', 'click', () => {
        const cur = this._getStringsFromConfig();
        const nextNum = cur.strings.length + 1;
        cur.strings.push({
          id: `string_${nextNum}`,
          name: `String ${nextNum}`,
          count: 8,
          watt: 430,
          azimuth: 180,
          tilt: cur.defaultTilt,
          actual_entity: '',
          shading: [],
          shading_date: '',
        });
        this._saveStringsToConfig(cur.strings, cur.defaultTilt, true);
      });

      on('ed-tilt', 'input', (e) => {
        const val = Math.min(90, Math.max(0, Math.round(Number(e.target.value) || 0)));
        const cur = this._getStringsFromConfig();
        this._saveStringsToConfig(cur.strings, val);
      });

      this.shadowRoot.querySelectorAll('[data-pv-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this._updateRootField('pv_mode', btn.getAttribute('data-pv-mode'));
        });
      });

      const bindCoord = (id, key) => {
        on(id, 'change', (e) => {
          const raw = e.target.value.trim();
          if (!raw) {
            this._updateRootField(key, null, true);
            return;
          }
          const num = parseFloat(raw);
          if (Number.isFinite(num)) {
            this._updateRootField(key, num);
          }
        });
      };
      bindCoord('ed-lat', 'latitude');
      bindCoord('ed-lon', 'longitude');
      on('ed-actual-entity', 'input', (e) => {
        const v = e.target.value.trim();
        this._updateRootField('pv_actual_entity', v, true);
      });
      on('ed-weather-entity', 'input', (e) => {
        const v = e.target.value.trim();
        this._updateRootField('weather_entity', v, true);
      });
      on('ed-global-shading-details', 'toggle', () => {
        this._globalDetailsUserToggled = true;
      });
      on('ed-calib-btn', 'click', () => this._runSunnyDayCalibration());
      on('ed-add-shade', 'click', () => {
        const cur = normalizePvShadingConfig(this._config.pv_shading);
        cur.push({
          from_azimuth: 205,
          to_azimuth: 260,
          min_elevation: 16,
          transmission: 0.15,
          label: 'Nachmittag (SW)',
        });
        this._updateShadingSectors(cur);
      });
      on('ed-clear-shade', 'click', () => {
        this._calibStatus = '';
        this._calibError = false;
        this._updateShadingSectors([], '');
      });
    }
  }

  if (!customElements.get(CARD_TAG)) {
    customElements.define(CARD_TAG, PvCockpitCard);
  }
  if (!customElements.get(EDITOR_TAG)) {
    customElements.define(EDITOR_TAG, PvCockpitCardEditor);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === CARD_TAG)) {
    window.customCards.push({
      type: CARD_TAG,
      name: 'PV-Cockpit',
      description:
        'PV-Ertragsprognose, Idealkurve, Verschattungskalibrierung, Ist-Abgleich & optionales Wetterradar (Open-Meteo, ZAMG, Met.no, DWD, RainViewer)',
      preview: true,
    });
  }
})();

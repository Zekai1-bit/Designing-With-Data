'use strict';

const FEEDS = {
  hour: {
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
    phrase: 'the past hour',
    durationMs: 60 * 60 * 1000,
    minimumMagnitude: 0
  },
  day: {
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    phrase: 'the past day',
    durationMs: 24 * 60 * 60 * 1000,
    minimumMagnitude: 0
  },
  week: {
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson',
    phrase: 'the past week',
    durationMs: 7 * 24 * 60 * 60 * 1000,
    minimumMagnitude: 2.5
  }
};

const LAND_URL = 'data/land.geojson';
const USGS_URL_PREFIX = 'https://earthquake.usgs.gov/';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const FETCH_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 60000;
const CLOCK_INTERVAL_MS = 1000;

const RIPPLE_COUNT = 12;
const LIST_LIMIT = 50;

const ENERGY_LOG_FLOOR = 7;
const ENERGY_LOG_RANGE = 4;

const CALM_HUE = 210;
const HUE_RANGE = 170;
const SEISMO_BASE_PX = 2;
const SEISMO_RANGE_PX = 18;
const RUMBLE_BASE_VOLUME = 0.05;
const RUMBLE_VOLUME_RANGE = 0.35;
const HERO_DIMMING = 0.25;
const HERO_MAX_BLUR_PX = 2;

const SHALLOW_HUE = 40;
const DEEP_HUE = 270;
const HUE_PER_KM = 0.35;
const PING_BASE_RATE = 1.4;
const PING_RATE_PER_MAGNITUDE = 0.12;
const PING_MIN_RATE = 0.6;
const PING_VOLUME = 0.5;
const OLDEST_OPACITY = 0.35;

const SEISMO_POINTS = 150;
const SEISMO_STEP = 4;

const rootElement = document.documentElement;
const headlineElement = document.querySelector('#headline');
const seismoPath = document.querySelector('#seismoPath');
const errorCard = document.querySelector('#errorCard');
const errorMessage = document.querySelector('#errorMessage');
const retryButton = document.querySelector('#retryBtn');
const mapFrame = document.querySelector('#mapFrame');
const graticuleLayer = document.querySelector('#graticule');
const landPath = document.querySelector('#land');
const markersLayer = document.querySelector('#markers');
const loadingElement = document.querySelector('#loading');
const windowButtons = Array.from(document.querySelectorAll('.window-button'));
const magnitudeSlider = document.querySelector('#magSlider');
const magnitudeOutput = document.querySelector('#magOutput');
const refreshButton = document.querySelector('#refreshBtn');
const soundButton = document.querySelector('#soundBtn');
const countText = document.querySelector('#countText');
const updatedText = document.querySelector('#updatedText');
const detailEmpty = document.querySelector('#detailEmpty');
const detailBody = document.querySelector('#detailBody');
const detailPlace = document.querySelector('#detailPlace');
const detailMag = document.querySelector('#detailMag');
const detailDepth = document.querySelector('#detailDepth');
const detailTime = document.querySelector('#detailTime');
const detailAgo = document.querySelector('#detailAgo');
const detailLink = document.querySelector('#detailLink');
const listNote = document.querySelector('#listNote');
const quakeList = document.querySelector('#quakeList');
const listSkeleton = document.querySelector('#listSkeleton');

let selectedWindow = 'day';
let dataWindow = 'day';
let allQuakes = [];
let filteredQuakes = [];
let currentSummary = null;
let minimumMagnitude = 0;
let selectedId = null;
let lastFetchedAt = null;
let loadToken = 0;
let pollTimerId = null;
let isSoundOn = false;
let rumbleSound = null;
let pingSound = null;

const seenIdsByWindow = { hour: null, day: null, week: null };

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function createSvgElement(name) {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function pluralise(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatMagnitude(magnitude) {
  return `M ${magnitude.toFixed(1)}`;
}

function formatDepth(depthKm, digits) {
  return depthKm === null ? 'Depth unavailable' : `${depthKm.toFixed(digits)} km deep`;
}

function formatTimeAgo(time, now) {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${pluralise(minutes, 'minute', 'minutes')} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${pluralise(hours, 'hour', 'hours')} ago`;
  }
  return `${pluralise(Math.round(hours / 24), 'day', 'days')} ago`;
}

function formatLocalTime(time) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'long'
  }).format(new Date(time));
}

function nearbyPlaceName(place) {
  const match = /^\d+(?:\.\d+)?\s*km\s+[NSEW]{1,3}\s+of\s+(.+)$/i.exec(place);
  return match ? match[1] : null;
}

function depthToHue(depthKm) {
  return clamp(SHALLOW_HUE + (depthKm ?? 0) * HUE_PER_KM, SHALLOW_HUE, DEEP_HUE);
}

function magnitudeToRadius(magnitude) {
  return clamp(0.9 + 0.55 * magnitude, 0.9, 5.5);
}

function magnitudeToPingRate(magnitude) {
  return clamp(PING_BASE_RATE - PING_RATE_PER_MAGNITUDE * magnitude, PING_MIN_RATE, PING_BASE_RATE);
}

function ageShare(time, now) {
  return clamp((now - time) / FEEDS[dataWindow].durationMs, 0, 1);
}

function effectiveMinimumMagnitude() {
  return Math.max(minimumMagnitude, FEEDS[dataWindow].minimumMagnitude);
}

async function fetchJson(url, serviceName) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: abortController.signal });
    if (!response.ok) {
      throw new Error(`The ${serviceName} answered with status ${response.status}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function fetchFeed(windowKey) {
  return fetchJson(FEEDS[windowKey].url, 'earthquake feed');
}

function describeError(error) {
  if (error?.name === 'AbortError') {
    return 'The earthquake feed took too long to answer. Check your connection and try again.';
  }
  if (error instanceof TypeError) {
    return 'The earthquake feed could not be reached. Check your connection and try again.';
  }
  if (error instanceof SyntaxError) {
    return 'The earthquake feed sent a reply that could not be read. Try again in a moment.';
  }
  return error?.message || 'Something went wrong while loading the earthquakes.';
}

function toQuakes(geojson, windowKey) {
  if (!Array.isArray(geojson?.features)) {
    throw new Error('The earthquake feed sent a reply with no list of earthquakes in it.');
  }
  const feedMinimum = FEEDS[windowKey].minimumMagnitude;

  return geojson.features
    .map((feature) => {
      const properties = feature?.properties ?? {};
      const coordinates = feature?.geometry?.coordinates ?? [];
      const url = typeof properties.url === 'string' && properties.url.startsWith(USGS_URL_PREFIX)
        ? properties.url
        : null;

      return {
        id: typeof feature?.id === 'string' ? feature.id : null,
        magnitude: toNumberOrNull(properties.mag),
        place: typeof properties.place === 'string' && properties.place.trim() !== ''
          ? properties.place.trim()
          : 'Unnamed location',
        time: toNumberOrNull(properties.time),
        url,
        longitude: toNumberOrNull(coordinates[0]),
        latitude: toNumberOrNull(coordinates[1]),
        depthKm: toNumberOrNull(coordinates[2])
      };
    })
    .filter((quake) => quake.id !== null
      && quake.magnitude !== null
      && quake.time !== null
      && quake.longitude !== null
      && quake.latitude !== null
      && quake.magnitude >= feedMinimum)
    .sort((first, second) => second.time - first.time);
}

function summarise(quakes) {
  let strongest = null;
  let totalEnergy = 0;

  quakes.forEach((quake) => {
    totalEnergy += 10 ** (1.5 * quake.magnitude);
    if (strongest === null || quake.magnitude > strongest.magnitude) {
      strongest = quake;
    }
  });

  const activity = totalEnergy > 0
    ? clamp((Math.log10(totalEnergy) - ENERGY_LOG_FLOOR) / ENERGY_LOG_RANGE, 0, 1)
    : 0;

  return { count: quakes.length, strongest, totalEnergy, activity };
}

function findArrivals(quakes, windowKey) {
  const seenIds = seenIdsByWindow[windowKey];
  const arrivalIds = new Set();

  if (seenIds === null) {
    seenIdsByWindow[windowKey] = new Set(quakes.map((quake) => quake.id));
    return arrivalIds;
  }
  quakes.forEach((quake) => {
    if (!seenIds.has(quake.id)) {
      arrivalIds.add(quake.id);
      seenIds.add(quake.id);
    }
  });
  return arrivalIds;
}

function applyMood(summary) {
  const activity = summary.activity;

  rootElement.style.setProperty('--activity', activity.toFixed(3));
  rootElement.style.setProperty('--accent-hue', (CALM_HUE - HUE_RANGE * activity).toFixed(1));
  rootElement.style.setProperty('--seismo-amp', (SEISMO_BASE_PX + SEISMO_RANGE_PX * activity).toFixed(2));
  rootElement.style.setProperty('--hero-brightness', (1 - HERO_DIMMING * activity).toFixed(3));
  rootElement.style.setProperty('--hero-blur', `${(HERO_MAX_BLUR_PX * activity).toFixed(2)}px`);
  updateRumbleVolume(activity);
}

function buildGraticule() {
  for (let x = 0; x <= 360; x += 30) {
    const line = createSvgElement('line');
    line.setAttribute('x1', String(x));
    line.setAttribute('x2', String(x));
    line.setAttribute('y1', '0');
    line.setAttribute('y2', '180');
    graticuleLayer.appendChild(line);
  }
  for (let y = 0; y <= 180; y += 30) {
    const line = createSvgElement('line');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', '360');
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    graticuleLayer.appendChild(line);
  }
}

function buildLand(geojson) {
  const parts = [];

  (geojson?.features ?? []).forEach((feature) => {
    const geometry = feature?.geometry;
    let polygons = [];
    if (geometry?.type === 'Polygon') {
      polygons = [geometry.coordinates];
    } else if (geometry?.type === 'MultiPolygon') {
      polygons = geometry.coordinates;
    }
    polygons.forEach((polygon) => {
      polygon.forEach((ring) => {
        ring.forEach((point, index) => {
          const x = (point[0] + 180).toFixed(1);
          const y = (90 - point[1]).toFixed(1);
          parts.push(`${index === 0 ? 'M' : 'L'}${x} ${y}`);
        });
        parts.push('Z');
      });
    });
  });

  landPath.setAttribute('d', parts.join(''));
}

async function loadLand() {
  try {
    buildLand(await fetchJson(LAND_URL, 'map outline'));
  } catch (error) {

    landPath.setAttribute('d', '');
  }
}

function buildSeismograph() {
  const parts = [];
  for (let index = 0; index <= SEISMO_POINTS * 2; index += 1) {
    const turn = (2 * Math.PI * (index % SEISMO_POINTS)) / SEISMO_POINTS;
    const y = 0.45 * Math.sin(7 * turn) + 0.3 * Math.sin(19 * turn + 1) + 0.25 * Math.sin(43 * turn + 2);
    parts.push(`${index === 0 ? 'M' : 'L'}${index * SEISMO_STEP} ${y.toFixed(3)}`);
  }
  seismoPath.setAttribute('d', parts.join(''));
}

function describeQuake(quake, now) {
  return `${formatMagnitude(quake.magnitude)}, ${quake.place}, ${formatTimeAgo(quake.time, now)}`;
}

function createMarker(quake, now, isRippling, isArrival) {
  const radius = magnitudeToRadius(quake.magnitude);
  const age = ageShare(quake.time, now);
  const label = describeQuake(quake, now);

  const marker = createSvgElement('g');
  marker.classList.add('quake');
  marker.classList.toggle('is-rippling', isRippling);
  marker.classList.toggle('is-selected', quake.id === selectedId);
  marker.dataset.id = quake.id;
  marker.setAttribute('tabindex', '0');
  marker.setAttribute('role', 'button');
  marker.setAttribute('aria-label', label);
  marker.setAttribute('transform',
    `translate(${(clamp(quake.longitude, -180, 180) + 180).toFixed(2)} ${(90 - clamp(quake.latitude, -90, 90)).toFixed(2)})`);
  marker.style.setProperty('--depth-hue', depthToHue(quake.depthKm).toFixed(0));
  marker.style.setProperty('--age-opacity', (1 - (1 - OLDEST_OPACITY) * age).toFixed(3));

  const title = createSvgElement('title');
  title.textContent = label;
  marker.appendChild(title);

  const hitArea = createSvgElement('circle');
  hitArea.classList.add('quake-hit');
  hitArea.setAttribute('r', Math.max(radius, 3.5).toFixed(2));
  marker.appendChild(hitArea);

  if (isRippling) {

    const magnitude = clamp(quake.magnitude, 0, 9);
    marker.style.setProperty('--ripple-scale', (1.6 + 0.6 * magnitude).toFixed(2));
    marker.style.setProperty('--ripple-duration', `${((1.2 + 0.35 * magnitude) * (1 + 1.5 * age)).toFixed(2)}s`);

    const ring = createSvgElement('circle');
    ring.classList.add('quake-ring');
    ring.setAttribute('r', radius.toFixed(2));
    marker.appendChild(ring);

    if (isArrival) {
      const arrivalRing = createSvgElement('circle');
      arrivalRing.classList.add('quake-arrival');
      arrivalRing.setAttribute('r', radius.toFixed(2));
      marker.appendChild(arrivalRing);
    }
  }

  const dot = createSvgElement('circle');
  dot.classList.add('quake-dot');
  dot.setAttribute('r', radius.toFixed(2));
  marker.appendChild(dot);

  return marker;
}

function renderMap(quakes, arrivalIds) {
  const now = Date.now();
  const fragment = document.createDocumentFragment();

  for (let index = quakes.length - 1; index >= 0; index -= 1) {
    const quake = quakes[index];
    const isRippling = index < RIPPLE_COUNT;
    fragment.appendChild(createMarker(quake, now, isRippling, arrivalIds.has(quake.id)));
  }
  markersLayer.replaceChildren(fragment);
}

function createListRow(quake, now) {
  const item = document.createElement('li');
  const row = document.createElement('button');
  row.type = 'button';
  row.classList.add('quake-row');
  row.classList.toggle('is-selected', quake.id === selectedId);
  row.dataset.id = quake.id;
  row.style.setProperty('--depth-hue', depthToHue(quake.depthKm).toFixed(0));

  const magnitude = document.createElement('span');
  magnitude.classList.add('row-mag');
  magnitude.textContent = formatMagnitude(quake.magnitude);

  const text = document.createElement('span');
  text.classList.add('row-text');

  const place = document.createElement('span');
  place.classList.add('row-place');
  place.textContent = quake.place;

  const meta = document.createElement('span');
  meta.classList.add('row-meta');
  meta.textContent = `${formatTimeAgo(quake.time, now)} · ${formatDepth(quake.depthKm, 0)}`;

  text.append(place, meta);
  row.append(magnitude, text);
  item.appendChild(row);
  return item;
}

function emptyMessage() {
  const minimum = effectiveMinimumMagnitude();
  const phrase = FEEDS[dataWindow].phrase;
  return minimum > 0
    ? `No earthquakes above M ${minimum.toFixed(1)} in ${phrase}.`
    : `No earthquakes in ${phrase}.`;
}

function renderList(quakes) {
  const now = Date.now();
  const fragment = document.createDocumentFragment();
  quakes.slice(0, LIST_LIMIT).forEach((quake) => {
    fragment.appendChild(createListRow(quake, now));
  });
  quakeList.replaceChildren(fragment);

  if (quakes.length === 0) {
    listNote.textContent = emptyMessage();
  } else if (quakes.length > LIST_LIMIT) {
    listNote.textContent = `Showing ${LIST_LIMIT} of ${quakes.length}`;
  } else {
    listNote.textContent = `Showing all ${quakes.length}`;
  }
}

function buildHeadline(summary) {
  if (summary.count === 0) {
    return emptyMessage();
  }
  const minimum = effectiveMinimumMagnitude();
  const strength = minimum > 0 ? ` of M ${minimum.toFixed(1)} or stronger` : '';
  const opening = `${pluralise(summary.count, 'earthquake', 'earthquakes')}${strength} in ${FEEDS[dataWindow].phrase}.`;

  const strongest = summary.strongest;
  const when = formatTimeAgo(strongest.time, Date.now());
  const nearby = nearbyPlaceName(strongest.place);
  const closing = nearby
    ? `The strongest, ${formatMagnitude(strongest.magnitude)}, was near ${nearby}, ${when}.`
    : `The strongest, ${formatMagnitude(strongest.magnitude)} (${strongest.place}), was ${when}.`;

  return `${opening} ${closing}`;
}

function renderHeadline(summary) {
  const text = buildHeadline(summary);
  if (headlineElement.textContent !== text) {
    headlineElement.textContent = text;
  }
}

function renderStatus(summary) {
  const count = pluralise(summary.count, 'earthquake', 'earthquakes');
  countText.textContent = summary.strongest
    ? `${count}, strongest ${formatMagnitude(summary.strongest.magnitude)}`
    : count;
}

function renderUpdatedClock() {
  if (lastFetchedAt === null) {
    return;
  }
  const seconds = Math.max(0, Math.round((Date.now() - lastFetchedAt) / 1000));
  updatedText.textContent = seconds < 60
    ? `updated ${seconds} s ago`
    : `updated ${Math.round(seconds / 60)} min ago`;
}

function renderDetail() {
  const quake = filteredQuakes.find((candidate) => candidate.id === selectedId) ?? null;
  detailEmpty.classList.toggle('is-hidden', quake !== null);
  detailBody.classList.toggle('is-hidden', quake === null);
  if (quake === null) {
    return;
  }

  detailPlace.textContent = quake.place;
  detailMag.textContent = formatMagnitude(quake.magnitude);
  detailDepth.textContent = quake.depthKm === null ? 'Depth unavailable' : `${quake.depthKm.toFixed(1)} km`;
  detailTime.textContent = formatLocalTime(quake.time);
  detailAgo.textContent = formatTimeAgo(quake.time, Date.now());

  detailLink.classList.toggle('is-hidden', quake.url === null);
  if (quake.url !== null) {
    detailLink.setAttribute('href', quake.url);
  }
}

function renderSelection() {
  markersLayer.querySelectorAll('.quake').forEach((marker) => {
    marker.classList.toggle('is-selected', marker.dataset.id === selectedId);
  });
  quakeList.querySelectorAll('.quake-row').forEach((row) => {
    row.classList.toggle('is-selected', row.dataset.id === selectedId);
  });
  renderDetail();
}

function renderWindowButtons() {
  windowButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.window === selectedWindow));
  });
}

function renderSliderLabel() {
  magnitudeOutput.textContent = minimumMagnitude > 0
    ? `M ${minimumMagnitude.toFixed(1)} and up`
    : 'All magnitudes';
}

function renderAll(arrivalIds = new Set()) {
  filteredQuakes = minimumMagnitude > 0
    ? allQuakes.filter((quake) => quake.magnitude >= minimumMagnitude)
    : allQuakes;

  if (!filteredQuakes.some((quake) => quake.id === selectedId)) {
    selectedId = null;
  }

  currentSummary = summarise(filteredQuakes);
  applyMood(currentSummary);
  renderMap(filteredQuakes, arrivalIds);
  renderList(filteredQuakes);
  renderHeadline(currentSummary);
  renderStatus(currentSummary);
  renderDetail();
}

function showLoading() {
  loadingElement.classList.remove('is-hidden');
  listSkeleton.classList.toggle('is-hidden', allQuakes.length > 0);
  mapFrame.setAttribute('aria-busy', 'true');
  errorCard.classList.add('is-hidden');
}

function hideLoading() {
  loadingElement.classList.add('is-hidden');
  listSkeleton.classList.add('is-hidden');
  mapFrame.setAttribute('aria-busy', 'false');
}

function showError(message) {
  errorMessage.textContent = message;
  errorCard.classList.remove('is-hidden');
  if (allQuakes.length === 0) {
    headlineElement.textContent = 'The earthquake feed is not answering right now.';
  }
}

function setControlsDisabled(isDisabled) {
  [refreshButton, retryButton].forEach((button) => {
    button.disabled = isDisabled;
  });
}

function hideSoundButton() {
  isSoundOn = false;
  soundButton.classList.add('is-hidden');
  if (rumbleSound) {
    rumbleSound.pause();
  }
}

function setUpAudio() {
  try {
    // Audio files are Freesound previews:
    // audio/rumble.mp3 - unfa (2014), "Rumble · loop 10s"
    //   https://freesound.org/people/unfa/sounds/258339/
    // audio/ping.mp3 - SamsterBirdies (2020), "Sonar Ping"
    //   https://freesound.org/people/SamsterBirdies/sounds/539957/
    rumbleSound = new Audio('audio/rumble.mp3');
    rumbleSound.loop = true;
    rumbleSound.volume = RUMBLE_BASE_VOLUME;

    pingSound = new Audio('audio/ping.mp3');
    pingSound.volume = PING_VOLUME;

    pingSound.preservesPitch = false;
    pingSound.mozPreservesPitch = false;
    pingSound.webkitPreservesPitch = false;

    rumbleSound.addEventListener('error', hideSoundButton);
    pingSound.addEventListener('error', hideSoundButton);
  } catch (error) {
    hideSoundButton();
  }
}

function updateRumbleVolume(activity) {
  if (!rumbleSound) {
    return;
  }
  rumbleSound.volume = RUMBLE_BASE_VOLUME + RUMBLE_VOLUME_RANGE * clamp(activity, 0, 1);
}

function renderSoundButton() {
  soundButton.textContent = isSoundOn ? 'Sound: on' : 'Sound: off';
  soundButton.setAttribute('aria-pressed', String(isSoundOn));
}

async function playPing(magnitude) {
  if (!isSoundOn || !pingSound) {
    return;
  }
  try {
    pingSound.playbackRate = magnitudeToPingRate(magnitude);
    pingSound.currentTime = 0;
    await pingSound.play();
  } catch (error) {

    if (error?.name !== 'AbortError') {
      hideSoundButton();
    }
  }
}

async function toggleSound() {
  if (!rumbleSound) {
    hideSoundButton();
    return;
  }
  isSoundOn = !isSoundOn;
  renderSoundButton();

  if (!isSoundOn) {
    rumbleSound.pause();
    return;
  }
  try {
    updateRumbleVolume(currentSummary?.activity ?? 0);
    await rumbleSound.play();
  } catch (error) {
    hideSoundButton();
  }
}

async function loadQuakes({ isBackground = false } = {}) {
  loadToken += 1;
  const token = loadToken;
  const windowKey = selectedWindow;

  if (!isBackground) {
    showLoading();
    setControlsDisabled(true);
  }

  try {
    const geojson = await fetchFeed(windowKey);
    if (token !== loadToken) {
      return;
    }
    const quakes = toQuakes(geojson, windowKey);
    const arrivalIds = findArrivals(quakes, windowKey);

    allQuakes = quakes;
    dataWindow = windowKey;
    lastFetchedAt = Date.now();
    errorCard.classList.add('is-hidden');
    renderAll(arrivalIds);
    renderUpdatedClock();

    const newestArrival = filteredQuakes.find((quake) => arrivalIds.has(quake.id));
    if (newestArrival) {
      playPing(newestArrival.magnitude);
    }
  } catch (error) {
    if (token === loadToken) {
      showError(describeError(error));
    }
  } finally {
    if (token === loadToken) {
      hideLoading();
      setControlsDisabled(false);
    }
  }
}

function startPolling() {
  if (pollTimerId === null) {
    pollTimerId = setInterval(() => loadQuakes({ isBackground: true }), POLL_INTERVAL_MS);
  }
}

function stopPolling() {
  clearInterval(pollTimerId);
  pollTimerId = null;
}

function selectQuake(id) {
  const quake = filteredQuakes.find((candidate) => candidate.id === id);
  if (!quake) {
    return;
  }
  selectedId = id;
  renderSelection();
  playPing(quake.magnitude);
}

function handleWindowClick(event) {
  const windowKey = event.currentTarget.dataset.window;
  if (!FEEDS[windowKey] || windowKey === selectedWindow) {
    return;
  }
  selectedWindow = windowKey;
  renderWindowButtons();
  loadQuakes();
}

function handleSliderInput() {
  minimumMagnitude = Number(magnitudeSlider.value) || 0;
  renderSliderLabel();
  renderAll();
}

function handleRefreshClick() {
  loadQuakes();
}

function handleMarkerClick(event) {
  const marker = event.target.closest('.quake');
  if (marker) {
    selectQuake(marker.dataset.id);
  }
}

function handleMarkerKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  const marker = event.target.closest('.quake');
  if (marker) {
    event.preventDefault();
    selectQuake(marker.dataset.id);
  }
}

function handleListClick(event) {
  const row = event.target.closest('.quake-row');
  if (row) {
    selectQuake(row.dataset.id);
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopPolling();
    return;
  }
  startPolling();
  if (lastFetchedAt === null || Date.now() - lastFetchedAt >= POLL_INTERVAL_MS) {
    loadQuakes({ isBackground: true });
  }
}

function addEventListeners() {
  windowButtons.forEach((button) => {
    button.addEventListener('click', handleWindowClick);
  });
  magnitudeSlider.addEventListener('input', handleSliderInput);
  refreshButton.addEventListener('click', handleRefreshClick);
  retryButton.addEventListener('click', handleRefreshClick);
  soundButton.addEventListener('click', toggleSound);
  markersLayer.addEventListener('click', handleMarkerClick);
  markersLayer.addEventListener('keydown', handleMarkerKeydown);
  quakeList.addEventListener('click', handleListClick);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function init() {
  buildGraticule();
  buildSeismograph();
  setUpAudio();
  addEventListeners();
  renderWindowButtons();
  renderSliderLabel();
  renderSoundButton();
  loadLand();
  loadQuakes();
  if (!document.hidden) {
    startPolling();
  }
  setInterval(renderUpdatedClock, CLOCK_INTERVAL_MS);
}

init();

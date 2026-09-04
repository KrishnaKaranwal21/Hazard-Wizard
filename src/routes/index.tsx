import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  CloudRain,
  CloudSun,
  Droplets,
  Gauge,
  LocateFixed,
  MapPin,
  Moon,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  ThermometerSun,
  Wind,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  getGooglePlaceLocation,
  getPlacePredictions,
  type PlacePrediction,
} from "@/lib/place-autocomplete";
import {
  describeWeather,
  fetchWeather,
  searchLocations,
  type Location,
  type WeatherSnapshot,
} from "@/lib/weather";
import { getHazardAssessment } from "@/lib/hazard-ml";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "HazardWatch — Live Weather Hazard Monitor" },
      {
        name: "description",
        content: "Live weather conditions, precipitation and threshold-based hazard monitoring.",
      },
      { property: "og:title", content: "HazardWatch — Live Weather Hazard Monitor" },
      {
        property: "og:description",
        content: "Clear live weather conditions and practical, threshold-based hazard signals.",
      },
    ],
  }),
  component: Dashboard,
});

const defaultLocation: Location = {
  name: "Bengaluru",
  country: "India",
  latitude: 12.9716,
  longitude: 77.5946,
};

type Hazard = {
  title: string;
  detail: string;
  severity: "critical" | "watch";
  source: string;
};

type TimeMode = "morning" | "day" | "evening" | "night";
type Appearance = "dark" | "light";

function Dashboard() {
  const [location, setLocation] = useState<Location>(defaultLocation);
  const [placeQuery, setPlaceQuery] = useState(defaultLocation.name);
  const [latitude, setLatitude] = useState(String(defaultLocation.latitude));
  const [longitude, setLongitude] = useState(String(defaultLocation.longitude));
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isPredicting, setIsPredicting] = useState(false);
  const [placePredictions, setPlacePredictions] = useState<PlacePrediction[]>([]);
  const [googleConfigured, setGoogleConfigured] = useState<boolean | null>(null);
  const [appearance, setAppearance] = useState<Appearance>("dark");
  const [clock, setClock] = useState<Date | null>(null);
  const predictionRequestRef = useRef(0);
  const suppressPredictionsRef = useRef(true);
  const placesSessionRef = useRef(createPlacesSession());

  const refresh = useCallback(
    async (target: Location = location) => {
      setIsRefreshing(true);
      setError(null);
      try {
        const data = await fetchWeather(target);
        setSnapshot(data);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Live weather data could not be loaded.",
        );
      } finally {
        setIsRefreshing(false);
      }
    },
    [location],
  );

  useEffect(() => {
    void refresh(location);
    const refreshId = window.setInterval(() => void refresh(location), 60_000);
    return () => window.clearInterval(refreshId);
  }, [location, refresh]);

  useEffect(() => {
    const syncClock = () => setClock(new Date());
    syncClock();
    const clockId = window.setInterval(syncClock, 1_000);
    return () => window.clearInterval(clockId);
  }, []);

  useEffect(() => {
    const savedAppearance = window.localStorage.getItem("hazardwatch-appearance");
    if (savedAppearance === "dark" || savedAppearance === "light") setAppearance(savedAppearance);
  }, []);

  useEffect(() => {
    if (suppressPredictionsRef.current) {
      suppressPredictionsRef.current = false;
      return;
    }

    const query = placeQuery.trim();
    if (query.length < 2) {
      predictionRequestRef.current += 1;
      setIsPredicting(false);
      setPlacePredictions([]);
      setGoogleConfigured(null);
      return;
    }

    const requestId = predictionRequestRef.current + 1;
    predictionRequestRef.current = requestId;
    const timeoutId = window.setTimeout(() => {
      void getPlacePredictions({
        data: { query, sessionToken: placesSessionRef.current },
      })
        .then((result) => {
          if (predictionRequestRef.current !== requestId) return;
          setPlacePredictions(result.predictions);
          setGoogleConfigured(result.googleConfigured);
        })
        .catch(async () => {
          try {
            const matches = await searchLocations(query);
            if (predictionRequestRef.current !== requestId) return;
            setGoogleConfigured(false);
            setPlacePredictions(
              matches.map((match, index) => ({
                id: `${match.latitude}:${match.longitude}:${index}`,
                label: locationLabel(match),
                provider: "fallback" as const,
                location: match,
              })),
            );
          } catch {
            if (predictionRequestRef.current !== requestId) return;
            setPlacePredictions([]);
          }
        })
        .finally(() => {
          if (predictionRequestRef.current === requestId) setIsPredicting(false);
        });
      setIsPredicting(true);
    }, 280);

    return () => {
      window.clearTimeout(timeoutId);
      if (predictionRequestRef.current === requestId) predictionRequestRef.current += 1;
    };
  }, [placeQuery]);

  const updateLocation = (next: Location) => {
    suppressPredictionsRef.current = true;
    predictionRequestRef.current += 1;
    setPlacePredictions([]);
    setGoogleConfigured(null);
    setSnapshot(null);
    setLocation(next);
    setPlaceQuery(next.name);
    setLatitude(next.latitude.toFixed(4));
    setLongitude(next.longitude.toFixed(4));
  };

  const searchPlace = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const term = placeQuery.trim();
    if (!term) {
      setError("Enter a place name to search.");
      return;
    }
    setIsSearching(true);
    setPlacePredictions([]);
    setError(null);
    try {
      const results = await searchLocations(term);
      const match = results[0];
      if (!match) {
        setError(`No matching place was found for “${term}”. Try a city, town, or region name.`);
        return;
      }
      updateLocation(match);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Location search failed.");
    } finally {
      setIsSearching(false);
    }
  };

  const choosePrediction = async (prediction: PlacePrediction) => {
    setIsSearching(true);
    setError(null);
    try {
      const next =
        prediction.provider === "google"
          ? await getGooglePlaceLocation({
              data: { placeId: prediction.id, sessionToken: placesSessionRef.current },
            })
          : prediction.location;
      if (!next) throw new Error("That prediction no longer has a usable location.");
      updateLocation(next);
      placesSessionRef.current = createPlacesSession();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That place could not be selected.");
    } finally {
      setIsSearching(false);
    }
  };

  const toggleAppearance = () => {
    setAppearance((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem("hazardwatch-appearance", next);
      return next;
    });
  };

  const submitCoordinates = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextLatitude = Number(latitude);
    const nextLongitude = Number(longitude);
    if (
      !Number.isFinite(nextLatitude) ||
      !Number.isFinite(nextLongitude) ||
      Math.abs(nextLatitude) > 90 ||
      Math.abs(nextLongitude) > 180
    ) {
      setError("Use a latitude from −90 to 90 and a longitude from −180 to 180.");
      return;
    }
    updateLocation({
      name: `${nextLatitude.toFixed(4)}°, ${nextLongitude.toFixed(4)}°`,
      latitude: nextLatitude,
      longitude: nextLongitude,
    });
  };

  const useDeviceLocation = () => {
    if (!navigator.geolocation) {
      setError("This browser does not provide device location.");
      return;
    }
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        updateLocation({
          name: "Your current location",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      () => setError("Location access was not granted. You can enter coordinates instead."),
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  };

  const hazards = useMemo(() => (snapshot ? getHazards(snapshot) : []), [snapshot]);
  const mlAssessment = useQuery({
    queryKey: ["hazard-ml", snapshot?.location.latitude, snapshot?.location.longitude, snapshot?.observedAt],
    queryFn: () => getHazardAssessment({ data: snapshot! }),
    enabled: snapshot !== null,
    retry: 1,
    staleTime: 55_000,
  });
  const highestSeverity = hazards.some((hazard) => hazard.severity === "critical")
    ? "critical"
    : hazards.length > 0
      ? "watch"
      : "normal";
  const forecastRain = snapshot?.hourly.reduce((total, item) => total + item.precipitation, 0) ?? 0;
  const nextWetHour = snapshot?.hourly.find(
    (hour) => hour.precipitationProbability >= 40 || hour.precipitation > 0.2,
  );
  const peakPrecipitationChance = Math.max(
    0,
    ...(snapshot?.hourly.map((hour) => hour.precipitationProbability) ?? []),
  );
  const peakForecastWind = Math.max(0, ...(snapshot?.hourly.map((hour) => hour.windSpeed) ?? []));
  const forecastTemperatures = snapshot?.hourly.map((hour) => hour.temperature) ?? [];
  const forecastTemperatureRange = forecastTemperatures.length
    ? `${Math.min(...forecastTemperatures).toFixed(0)}–${Math.max(...forecastTemperatures).toFixed(0)}°C`
    : "Unavailable";
  const timeMode = clock ? getTimeMode(clock, snapshot?.timezone) : "night";

  return (
    <main className={`hazard-app mode-${timeMode} appearance-${appearance}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <section className="dashboard-shell">
        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <ShieldCheck size={22} strokeWidth={2.2} />
            </div>
            <div>
              <p className="eyebrow">Environmental intelligence</p>
              <div className="brand-name">
                Hazard<span>Watch</span>
              </div>
            </div>
          </div>

          <div className="topbar-meta">
            <div className="local-time">
              <span className="meta-label">Current local time</span>
              <strong>{clock ? formatClock(clock, snapshot?.timezone) : "--:--:--"}</strong>
              <span>
                {clock
                  ? `${formatDate(clock, snapshot?.timezone)} · ${timeMode} mode`
                  : "Loading local time…"}
              </span>
            </div>
            <div className="live-indicator" aria-label="Live data updates every minute">
              <span className="live-dot" />
              <span>{isRefreshing ? "SYNCING" : "LIVE DATA"}</span>
            </div>
            <button
              className="appearance-toggle"
              type="button"
              onClick={toggleAppearance}
              aria-pressed={appearance === "light"}
              aria-label={`Switch to ${appearance === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${appearance === "dark" ? "light" : "dark"} mode`}
            >
              {appearance === "dark" ? <Sun size={15} /> : <Moon size={15} />}
              <span>{appearance === "dark" ? "Light" : "Dark"}</span>
            </button>
          </div>
        </header>

        <section className="hero-row">
          <div>
            <p className="eyebrow accent">Live hazard overview</p>
            <h1>
              Know what the weather is doing <em>right now.</em>
            </h1>
            <p className="hero-copy">
              Live conditions and rainfall outlook, translated into clear weather hazard signals for
              any monitored location.
            </p>
          </div>
          <div className={`system-status status-${highestSeverity}`}>
            <span className="status-kicker">Monitoring status</span>
            <strong>
              {highestSeverity === "normal"
                ? "All clear"
                : highestSeverity === "watch"
                  ? "Keep watch"
                  : "Action advised"}
            </strong>
            <span>
              {hazards.length === 0
                ? "No active threshold alerts"
                : `${hazards.length} active threshold alert${hazards.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </section>

        <section className="location-controls" aria-label="Choose monitoring location">
          <form className="place-search" onSubmit={searchPlace}>
            <label htmlFor="place">Monitor a place</label>
            <div className="input-wrap">
              <Search size={18} aria-hidden="true" />
              <input
                id="place"
                value={placeQuery}
                onChange={(event) => setPlaceQuery(event.target.value)}
                placeholder="Search city or region"
                autoComplete="off"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={placePredictions.length > 0}
                aria-controls="place-predictions"
              />
              <button className="primary-button" type="submit" disabled={isSearching}>
                {isSearching ? "Finding…" : "Search"}
              </button>
            </div>
            {(isPredicting || placePredictions.length > 0) && (
              <div className="prediction-popover">
                <div className="prediction-meta">
                  <span>{isPredicting ? "Finding places…" : "Place predictions"}</span>
                  {!isPredicting &&
                    (googleConfigured ? (
                      <span translate="no">Google Maps</span>
                    ) : (
                      <span>Location search</span>
                    ))}
                </div>
                {placePredictions.length > 0 && (
                  <ul id="place-predictions" className="place-predictions" role="listbox">
                    {placePredictions.map((prediction) => (
                      <li key={`${prediction.provider}-${prediction.id}`}>
                        <button type="button" onClick={() => void choosePrediction(prediction)}>
                          <MapPin size={15} aria-hidden="true" />
                          <span>{prediction.label}</span>
                          {prediction.provider === "google" && (
                            <small translate="no">Google Maps</small>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </form>
          <div className="control-divider" />
          <form className="coordinate-form" onSubmit={submitCoordinates}>
            <label>Or use coordinates</label>
            <input
              aria-label="Latitude"
              value={latitude}
              onChange={(event) => setLatitude(event.target.value)}
              inputMode="decimal"
              placeholder="Latitude"
            />
            <input
              aria-label="Longitude"
              value={longitude}
              onChange={(event) => setLongitude(event.target.value)}
              inputMode="decimal"
              placeholder="Longitude"
            />
            <button
              className="icon-button"
              type="button"
              onClick={useDeviceLocation}
              title="Use my location"
              aria-label="Use my location"
            >
              <LocateFixed size={18} />
            </button>
            <button className="apply-button" type="submit">
              Apply
            </button>
          </form>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={18} />
            <span>{error}</span>
            <button type="button" onClick={() => void refresh()}>
              <RefreshCw size={15} /> Retry
            </button>
          </div>
        )}

        <section className="location-heading" aria-live="polite">
          <div className="location-title">
            <MapPin size={21} />
            <div>
              <h2>{locationLabel(snapshot?.location ?? location)}</h2>
              <p>
                {snapshot
                  ? `${formatCoordinates(snapshot.location)} · ${snapshot.timezoneAbbreviation}`
                  : "Connecting to live weather service…"}
              </p>
            </div>
          </div>
          <div className="updated-at">
            <span>Provider observation</span>
            <strong>
              {snapshot
                ? formatTimestamp(snapshot.observedAt, snapshot.timezone)
                : "Loading current conditions…"}
            </strong>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={isRefreshing}
              aria-label="Refresh live weather data"
            >
              <RefreshCw size={15} className={isRefreshing ? "spinning" : ""} /> Refresh now
            </button>
            {snapshot && (
              <details className="more-details">
                <summary>
                  Detailed briefing <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="details-menu">
                  <div className="details-menu-heading">
                    <span>Live weather detail</span>
                    <strong>{formatTimestamp(snapshot.observedAt, snapshot.timezone)}</strong>
                  </div>
                  <DetailItem label="Temperature" value={`${snapshot.temperature.toFixed(1)}°C`} />
                  <DetailItem
                    label="Feels like"
                    value={`${snapshot.apparentTemperature.toFixed(1)}°C`}
                  />
                  <DetailItem label="Current state" value={describeWeather(snapshot.weatherCode)} />
                  <DetailItem label="Humidity" value={`${snapshot.humidity.toFixed(0)}%`} />
                  <DetailItem
                    label="Precipitation now"
                    value={`${snapshot.precipitation.toFixed(1)} mm`}
                  />
                  <DetailItem label="Rain now" value={`${snapshot.rain.toFixed(1)} mm`} />
                  <DetailItem label="Wind speed" value={`${snapshot.windSpeed.toFixed(0)} km/h`} />
                  <DetailItem label="Wind gusts" value={`${snapshot.windGusts.toFixed(0)} km/h`} />
                  <DetailItem
                    label="Wind direction"
                    value={`${directionLabel(snapshot.windDirection)} · ${snapshot.windDirection.toFixed(0)}°`}
                  />
                  <DetailItem
                    label="Surface pressure"
                    value={`${snapshot.pressure.toFixed(0)} hPa`}
                  />
                  <DetailItem label="Time zone" value={snapshot.timezoneAbbreviation} />
                  <DetailItem
                    label="24h rain outlook"
                    value={`${forecastRain.toFixed(1)} mm total`}
                  />
                  <DetailItem
                    label="Peak rain chance"
                    value={`${peakPrecipitationChance.toFixed(0)}% over 24h`}
                  />
                  <DetailItem label="Forecast temperature" value={forecastTemperatureRange} />
                  <DetailItem
                    label="Peak forecast wind"
                    value={`${peakForecastWind.toFixed(0)} km/h`}
                  />
                  <DetailItem
                    label="Next wet period"
                    value={
                      nextWetHour
                        ? `${formatHour(nextWetHour.time, snapshot.timezone)} · ${nextWetHour.precipitationProbability.toFixed(0)}%`
                        : "No notable signal"
                    }
                  />
                </div>
              </details>
            )}
          </div>
        </section>

        {snapshot ? (
          <>
            <section className="metric-grid" aria-label="Current weather conditions">
              <MetricCard
                icon={ThermometerSun}
                label="Temperature"
                value={snapshot.temperature.toFixed(1)}
                unit="°C"
                note={`Feels like ${snapshot.apparentTemperature.toFixed(1)}°C`}
                tone="sun"
              />
              <MetricCard
                icon={CloudRain}
                label="Precipitation"
                value={snapshot.precipitation.toFixed(1)}
                unit="mm"
                note={
                  snapshot.rain > 0
                    ? `${snapshot.rain.toFixed(1)} mm rain recorded`
                    : "No rain in current interval"
                }
                tone="rain"
              />
              <MetricCard
                icon={Droplets}
                label="Humidity"
                value={snapshot.humidity.toFixed(0)}
                unit="%"
                note="Relative humidity at 2 m"
                tone="aqua"
              />
              <MetricCard
                icon={Wind}
                label="Wind speed"
                value={snapshot.windSpeed.toFixed(0)}
                unit="km/h"
                note={`Gusts up to ${snapshot.windGusts.toFixed(0)} km/h`}
                tone="wind"
              />
              <MetricCard
                icon={Gauge}
                label="Surface pressure"
                value={snapshot.pressure.toFixed(0)}
                unit="hPa"
                note={`Wind ${directionLabel(snapshot.windDirection)}`}
                tone="pressure"
              />
            </section>

            <section className="panel alerts-panel hazard-priority">
              <div className="panel-heading">
                <div>
                  <p className="panel-eyebrow">Rule-based monitor</p>
                  <h2>Hazard signals</h2>
                </div>
                <Activity size={25} className="heading-icon" />
              </div>
              {hazards.length ? (
                <div className="hazard-list">
                  {hazards.map((hazard) => (
                    <HazardRow key={hazard.title} hazard={hazard} />
                  ))}
                </div>
              ) : (
                <div className="clear-state">
                  <ShieldCheck size={24} />
                  <div>
                    <strong>No thresholds are exceeded.</strong>
                    <span>
                      Temperature, precipitation, wind, and pressure are currently within the
                      monitor’s baseline range.
                    </span>
                  </div>
                </div>
              )}
            </section>

            <section className="content-grid">
              <section className="panel weather-panel">
                <div className="panel-heading">
                  <div>
                    <p className="panel-eyebrow">Current situation</p>
                    <h2>{describeWeather(snapshot.weatherCode)}</h2>
                  </div>
                  <CloudSun size={29} className="heading-icon" />
                </div>
                <div className="weather-summary">
                  <div className="condition-temperature">
                    {snapshot.temperature.toFixed(0)}
                    <span>°</span>
                  </div>
                  <div>
                    <p>{snapshot.isDay ? "Daylight conditions" : "Night conditions"}</p>
                    <strong>
                      Apparent temperature {snapshot.apparentTemperature.toFixed(1)}°C
                    </strong>
                    <span>Observed {formatTimestamp(snapshot.observedAt, snapshot.timezone)}</span>
                  </div>
                </div>
                <div className="weather-facts">
                  <Fact
                    label="Precipitation now"
                    value={`${snapshot.precipitation.toFixed(1)} mm`}
                  />
                  <Fact label="Rain now" value={`${snapshot.rain.toFixed(1)} mm`} />
                  <Fact label="Wind gusts" value={`${snapshot.windGusts.toFixed(0)} km/h`} />
                  <Fact label="Pressure" value={`${snapshot.pressure.toFixed(0)} hPa`} />
                </div>
              </section>

              <section className="panel precipitation-panel">
                <div className="panel-heading">
                  <div>
                    <p className="panel-eyebrow">Next 24 hours</p>
                    <h2>Precipitation outlook</h2>
                  </div>
                  <div className="forecast-total">
                    <strong>{forecastRain.toFixed(1)} mm</strong>
                    <span>forecast total</span>
                  </div>
                </div>
                <PrecipitationChart readings={snapshot.hourly} timezone={snapshot.timezone} />
                <div className="forecast-note">
                  <CloudRain size={17} />
                  {nextWetHour ? (
                    <span>
                      Next likely precipitation:{" "}
                      <strong>{formatHour(nextWetHour.time, snapshot.timezone)}</strong> ·{" "}
                      {nextWetHour.precipitationProbability.toFixed(0)}% probability
                    </span>
                  ) : (
                    <span>No notable precipitation signal in the next 24 hours.</span>
                  )}
                </div>
              </section>
            </section>

            <section className="bottom-grid anomaly-grid">
              <section className="panel ml-panel">
                <div className="panel-heading">
                  <div>
                    <p className="panel-eyebrow">AI autoencoder</p>
                    <h2>Anomaly detection</h2>
                  </div>
                  <Activity size={25} className="heading-icon" />
                </div>
                {mlAssessment.isLoading ? (
                  <div className="clear-state">
                    <span>Scoring current conditions…</span>
                  </div>
                ) : mlAssessment.isError ? (
                  <div className="clear-state">
                    <AlertTriangle size={24} />
                    <div>
                      <strong>AI analysis unavailable.</strong>
                      <span>Rule-based signals above are still live.</span>
                    </div>
                  </div>
                ) : mlAssessment.data?.status === "Hazard" ? (
                  <div className="hazard-list">
                    <HazardRow
                      hazard={{
                        title: "Anomalous conditions detected",
                        detail: `Reconstruction anomaly score ${mlAssessment.data.anomalyScore.toFixed(2)}. Top factors: ${mlAssessment.data.triggerFactors.join(", ")}.`,
                        severity: mlAssessment.data.anomalyScore > 0.8 ? "critical" : "watch",
                        source: "AI",
                      }}
                    />
                  </div>
                ) : (
                  <div className="clear-state">
                    <ShieldCheck size={24} />
                    <div>
                      <strong>No anomaly detected by the model.</strong>
                      <span>
                        Anomaly score {mlAssessment.data?.anomalyScore.toFixed(2) ?? "—"} is within
                        the learned normal range.
                      </span>
                    </div>
                  </div>
                )}
              </section>
            </section>
          </>
        ) : (
          <section className="loading-card" aria-busy="true">
            <span className="loading-orb" />
            <div>
              <strong>Loading live weather conditions</strong>
              <span>Connecting to the weather service for {locationLabel(location)}…</span>
            </div>
          </section>
        )}

        <footer className="dashboard-footer">
          <span>
            HazardWatch provides weather-awareness signals, not official emergency warnings.
          </span>
          <span>
            Last interface refresh: {clock ? formatTimestamp(clock.getTime(), snapshot?.timezone) : "Loading…"}
          </span>
        </footer>
      </section>
    </main>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  unit,
  note,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  unit: string;
  note: string;
  tone: string;
}) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-icon">
        <Icon size={20} />
      </div>
      <p>{label}</p>
      <div className="metric-value">
        {value}
        <span>{unit}</span>
      </div>
      <small>{note}</small>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HazardRow({ hazard }: { hazard: Hazard }) {
  return (
    <article className={`hazard-row hazard-${hazard.severity}`}>
      <span className="hazard-symbol">
        <AlertTriangle size={18} />
      </span>
      <div>
        <strong>{hazard.title}</strong>
        <p>{hazard.detail}</p>
      </div>
      <span className="hazard-source">{hazard.source}</span>
    </article>
  );
}

function PrecipitationChart({
  readings,
  timezone,
}: {
  readings: WeatherSnapshot["hourly"];
  timezone: string;
}) {
  const maxValue = Math.max(1, ...readings.map((reading) => reading.precipitation));
  return (
    <div className="rain-chart" aria-label="Hourly precipitation forecast">
      <div className="chart-gridline chart-gridline-top" />
      <div className="chart-gridline chart-gridline-mid" />
      <div className="chart-gridline chart-gridline-bottom" />
      <div className="chart-bars">
        {readings.map((reading, index) => {
          const isLabelled = index === 0 || index === readings.length - 1 || index % 4 === 0;
          const height = Math.max(
            reading.precipitation > 0 ? 8 : 2,
            (reading.precipitation / maxValue) * 100,
          );
          return (
            <div
              className="chart-column"
              key={reading.time}
              title={`${formatHour(reading.time, timezone)}: ${reading.precipitation.toFixed(1)} mm, ${reading.precipitationProbability.toFixed(0)}% probability`}
            >
              <span className="chart-value">
                {reading.precipitation > 0 ? reading.precipitation.toFixed(1) : ""}
              </span>
              <div className="bar-track">
                <div className="bar-fill" style={{ height: `${height}%` }} />
              </div>
              <span className="chart-label">
                {isLabelled ? formatHour(reading.time, timezone) : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getHazards(snapshot: WeatherSnapshot): Hazard[] {
  const alerts: Hazard[] = [];
  if (snapshot.precipitation >= 7)
    alerts.push({
      title: "Heavy precipitation",
      detail: `${snapshot.precipitation.toFixed(1)} mm is recorded in the current weather interval. Check drainage and local flood advisories.`,
      severity: "critical",
      source: "RAIN",
    });
  else if (snapshot.precipitation >= 2)
    alerts.push({
      title: "Steady precipitation",
      detail: `${snapshot.precipitation.toFixed(1)} mm is recorded in the current weather interval. Monitor changing road and surface conditions.`,
      severity: "watch",
      source: "RAIN",
    });
  if (snapshot.windGusts >= 70)
    alerts.push({
      title: "Strong wind gusts",
      detail: `Peak gusts are ${snapshot.windGusts.toFixed(0)} km/h. Secure exposed equipment and review local wind guidance.`,
      severity: "critical",
      source: "WIND",
    });
  else if (snapshot.windGusts >= 50)
    alerts.push({
      title: "Gusty conditions",
      detail: `Peak gusts are ${snapshot.windGusts.toFixed(0)} km/h. Outdoor work and travel may need extra care.`,
      severity: "watch",
      source: "WIND",
    });
  if (snapshot.apparentTemperature >= 42)
    alerts.push({
      title: "Extreme heat stress",
      detail: `Apparent temperature is ${snapshot.apparentTemperature.toFixed(1)}°C. Prioritise shade, hydration, and heat safety procedures.`,
      severity: "critical",
      source: "HEAT",
    });
  else if (snapshot.apparentTemperature >= 36)
    alerts.push({
      title: "Elevated heat stress",
      detail: `Apparent temperature is ${snapshot.apparentTemperature.toFixed(1)}°C. Plan hydration and rest breaks for prolonged outdoor activity.`,
      severity: "watch",
      source: "HEAT",
    });
  if (snapshot.pressure < 985)
    alerts.push({
      title: "Low-pressure pattern",
      detail: `Surface pressure is ${snapshot.pressure.toFixed(0)} hPa. Watch for rapidly evolving local weather.`,
      severity: "watch",
      source: "PRESSURE",
    });
  return alerts;
}

function locationLabel(location: Location): string {
  return [location.name, location.admin1, location.country].filter(Boolean).join(", ");
}

function formatCoordinates(location: Location): string {
  return `${location.latitude.toFixed(4)}°, ${location.longitude.toFixed(4)}°`;
}

function formatClock(date: Date, timezone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(date);
}

function formatDate(date: Date, timezone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: timezone,
  }).format(date);
}

function formatTimestamp(timestamp: number, timezone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(new Date(timestamp));
}

function formatHour(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(new Date(timestamp));
}

function getTimeMode(date: Date, timezone = "UTC"): TimeMode {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(date),
  );

  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "day";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

function createPlacesSession(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function directionLabel(degrees: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(degrees / 45) % 8] ?? "N";
}

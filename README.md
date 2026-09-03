# HazardWatch

HazardWatch is a responsive weather-hazard dashboard that reads live conditions from the Open-Meteo Forecast API. It makes the latest temperature, precipitation, humidity, wind, pressure, observation time, and rule-based alerts easy to scan.

## Features

- Live public-weather data, refreshed automatically every 60 seconds
- Search a place or enter a precise latitude and longitude
- Current precipitation plus a 24-hour precipitation outlook
- Full date, time, provider observation timestamp, and time zone
- Clear threshold-based heat, rain, wind, and low-pressure alerts
- No synthetic telemetry or API key required

## Run locally

```sh
npm install
npm run dev
```

Then open the local address shown by Vite. To create a production build, run `npm run build`.

## Data source

The client calls [Open-Meteo's Forecast API](https://open-meteo.com/en/docs) directly. The API returns model-based current conditions and forecast values; it is not a replacement for official weather warnings or emergency services.

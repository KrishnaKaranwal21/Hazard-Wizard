import { createServerFn } from "@tanstack/react-start";

import type { WeatherSnapshot } from "./weather";

export type HazardAssessment = {
  status: "Normal" | "Hazard";
  anomalyScore: number;
  triggerFactors: string[];
};

type MlApiResponse = {
  status: "Normal" | "Hazard";
  anomaly_score: number;
  trigger_factors: string[];
};

export const getHazardAssessment = createServerFn({ method: "POST" })
  .validator((snapshot: WeatherSnapshot) => snapshot)
  .handler(async ({ data }): Promise<HazardAssessment> => {
    const apiUrl = process.env.ML_API_URL;
    if (!apiUrl) {
      throw new Error("ML_API_URL is not configured on the server.");
    }

    const response = await fetch(`${apiUrl}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.ML_API_KEY ? { "X-API-Key": process.env.ML_API_KEY } : {}),
      },
      body: JSON.stringify({
        temperature_2m: data.temperature,
        relative_humidity_2m: data.humidity,
        pressure_msl: data.pressureMsl,
        wind_speed_10m: data.windSpeed,
        wind_gusts_10m: data.windGusts,
        precipitation: data.precipitation,
        cloud_cover: data.cloudCover,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(`ML service returned ${response.status}`);
    }

    const payload = (await response.json()) as MlApiResponse;
    return {
      status: payload.status,
      anomalyScore: payload.anomaly_score,
      triggerFactors: payload.trigger_factors,
    };
  });

import { createServerFn } from "@tanstack/react-start";

import { searchLocations, type Location } from "@/lib/weather";

type JsonRecord = Record<string, unknown>;

export type PlacePrediction = {
  id: string;
  label: string;
  provider: "google" | "fallback";
  location?: Location;
};

export type PredictionResult = {
  googleConfigured: boolean;
  predictions: PlacePrediction[];
};

type PredictionInput = {
  query: string;
  sessionToken?: string;
};

const autocompleteEndpoint =
  "https://places.googleapis.com/v1/places:autocomplete";
const placesEndpoint = "https://places.googleapis.com/v1/places";

const predictionValidator = (input: unknown): PredictionInput => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A place search query is required.");
  }

  const data = input as JsonRecord;
  const query =
    typeof data["query"] === "string" ? data["query"].trim().slice(0, 120) : "";
  const sessionToken =
    typeof data["sessionToken"] === "string"
      ? data["sessionToken"].trim().slice(0, 120)
      : undefined;

  if (query.length < 2)
    throw new Error("Enter at least two characters to search for a place.");
  return sessionToken ? { query, sessionToken } : { query };
};

const placeIdValidator = (
  input: unknown,
): { placeId: string; sessionToken?: string } => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A Google place is required.");
  }

  const data = input as JsonRecord;
  const placeId =
    typeof data["placeId"] === "string" ? data["placeId"].trim() : "";
  const sessionToken =
    typeof data["sessionToken"] === "string"
      ? data["sessionToken"].trim().slice(0, 120)
      : undefined;

  if (!/^[A-Za-z0-9_-]{10,200}$/.test(placeId))
    throw new Error("That Google place is invalid.");
  return sessionToken ? { placeId, sessionToken } : { placeId };
};

export const getPlacePredictions = createServerFn({ method: "POST" })
  .validator(predictionValidator)
  .handler(async ({ data }): Promise<PredictionResult> => {
    const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
    if (!apiKey) return getFallbackPredictions(data.query);

    try {
      const response = await fetch(autocompleteEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text",
        },
        body: JSON.stringify({
          input: data.query,
          includedPrimaryTypes: ["(cities)"],
          ...(data.sessionToken ? { sessionToken: data.sessionToken } : {}),
        }),
      });

      if (!response.ok)
        throw new Error(`Google Places returned ${response.status}.`);
      const payload = recordValue(await response.json());
      const suggestions = Array.isArray(payload["suggestions"])
        ? payload["suggestions"]
        : [];
      const predictions = suggestions.flatMap((suggestion) => {
        const item = recordValueOrNull(suggestion);
        const prediction = item
          ? recordValueOrNull(item["placePrediction"])
          : null;
        const text = prediction ? recordValueOrNull(prediction["text"]) : null;
        const placeId = prediction?.["placeId"];
        const label = text?.["text"];
        if (typeof placeId !== "string" || typeof label !== "string") return [];
        return [{ id: placeId, label, provider: "google" as const }];
      });

      return { googleConfigured: true, predictions };
    } catch (error) {
      console.warn(
        "Google Places prediction request failed; using location fallback.",
        error,
      );
      return getFallbackPredictions(data.query, true);
    }
  });

export const getGooglePlaceLocation = createServerFn({ method: "POST" })
  .validator(placeIdValidator)
  .handler(async ({ data }): Promise<Location> => {
    const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
    if (!apiKey)
      throw new Error("Google Places is not configured for this deployment.");

    const query = new URLSearchParams();
    if (data.sessionToken) query.set("sessionToken", data.sessionToken);
    const response = await fetch(
      `${placesEndpoint}/${encodeURIComponent(data.placeId)}${query.size ? `?${query}` : ""}`,
      {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "displayName,formattedAddress,location,addressComponents",
        },
      },
    );
    if (!response.ok)
      throw new Error("Google Places could not load that location.");

    const payload = recordValue(await response.json());
    const coordinates = recordValueOrNull(payload["location"]);
    const latitude = coordinates?.["latitude"];
    const longitude = coordinates?.["longitude"];
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      throw new Error(
        "Google Places did not return coordinates for that location.",
      );
    }

    const displayName = recordValueOrNull(payload["displayName"])?.["text"];
    const addressComponents = Array.isArray(payload["addressComponents"])
      ? payload["addressComponents"]
      : [];
    const country = componentText(addressComponents, "country");
    const admin1 = componentText(
      addressComponents,
      "administrative_area_level_1",
    );

    return {
      name: typeof displayName === "string" ? displayName : "Selected place",
      latitude,
      longitude,
      ...(country ? { country } : {}),
      ...(admin1 ? { admin1 } : {}),
    };
  });

async function getFallbackPredictions(
  query: string,
  googleConfigured = false,
): Promise<PredictionResult> {
  const matches = await searchLocations(query);
  return {
    googleConfigured,
    predictions: matches.map((location, index) => ({
      id: `${location.latitude}:${location.longitude}:${index}`,
      label: [location.name, location.admin1, location.country]
        .filter(Boolean)
        .join(", "),
      provider: "fallback" as const,
      location,
    })),
  };
}

function recordValue(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Google Places returned an unexpected response.");
  }
  return value as JsonRecord;
}

function recordValueOrNull(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function componentText(
  components: unknown[],
  type: string,
): string | undefined {
  for (const value of components) {
    const component = recordValueOrNull(value);
    const types = component?.["types"];
    if (!Array.isArray(types) || !types.includes(type)) continue;
    const longText = component?.["longText"];
    if (typeof longText === "string") return longText;
  }
  return undefined;
}

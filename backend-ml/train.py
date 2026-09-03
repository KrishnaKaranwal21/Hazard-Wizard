"""
Run once (locally) to produce the artifacts main.py loads at startup:
  weights/autoencoder.pt, weights/scaler.pkl, weights/threshold.txt, weights/background.npy

Trains on pooled historical data from ~50 Indian cities spanning every
state/UT and all major climate zones, so the model learns "plausible
Indian weather" broadly rather than one city's specific normal range.

Fetched data is cached to raw_data/<city>.csv so re-running this script
(e.g. after tweaking the model) doesn't re-hit the API every time.
"""
import os
import time

import numpy as np
import pandas as pd
import torch
import joblib

from model_experiments import WeatherDataPipeline, TelemetryAutoencoder, FEATURE_COLUMNS

CITIES = {
    "Mumbai": (19.0760, 72.8777), "Delhi": (28.7041, 77.1025),
    "Bengaluru": (12.9716, 77.5946), "Chennai": (13.0827, 80.2707),
    "Kolkata": (22.5726, 88.3639), "Hyderabad": (17.3850, 78.4867),
    "Ahmedabad": (23.0225, 72.5714), "Pune": (18.5204, 73.8567),
    "Jaipur": (26.9124, 75.7873), "Lucknow": (26.8467, 80.9462),
    "Bhopal": (23.2599, 77.4126), "Patna": (25.5941, 85.1376),
    "Thiruvananthapuram": (8.5241, 76.9366), "Guwahati": (26.1445, 91.7362),
    "Chandigarh": (30.7333, 76.7794), "Bhubaneswar": (20.2961, 85.8245),
    "Raipur": (21.2514, 81.6296), "Ranchi": (23.3441, 85.3096),
    "Dehradun": (30.3165, 78.0322), "Shimla": (31.1048, 77.1734),
    "Srinagar": (34.0837, 74.7973), "Leh": (34.1526, 77.5771),
    "Jammu": (32.7266, 74.8570), "Amritsar": (31.6340, 74.8723),
    "Panaji": (15.4909, 73.8278), "Gangtok": (27.3389, 88.6065),
    "Shillong": (25.5788, 91.8933), "Imphal": (24.8170, 93.9368),
    "Aizawl": (23.7271, 92.7176), "Kohima": (25.6751, 94.1086),
    "Itanagar": (27.0844, 93.6053), "Agartala": (23.8315, 91.2868),
    "Jaisalmer": (26.9157, 70.9083), "Jodhpur": (26.2389, 73.0243),
    "Nagpur": (21.1458, 79.0882), "Indore": (22.7196, 75.8577),
    "Surat": (21.1702, 72.8311), "Kanpur": (26.4499, 80.3319),
    "Varanasi": (25.3176, 82.9739), "Coimbatore": (11.0168, 76.9558),
    "Madurai": (9.9252, 78.1198), "Visakhapatnam": (17.6868, 83.2185),
    "Vijayawada": (16.5062, 80.6480), "Mangaluru": (12.9141, 74.8560),
    "Kochi": (9.9312, 76.2673), "Puducherry": (11.9416, 79.8083),
    "Port Blair": (11.6234, 92.7265), "Siliguri": (26.7271, 88.3953),
    "Udaipur": (24.5854, 73.7125), "Gwalior": (26.2183, 78.1828),
}

FETCH_DELAY_SECONDS = 0.5
RAW_DATA_DIR = "raw_data"


def fetch_all_cities(start_date: str, end_date: str) -> pd.DataFrame:
    os.makedirs(RAW_DATA_DIR, exist_ok=True)
    frames = []
    for name, (lat, lon) in CITIES.items():
        cache_path = os.path.join(RAW_DATA_DIR, f"{name}.csv")
        if os.path.exists(cache_path):
            print(f"Using cached data for {name}")
            df = pd.read_csv(cache_path)
        else:
            print(f"Fetching historical data for {name}...")
            pipeline = WeatherDataPipeline(latitude=lat, longitude=lon)
            df = pipeline.fetch_historical(start_date, end_date)
            if df.empty:
                print(f"  WARNING: no data returned for {name}, skipping")
                continue
            df.to_csv(cache_path, index=False)
            time.sleep(FETCH_DELAY_SECONDS)
        df["city"] = name
        frames.append(df)

    if not frames:
        raise RuntimeError("No historical data could be fetched for any city.")

    combined = pd.concat(frames, ignore_index=True)
    print(f"\nPooled {len(combined)} hourly readings across {len(frames)} cities.")
    return combined


if __name__ == "__main__":
    raw = fetch_all_cities("2024-01-01", "2025-01-01")

    pipeline = WeatherDataPipeline(latitude=0, longitude=0, feature_columns=FEATURE_COLUMNS)
    X = pipeline.preprocess(raw, fit=True)

    model = TelemetryAutoencoder(input_dim=X.shape[1], epochs=50)
    model.fit(X)

    os.makedirs("weights", exist_ok=True)
    torch.save(model.model.state_dict(), "weights/autoencoder.pt")
    joblib.dump(pipeline.scaler, "weights/scaler.pkl")
    with open("weights/threshold.txt", "w") as f:
        f.write(str(model.threshold_))

    background_idx = np.random.choice(len(X), min(50, len(X)), replace=False)
    np.save("weights/background.npy", X[background_idx])

    print("\nSaved model artifacts to weights/ (trained on pan-India data, 50 cities)")

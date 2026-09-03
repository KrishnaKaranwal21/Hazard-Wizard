"""
SkyGuard ML API — thin FastAPI wrapper around final_ml_engine.py
Deploy this separately from the frontend (Render/Railway/Fly.io/Docker).
"""
import os

import joblib
import numpy as np
import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Header
from pydantic import BaseModel

from final_ml_engine import (
    WeatherDataPipeline,
    ProductionAutoencoder,
    SHAP_Explainer,
    run_live_inference,
    FEATURE_COLUMNS,
)

app = FastAPI(title="SkyGuard ML API")

API_KEY = os.environ.get("ML_API_KEY")


def check_key(x_api_key: str = Header(None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


class WeatherReading(BaseModel):
    temperature_2m: float
    relative_humidity_2m: float
    pressure_msl: float
    wind_speed_10m: float
    wind_gusts_10m: float
    precipitation: float
    cloud_cover: float


# --- load trained artifacts once at startup ---
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "weights")

pipeline = WeatherDataPipeline(latitude=0, longitude=0)  # lat/lon unused once scaler is loaded
pipeline.scaler = joblib.load(f"{WEIGHTS_DIR}/scaler.pkl")
pipeline._is_fitted = True

with open(f"{WEIGHTS_DIR}/threshold.txt") as f:
    threshold = float(f.read())

model = ProductionAutoencoder(
    input_dim=len(FEATURE_COLUMNS),
    threshold=threshold,
    weights_path=f"{WEIGHTS_DIR}/autoencoder.pt",
)

background = np.load(f"{WEIGHTS_DIR}/background.npy")
explainer = SHAP_Explainer(model, background_data=background, feature_names=FEATURE_COLUMNS)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/predict", dependencies=[Depends(check_key)])
def predict(reading: WeatherReading):
    df = pd.DataFrame([reading.dict()])
    return run_live_inference(df, pipeline, model, explainer)

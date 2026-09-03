"""
SkyGuard AI - Production ML Engine
=====================================
Ultra-clean production module. Exposes a single entrypoint,
run_live_inference(), that the frontend/backend integration layer calls.

Pipeline: Fetch -> Preprocess -> Autoencoder Inference -> SHAP Explainability
          -> Structured Output

NOTE: This file assumes the PyTorch Autoencoder (see model_experiments.py)
won the offline model comparison. In a real deployment, load trained
weights + a calibrated threshold produced by that training run instead of
using the randomly-initialized network shown in the __main__ smoke test.
"""

import warnings
from typing import List, Dict, Any, Optional

import numpy as np
import pandas as pd
import requests

from sklearn.preprocessing import StandardScaler

import torch
import torch.nn as nn

import shap

warnings.filterwarnings("ignore")

FEATURE_COLUMNS = [
    "temperature_2m",
    "relative_humidity_2m",
    "pressure_msl",
    "wind_speed_10m",
    "wind_gusts_10m",
    "precipitation",
    "cloud_cover",
]

# Human-readable labels handed to the frontend in `trigger_factors`
FEATURE_DISPLAY_NAMES = {
    "temperature_2m": "Temperature",
    "relative_humidity_2m": "Humidity",
    "pressure_msl": "Pressure",
    "wind_speed_10m": "Wind Speed",
    "wind_gusts_10m": "Wind Gusts",
    "precipitation": "Precipitation",
    "cloud_cover": "Cloud Cover",
}


# ---------------------------------------------------------------------------
# DATA PIPELINE (fetch + preprocess)
# ---------------------------------------------------------------------------
class WeatherDataPipeline:
    """Fetches live weather telemetry and prepares it for the autoencoder."""

    BASE_LIVE_URL = "https://api.open-meteo.com/v1/forecast"

    def __init__(self, latitude: float, longitude: float, feature_columns: Optional[List[str]] = None):
        self.latitude = latitude
        self.longitude = longitude
        self.feature_columns = feature_columns or FEATURE_COLUMNS
        self.scaler = StandardScaler()
        self._is_fitted = False

    def fetch_live(self) -> pd.DataFrame:
        params = {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "current": ",".join(self.feature_columns),
            "timezone": "UTC",
        }
        try:
            resp = requests.get(self.BASE_LIVE_URL, params=params, timeout=15)
            resp.raise_for_status()
            current = resp.json()["current"]
            return pd.DataFrame([current])
        except (requests.RequestException, KeyError, ValueError) as exc:
            print(f"[WeatherDataPipeline] Live fetch failed: {exc}")
            return pd.DataFrame(columns=self.feature_columns)

    def fit_scaler(self, reference_df: pd.DataFrame) -> "WeatherDataPipeline":
        """Fit the scaler once at startup using historical/reference data."""
        clean = self._clean(reference_df)
        self.scaler.fit(clean.values)
        self._is_fitted = True
        return self

    def preprocess(self, df: pd.DataFrame) -> np.ndarray:
        if not self._is_fitted:
            raise RuntimeError("Scaler not fitted. Call fit_scaler() with reference data at startup.")
        clean = self._clean(df)
        return self.scaler.transform(clean.values)

    def _clean(self, df: pd.DataFrame) -> pd.DataFrame:
        working = df.copy()
        for col in self.feature_columns:
            if col not in working.columns:
                working[col] = np.nan
        working = working[self.feature_columns]
        working = working.interpolate(method="linear", limit_direction="both")
        working = working.fillna(working.median(numeric_only=True))
        working = working.fillna(0.0)
        return working


# ---------------------------------------------------------------------------
# MODEL (winning architecture: PyTorch Autoencoder)
# ---------------------------------------------------------------------------
class AutoencoderNet(nn.Module):
    def __init__(self, input_dim: int, encoding_dim: int = 4, hidden_dim: int = 16):
        super().__init__()
        self.encoder = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, encoding_dim),
            nn.ReLU(),
        )
        self.decoder = nn.Sequential(
            nn.Linear(encoding_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, input_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.decoder(self.encoder(x))


class ProductionAutoencoder:
    """
    Production wrapper around the trained autoencoder. Handles inference,
    reconstruction-error scoring, and threshold-based anomaly flagging.
    """

    def __init__(
        self,
        input_dim: int,
        threshold: float,
        weights_path: Optional[str] = None,
        encoding_dim: int = 4,
        hidden_dim: int = 16,
        device: Optional[str] = None,
    ):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.net = AutoencoderNet(input_dim, encoding_dim, hidden_dim).to(self.device)
        self.threshold = threshold

        if weights_path:
            self.net.load_state_dict(torch.load(weights_path, map_location=self.device))
        self.net.eval()

    def reconstruction_error(self, X: np.ndarray) -> np.ndarray:
        """Per-sample MSE reconstruction error — the raw anomaly score."""
        self.net.eval()
        with torch.no_grad():
            X_t = torch.tensor(X, dtype=torch.float32).to(self.device)
            recon = self.net(X_t)
            errors = torch.mean((recon - X_t) ** 2, dim=1)
        return errors.cpu().numpy()

    def predict_anomaly(self, X: np.ndarray) -> np.ndarray:
        """Boolean array: True where reconstruction error exceeds the calibrated threshold."""
        return self.reconstruction_error(X) > self.threshold

    def normalized_score(self, X: np.ndarray) -> np.ndarray:
        """Maps raw reconstruction error to a 0-1 severity score relative to the threshold."""
        errors = self.reconstruction_error(X)
        return np.clip(errors / (2 * self.threshold), 0.0, 1.0)


# ---------------------------------------------------------------------------
# EXPLAINABILITY
# ---------------------------------------------------------------------------
class SHAP_Explainer:
    """
    Produces SHAP-based feature attributions for the autoencoder's
    reconstruction error, so the frontend can display *why* a reading
    was flagged as a hazard.
    """

    def __init__(
        self,
        model: ProductionAutoencoder,
        background_data: np.ndarray,
        feature_names: List[str],
        max_background: int = 50,
    ):
        self.model = model
        self.feature_names = feature_names

        background_sample = background_data
        if len(background_data) > max_background:
            idx = np.random.choice(len(background_data), max_background, replace=False)
            background_sample = background_data[idx]

        self.explainer = shap.KernelExplainer(self._score_fn, background_sample)

    def _score_fn(self, X: np.ndarray) -> np.ndarray:
        return self.model.reconstruction_error(X)

    def top_contributing_features(self, x_instance: np.ndarray, top_n: int = 3) -> List[str]:
        x_instance = x_instance.reshape(1, -1)
        shap_values = np.array(self.explainer.shap_values(x_instance, nsamples=100)).flatten()
        ranked = sorted(zip(self.feature_names, shap_values), key=lambda pair: abs(pair[1]), reverse=True)
        return [FEATURE_DISPLAY_NAMES.get(name, name) for name, _ in ranked[:top_n]]


# ---------------------------------------------------------------------------
# MASTER INFERENCE FUNCTION (frontend contract)
# ---------------------------------------------------------------------------
def run_live_inference(
    live_data_df: pd.DataFrame,
    pipeline: WeatherDataPipeline,
    model: ProductionAutoencoder,
    explainer: Optional[SHAP_Explainer] = None,
    top_n_factors: int = 3,
) -> Dict[str, Any]:
    """
    Master orchestration function called by the frontend integration layer.

    Steps:
      1. Scale incoming live data using the already-fitted pipeline.
      2. Run the autoencoder to get a reconstruction-error anomaly score.
      3. If flagged as an anomaly, run SHAP to extract top contributing features.
      4. Return a strictly formatted dictionary.

    Returns:
        {
            "status": "Hazard" | "Normal",
            "anomaly_score": float,          # 0.0 - 1.0
            "trigger_factors": List[str],    # empty list when status == "Normal"
        }
    """
    if live_data_df.empty:
        return {"status": "Normal", "anomaly_score": 0.0, "trigger_factors": []}

    X_scaled = pipeline.preprocess(live_data_df)

    # Single-reading live inference (loop this function for batch use cases)
    instance = X_scaled[0]
    is_anomaly = bool(model.predict_anomaly(X_scaled)[0])
    score = float(model.normalized_score(X_scaled)[0])

    trigger_factors: List[str] = []
    if is_anomaly and explainer is not None:
        trigger_factors = explainer.top_contributing_features(instance, top_n=top_n_factors)

    return {
        "status": "Hazard" if is_anomaly else "Normal",
        "anomaly_score": round(score, 4),
        "trigger_factors": trigger_factors,
    }


# ---------------------------------------------------------------------------
# Example wiring / smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # Demonstrates the wiring only. In production, load calibrated weights +
    # threshold produced offline by model_experiments.py instead of this
    # randomly-initialized network.

    np.random.seed(0)
    reference_data = pd.DataFrame({
        "temperature_2m": np.random.normal(22, 4, 500),
        "relative_humidity_2m": np.random.normal(55, 12, 500),
        "pressure_msl": np.random.normal(1013, 6, 500),
        "wind_speed_10m": np.random.normal(12, 5, 500),
        "wind_gusts_10m": np.random.normal(18, 7, 500),
        "precipitation": np.abs(np.random.normal(0.5, 1.0, 500)),
        "cloud_cover": np.random.uniform(0, 100, 500),
    })

    pipeline = WeatherDataPipeline(latitude=40.71, longitude=-74.0)
    pipeline.fit_scaler(reference_data)
    X_ref = pipeline.preprocess(reference_data)

    engine = ProductionAutoencoder(input_dim=X_ref.shape[1], threshold=0.5)
    explainer = SHAP_Explainer(engine, background_data=X_ref, feature_names=pipeline.feature_columns)

    hazard_reading = pd.DataFrame([{
        "temperature_2m": 41.0,
        "relative_humidity_2m": 12.0,
        "pressure_msl": 970.0,
        "wind_speed_10m": 95.0,
        "wind_gusts_10m": 140.0,
        "precipitation": 60.0,
        "cloud_cover": 90.0,
    }])

    result = run_live_inference(hazard_reading, pipeline, engine, explainer)
    print(result)

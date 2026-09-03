"""
SkyGuard AI - Model Experimentation Suite
===========================================
Implements and benchmarks three anomaly detection architectures against
weather telemetry sourced from the Open-Meteo API:

    1. TelemetryIsolationForest  (scikit-learn)
    2. TelemetryOneClassSVM      (scikit-learn)
    3. TelemetryAutoencoder      (PyTorch)

Run this file directly to train all three on synthetic data and compare
execution time + detection performance.
"""

import time
import warnings
from typing import List, Optional

import numpy as np
import pandas as pd
import requests

from sklearn.ensemble import IsolationForest
from sklearn.svm import OneClassSVM
from sklearn.preprocessing import StandardScaler

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

warnings.filterwarnings("ignore")

# Default telemetry fields pulled from Open-Meteo
FEATURE_COLUMNS = [
    "temperature_2m",
    "relative_humidity_2m",
    "pressure_msl",
    "wind_speed_10m",
    "wind_gusts_10m",
    "precipitation",
    "cloud_cover",
]


# ---------------------------------------------------------------------------
# 1. DATA PIPELINE
# ---------------------------------------------------------------------------
class WeatherDataPipeline:
    """
    Handles fetching (historical + live) and preprocessing of weather
    telemetry from the Open-Meteo API.
    """

    BASE_HISTORICAL_URL = "https://archive-api.open-meteo.com/v1/archive"
    BASE_LIVE_URL = "https://api.open-meteo.com/v1/forecast"

    def __init__(self, latitude: float, longitude: float, feature_columns: Optional[List[str]] = None):
        self.latitude = latitude
        self.longitude = longitude
        self.feature_columns = feature_columns or FEATURE_COLUMNS
        self.scaler = StandardScaler()
        self._is_fitted = False

    # -- Fetching -------------------------------------------------------
    def fetch_historical(self, start_date: str, end_date: str) -> pd.DataFrame:
        """Fetch historical hourly weather data for training. Dates as 'YYYY-MM-DD'."""
        params = {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "start_date": start_date,
            "end_date": end_date,
            "hourly": ",".join(self.feature_columns),
            "timezone": "UTC",
        }
        try:
            resp = requests.get(self.BASE_HISTORICAL_URL, params=params, timeout=15)
            resp.raise_for_status()
            payload = resp.json()
            df = pd.DataFrame(payload["hourly"])
            df["time"] = pd.to_datetime(df["time"])
            return df
        except (requests.RequestException, KeyError, ValueError) as exc:
            print(f"[WeatherDataPipeline] Historical fetch failed: {exc}")
            return pd.DataFrame(columns=["time"] + self.feature_columns)

    def fetch_live(self) -> pd.DataFrame:
        """Fetch current/live weather telemetry."""
        params = {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "current": ",".join(self.feature_columns),
            "timezone": "UTC",
        }
        try:
            resp = requests.get(self.BASE_LIVE_URL, params=params, timeout=15)
            resp.raise_for_status()
            payload = resp.json()
            current = payload["current"]
            df = pd.DataFrame([current])
            df["time"] = pd.to_datetime(df["time"])
            return df
        except (requests.RequestException, KeyError, ValueError) as exc:
            print(f"[WeatherDataPipeline] Live fetch failed: {exc}")
            return pd.DataFrame(columns=["time"] + self.feature_columns)

    # -- Preprocessing ----------------------------------------------------
    def preprocess(self, df: pd.DataFrame, fit: bool = False) -> np.ndarray:
        """
        Cleans and scales a raw dataframe into a model-ready numpy array.

        Args:
            df:  Raw dataframe containing feature_columns (extra columns ignored).
            fit: If True, fits the internal StandardScaler (use for training data).
                 If False, reuses the already-fitted scaler (use for inference).
        """
        working = df.copy()

        # Guarantee every expected column exists, even if the API omitted one
        for col in self.feature_columns:
            if col not in working.columns:
                working[col] = np.nan
        working = working[self.feature_columns]

        # NaN handling: interpolate -> median fill -> zero fallback
        working = working.interpolate(method="linear", limit_direction="both")
        working = working.fillna(working.median(numeric_only=True))
        working = working.fillna(0.0)

        if fit:
            scaled = self.scaler.fit_transform(working.values)
            self._is_fitted = True
        else:
            if not self._is_fitted:
                raise RuntimeError(
                    "Scaler is not fitted yet. Call preprocess(df, fit=True) on training data first."
                )
            scaled = self.scaler.transform(working.values)

        return scaled


# ---------------------------------------------------------------------------
# 2a. MODEL: ISOLATION FOREST
# ---------------------------------------------------------------------------
class TelemetryIsolationForest:
    """Tree-based anomaly detector. Fast, robust to non-Gaussian data."""

    def __init__(self, contamination: float = 0.05, n_estimators: int = 200, random_state: int = 42):
        self.model = IsolationForest(
            contamination=contamination,
            n_estimators=n_estimators,
            random_state=random_state,
        )

    def fit(self, X: np.ndarray) -> "TelemetryIsolationForest":
        self.model.fit(X)
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Returns 1 for normal, -1 for anomaly (sklearn convention)."""
        return self.model.predict(X)

    def score(self, X: np.ndarray) -> np.ndarray:
        """Higher score = more anomalous."""
        return -self.model.score_samples(X)


# ---------------------------------------------------------------------------
# 2b. MODEL: ONE-CLASS SVM
# ---------------------------------------------------------------------------
class TelemetryOneClassSVM:
    """Boundary-based anomaly detector using an RBF kernel."""

    def __init__(self, nu: float = 0.05, kernel: str = "rbf", gamma: str = "scale"):
        self.model = OneClassSVM(nu=nu, kernel=kernel, gamma=gamma)

    def fit(self, X: np.ndarray) -> "TelemetryOneClassSVM":
        self.model.fit(X)
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Returns 1 for normal, -1 for anomaly (sklearn convention)."""
        return self.model.predict(X)

    def score(self, X: np.ndarray) -> np.ndarray:
        """Higher score = more anomalous."""
        return -self.model.decision_function(X)


# ---------------------------------------------------------------------------
# 2c. MODEL: PYTORCH AUTOENCODER
# ---------------------------------------------------------------------------
class AutoencoderNet(nn.Module):
    """Compact feed-forward autoencoder tuned for low-dimensional tabular telemetry."""

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


class TelemetryAutoencoder:
    """
    Reconstruction-error based anomaly detector. Learns to reconstruct
    'normal' telemetry; readings that reconstruct poorly are flagged.
    """

    def __init__(
        self,
        input_dim: int,
        encoding_dim: int = 4,
        hidden_dim: int = 16,
        lr: float = 1e-3,
        epochs: int = 50,
        batch_size: int = 32,
        contamination: float = 0.05,
        device: Optional[str] = None,
    ):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model = AutoencoderNet(input_dim, encoding_dim, hidden_dim).to(self.device)
        self.lr = lr
        self.epochs = epochs
        self.batch_size = batch_size
        self.contamination = contamination
        self.threshold_: Optional[float] = None

    def fit(self, X: np.ndarray) -> "TelemetryAutoencoder":
        X_t = torch.tensor(X, dtype=torch.float32)
        loader = DataLoader(TensorDataset(X_t, X_t), batch_size=self.batch_size, shuffle=True)
        optimizer = optim.Adam(self.model.parameters(), lr=self.lr)
        criterion = nn.MSELoss()

        self.model.train()
        for _ in range(self.epochs):
            for batch_x, _ in loader:
                batch_x = batch_x.to(self.device)
                optimizer.zero_grad()
                recon = self.model(batch_x)
                loss = criterion(recon, batch_x)
                loss.backward()
                optimizer.step()

        # Calibrate the anomaly threshold from the training error distribution
        train_errors = self._reconstruction_error(X)
        self.threshold_ = float(np.quantile(train_errors, 1 - self.contamination))
        return self

    def _reconstruction_error(self, X: np.ndarray) -> np.ndarray:
        self.model.eval()
        with torch.no_grad():
            X_t = torch.tensor(X, dtype=torch.float32).to(self.device)
            recon = self.model(X_t)
            errors = torch.mean((recon - X_t) ** 2, dim=1)
        return errors.cpu().numpy()

    def score(self, X: np.ndarray) -> np.ndarray:
        """Higher score = more anomalous (raw reconstruction MSE)."""
        return self._reconstruction_error(X)

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Returns 1 for normal, -1 for anomaly (matches sklearn convention)."""
        errors = self.score(X)
        return np.where(errors > self.threshold_, -1, 1)


# ---------------------------------------------------------------------------
# 3. TRAIN / COMPARE ON SYNTHETIC DATA
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    np.random.seed(42)

    n_samples = 2000
    n_anomalies = 100

    # "Normal" weather distribution
    normal_data = pd.DataFrame({
        "temperature_2m": np.random.normal(22, 4, n_samples),
        "relative_humidity_2m": np.random.normal(55, 12, n_samples),
        "pressure_msl": np.random.normal(1013, 6, n_samples),
        "wind_speed_10m": np.random.normal(12, 5, n_samples),
        "wind_gusts_10m": np.random.normal(18, 7, n_samples),
        "precipitation": np.abs(np.random.normal(0.5, 1.0, n_samples)),
        "cloud_cover": np.random.uniform(0, 100, n_samples),
    })

    # Injected extreme / hazardous readings
    anomaly_data = pd.DataFrame({
        "temperature_2m": np.random.uniform(-15, 48, n_anomalies),
        "relative_humidity_2m": np.random.uniform(0, 100, n_anomalies),
        "pressure_msl": np.random.uniform(950, 1050, n_anomalies),
        "wind_speed_10m": np.random.uniform(60, 150, n_anomalies),
        "wind_gusts_10m": np.random.uniform(90, 200, n_anomalies),
        "precipitation": np.random.uniform(30, 100, n_anomalies),
        "cloud_cover": np.random.uniform(0, 100, n_anomalies),
    })

    ground_truth = np.array([1] * n_samples + [-1] * n_anomalies)  # 1=normal, -1=anomaly
    full_df = pd.concat([normal_data, anomaly_data], ignore_index=True)

    shuffle_idx = np.random.permutation(len(full_df))
    full_df = full_df.iloc[shuffle_idx].reset_index(drop=True)
    ground_truth = ground_truth[shuffle_idx]

    # Preprocess through the pipeline (lat/lon unused here since we're not fetching)
    pipeline = WeatherDataPipeline(latitude=40.71, longitude=-74.0, feature_columns=list(full_df.columns))
    X = pipeline.preprocess(full_df, fit=True)

    contamination_rate = n_anomalies / (n_samples + n_anomalies)

    models = {
        "IsolationForest": TelemetryIsolationForest(contamination=contamination_rate),
        "OneClassSVM": TelemetryOneClassSVM(nu=contamination_rate),
        "Autoencoder": TelemetryAutoencoder(
            input_dim=X.shape[1], contamination=contamination_rate, epochs=30
        ),
    }

    print(f"{'Model':<20}{'Train (s)':<14}{'Inference (s)':<16}{'Flagged':<12}{'Recall vs Truth':<18}")
    print("-" * 80)

    results = {}
    true_anomaly_mask = ground_truth == -1

    for name, model in models.items():
        t0 = time.time()
        model.fit(X)
        train_time = time.time() - t0

        t1 = time.time()
        preds = model.predict(X)
        infer_time = time.time() - t1

        flagged = int(np.sum(preds == -1))
        recall = np.sum(preds[true_anomaly_mask] == -1) / true_anomaly_mask.sum()

        results[name] = {
            "train_time": train_time,
            "infer_time": infer_time,
            "flagged": flagged,
            "recall": recall,
        }

        print(f"{name:<20}{train_time:<14.4f}{infer_time:<16.4f}{flagged:<12}{recall:<18.2%}")

    best_model = max(results.items(), key=lambda kv: kv[1]["recall"])
    print(f"\nBest performing model by recall against injected anomalies: {best_model[0]}")

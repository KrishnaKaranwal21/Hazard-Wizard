"""
Run once (locally or in CI) to produce the artifacts main.py loads at startup:
  weights/autoencoder.pt, weights/scaler.pkl, weights/threshold.txt, weights/background.npy
"""
import numpy as np
import torch
import joblib

from model_experiments import WeatherDataPipeline, TelemetryAutoencoder

# Point this at real coordinates you want the model calibrated against.
pipeline = WeatherDataPipeline(latitude=19.0760, longitude=72.8777)
historical = pipeline.fetch_historical("2024-01-01", "2025-01-01")
X = pipeline.preprocess(historical, fit=True)

model = TelemetryAutoencoder(input_dim=X.shape[1], epochs=50)
model.fit(X)

import os
os.makedirs("weights", exist_ok=True)
torch.save(model.model.state_dict(), "weights/autoencoder.pt")
joblib.dump(pipeline.scaler, "weights/scaler.pkl")
with open("weights/threshold.txt", "w") as f:
    f.write(str(model.threshold_))
np.save("weights/background.npy", X[np.random.choice(len(X), min(50, len(X)), replace=False)])

print("Saved model artifacts to weights/")

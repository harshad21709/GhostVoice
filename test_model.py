import torch
import librosa
from transformers import AutoFeatureExtractor, AutoModelForAudioClassification
from pathlib import Path

MODEL = next(
    Path(
        r"D:\GhostVoice\GhostVoice-3\HFCache\hub\models--garystafford--wav2vec2-deepfake-voice-detector\snapshots"
    ).iterdir()
)

# CHANGE THIS TO YOUR ACTUAL AI RECORDING
AUDIO = r"D:\GhostVoice\GhostVoice-3\.venv\Lib\site-packages\scipy\io\tests\data\test-44100Hz-le-1ch-4bytes-rf64.wav"

print("Model:", MODEL)
print("Audio:", AUDIO)

audio, sr = librosa.load(
    AUDIO,
    sr=16000,
    mono=True,
)

print("Sample rate:", sr)
print("Samples:", len(audio))
print("Duration:", len(audio) / 16000, "seconds")

if len(audio) < 16000:
    raise RuntimeError(
        f"Audio is only {len(audio)/16000:.2f} seconds long. "
        "Provide a recording of at least 1 second."
    )

# Use exactly 4 seconds when available.
target = 16000 * 4

if len(audio) >= target:
    audio = audio[:target]
else:
    # Pad short recordings.
    audio = torch.tensor(audio, dtype=torch.float32)
    audio = torch.nn.functional.pad(
        audio,
        (0, target - len(audio)),
    ).numpy()

print("Input samples:", len(audio))
print("Input duration:", len(audio) / 16000, "seconds")

processor = AutoFeatureExtractor.from_pretrained(
    str(MODEL),
    local_files_only=True,
)

model = AutoModelForAudioClassification.from_pretrained(
    str(MODEL),
    local_files_only=True,
).eval()

inputs = processor(
    audio,
    sampling_rate=16000,
    return_tensors="pt",
)

print("Running model...")

with torch.inference_mode():
    logits = model(**inputs).logits
    probabilities = torch.softmax(
        logits,
        dim=-1,
    )[0]

real_probability = float(probabilities[0])
fake_probability = float(probabilities[1])

prediction = int(
    torch.argmax(probabilities)
)

print()
print("==============================")
print("GHOSTVOICE RAW MODEL RESULT")
print("==============================")
print(f"REAL: {real_probability:.4f}")
print(f"FAKE: {fake_probability:.4f}")
print(
    "LABEL:",
    model.config.id2label[prediction],
)
print("==============================")
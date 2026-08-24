import os
import random
from pathlib import Path

import numpy as np
import torch

from datasets import Audio, concatenate_datasets, load_dataset

from sklearn.metrics import (
    accuracy_score,
    precision_recall_fscore_support,
    roc_auc_score,
)

from transformers import (
    AutoFeatureExtractor,
    AutoModelForAudioClassification,
    Trainer,
    TrainingArguments,
)


# ============================================================
# CONFIGURATION
# ============================================================

BASE_MODEL = os.getenv(
    "BASE_MODEL",
    "garystafford/wav2vec2-deepfake-voice-detector",
)

OUTPUT_DIR = Path(
    os.getenv(
        "MODEL_OUTPUT",
        "./models/ghostvoice_detector",
    )
)

SAMPLE_RATE = int(
    os.getenv(
        "TRAINING_SAMPLE_RATE",
        "16000",
    )
)

CLIP_SECONDS = int(
    os.getenv(
        "TRAINING_SECONDS",
        "4",
    )
)

MAX_LENGTH = (
    SAMPLE_RATE *
    CLIP_SECONDS
)

EPOCHS = int(
    os.getenv(
        "TRAIN_EPOCHS",
        "10",
    )
)

BATCH_SIZE = int(
    os.getenv(
        "TRAIN_BATCH_SIZE",
        "4",
    )
)

GRADIENT_ACCUMULATION = int(
    os.getenv(
        "TRAIN_GRADIENT_ACCUMULATION",
        "4",
    )
)

LEARNING_RATE = float(
    os.getenv(
        "TRAIN_LEARNING_RATE",
        "0.00002",
    )
)

WEIGHT_DECAY = float(
    os.getenv(
        "TRAIN_WEIGHT_DECAY",
        "0.01",
    )
)

SEED = int(
    os.getenv(
        "SEED",
        "42",
    )
)


# ============================================================
# REPRODUCIBILITY
# ============================================================

random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)

if torch.cuda.is_available():
    torch.cuda.manual_seed_all(SEED)


# ============================================================
# DATASETS
# ============================================================

DATASETS = [
    {
        "name": "SpeechAntiSpoofingBenchmarks/ASVspoof2019_LA",
        "split": "train",
    },

    {
        "name": "SpeechAntiSpoofingBenchmarks/ASVspoof2021_LA",
        "split": "train",
    },

    {
        "name": "mueller91/MLAAD",
        "split": "train",
    },
]


# ============================================================
# HELPERS
# ============================================================

def print_header(text):

    print()
    print("=" * 75)
    print(text)
    print("=" * 75)
    print()


def find_audio_column(dataset):

    candidates = [
        "audio",
        "Audio",
        "speech",
        "wav",
        "waveform",
    ]

    for column in candidates:

        if column in dataset.column_names:
            return column

    raise RuntimeError(
        "Could not find an audio column.\n"
        f"Columns: {dataset.column_names}"
    )


def find_label_column(dataset):

    candidates = [
        "label",
        "labels",
        "class",
        "target",
        "category",
    ]

    for column in candidates:

        if column in dataset.column_names:
            return column

    raise RuntimeError(
        "Could not find a label column.\n"
        f"Columns: {dataset.column_names}"
    )


def normalize_label(value):

    if isinstance(
        value,
        (int, np.integer),
    ):

        value = int(value)

        if value in (0, 1):
            return value


    text = str(
        value
    ).strip().lower()


    human = {
        "0",
        "real",
        "human",
        "bonafide",
        "bona_fide",
        "bona-fide",
        "genuine",
        "authentic",
        "natural",
    }


    fake = {
        "1",
        "fake",
        "spoof",
        "ai",
        "synthetic",
        "deepfake",
        "generated",
        "artificial",
        "converted",
        "manipulated",
    }


    if text in human:
        return 0


    if text in fake:
        return 1


    raise ValueError(
        f"Unknown audio label: {value!r}"
    )


def normalize_example(
    example,
    label_column,
):

    example["labels"] = normalize_label(
        example[label_column]
    )

    return example


# ============================================================
# LOAD DATASETS
# ============================================================

print_header(
    "GHOSTVOICE MULTI-DATASET TRAINING"
)

print(
    "Base model:",
    BASE_MODEL,
)

print(
    "Device:",
    "CUDA" if torch.cuda.is_available()
    else "CPU",
)

print(
    "Datasets:",
    len(DATASETS),
)


loaded = []


for config in DATASETS:

    name = config["name"]
    split = config["split"]

    print()
    print(
        f"Loading: {name}"
    )

    try:

        ds = load_dataset(
            name,
            split=split,
        )

        print(
            f"Loaded {len(ds):,} samples"
        )

        loaded.append(ds)

    except Exception as exc:

        print(
            f"WARNING: Could not load {name}"
        )

        print(
            repr(exc)
        )

        print(
            "Skipping this dataset."
        )


if not loaded:

    raise RuntimeError(
        "No datasets could be loaded."
    )


# ============================================================
# NORMALIZE EACH DATASET
# ============================================================

normalized = []


for ds in loaded:

    audio_column = find_audio_column(
        ds
    )

    label_column = find_label_column(
        ds
    )

    print()
    print(
        "Audio column:",
        audio_column,
    )

    print(
        "Label column:",
        label_column,
    )


    if audio_column != "audio":

        ds = ds.rename_column(
            audio_column,
            "audio",
        )


    ds = ds.map(
        lambda x: normalize_example(
            x,
            label_column,
        ),
        desc="Normalizing labels",
    )


    ds = ds.cast_column(
        "audio",
        Audio(
            sampling_rate=SAMPLE_RATE
        ),
    )


    normalized.append(
        ds
    )


# ============================================================
# COMBINE DATASETS
# ============================================================

print_header(
    "COMBINING DATASETS"
)


combined = concatenate_datasets(
    normalized
)


print(
    f"Combined dataset: {len(combined):,}"
)


# ============================================================
# REMOVE INVALID LABELS
# ============================================================

def valid_label(example):

    return example["labels"] in (
        0,
        1,
    )


combined = combined.filter(
    valid_label,
    desc="Removing invalid labels",
)


# ============================================================
# BALANCE DATASET
# ============================================================

print_header(
    "BALANCING DATA"
)


labels = np.asarray(
    combined["labels"],
    dtype=np.int64,
)


human_indices = np.where(
    labels == 0
)[0]


fake_indices = np.where(
    labels == 1
)[0]


print(
    f"Human samples: {len(human_indices):,}"
)

print(
    f"AI samples:    {len(fake_indices):,}"
)


if len(human_indices) == 0:

    raise RuntimeError(
        "No human samples found."
    )


if len(fake_indices) == 0:

    raise RuntimeError(
        "No AI samples found."
    )


target_size = min(
    len(human_indices),
    len(fake_indices),
)


rng = np.random.default_rng(
    SEED
)


human_indices = rng.choice(
    human_indices,
    target_size,
    replace=False,
)


fake_indices = rng.choice(
    fake_indices,
    target_size,
    replace=False,
)


selected_indices = np.concatenate(
    [
        human_indices,
        fake_indices,
    ]
)


rng.shuffle(
    selected_indices
)


combined = combined.select(
    selected_indices.tolist()
)


print(
    f"Balanced dataset: {len(combined):,}"
)


# ============================================================
# TRAIN / VALIDATION SPLIT
# ============================================================

split = combined.train_test_split(
    test_size=0.15,
    seed=SEED,
    stratify_by_column="labels",
)


train_dataset = split["train"]
validation_dataset = split["test"]


print(
    f"Training:   {len(train_dataset):,}"
)

print(
    f"Validation: {len(validation_dataset):,}"
)


# ============================================================
# PROCESSOR
# ============================================================

print_header(
    "LOADING FEATURE EXTRACTOR"
)


processor = (
    AutoFeatureExtractor.from_pretrained(
        BASE_MODEL
    )
)


# ============================================================
# AUDIO PROCESSING
# ============================================================

def crop_or_pad(
    waveform,
    training=False,
):

    waveform = np.asarray(
        waveform,
        dtype=np.float32,
    )


    if waveform.size == 0:

        return np.zeros(
            MAX_LENGTH,
            dtype=np.float32,
        )


    if len(waveform) > MAX_LENGTH:

        if training:

            start = np.random.randint(
                0,
                len(waveform) - MAX_LENGTH + 1,
            )

        else:

            start = (
                len(waveform)
                - MAX_LENGTH
            ) // 2


        waveform = waveform[
            start:
            start + MAX_LENGTH
        ]


    elif len(waveform) < MAX_LENGTH:

        padding = (
            MAX_LENGTH
            - len(waveform)
        )


        left = padding // 2
        right = padding - left


        waveform = np.pad(
            waveform,
            (
                left,
                right,
            ),
        )


    return waveform


# ============================================================
# AUGMENTATION
# ============================================================

def augment_audio(
    waveform
):

    waveform = waveform.copy()


    # Gain augmentation
    if np.random.random() < 0.5:

        gain_db = np.random.uniform(
            -5,
            5,
        )

        gain = (
            10 **
            (gain_db / 20)
        )

        waveform *= gain


    # Noise augmentation
    if np.random.random() < 0.30:

        rms = np.sqrt(
            np.mean(
                waveform ** 2
            )
            + 1e-8
        )


        noise_level = np.random.uniform(
            0.001,
            0.01,
        )


        noise = (
            np.random.randn(
                len(waveform)
            )
            .astype(
                np.float32
            )
            * rms
            * noise_level
        )


        waveform += noise


    # Random polarity inversion
    if np.random.random() < 0.05:

        waveform *= -1


    return np.clip(
        waveform,
        -1.0,
        1.0,
    )


# ============================================================
# ENCODE TRAINING DATA
# ============================================================

def encode_train(
    example
):

    waveform = crop_or_pad(
        example["audio"]["array"],
        training=True,
    )


    waveform = augment_audio(
        waveform
    )


    result = processor(
        waveform,
        sampling_rate=SAMPLE_RATE,
        max_length=MAX_LENGTH,
        truncation=True,
    )


    result["labels"] = int(
        example["labels"]
    )


    return result


def encode_validation(
    example
):

    waveform = crop_or_pad(
        example["audio"]["array"],
        training=False,
    )


    result = processor(
        waveform,
        sampling_rate=SAMPLE_RATE,
        max_length=MAX_LENGTH,
        truncation=True,
    )


    result["labels"] = int(
        example["labels"]
    )


print_header(
    "ENCODING AUDIO"
)


train_encoded = train_dataset.map(
    encode_train,
    remove_columns=train_dataset.column_names,
    desc="Encoding training audio",
)


validation_encoded = validation_dataset.map(
    encode_validation,
    remove_columns=validation_dataset.column_names,
    desc="Encoding validation audio",
)


# ============================================================
# MODEL
# ============================================================

print_header(
    "LOADING MODEL"
)


model = (
    AutoModelForAudioClassification
    .from_pretrained(
        BASE_MODEL,
        num_labels=2,
        label2id={
            "HUMAN": 0,
            "AI_GENERATED": 1,
        },
        id2label={
            0: "HUMAN",
            1: "AI_GENERATED",
        },
        ignore_mismatched_sizes=True,
    )
)


# ============================================================
# METRICS
# ============================================================

def compute_metrics(
    evaluation
):

    logits = evaluation.predictions

    labels = evaluation.label_ids


    probabilities = torch.softmax(
        torch.tensor(
            logits
        ),
        dim=-1,
    ).numpy()


    predictions = np.argmax(
        probabilities,
        axis=-1,
    )


    precision, recall, f1, _ = (
        precision_recall_fscore_support(
            labels,
            predictions,
            average="binary",
            zero_division=0,
        )
    )


    accuracy = accuracy_score(
        labels,
        predictions,
    )


    try:

        auc = roc_auc_score(
            labels,
            probabilities[:, 1],
        )

    except ValueError:

        auc = 0.0


    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "roc_auc": auc,
    }


# ============================================================
# TRAINING
# ============================================================

training_args = TrainingArguments(

    output_dir=str(
        OUTPUT_DIR
    ),

    eval_strategy="epoch",

    save_strategy="epoch",

    learning_rate=LEARNING_RATE,

    per_device_train_batch_size=BATCH_SIZE,

    per_device_eval_batch_size=BATCH_SIZE,

    gradient_accumulation_steps=(
        GRADIENT_ACCUMULATION
    ),

    num_train_epochs=EPOCHS,

    warmup_ratio=0.10,

    weight_decay=WEIGHT_DECAY,

    logging_steps=25,

    save_total_limit=3,

    load_best_model_at_end=True,

    metric_for_best_model="roc_auc",

    greater_is_better=True,

    fp16=torch.cuda.is_available(),

    report_to="none",

    seed=SEED,

    gradient_checkpointing=True,
)


trainer = Trainer(

    model=model,

    args=training_args,

    train_dataset=train_encoded,

    eval_dataset=validation_encoded,

    processing_class=processor,

    compute_metrics=compute_metrics,
)


# ============================================================
# TRAIN
# ============================================================

print_header(
    "STARTING GHOSTVOICE TRAINING"
)


trainer.train()


# ============================================================
# FINAL EVALUATION
# ============================================================

print_header(
    "FINAL VALIDATION"
)


metrics = trainer.evaluate()


for key, value in metrics.items():

    print(
        f"{key}: {value}"
    )


# ============================================================
# SAVE
# ============================================================

print_header(
    "SAVING MODEL"
)


OUTPUT_DIR.mkdir(
    parents=True,
    exist_ok=True,
)


trainer.save_model(
    str(OUTPUT_DIR)
)


processor.save_pretrained(
    str(OUTPUT_DIR)
)


print(
    "Model saved to:"
)

print(
    OUTPUT_DIR.resolve()
)


print()
print(
    "GHOSTVOICE TRAINING COMPLETE."
)
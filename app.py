import base64
import hashlib
import io
import math
import os
import re
import secrets
import smtplib
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

import jwt
import librosa
import numpy as np
import soundfile as sf
import torch
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


class Settings(BaseSettings):
    app_env: str = "development"
    base_model: str = "garystafford/wav2vec2-deepfake-voice-detector"
    database_url: str = "sqlite:///./data/ghostvoice.db"
    storage_dir: str = "./data/encrypted"
    voice_encryption_key: str
    jwt_secret: str
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    app_base_url: str = "http://localhost:8000"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    app_base_url: str = "http://localhost:8000"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    app_base_url: str = "http://localhost:8000"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    app_base_url: str = "http://localhost:8000"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    app_base_url: str = "http://localhost:8000"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    app_base_url: str = "http://localhost:8000"
    ffmpeg_bin: str = "ffmpeg"
    max_upload_mb: int = 200
    max_seconds: int = 180
    max_windows: int = 30
    window_seconds: float = 4.0
    hop_seconds: float = 2.0
    base_weight: float = 0.85
    spectral_weight: float = 0.15
    uncertain_low: float = 0.30
    uncertain_high: float = 0.70
    allowed_origins: str = "https://localhost:8443,https://127.0.0.1:8443,http://localhost:8000,http://127.0.0.1:8000"
    cookie_secure: bool = True
    cookie_samesite: str = "strict"
    access_token_minutes: int = 60
    rate_limit_auth: str = "10/minute"
    rate_limit_analyze: str = "20/minute"

    model_config = SettingsConfigDict(env_file=str(BASE_DIR / ".env"), extra="ignore")

    @property
    def origins(self):
        return [item.strip() for item in self.allowed_origins.split(",") if item.strip()]


s = Settings()

storage_path = Path(s.storage_dir)
STORAGE_DIR = storage_path if storage_path.is_absolute() else (BASE_DIR / storage_path).resolve()
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

database_url = s.database_url
if database_url.startswith("sqlite:///./"):
    database_path = (BASE_DIR / database_url[len("sqlite:///./"):]).resolve()
    database_path.parent.mkdir(parents=True, exist_ok=True)
    database_url = f"sqlite:///{database_path.as_posix()}"

engine = create_engine(database_url, connect_args={"check_same_thread": False} if database_url.startswith("sqlite:") else {})
Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    email: Mapped[str | None] = mapped_column(String(320), unique=True, nullable=True, index=True)


class Recording(Base):
    __tablename__ = "recordings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_id: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    duration: Mapped[float] = mapped_column(Float)
    verdict: Mapped[str] = mapped_column(String(32))
    ai_probability: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class PasswordReset(Base):
    __tablename__ = "password_resets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class Audit(Base):
    __tablename__ = "audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(80))
    detail: Mapped[str] = mapped_column(Text, default="", nullable=False)
    ip: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


Base.metadata.create_all(engine)


def ensure_schema():
    """Apply the small SQLite migrations needed by newer GhostVoice builds."""
    if not database_url.startswith("sqlite:"):
        return
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(users)").fetchall()}
        if "email" not in cols:
            conn.exec_driver_sql("ALTER TABLE users ADD COLUMN email VARCHAR(320)")
        conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email_unique ON users(email) WHERE email IS NOT NULL")


ensure_schema()

if database_url.startswith("sqlite:"):
    with engine.begin() as connection:
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(users)").fetchall()}
        if "email" not in columns:
            connection.exec_driver_sql("ALTER TABLE users ADD COLUMN email VARCHAR(320)")
        connection.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email_unique ON users(email) WHERE email IS NOT NULL")

ph = PasswordHasher()


def db():
    return Session()


def master_key() -> bytes:
    try:
        key = base64.urlsafe_b64decode(s.voice_encryption_key)
    except Exception as exc:
        raise RuntimeError("VOICE_ENCRYPTION_KEY is not valid base64") from exc
    if len(key) != 32:
        raise RuntimeError("VOICE_ENCRYPTION_KEY must decode to exactly 32 bytes")
    return key


MASTER_KEY = master_key()


def user_key(user_id: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=f"ghostvoice:v3:{user_id}".encode()).derive(MASTER_KEY)


def encrypted_store(data: bytes, user_id: int) -> str:
    file_id = secrets.token_urlsafe(20)
    nonce = secrets.token_bytes(12)
    aad = b"GV3" + str(user_id).encode()
    ciphertext = AESGCM(user_key(user_id)).encrypt(nonce, data, aad)
    (STORAGE_DIR / f"{file_id}.enc").write_bytes(b"GV3" + nonce + ciphertext)
    return file_id


def encrypted_read(file_id: str, user_id: int) -> bytes:
    raw = (STORAGE_DIR / f"{file_id}.enc").read_bytes()
    if len(raw) < 16 or raw[:3] != b"GV3":
        raise ValueError("Invalid encrypted recording")
    return AESGCM(user_key(user_id)).decrypt(raw[3:15], raw[15:], b"GV3" + str(user_id).encode())


def encrypted_delete(file_id: str) -> None:
    path = STORAGE_DIR / f"{file_id}.enc"
    if path.exists():
        path.unlink()


def make_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(user_id), "iat": int(now.timestamp()), "exp": int((now + timedelta(minutes=s.access_token_minutes)).timestamp()), "jti": secrets.token_urlsafe(16)}, s.jwt_secret, algorithm="HS256")


def current_user(request: Request) -> User:
    token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(401, "Authentication required")
    try:
        user_id = int(jwt.decode(token, s.jwt_secret, algorithms=["HS256"])["sub"])
    except Exception as exc:
        raise HTTPException(401, "Invalid or expired session") from exc
    session = db()
    try:
        user = session.get(User, user_id)
        if not user:
            raise HTTPException(401, "Authentication required")
        return user
    finally:
        session.close()


def require_csrf(request: Request) -> None:
    cookie = request.cookies.get("csrf_token")
    header = request.headers.get("X-CSRF-Token")
    if not cookie or not header or not secrets.compare_digest(cookie, header):
        raise HTTPException(403, "CSRF validation failed")


def cookie_secure(request: Request) -> bool:
    return bool(s.cookie_secure and request.url.scheme == "https")


def set_session_cookies(response: Response, request: Request, user_id: int) -> None:
    secure = cookie_secure(request)
    response.set_cookie("access_token", make_token(user_id), httponly=True, secure=secure, samesite=s.cookie_samesite, max_age=s.access_token_minutes * 60, path="/")
    response.set_cookie("csrf_token", secrets.token_urlsafe(32), httponly=False, secure=secure, samesite=s.cookie_samesite, max_age=s.access_token_minutes * 60, path="/")


def normalize_email(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise HTTPException(400, "Enter a valid email address")
    return value


def send_password_reset_email(email: str, token: str) -> None:
    if not all((s.smtp_host, s.smtp_username, s.smtp_password, s.smtp_from)):
        raise RuntimeError("Password reset email is not configured")
    link = s.app_base_url.rstrip("/") + "/?reset_token=" + token
    message = EmailMessage()
    message["Subject"] = "GhostVoice password reset"
    message["From"] = s.smtp_from
    message["To"] = email
    message.set_content(f"A GhostVoice password reset was requested.\n\nReset your password: {link}\n\nThis link expires in 30 minutes and can only be used once.")
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as server:
        server.starttls()
        server.login(s.smtp_username, s.smtp_password)
        server.send_message(message)


def decode_audio(raw: bytes, ext: str):
    if ext == ".wav":
        y, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
        y = np.asarray(y, dtype=np.float32)
        if y.ndim > 1:
            y = y.mean(axis=1)
        if sr != 16000:
            y = librosa.resample(y, orig_sr=sr, target_sr=16000)
            sr = 16000
        return y, sr

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as source, tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as target:
        source_path, target_path = source.name, target.name
        source.write(raw)
        source.flush()
    try:
        result = subprocess.run([s.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-i", source_path, "-ac", "1", "-ar", "16000", "-f", "wav", target_path, "-y"], capture_output=True, timeout=30, check=False)
        if result.returncode != 0:
            raise ValueError("FFmpeg could not decode this file")
        y, sr = sf.read(target_path, dtype="float32", always_2d=False)
        y = np.asarray(y, dtype=np.float32)
        if y.ndim > 1:
            y = y.mean(axis=1)
        return y, sr
    finally:
        for path in (source_path, target_path):
            try:
                os.unlink(path)
            except OSError:
                pass


def speech_windows(y: np.ndarray, sr: int):
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0]
    threshold = max(float(np.percentile(rms, 35)) * 1.4, 1e-4)
    indices = np.where(rms > threshold)[0]
    if len(indices) == 0:
        return []
    start = max(0, int(indices[0] * 256))
    end = min(len(y), int((indices[-1] + 1) * 256 + 1024))
    y = y[start:end]
    window = int(s.window_seconds * sr)
    hop = int(s.hop_seconds * sr)
    if len(y) < int(0.5 * sr):
        return []
    if len(y) <= window:
        return [np.pad(y, (0, window - len(y)))]
    windows = [y[i:i + window] for i in range(0, len(y) - window + 1, hop)]
    if len(windows) > s.max_windows:
        positions = np.linspace(0, len(windows) - 1, s.max_windows, dtype=int)
        windows = [windows[int(i)] for i in positions]
    return windows


DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
PROCESSOR = None
MODEL = None
_MODEL_LOCK = __import__("threading").Lock()


def load_model():
    global PROCESSOR, MODEL
    if MODEL is not None and PROCESSOR is not None:
        return
    with _MODEL_LOCK:
        if MODEL is None or PROCESSOR is None:
            print(f"[GhostVoice] Loading model: {s.base_model}")
            PROCESSOR = AutoFeatureExtractor.from_pretrained(s.base_model)
            MODEL = AutoModelForAudioClassification.from_pretrained(s.base_model).to(DEVICE).eval()
            print(f"[GhostVoice] Model loaded on {DEVICE}")


def base_score(y: np.ndarray) -> float:
    load_model()
    inputs = PROCESSOR(y, sampling_rate=16000, return_tensors="pt", padding=True)
    inputs = {key: value.to(DEVICE) for key, value in inputs.items()}
    with torch.inference_mode():
        probabilities = torch.softmax(MODEL(**inputs).logits, dim=-1)[0].cpu().numpy()
    return float(probabilities[1] if len(probabilities) == 2 else probabilities[-1])


def spectral_score(y: np.ndarray) -> float:
    stft = np.abs(librosa.stft(y, n_fft=1024, hop_length=256)) + 1e-8
    db = librosa.amplitude_to_db(stft, ref=np.max)
    high = float(np.mean(db[int(0.7 * len(db)):]))
    flatness = float(np.mean(librosa.feature.spectral_flatness(y=y)))
    z = 1.8 * (high + 50) / 50 + 1.2 * (flatness - 0.03)
    return 1 / (1 + math.exp(-z))


def analyze(y: np.ndarray):
    windows = speech_windows(y, 16000)
    if not windows:
        raise ValueError("No usable speech detected")
    model_scores = [base_score(window) for window in windows]
    spectral_scores = [spectral_score(window) for window in windows]
    model_median = float(np.median(model_scores))
    spectral_median = float(np.median(spectral_scores))
    score = float(np.clip(s.base_weight * model_median + s.spectral_weight * spectral_median, 0, 1))
    spread = float(np.std(model_scores))
    agreement = float(np.mean([(value >= 0.5) == (score >= 0.5) for value in model_scores]))
    confidence = max(0, min(1, agreement * (1 - spread)))
    verdict = "HUMAN" if score < s.uncertain_low else "AI_GENERATED" if score > s.uncertain_high else "UNCERTAIN"
    return {"verdict": verdict, "ai_probability": round(score, 4), "confidence": round(confidence, 4), "windows": len(windows), "window_scores": [round(value, 4) for value in model_scores], "device": str(DEVICE)}


limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])
app = FastAPI(title="GhostVoice", docs_url="/docs" if s.app_env != "production" else None)
app.state.limiter = limiter
app.add_middleware(CORSMiddleware, allow_origins=s.origins, allow_credentials=True, allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "X-CSRF-Token"])
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc):
    return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "microphone=(self)"
    response.headers["Cache-Control"] = "no-store"
    if s.app_env == "production":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    return response


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=12, max_length=256)
    email: str | None = Field(default=None, max_length=320)


def normalize_email(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise HTTPException(400, "Enter a valid email address")
    return value


def send_password_reset_email(email: str, token: str) -> None:
    if not all((s.smtp_host, s.smtp_username, s.smtp_password, s.smtp_from)):
        raise RuntimeError("Password reset email is not configured")
    link = s.app_base_url.rstrip("/") + "/?reset_token=" + token
    message = EmailMessage()
    message["Subject"] = "GhostVoice password reset"
    message["From"] = s.smtp_from
    message["To"] = email
    message.set_content(
        "A GhostVoice password reset was requested.\n\n"
        f"Reset your password: {link}\n\n"
        "This link expires in 30 minutes and can only be used once. "
        "If you did not request this, you can ignore this email."
    )
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as server:
        server.starttls()
        server.login(s.smtp_username, s.smtp_password)
        server.send_message(message)
    email: str | None = Field(default=None, max_length=320)


def normalize_email(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise HTTPException(400, "Enter a valid email address")
    return value


def send_password_reset_email(email: str, token: str) -> None:
    if not all((s.smtp_host, s.smtp_username, s.smtp_password, s.smtp_from)):
        raise RuntimeError("Password reset email is not configured")
    link = s.app_base_url.rstrip("/") + "/?reset_token=" + token
    message = EmailMessage()
    message["Subject"] = "GhostVoice password reset"
    message["From"] = s.smtp_from
    message["To"] = email
    message.set_content(
        "A GhostVoice password reset was requested.\n\n"
        f"Reset your password: {link}\n\n"
        "This link expires in 30 minutes and can only be used once. "
        "If you did not request this, you can ignore this email."
    )
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as server:
        server.starttls()
        server.login(s.smtp_username, s.smtp_password)
        server.send_message(message)
    email: str | None = Field(default=None, max_length=320)


def normalize_email(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise HTTPException(400, "Enter a valid email address")
    return value


def send_password_reset_email(email: str, token: str) -> None:
    if not all((s.smtp_host, s.smtp_username, s.smtp_password, s.smtp_from)):
        raise RuntimeError("Password reset email is not configured")
    link = s.app_base_url.rstrip("/") + "/?reset_token=" + token
    message = EmailMessage()
    message["Subject"] = "GhostVoice password reset"
    message["From"] = s.smtp_from
    message["To"] = email
    message.set_content(
        "A GhostVoice password reset was requested.\n\n"
        f"Reset your password: {link}\n\n"
        "This link expires in 30 minutes and can only be used once. "
        "If you did not request this, you can ignore this email."
    )
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as server:
        server.starttls()
        server.login(s.smtp_username, s.smtp_password)
        server.send_message(message)
    email: str | None = Field(default=None, max_length=320)


def normalize_email(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise HTTPException(400, "Enter a valid email address")
    return value


def send_password_reset_email(email: str, token: str) -> None:
    if not all((s.smtp_host, s.smtp_username, s.smtp_password, s.smtp_from)):
        raise RuntimeError("Password reset email is not configured")
    link = s.app_base_url.rstrip("/") + "/?reset_token=" + token
    message = EmailMessage()
    message["Subject"] = "GhostVoice password reset"
    message["From"] = s.smtp_from
    message["To"] = email
    message.set_content(
        "A GhostVoice password reset was requested.\n\n"
        f"Reset your password: {link}\n\n"
        "This link expires in 30 minutes and can only be used once. "
        "If you did not request this, you can ignore this email."
    )
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as server:
        server.starttls()
        server.login(s.smtp_username, s.smtp_password)
        server.send_message(message)
    email: str | None = Field(default=None, max_length=320)


def normalize_email(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        raise HTTPException(400, "Enter a valid email address")
    return value


def send_password_reset_email(email: str, token: str) -> None:
    if not all((s.smtp_host, s.smtp_username, s.smtp_password, s.smtp_from)):
        raise RuntimeError("Password reset email is not configured")
    link = s.app_base_url.rstrip("/") + "/?reset_token=" + token
    message = EmailMessage()
    message["Subject"] = "GhostVoice password reset"
    message["From"] = s.smtp_from
    message["To"] = email
    message.set_content(
        "A GhostVoice password reset was requested.\n\n"
        f"Reset your password: {link}\n\n"
        "This link expires in 30 minutes and can only be used once. "
        "If you did not request this, you can ignore this email."
    )
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as server:
        server.starttls()
        server.login(s.smtp_username, s.smtp_password)
        server.send_message(message)
    email: str | None = Field(default=None, max_length=320)


class ForgotPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=40, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html", media_type="text/html")


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": MODEL is not None, "device": str(DEVICE)}


@app.get("/api/csrf")
def csrf_api(request: Request, response: Response):
    token = request.cookies.get("csrf_token") or secrets.token_urlsafe(32)
    response.set_cookie("csrf_token", token, httponly=False, secure=cookie_secure(request), samesite=s.cookie_samesite, max_age=s.access_token_minutes * 60, path="/")
    return {"csrf_token": token}


@app.post("/api/register")
@limiter.limit(s.rate_limit_auth)
def register(request: Request, response: Response, credentials: Credentials):
    email = normalize_email(credentials.email)
    if not email:
        raise HTTPException(400, "Email is required for password recovery")
    session = db()
    try:
        if session.scalar(select(User).where(User.username == credentials.username)):
            raise HTTPException(409, "Username already exists")
        if session.scalar(select(User).where(User.email == email)):
            raise HTTPException(409, "Email is already registered")
        user = User(username=credentials.username, email=email, password_hash=ph.hash(credentials.password))
        session.add(user)
        session.flush()
        session.add(Audit(user_id=user.id, action="register", detail="", ip=request.client.host if request.client else ""))
        user_id, username = user.id, user.username
        session.commit()
    finally:
        session.close()
    set_session_cookies(response, request, user_id)
    return {"username": username}


@app.post("/api/account/recovery-email")
@limiter.limit(s.rate_limit_auth)
def set_recovery_email(request: Request, credentials: Credentials, user: User = Depends(current_user)):
    require_csrf(request)
    email = normalize_email(credentials.email)
    if not email:
        raise HTTPException(400, "Email is required")
    session = db()
    try:
        existing = session.scalar(select(User).where(User.email == email, User.id != user.id))
        if existing:
            raise HTTPException(409, "Email is already registered")
        row = session.get(User, user.id)
        row.email = email
        session.commit()
    finally:
        session.close()
    return {"ok": True}


@app.post("/api/login")
@limiter.limit(s.rate_limit_auth)
def login(request: Request, response: Response, credentials: Credentials):
    session = db()
    try:
        user = session.scalar(select(User).where(User.username == credentials.username))
        valid = False
        if user:
            try:
                valid = ph.verify(user.password_hash, credentials.password)
            except (VerifyMismatchError, VerificationError):
                valid = False
        if not valid:
            raise HTTPException(401, "Invalid username or password")
        user_id, username = user.id, user.username
        session.add(Audit(user_id=user_id, action="login", detail="", ip=request.client.host if request.client else ""))
        session.commit()
    finally:
        session.close()
    set_session_cookies(response, request, user_id)
    return {"username": username}


@app.post("/api/logout")
def logout(request: Request, response: Response, user: User = Depends(current_user)):
    require_csrf(request)
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("csrf_token", path="/")
    return {"ok": True}


@app.get("/api/me")
def me(user: User = Depends(current_user)):
    return {"id": user.id, "username": user.username}


@app.post("/api/forgot-password")
@limiter.limit("5/hour")
def forgot_password(payload: ForgotPasswordRequest):
    email = normalize_email(payload.email)
    session = db()
    try:
        user = session.scalar(select(User).where(User.email == email))
        if user:
            token = secrets.token_urlsafe(48)
            now = datetime.now(timezone.utc)
            session.query(PasswordReset).filter(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None)).update({"used_at": now})
            session.add(PasswordReset(user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=now + timedelta(minutes=30)))
            session.commit()
            try:
                send_password_reset_email(email, token)
            except Exception as exc:
                print(f"[GhostVoice] reset email failed: {exc}")
    finally:
        session.close()
    return {"ok": True, "message": "If that email is registered, a reset link has been sent."}


@app.post("/api/reset-password")
@limiter.limit("10/hour")
def reset_password(request: Request, payload: ResetPasswordRequest):
    require_csrf(request)
    token_hash = hashlib.sha256(payload.token.encode()).hexdigest()
    session = db()
    try:
        reset = session.scalar(select(PasswordReset).where(PasswordReset.token_hash == token_hash))
        now = datetime.now(timezone.utc)
        if not reset or reset.used_at is not None:
            raise HTTPException(400, "Reset link is invalid or expired")
        expires = reset.expires_at.replace(tzinfo=timezone.utc) if reset.expires_at.tzinfo is None else reset.expires_at
        if expires < now:
            raise HTTPException(400, "Reset link is invalid or expired")
        user = session.get(User, reset.user_id)
        if not user:
            raise HTTPException(400, "Reset link is invalid or expired")
        user.password_hash = ph.hash(payload.new_password)
        reset.used_at = now
        session.commit()
    finally:
        session.close()
    return {"ok": True, "message": "Password changed. You can now sign in."}


async def read_upload(file: UploadFile):
    ext = Path(file.filename or "").suffix.lower()
    allowed = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".webm", ".aac", ".mp4", ".opus"}
    if ext not in allowed:
        raise HTTPException(415, "Unsupported audio format")
    raw = await file.read(s.max_upload_mb * 1024 * 1024 + 1)
    if len(raw) > s.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, "File too large")
    return raw, ext


async def analyze_upload(request: Request, file: UploadFile):
    raw, ext = await read_upload(file)
    try:
        y, sr = decode_audio(raw, ext)
        if len(y) / sr > s.max_seconds:
            raise HTTPException(413, f"Maximum {s.max_seconds} seconds")
        result = analyze(y)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    result["duration_seconds"] = round(len(y) / sr, 2)
    result["sha256"] = hashlib.sha256(raw).hexdigest()
    return result, raw, y, sr


@app.post("/api/analyze")
@limiter.limit(s.rate_limit_analyze)
async def api_analyze(request: Request, file: UploadFile = File(...), user: User = Depends(current_user)):
    result, _, _, _ = await analyze_upload(request, file)
    return result


@app.post("/api/analyze-and-save")
@limiter.limit(s.rate_limit_analyze)
async def api_save(request: Request, file: UploadFile = File(...), user: User = Depends(current_user)):
    result, _, y, sr = await analyze_upload(request, file)
    output = io.BytesIO()
    sf.write(output, y, 16000, format="WAV", subtype="PCM_16")
    file_id = encrypted_store(output.getvalue(), user.id)
    session = db()
    try:
        session.add(Recording(file_id=file_id, user_id=user.id, duration=len(y) / sr, verdict=result["verdict"], ai_probability=result["ai_probability"]))
        session.add(Audit(user_id=user.id, action="save_recording", detail=file_id, ip=request.client.host if request.client else ""))
        session.commit()
    finally:
        session.close()
    result["recording_id"] = file_id
    return result


@app.get("/api/recordings")
def recordings(user: User = Depends(current_user)):
    session = db()
    try:
        rows = session.scalars(select(Recording).where(Recording.user_id == user.id).order_by(Recording.created_at.desc())).all()
        return [{"id": row.file_id, "duration": row.duration, "verdict": row.verdict, "ai_probability": row.ai_probability, "created_at": (row.created_at.replace(tzinfo=timezone.utc) if row.created_at.tzinfo is None else row.created_at).astimezone(timezone.utc).isoformat()} for row in rows]
    finally:
        session.close()


@app.get("/api/recordings/{file_id}")
def get_recording(file_id: str, user: User = Depends(current_user)):
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,40}", file_id):
        raise HTTPException(400, "Invalid id")
    session = db()
    try:
        row = session.scalar(select(Recording).where(Recording.file_id == file_id, Recording.user_id == user.id))
        if not row:
            raise HTTPException(404, "Not found")
    finally:
        session.close()
    try:
        data = encrypted_read(file_id, user.id)
    except Exception as exc:
        raise HTTPException(404, "Not found") from exc
    return Response(data, media_type="audio/wav")


@app.get("/api/recordings/{file_id}/download")
def download_recording(file_id: str, user: User = Depends(current_user)):
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,40}", file_id):
        raise HTTPException(400, "Invalid id")
    session = db()
    try:
        row = session.scalar(select(Recording).where(Recording.file_id == file_id, Recording.user_id == user.id))
        if not row:
            raise HTTPException(404, "Not found")
    finally:
        session.close()
    try:
        data = encrypted_read(file_id, user.id)
    except Exception as exc:
        raise HTTPException(404, "Not found") from exc
    return Response(data, media_type="audio/wav", headers={"Content-Disposition": f'attachment; filename="ghostvoice-{file_id}.wav"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@app.delete("/api/recordings/{file_id}")
def delete_recording(file_id: str, request: Request, user: User = Depends(current_user)):
    require_csrf(request)
    session = db()
    try:
        row = session.scalar(select(Recording).where(Recording.file_id == file_id, Recording.user_id == user.id))
        if not row:
            raise HTTPException(404, "Not found")
        encrypted_delete(file_id)
        session.delete(row)
        session.add(Audit(user_id=user.id, action="delete_recording", detail=file_id, ip=request.client.host if request.client else ""))
        session.commit()
    finally:
        session.close()
    return {"ok": True}

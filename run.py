"""Run GhostVoice with profile and admin routes enabled."""
from __future__ import annotations
import importlib.util
import re
import sys
from pathlib import Path
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
APP_PATH = BASE_DIR / "app.py"
source = APP_PATH.read_text(encoding="utf-8")
source = re.sub(r"def forgot_password\(\s*(?:request:\s*Request,\s*)?payload:\s*ForgotPasswordRequest\s*\):", "def forgot_password(request: Request, payload: ForgotPasswordRequest):", source, count=1)
spec = importlib.util.spec_from_file_location("app", APP_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError("Unable to load app.py")
module = importlib.util.module_from_spec(spec)
module.__file__ = str(APP_PATH)
sys.modules["app"] = module
exec(compile(source, str(APP_PATH), "exec"), module.__dict__)
from profile_routes import register_profile_routes
from admin_routes import register_admin_routes
register_profile_routes(module.app)
register_admin_routes(module.app)
if __name__ == "__main__":
    uvicorn.run(module.app, host="127.0.0.1", port=8000)

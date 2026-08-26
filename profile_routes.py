import os
from pathlib import Path

from argon2.exceptions import VerificationError, VerifyMismatchError
from fastapi import Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select


class DeleteAccountRequest(BaseModel):
    password: str = Field(min_length=12, max_length=256)


def _admin_emails() -> set[str]:
    value = os.getenv("ADMIN_EMAILS", "").strip()
    if not value:
        env_file = Path(__file__).resolve().parent / ".env"
        try:
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("ADMIN_EMAILS="):
                    value = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except OSError:
            pass
    return {item.strip().lower() for item in value.split(",") if item.strip()}


def register_profile_routes(app):
    # Imports are intentionally delayed until app.py has finished defining its models/helpers.
    from app import Audit, PasswordReset, Recording, User, current_user, db, encrypted_delete, ph, require_csrf

    @app.get("/api/profile")
    def profile(user: User = Depends(current_user)):
        email = (user.email or "").strip().lower()
        return {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "is_admin": bool(email and email in _admin_emails()),
        }

    @app.post("/api/profile/delete-audios")
    def delete_all_audios(request: Request, user: User = Depends(current_user)):
        require_csrf(request)
        session = db()
        try:
            rows = session.scalars(select(Recording).where(Recording.user_id == user.id)).all()
            for row in rows:
                encrypted_delete(row.file_id)
                session.delete(row)
            session.add(Audit(
                user_id=user.id,
                action="delete_all_recordings",
                detail=f"count={len(rows)}",
                ip=request.client.host if request.client else "",
            ))
            session.commit()
            return {"ok": True, "deleted": len(rows)}
        finally:
            session.close()

    @app.post("/api/profile/delete-account")
    def delete_account(request: Request, response: Response, payload: DeleteAccountRequest, user: User = Depends(current_user)):
        require_csrf(request)
        session = db()
        try:
            row = session.get(User, user.id)
            if not row:
                raise HTTPException(401, "Account no longer exists")
            try:
                ph.verify(row.password_hash, payload.password)
            except (VerifyMismatchError, VerificationError):
                raise HTTPException(401, "Incorrect password")

            recordings = session.scalars(select(Recording).where(Recording.user_id == row.id)).all()
            for recording in recordings:
                encrypted_delete(recording.file_id)
                session.delete(recording)

            session.execute(delete(PasswordReset).where(PasswordReset.user_id == row.id))
            session.execute(delete(Audit).where(Audit.user_id == row.id))
            session.delete(row)
            session.commit()
        finally:
            session.close()

        response.delete_cookie("access_token", path="/")
        response.delete_cookie("csrf_token", path="/")
        return {"ok": True, "message": "Account permanently deleted."}

import os
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy import func, select


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


def register_admin_routes(app):
    from app import Audit, Recording, User, current_user, db, encrypted_delete, require_csrf

    def require_admin(user: User = Depends(current_user)):
        email = (user.email or "").strip().lower()
        if not email or email not in _admin_emails():
            raise HTTPException(403, "Administrator access required")
        return user

    @app.get("/admin")
    def admin_page(user: User = Depends(require_admin)):
        return FileResponse(Path(__file__).resolve().parent / "web" / "admin.html", media_type="text/html")

    @app.get("/api/admin/overview")
    def admin_overview(user: User = Depends(require_admin)):
        session = db()
        try:
            users = session.scalar(select(func.count()).select_from(User)) or 0
            recordings = session.scalar(select(func.count()).select_from(Recording)) or 0
            audit_events = session.scalar(select(func.count()).select_from(Audit)) or 0
            return {"users": users, "recordings": recordings, "audit_events": audit_events}
        finally:
            session.close()

    @app.get("/api/admin/users")
    def admin_users(user: User = Depends(require_admin)):
        session = db()
        try:
            rows = session.scalars(select(User).order_by(User.created_at.desc())).all()
            recording_counts = dict(session.execute(select(Recording.user_id, func.count(Recording.id)).group_by(Recording.user_id)).all())
            return [{
                "id": row.id,
                "username": row.username,
                "email": row.email,
                "created_at": (row.created_at.replace(tzinfo=__import__("datetime").timezone.utc) if row.created_at.tzinfo is None else row.created_at).isoformat(),
                "recordings": int(recording_counts.get(row.id, 0)),
                "is_admin": bool(row.email and row.email.strip().lower() in _admin_emails()),
            } for row in rows]
        finally:
            session.close()

    @app.get("/api/admin/audit")
    def admin_audit(user: User = Depends(require_admin)):
        session = db()
        try:
            rows = session.scalars(select(Audit).order_by(Audit.created_at.desc()).limit(100)).all()
            return [{"id": r.id, "user_id": r.user_id, "action": r.action, "detail": r.detail, "ip": r.ip, "created_at": (r.created_at.replace(tzinfo=__import__("datetime").timezone.utc) if r.created_at.tzinfo is None else r.created_at).isoformat()} for r in rows]
        finally:
            session.close()

    @app.delete("/api/admin/users/{user_id}")
    def admin_delete_user(user_id: int, request: Request, user: User = Depends(require_admin)):
        require_csrf(request)
        if user_id == user.id:
            raise HTTPException(400, "Use your account settings to delete your own account")
        session = db()
        try:
            target = session.get(User, user_id)
            if not target:
                raise HTTPException(404, "User not found")
            if target.email and target.email.strip().lower() in _admin_emails():
                raise HTTPException(403, "Configured administrator accounts cannot be deleted here")
            recordings = session.scalars(select(Recording).where(Recording.user_id == target.id)).all()
            for recording in recordings:
                encrypted_delete(recording.file_id)
                session.delete(recording)
            session.query(Audit).filter(Audit.user_id == target.id).delete(synchronize_session=False)
            session.delete(target)
            session.add(Audit(user_id=user.id, action="admin_delete_user", detail=f"deleted_user_id={user_id}", ip=request.client.host if request.client else ""))
            session.commit()
            return {"ok": True}
        finally:
            session.close()

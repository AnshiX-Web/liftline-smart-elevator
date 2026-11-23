from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import smtplib
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
import uuid
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from functools import wraps
from pathlib import Path

import click
import qrcode
from flask import Flask, Response, current_app, g, jsonify, request, send_from_directory, session
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent
ROLE_NAMES = {
    "passenger": "Passenger",
    "rescue_team": "Rescue team",
    "building_admin": "Building administrator",
    "maintenance_engineer": "Maintenance engineer",
    "system_admin": "System administrator",
}
EMERGENCY_STATUSES = ("New", "Accepted", "In Progress", "Resolved", "Closed")
MAINTENANCE_STATUSES = ("Open", "In Progress", "Completed", "Closed")
SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT,
    role TEXT NOT NULL CHECK (role IN ('passenger','rescue_team','building_admin','maintenance_engineer','system_admin')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS elevators (
    id TEXT PRIMARY KEY,
    building TEXT NOT NULL,
    location TEXT NOT NULL,
    floors TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Unknown',
    qr_token_hash TEXT,
    assigned_rescuer_id TEXT REFERENCES users(id),
    assigned_engineer_id TEXT REFERENCES users(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emergencies (
    id TEXT PRIMARY KEY,
    client_request_id TEXT NOT NULL UNIQUE,
    elevator_id TEXT NOT NULL REFERENCES elevators(id),
    requester_id TEXT REFERENCES users(id),
    requester_name TEXT,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('New','Accepted','In Progress','Resolved','Closed')),
    assigned_rescuer_id TEXT REFERENCES users(id),
    tracking_token_hash TEXT NOT NULL,
    verified_elevator INTEGER NOT NULL DEFAULT 0,
    escalation_sent_at TEXT,
    maintenance_required INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emergencies_status_created ON emergencies(status, created_at);
CREATE TABLE IF NOT EXISTS emergency_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emergency_id TEXT NOT NULL REFERENCES emergencies(id),
    actor_id TEXT REFERENCES users(id),
    old_status TEXT,
    new_status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS maintenance_requests (
    id TEXT PRIMARY KEY,
    elevator_id TEXT NOT NULL REFERENCES elevators(id),
    emergency_id TEXT REFERENCES emergencies(id),
    assigned_engineer_id TEXT REFERENCES users(id),
    description TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'Normal',
    status TEXT NOT NULL CHECK (status IN ('Open','In Progress','Completed','Closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_requests(status, created_at);
CREATE TABLE IF NOT EXISTS maintenance_records (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES maintenance_requests(id),
    engineer_id TEXT NOT NULL REFERENCES users(id),
    inspection_details TEXT NOT NULL,
    repair_details TEXT NOT NULL DEFAULT '',
    remarks TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    emergency_id TEXT REFERENCES emergencies(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_outbox (
    id TEXT PRIMARY KEY,
    emergency_id TEXT NOT NULL REFERENCES emergencies(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (emergency_id, user_id, channel)
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
"""
_sos_requests = defaultdict(deque)
_login_requests = defaultdict(deque)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return str(uuid.uuid4())


def row_dict(row: sqlite3.Row | None):
    return dict(row) if row is not None else None


def connect_database(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect_database(current_app.config["DATABASE"])
    return g.db


@contextmanager
def transaction():
    connection = get_db()
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise


def audit(connection: sqlite3.Connection, actor_id, action, entity_type, entity_id, details=None):
    connection.execute(
        """INSERT INTO audit_log(actor_id,action,entity_type,entity_id,details,created_at)
           VALUES(?,?,?,?,?,?)""",
        (actor_id, action, entity_type, entity_id, json.dumps(details or {}), utc_now()),
    )


def create_user(connection, name, email, role, password, phone=""):
    if len(password) < 12:
        raise ValueError("Password must contain at least 12 characters.")
    if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
        raise ValueError("Email address is invalid.")
    user_id = new_id()
    timestamp = utc_now()
    connection.execute(
        """INSERT INTO users(id,name,email,phone,role,password_hash,active,created_at,updated_at)
           VALUES(?,?,?,?,?,?,1,?,?)""",
        (user_id, name.strip(), email.strip().lower(), phone.strip(), role,
         generate_password_hash(password), timestamp, timestamp),
    )
    return user_id


def ensure_initial_data(app: Flask):
    connection = connect_database(app.config["DATABASE"])
    try:
        connection.executescript(SCHEMA)
        elevator_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(elevators)").fetchall()
        }
        if "qr_token_hash" not in elevator_columns:
            connection.execute("ALTER TABLE elevators ADD COLUMN qr_token_hash TEXT")
        if app.config["APP_ENV"] != "production" and connection.execute(
            "SELECT COUNT(*) FROM elevators"
        ).fetchone()[0] == 0:
            now = utc_now()
            sample_elevators = [
                ("ELV-104", "Building A", "North tower · Floor 3", "Ground, 1, 2", "Operational"),
                ("ELV-201", "Building B", "South tower · Floor 1", "Ground, 1", "Operational"),
                ("ELV-301", "Admin Block", "Main entrance", "Ground, 1, 2", "Unknown"),
            ]
            connection.executemany(
                """INSERT INTO elevators(id,building,location,floors,status,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?)""",
                [(eid, building, location, floors, status, now, now)
                 for eid, building, location, floors, status in sample_elevators],
            )
        if app.config["SEED_DEMO_USERS"] and connection.execute(
            "SELECT COUNT(*) FROM users"
        ).fetchone()[0] == 0:
            demo_users = [
                ("Campus Administrator", "admin@demo.local", "building_admin"),
                ("System Administrator", "sysadmin@demo.local", "system_admin"),
                ("Rescue Lead", "rescue@demo.local", "rescue_team"),
                ("Maintenance Engineer", "maintenance@demo.local", "maintenance_engineer"),
            ]
            for name, email, role in demo_users:
                create_user(connection, name, email, role, "Liftline-Demo-2026!")
        bootstrap_email = app.config.get("BOOTSTRAP_ADMIN_EMAIL")
        bootstrap_password = app.config.get("BOOTSTRAP_ADMIN_PASSWORD")
        if bootstrap_email and bootstrap_password and connection.execute(
            "SELECT COUNT(*) FROM users WHERE role IN ('system_admin','building_admin')"
        ).fetchone()[0] == 0:
            create_user(
                connection,
                app.config.get("BOOTSTRAP_ADMIN_NAME", "Campus Administrator"),
                bootstrap_email,
                "system_admin",
                bootstrap_password,
            )
        connection.commit()
    finally:
        connection.close()


def current_user():
    if hasattr(g, "current_user"):
        return g.current_user
    user_id = session.get("user_id")
    g.current_user = row_dict(
        get_db().execute(
            "SELECT id,name,email,phone,role,active FROM users WHERE id=? AND active=1",
            (user_id,),
        ).fetchone()
    ) if user_id else None
    return g.current_user


def roles_required(*roles):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            user = current_user()
            if not user:
                return jsonify(success=False, error="Authentication required."), 401
            if user["role"] not in roles:
                return jsonify(success=False, error="Your account is not authorized for this action."), 403
            return function(*args, **kwargs)
        return wrapped
    return decorate


def json_body():
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else None


def error(message, status=400):
    return jsonify(success=False, error=message), status


def validate_text(value, label, maximum=300, required=True):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{label} is required.")
    if len(value) > maximum:
        raise ValueError(f"{label} must be {maximum} characters or fewer.")
    return value


def notification_recipients(connection, emergency_id, elevator_id, title, message):
    elevator = connection.execute(
        "SELECT assigned_rescuer_id,assigned_engineer_id FROM elevators WHERE id=?",
        (elevator_id,),
    ).fetchone()
    recipients = connection.execute(
        """SELECT id,email,phone,role FROM users
           WHERE active=1 AND role IN ('rescue_team','building_admin','system_admin')
           AND (role!='rescue_team' OR ? IS NULL OR id=?)""",
        (elevator["assigned_rescuer_id"] if elevator else None,
         elevator["assigned_rescuer_id"] if elevator else None),
    ).fetchall()
    configured = configured_channels()
    now = utc_now()
    queued = 0
    for recipient in recipients:
        connection.execute(
            """INSERT INTO notifications(id,user_id,emergency_id,title,message,created_at)
               VALUES(?,?,?,?,?,?)""",
            (new_id(), recipient["id"], emergency_id, title, message, now),
        )
        for channel in configured:
            if channel == "sms" and not recipient["phone"]:
                continue
            inserted = connection.execute(
                """INSERT OR IGNORE INTO notification_outbox
                   (id,emergency_id,user_id,channel,status,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (new_id(), emergency_id, recipient["id"], channel, "Pending", now, now),
            )
            queued += inserted.rowcount
    return configured, len(recipients), queued


def configured_channels():
    channels = []
    if current_app.config.get("SMTP_HOST") and current_app.config.get("SMTP_FROM"):
        channels.append("email")
    if all(current_app.config.get(key) for key in (
        "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"
    )):
        channels.append("sms")
    return channels


def dispatch_outbox(emergency_id: str):
    """Claim and deliver queued messages after the incident transaction has committed."""
    connection = connect_database(current_app.config["DATABASE"])
    try:
        connection.execute("BEGIN IMMEDIATE")
        jobs = connection.execute(
            """SELECT o.id,o.channel,u.name,u.email,u.phone,e.id emergency_id,
                      e.category,e.description,l.building,l.location,l.id elevator_id
               FROM notification_outbox o
               JOIN users u ON u.id=o.user_id
               JOIN emergencies e ON e.id=o.emergency_id
               JOIN elevators l ON l.id=e.elevator_id
               WHERE o.emergency_id=? AND o.status='Pending'""",
            (emergency_id,),
        ).fetchall()
        now = utc_now()
        claimed = []
        for job in jobs:
            result = connection.execute(
                """UPDATE notification_outbox SET status='Sending',attempts=attempts+1,updated_at=?
                   WHERE id=? AND status='Pending'""",
                (now, job["id"]),
            )
            if result.rowcount:
                claimed.append(job)
        connection.commit()
        jobs = claimed
    finally:
        connection.close()

    for job in jobs:
        failure = ""
        try:
            if job["channel"] == "email":
                send_email(job)
            elif job["channel"] == "sms":
                send_sms(job)
            else:
                raise RuntimeError("Unknown notification channel.")
        except Exception as exc:
            failure = str(exc)[:500]
        connection = connect_database(current_app.config["DATABASE"])
        try:
            connection.execute(
                """UPDATE notification_outbox SET status=?,last_error=?,updated_at=?
                   WHERE id=? AND status='Sending'""",
                ("Failed" if failure else "Sent", failure, utc_now(), job["id"]),
            )
            connection.commit()
        finally:
            connection.close()


def send_email(job):
    host = current_app.config.get("SMTP_HOST")
    sender = current_app.config.get("SMTP_FROM")
    if not host or not sender or not job["email"]:
        raise RuntimeError("SMTP or recipient email is not configured.")
    message = EmailMessage()
    message["Subject"] = f"Elevator emergency {job['emergency_id']}"
    message["From"] = sender
    message["To"] = job["email"]
    message.set_content(
        f"Emergency {job['emergency_id']} at {job['building']} · {job['elevator_id']}.\n"
        f"Location: {job['location']}\nCategory: {job['category']}\n"
        f"Details: {job['description'] or 'None provided'}"
    )
    port = int(current_app.config.get("SMTP_PORT", 587))
    with smtplib.SMTP(host, port, timeout=5) as client:
        if current_app.config.get("SMTP_STARTTLS", True):
            client.starttls()
        user = current_app.config.get("SMTP_USER")
        password = current_app.config.get("SMTP_PASSWORD")
        if user and password:
            client.login(user, password)
        client.send_message(message)


def send_sms(job):
    sid = current_app.config["TWILIO_ACCOUNT_SID"]
    token = current_app.config["TWILIO_AUTH_TOKEN"]
    number = job["phone"]
    if not number:
        raise RuntimeError("Recipient has no mobile number.")
    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
    content = (
        f"Elevator emergency {job['emergency_id']}: {job['building']} · "
        f"{job['elevator_id']}, {job['location']}. Please acknowledge in Liftline."
    )
    payload = urllib.parse.urlencode({
        "To": number,
        "From": current_app.config["TWILIO_FROM_NUMBER"],
        "Body": content,
    }).encode()
    credentials = f"{sid}:{token}".encode()
    request_object = urllib.request.Request(
        url,
        data=payload,
        headers={"Authorization": "Basic " + base64.b64encode(credentials).decode()},
        method="POST",
    )
    with urllib.request.urlopen(request_object, timeout=5) as response:
        if response.status >= 300:
            raise RuntimeError(f"SMS provider returned HTTP {response.status}.")


def create_maintenance_request(connection, emergency, description, priority="High"):
    existing = connection.execute(
        "SELECT id FROM maintenance_requests WHERE emergency_id=? AND status!='Closed'",
        (emergency["id"],),
    ).fetchone()
    if existing:
        return existing["id"]
    elevator = connection.execute(
        "SELECT assigned_engineer_id FROM elevators WHERE id=?",
        (emergency["elevator_id"],),
    ).fetchone()
    request_id = "WO-" + uuid.uuid4().hex[:8].upper()
    now = utc_now()
    connection.execute(
        """INSERT INTO maintenance_requests
           (id,elevator_id,emergency_id,assigned_engineer_id,description,priority,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,'Open',?,?)""",
        (request_id, emergency["elevator_id"], emergency["id"],
         elevator["assigned_engineer_id"] if elevator else None, description, priority, now, now),
    )
    connection.execute(
        "UPDATE elevators SET status='Under maintenance',updated_at=? WHERE id=?",
        (now, emergency["elevator_id"]),
    )
    if elevator and elevator["assigned_engineer_id"]:
        connection.execute(
            """INSERT INTO notifications(id,user_id,emergency_id,title,message,created_at)
               VALUES(?,?,?,'New maintenance request',?,?)""",
            (
                new_id(),
                elevator["assigned_engineer_id"],
                emergency["id"],
                f"{request_id} for {emergency['elevator_id']}: {description}",
                now,
            ),
        )
    audit(connection, None, "maintenance.auto_created", "maintenance_request", request_id,
          {"emergency_id": emergency["id"]})
    return request_id


def escalate_unacknowledged(connection):
    minutes = int(current_app.config.get("ESCALATION_MINUTES", 2))
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    pending = connection.execute(
        """SELECT e.id,e.elevator_id,e.created_at,l.building,l.location,l.id elevator_label
           FROM emergencies e JOIN elevators l ON l.id=e.elevator_id
           WHERE e.status='New' AND e.escalation_sent_at IS NULL AND e.created_at<=?""",
        (cutoff,),
    ).fetchall()
    escalated = []
    channels = configured_channels()
    for incident in pending:
        recipients = connection.execute(
            "SELECT id FROM users WHERE active=1 AND role IN ('building_admin','system_admin')"
        ).fetchall()
        for recipient in recipients:
            connection.execute(
                """INSERT INTO notifications(id,user_id,emergency_id,title,message,created_at)
                   VALUES(?,?,?,?,?,?)""",
                (new_id(), recipient["id"], incident["id"], "Emergency needs acknowledgement",
                 f"Emergency {incident['id']} remains unacknowledged at {incident['building']} · "
                 f"{incident['elevator_label']} ({incident['location']}).", utc_now()),
            )
            for channel in channels:
                 if channel == "sms":
                     phone = connection.execute(
                         "SELECT phone FROM users WHERE id=?", (recipient["id"],)
                     ).fetchone()
                     if not phone or not phone["phone"]:
                         continue
                 connection.execute(
                     """INSERT OR IGNORE INTO notification_outbox
                        (id,emergency_id,user_id,channel,status,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?)""",
                     (new_id(), incident["id"], recipient["id"], channel, "Pending",
                      utc_now(), utc_now()),
                 )
        connection.execute(
            "UPDATE emergencies SET escalation_sent_at=?,updated_at=? WHERE id=?",
            (utc_now(), utc_now(), incident["id"]),
        )
        audit(connection, None, "emergency.escalated", "emergency", incident["id"],
              {"after_minutes": minutes})
        escalated.append(incident["id"])
    return escalated


def emergency_query(connection, emergency_id):
    return connection.execute(
        """SELECT e.*,l.building,l.location,l.floors,l.status elevator_status,
                  u.name rescuer_name
           FROM emergencies e JOIN elevators l ON l.id=e.elevator_id
           LEFT JOIN users u ON u.id=e.assigned_rescuer_id
           WHERE e.id=?""",
        (emergency_id,),
    ).fetchone()


def public_emergency(row, include_private=False):
    result = {
        "id": row["id"],
        "elevator_id": row["elevator_id"],
        "building": row["building"],
        "location": row["location"],
        "floors": row["floors"],
        "category": row["category"],
        "description": row["description"],
        "status": row["status"],
        "verified_elevator": bool(row["verified_elevator"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if include_private:
        result.update(
            requester_name=row["requester_name"],
            rescuer_name=row["rescuer_name"],
            assigned_rescuer_id=row["assigned_rescuer_id"],
            maintenance_required=bool(row["maintenance_required"]),
        )
    return result


def create_app(test_config=None):
    app = Flask(__name__, static_folder="static")
    instance_dir = ROOT / "instance"
    instance_dir.mkdir(exist_ok=True)
    overrides = test_config or {}
    app_environment = overrides.get("APP_ENV", os.environ.get("APP_ENV", "development"))
    secret_key = overrides.get("SECRET_KEY") or os.environ.get("SECRET_KEY")
    if app_environment == "production" and not secret_key:
        raise RuntimeError("SECRET_KEY must be configured in production.")
    app.config.from_mapping(
        SECRET_KEY=secret_key or secrets.token_hex(32),
        DATABASE=os.environ.get("DATABASE_PATH", str(instance_dir / "liftline.sqlite")),
        APP_ENV=app_environment,
        SEED_DEMO_USERS=app_environment != "production" and os.environ.get("SEED_DEMO_USERS", "0") == "1",
        ENABLE_BACKGROUND_WORKER=app_environment == "production" or os.environ.get("ENABLE_BACKGROUND_WORKER", "0") == "1",
        TRUSTED_PROXY_HOPS=int(os.environ.get("TRUSTED_PROXY_HOPS", "0")),
        BOOTSTRAP_ADMIN_EMAIL=os.environ.get("BOOTSTRAP_ADMIN_EMAIL"),
        BOOTSTRAP_ADMIN_PASSWORD=os.environ.get("BOOTSTRAP_ADMIN_PASSWORD"),
        BOOTSTRAP_ADMIN_NAME=os.environ.get("BOOTSTRAP_ADMIN_NAME", "Campus Administrator"),
        SMTP_HOST=os.environ.get("SMTP_HOST"),
        SMTP_PORT=os.environ.get("SMTP_PORT", "587"),
        SMTP_USER=os.environ.get("SMTP_USER"),
        SMTP_PASSWORD=os.environ.get("SMTP_PASSWORD"),
        SMTP_FROM=os.environ.get("SMTP_FROM"),
        SMTP_STARTTLS=os.environ.get("SMTP_STARTTLS", "true").lower() == "true",
        TWILIO_ACCOUNT_SID=os.environ.get("TWILIO_ACCOUNT_SID"),
        TWILIO_AUTH_TOKEN=os.environ.get("TWILIO_AUTH_TOKEN"),
        TWILIO_FROM_NUMBER=os.environ.get("TWILIO_FROM_NUMBER"),
        MANUAL_EMERGENCY_NUMBER=os.environ.get("MANUAL_EMERGENCY_NUMBER", ""),
        PUBLIC_BASE_URL=(
            os.environ.get("PUBLIC_BASE_URL")
            or os.environ.get("RENDER_EXTERNAL_URL", "")
        ),
        ESCALATION_MINUTES=os.environ.get("ESCALATION_MINUTES", "2"),
        SESSION_COOKIE_SECURE=app_environment == "production",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        MAX_CONTENT_LENGTH=64 * 1024,
    )
    if test_config:
        app.config.update(test_config)
    if app.config["TRUSTED_PROXY_HOPS"] > 0:
        app.wsgi_app = ProxyFix(
            app.wsgi_app,
            x_for=app.config["TRUSTED_PROXY_HOPS"],
            x_proto=app.config["TRUSTED_PROXY_HOPS"],
            x_host=app.config["TRUSTED_PROXY_HOPS"],
        )
    ensure_initial_data(app)

    @app.teardown_appcontext
    def close_db(_error=None):
        connection = g.pop("db", None)
        if connection is not None:
            connection.close()

    @app.before_request
    def require_csrf_for_mutations():
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            token = session.get("csrf_token")
            if not token or not hmac.compare_digest(token, request.headers.get("X-CSRF-Token", "")):
                return error("Request token is missing or expired. Reload the page and try again.", 400)
            if request.path.startswith("/api/") and request.method != "GET" and not request.is_json:
                return error("Requests must use JSON.", 415)

    @app.after_request
    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        )
        if request.is_secure:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(413)
    def request_too_large(_error):
        return jsonify(success=False, error="Request is too large."), 413

    @app.get("/")
    def index():
        return send_from_directory(ROOT, "index.html")

    @app.get("/service-worker.js")
    def service_worker():
        response = send_from_directory(ROOT / "static", "service-worker.js")
        response.headers["Service-Worker-Allowed"] = "/"
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/api/health")
    def health():
        get_db().execute("SELECT 1").fetchone()
        return jsonify(status="healthy", database="connected")

    @app.get("/api/session")
    def get_session():
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_urlsafe(32)
        user = current_user()
        return jsonify(
            user=user,
            csrf_token=session["csrf_token"],
            demo_mode=bool(app.config["SEED_DEMO_USERS"]),
            notification_channels={
                "email": bool(app.config.get("SMTP_HOST") and app.config.get("SMTP_FROM")),
                "sms": bool(app.config.get("TWILIO_ACCOUNT_SID") and app.config.get("TWILIO_AUTH_TOKEN")
                            and app.config.get("TWILIO_FROM_NUMBER")),
            },
            manual_emergency_number=re.sub(r"[^\d+]", "", app.config["MANUAL_EMERGENCY_NUMBER"]),
            escalation_minutes=int(app.config["ESCALATION_MINUTES"]),
        )

    @app.post("/api/login")
    def login():
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        address = request.remote_addr or "unknown"
        now_monotonic = time.monotonic()
        attempts = _login_requests[address]
        while attempts and now_monotonic - attempts[0] > 60:
            attempts.popleft()
        if len(attempts) >= 10:
            return error("Too many sign-in attempts. Try again shortly.", 429)
        attempts.append(now_monotonic)
        try:
            email = validate_text(body.get("email"), "Email", 254).lower()
            password = validate_text(body.get("password"), "Password", 256)
        except ValueError as exc:
            return error(str(exc))
        user = get_db().execute(
            "SELECT * FROM users WHERE email=? COLLATE NOCASE AND active=1", (email,)
        ).fetchone()
        if not user or not check_password_hash(user["password_hash"], password):
            return error("Email or password is incorrect.", 401)
        attempts.clear()
        session.clear()
        session.permanent = True
        session["user_id"] = user["id"]
        session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(success=True, user={
            "id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]
        }, csrf_token=session["csrf_token"])

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(success=True)

    @app.get("/api/elevators")
    def list_elevators():
        rows = get_db().execute(
            """SELECT e.id,e.building,e.location,e.floors,e.status,e.active,
                      e.assigned_rescuer_id,e.assigned_engineer_id,
                      CASE WHEN e.qr_token_hash IS NULL THEN 0 ELSE 1 END qr_configured,
                      r.name rescue_name,m.name engineer_name
               FROM elevators e
               LEFT JOIN users r ON r.id=e.assigned_rescuer_id
               LEFT JOIN users m ON m.id=e.assigned_engineer_id
               WHERE e.active=1 ORDER BY e.building,e.id"""
        ).fetchall()
        return jsonify(elevators=[row_dict(row) for row in rows])

    @app.post("/api/elevators/<elevator_id>/qr-token")
    @roles_required("system_admin")
    def rotate_elevator_qr(elevator_id):
        body = json_body()
        if body is None:
            return error("Invalid JSON request.")
        connection = get_db()
        if not connection.execute(
            "SELECT 1 FROM elevators WHERE id=? AND active=1", (elevator_id,)
        ).fetchone():
            return error("Elevator not found.", 404)
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        public_base_url = app.config["PUBLIC_BASE_URL"]
        if app.config["APP_ENV"] == "production" and not public_base_url:
            return error("PUBLIC_BASE_URL must be configured before generating cabin QR codes.", 503)
        if app.config["APP_ENV"] == "production":
            parsed_base_url = urllib.parse.urlparse(public_base_url)
            if (
                parsed_base_url.scheme != "https"
                or not parsed_base_url.netloc
                or parsed_base_url.path not in ("", "/")
                or parsed_base_url.query
                or parsed_base_url.fragment
            ):
                return error("PUBLIC_BASE_URL must be an HTTPS origin without a path.", 503)
        base_url = (public_base_url or request.url_root).rstrip("/")
        qr_url = (
            f"{base_url}/?elevator={urllib.parse.quote(elevator_id, safe='')}"
            f"#elevator_token={urllib.parse.quote(token, safe='')}"
        )
        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=8,
            border=4,
        )
        qr.add_data(qr_url)
        qr.make(fit=True)
        image = qr.make_image(fill_color="#102238", back_color="#FFFFFF")
        image_buffer = io.BytesIO()
        image.save(image_buffer, format="PNG")
        image_data = "data:image/png;base64," + base64.b64encode(image_buffer.getvalue()).decode()
        with transaction() as connection:
            connection.execute(
                "UPDATE elevators SET qr_token_hash=?,updated_at=? WHERE id=?",
                (token_hash, utc_now(), elevator_id),
            )
            audit(connection, current_user()["id"], "elevator.qr_rotated", "elevator", elevator_id)
        return jsonify(success=True, elevator_id=elevator_id, qr_url=qr_url, qr_image=image_data)

    @app.post("/api/emergencies")
    def create_emergency():
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        address = request.remote_addr or "unknown"
        now_monotonic = time.monotonic()
        requests_from_address = _sos_requests[address]
        while requests_from_address and now_monotonic - requests_from_address[0] > 60:
            requests_from_address.popleft()
        if len(requests_from_address) >= 10:
            return error("Too many emergency submissions from this connection. Try again shortly.", 429)
        requests_from_address.append(now_monotonic)
        try:
            elevator_id = validate_text(body.get("elevator_id"), "Elevator ID", 80)
            category = validate_text(
                body.get("category") or "Trapped inside elevator", "Category", 100
            )
            description = validate_text(body.get("description", ""), "Details", 1000, required=False)
            requester_name = validate_text(body.get("requester_name", ""), "Name", 120, required=False)
            request_id = validate_text(
                body.get("client_request_id") or str(uuid.uuid4()), "Request ID", 80
            )
        except ValueError as exc:
            return error(str(exc))
        if category not in {
            "Trapped inside elevator", "Elevator stopped / fault", "Other urgent issue"
        }:
            return error("Category is not recognized.")

        connection = get_db()
        duplicate = connection.execute(
            "SELECT id FROM emergencies WHERE client_request_id=?", (request_id,)
        ).fetchone()
        if duplicate:
            existing = emergency_query(connection, duplicate["id"])
            token = hmac.new(
                str(app.config["SECRET_KEY"]).encode(), request_id.encode(), hashlib.sha256
            ).hexdigest()
            return jsonify(
                success=True, duplicate=True,
                emergency=public_emergency(existing),
                tracking_token=token,
                delivery_status="recorded",
            )

        elevator = connection.execute(
            "SELECT * FROM elevators WHERE id=? AND active=1", (elevator_id,)
        ).fetchone()
        if not elevator:
            return error("The selected elevator is not registered or is inactive.", 400)
        try:
            elevator_token = validate_text(
                body.get("elevator_token", ""), "Elevator verification token", 128, required=False
            )
        except ValueError as exc:
            return error(str(exc))
        verified = False
        if elevator_token:
            expected_hash = elevator["qr_token_hash"]
            supplied_hash = hashlib.sha256(elevator_token.encode()).hexdigest()
            if not expected_hash or not hmac.compare_digest(supplied_hash, expected_hash):
                return error("This cabin QR is invalid or has been replaced. Select the lift manually and contact staff.", 400)
            verified = True
        if requester_name and current_user():
            requester_id = current_user()["id"]
        else:
            requester_id = None
        emergency_id = f"EM-{datetime.now(timezone.utc).year}-{uuid.uuid4().hex[:6].upper()}"
        tracking_token = hmac.new(
            str(app.config["SECRET_KEY"]).encode(), request_id.encode(), hashlib.sha256
        ).hexdigest()
        token_hash = hashlib.sha256(tracking_token.encode()).hexdigest()
        now = utc_now()

        try:
            with transaction() as tx:
                tx.execute(
                    """INSERT INTO emergencies
                       (id,client_request_id,elevator_id,requester_id,requester_name,category,
                        description,status,tracking_token_hash,verified_elevator,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?,'New',?,?,?,?)""",
                    (emergency_id, request_id, elevator_id, requester_id, requester_name,
                     category, description, token_hash, int(verified), now, now),
                )
                tx.execute(
                    """INSERT INTO emergency_status_history
                       (emergency_id,actor_id,old_status,new_status,note,created_at)
                       VALUES(?,NULL,NULL,'New','SOS received',?)""",
                    (emergency_id, now),
                )
                _configured_channels, recipient_count, queued_count = notification_recipients(
                    tx, emergency_id, elevator_id, "New elevator emergency",
                    f"{emergency_id} · {elevator['building']} · {elevator_id} · {category}"
                )
                audit(tx, requester_id, "emergency.created", "emergency", emergency_id, {
                    "elevator_id": elevator_id,
                    "category": category,
                    "verified_elevator": verified,
                })
                emergency = emergency_query(tx, emergency_id)
        except sqlite3.IntegrityError as exc:
            if "client_request_id" in str(exc):
                duplicate = connection.execute(
                    "SELECT id FROM emergencies WHERE client_request_id=?", (request_id,)
                ).fetchone()
                existing = emergency_query(connection, duplicate["id"]) if duplicate else None
                if existing:
                    return jsonify(
                        success=True, duplicate=True,
                        emergency=public_emergency(existing),
                        tracking_token=tracking_token,
                        delivery_status="recorded",
                    )
            raise

        if not recipient_count:
            delivery_status = "unconfigured"
        elif queued_count:
            delivery_status = "queued"
        else:
            delivery_status = "in_app_only"
        message = {
            "queued": "Request registered. External notifications are queued; use the manual emergency procedure if staff do not respond.",
            "failed": "Request recorded, but an external notification failed. Use the building's manual emergency procedure.",
            "in_app_only": "Request recorded. Staff notifications are available only in the app; no configured external channel reached the response team.",
            "unconfigured": "Request recorded, but no rescue team or administrator accounts are configured. Use the building's manual emergency procedure.",
        }[delivery_status]
        return jsonify(
            success=True,
            emergency=public_emergency(emergency),
            tracking_token=tracking_token,
            delivery_status=delivery_status,
            message=message,
        ), 201

    @app.get("/api/emergencies/<emergency_id>/tracking")
    def track_emergency(emergency_id):
        token = request.headers.get("X-Tracking-Token") or request.args.get("token", "")
        row = emergency_query(get_db(), emergency_id)
        if not row:
            return error("Emergency not found.", 404)
        supplied_hash = hashlib.sha256(token.encode()).hexdigest()
        if not token or not hmac.compare_digest(supplied_hash, row["tracking_token_hash"]):
            return error("Tracking link is invalid.", 403)
        history = get_db().execute(
            """SELECT new_status,note,created_at FROM emergency_status_history
               WHERE emergency_id=? ORDER BY id""",
            (emergency_id,),
        ).fetchall()
        return jsonify(
            emergency=public_emergency(row),
            history=[row_dict(item) for item in history],
        )

    @app.get("/api/emergencies")
    @roles_required("rescue_team", "building_admin", "system_admin")
    def list_emergencies():
        connection = get_db()
        with transaction() as tx:
            escalate_unacknowledged(tx)
        status_filter = request.args.get("status", "")
        query = """SELECT e.*,l.building,l.location,l.floors,l.status elevator_status,
                          u.name rescuer_name
                   FROM emergencies e JOIN elevators l ON l.id=e.elevator_id
                   LEFT JOIN users u ON u.id=e.assigned_rescuer_id"""
        params = []
        if status_filter in EMERGENCY_STATUSES:
            query += " WHERE e.status=?"
            params.append(status_filter)
        query += " ORDER BY e.created_at DESC LIMIT 200"
        rows = connection.execute(query, params).fetchall()
        return jsonify(emergencies=[public_emergency(row, include_private=True) for row in rows])

    @app.post("/api/notifications/retry")
    @roles_required("system_admin")
    def retry_failed_notifications():
        with transaction() as connection:
            connection.execute(
                """UPDATE notification_outbox SET status='Pending',last_error='',updated_at=?
                   WHERE status='Failed'""",
                (utc_now(),),
            )
            emergency_ids = [
                row["emergency_id"] for row in connection.execute(
                    "SELECT DISTINCT emergency_id FROM notification_outbox WHERE status='Pending'"
                ).fetchall()
            ]
            audit(connection, current_user()["id"], "notifications.retry_requested",
                  "notification_outbox", "all")
        return jsonify(success=True, queued=len(emergency_ids))

    @app.get("/api/notifications/delivery")
    @roles_required("system_admin")
    def notification_delivery_status():
        counts = get_db().execute(
            """SELECT channel,status,COUNT(*) count FROM notification_outbox
               GROUP BY channel,status ORDER BY channel,status"""
        ).fetchall()
        failures = get_db().execute(
            """SELECT o.id,o.channel,o.attempts,o.last_error,o.updated_at,
                      e.id emergency_id,u.email
               FROM notification_outbox o
               JOIN emergencies e ON e.id=o.emergency_id
               JOIN users u ON u.id=o.user_id
               WHERE o.status='Failed' ORDER BY o.updated_at DESC LIMIT 20"""
        ).fetchall()
        return jsonify(
            counts=[row_dict(row) for row in counts],
            failures=[row_dict(row) for row in failures],
        )

    @app.post("/api/emergencies/<emergency_id>/accept")
    @roles_required("rescue_team", "building_admin", "system_admin")
    def accept_emergency(emergency_id):
        user = current_user()
        with transaction() as connection:
            incident = emergency_query(connection, emergency_id)
            if not incident:
                return error("Emergency not found.", 404)
            if incident["status"] != "New":
                return error("This emergency has already been accepted or closed.", 409)
            now = utc_now()
            connection.execute(
                """UPDATE emergencies SET status='Accepted',assigned_rescuer_id=?,updated_at=?
                   WHERE id=? AND status='New'""",
                (user["id"], now, emergency_id),
            )
            connection.execute(
                """INSERT INTO emergency_status_history
                   (emergency_id,actor_id,old_status,new_status,note,created_at)
                   VALUES(?,?,'New','Accepted','Rescue request accepted',?)""",
                (emergency_id, user["id"], now),
            )
            audit(connection, user["id"], "emergency.accepted", "emergency", emergency_id)
        return jsonify(success=True, emergency=public_emergency(emergency_query(get_db(), emergency_id), True))

    @app.post("/api/emergencies/<emergency_id>/status")
    @roles_required("rescue_team", "building_admin", "system_admin")
    def update_emergency_status(emergency_id):
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        user = current_user()
        new_status = body.get("status")
        note = body.get("note", "")
        if not isinstance(new_status, str):
            return error("Status must be a recognized text value.")
        if not isinstance(body.get("maintenance_required", False), bool):
            return error("maintenance_required must be true or false.")
        try:
            note = validate_text(note, "Status note", 500, required=False)
        except ValueError as exc:
            return error(str(exc))
        transition = {
            "Accepted": {"In Progress"},
            "In Progress": {"Resolved"},
            "Resolved": {"Closed"},
        }
        with transaction() as connection:
            incident = emergency_query(connection, emergency_id)
            if not incident:
                return error("Emergency not found.", 404)
            if incident["status"] == "New" and new_status == "Accepted":
                return error("Use the accept action to take responsibility for an emergency.", 409)
            if new_status not in transition.get(incident["status"], set()):
                return error(f"Invalid status transition from {incident['status']} to {new_status}.", 409)
            if new_status == "Closed" and user["role"] not in {"building_admin", "system_admin"}:
                return error("Only an administrator can close a resolved emergency.", 403)
            if incident["assigned_rescuer_id"] and incident["assigned_rescuer_id"] != user["id"] \
                    and user["role"] == "rescue_team":
                return error("This emergency is assigned to another responder.", 403)
            now = utc_now()
            maintenance_required = bool(body.get("maintenance_required", False))
            connection.execute(
                """UPDATE emergencies SET status=?,maintenance_required=?,updated_at=?
                   WHERE id=?""",
                (new_status, int(maintenance_required or incident["maintenance_required"]), now, emergency_id),
            )
            connection.execute(
                """INSERT INTO emergency_status_history
                   (emergency_id,actor_id,old_status,new_status,note,created_at)
                   VALUES(?,?,?,?,?,?)""",
                (emergency_id, user["id"], incident["status"], new_status, note, now),
            )
            audit(connection, user["id"], "emergency.status_updated", "emergency", emergency_id,
                  {"from": incident["status"], "to": new_status, "note": note})
            if new_status == "Resolved" and (
                maintenance_required or incident["category"] == "Elevator stopped / fault"
            ):
                create_maintenance_request(
                    connection, incident,
                    f"Post-incident inspection for {emergency_id}: {note or incident['category']}",
                )
        return jsonify(success=True, emergency=public_emergency(emergency_query(get_db(), emergency_id), True))

    @app.get("/api/emergency-history")
    @roles_required("building_admin", "system_admin")
    def emergency_history():
        rows = get_db().execute(
            """SELECT e.*,l.building,l.location,l.floors,l.status elevator_status,
                      u.name rescuer_name
               FROM emergencies e JOIN elevators l ON l.id=e.elevator_id
               LEFT JOIN users u ON u.id=e.assigned_rescuer_id
               ORDER BY e.created_at DESC LIMIT 500"""
        ).fetchall()
        return jsonify(emergencies=[public_emergency(row, True) for row in rows])

    @app.get("/api/reports/emergencies.csv")
    @roles_required("building_admin", "system_admin")
    def emergency_report():
        rows = get_db().execute(
            """SELECT e.id,e.created_at,e.status,e.category,e.description,e.requester_name,
                      e.elevator_id,l.building,l.location,u.name rescuer
               FROM emergencies e JOIN elevators l ON l.id=e.elevator_id
               LEFT JOIN users u ON u.id=e.assigned_rescuer_id
               ORDER BY e.created_at DESC"""
        ).fetchall()
        stream = io.StringIO()
        writer = csv.writer(stream)
        writer.writerow(["Emergency ID","Created","Status","Category","Description","Requester",
                         "Elevator ID","Building","Location","Rescuer"])
        for row in rows:
            values = [row[key] or "" for key in row.keys()]
            writer.writerow([
                "'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t")) else value
                for value in values
            ])
        return Response(stream.getvalue(), mimetype="text/csv", headers={
            "Content-Disposition": "attachment; filename=liftline-emergency-history.csv"
        })

    @app.get("/api/maintenance")
    @roles_required("maintenance_engineer", "building_admin", "system_admin")
    def list_maintenance():
        user = current_user()
        query = """SELECT m.*,e.building,e.location,e.floors,u.name engineer_name
                   FROM maintenance_requests m
                   JOIN elevators e ON e.id=m.elevator_id
                   LEFT JOIN users u ON u.id=m.assigned_engineer_id"""
        params = []
        if user["role"] == "maintenance_engineer":
            query += " WHERE m.assigned_engineer_id IS NULL OR m.assigned_engineer_id=?"
            params.append(user["id"])
        query += " ORDER BY m.created_at DESC"
        requests_list = get_db().execute(query, params).fetchall()
        result = []
        for item in requests_list:
            record_rows = get_db().execute(
                """SELECT r.*,u.name engineer_name FROM maintenance_records r
                   JOIN users u ON u.id=r.engineer_id WHERE r.request_id=? ORDER BY r.created_at""",
                (item["id"],),
            ).fetchall()
            value = row_dict(item)
            value["records"] = [row_dict(record) for record in record_rows]
            result.append(value)
        return jsonify(requests=result)

    @app.post("/api/maintenance")
    @roles_required("rescue_team", "building_admin", "system_admin", "maintenance_engineer")
    def create_maintenance():
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        try:
            elevator_id = validate_text(body.get("elevator_id"), "Elevator ID", 80)
            description = validate_text(body.get("description"), "Maintenance description", 1000)
            priority = validate_text(body.get("priority", "Normal"), "Priority", 20)
        except ValueError as exc:
            return error(str(exc))
        if priority not in {"Low", "Normal", "High", "Urgent"}:
            return error("Priority must be Low, Normal, High, or Urgent.")
        connection = get_db()
        if not connection.execute("SELECT 1 FROM elevators WHERE id=? AND active=1", (elevator_id,)).fetchone():
            return error("Elevator is not registered or is inactive.", 400)
        request_id = "WO-" + uuid.uuid4().hex[:8].upper()
        with transaction() as connection:
            elevator = connection.execute(
                "SELECT assigned_engineer_id FROM elevators WHERE id=?", (elevator_id,)
            ).fetchone()
            now = utc_now()
            connection.execute(
                """INSERT INTO maintenance_requests
                   (id,elevator_id,assigned_engineer_id,description,priority,status,created_at,updated_at)
                   VALUES(?,?,?,?,?,'Open',?,?)""",
                (request_id, elevator_id, elevator["assigned_engineer_id"], description, priority, now, now),
            )
            connection.execute(
                "UPDATE elevators SET status='Under maintenance',updated_at=? WHERE id=?",
                (now, elevator_id),
            )
            if elevator["assigned_engineer_id"]:
                connection.execute(
                    """INSERT INTO notifications(id,user_id,title,message,created_at)
                       VALUES(?,?,'New maintenance request',?,?)""",
                    (
                        new_id(),
                        elevator["assigned_engineer_id"],
                        f"{request_id} for {elevator_id}: {description}",
                        now,
                    ),
                )
            audit(connection, current_user()["id"], "maintenance.created", "maintenance_request",
                  request_id, {"elevator_id": elevator_id})
        return jsonify(success=True, request_id=request_id), 201

    @app.post("/api/maintenance/<request_id>/records")
    @roles_required("maintenance_engineer", "building_admin", "system_admin")
    def add_maintenance_record(request_id):
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        try:
            inspection = validate_text(body.get("inspection_details"), "Inspection details", 2000)
            repair = validate_text(body.get("repair_details", ""), "Repair details", 2000, required=False)
            remarks = validate_text(body.get("remarks", ""), "Remarks", 1000, required=False)
        except ValueError as exc:
            return error(str(exc))
        user = current_user()
        with transaction() as connection:
            work = connection.execute(
                "SELECT * FROM maintenance_requests WHERE id=?", (request_id,)
            ).fetchone()
            if not work:
                return error("Maintenance request not found.", 404)
            if user["role"] == "maintenance_engineer" and work["assigned_engineer_id"] not in (None, user["id"]):
                return error("This work order is assigned to another engineer.", 403)
            now = utc_now()
            record_id = new_id()
            connection.execute(
                """INSERT INTO maintenance_records
                   (id,request_id,engineer_id,inspection_details,repair_details,remarks,created_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (record_id, request_id, user["id"], inspection, repair, remarks, now),
            )
            connection.execute(
                """UPDATE maintenance_requests SET assigned_engineer_id=?,
                   status=CASE WHEN status='Open' THEN 'In Progress' ELSE status END,updated_at=?
                   WHERE id=?""",
                (user["id"], now, request_id),
            )
            audit(connection, user["id"], "maintenance.record_added", "maintenance_request",
                  request_id, {"record_id": record_id})
        return jsonify(success=True, record_id=record_id), 201

    @app.post("/api/maintenance/<request_id>/close")
    @roles_required("maintenance_engineer", "building_admin", "system_admin")
    def close_maintenance(request_id):
        user = current_user()
        with transaction() as connection:
            work = connection.execute(
                "SELECT * FROM maintenance_requests WHERE id=?", (request_id,)
            ).fetchone()
            if not work:
                return error("Maintenance request not found.", 404)
            if user["role"] == "maintenance_engineer" and work["assigned_engineer_id"] not in (None, user["id"]):
                return error("This work order is assigned to another engineer.", 403)
            if not connection.execute(
                "SELECT 1 FROM maintenance_records WHERE request_id=?", (request_id,)
            ).fetchone():
                return error("Add an inspection record before closing this request.", 409)
            now = utc_now()
            connection.execute(
                "UPDATE maintenance_requests SET status='Closed',updated_at=? WHERE id=?",
                (now, request_id),
            )
            open_work = connection.execute(
                """SELECT 1 FROM maintenance_requests
                   WHERE elevator_id=? AND id!=? AND status NOT IN ('Closed','Completed') LIMIT 1""",
                (work["elevator_id"], request_id),
            ).fetchone()
            if not open_work:
                connection.execute(
                    "UPDATE elevators SET status='Operational',updated_at=? WHERE id=?",
                    (now, work["elevator_id"]),
                )
            audit(connection, user["id"], "maintenance.closed", "maintenance_request", request_id)
        return jsonify(success=True)

    @app.get("/api/notifications")
    @roles_required("rescue_team", "building_admin", "maintenance_engineer", "system_admin")
    def list_notifications():
        rows = get_db().execute(
            """SELECT id,title,message,emergency_id,read_at,created_at
               FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100""",
            (current_user()["id"],),
        ).fetchall()
        return jsonify(notifications=[row_dict(row) for row in rows])

    @app.post("/api/notifications/<notification_id>/read")
    @roles_required("rescue_team", "building_admin", "maintenance_engineer", "system_admin")
    def mark_notification_read(notification_id):
        with transaction() as connection:
            cursor = connection.execute(
                "UPDATE notifications SET read_at=? WHERE id=? AND user_id=?",
                (utc_now(), notification_id, current_user()["id"]),
            )
            if cursor.rowcount == 0:
                return error("Notification not found.", 404)
        return jsonify(success=True)

    @app.get("/api/users")
    @roles_required("system_admin")
    def list_users():
        rows = get_db().execute(
            """SELECT id,name,email,phone,role,active,created_at,updated_at
               FROM users ORDER BY name"""
        ).fetchall()
        return jsonify(users=[row_dict(row) for row in rows])

    @app.post("/api/users")
    @roles_required("system_admin")
    def add_user():
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        try:
            name = validate_text(body.get("name"), "Name", 120)
            email = validate_text(body.get("email"), "Email", 254)
            password = validate_text(body.get("password"), "Password", 256)
            phone = validate_text(body.get("phone", ""), "Phone", 40, required=False)
        except ValueError as exc:
            return error(str(exc))
        role = body.get("role")
        if not isinstance(role, str) or role not in ROLE_NAMES:
            return error("Role is not recognized.")
        if len(password) < 12:
            return error("Password must contain at least 12 characters.")
        with transaction() as connection:
            try:
                user_id = create_user(connection, name, email, role, password, phone)
            except ValueError as exc:
                return error(str(exc))
            except sqlite3.IntegrityError:
                return error("A user with this email already exists.", 409)
            audit(connection, current_user()["id"], "user.created", "user", user_id, {"role": role})
        return jsonify(success=True, user_id=user_id), 201

    @app.put("/api/users/<user_id>")
    @roles_required("system_admin")
    def update_user(user_id):
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        try:
            name = validate_text(body.get("name"), "Name", 120)
            email = validate_text(body.get("email"), "Email", 254).lower()
            phone = validate_text(body.get("phone", ""), "Phone", 40, required=False)
            password = validate_text(body.get("password", ""), "Password", 256, required=False)
        except ValueError as exc:
            return error(str(exc))
        role = body.get("role")
        if not isinstance(role, str) or role not in ROLE_NAMES:
            return error("Role is not recognized.")
        if password and len(password) < 12:
            return error("Password must contain at least 12 characters.")
        if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
            return error("Email address is invalid.")
        active_value = body.get("active", True)
        if not isinstance(active_value, bool):
            return error("Account status must be true or false.")
        active = 1 if active_value else 0
        with transaction() as connection:
            existing = connection.execute("SELECT role,active FROM users WHERE id=?", (user_id,)).fetchone()
            if not existing:
                return error("User not found.", 404)
            if existing["role"] == "system_admin" and existing["active"] and (
                role != "system_admin" or not active
            ):
                remaining_admins = connection.execute(
                    """SELECT COUNT(*) FROM users
                       WHERE role='system_admin' AND active=1 AND id!=?""",
                    (user_id,),
                ).fetchone()[0]
                if remaining_admins == 0:
                    return error("At least one active system administrator must remain.", 409)
            if current_user()["id"] == user_id and not active:
                return error("You cannot deactivate your own account.", 409)
            try:
                if password:
                    connection.execute(
                        """UPDATE users SET name=?,email=?,phone=?,role=?,active=?,password_hash=?,updated_at=?
                           WHERE id=?""",
                        (name, email, phone, role, active, generate_password_hash(password), utc_now(), user_id),
                    )
                else:
                    connection.execute(
                        """UPDATE users SET name=?,email=?,phone=?,role=?,active=?,updated_at=?
                           WHERE id=?""",
                        (name, email, phone, role, active, utc_now(), user_id),
                    )
            except sqlite3.IntegrityError:
                return error("A user with this email already exists.", 409)
            audit(connection, current_user()["id"], "user.updated", "user", user_id,
                  {"role": role, "active": bool(active), "password_changed": bool(password)})
        return jsonify(success=True)

    @app.post("/api/users/<user_id>/deactivate")
    @roles_required("system_admin")
    def deactivate_user(user_id):
        if current_user()["id"] == user_id:
            return error("You cannot deactivate your own account.", 409)
        with transaction() as connection:
            target = connection.execute(
                "SELECT role,active FROM users WHERE id=?", (user_id,)
            ).fetchone()
            if not target:
                return error("User not found.", 404)
            if target["role"] == "system_admin" and target["active"]:
                remaining_admins = connection.execute(
                    """SELECT COUNT(*) FROM users
                       WHERE role='system_admin' AND active=1 AND id!=?""",
                    (user_id,),
                ).fetchone()[0]
                if remaining_admins == 0:
                    return error("At least one active system administrator must remain.", 409)
            cursor = connection.execute(
                "UPDATE users SET active=0,updated_at=? WHERE id=?",
                (utc_now(), user_id),
            )
            if cursor.rowcount == 0:
                return error("User not found.", 404)
            audit(connection, current_user()["id"], "user.deactivated", "user", user_id)
        return jsonify(success=True)

    @app.post("/api/elevators")
    @roles_required("system_admin")
    def add_elevator():
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        try:
            elevator_id = validate_text(body.get("id"), "Elevator ID", 80)
            building = validate_text(body.get("building"), "Building", 120)
            location = validate_text(body.get("location"), "Location", 240)
            floors = validate_text(body.get("floors"), "Floors", 240)
            status = validate_text(body.get("status", "Unknown"), "Status", 40)
        except ValueError as exc:
            return error(str(exc))
        if status not in {"Operational", "Under maintenance", "Offline", "Unknown"}:
            return error("Elevator status is not recognized.")
        try:
            rescuer_id = validate_text(body.get("assigned_rescuer_id", ""), "Responder ID", 80, required=False) or None
            engineer_id = validate_text(body.get("assigned_engineer_id", ""), "Engineer ID", 80, required=False) or None
        except ValueError as exc:
            return error(str(exc))
        with transaction() as connection:
            if rescuer_id and not connection.execute(
                "SELECT 1 FROM users WHERE id=? AND role='rescue_team' AND active=1", (rescuer_id,)
            ).fetchone():
                return error("Assigned responder must be an active rescue-team user.", 400)
            if engineer_id and not connection.execute(
                "SELECT 1 FROM users WHERE id=? AND role='maintenance_engineer' AND active=1", (engineer_id,)
            ).fetchone():
                return error("Assigned engineer must be an active maintenance user.", 400)
            try:
                connection.execute(
                    """INSERT INTO elevators
                       (id,building,location,floors,status,assigned_rescuer_id,assigned_engineer_id,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?)""",
                    (elevator_id, building, location, floors, status, rescuer_id, engineer_id,
                     utc_now(), utc_now()),
                )
            except sqlite3.IntegrityError:
                return error("Elevator ID already exists or an assignee is invalid.", 409)
            audit(connection, current_user()["id"], "elevator.created", "elevator", elevator_id,
                  {"building": building, "location": location})
        return jsonify(success=True, elevator_id=elevator_id), 201

    @app.put("/api/elevators/<elevator_id>")
    @roles_required("system_admin")
    def update_elevator(elevator_id):
        body = json_body()
        if not body:
            return error("Invalid JSON request.")
        try:
            building = validate_text(body.get("building"), "Building", 120)
            location = validate_text(body.get("location"), "Location", 240)
            floors = validate_text(body.get("floors"), "Floors", 240)
            status = validate_text(body.get("status", "Unknown"), "Status", 40)
        except ValueError as exc:
            return error(str(exc))
        if status not in {"Operational", "Under maintenance", "Offline", "Unknown"}:
            return error("Elevator status is not recognized.")
        try:
            rescuer_id = validate_text(body.get("assigned_rescuer_id", ""), "Responder ID", 80, required=False) or None
            engineer_id = validate_text(body.get("assigned_engineer_id", ""), "Engineer ID", 80, required=False) or None
        except ValueError as exc:
            return error(str(exc))
        with transaction() as connection:
            if rescuer_id and not connection.execute(
                "SELECT 1 FROM users WHERE id=? AND role='rescue_team' AND active=1", (rescuer_id,)
            ).fetchone():
                return error("Assigned responder must be an active rescue-team user.", 400)
            if engineer_id and not connection.execute(
                "SELECT 1 FROM users WHERE id=? AND role='maintenance_engineer' AND active=1", (engineer_id,)
            ).fetchone():
                return error("Assigned engineer must be an active maintenance user.", 400)
            cursor = connection.execute(
                """UPDATE elevators SET building=?,location=?,floors=?,status=?,
                   assigned_rescuer_id=?,assigned_engineer_id=?,updated_at=? WHERE id=? AND active=1""",
                (building, location, floors, status, rescuer_id, engineer_id, utc_now(), elevator_id),
            )
            if cursor.rowcount == 0:
                return error("Elevator not found.", 404)
            audit(connection, current_user()["id"], "elevator.updated", "elevator", elevator_id,
                  {"building": building, "location": location, "status": status})
        return jsonify(success=True)

    @app.post("/api/elevators/<elevator_id>/deactivate")
    @roles_required("system_admin")
    def deactivate_elevator(elevator_id):
        with transaction() as connection:
            cursor = connection.execute(
                "UPDATE elevators SET active=0,updated_at=? WHERE id=? AND active=1",
                (utc_now(), elevator_id),
            )
            if cursor.rowcount == 0:
                return error("Elevator not found.", 404)
            audit(connection, current_user()["id"], "elevator.deactivated", "elevator", elevator_id)
        return jsonify(success=True)

    @app.get("/api/audit")
    @roles_required("system_admin")
    def audit_history():
        rows = get_db().execute(
            """SELECT a.id,a.action,a.entity_type,a.entity_id,a.details,a.created_at,u.name actor
               FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
               ORDER BY a.id DESC LIMIT 500"""
        ).fetchall()
        return jsonify(entries=[row_dict(row) for row in rows])

    @app.cli.command("create-admin")
    @click.option("--name", prompt=True)
    @click.option("--email", prompt=True)
    @click.password_option()
    def create_admin(name, email, password):
        """Create the initial system administrator."""
        with app.app_context():
            try:
                with transaction() as connection:
                    user_id = create_user(connection, name, email, "system_admin", password)
                click.echo(f"Created administrator {email} ({user_id}).")
            except sqlite3.IntegrityError:
                raise click.ClickException("That email is already registered.")

    if app.config["ENABLE_BACKGROUND_WORKER"] and not app.config.get("TESTING"):
        start_escalation_worker(app)

    return app


def start_escalation_worker(app: Flask):
    def run():
        while True:
            try:
                with app.app_context():
                    with transaction() as connection:
                        retry_cutoff = (
                            datetime.now(timezone.utc) - timedelta(minutes=5)
                        ).isoformat(timespec="seconds")
                        connection.execute(
                            """UPDATE notification_outbox SET status='Pending',updated_at=?
                               WHERE status='Sending' AND updated_at<=?""",
                            (utc_now(), retry_cutoff),
                        )
                        escalated = escalate_unacknowledged(connection)
                        pending = [
                            row["emergency_id"] for row in connection.execute(
                                """SELECT DISTINCT emergency_id FROM notification_outbox
                                   WHERE status='Pending' LIMIT 50"""
                            ).fetchall()
                        ]
                    for emergency_id in set(escalated + pending):
                        dispatch_outbox(emergency_id)
            except Exception:
                app.logger.exception("The emergency escalation worker failed.")
            time.sleep(5)

    threading.Thread(target=run, name="liftline-escalation", daemon=True).start()


app = create_app()

if __name__ == "__main__":
    from waitress import serve

    host = "0.0.0.0" if app.config["APP_ENV"] == "production" else "127.0.0.1"
    serve(app, host=host, port=int(os.environ.get("PORT", "4174")))

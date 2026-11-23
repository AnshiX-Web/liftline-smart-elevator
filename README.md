# Liftline — Smart Elevator Emergency Rescue Alert System

Liftline is the working web application for the report’s first software increment. It implements the passenger SOS path, role-controlled rescue and maintenance workspaces, administrator monitoring/history, and elevator/user administration.

## Implemented workflows

- **Passenger:** one-tap SOS with a registered lift, default “Trapped inside elevator” category, request reference, private status-tracking link, and optional detail/name fields.
- **Rescue team:** live incident queue, accept/assign, move an incident through In Progress and Resolved, and optionally generate a linked maintenance request.
- **Building administrator:** active incident monitoring, timed escalation to administrator accounts while the service is running, incident history, and CSV export.
- **Maintenance engineer:** assigned service queue, inspection/repair records, and request closure.
- **System administrator:** role-based user management, elevator registry, responder/engineer assignment, and audit history.
- **Cabin identification:** generate and download a one-time-verification QR for each registered elevator; rotating the code invalidates the previous sticker.
- **Reliability and security:** SQLite persistence, password hashing, role checks, CSRF protection, input limits, duplicate suppression, audit timestamps, offline SOS outbox with retry, and notification outbox records.

The app does not control elevator machinery or security doors. Sensor/IoT gateways, GPS, predictive AI, voice/video, multilingual UI, and police/fire/ambulance dispatch are future integrations in the report, not implemented capabilities.

## Run locally (Windows PowerShell)

Requires Python 3.12 or later.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-preview.ps1
```

Open `http://127.0.0.1:4174/`. The preview script seeds sample elevators and local-only demo accounts:

| Role | Email |
|---|---|
| Building administrator | `admin@demo.local` |
| System administrator | `sysadmin@demo.local` |
| Rescue team | `rescue@demo.local` |
| Maintenance engineer | `maintenance@demo.local` |

Demo password: `Liftline-Demo-2026!`. These accounts are enabled only by the local preview script; never use them in a public deployment.

Data is stored in `instance/liftline.sqlite`. Run the test suite with:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

## Production setup

The application is a Flask server, not a static site. GitHub Pages cannot run its API or database. Build the included container and deploy it to a host that provides HTTPS and a **persistent volume** mounted at `/data`.

For a container host, build with `docker build -t liftline .`, configure the required environment variables in the host’s secret manager, and mount persistent storage at `/data`. The container listens on `PORT` (default `8000`). Never enable demo seeding in production.

### Fast Render launch

After this repository is pushed to its public `main` branch, use the [Render Blueprint](https://render.com/deploy?repo=https://github.com/AnshiX-Web/liftline-smart-elevator). It provisions the Docker app, HTTPS health check, and a 1 GB persistent disk in Singapore. Render will prompt for `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`; choose a unique email and a password of at least 12 characters. Review Render’s displayed pricing before confirming—the persistent disk and web service are paid resources. Render supplies the public service URL automatically for cabin QR codes. Email/SMS remain in-app only until you add provider credentials in the Render dashboard.

Required production settings:

- `APP_ENV=production`
- `SECRET_KEY` — a long random secret
- `DATABASE_PATH=/data/liftline.sqlite`
- `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` for the first system administrator (password must be at least 12 characters)
- `PUBLIC_BASE_URL` — optional HTTPS site origin used in cabin QR codes; Render’s generated HTTPS URL is used automatically if omitted
- `TRUSTED_PROXY_HOPS` — set only to the exact number of trusted reverse proxies in front of the app; leave `0` when directly exposed

Optional notification settings are `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and the `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` variables. `MANUAL_EMERGENCY_NUMBER` can provide a phone number for the passenger’s explicit native-SMS fallback link when offline. Configure these as host secrets/settings, not in source control. Add staff accounts with current contact details and test delivery before inviting students.

Without an email/SMS provider, the app records in-app notifications only. A request confirmation is **not proof that staff received or acted on it**. Offline requests remain in browser storage on that device until a connection returns; they are not sent while offline. Avoid shared/public devices and clear local browser data after testing. Students must use the elevator intercom or the college’s established emergency procedure if the app/network is unavailable. External emergency services are not automatically contacted.

The SQLite deployment is suitable for a single persistent app instance. It does not by itself provide the report’s 24×7/high-availability target; use managed backups, uptime monitoring, and an appropriately redundant production database/host before operational campus use.

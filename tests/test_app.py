import os
import tempfile
import urllib.parse
import unittest

from app import _login_requests, _sos_requests, create_app


class LiftlineAppTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-key-not-for-production",
            "DATABASE": os.path.join(self.temp_dir.name, "test.sqlite"),
            "SEED_DEMO_USERS": True,
            "ESCALATION_MINUTES": 1,
        })
        self.client = self.app.test_client()
        _login_requests.clear()
        _sos_requests.clear()

    def tearDown(self):
        self.temp_dir.cleanup()

    def token(self, client=None):
        return (client or self.client).get("/api/session").get_json()["csrf_token"]

    def login(self, email, client=None):
        client = client or self.client
        token = self.token(client)
        response = client.post(
            "/api/login",
            json={"email": email, "password": "Liftline-Demo-2026!"},
            headers={"X-CSRF-Token": token},
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["csrf_token"]

    def test_public_sos_defaults_category_is_idempotent_and_trackable(self):
        csrf = self.token()
        payload = {"elevator_id": "ELV-104", "client_request_id": "offline-request-1"}
        response = self.client.post(
            "/api/emergencies", json=payload, headers={"X-CSRF-Token": csrf}
        )
        self.assertEqual(response.status_code, 201, response.get_json())
        result = response.get_json()
        self.assertEqual(result["emergency"]["category"], "Trapped inside elevator")
        self.assertEqual(result["emergency"]["status"], "New")
        self.assertEqual(result["delivery_status"], "in_app_only")

        duplicate = self.client.post(
            "/api/emergencies", json=payload, headers={"X-CSRF-Token": csrf}
        )
        self.assertEqual(duplicate.status_code, 200)
        self.assertTrue(duplicate.get_json()["duplicate"])
        self.assertEqual(duplicate.get_json()["emergency"]["id"], result["emergency"]["id"])

        tracking = self.client.get(
            f"/api/emergencies/{result['emergency']['id']}/tracking",
            query_string={"token": result["tracking_token"]},
        )
        self.assertEqual(tracking.status_code, 200)
        self.assertEqual(tracking.get_json()["emergency"]["status"], "New")
        self.assertEqual(len(tracking.get_json()["history"]), 1)
        private_link = self.client.get(
            f"/api/emergencies/{result['emergency']['id']}/tracking",
            headers={"X-Tracking-Token": result["tracking_token"]},
        )
        self.assertEqual(private_link.status_code, 200)

        rejected = self.client.get(
            f"/api/emergencies/{result['emergency']['id']}/tracking",
            query_string={"token": "invalid"},
        )
        self.assertEqual(rejected.status_code, 403)

    def test_sos_rejects_unregistered_elevator_and_missing_csrf(self):
        body = {"elevator_id": "ELV-DOES-NOT-EXIST", "client_request_id": "invalid-elevator"}
        csrf = self.token()
        response = self.client.post(
            "/api/emergencies", json=body, headers={"X-CSRF-Token": csrf}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("not registered", response.get_json()["error"])
        missing_token = self.client.post("/api/emergencies", json=body)
        self.assertEqual(missing_token.status_code, 400)

    def test_rescue_lifecycle_generates_maintenance_and_engineer_closes_it(self):
        public_csrf = self.token()
        created = self.client.post(
            "/api/emergencies",
            json={
                "elevator_id": "ELV-104",
                "client_request_id": "lifecycle-request",
                "category": "Elevator stopped / fault",
            },
            headers={"X-CSRF-Token": public_csrf},
        ).get_json()["emergency"]
        emergency_id = created["id"]

        rescue_client = self.app.test_client()
        rescue_csrf = self.login("rescue@demo.local", rescue_client)
        accepted = rescue_client.post(
            f"/api/emergencies/{emergency_id}/accept",
            json={},
            headers={"X-CSRF-Token": rescue_csrf},
        )
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.get_json()["emergency"]["status"], "Accepted")

        progressed = rescue_client.post(
            f"/api/emergencies/{emergency_id}/status",
            json={"status": "In Progress", "note": "Responder reached the lift"},
            headers={"X-CSRF-Token": rescue_csrf},
        )
        self.assertEqual(progressed.status_code, 200)
        resolved = rescue_client.post(
            f"/api/emergencies/{emergency_id}/status",
            json={"status": "Resolved", "maintenance_required": True},
            headers={"X-CSRF-Token": rescue_csrf},
        )
        self.assertEqual(resolved.status_code, 200)
        self.assertEqual(resolved.get_json()["emergency"]["status"], "Resolved")
        status = next(
            item for item in rescue_client.get("/api/elevators").get_json()["elevators"]
            if item["id"] == "ELV-104"
        )["status"]
        self.assertEqual(status, "Under maintenance")

        engineer_client = self.app.test_client()
        engineer_csrf = self.login("maintenance@demo.local", engineer_client)
        work_orders = engineer_client.get("/api/maintenance").get_json()["requests"]
        self.assertEqual(len(work_orders), 1)
        work_order_id = work_orders[0]["id"]
        record = engineer_client.post(
            f"/api/maintenance/{work_order_id}/records",
            json={
                "inspection_details": "Inspected interlock and door sensor",
                "repair_details": "Replaced damaged sensor",
            },
            headers={"X-CSRF-Token": engineer_csrf},
        )
        self.assertEqual(record.status_code, 201, record.get_json())
        closed = engineer_client.post(
            f"/api/maintenance/{work_order_id}/close",
            json={},
            headers={"X-CSRF-Token": engineer_csrf},
        )
        self.assertEqual(closed.status_code, 200)
        refreshed = engineer_client.get("/api/maintenance").get_json()["requests"][0]
        self.assertEqual(refreshed["status"], "Closed")
        self.assertEqual(len(refreshed["records"]), 1)
        elevator_status = next(
            item for item in engineer_client.get("/api/elevators").get_json()["elevators"]
            if item["id"] == "ELV-104"
        )["status"]
        self.assertEqual(elevator_status, "Operational")

        admin_client = self.app.test_client()
        self.login("admin@demo.local", admin_client)
        history = admin_client.get("/api/emergency-history")
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.get_json()["emergencies"][0]["status"], "Resolved")
        report = admin_client.get("/api/reports/emergencies.csv")
        self.assertEqual(report.status_code, 200)
        self.assertIn("Emergency ID", report.get_data(as_text=True))

    def test_role_permissions_and_system_admin_management(self):
        engineer_client = self.app.test_client()
        engineer_csrf = self.login("maintenance@demo.local", engineer_client)
        self.assertEqual(engineer_client.get("/api/emergency-history").status_code, 403)
        denied = engineer_client.post(
            "/api/users",
            json={"name": "Unauthorized", "email": "unauthorized@example.test",
                  "password": "LongEnoughPassword!", "role": "system_admin"},
            headers={"X-CSRF-Token": engineer_csrf},
        )
        self.assertEqual(denied.status_code, 403)

        admin_client = self.app.test_client()
        admin_csrf = self.login("sysadmin@demo.local", admin_client)
        seeded_users = admin_client.get("/api/users").get_json()["users"]
        rescue_id = next(item["id"] for item in seeded_users if item["role"] == "rescue_team")
        engineer_id = next(item["id"] for item in seeded_users if item["role"] == "maintenance_engineer")
        created_user = admin_client.post(
            "/api/users",
            json={"name": "Test Responder", "email": "responder@example.test",
                  "password": "LongEnoughPassword!", "role": "rescue_team"},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(created_user.status_code, 201, created_user.get_json())
        user_id = created_user.get_json()["user_id"]
        deactivated = admin_client.post(
            f"/api/users/{user_id}/deactivate",
            json={},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(deactivated.status_code, 200)

        elevator = admin_client.post(
            "/api/elevators",
            json={"id": "ELV-777", "building": "Test block", "location": "Lobby",
                  "floors": "Ground, 1", "status": "Unknown",
                  "assigned_rescuer_id": rescue_id, "assigned_engineer_id": engineer_id},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(elevator.status_code, 201, elevator.get_json())
        registered = next(
            item for item in admin_client.get("/api/elevators").get_json()["elevators"]
            if item["id"] == "ELV-777"
        )
        self.assertEqual(registered["assigned_rescuer_id"], rescue_id)
        self.assertEqual(registered["assigned_engineer_id"], engineer_id)

        qr = admin_client.post(
            "/api/elevators/ELV-777/qr-token",
            json={},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(qr.status_code, 200, qr.get_json())
        qr_data = qr.get_json()
        self.assertTrue(qr_data["qr_image"].startswith("data:image/png;base64,"))
        cabin_token = urllib.parse.parse_qs(qr_data["qr_url"].split("#", 1)[1])["elevator_token"][0]
        verified_sos = admin_client.post(
            "/api/emergencies",
            json={
                "elevator_id": "ELV-777",
                "elevator_token": cabin_token,
                "client_request_id": "verified-qr-request",
            },
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(verified_sos.status_code, 201, verified_sos.get_json())
        self.assertTrue(verified_sos.get_json()["emergency"]["verified_elevator"])
        replacement_qr = admin_client.post(
            "/api/elevators/ELV-777/qr-token",
            json={},
            headers={"X-CSRF-Token": admin_csrf},
        ).get_json()
        replaced_token = urllib.parse.parse_qs(
            replacement_qr["qr_url"].split("#", 1)[1]
        )["elevator_token"][0]
        stale_qr_sos = admin_client.post(
            "/api/emergencies",
            json={
                "elevator_id": "ELV-777",
                "elevator_token": cabin_token,
                "client_request_id": "stale-qr-request",
            },
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(stale_qr_sos.status_code, 400)
        current_qr_sos = admin_client.post(
            "/api/emergencies",
            json={
                "elevator_id": "ELV-777",
                "elevator_token": replaced_token,
                "client_request_id": "current-qr-request",
            },
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(current_qr_sos.status_code, 201)
        self.assertTrue(current_qr_sos.get_json()["emergency"]["verified_elevator"])
        work_order = admin_client.post(
            "/api/maintenance",
            json={"elevator_id": "ELV-777", "description": "Check cabin door sensor"},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(work_order.status_code, 201, work_order.get_json())
        engineer_client = self.app.test_client()
        self.login("maintenance@demo.local", engineer_client)
        maintenance_notifications = engineer_client.get("/api/notifications").get_json()["notifications"]
        self.assertTrue(any(item["title"] == "New maintenance request" for item in maintenance_notifications))

    def test_unacknowledged_emergency_escalates_once_to_administrators(self):
        csrf = self.token()
        created = self.client.post(
            "/api/emergencies",
            json={"elevator_id": "ELV-104", "client_request_id": "escalation-request"},
            headers={"X-CSRF-Token": csrf},
        ).get_json()["emergency"]
        with self.app.app_context():
            from app import get_db

            connection = get_db()
            connection.execute(
                "UPDATE emergencies SET created_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                (created["id"],),
            )
            connection.commit()

        rescue_client = self.app.test_client()
        self.login("rescue@demo.local", rescue_client)
        first = rescue_client.get("/api/emergencies")
        self.assertEqual(first.status_code, 200)

        admin_client = self.app.test_client()
        self.login("admin@demo.local", admin_client)
        notifications = admin_client.get("/api/notifications").get_json()["notifications"]
        escalations = [item for item in notifications if item["title"] == "Emergency needs acknowledgement"]
        self.assertEqual(len(escalations), 1)

        rescue_client.get("/api/emergencies")
        notifications_again = admin_client.get("/api/notifications").get_json()["notifications"]
        self.assertEqual(
            len([item for item in notifications_again if item["title"] == "Emergency needs acknowledgement"]),
            1,
        )

    def test_system_admin_can_edit_users_and_cannot_remove_last_admin(self):
        admin_client = self.app.test_client()
        csrf = self.login("sysadmin@demo.local", admin_client)
        users = admin_client.get("/api/users").get_json()["users"]
        rescue = next(item for item in users if item["role"] == "rescue_team")
        updated = admin_client.put(
            f"/api/users/{rescue['id']}",
            json={
                "name": "Campus Rescue Lead",
                "email": "rescue-lead@example.test",
                "phone": "+15551234567",
                "role": "rescue_team",
                "active": True,
                "password": "Replacement-Password-12!",
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(updated.status_code, 200, updated.get_json())
        audit = admin_client.get("/api/audit").get_json()["entries"]
        self.assertTrue(any(item["action"] == "user.updated" for item in audit))

        last_admin = next(item for item in users if item["role"] == "system_admin")
        rejected = admin_client.put(
            f"/api/users/{last_admin['id']}",
            json={
                "name": last_admin["name"],
                "email": last_admin["email"],
                "role": "building_admin",
                "active": True,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(rejected.status_code, 409)

    def test_pwa_shell_is_served_and_production_requires_a_secret(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"/static/app.js", page.data)
        self.assertNotIn(b"Northpoint Residences", page.data)
        page.close()
        worker = self.client.get("/service-worker.js")
        self.assertEqual(worker.status_code, 200)
        self.assertEqual(worker.headers["Service-Worker-Allowed"], "/")
        worker.close()
        manifest = self.client.get("/static/manifest.json")
        self.assertEqual(manifest.status_code, 200)
        manifest.close()

        with self.assertRaises(RuntimeError):
            create_app({
                "APP_ENV": "production",
                "DATABASE": os.path.join(self.temp_dir.name, "production.sqlite"),
            })
        production_app = create_app({
            "TESTING": True,
            "APP_ENV": "production",
            "SECRET_KEY": "production-test-secret",
            "DATABASE": os.path.join(self.temp_dir.name, "production-configured.sqlite"),
        })
        production_elevators = production_app.test_client().get("/api/elevators").get_json()["elevators"]
        self.assertEqual(production_elevators, [])

    def test_external_notifications_are_persisted_before_background_delivery(self):
        queued_app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-notification-secret",
            "DATABASE": os.path.join(self.temp_dir.name, "notifications.sqlite"),
            "SEED_DEMO_USERS": True,
            "SMTP_HOST": "mail.invalid",
            "SMTP_FROM": "alerts@example.test",
        })
        client = queued_app.test_client()
        csrf = self.token(client)
        response = client.post(
            "/api/emergencies",
            json={"elevator_id": "ELV-104", "client_request_id": "queued-notification"},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["delivery_status"], "queued")

        with queued_app.app_context():
            from app import get_db

            connection = get_db()
            rows = connection.execute(
                "SELECT status,COUNT(*) count FROM notification_outbox GROUP BY status"
            ).fetchall()
            self.assertEqual([(row["status"], row["count"]) for row in rows], [("Pending", 3)])
            connection.close()

        admin = queued_app.test_client()
        admin_csrf = self.login("sysadmin@demo.local", admin)
        delivery = admin.get("/api/notifications/delivery").get_json()
        self.assertEqual(delivery["counts"][0]["status"], "Pending")
        with queued_app.app_context():
            connection = get_db()
            connection.execute(
                "UPDATE notification_outbox SET status='Failed',last_error='temporary failure' WHERE id=(SELECT id FROM notification_outbox LIMIT 1)"
            )
            connection.commit()
            connection.close()
        retried = admin.post(
            "/api/notifications/retry",
            json={},
            headers={"X-CSRF-Token": admin_csrf},
        )
        self.assertEqual(retried.status_code, 200)
        self.assertEqual(retried.get_json()["queued"], 1)


if __name__ == "__main__":
    unittest.main()

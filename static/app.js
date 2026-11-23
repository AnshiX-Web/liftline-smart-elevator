(() => {
    const state = {
        user: null,
        csrf: "",
        demoMode: false,
        channels: { email: false, sms: false },
        manualEmergencyNumber: "",
        view: "passenger",
        elevators: [],
        buildingFilter: "all",
        emergencies: [],
        maintenance: [],
        users: [],
        audit: [],
        delivery: { counts: [], failures: [] },
        editUser: null,
        history: [],
        notifications: [],
        unreadCount: 0,
        selectedElevator: "",
        qrElevatorId: "",
        elevatorToken: "",
        qrCode: null,
        trackedEmergency: null,
        trackingErrorShown: false,
        editElevator: null,
        toastTimer: 0
    };
    const content = document.getElementById("content");
    const titles = {
        overview: "Overview",
        incidents: "Emergencies",
        rescue: "Rescue team",
        elevators: "Elevators",
        maintenance: "Maintenance",
        history: "Emergency history",
        passenger: "Passenger SOS",
        admin: "Administration",
        login: "Sign in"
    };
    const roles = {
        rescue_team: "Rescue team",
        building_admin: "Building administrator",
        maintenance_engineer: "Maintenance engineer",
        system_admin: "System administrator",
        passenger: "Passenger"
    };

    function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[char]);
    }

    function icon(name) {
        return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
    }

    function showToast(message, isError = false) {
        const toast = document.getElementById("toast");
        toast.textContent = message;
        toast.classList.toggle("error", isError);
        toast.hidden = false;
        window.clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(() => { toast.hidden = true; }, 5000);
    }

    async function api(path, options = {}) {
        const headers = { Accept: "application/json", ...options.headers };
        if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
        if (options.method && options.method !== "GET" && state.csrf) {
            headers["X-CSRF-Token"] = state.csrf;
        }
        let response;
        try {
            response = await fetch(path, { credentials: "same-origin", ...options, headers });
        } catch (error) {
            throw new TypeError("The server could not be reached.");
        }
        let result;
        try {
            result = await response.json();
        } catch {
            throw new Error("The server returned an unreadable response.");
        }
        if (!response.ok || result.success === false) {
            const failure = new Error(result.error || `The server returned ${response.status}.`);
            failure.status = response.status;
            throw failure;
        }
        return result;
    }

    function formatTime(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? "Unknown time"
            : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }

    function notifyCount() {
        const badge = document.getElementById("nav-count");
        const count = state.emergencies.filter((item) => !["Resolved", "Closed"].includes(item.status)).length;
        badge.textContent = count;
        badge.hidden = !state.user || count === 0;
        const dot = document.querySelector(".icon-button .dot");
        dot.hidden = !state.user || state.unreadCount === 0;
        dot.title = state.unreadCount
            ? `${state.unreadCount} unread notification${state.unreadCount === 1 ? "" : "s"}`
            : "No unread notifications";
    }

    function applyRoleNavigation() {
        document.querySelectorAll(".nav-button").forEach((button) => {
            const permitted = (button.dataset.roles || "").split(",").filter(Boolean);
            button.hidden = permitted.length > 0 && !permitted.includes(state.user?.role);
            button.classList.toggle("active", button.dataset.view === state.view);
        });
        document.getElementById("sidebar-name").textContent = state.user?.name || "Not signed in";
        document.getElementById("sidebar-role").textContent = state.user
            ? roles[state.user.role] || state.user.role
            : "Passenger access";
        document.getElementById("sidebar-avatar").textContent = state.user
            ? state.user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()
            : "?";
        document.getElementById("account-button").textContent = state.user ? "Sign out" : "Sign in";
        const indicator = document.getElementById("storage-mode");
        indicator.textContent = state.user
            ? "Server records · role protected"
            : "Passenger SOS · no login needed";
        indicator.classList.toggle("local", !state.user);
        indicator.hidden = false;
        notifyCount();
    }

    function pageHeading(eyebrow, title, subtitle, action = "") {
        return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p></div>${action}</div>`;
    }

    function statusBadge(status) {
        const style = status === "Accepted" ? "status-acknowledged"
            : status === "In Progress" ? "status-dispatched"
                : ["Resolved", "Closed"].includes(status) ? "status-resolved" : "status-received";
        return `<span class="status ${style}">${escapeHtml(status)}</span>`;
    }

    function currentElevator() {
        return state.elevators.find((item) => item.id === state.selectedElevator) || state.elevators[0];
    }

    function visibleElevators() {
        return state.buildingFilter === "all"
            ? state.elevators
            : state.elevators.filter((item) => item.building === state.buildingFilter);
    }

    async function loadElevators() {
        try {
            const result = await api("/api/elevators");
            state.elevators = result.elevators;
            localStorage.setItem("liftline-elevators-cache", JSON.stringify(state.elevators));
        } catch (error) {
            try {
                state.elevators = JSON.parse(localStorage.getItem("liftline-elevators-cache") || "[]");
            } catch {
                state.elevators = [];
            }
            if (!state.elevators.length) throw error;
            showToast("Offline: showing the last saved lift directory. Emergency requests will be queued locally.", true);
        }
        if (!state.selectedElevator || !state.elevators.some((item) => item.id === state.selectedElevator)) {
            const urlId = new URLSearchParams(location.search).get("elevator");
            state.selectedElevator = state.elevators.some((item) => item.id === urlId)
                ? urlId : state.elevators.some((item) => item.id === "ELV-104")
                    ? "ELV-104" : state.elevators[0]?.id || "";
        }
        const select = document.getElementById("building-select");
        select.innerHTML = `<option value="all">All buildings</option>${[...new Set(state.elevators.map((item) => item.building))].map((building) => `<option value="${escapeHtml(building)}">${escapeHtml(building)}</option>`).join("")}`;
    }

    async function loadEmergencies() {
        if (!state.user || !["rescue_team", "building_admin", "system_admin"].includes(state.user.role)) return;
        const result = await api("/api/emergencies");
        const previous = JSON.stringify(state.emergencies);
        state.emergencies = result.emergencies;
        notifyCount();
        return previous !== JSON.stringify(state.emergencies);
    }

    async function loadMaintenance() {
        if (!state.user || !["maintenance_engineer", "building_admin", "system_admin"].includes(state.user.role)) return;
        const result = await api("/api/maintenance");
        const previous = JSON.stringify(state.maintenance);
        state.maintenance = result.requests;
        return previous !== JSON.stringify(state.maintenance);
    }

    async function loadUsers() {
        if (state.user?.role !== "system_admin") return;
        const result = await api("/api/users");
        state.users = result.users;
    }

    async function loadAudit() {
        if (state.user?.role !== "system_admin") return;
        const result = await api("/api/audit");
        state.audit = result.entries;
    }

    async function loadDelivery() {
        if (state.user?.role !== "system_admin") return;
        state.delivery = await api("/api/notifications/delivery");
    }

    function renderLogin() {
        return `${pageHeading("AUTHORIZED ACCESS", "Sign in", "Rescue, administration, and maintenance workspaces require an authorized account.")}
            <section class="panel login-panel">
                <h2 style="margin:0;color:var(--ink);font-size:18px">Liftline operations</h2>
                <p class="card-description">Passenger SOS remains available without sign-in.</p>
                <form id="login-form">
                    <div class="form-field"><label for="login-email">Email</label><input id="login-email" name="email" type="email" autocomplete="username" required maxlength="254"></div>
                    <div class="form-field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="256"></div>
                    <div class="form-actions"><button class="button button-primary" type="submit">Sign in</button><button class="button" type="button" data-view="passenger">Passenger SOS</button></div>
                </form>
                ${state.demoMode ? `<div class="warning-panel"><strong>Local demo accounts</strong><span>Use admin@demo.local, sysadmin@demo.local, rescue@demo.local, or maintenance@demo.local. Password: Liftline-Demo-2026!</span></div>` : ""}
            </section>`;
    }

    function renderOverview() {
        const active = state.emergencies.filter((item) => !["Resolved", "Closed"].includes(item.status));
        const resolved = state.emergencies.filter((item) => ["Resolved", "Closed"].includes(item.status));
        const incidents = state.emergencies.slice(0, 5);
        const elevators = visibleElevators();
        return `${pageHeading("SAFETY OPERATIONS", "Campus overview", "Current emergency activity and registered elevator status.", `<button class="button button-danger" type="button" data-view="passenger">${icon("plus")} Passenger SOS</button>`)}
            <section class="hero"><div class="hero-copy"><div class="hero-kicker">Liftline · Emergency response</div><h2>Every alert, tracked.</h2><p>Monitor incoming SOS requests, coordinate the response, and keep an auditable incident history.</p></div><div class="hero-status"><span class="pulse"></span><span><strong>Application connected</strong><span>Operational status is based on server records</span></span></div></section>
            <section class="stats-grid">
                <article class="stat-card"><div class="stat-top">Active emergencies<span class="stat-icon red">${icon("bell")}</span></div><div class="stat-value">${active.length}</div><div class="stat-foot">New, accepted, or in progress</div></article>
                <article class="stat-card"><div class="stat-top">Registered lifts<span class="stat-icon">${icon("lift")}</span></div><div class="stat-value">${elevators.length}</div><div class="stat-foot">Configured in the elevator register</div></article>
                <article class="stat-card"><div class="stat-top">Resolved / closed<span class="stat-icon blue">${icon("check")}</span></div><div class="stat-value">${resolved.length}</div><div class="stat-foot">Recorded in emergency history</div></article>
                <article class="stat-card"><div class="stat-top">Open maintenance<span class="stat-icon amber">${icon("wrench")}</span></div><div class="stat-value">${state.maintenance.filter((item) => !["Closed", "Completed"].includes(item.status)).length}</div><div class="stat-foot">Assigned service requests</div></article>
            </section>
            <section class="panel"><div class="panel-heading"><div><h3>Recent emergencies</h3><p>Updates refresh automatically while this workspace is open.</p></div><button class="text-link" type="button" data-view="history">View history →</button></div>${emergencyTable(incidents)}</section>
            <section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>Elevator register</h3><p>Status and location maintained by the system administrator.</p></div><button class="text-link" type="button" data-view="elevators">Manage →</button></div>${elevatorTable(elevators)}</section>`;
    }

    function emergencyTable(items) {
        if (!items.length) return `<div class="empty-state"><strong>No emergencies recorded yet</strong>Passenger SOS requests will appear here after the server registers them.</div>`;
        return `<div class="table-wrap"><table><thead><tr><th>Emergency</th><th>Elevator / location</th><th>Category</th><th>Status</th><th>Response</th></tr></thead><tbody>${items.map((item) => {
            let action = "";
            if (item.status === "New" && ["rescue_team", "building_admin", "system_admin"].includes(state.user?.role)) {
                action = `<button class="button button-small" data-accept="${escapeHtml(item.id)}">Accept</button>`;
            } else if (item.status === "Accepted") {
                action = `<button class="button button-small" data-set-status="${escapeHtml(item.id)}" data-status="In Progress">Start response</button>`;
            } else if (item.status === "In Progress") {
                action = `<label class="cell-sub"><input type="checkbox" data-maintenance-required="${escapeHtml(item.id)}"> inspection</label><button class="button button-small" data-set-status="${escapeHtml(item.id)}" data-status="Resolved">Resolve</button>`;
            } else if (item.status === "Resolved" && ["building_admin", "system_admin"].includes(state.user?.role)) {
                action = `<button class="button button-small" data-set-status="${escapeHtml(item.id)}" data-status="Closed">Close</button>`;
            } else {
                action = `<span class="cell-sub">${escapeHtml(item.rescuer_name || "Awaiting assignment")}</span>`;
            }
            return `<tr><td><span class="cell-strong">${escapeHtml(item.id)}</span><div class="cell-sub">${formatTime(item.created_at)}</div></td><td><span class="cell-strong">${escapeHtml(item.elevator_id)} · ${escapeHtml(item.building)}</span><div class="cell-sub">${escapeHtml(item.location)}</div>${item.verified_elevator ? "" : `<div class="cell-sub">Location unverified</div>`}</td><td>${escapeHtml(item.category)}</td><td>${statusBadge(item.status)}</td><td>${action}</td></tr>`;
        }).join("")}</tbody></table></div>`;
    }

    function elevatorTable(items) {
        if (!items.length) return `<div class="empty-state"><strong>No registered elevators</strong>A system administrator can add elevator IDs and location details.</div>`;
        return `<div class="table-wrap"><table><thead><tr><th>Elevator ID</th><th>Building / location</th><th>Floors</th><th>Operational status</th></tr></thead><tbody>${items.map((item) => `<tr><td class="cell-strong">${escapeHtml(item.id)}</td><td>${escapeHtml(item.building)}<div class="cell-sub">${escapeHtml(item.location)}</div></td><td>${escapeHtml(item.floors)}</td><td><span class="tag">${escapeHtml(item.status)}</span></td></tr>`).join("")}</tbody></table></div>`;
    }

    function renderIncidents() {
        return `${pageHeading("RESPONSE QUEUE", "Emergency center", "Accept requests, update rescue progress, and document hand-offs.")}
            <div class="status-strip"><span class="pulse"></span><strong>${state.emergencies.filter((item) => !["Resolved", "Closed"].includes(item.status)).length} active</strong><span>·</span><span>Unacknowledged alerts are escalated to administrators after the configured delay.</span></div>
            <section class="panel"><div class="panel-heading"><div><h3>All emergency alerts</h3><p>Each status change is timestamped in the audit history.</p></div><button class="button button-small" data-refresh="emergencies">Refresh</button></div>${emergencyTable(state.emergencies)}</section>`;
    }

    function renderRescue() {
        const assigned = state.emergencies.filter((item) => item.assigned_rescuer_id === state.user?.id);
        return `${pageHeading("FIELD RESPONSE", "Rescue team", "Review incidents, accept responsibility, and record each response step.")}
            <div class="stats-grid"><article class="stat-card"><div class="stat-top">Open calls<span class="stat-icon red">${icon("bell")}</span></div><div class="stat-value">${state.emergencies.filter((item) => item.status === "New").length}</div><div class="stat-foot">Waiting to be accepted</div></article><article class="stat-card"><div class="stat-top">Assigned to you<span class="stat-icon">${icon("users")}</span></div><div class="stat-value">${assigned.filter((item) => !["Resolved", "Closed"].includes(item.status)).length}</div><div class="stat-foot">Active rescue operations</div></article></div>
            <section class="panel"><div class="panel-heading"><div><h3>Rescue queue</h3><p>Unverified elevator location should be confirmed by call-back or cabin signage.</p></div></div>${emergencyTable(state.emergencies)}</section>`;
    }

    function renderElevators() {
        const editing = state.editElevator;
        const qrPanel = state.qrCode
            ? `<section class="panel qr-panel" style="margin-bottom:16px"><div class="panel-heading"><div><h3>Cabin QR ready · ${escapeHtml(state.qrCode.elevator_id)}</h3><p>This one-time QR verifies the elevator association when students scan it. Rotating it invalidates every earlier sticker.</p></div><button class="button button-small" type="button" data-close-qr>Done</button></div><div class="qr-content"><img src="${escapeHtml(state.qrCode.qr_image)}" alt="Cabin SOS QR code for ${escapeHtml(state.qrCode.elevator_id)}"><div><p class="card-description">Print this code and place it inside the matching elevator. Verify the destination URL before printing.</p><p><a class="report-link" href="${escapeHtml(state.qrCode.qr_url)}">${escapeHtml(state.qrCode.qr_url)}</a></p><a class="button button-small" href="${escapeHtml(state.qrCode.qr_image)}" download="liftline-${escapeHtml(state.qrCode.elevator_id)}-cabin-qr.png">Download printable QR</a></div></div></section>`
            : "";
        const editor = state.user?.role === "system_admin"
            ? `<section class="panel" style="margin-bottom:16px"><div class="panel-heading"><div><h3>${editing ? "Update elevator" : "Register elevator"}</h3><p>Keep elevator IDs and location records accurate.</p></div></div><form id="elevator-form" data-id="${escapeHtml(editing?.id || "")}">
                <div class="form-row"><div class="form-field"><label>Elevator ID</label><input name="id" required maxlength="80" value="${escapeHtml(editing?.id || "")}" ${editing ? "readonly" : ""}></div><div class="form-field"><label>Building</label><input name="building" required maxlength="120" value="${escapeHtml(editing?.building || "")}"></div></div>
                <div class="form-row"><div class="form-field"><label>Location</label><input name="location" required maxlength="240" value="${escapeHtml(editing?.location || "")}"></div><div class="form-field"><label>Floors served</label><input name="floors" required maxlength="240" value="${escapeHtml(editing?.floors || "")}"></div></div>
                <div class="form-field"><label>Operational status</label><select name="status"><option ${editing?.status === "Unknown" ? "selected" : ""}>Unknown</option><option ${editing?.status === "Operational" ? "selected" : ""}>Operational</option><option ${editing?.status === "Under maintenance" ? "selected" : ""}>Under maintenance</option><option ${editing?.status === "Offline" ? "selected" : ""}>Offline</option></select></div>
                <div class="form-row"><div class="form-field"><label>Assigned rescue team member</label><select name="assigned_rescuer_id"><option value="">Unassigned</option>${state.users.filter((user) => user.role === "rescue_team" && user.active).map((user) => `<option value="${escapeHtml(user.id)}" ${editing?.assigned_rescuer_id === user.id ? "selected" : ""}>${escapeHtml(user.name)}</option>`).join("")}</select></div><div class="form-field"><label>Assigned maintenance engineer</label><select name="assigned_engineer_id"><option value="">Unassigned</option>${state.users.filter((user) => user.role === "maintenance_engineer" && user.active).map((user) => `<option value="${escapeHtml(user.id)}" ${editing?.assigned_engineer_id === user.id ? "selected" : ""}>${escapeHtml(user.name)}</option>`).join("")}</select></div></div>
                <div class="form-actions"><button class="button button-primary" type="submit">${editing ? "Save changes" : "Add elevator"}</button>${editing ? `<button class="button" type="button" data-cancel-edit>Cancel</button>` : ""}</div></form></section>`
            : "";
        const elevators = visibleElevators();
        const table = state.user?.role === "system_admin"
            ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Building / location</th><th>Floors</th><th>Status</th><th>Actions</th></tr></thead><tbody>${elevators.map((item) => `<tr><td class="cell-strong">${escapeHtml(item.id)}<div class="cell-sub">${item.qr_configured ? "Cabin QR configured" : "No cabin QR"}</div></td><td>${escapeHtml(item.building)}<div class="cell-sub">${escapeHtml(item.location)}</div></td><td>${escapeHtml(item.floors)}</td><td>${escapeHtml(item.status)}</td><td><button class="button button-small" data-generate-qr="${escapeHtml(item.id)}">${item.qr_configured ? "Rotate QR" : "Generate QR"}</button> <button class="button button-small" data-edit-elevator="${escapeHtml(item.id)}">Edit</button> <button class="button button-small" data-deactivate-elevator="${escapeHtml(item.id)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`
            : elevatorTable(elevators);
        return `${pageHeading("REGISTERED EQUIPMENT", "Elevators", "Each emergency is associated with a registered elevator and its location.")}${qrPanel}${editor}<section class="panel">${table}</section>`;
    }

    function renderMaintenance() {
        const canCreate = ["building_admin", "system_admin", "rescue_team", "maintenance_engineer"].includes(state.user?.role);
        return `${pageHeading("SERVICE REQUESTS", "Maintenance", "Inspect, repair, and close elevator service requests.")}
            ${canCreate ? `<section class="panel" style="margin-bottom:16px"><div class="panel-heading"><div><h3>Create maintenance request</h3><p>Requests can also be generated from an emergency resolution.</p></div></div><form id="maintenance-form">
                <div class="form-row"><div class="form-field"><label>Elevator</label><select name="elevator_id" required>${state.elevators.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)} · ${escapeHtml(item.building)}</option>`).join("")}</select></div><div class="form-field"><label>Priority</label><select name="priority"><option>Normal</option><option>Low</option><option>High</option><option>Urgent</option></select></div></div>
                <div class="form-field"><label>Fault / inspection details</label><textarea name="description" required maxlength="1000"></textarea></div><button class="button button-primary" type="submit">Create request</button></form></section>` : ""}
            <section class="content-grid">${state.maintenance.length ? state.maintenance.map((item) => `<article class="maintenance-card"><div class="card-top"><div><div class="card-title">${escapeHtml(item.id)} · ${escapeHtml(item.elevator_id)}</div><div class="card-description">${escapeHtml(item.building)} · ${escapeHtml(item.location)}</div></div><span class="tag">${escapeHtml(item.status)}</span></div><p class="card-description">${escapeHtml(item.description)}</p><p class="cell-sub">${escapeHtml(item.priority)} priority · Assigned to ${escapeHtml(item.engineer_name || "unassigned")} · ${formatTime(item.created_at)}</p><div class="fleet-list">${(item.records || []).map((record) => `<div class="fleet-row"><span><span class="fleet-title">${escapeHtml(record.engineer_name)}</span><span class="fleet-detail">${escapeHtml(record.inspection_details)} ${escapeHtml(record.repair_details)}</span></span><span class="cell-sub">${formatTime(record.created_at)}</span></div>`).join("")}</div>${state.user?.role === "maintenance_engineer" || state.user?.role === "system_admin" || state.user?.role === "building_admin" ? `<form data-maintenance-record="${escapeHtml(item.id)}"><div class="form-field"><label>Inspection details</label><textarea name="inspection_details" required maxlength="2000"></textarea></div><div class="form-field"><label>Repair details</label><textarea name="repair_details" maxlength="2000"></textarea></div><div class="form-field"><label>Engineer remarks</label><input name="remarks" maxlength="1000"></div><div class="form-actions"><button class="button button-small" type="submit">Save maintenance record</button>${item.status !== "Closed" ? `<button class="button button-small" type="button" data-close-maintenance="${escapeHtml(item.id)}">Close request</button>` : ""}</div></form>` : ""}</article>`).join("") : `<article class="panel"><div class="empty-state"><strong>No maintenance requests</strong>Fault-related SOS requests and authorized service entries will appear here.</div></article>`}</section>`;
    }

    function renderHistory() {
        const items = state.history;
        return `${pageHeading("AUDITABLE RECORDS", "Emergency history", "Previously recorded incidents, rescue status changes, and outcomes.", `<a class="button button-small" href="/api/reports/emergencies.csv">Export CSV</a>`)}
            <section class="panel">${items.length ? `<div class="table-wrap"><table><thead><tr><th>ID / time</th><th>Elevator</th><th>Category</th><th>Requester</th><th>Responder</th><th>Status</th></tr></thead><tbody>${items.map((item) => `<tr><td class="cell-strong">${escapeHtml(item.id)}<div class="cell-sub">${formatTime(item.created_at)}</div></td><td>${escapeHtml(item.elevator_id)} · ${escapeHtml(item.building)}<div class="cell-sub">${escapeHtml(item.location)}</div></td><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.requester_name || "Passenger")}</td><td>${escapeHtml(item.rescuer_name || "Unassigned")}</td><td>${statusBadge(item.status)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No emergency history</strong>Closed and resolved incidents are retained here.</div>`}</section>`;
    }

    function renderAdmin() {
        const editing = state.editUser;
        const deliveryPanel = `<section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>External notification delivery</h3><p>Delivery is asynchronous; failed attempts remain recorded and can be retried.</p></div><button class="button button-small" type="button" data-refresh-delivery>Refresh</button></div>${state.delivery.counts.length ? `<div class="fleet-list">${state.delivery.counts.map((item) => `<div class="fleet-row"><span class="fleet-title">${escapeHtml(item.channel)} · ${escapeHtml(item.status)}</span><span class="tag">${item.count}</span></div>`).join("")}</div>` : `<div class="empty-state"><strong>No external notification attempts</strong>In-app notifications remain available; configure SMTP or Twilio to send email/SMS.</div>`}${state.delivery.failures.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Emergency</th><th>Channel</th><th>Attempts</th><th>Last error</th><th>Updated</th></tr></thead><tbody>${state.delivery.failures.map((item) => `<tr><td>${escapeHtml(item.emergency_id)}</td><td>${escapeHtml(item.channel)}</td><td>${item.attempts}</td><td>${escapeHtml(item.last_error)}</td><td>${formatTime(item.updated_at)}</td></tr>`).join("")}</tbody></table></div>` : ""}</section>`;
        return `${pageHeading("AUTHORIZED ADMINISTRATION", "Users & access", "Manage role assignments and disable accounts when access is no longer required.")}
            <section class="panel" style="margin-bottom:16px"><div class="panel-heading"><div><h3>${editing ? "Update user" : "Create user"}</h3><p>Use a unique account for each rescue, maintenance, and administrative operator.</p></div></div><form id="user-form" data-user-id="${escapeHtml(editing?.id || "")}"><div class="form-row"><div class="form-field"><label>Name</label><input name="name" required maxlength="120" value="${escapeHtml(editing?.name || "")}"></div><div class="form-field"><label>Email</label><input name="email" type="email" required maxlength="254" value="${escapeHtml(editing?.email || "")}"></div></div><div class="form-row"><div class="form-field"><label>${editing ? "New password (leave blank to keep current)" : "Temporary password (12+ characters)"}</label><input name="password" type="password" ${editing ? "" : "required"} minlength="12" maxlength="256"></div><div class="form-field"><label>Phone for optional SMS notifications</label><input name="phone" type="tel" maxlength="40" value="${escapeHtml(editing?.phone || "")}"></div></div><div class="form-field"><label>Role</label><select name="role">${Object.entries(roles).map(([key, name]) => `<option value="${key}" ${editing?.role === key ? "selected" : ""}>${name}</option>`).join("")}</select></div><div class="form-actions"><button class="button button-primary" type="submit">${editing ? "Save user" : "Create user"}</button>${editing ? `<button class="button" type="button" data-cancel-user-edit>Cancel</button>` : ""}</div></form></section>
            <section class="panel"><div class="panel-heading"><div><h3>Operator accounts</h3><p>Passwords are hashed and never displayed.</p></div></div>${state.users.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody>${state.users.map((user) => `<tr><td class="cell-strong">${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(roles[user.role] || user.role)}</td><td>${user.active ? "Active" : "Disabled"}</td><td>${user.active ? `<button class="button button-small" data-edit-user="${escapeHtml(user.id)}">Edit</button> ${user.id !== state.user.id ? `<button class="button button-small" data-deactivate-user="${escapeHtml(user.id)}">Deactivate</button>` : ""}` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No user accounts</strong>Create authorized operator accounts above.</div>`}</section>
            <section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>Recent audit events</h3><p>Important changes are recorded with actor and timestamp.</p></div></div>${state.audit.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Record</th></tr></thead><tbody>${state.audit.slice(0,20).map((entry) => `<tr><td>${formatTime(entry.created_at)}</td><td>${escapeHtml(entry.actor || "System")}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.entity_type)} · ${escapeHtml(entry.entity_id)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>No audit events yet</strong>Emergency and maintenance activity will be recorded here.</div>`}</section>${deliveryPanel}
            <section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>Safety boundaries</h3><p>External capabilities require separately configured integrations.</p></div></div><div class="fleet-list"><div class="fleet-row"><span class="fleet-title">Emergency notifications</span><span class="tag">${state.channels.email || state.channels.sms ? "Provider configured" : "In-app only"}</span></div><div class="fleet-row"><span class="fleet-title">Elevator sensors / IoT gateway</span><span class="tag">Not connected</span></div><div class="fleet-row"><span class="fleet-title">Door / machinery control</span><span class="tag">Not supported</span></div><div class="fleet-row"><span class="fleet-title">External emergency dispatch</span><span class="tag">Manual escalation only</span></div></div><div class="form-actions"><button class="button button-small" data-retry-notifications>Retry failed notifications</button><span class="cell-sub">Only configured email/SMS messages are retried.</span></div></section>`;
    }

    function renderPassenger() {
        const elevator = currentElevator();
        const tracked = state.trackedEmergency;
        const categories = ["Trapped inside elevator", "Elevator stopped / fault", "Other urgent issue"];
        const offline = !navigator.onLine;
        const trackingLink = tracked?.token
            ? `${location.origin}/?tracking=${encodeURIComponent(tracked.emergency.id)}#token=${encodeURIComponent(tracked.token)}`
            : "";
        const main = tracked
            ? `<article class="panel tracking-card"><div class="tracking-heading"><span class="tracking-check">✓</span><span><h3>Emergency request registered</h3><p>${escapeHtml(tracked.message || "The server recorded your request.")}</p></span></div><div class="tracking-id"><span>EMERGENCY REFERENCE</span><strong>${escapeHtml(tracked.emergency.id)}</strong></div><p class="card-description">${escapeHtml(tracked.emergency.building)} · ${escapeHtml(tracked.emergency.elevator_id)} · ${escapeHtml(tracked.emergency.location)}</p><p class="cell-sub">${tracked.emergency.verified_elevator ? "Cabin QR verified by the server" : "Location selected manually · unverified"}</p>${statusBadge(tracked.emergency.status)}<div class="timeline">${(tracked.history || [{ new_status: tracked.emergency.status, created_at: tracked.emergency.created_at, note: "Request registered" }]).map((step) => `<div class="timeline-item done"><span class="timeline-dot"></span><strong>${escapeHtml(step.new_status)}</strong><span>${formatTime(step.created_at)} · ${escapeHtml(step.note || "")}</span></div>`).join("")}</div>${trackingLink ? `<p><a class="report-link" href="${escapeHtml(trackingLink)}">Save private tracking link</a></p>` : ""}<button class="button" type="button" data-new-request>Report another emergency</button></article>`
            : `<section class="panel sos-card"><h2>Emergency SOS</h2><p>One tap sends the default “Trapped inside elevator” alert. Category and details are optional.</p>
                <div class="location-box">${icon("pin")}<span><strong>${escapeHtml(elevator?.id || "No lift selected")} · ${escapeHtml(elevator?.building || "")}</strong><span>${escapeHtml(elevator?.location || "Elevator location unavailable")} · Floors ${escapeHtml(elevator?.floors || "unknown")}</span><span>${state.elevatorToken && state.qrElevatorId === elevator?.id ? "Cabin QR detected · server verifies on submission" : "Manual selection · location unverified"}</span></span></div>
                <form id="emergency-form">
                    <div class="form-field"><label for="emergency-elevator">Elevator</label><select id="emergency-elevator" name="elevator_id" required>${state.elevators.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.selectedElevator ? "selected" : ""}>${escapeHtml(item.id)} · ${escapeHtml(item.building)} · ${escapeHtml(item.location)}</option>`).join("")}</select></div>
                    <div class="form-field"><label for="emergency-category">Category (optional)</label><select id="emergency-category" name="category">${categories.map((category, index) => `<option ${index === 0 ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}</select></div>
                    <div class="form-field"><label for="emergency-details">Additional details (optional)</label><textarea id="emergency-details" name="description" maxlength="1000" placeholder="Anything responders should know?"></textarea></div>
                    <div class="form-field"><label for="requester-name">Name (optional)</label><input id="requester-name" name="requester_name" maxlength="120" autocomplete="name"></div>
                    ${offline ? `<div class="warning-panel"><strong>You are offline.</strong><span>Your request cannot reach the rescue team now. It can be queued on this device for retry, but use the elevator intercom or call the building emergency contact immediately.</span>${state.manualEmergencyNumber ? `<a class="report-link" href="sms:${escapeHtml(state.manualEmergencyNumber)}?body=${encodeURIComponent(`Elevator SOS: ${elevator?.id || ""} · ${elevator?.building || ""} · ${elevator?.location || ""}`)}">Open SMS fallback</a>` : ""}</div>` : ""}
                    <button class="button button-danger sos-button" id="send-sos" type="submit">${offline ? "SAVE SOS FOR RETRY" : "SEND EMERGENCY SOS"}</button>
                    <p class="fine-print">No physical elevator control is performed by this app. If the network fails, use the cabin intercom / manual emergency process.</p>
                </form>
            </section>`;
        const aside = `<article class="panel tracking-card"><div class="tracking-heading"><span class="tracking-check" style="color:#5d7186;background:#eef2f6">${icon("shield")}</span><span><h3>Response information</h3><p>Keep the cabin phone or intercom as a backup.</p></span></div><div class="tracking-id"><span>NOTIFICATION STATUS</span><strong style="font-family:inherit;font-size:12px">${state.channels.email || state.channels.sms ? "Configured channels available" : "In-app only"}</strong></div><p class="card-description">${state.channels.email || state.channels.sms ? "A server notification will be attempted after the request is stored." : "No external email/SMS service is configured. If no team member is signed in, staff may not see the request immediately."}</p><div class="timeline"><div class="timeline-item done"><span class="timeline-dot"></span><strong>Register request</strong><span>Unique ID and timestamp</span></div><div class="timeline-item"><span class="timeline-dot"></span><strong>Notify response staff</strong><span>In-app updates; provider delivery depends on setup</span></div><div class="timeline-item"><span class="timeline-dot"></span><strong>Track progress</strong><span>Accepted · In Progress · Resolved</span></div></div></article>`;
        return `${pageHeading("PASSENGER SUPPORT", tracked ? "Emergency submitted" : "Need help with your elevator?", tracked ? "Use the reference below when speaking with campus staff." : "Send a one-tap SOS request associated with a registered elevator.")}
            <div class="sos-layout">${main}${aside}</div>`;
    }

    function render() {
        applyRoleNavigation();
        document.getElementById("breadcrumb").textContent = titles[state.view] || "Overview";
        const pages = {
            login: renderLogin,
            overview: renderOverview,
            incidents: renderIncidents,
            rescue: renderRescue,
            elevators: renderElevators,
            maintenance: renderMaintenance,
            history: renderHistory,
            passenger: renderPassenger,
            admin: renderAdmin
        };
        content.innerHTML = pages[state.view]();
    }

    async function navigate(view) {
        const button = document.querySelector(`[data-view="${CSS.escape(view)}"]`);
        if (view !== "login" && (!button || button.hidden)) return;
        state.view = view;
        try {
            if (["overview", "incidents", "rescue", "history"].includes(view)) {
                if (!state.user) {
                    state.view = "login";
                } else {
                    await loadEmergencies();
                    if (view === "overview") await loadMaintenance();
                    if (view === "history") {
                        const result = await api("/api/emergency-history");
                        state.history = result.emergencies;
                    }
                }
            }
            if (view === "maintenance") await loadMaintenance();
            if (view === "admin") {
                await loadUsers();
                await loadAudit();
                await loadDelivery();
            }
            if (view === "elevators") {
                await loadElevators();
                if (state.user?.role === "system_admin") await loadUsers();
            }
        } catch (error) {
            showToast(error.message, true);
        }
        render();
        content.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    async function loadNotifications() {
        if (!state.user) {
            await navigate("login");
            return;
        }
        await refreshNotifications();
        const panel = document.createElement("section");
        panel.className = "panel";
        panel.id = "notifications-panel";
        panel.style.cssText = "position:fixed;right:18px;top:76px;z-index:25;width:min(420px,calc(100vw - 32px));max-height:70vh;overflow:auto;box-shadow:0 12px 40px rgba(20,37,58,.24)";
        panel.innerHTML = `<div class="panel-heading"><div><h3>Notifications</h3><p>Saved in your account inbox</p></div><button class="button button-small" data-close-notifications>Close</button></div>${state.notifications.length ? `<div class="fleet-list">${state.notifications.map((item) => `<article class="fleet-row"><span><span class="fleet-title">${escapeHtml(item.title)}</span><span class="fleet-detail">${escapeHtml(item.message)} · ${formatTime(item.created_at)}</span></span>${item.read_at ? "" : `<button class="button button-small" data-notification-read="${escapeHtml(item.id)}">Mark read</button>`}</article>`).join("")}</div>` : `<div class="empty-state"><strong>No notifications</strong>New incident notifications appear here.</div>`}`;
        document.getElementById("notifications-panel")?.remove();
        document.body.appendChild(panel);
    }

    async function refreshNotifications() {
        if (!state.user || state.user.role === "passenger") return false;
        const previous = JSON.stringify(state.notifications);
        const result = await api("/api/notifications");
        state.notifications = result.notifications;
        state.unreadCount = state.notifications.filter((item) => !item.read_at).length;
        notifyCount();
        return previous !== JSON.stringify(state.notifications);
    }

    function openOutbox() {
        return new Promise((resolve, reject) => {
            const opening = indexedDB.open("liftline-offline", 1);
            opening.onupgradeneeded = () => {
                if (!opening.result.objectStoreNames.contains("outbox")) {
                    opening.result.createObjectStore("outbox", { keyPath: "client_request_id" });
                }
            };
            opening.onsuccess = () => resolve(opening.result);
            opening.onerror = () => reject(opening.error);
        });
    }

    async function storeOfflineAlert(payload) {
        const database = await openOutbox();
        await new Promise((resolve, reject) => {
            const transaction = database.transaction("outbox", "readwrite");
            transaction.objectStore("outbox").put({ ...payload, csrf_token: state.csrf });
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
        if (navigator.serviceWorker) {
            const registration = await navigator.serviceWorker.getRegistration();
            if (registration?.sync?.register) {
                await registration.sync.register("liftline-emergency-outbox");
            }
        }
    }

    async function readOfflineAlerts() {
        const database = await openOutbox();
        const values = await new Promise((resolve, reject) => {
            const request = database.transaction("outbox").objectStore("outbox").getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        database.close();
        return values;
    }

    async function removeOfflineAlert(requestId) {
        const database = await openOutbox();
        await new Promise((resolve, reject) => {
            const transaction = database.transaction("outbox", "readwrite");
            transaction.objectStore("outbox").delete(requestId);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
    }

    async function syncOfflineAlerts() {
        if (!navigator.onLine) return;
        try {
            for (const payload of await readOfflineAlerts()) {
                try {
                    const result = await api("/api/emergencies", {
                        method: "POST",
                        body: JSON.stringify(payload)
                    });
                    await removeOfflineAlert(payload.client_request_id);
                    state.trackedEmergency = {
                        emergency: result.emergency,
                        token: result.tracking_token,
                        message: result.message,
                        history: [{ new_status: "New", created_at: result.emergency.created_at, note: "Request registered after retry" }]
                    };
                    sessionStorage.setItem("liftline-tracking", JSON.stringify(state.trackedEmergency));
                    if (state.view === "passenger") render();
                    showToast(`Queued emergency ${result.emergency.id} reached the server.`);
                } catch (error) {
                    if (error.status) {
                        showToast(`Queued request remains on this device: ${error.message}`, true);
                        break;
                    }
                    break;
                }
            }
        } catch (error) {
            showToast(`Offline queue could not be read: ${error.message}`, true);
        }
    }

    async function submitEmergency(form) {
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = {
            elevator_id: data.elevator_id,
            category: data.category || "Trapped inside elevator",
            description: data.description || "",
            requester_name: data.requester_name || "",
            client_request_id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
        };
        if (state.elevatorToken && state.qrElevatorId === data.elevator_id) {
            payload.elevator_token = state.elevatorToken;
        }
        const button = form.querySelector("#send-sos");
        button.disabled = true;
        button.textContent = "REGISTERING SOS…";
        try {
            if (!navigator.onLine) throw new TypeError("The server could not be reached.");
            const result = await api("/api/emergencies", {
                method: "POST",
                body: JSON.stringify(payload)
            });
            state.trackedEmergency = {
                emergency: result.emergency,
                token: result.tracking_token,
                message: result.message,
                history: [{ new_status: "New", created_at: result.emergency.created_at, note: "Request registered" }]
            };
            sessionStorage.setItem("liftline-tracking", JSON.stringify(state.trackedEmergency));
            state.view = "passenger";
            render();
            showToast(
                result.message,
                ["failed", "unconfigured", "in_app_only"].includes(result.delivery_status)
            );
        } catch (error) {
            if (error instanceof TypeError) {
                try {
                    await storeOfflineAlert(payload);
                    button.disabled = true;
                    button.textContent = "SOS SAVED — NOT SENT";
                    showToast("Saved on this device only. It has not reached responders. Use the elevator intercom or emergency phone now.", true);
                    return;
                } catch {
                    showToast("The SOS could not be queued. Use the elevator intercom or call the building emergency number.", true);
                }
            } else {
                showToast(error.message, true);
            }
            button.disabled = false;
            button.textContent = "SEND EMERGENCY SOS";
        }
    }

    async function handleSubmit(event) {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        try {
            if (form.id === "login-form") {
                const result = await api("/api/login", { method: "POST", body: JSON.stringify(data) });
                state.user = result.user;
                state.csrf = result.csrf_token;
                localStorage.setItem("liftline-csrf", state.csrf);
                state.view = state.user.role === "rescue_team" ? "rescue"
                    : state.user.role === "maintenance_engineer" ? "maintenance"
                        : state.user.role === "passenger" ? "passenger" : "overview";
                await loadElevators();
                await loadEmergencies();
                if (state.view === "maintenance" || state.view === "overview") await loadMaintenance();
                await refreshNotifications();
                render();
                showToast(`Signed in as ${roles[state.user.role]}.`);
                return;
            }
            if (form.id === "emergency-form") {
                await submitEmergency(form);
                return;
            }
            if (form.id === "maintenance-form") {
                await api("/api/maintenance", { method: "POST", body: JSON.stringify(data) });
                await loadMaintenance();
                render();
                showToast("Maintenance request created.");
                return;
            }
            if (form.id === "user-form") {
                const userId = form.dataset.userId;
                await api(userId ? `/api/users/${encodeURIComponent(userId)}` : "/api/users", {
                    method: userId ? "PUT" : "POST", body: JSON.stringify(data)
                });
                state.editUser = null;
                await loadUsers();
                await loadAudit();
                render();
                showToast(userId ? "Operator account updated." : "Operator account created.");
                return;
            }
            if (form.id === "elevator-form") {
                const payload = { ...data };
                const id = form.dataset.id;
                await api(id ? `/api/elevators/${encodeURIComponent(id)}` : "/api/elevators", {
                    method: id ? "PUT" : "POST", body: JSON.stringify(payload)
                });
                state.editElevator = null;
                await loadElevators();
                render();
                showToast(id ? "Elevator details updated." : "Elevator registered.");
                return;
            }
            if (form.matches("[data-maintenance-record]")) {
                const id = form.dataset.maintenanceRecord;
                await api(`/api/maintenance/${encodeURIComponent(id)}/records`, {
                    method: "POST", body: JSON.stringify(data)
                });
                await loadMaintenance();
                render();
                showToast("Maintenance record saved.");
            }
        } catch (error) {
            showToast(error.message, true);
        }
    }

    async function handleClick(event) {
        const button = event.target.closest("button, a");
        if (!button) return;
        if (button.dataset.view) {
            await navigate(button.dataset.view);
            return;
        }
        if (button.id === "account-button") {
            if (!state.user) {
                await navigate("login");
            } else {
                try {
                    await api("/api/logout", { method: "POST", body: JSON.stringify({}) });
                    state.user = null;
                    const sessionResult = await api("/api/session");
                    state.csrf = sessionResult.csrf_token;
                    state.channels = sessionResult.notification_channels;
                    state.manualEmergencyNumber = sessionResult.manual_emergency_number || "";
                    localStorage.setItem("liftline-csrf", state.csrf);
                    state.emergencies = [];
                    state.maintenance = [];
                    state.users = [];
                    state.audit = [];
                    state.delivery = { counts: [], failures: [] };
                    state.notifications = [];
                    state.unreadCount = 0;
                    state.history = [];
                    state.trackedEmergency = null;
                    state.editUser = null;
                    state.editElevator = null;
                    state.qrCode = null;
                    sessionStorage.removeItem("liftline-tracking");
                    document.getElementById("notifications-panel")?.remove();
                    state.view = "passenger";
                    render();
                    showToast("Signed out.");
                } catch (error) {
                    showToast(error.message, true);
                }
            }
            return;
        }
        if (button.id === "notification-button") {
            try { await loadNotifications(); } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.hasAttribute("data-close-notifications")) {
            document.getElementById("notifications-panel")?.remove();
            return;
        }
        if (button.dataset.accept) {
            try {
                await api(`/api/emergencies/${encodeURIComponent(button.dataset.accept)}/accept`, {
                    method: "POST", body: JSON.stringify({})
                });
                await loadEmergencies();
                render();
                showToast("Rescue request accepted and assigned to you.");
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.dataset.setStatus) {
            const id = button.dataset.setStatus;
            const maintenance = document.querySelector(`[data-maintenance-required="${CSS.escape(id)}"]`)?.checked || false;
            try {
                await api(`/api/emergencies/${encodeURIComponent(id)}/status`, {
                    method: "POST",
                    body: JSON.stringify({ status: button.dataset.status, maintenance_required: maintenance })
                });
                await loadEmergencies();
                if (maintenance || button.dataset.status === "Resolved") await loadMaintenance();
                render();
                showToast(`Emergency moved to ${button.dataset.status}.`);
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.dataset.refresh) {
            try {
                if (button.dataset.refresh === "emergencies") await loadEmergencies();
                render();
                showToast("Records refreshed.");
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.dataset.deactivateUser) {
            if (!window.confirm("Deactivate this user account?")) return;
            try {
                await api(`/api/users/${encodeURIComponent(button.dataset.deactivateUser)}/deactivate`, {
                    method: "POST", body: JSON.stringify({})
                });
                await loadUsers();
                await loadAudit();
                render();
                showToast("User account deactivated.");
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.dataset.editUser) {
            state.editUser = state.users.find((item) => item.id === button.dataset.editUser);
            render();
            return;
        }
        if (button.hasAttribute("data-cancel-user-edit")) {
            state.editUser = null;
            render();
            return;
        }
        if (button.dataset.editElevator) {
            state.editElevator = state.elevators.find((item) => item.id === button.dataset.editElevator);
            render();
            return;
        }
        if (button.hasAttribute("data-cancel-edit")) {
            state.editElevator = null;
            render();
            return;
        }
        if (button.dataset.generateQr) {
            try {
                state.qrCode = await api(`/api/elevators/${encodeURIComponent(button.dataset.generateQr)}/qr-token`, {
                    method: "POST", body: JSON.stringify({})
                });
                await loadElevators();
                render();
                showToast("New cabin QR generated. Replace any previously printed QR sticker.");
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.hasAttribute("data-close-qr")) {
            state.qrCode = null;
            render();
            return;
        }
        if (button.dataset.deactivateElevator) {
            if (!window.confirm("Remove this elevator from active use? Existing records will remain for audit/history.")) return;
            try {
                await api(`/api/elevators/${encodeURIComponent(button.dataset.deactivateElevator)}/deactivate`, {
                    method: "POST", body: JSON.stringify({})
                });
                await loadElevators();
                render();
                showToast("Elevator deactivated.");
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.dataset.closeMaintenance) {
            try {
                await api(`/api/maintenance/${encodeURIComponent(button.dataset.closeMaintenance)}/close`, {
                    method: "POST", body: JSON.stringify({})
                });
                await loadMaintenance();
                render();
                showToast("Maintenance request closed.");
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.dataset.notificationRead) {
            try {
                await api(`/api/notifications/${encodeURIComponent(button.dataset.notificationRead)}/read`, {
                    method: "POST", body: JSON.stringify({})
                });
                await loadNotifications();
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.hasAttribute("data-retry-notifications")) {
            try {
                const result = await api("/api/notifications/retry", {
                    method: "POST", body: JSON.stringify({})
                });
                await loadDelivery();
                render();
                showToast(`Queued notification retries for ${result.queued} incident${result.queued === 1 ? "" : "s"}.`);
            } catch (error) { showToast(error.message, true); }
            return;
        }
        if (button.hasAttribute("data-refresh-delivery")) {
            try {
                await loadDelivery();
                render();
            } catch (error) { showToast(error.message, true); }
        }
        if (button.hasAttribute("data-new-request")) {
            state.trackedEmergency = null;
            sessionStorage.removeItem("liftline-tracking");
            const nextUrl = state.qrElevatorId && state.elevatorToken
                ? `/?elevator=${encodeURIComponent(state.qrElevatorId)}#elevator_token=${encodeURIComponent(state.elevatorToken)}`
                : location.pathname;
            history.replaceState(null, "", nextUrl);
            render();
        }
    }

    async function updateTracking() {
        if (!state.trackedEmergency?.token) return;
        try {
            const tracked = state.trackedEmergency;
            const result = await api(`/api/emergencies/${encodeURIComponent(tracked.emergency.id)}/tracking`, {
                headers: { "X-Tracking-Token": tracked.token }
            });
            const previous = JSON.stringify({ emergency: tracked.emergency, history: tracked.history });
            state.trackedEmergency.emergency = result.emergency;
            state.trackedEmergency.history = result.history;
            state.trackingErrorShown = false;
            sessionStorage.setItem("liftline-tracking", JSON.stringify(state.trackedEmergency));
            if (state.view === "passenger" && previous !== JSON.stringify({
                emergency: state.trackedEmergency.emergency,
                history: state.trackedEmergency.history
            })) render();
        } catch {
            if (!state.trackingErrorShown) {
                showToast("Could not refresh emergency status. The last confirmed status remains visible.", true);
                state.trackingErrorShown = true;
            }
        }
    }

    async function bootstrap() {
        try {
            const sessionResult = await api("/api/session");
            state.user = sessionResult.user;
            state.csrf = sessionResult.csrf_token;
            localStorage.setItem("liftline-csrf", state.csrf);
            state.demoMode = sessionResult.demo_mode;
            state.channels = sessionResult.notification_channels;
            state.manualEmergencyNumber = sessionResult.manual_emergency_number || "";
            localStorage.setItem("liftline-manual-emergency-number", state.manualEmergencyNumber);
            const trackingId = new URLSearchParams(location.search).get("tracking");
            const qrElevatorId = new URLSearchParams(location.search).get("elevator");
            const hashParams = new URLSearchParams(location.hash.slice(1));
            const trackingToken = hashParams.get("token");
            state.qrElevatorId = qrElevatorId || "";
            state.elevatorToken = hashParams.get("elevator_token") || "";
            if (trackingId && trackingToken) {
                try {
                    const tracked = await api(`/api/emergencies/${encodeURIComponent(trackingId)}/tracking`, {
                        headers: { "X-Tracking-Token": trackingToken }
                    });
                    state.trackedEmergency = {
                        emergency: tracked.emergency,
                        token: trackingToken,
                        message: "Private tracking link loaded.",
                        history: tracked.history
                    };
                    sessionStorage.setItem("liftline-tracking", JSON.stringify(state.trackedEmergency));
                } catch (error) {
                    sessionStorage.removeItem("liftline-tracking");
                    history.replaceState(null, "", location.pathname);
                    showToast(`Tracking link unavailable: ${error.message}. You can still submit a new SOS.`, true);
                }
            } else {
                if (qrElevatorId) {
                    sessionStorage.removeItem("liftline-tracking");
                } else {
                    const savedTracking = sessionStorage.getItem("liftline-tracking");
                    if (savedTracking) state.trackedEmergency = JSON.parse(savedTracking);
                }
            }
            await loadElevators();
            if (state.user) {
                const defaultView = state.user.role === "rescue_team" ? "rescue"
                    : state.user.role === "maintenance_engineer" ? "maintenance"
                        : state.user.role === "passenger" ? "passenger" : "overview";
                state.view = defaultView;
                if (["rescue_team", "building_admin", "system_admin"].includes(state.user.role)) await loadEmergencies();
                if (["maintenance_engineer", "building_admin", "system_admin"].includes(state.user.role)) await loadMaintenance();
                if (state.user.role === "system_admin") await loadUsers();
                await refreshNotifications();
            } else {
                state.view = "passenger";
            }
        } catch (error) {
            state.user = null;
            state.csrf = localStorage.getItem("liftline-csrf") || "";
            state.manualEmergencyNumber = localStorage.getItem("liftline-manual-emergency-number") || "";
            state.view = "passenger";
            showToast(`Server unavailable: ${error.message}. Offline SOS requests will be queued locally.`, true);
        }
        render();
        syncOfflineAlerts();
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/service-worker.js").catch((error) => {
                showToast(`Offline app cache could not be installed: ${error.message}`, true);
            });
        }
        window.addEventListener("online", async () => {
            try {
                const sessionResult = await api("/api/session");
                state.csrf = sessionResult.csrf_token;
                localStorage.setItem("liftline-csrf", state.csrf);
                state.manualEmergencyNumber = sessionResult.manual_emergency_number || "";
                localStorage.setItem("liftline-manual-emergency-number", state.manualEmergencyNumber);
            } catch {
                // Keep the last token for a retry if the server is still waking up.
            }
            await syncOfflineAlerts();
        });
        navigator.serviceWorker?.addEventListener("message", (event) => {
            if (event.data?.type === "liftline-outbox-synced") {
                showToast("A queued SOS was delivered to the server.");
            }
        });
        window.setInterval(async () => {
            if (!state.user) {
                if (state.view === "passenger" && state.trackedEmergency) await updateTracking();
                return;
            }
            try {
                if (["overview", "incidents", "rescue"].includes(state.view)) {
                    let changed = await loadEmergencies();
                    if (state.view === "overview") changed = await loadMaintenance() || changed;
                    changed = await refreshNotifications() || changed;
                    if (changed) render();
                } else if (state.view === "maintenance") {
                    let changed = await loadMaintenance();
                    changed = await refreshNotifications() || changed;
                    if (changed) render();
                } else if (state.view === "admin") {
                    if (await refreshNotifications()) render();
                } else if (state.view === "passenger" && state.trackedEmergency) {
                    await updateTracking();
                }
            } catch {
                showToast("Live refresh failed. Check the connection and use the manual emergency procedure if needed.", true);
            }
        }, 5000);
    }

    document.body.addEventListener("click", handleClick);
    document.getElementById("content").addEventListener("submit", handleSubmit);
    document.getElementById("content").addEventListener("change", (event) => {
        if (event.target.id === "emergency-elevator") {
            state.selectedElevator = event.target.value;
            if (state.selectedElevator !== state.qrElevatorId) state.elevatorToken = "";
            render();
        }
    });
    document.getElementById("building-select").addEventListener("change", (event) => {
        state.buildingFilter = event.target.value;
        render();
    });

    bootstrap();
})();

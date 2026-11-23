(() => {
    const roles = {
        rescue_team: "Rescue team",
        building_admin: "Building administrator",
        maintenance_engineer: "Maintenance engineer",
        system_admin: "System administrator"
    };
    const seed = {
        elevators: [
            { id: "ELV-104", building: "Building A", location: "North tower · Floor 3", floors: "Ground, 1, 2", status: "Operational" },
            { id: "ELV-201", building: "Building B", location: "South tower · Floor 1", floors: "Ground, 1", status: "Operational" },
            { id: "ELV-301", building: "Admin Block", location: "Main entrance", floors: "Ground, 1, 2", status: "Unknown" }
        ],
        emergencies: [],
        maintenance: [],
        users: [
            { name: "Rescue Lead", email: "rescue@liftline.test", role: "rescue_team", active: true },
            { name: "Campus Administrator", email: "admin@liftline.test", role: "building_admin", active: true },
            { name: "Maintenance Engineer", email: "maintenance@liftline.test", role: "maintenance_engineer", active: true },
            { name: "System Administrator", email: "sysadmin@liftline.test", role: "system_admin", active: true }
        ],
        notifications: []
    };
    const storageKey = "liftline-classroom-demo-v1";
    const state = {
        db: readDb(),
        user: null,
        view: "passenger",
        selectedElevator: "ELV-104",
        trackedId: "",
        notice: ""
    };
    const content = document.getElementById("content");

    function readDb() {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
            if (saved && Array.isArray(saved.elevators) && Array.isArray(saved.emergencies)) return saved;
        } catch { }
        return structuredClone(seed);
    }

    function save() {
        localStorage.setItem(storageKey, JSON.stringify(state.db));
    }

    function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[char]);
    }

    function time(value) {
        return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }

    function badge(status) {
        const type = status === "Resolved" || status === "Closed" || status === "Operational"
            ? "resolved" : status === "New" || status === "Urgent" ? "new" : "accepted";
        return `<span class="status-badge ${type}">${escapeHtml(status)}</span>`;
    }

    function heading(kicker, title, subtitle) {
        return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(kicker)}</div><h1>${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p></div></div>`;
    }

    function currentLift() {
        return state.db.elevators.find((item) => item.id === state.selectedElevator) || state.db.elevators[0];
    }

    function activeEmergencies() {
        return state.db.emergencies.filter((item) => !["Resolved", "Closed"].includes(item.status));
    }

    function syncChrome() {
        document.querySelectorAll(".nav-button").forEach((button) => {
            const permitted = (button.dataset.roles || "").split(",").filter(Boolean);
            button.hidden = permitted.length > 0 && !permitted.includes(state.user?.role);
            button.classList.toggle("active", button.dataset.view === state.view);
        });
        document.getElementById("sidebar-name").textContent = state.user?.name || "Not signed in";
        document.getElementById("sidebar-role").textContent = roles[state.user?.role] || "Passenger";
        document.getElementById("sidebar-avatar").textContent = (state.user?.name || "?").split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
        document.getElementById("account-button").textContent = state.user ? "Sign out" : "Sign in";
        document.getElementById("breadcrumb").textContent = ({
            overview: "Overview", incidents: "Emergencies", rescue: "Rescue team", elevators: "Elevators",
            maintenance: "Maintenance", history: "Emergency history", passenger: "Passenger SOS",
            admin: "Administration", login: "Sign in"
        })[state.view] || "Passenger SOS";
        const count = activeEmergencies().length;
        const navCount = document.getElementById("nav-count");
        navCount.textContent = count;
        navCount.hidden = !state.user || !count;
        const dot = document.querySelector(".icon-button .dot");
        const unread = state.db.notifications.filter((item) => !item.read).length;
        dot.hidden = !state.user || unread === 0;
        dot.title = unread ? `${unread} notification${unread === 1 ? "" : "s"}` : "No new notifications";
        const buildingSelect = document.getElementById("building-select");
        buildingSelect.innerHTML = `<option value="all">All buildings</option>${[...new Set(state.db.elevators.map((item) => item.building))].map((building) => `<option>${escapeHtml(building)}</option>`).join("")}`;
    }

    function renderPassenger() {
        const tracked = state.db.emergencies.find((item) => item.id === state.trackedId);
        if (tracked) {
            return `${heading("PASSENGER SUPPORT", "Emergency submitted", "Presentation mode — no real rescue alert was sent.")}
                <article class="panel tracking-card"><div class="tracking-heading"><span class="tracking-check">✓</span><span><h3>Request recorded</h3><p>Saved in this browser only; no response team was notified.</p></span></div>
                <div class="tracking-id"><span>EMERGENCY REFERENCE</span><strong>${escapeHtml(tracked.id)}</strong></div>
                <p class="card-description">${escapeHtml(tracked.building)} · ${escapeHtml(tracked.elevator_id)} · ${escapeHtml(tracked.location)}</p>
                <p>Location manually selected · unverified</p>${badge(tracked.status)}
                <div class="timeline">${tracked.history.map((item) => `<div class="timeline-item done"><span class="timeline-dot"></span><strong>${escapeHtml(item.status)}</strong><span>${time(item.at)} · ${escapeHtml(item.note)}</span></div>`).join("")}</div>
                <button class="button" data-action="new-sos">Report another emergency</button></article>`;
        }
        const lift = currentLift();
        return `${heading("PASSENGER SUPPORT", "Need help with your elevator?", "One-tap emergency request associated with a registered lift.")}
            <div class="sos-layout"><section class="panel sos-card"><h2>Emergency SOS</h2><p>Category and details are optional. Requests are stored in this browser only.</p>
            <div class="location-box"><span><strong>${escapeHtml(lift?.id || "No lift")} · ${escapeHtml(lift?.building || "")}</strong><span>${escapeHtml(lift?.location || "")} · Floors ${escapeHtml(lift?.floors || "")}</span></span></div>
            <form id="demo-sos-form"><div class="form-field"><label>Elevator</label><select name="elevator_id">${state.db.elevators.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.selectedElevator ? "selected" : ""}>${escapeHtml(item.id)} · ${escapeHtml(item.building)} · ${escapeHtml(item.location)}</option>`).join("")}</select></div>
            <div class="form-field"><label>Category (optional)</label><select name="category"><option>Trapped inside elevator</option><option>Elevator stopped / fault</option><option>Other urgent issue</option></select></div>
            <div class="form-field"><label>Additional details (optional)</label><textarea name="description" maxlength="500"></textarea></div>
            <div class="form-field"><label>Name (optional)</label><input name="requester_name" maxlength="80"></div>
            <button class="button button-danger sos-button" type="submit">SEND EMERGENCY SOS</button></form></section>
            <article class="panel tracking-card"><h3>Presentation mode</h3><p class="card-description">No staff are notified. No email, SMS, elevator control, or emergency-service dispatch occurs.</p><div class="timeline"><div class="timeline-item done"><span class="timeline-dot"></span><strong>Register request</strong><span>Stored in this browser</span></div><div class="timeline-item"><span class="timeline-dot"></span><strong>Staff response</strong><span>Switch to Rescue team to advance it</span></div><div class="timeline-item"><span class="timeline-dot"></span><strong>Track progress</strong><span>View status in this browser</span></div></div></article></div>`;
    }

    function emergencyRows(items) {
        if (!items.length) return `<div class="empty-state"><strong>No emergency requests</strong>Submit a passenger SOS to populate the queue.</div>`;
        return `<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Elevator / location</th><th>Category</th><th>Status</th><th>Action</th></tr></thead><tbody>${items.map((item) => `<tr><td class="cell-strong">${escapeHtml(item.id)}<div class="cell-sub">${time(item.created_at)}</div></td><td>${escapeHtml(item.elevator_id)} · ${escapeHtml(item.building)}<div class="cell-sub">${escapeHtml(item.location)}</div></td><td>${escapeHtml(item.category)}</td><td>${badge(item.status)}</td><td>${item.status === "New" ? `<button class="button button-small" data-action="accept" data-id="${item.id}">Accept</button>` : item.status === "Accepted" ? `<button class="button button-small" data-action="status" data-status="In Progress" data-id="${item.id}">Start response</button>` : item.status === "In Progress" ? `<button class="button button-small" data-action="status" data-status="Resolved" data-id="${item.id}">Resolve</button>` : `<span class="cell-sub">Recorded</span>`}</td></tr>`).join("")}</tbody></table></div>`;
    }

    function renderOverview() {
        return `${heading("SAFETY OPERATIONS", "Campus overview", "Records are saved in this browser for presentation.")}
            <div class="stats-grid"><article class="stat-card"><div class="stat-top">Active emergencies</div><div class="stat-value">${activeEmergencies().length}</div><div class="stat-foot">New, accepted, or in progress</div></article><article class="stat-card"><div class="stat-top">Registered lifts</div><div class="stat-value">${state.db.elevators.length}</div><div class="stat-foot">Elevator register</div></article><article class="stat-card"><div class="stat-top">Resolved / closed</div><div class="stat-value">${state.db.emergencies.filter((item) => ["Resolved", "Closed"].includes(item.status)).length}</div><div class="stat-foot">Emergency history</div></article><article class="stat-card"><div class="stat-top">Open maintenance</div><div class="stat-value">${state.db.maintenance.filter((item) => item.status !== "Closed").length}</div><div class="stat-foot">Service requests</div></article></div>
            <section class="panel"><div class="panel-heading"><div><h3>Recent emergencies</h3><p>Changes are visible to other workspaces in this browser.</p></div></div>${emergencyRows(state.db.emergencies.slice().reverse().slice(0, 8))}</section>`;
    }

    function renderIncidents() {
        return `${heading("LIVE QUEUE", "Emergencies", "Advance requests through the rescue workflow.")}<section class="panel">${emergencyRows(state.db.emergencies.slice().reverse())}</section>`;
    }

    function renderRescue() {
        const queue = state.db.emergencies.filter((item) => !["Resolved", "Closed"].includes(item.status));
        return `${heading("FIELD RESPONSE", "Rescue team", "Accept requests, record response progress, and resolve incidents.")}<section class="panel"><div class="panel-heading"><div><h3>Rescue queue</h3><p>${queue.length} active request${queue.length === 1 ? "" : "s"}</p></div></div>${emergencyRows(queue)}</section>`;
    }

    function renderMaintenance() {
        return `${heading("SERVICE REQUESTS", "Maintenance", "Create and close inspection or repair records.")}
            <section class="panel" style="margin-bottom:16px"><form id="demo-maintenance-form"><div class="form-row"><div class="form-field"><label>Elevator</label><select name="elevator_id">${state.db.elevators.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)} · ${escapeHtml(item.building)}</option>`).join("")}</select></div><div class="form-field"><label>Priority</label><select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select></div></div><div class="form-field"><label>Inspection / repair details</label><textarea name="description" required></textarea></div><button class="button button-primary">Create work order</button></form></section>
            <section class="content-grid">${state.db.maintenance.length ? state.db.maintenance.slice().reverse().map((item) => `<article class="maintenance-card"><div class="card-top"><div class="card-title">${escapeHtml(item.id)} · ${escapeHtml(item.elevator_id)}</div>${badge(item.status)}</div><p>${escapeHtml(item.description)}</p><p class="cell-sub">${escapeHtml(item.priority)} priority · ${time(item.created_at)}</p>${item.status !== "Closed" ? `<button class="button button-small" data-action="close-maintenance" data-id="${item.id}">Close work order</button>` : ""}</article>`).join("") : `<article class="panel"><div class="empty-state"><strong>No maintenance work</strong>Create a work order above.</div></article>`}</section>`;
    }

    function renderElevators() {
        return `${heading("REGISTERED EQUIPMENT", "Elevators", "Manage the lift register for this presentation.")}
            <section class="panel" style="margin-bottom:16px"><form id="demo-elevator-form"><div class="form-row"><div class="form-field"><label>Elevator ID</label><input name="id" required></div><div class="form-field"><label>Building</label><input name="building" required></div></div><div class="form-row"><div class="form-field"><label>Location</label><input name="location" required></div><div class="form-field"><label>Floors served</label><input name="floors" required></div></div><button class="button button-primary">Add elevator</button></form></section>
            <section class="panel"><div class="table-wrap"><table><thead><tr><th>Elevator</th><th>Building / location</th><th>Floors</th><th>Status</th></tr></thead><tbody>${state.db.elevators.map((item) => `<tr><td class="cell-strong">${escapeHtml(item.id)}</td><td>${escapeHtml(item.building)}<div class="cell-sub">${escapeHtml(item.location)}</div></td><td>${escapeHtml(item.floors)}</td><td>${badge(item.status)}</td></tr>`).join("")}</tbody></table></div></section>`;
    }

    function renderHistory() {
        const rows = state.db.emergencies.filter((item) => ["Resolved", "Closed"].includes(item.status));
        return `${heading("AUDITABLE RECORDS", "Emergency history", "Resolved and closed requests are retained in this browser.")}<section class="panel"><div class="panel-heading"><div><h3>History</h3></div><button class="button button-small" data-action="export">Export CSV</button></div>${emergencyRows(rows)}</section>`;
    }

    function renderAdmin() {
        return `${heading("AUTHORIZED ADMINISTRATION", "Users & access", "Role management is simulated in this browser.")}
            <section class="panel" style="margin-bottom:16px"><form id="demo-user-form"><div class="form-row"><div class="form-field"><label>Name</label><input name="name" required></div><div class="form-field"><label>Email</label><input name="email" type="email" required></div></div><div class="form-field"><label>Role</label><select name="role">${Object.entries(roles).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></div><button class="button button-primary">Add account</button></form></section>
            <section class="panel"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody>${state.db.users.map((user, i) => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(roles[user.role] || user.role)}</td><td>${user.active ? "Active" : "Disabled"}</td><td>${user.active ? `<button class="button button-small" data-action="disable-user" data-index="${i}">Disable</button>` : ""}</td></tr>`).join("")}</tbody></table></div><button class="button button-small" data-action="reset">Reset presentation data</button></section>`;
    }

    function renderLogin() {
        return `${heading("SIGN IN", "Choose a workspace", "Select a role to present its workflow.")}
            <section class="panel"><p>Role switching is simulated and requires no password. Records remain in this browser.</p><div class="content-grid">${Object.entries(roles).map(([role, name]) => `<button class="button" data-action="login" data-role="${role}">Continue as ${escapeHtml(name)}</button>`).join("")}</div></section>`;
    }

    function render() {
        syncChrome();
        const pages = {
            passenger: renderPassenger, overview: renderOverview, incidents: renderIncidents,
            rescue: renderRescue, maintenance: renderMaintenance, elevators: renderElevators,
            history: renderHistory, admin: renderAdmin, login: renderLogin
        };
        content.innerHTML = `<div class="warning-panel"><strong>Presentation mode — not for real emergencies</strong><span>Workflows are simulated. Data is saved in this browser; no staff or emergency services are contacted.</span></div>${pages[state.view]()}${state.notice ? `<div class="toast">${escapeHtml(state.notice)}</div>` : ""}`;
        state.notice = "";
    }

    function notify(title, message) {
        state.db.notifications.unshift({ title, message, read: false, created_at: new Date().toISOString() });
    }

    function addMaintenance(item, description) {
        const id = `WO-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
        state.db.maintenance.push({ id, elevator_id: item.elevator_id, description, priority: "Normal", status: "Open", created_at: new Date().toISOString() });
        const lift = state.db.elevators.find((elevator) => elevator.id === item.elevator_id);
        if (lift) lift.status = "Under maintenance";
    }

    function updateStatus(id, status) {
        const item = state.db.emergencies.find((entry) => entry.id === id);
        if (!item) return;
        const old = item.status;
        item.status = status;
        item.updated_at = new Date().toISOString();
        item.history.push({ status, at: item.updated_at, note: status === "Accepted" ? "Rescue request accepted" : `Status changed from ${old}` });
        if (status === "Accepted") item.assigned_rescuer = state.user?.name || "Rescue Lead";
        if (status === "Resolved" && (item.category === "Elevator stopped / fault" || item.maintenance_required)) {
            addMaintenance(item, `Follow-up for ${item.id}: ${item.category}`);
            notify("New maintenance request", `Work order created for ${item.elevator_id}.`);
        }
        notify("Emergency updated", `${item.id} is now ${status}.`);
    }

    function handleClick(event) {
        const button = event.target.closest("button, a");
        if (!button) return;
        if (button.dataset.view) {
            state.view = button.dataset.view;
            render();
            return;
        }
        if (button.id === "account-button") {
            state.view = state.user ? "passenger" : "login";
            state.user = null;
            render();
            return;
        }
        if (button.id === "notification-button") {
            const notices = state.db.notifications.slice(0, 8);
            window.alert(notices.length ? notices.map((item) => `${item.title}: ${item.message}`).join("\n") : "No notifications.");
            state.db.notifications.forEach((item) => { item.read = true; });
            save();
            render();
            return;
        }
        if (button.dataset.action === "login") {
            const user = state.db.users.find((item) => item.role === button.dataset.role && item.active);
            state.user = user || { name: roles[button.dataset.role], role: button.dataset.role };
            state.view = state.user.role === "rescue_team" ? "rescue" : state.user.role === "maintenance_engineer" ? "maintenance" : state.user.role === "system_admin" || state.user.role === "building_admin" ? "overview" : "passenger";
            render();
        } else if (button.dataset.action === "new-sos") {
            state.trackedId = "";
            state.view = "passenger";
            render();
        } else if (button.dataset.action === "accept") {
            updateStatus(button.dataset.id, "Accepted");
            save(); render();
        } else if (button.dataset.action === "status") {
            updateStatus(button.dataset.id, button.dataset.status);
            save(); render();
        } else if (button.dataset.action === "close-maintenance") {
            const order = state.db.maintenance.find((item) => item.id === button.dataset.id);
            if (order) {
                order.status = "Closed";
                const lift = state.db.elevators.find((item) => item.id === order.elevator_id);
                if (lift && !state.db.maintenance.some((item) => item.elevator_id === lift.id && item.status !== "Closed")) lift.status = "Operational";
            }
            save(); render();
        } else if (button.dataset.action === "disable-user") {
            state.db.users[Number(button.dataset.index)].active = false;
            save(); render();
        } else if (button.dataset.action === "reset") {
            if (window.confirm("Reset this browser’s presentation data?")) {
                state.db = structuredClone(seed);
                state.trackedId = "";
                save(); render();
            }
        } else if (button.dataset.action === "export") {
            const csv = ["Reference,Elevator,Building,Category,Status,Created", ...state.db.emergencies.map((item) =>
                [item.id, item.elevator_id, item.building, item.category, item.status, item.created_at]
                    .map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")
            )].join("\r\n");
            const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
            const link = document.createElement("a");
            link.href = url; link.download = "liftline-emergency-history.csv"; link.click();
            URL.revokeObjectURL(url);
        }
    }

    function handleSubmit(event) {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        if (form.id === "demo-sos-form") {
            const lift = state.db.elevators.find((item) => item.id === data.elevator_id);
            const id = `EM-${new Date().getFullYear()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
            const emergency = {
                id, elevator_id: lift.id, building: lift.building, location: lift.location,
                requester_name: data.requester_name, category: data.category || "Trapped inside elevator",
                description: data.description || "", status: "New", created_at: new Date().toISOString(),
                history: [{ status: "New", at: new Date().toISOString(), note: "Request registered in this browser" }]
            };
            state.db.emergencies.push(emergency);
            notify("New elevator emergency", `${id} · ${lift.building} · ${lift.id} · ${emergency.category}`);
            state.trackedId = id;
            save(); render();
        } else if (form.id === "demo-maintenance-form") {
            const lift = state.db.elevators.find((item) => item.id === data.elevator_id);
            const order = { id: `WO-${Math.random().toString(16).slice(2, 10).toUpperCase()}`, elevator_id: lift.id, description: data.description, priority: data.priority, status: "Open", created_at: new Date().toISOString() };
            state.db.maintenance.push(order);
            lift.status = "Under maintenance";
            notify("New maintenance request", `Work order ${order.id} created for ${lift.id}.`);
            save(); render();
        } else if (form.id === "demo-elevator-form") {
            if (state.db.elevators.some((item) => item.id === data.id)) {
                window.alert("That elevator ID already exists.");
                return;
            }
            state.db.elevators.push({ ...data, status: "Unknown" });
            save(); render();
        } else if (form.id === "demo-user-form") {
            state.db.users.push({ ...data, active: true });
            save(); render();
        }
    }

    document.body.addEventListener("click", handleClick);
    content.addEventListener("submit", handleSubmit);
    content.addEventListener("change", (event) => {
        if (event.target.name === "elevator_id") {
            state.selectedElevator = event.target.value;
            render();
        }
    });
    window.addEventListener("storage", (event) => {
        if (event.key === storageKey) {
            state.db = readDb();
            render();
        }
    });
    render();
})();

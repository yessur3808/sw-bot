const appRoot = document.getElementById("app");
const csrfToken = appRoot?.dataset?.csrf || "";

let state = {
    settings: {},
    sources: { hk: [], global: [] },
    pending_events: [],
    source_status: [],
    recent_runs: [],
    audit: [],
    llm_status_counts: [],
    llm_skip_reasons: [],
    reddit_cache_stats: { total: 0, relayed: 0, by_type: [] },
    reddit_subreddit_counts: [],
    reddit_cache_rows: [],
    reddit_cache_total: 0,
    reddit_cache_limit: 20,
    reddit_cache_offset: 0,
    dataset_candidates_rows: [],
    dataset_candidates_total: 0,
    dataset_candidates_limit: 40,
    dataset_candidates_offset: 0,
    telemetry_hours: 24,
    telemetry_summary: {},
    telemetry_alerts: [],
    command_usage_counts: [],
    top_commands: [],
    command_error_rates: [],
    scheduler_topics: [],
    scheduler_outcomes: [],
    scheduler_breakdown: [],
    scheduler_trends: [],
    scheduler_outcome_timeseries: [],
    scheduled_upcoming: [],
    schedulerPlanDetail: null,
    command_failure_timeseries: [],
    system_metrics: {},
    schema_status: null,
    recent_tasks: [],
    holidays_rows: [],
    holidays_total: 0,
    holidays_region: "hk",
    holidays_year: null,
    ai_config: {},
    admin_profiles: [],
    current_admin_profile: null,
};

let activeDataset = "facts";
let activeSourceType = "hk";
let sourceBuilderRows = [];
let redditPage = 1;
let activeHealthTab = "overview";
let healthPollId = null;
let liveRefreshId = null;
let adminDrafts = [];
let selectedCandidateIds = new Set();
let candidateFilterTimer = null;
let candidateViewMode = "compact";
let expandedCandidateIds = new Set();
const candidateViewStorageKey = "admin.datasetCandidates.viewMode";
const recentTasksHideCompletedStorageKey = "admin.recentTasks.hideCompleted";
let recentTasksHideCompleted = false;
let connectionState = {
    tone: "loading",
    label: "Connecting...",
    detail: "Loading dashboard data",
};
const healthHistory = {
    cpu: [],
    mem: [],
    load: [],
};

const requestJson = async (url, options = {}) => {
    const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {}),
    };
    const method = String(options.method || "GET").toUpperCase();
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : 15000;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timeoutId = null;
    if (options.method && options.method !== "GET") {
        headers["X-CSRF-Token"] = csrfToken;
    }
    try {
        if (controller) {
            timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
        }
        const response = await fetch(url, {
            ...options,
            headers,
            signal: controller ? controller.signal : options.signal,
            cache: method === "GET" ? "no-store" : options.cache,
        });
        if (!response.ok) {
            const bodyText = await response.text();
            let detail = "";
            try {
                const body = bodyText ? JSON.parse(bodyText) : null;
                detail = body?.error || body?.description || "";
            } catch (_) {
                detail = bodyText;
            }
            throw new Error(detail || `Request failed: ${response.status}`);
        }
        return response.json();
    } catch (err) {
        if (err?.name === "AbortError") {
            throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
        }
        throw err;
    } finally {
        if (timeoutId) {
            window.clearTimeout(timeoutId);
        }
    }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pollTaskUntilDone = async (taskId, options = {}) => {
    const intervalMs = Math.max(250, Number(options.intervalMs || 1200));
    const maxWaitMs = Math.max(5000, Number(options.maxWaitMs || 10 * 60 * 1000));
    const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;
    const startedAt = Date.now();

    while (true) {
        const task = await requestJson(`/admin/api/tasks/${encodeURIComponent(taskId)}`);
        if (onUpdate) {
            onUpdate(task);
        }

        if (task.status === "succeeded") {
            return task;
        }
        if (task.status === "failed") {
            throw new Error(task.error || "Task failed");
        }
        if ((Date.now() - startedAt) > maxWaitMs) {
            throw new Error("Task polling timed out");
        }

        await sleep(intervalMs);
    }
};

const renderConnectionStatus = () => {
    const pill = document.getElementById("connection-status");
    const label = document.getElementById("connection-status-label");
    const detail = document.getElementById("connection-status-detail");
    if (!pill || !label || !detail) {
        return;
    }
    pill.classList.remove("is-loading", "is-ok", "is-error");
    pill.classList.add(`is-${connectionState.tone || "loading"}`);
    label.textContent = connectionState.label || "Unknown";
    detail.textContent = connectionState.detail || "";
};

const setConnectionStatus = (tone, label, detail) => {
    connectionState = { tone, label, detail };
    renderConnectionStatus();
};

const setDashboardLoading = (isLoading, detail = "Loading dashboard data") => {
    document.body.classList.toggle("is-loading", isLoading);
    if (isLoading) {
        setConnectionStatus("loading", "Connecting...", detail);
    }
};

const createListItem = (title, subtitle, actions = []) => {
    const wrap = document.createElement("div");
    wrap.className = "list-item";
    const line = document.createElement("p");
    line.innerHTML = title;
    const small = document.createElement("small");
    small.innerHTML = subtitle;
    wrap.append(line, small);
    if (actions.length) {
        const row = document.createElement("div");
        row.className = "button-row";
        actions.forEach((button) => row.appendChild(button));
        wrap.appendChild(row);
    }
    return wrap;
};

const renderSchemaStatus = () => {
    const target = document.getElementById("schema-status-card");
    if (!target) {
        return;
    }
    target.innerHTML = "";
    const schema = state.schema_status;
    if (!schema) {
        target.appendChild(createListItem("Schema status", "Loading migration status..."));
        return;
    }

    const statusText = schema.is_up_to_date ? "Up to date" : `Pending ${schema.pending_versions?.length || 0}`;
    const currentVersion = schema.current_version || "none";
    const latestVersion = schema.latest_available_version || "none";
    const details = `backend=${schema.backend} | current=${currentVersion} | latest=${latestVersion} | status=${statusText}`;
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy Migration Command";
    copyButton.onclick = async () => {
        try {
            await navigator.clipboard.writeText(schema.migration_command || "");
            copyButton.textContent = "Copied";
            setTimeout(() => {
                copyButton.textContent = "Copy Migration Command";
            }, 1200);
        } catch (_) {
            alert(schema.migration_command || "No command available");
        }
    };

    const item = createListItem("Schema Version", details, [copyButton]);
    if (Array.isArray(schema.pending_versions) && schema.pending_versions.length) {
        const pending = document.createElement("small");
        pending.className = "candidate-source";
        pending.textContent = `pending: ${schema.pending_versions.join(", ")}`;
        item.appendChild(pending);
    }
    const command = document.createElement("small");
    command.className = "candidate-source";
    command.textContent = schema.migration_command || "";
    item.appendChild(command);
    target.appendChild(item);
};

const escapeHtml = (value) => {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
};

const setActivePills = (selector, attrName, activeValue) => {
    document.querySelectorAll(selector).forEach((button) => {
        button.classList.toggle("active", button.dataset[attrName] === activeValue);
    });
};

const normalizeAdminProfile = (profile = {}) => ({
    user_id: profile.user_id ?? "",
    display_name: profile.display_name ?? "",
    username: profile.username ?? "",
    email: profile.email ?? "",
    role: profile.role ?? "admin",
    is_active: Boolean(profile.is_active),
    is_primary: Boolean(profile.is_primary),
    notes: profile.notes ?? "",
});

const renderAiConfig = () => {
    const cfg = state.ai_config || {};
    const summary = document.getElementById("ai-summary");
    const provider = document.getElementById("ai-provider-detail");
    const integration = document.getElementById("ai-integration-detail");
    const notes = document.getElementById("ai-notes-detail");
    const catalog = document.getElementById("ai-catalog");
    if (summary) {
        summary.innerHTML = "";
        [
            { label: "Provider", value: cfg.provider || "n/a" },
            { label: "Model", value: cfg.model || "n/a" },
            { label: "Max Tokens", value: cfg.max_tokens || "n/a" },
            { label: "Temperature", value: cfg.temperature ?? "n/a" },
        ].forEach((metric) => {
            const node = document.createElement("div");
            node.className = "metric";
            node.innerHTML = `<b>${escapeHtml(metric.value)}</b><span>${escapeHtml(metric.label)}</span>`;
            summary.appendChild(node);
        });
    }
    if (provider) {
        provider.textContent = `${cfg.provider || "unknown"} | ${cfg.enabled ? "enabled" : "disabled"} | autonomous ${cfg.autonomous_mode ? "on" : "off"}`;
    }
    if (integration) {
        integration.textContent = cfg.api_base_url ? `API base URL: ${cfg.api_base_url}` : "Using the provider default API endpoint.";
    }
    if (notes) {
        notes.textContent = `Reply cap ${cfg.reply_daily_cap ?? "n/a"} / day, cooldown ${cfg.reply_cooldown_seconds ?? "n/a"}s, scope ${cfg.thread_scope_mode || "allowlist"}. Use the provider cards below to compare or integrate other APIs.`;
    }
    if (catalog) {
        catalog.innerHTML = "";
        (cfg.available_integrations || []).forEach((item) => {
            const card = document.createElement("div");
            card.className = "catalog-card";
            card.innerHTML = `
                <p>${escapeHtml(item.name || "Integration")}</p>
                <small>${escapeHtml(item.url || "")}</small>
                <div class="card-actions">
                    <a class="ai-link" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">Open Docs ↗</a>
                </div>
            `;
            catalog.appendChild(card);
        });
    }
};

const renderCurrentAdminProfile = () => {
    const form = document.getElementById("admin-profile-form");
    if (!form) {
        return;
    }
    const profile = normalizeAdminProfile(state.current_admin_profile || { user_id: state.user_id });
    form.elements.user_id.value = profile.user_id || state.user_id || "";
    form.elements.display_name.value = profile.display_name || "";
    form.elements.username.value = profile.username || "";
    form.elements.email.value = profile.email || "";
    form.elements.role.value = profile.role || "admin";
    form.elements.notes.value = profile.notes || "";
    form.elements.is_active.checked = Boolean(profile.is_active);
    form.elements.is_primary.checked = Boolean(profile.is_primary);
};

const renderAdminDirectory = () => {
    const target = document.getElementById("admin-directory");
    if (!target) {
        return;
    }
    const profiles = [...adminDrafts, ...(state.admin_profiles || []).map((row) => normalizeAdminProfile(row))];
    target.innerHTML = "";
    if (!profiles.length) {
        target.appendChild(createListItem("No admins configured", "Use Add Admin to create the first profile."));
        return;
    }
    profiles.forEach((profile, idx) => {
        const card = document.createElement("div");
        card.className = "admin-card";
        card.dataset.adminIndex = String(idx);
        const isDraft = !profile.user_id;
        card.innerHTML = `
            <div class="audit-top">
                <span class="audit-action">${profile.user_id || "New Admin"}</span>
                <span class="audit-meta">${profile.is_primary ? "primary" : profile.is_active ? "active" : "inactive"}</span>
            </div>
            <div class="settings-grid settings-grid-modern">
                <label>User ID<input data-admin-field="user_id" type="number" value="${escapeHtml(profile.user_id)}"></label>
                <label>Display Name<input data-admin-field="display_name" type="text" value="${escapeHtml(profile.display_name)}"></label>
                <label>Username<input data-admin-field="username" type="text" value="${escapeHtml(profile.username)}"></label>
                <label>Email<input data-admin-field="email" type="email" value="${escapeHtml(profile.email)}"></label>
                <label>Role<input data-admin-field="role" type="text" value="${escapeHtml(profile.role)}"></label>
                <label>Notes<input data-admin-field="notes" type="text" value="${escapeHtml(profile.notes)}"></label>
            </div>
            <div class="badge-row">
                <span class="small-chip">${profile.is_primary ? "Primary" : "Contact"}</span>
                <span class="small-chip">${profile.is_active ? "Active" : "Inactive"}</span>
            </div>
            <div class="card-actions">
                <label class="switch-row"><input data-admin-field="is_active" type="checkbox" ${profile.is_active ? "checked" : ""}><span>Active</span></label>
                <label class="switch-row"><input data-admin-field="is_primary" type="checkbox" ${profile.is_primary ? "checked" : ""}><span>Primary</span></label>
                <button type="button" data-admin-action="save">Save</button>
                <button type="button" data-admin-action="delete">Delete</button>
            </div>
        `;

        const saveButton = card.querySelector("[data-admin-action='save']");
        const deleteButton = card.querySelector("[data-admin-action='delete']");
        if (isDraft) {
            deleteButton.textContent = "Discard";
        }

        saveButton.onclick = async () => {
            const read = (field) => card.querySelector(`[data-admin-field='${field}']`);
            const payload = {
                user_id: read("user_id")?.value,
                display_name: read("display_name")?.value,
                username: read("username")?.value,
                email: read("email")?.value,
                role: read("role")?.value,
                notes: read("notes")?.value,
                is_active: Boolean(read("is_active")?.checked),
                is_primary: Boolean(read("is_primary")?.checked),
            };
            try {
                await requestJson("/admin/api/admin-profiles", {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
                adminDrafts = [];
                await loadAdminProfiles();
                alert("Admin profile saved");
            } catch (err) {
                alert(err.message);
            }
        };

        deleteButton.onclick = async () => {
            if (isDraft) {
                const draftIdx = adminDrafts.indexOf(profile);
                if (draftIdx >= 0) {
                    adminDrafts.splice(draftIdx, 1);
                }
                renderAdminDirectory();
                return;
            }
            if (!confirm(`Remove admin ${profile.user_id}?`)) {
                return;
            }
            try {
                await requestJson(`/admin/api/admin-profiles/${profile.user_id}`, { method: "DELETE" });
                await loadAdminProfiles();
                alert("Admin removed");
            } catch (err) {
                alert(err.message);
            }
        };

        target.appendChild(card);
    });
};

const loadAdminProfiles = async () => {
    const payload = await requestJson("/admin/api/admin-profiles");
    state.admin_profiles = payload.rows || [];
    renderAdminDirectory();
    renderCurrentAdminProfile();
};

const formatRunTime = (value) => {
    if (!value) {
        return "unknown";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
    return date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
};

const chartWidth = 720;

const truncateChartLabel = (label, maxLength = 18) => {
    const text = String(label || "");
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength - 1)}…`;
};

const formatChartValue = (value) => {
    const numeric = Number(value || 0);
    if (Number.isInteger(numeric)) {
        return String(numeric);
    }
    return numeric.toFixed(1);
};

const chartValueSuffix = (chartId, options = {}) => {
    if (typeof options.valueSuffix === "string") {
        return options.valueSuffix;
    }
    if (chartId === "chart-source-ratio") {
        return "%";
    }
    if (chartId === "chart-llm-status" || chartId === "chart-reddit-type" || chartId === "chart-reddit-subreddits") {
        return " count";
    }
    return "";
};

const chartSeriesLabels = (chartId, options = {}) => {
    if (Array.isArray(options.seriesLabels) && options.seriesLabels.length) {
        return options.seriesLabels;
    }
    switch (chartId) {
        case "chart-throughput":
            return ["Fetched", "Saved"];
        case "chart-health-usage":
            return ["CPU", "Memory"];
        case "chart-health-cpu":
            return ["CPU"];
        case "chart-health-memory":
            return ["Memory"];
        case "chart-health-load":
            return ["Load"];
        default:
            return ["Series A", "Series B"];
    }
};

const createChartShell = (containerId, height) => {
    if (!window.d3) {
        const fallback = document.getElementById(containerId);
        if (fallback) {
            fallback.innerHTML = '<div class="help">Interactive charts require D3.js to load.</div>';
        }
        return null;
    }
    const container = d3.select(`#${containerId}`);
    if (container.empty()) {
        return null;
    }
    container.selectAll("*").remove();
    container.style("position", "relative").style("min-height", `${height}px`);

    const tooltip = container.append("div").attr("class", "chart-tooltip");
    const svg = container
        .append("svg")
        .attr("viewBox", `0 0 ${chartWidth} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet")
        .attr("role", "img")
        .attr("aria-hidden", "true");

    return { container, tooltip, svg, width: chartWidth, height };
};

const showChartTooltip = (tooltip, event, containerNode, html) => {
    const [x, y] = d3.pointer(event, containerNode);
    tooltip
        .html(html)
        .style("display", "block")
        .style("left", `${Math.min(x + 16, chartWidth - 240)}px`)
        .style("top", `${Math.max(12, y - 12)}px`);
};

const hideChartTooltip = (tooltip) => {
    tooltip.style("display", "none");
};

const drawBarChart = (chartId, labels, values, colorA, colorB, options = {}) => {
    const chart = createChartShell(chartId, 340);
    if (!chart) {
        return;
    }

    const { svg, tooltip, container, width, height } = chart;
    const margin = { top: 26, right: 18, bottom: 84, left: 54 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const max = Math.max(1, ...values);
    const x = d3.scaleBand().domain(labels).range([0, innerWidth]).padding(0.2);
    const y = d3.scaleLinear().domain([0, max]).nice().range([innerHeight, 0]);
    const axisStep = labels.length > 10 ? Math.ceil(labels.length / 8) : 1;
    const tickValues = labels.filter((_, index) => index % axisStep === 0);
    const valueSuffix = chartValueSuffix(chartId, options);

    const root = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const defs = svg.append("defs");
    const gradientId = `${chartId}-gradient`;
    const gradient = defs.append("linearGradient").attr("id", gradientId).attr("x1", "0%").attr("y1", "0%").attr("x2", "0%").attr("y2", "100%");
    gradient.append("stop").attr("offset", "0%").attr("stop-color", colorA);
    gradient.append("stop").attr("offset", "100%").attr("stop-color", colorB);

    const grid = root.append("g").attr("class", "chart-grid");
    grid
        .selectAll("line")
        .data(y.ticks(4))
        .enter()
        .append("line")
        .attr("x1", 0)
        .attr("x2", innerWidth)
        .attr("y1", (d) => y(d))
        .attr("y2", (d) => y(d))
        .attr("stroke", "rgba(116,230,255,0.18)")
        .attr("stroke-width", 1);

    root
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(x).tickValues(tickValues).tickFormat((d) => truncateChartLabel(d, 12)))
        .call((axis) => axis.selectAll("text").attr("fill", "#8cc6d7").attr("font-size", 11).attr("transform", "rotate(-25)").style("text-anchor", "end"))
        .call((axis) => axis.selectAll("path,line").attr("stroke", "rgba(116,230,255,0.22)"));

    root
        .append("g")
        .call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${d}${valueSuffix}`))
        .call((axis) => axis.selectAll("text").attr("fill", "#8cc6d7").attr("font-size", 11))
        .call((axis) => axis.selectAll("path,line").attr("stroke", "rgba(116,230,255,0.22)"));

    const bars = root.append("g");
    bars
        .selectAll("rect")
        .data(labels.map((label, index) => ({ label, value: values[index] || 0 })))
        .enter()
        .append("rect")
        .attr("x", (d) => x(d.label) || 0)
        .attr("y", y(0))
        .attr("width", x.bandwidth())
        .attr("height", 0)
        .attr("rx", 8)
        .attr("fill", `url(#${gradientId})`)
        .attr("opacity", 0.92)
        .on("mouseenter", function (event, d) {
            d3.select(this).attr("opacity", 1).attr("filter", "drop-shadow(0px 0px 10px rgba(255,226,122,0.28))");
            showChartTooltip(
                tooltip,
                event,
                container.node(),
                `<strong>${truncateChartLabel(d.label, 40)}</strong><span>${formatChartValue(d.value)}${valueSuffix}</span>`,
            );
        })
        .on("mousemove", function (event, d) {
            showChartTooltip(
                tooltip,
                event,
                container.node(),
                `<strong>${truncateChartLabel(d.label, 40)}</strong><span>${formatChartValue(d.value)}${valueSuffix}</span>`,
            );
        })
        .on("mouseleave", function () {
            d3.select(this).attr("opacity", 0.92).attr("filter", null);
            hideChartTooltip(tooltip);
        })
        .transition()
        .duration(450)
        .attr("y", (d) => y(d.value))
        .attr("height", (d) => innerHeight - y(d.value));

    root
        .append("text")
        .attr("x", 0)
        .attr("y", -8)
        .attr("fill", "#9cc5d4")
        .attr("font-size", 12)
        .attr("font-weight", 700)
        .text(options.title || "Hover bars for details");
};

const drawLineChart = (chartId, pointsA, pointsB, colorA, colorB, options = {}) => {
    const chart = createChartShell(chartId, 340);
    if (!chart) {
        return;
    }

    const { svg, tooltip, container, width, height } = chart;
    const seriesLabels = chartSeriesLabels(chartId, options);
    const xLabels = Array.isArray(options.xLabels) ? options.xLabels : [];
    const margin = { top: 28, right: 22, bottom: 46, left: 54 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const max = Math.max(1, ...pointsA, ...pointsB);
    const x = d3.scaleLinear().domain([0, Math.max(0, Math.max(pointsA.length, pointsB.length) - 1)]).range([0, innerWidth]);
    const y = d3.scaleLinear().domain([0, max]).nice().range([innerHeight, 0]);
    const root = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    const hasSecondSeries = pointsB.length > 0;

    const grid = root.append("g").attr("class", "chart-grid");
    grid
        .selectAll("line")
        .data(y.ticks(4))
        .enter()
        .append("line")
        .attr("x1", 0)
        .attr("x2", innerWidth)
        .attr("y1", (d) => y(d))
        .attr("y2", (d) => y(d))
        .attr("stroke", "rgba(116,230,255,0.18)")
        .attr("stroke-width", 1);

    root
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(x).ticks(Math.min(8, Math.max(2, pointsA.length || pointsB.length))).tickFormat((value) => {
            const index = Math.round(Number(value || 0));
            const raw = xLabels[index] || String(index);
            return truncateChartLabel(raw, 10);
        }))
        .call((axis) => axis.selectAll("text").attr("fill", "#8cc6d7").attr("font-size", 11))
        .call((axis) => axis.selectAll("path,line").attr("stroke", "rgba(116,230,255,0.22)"));

    root
        .append("g")
        .call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${d}${chartValueSuffix(chartId, options)}`))
        .call((axis) => axis.selectAll("text").attr("fill", "#8cc6d7").attr("font-size", 11))
        .call((axis) => axis.selectAll("path,line").attr("stroke", "rgba(116,230,255,0.22)"));

    const line = d3.line().x((_, index) => x(index)).y((value) => y(value)).curve(d3.curveMonotoneX);
    const area = d3.area().x((_, index) => x(index)).y0(innerHeight).y1((value) => y(value)).curve(d3.curveMonotoneX);
    const pointsAData = pointsA.map((value, index) => ({ index, value }));
    const pointsBData = pointsB.map((value, index) => ({ index, value }));

    root
        .append("path")
        .datum(pointsA)
        .attr("fill", `${colorA}18`)
        .attr("d", area)
        .attr("opacity", 0.9);

    const pathA = root
        .append("path")
        .datum(pointsA)
        .attr("fill", "none")
        .attr("stroke", colorA)
        .attr("stroke-width", 3)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("d", line);

    if (hasSecondSeries) {
        root
            .append("path")
            .datum(pointsB)
            .attr("fill", "none")
            .attr("stroke", colorB)
            .attr("stroke-width", 3)
            .attr("stroke-linecap", "round")
            .attr("stroke-linejoin", "round")
            .attr("d", line);
    }

    root.append("g").selectAll("circle").data(pointsAData).enter().append("circle").attr("cx", (d) => x(d.index)).attr("cy", (d) => y(d.value)).attr("r", 3.5).attr("fill", colorA);

    if (hasSecondSeries) {
        root.append("g").selectAll("circle").data(pointsBData).enter().append("circle").attr("cx", (d) => x(d.index)).attr("cy", (d) => y(d.value)).attr("r", 3.5).attr("fill", colorB);
    }

    const hoverLine = root.append("line").attr("y1", 0).attr("y2", innerHeight).attr("stroke", "rgba(255,226,122,0.42)").attr("stroke-dasharray", "4 4").style("display", "none");
    const focusA = root.append("circle").attr("r", 5).attr("fill", colorA).attr("stroke", "#02111a").attr("stroke-width", 2).style("display", "none");
    const focusB = root.append("circle").attr("r", 5).attr("fill", colorB).attr("stroke", "#02111a").attr("stroke-width", 2).style("display", "none");
    const overlay = root.append("rect").attr("width", innerWidth).attr("height", innerHeight).attr("fill", "transparent");

    const resolveTooltipContent = (index) => {
        const firstValue = pointsA[index];
        const secondValue = pointsB[index];
        const title = options.title || seriesLabels.join(" / ");
        const bucket = xLabels[index] || `point ${index + 1}`;
        if (!hasSecondSeries) {
            return `<strong>${title}</strong><span>${bucket}</span><span>${seriesLabels[0]}: ${formatChartValue(firstValue)}${chartValueSuffix(chartId, options)}</span>`;
        }
        return `<strong>${title}</strong><span>${bucket}</span><span>${seriesLabels[0]}: ${formatChartValue(firstValue)}${chartValueSuffix(chartId, options)}</span><span>${seriesLabels[1]}: ${formatChartValue(secondValue)}${chartValueSuffix(chartId, options)}</span>`;
    };

    const onMove = (event) => {
        const [pointerX] = d3.pointer(event, overlay.node());
        const index = Math.max(0, Math.min(pointsA.length ? pointsA.length - 1 : pointsB.length - 1, Math.round(x.invert(pointerX))));
        const valueA = pointsA[index];
        const valueB = pointsB[index];
        hoverLine.style("display", null).attr("x1", x(index)).attr("x2", x(index));
        if (Number.isFinite(valueA)) {
            focusA.style("display", null).attr("cx", x(index)).attr("cy", y(valueA));
        }
        if (hasSecondSeries && Number.isFinite(valueB)) {
            focusB.style("display", null).attr("cx", x(index)).attr("cy", y(valueB));
        }
        showChartTooltip(tooltip, event, container.node(), resolveTooltipContent(index));
    };

    overlay
        .on("mouseenter", (event) => {
            hoverLine.style("display", null);
            onMove(event);
        })
        .on("mousemove", onMove)
        .on("mouseleave", () => {
            hoverLine.style("display", "none");
            focusA.style("display", "none");
            focusB.style("display", "none");
            hideChartTooltip(tooltip);
        });

    svg
        .append("text")
        .attr("x", margin.left)
        .attr("y", 18)
        .attr("fill", "#9cc5d4")
        .attr("font-size", 12)
        .attr("font-weight", 700)
        .text(options.title || seriesLabels.join(" / "));

    if (hasSecondSeries) {
        const legend = container.append("div").attr("class", "chart-legend");
        legend.append("span").attr("class", "legend-item").html(`<span class="legend-swatch" style="background:${colorA}"></span>${seriesLabels[0]}`);
        legend.append("span").attr("class", "legend-item").html(`<span class="legend-swatch" style="background:${colorB}"></span>${seriesLabels[1]}`);
    }
};

const switchMainTab = (tabId) => {
    document.querySelectorAll(".tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.tab === tabId);
    });
    document.querySelectorAll(".panel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === tabId);
    });
    if (tabId === "health") {
        renderHealth();
    } else if (tabId === "ai") {
        renderAiConfig();
    } else if (tabId === "admins") {
        renderCurrentAdminProfile();
        renderAdminDirectory();
    } else if (tabId === "holidays") {
        loadHolidays().catch(() => { });
    } else if (tabId === "dataset-candidates") {
        loadDatasetCandidates().catch(() => { });
    }
};

const holidayFilters = () => {
    const region = String(document.getElementById("holiday-filter-region")?.value || "hk").trim().toLowerCase() || "hk";
    const yearRaw = String(document.getElementById("holiday-filter-year")?.value || "").trim();
    const limit = 200;
    const out = { region, limit };
    if (yearRaw && /^\d{4}$/.test(yearRaw)) {
        out.year = yearRaw;
    }
    return out;
};

const renderHolidayRows = () => {
    const target = document.getElementById("holiday-list");
    const meta = document.getElementById("holiday-meta");
    if (!target || !meta) {
        return;
    }

    const rows = state.holidays_rows || [];
    const total = Number(state.holidays_total || 0);
    const region = String(state.holidays_region || "hk");
    const year = state.holidays_year;
    meta.textContent = `${rows.length}/${total} records | region=${region}${year ? ` | year=${year}` : ""}`;
    target.innerHTML = "";

    if (!rows.length) {
        target.appendChild(createListItem("No holidays found", "Try removing year filter or syncing latest source data."));
        return;
    }

    rows.forEach((row) => {
        const dateValue = String(row.holiday_date || "").trim() || "unknown-date";
        const nameValue = String(row.holiday_name || "Unnamed holiday");
        const sourceName = String(row.source_name || "source");
        const sourceUrl = String(row.source_url || "");
        const subtitle = sourceUrl
            ? `${sourceName} | <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">open source ↗</a>`
            : sourceName;
        target.appendChild(createListItem(`${escapeHtml(dateValue)} | ${escapeHtml(nameValue)}`, subtitle));
    });
};

const loadHolidays = async () => {
    const query = buildQuery(holidayFilters());
    const payload = await requestJson(`/admin/api/holidays?${query}`);
    state.holidays_rows = payload.rows || [];
    state.holidays_total = Number(payload.total || 0);
    state.holidays_region = payload.region || "hk";
    state.holidays_year = payload.year || null;
    renderHolidayRows();
};

const fmtDuration = (seconds) => {
    const s = Math.max(0, Number(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) {
        return `${h}h ${m}m ${sec}s`;
    }
    if (m > 0) {
        return `${m}m ${sec}s`;
    }
    return `${sec}s`;
};

const fmtRelativeAge = (seconds) => {
    if (seconds === null || seconds === undefined) {
        return "unknown";
    }
    return `${fmtDuration(seconds)} ago`;
};

const readStoredRecentTasksHideCompleted = () => {
    try {
        return window.localStorage.getItem(recentTasksHideCompletedStorageKey) === "1";
    } catch (_) {
        return false;
    }
};

const writeStoredRecentTasksHideCompleted = (value) => {
    try {
        window.localStorage.setItem(recentTasksHideCompletedStorageKey, value ? "1" : "0");
    } catch (_) {
        // Ignore storage failures.
    }
};

const taskKindLabel = (kind) => {
    const raw = String(kind || "task").trim().toLowerCase();
    if (raw === "events_ingest") {
        return "Events Ingest";
    }
    if (raw === "dataset_ingest") {
        return "Dataset Collect";
    }
    return raw || "task";
};

const taskStatusLabel = (status) => {
    const raw = String(status || "unknown").trim().toLowerCase();
    if (raw === "queued") {
        return "Queued";
    }
    if (raw === "running") {
        return "Running";
    }
    if (raw === "succeeded") {
        return "Succeeded";
    }
    if (raw === "failed") {
        return "Failed";
    }
    return raw || "Unknown";
};

const taskStatusClass = (status) => {
    const raw = String(status || "").trim().toLowerCase();
    if (raw === "succeeded") {
        return "is-ok";
    }
    if (raw === "failed") {
        return "is-critical";
    }
    if (raw === "running" || raw === "queued") {
        return "is-info";
    }
    return "is-warn";
};

const renderRecentTasks = () => {
    const target = document.getElementById("recent-tasks-list");
    const meta = document.getElementById("recent-tasks-meta");
    const filterButton = document.getElementById("recent-tasks-clear-completed");
    if (!target || !meta) {
        return;
    }

    const rows = state.recent_tasks || [];
    const successCount = rows.filter((row) => String(row.status || "").toLowerCase() === "succeeded").length;
    const failedCount = rows.filter((row) => String(row.status || "").toLowerCase() === "failed").length;
    const runningCount = rows.filter((row) => {
        const s = String(row.status || "").toLowerCase();
        return s === "running" || s === "queued";
    }).length;

    const visibleRows = recentTasksHideCompleted
        ? rows.filter((row) => String(row.status || "").toLowerCase() !== "succeeded")
        : rows;

    if (filterButton) {
        filterButton.textContent = recentTasksHideCompleted ? "Show Completed" : "Clear Completed";
        filterButton.classList.toggle("active", recentTasksHideCompleted);
        filterButton.disabled = recentTasksHideCompleted ? rows.length === visibleRows.length : successCount === 0;
    }

    meta.textContent = `${visibleRows.length}/${rows.length} shown | running=${runningCount} | succeeded=${successCount} | failed=${failedCount}`;
    target.innerHTML = "";

    if (!rows.length) {
        target.appendChild(createListItem("No recent tasks", "Background jobs will appear here after you run ingestion actions."));
        return;
    }

    if (!visibleRows.length) {
        target.appendChild(createListItem("No running or failed tasks", "All recent tasks are completed. Use Show Completed to view them."));
        return;
    }

    visibleRows.slice(0, 10).forEach((task) => {
        const status = String(task.status || "unknown");
        const statusClass = taskStatusClass(status);
        const createdAt = formatRunTime(task.created_at);
        const finishedAt = formatRunTime(task.finished_at || task.started_at);
        const title = `${taskKindLabel(task.kind)} | ${createdAt}`;
        const subtitleParts = [
            `status=${taskStatusLabel(status)}`,
            `id=${String(task.id || "").slice(0, 10)}`,
        ];
        if (task.finished_at || task.started_at) {
            subtitleParts.push(`updated=${finishedAt}`);
        }
        if (status.toLowerCase() === "failed" && task.error) {
            subtitleParts.push(`error=${task.error}`);
        }

        const item = createListItem(escapeHtml(title), escapeHtml(subtitleParts.join(" | ")));
        item.classList.add("ops-alert", statusClass, "recent-task-item");
        target.appendChild(item);
    });
};

const loadRecentTasks = async (limit = 12) => {
    const payload = await requestJson(`/admin/api/tasks?${buildQuery({ limit })}`);
    state.recent_tasks = payload.rows || [];
    renderRecentTasks();
};

const alertToneIcon = (level) => {
    switch (String(level || "").toLowerCase()) {
        case "critical":
            return "⛔";
        case "warn":
            return "⚠️";
        case "info":
            return "ℹ️";
        default:
            return "✅";
    }
};

const renderOperationalSummary = () => {
    const metricTarget = document.getElementById("ops-summary-metrics");
    const alertTarget = document.getElementById("ops-alerts");
    const queueTarget = document.getElementById("ops-queue-list");
    const summary = state.telemetry_summary || {};
    const alerts = state.telemetry_alerts || [];

    if (metricTarget) {
        metricTarget.innerHTML = "";
        const metrics = [
            { label: "Last Post", value: fmtRelativeAge(summary.posts?.seconds_since_last) },
            { label: "Event Success", value: fmtRelativeAge(summary.events?.seconds_since_success) },
            { label: "Reddit Activity", value: fmtRelativeAge(summary.reddit?.seconds_since_activity) },
            { label: "Heartbeat", value: fmtRelativeAge(summary.heartbeat?.seconds_since_last) },
        ];
        metrics.forEach((metric) => {
            const node = document.createElement("div");
            node.className = "metric";
            node.innerHTML = `<b>${escapeHtml(metric.value)}</b><span>${escapeHtml(metric.label)}</span>`;
            metricTarget.appendChild(node);
        });
    }

    if (alertTarget) {
        alertTarget.innerHTML = "";
        alerts.forEach((alert) => {
            const level = String(alert.level || "ok").toLowerCase();
            const item = createListItem(
                `${alertToneIcon(level)} ${escapeHtml(alert.title || "Alert")}`,
                escapeHtml(alert.detail || "")
            );
            item.classList.add("ops-alert", `is-${level}`);
            alertTarget.appendChild(item);
        });
    }

    if (queueTarget) {
        queueTarget.innerHTML = "";
        const rows = [
            {
                title: "Event review queue",
                detail: `${Number(summary.events?.pending_review || 0)} pending review`,
            },
            {
                title: "Reddit relay queue",
                detail: `${Number(summary.reddit?.queue_open || 0)} unrelayed | ${Number(summary.reddit?.blocked || 0)} blocked`,
            },
            {
                title: "Dataset candidates",
                detail: `${Number(summary.datasets?.candidate_queue || 0)} pending candidate rows`,
            },
        ];
        rows.forEach((row) => {
            queueTarget.appendChild(createListItem(escapeHtml(row.title), escapeHtml(row.detail)));
        });

        const scheduled = state.scheduled_upcoming || [];
        if (scheduled.length) {
            const items = scheduled.slice(0, 3).map((row) => {
                const runAt = String(row.run_at || "").replace("T", " ").slice(0, 16) || "later";
                return `${row.topic} @ ${runAt} UTC`;
            });
            queueTarget.appendChild(createListItem("Upcoming scheduled posts", items.join(" | ")));
        }

        const topCommands = state.top_commands || [];
        if (topCommands.length) {
            const details = topCommands.slice(0, 3).map((row) => {
                const latency = row.avg_latency_ms != null ? `${Math.round(Number(row.avg_latency_ms || 0))}ms` : "n/a";
                return `/${row.command_name} x${row.cnt} avg ${latency}`;
            });
            queueTarget.appendChild(createListItem("Top commands", details.join(" | ")));
        }
    }
};

const renderDecisionTelemetry = () => {
    const schedulerMetricTarget = document.getElementById("scheduler-outcome-metrics");
    const schedulerListTarget = document.getElementById("scheduler-breakdown-list");
    const commandMetricTarget = document.getElementById("command-error-metrics");
    const commandListTarget = document.getElementById("command-error-list");

    if (schedulerMetricTarget) {
        schedulerMetricTarget.innerHTML = "";
        const counts = Object.fromEntries((state.scheduler_outcomes || []).map((row) => [row.execution_status || "pending", Number(row.cnt || 0)]));
        [
            { label: "Sent", value: counts.sent || 0 },
            { label: "Pending", value: counts.pending || 0 },
            { label: "No Content", value: counts.no_content || 0 },
            { label: "Failed", value: counts.failed || 0 },
        ].forEach((metric) => {
            const node = document.createElement("div");
            node.className = "metric";
            node.innerHTML = `<b>${metric.value}</b><span>${escapeHtml(metric.label)}</span>`;
            schedulerMetricTarget.appendChild(node);
        });
    }

    if (schedulerListTarget) {
        schedulerListTarget.innerHTML = "";
        const rows = state.scheduler_breakdown || [];
        if (!rows.length) {
            schedulerListTarget.appendChild(createListItem("No scheduler decisions", "No selected scheduler rows found in the current window."));
        } else {
            rows.slice(0, 10).forEach((row) => {
                const factors = row.score_factors || {};
                const details = [
                    `score=${Number(row.score || 0).toFixed(2)}`,
                    `recent=${Number(factors.recent_count_72h || 0)}`,
                    `diversity=${Number(factors.diversity_bonus || 0).toFixed(2)}`,
                    `seasonal=${Number(factors.seasonal_bonus || 0).toFixed(2)}`,
                    `penalty=${Number(factors.saturation_penalty || 0).toFixed(2)}`,
                    `status=${row.execution_status || "pending"}`,
                ];
                const when = row.run_at ? String(row.run_at).replace("T", " ").slice(0, 16) : "unscheduled";
                const title = `${escapeHtml(row.topic || "topic")} | slot ${escapeHtml(row.slot_index ?? "?")} | ${escapeHtml(when)} UTC`;
                const subtitle = escapeHtml(details.join(" | "));
                const item = createListItem(title, subtitle);
                const inspect = document.createElement("button");
                inspect.type = "button";
                inspect.textContent = "Inspect Plan";
                inspect.onclick = async () => {
                    try {
                        const payload = await requestJson(`/admin/api/scheduler-plan/${encodeURIComponent(row.plan_key)}`);
                        state.schedulerPlanDetail = payload;
                        renderSchedulerPlanDetail();
                    } catch (err) {
                        alert(err.message);
                    }
                };
                const rowButtons = document.createElement("div");
                rowButtons.className = "button-row";
                rowButtons.appendChild(inspect);
                item.appendChild(rowButtons);
                if (row.execution_error) {
                    const err = document.createElement("small");
                    err.className = "candidate-source";
                    err.textContent = `error: ${row.execution_error}`;
                    item.appendChild(err);
                }
                schedulerListTarget.appendChild(item);
            });
        }
    }

    const schedulerSeries = state.scheduler_outcome_timeseries || [];
    drawLineChart(
        "chart-scheduler-outcomes",
        schedulerSeries.map((row) => Number(row.sent || 0)),
        schedulerSeries.map((row) => Number(row.failed || 0)),
        "#57a9ff",
        "#ff6464",
        {
            title: "Scheduler sent vs failed over time",
            seriesLabels: ["Sent", "Failed"],
            xLabels: schedulerSeries.map((row) => row.bucket || ""),
        }
    );

    const commandSeries = state.command_failure_timeseries || [];
    drawLineChart(
        "chart-command-errors",
        commandSeries.map((row) => Number(row.total || 0)),
        commandSeries.map((row) => Number(row.errors || 0)),
        "#f6b93b",
        "#ff6464",
        {
            title: "Command calls vs failures over time",
            seriesLabels: ["Calls", "Failures"],
            xLabels: commandSeries.map((row) => row.bucket || ""),
        }
    );

    if (schedulerSeries.length === 0) {
        drawBarChart("chart-scheduler-outcomes", [], [], "rgba(87,169,255,0.95)", "rgba(87,169,255,0.28)", {
            title: "Selected scheduler outcomes",
        });
    }

    if (commandSeries.length === 0) {
        drawBarChart("chart-command-errors", [], [], "rgba(246,185,59,0.95)", "rgba(246,185,59,0.30)", {
            title: "Command error rate",
            valueSuffix: "%",
        });
    }

    if (commandMetricTarget) {
        commandMetricTarget.innerHTML = "";
        const total = (state.command_error_rates || []).reduce((sum, row) => sum + Number(row.total_count || 0), 0);
        const totalErrors = (state.command_error_rates || []).reduce((sum, row) => sum + Number(row.error_count || 0), 0);
        const overallRate = total > 0 ? `${((totalErrors / total) * 100).toFixed(1)}%` : "0.0%";
        [
            { label: "Command Calls", value: total },
            { label: "Errors", value: totalErrors },
            { label: "Error Rate", value: overallRate },
        ].forEach((metric) => {
            const node = document.createElement("div");
            node.className = "metric";
            node.innerHTML = `<b>${escapeHtml(metric.value)}</b><span>${escapeHtml(metric.label)}</span>`;
            commandMetricTarget.appendChild(node);
        });
    }

    if (commandListTarget) {
        commandListTarget.innerHTML = "";
        const rows = state.command_error_rates || [];
        if (!rows.length) {
            commandListTarget.appendChild(createListItem("No command usage", "No command telemetry found in the current window."));
        } else {
            rows.forEach((row) => {
                const errorPct = `${(Number(row.error_rate || 0) * 100).toFixed(1)}%`;
                const latency = row.avg_latency_ms != null ? `${Math.round(Number(row.avg_latency_ms || 0))}ms` : "n/a";
                commandListTarget.appendChild(
                    createListItem(
                        `/${escapeHtml(row.command_name || "unknown")}`,
                        escapeHtml(`calls=${row.total_count} | errors=${row.error_count} | error_rate=${errorPct} | avg_latency=${latency}`)
                    )
                );
            });
        }
    }

};

const renderSchedulerPlanDetail = () => {
    const summaryTarget = document.getElementById("scheduler-plan-summary");
    const auditTarget = document.getElementById("scheduler-plan-post-audit");
    const detailTarget = document.getElementById("scheduler-plan-detail");
    if (!summaryTarget || !detailTarget || !auditTarget) {
        return;
    }
    const payload = state.schedulerPlanDetail;
    auditTarget.innerHTML = "";
    detailTarget.innerHTML = "";
    if (!payload || !payload.rows || !payload.rows.length) {
        summaryTarget.textContent = "Select a scheduler row to inspect its full plan.";
        return;
    }
    const summary = payload.summary || {};
    summaryTarget.textContent = `${payload.plan_key} | selected=${summary.selected || 0} | sent=${summary.sent || 0} | failed=${summary.failed || 0}`;
    payload.rows.forEach((row) => {
        const factors = row.score_factors || {};
        const detailParts = [
            `score=${Number(row.score || 0).toFixed(2)}`,
            `selected=${Number(row.selected || 0) === 1 ? "yes" : "no"}`,
            `status=${row.execution_status || "pending"}`,
            `latency=${row.execution_latency_ms != null ? `${Math.round(Number(row.execution_latency_ms || 0))}ms` : "n/a"}`,
            `recent=${Number(factors.recent_count_72h || 0)}`,
            `diversity=${Number(factors.diversity_bonus || 0).toFixed(2)}`,
        ];
        const title = `${row.topic} | slot ${row.slot_index}`;
        const item = createListItem(title, detailParts.join(" | "));
        const audit = row.post_audit;
        if (audit) {
            const auditMeta = document.createElement("small");
            auditMeta.className = "candidate-source";
            auditMeta.textContent = `post_audit id=${audit.id} | topic=${audit.topic} | thread=${audit.thread_id} | message=${audit.telegram_message_id} | posted_at=${audit.posted_at}`;
            item.appendChild(auditMeta);
        }
        detailTarget.appendChild(item);
    });
};

const renderStatus = () => {
    const target = document.getElementById("status-list");
    const metricTarget = document.getElementById("dashboard-metrics");
    const auditTarget = document.getElementById("scheduler-plan-post-audit");
    renderSchemaStatus();
    if (!target || !metricTarget) {
        return;
    }
    target.innerHTML = "";
    if (auditTarget) {
        auditTarget.innerHTML = "";
    }

    let ok = 0;
    let blocked = 0;
    let error = 0;

    state.source_status.forEach((row) => {
        const status = String(row.status || "");
        if (status === "ok") {
            ok += 1;
        } else if (status.startsWith("blocked:")) {
            blocked += 1;
            const primaryAuditRow = state.source_status.find((statusRow) => statusRow.post_audit) || null;
            if (primaryAuditRow && primaryAuditRow.post_audit && auditTarget) {
                const audit = primaryAuditRow.post_audit;
                auditTarget.appendChild(
                    createListItem(
                        `Linked post_audit row #${audit.id}`,
                        `topic=${audit.topic} | thread=${audit.thread_id} | message=${audit.telegram_message_id} | content_type=${audit.content_type} | content_id=${audit.content_id} | posted_at=${audit.posted_at}`
                    )
                );
            } else if (auditTarget) {
                auditTarget.appendChild(createListItem("Linked post_audit row", "No delivered post_audit row is linked to this plan yet."));
            }
        } else {
            error += 1;
        }

        const fetched = Number(row.fetched_count || 0);
        const saved = Number(row.saved_count || 0);
        const ratio = fetched > 0 ? `${Math.round((saved / fetched) * 100)}%` : "n/a";
        const statusClass = status === "ok" ? "is-ok" : status.startsWith("blocked:") ? "is-blocked" : "is-error";
        const sourceUrl = row.source_url ? `<a class="inline-link source-link-icon" href="${row.source_url}" target="_blank" rel="noopener noreferrer" aria-label="Open ${row.source_name || "source"}">↗</a>` : "";
        const createdAt = formatRunTime(row.created_at);
        const item = document.createElement("div");
        item.className = `list-item source-matrix-row ${statusClass}`;
        item.innerHTML = `
            <div class="source-matrix-top">
                <div>
                    <div class="source-matrix-title">
                        <strong>${escapeHtml(row.source_name || "unknown")}</strong>
                        ${sourceUrl}
                    </div>
                    <span class="item-kicker-subtle">Last run ${escapeHtml(createdAt)}</span>
                </div>
                <span class="status-pill ${statusClass}">${escapeHtml(row.status || "unknown")}</span>
            </div>
            <div class="source-matrix-body">
                <span>Fetched <strong>${fetched}</strong></span>
                <span>Saved <strong>${saved}</strong></span>
                <span>Ratio <strong>${ratio}</strong></span>
            </div>
        `;
        target.appendChild(item);
    });

    if (!state.source_status.length) {
        target.appendChild(createListItem("No source status", "Ingestion has not run yet."));
    }

    metricTarget.innerHTML = "";
    const metrics = [
        { label: "Total Sources", value: state.source_status.length },
        { label: "Healthy", value: ok },
        { label: "Blocked", value: blocked },
        { label: "Errors", value: error },
    ];
    metrics.forEach((metric) => {
        const node = document.createElement("div");
        node.className = "metric";
        node.innerHTML = `<b>${escapeHtml(metric.value)}</b><span>${escapeHtml(metric.label)}</span>`;
        metricTarget.appendChild(node);
    });

    const labels = state.source_status.map((row) => `${row.run_type}:${row.source_name} `);
    const ratioValues = state.source_status.map((row) => {
        const fetched = Number(row.fetched_count || 0);
        const saved = Number(row.saved_count || 0);
        if (fetched <= 0) {
            return 0;
        }
        return Math.round((saved / fetched) * 100);
    });
    drawBarChart("chart-source-ratio", labels, ratioValues, "rgba(39,214,211,0.95)", "rgba(39,214,211,0.25)", {
        title: "Hover bars for source save ratios",
        valueSuffix: "%",
    });

    const runs = [...state.recent_runs].reverse().slice(-24);
    const fetchedSeries = runs.map((row) => Number(row.fetched_count || 0));
    const savedSeries = runs.map((row) => Number(row.saved_count || 0));
    drawLineChart("chart-throughput", fetchedSeries, savedSeries, "#42e5e0", "#f6b93b", {
        title: "Recent ingestion throughput",
        seriesLabels: ["Fetched", "Saved"],
    });

    renderOperationalSummary();
    renderDecisionTelemetry();
};

const renderLlmAndReddit = () => {
    const llmMetrics = document.getElementById("llm-metrics");
    const llmSkipList = document.getElementById("llm-skip-list");
    const redditMetrics = document.getElementById("reddit-metrics");

    if (llmMetrics) {
        llmMetrics.innerHTML = "";
        const counts = Object.fromEntries((state.llm_status_counts || []).map((row) => [row.status || "unknown", Number(row.cnt || 0)]));
        const sent = counts.sent || 0;
        const skipped = counts.skipped || 0;
        const error = counts.error || 0;
        const total = sent + skipped + error;
        [
            { label: "Total", value: total },
            { label: "Sent", value: sent },
            { label: "Skipped", value: skipped },
            { label: "Errors", value: error },
        ].forEach((metric) => {
            const node = document.createElement("div");
            node.className = "metric";
            node.innerHTML = `<b>${escapeHtml(metric.value)}</b><span>${escapeHtml(metric.label)}</span>`;
            llmMetrics.appendChild(node);
        });

        const labels = (state.llm_status_counts || []).map((row) => row.status || "unknown");
        const values = (state.llm_status_counts || []).map((row) => Number(row.cnt || 0));
        drawBarChart("chart-llm-status", labels, values, "rgba(87,169,255,0.95)", "rgba(87,169,255,0.28)", {
            title: "LLM action status",
            valueSuffix: "",
        });
    }

    if (llmSkipList) {
        llmSkipList.innerHTML = "";
        const rows = state.llm_skip_reasons || [];
        if (!rows.length) {
            llmSkipList.appendChild(createListItem("No skip reasons", "No skipped LLM actions in the last 24 hours."));
        } else {
            rows.forEach((row) => {
                llmSkipList.appendChild(createListItem(String(row.reason || "unknown"), `count = ${Number(row.cnt || 0)} `));
            });
        }
    }

    if (redditMetrics) {
        redditMetrics.innerHTML = "";
        const stats = state.reddit_cache_stats || { total: 0, relayed: 0, by_type: [] };
        const total = Number(stats.total || 0);
        const relayed = Number(stats.relayed || 0);
        const queued = Math.max(0, total - relayed);
        [
            { label: "Cached", value: total },
            { label: "Relayed", value: relayed },
            { label: "Queued", value: queued },
            { label: "Window", value: `${state.telemetry_hours || 24} h` },
        ].forEach((metric) => {
            const node = document.createElement("div");
            node.className = "metric";
            node.innerHTML = `<b>${escapeHtml(metric.value)}</b><span>${escapeHtml(metric.label)}</span>`;
            redditMetrics.appendChild(node);
        });

        const labels = (stats.by_type || []).map((row) => row.content_type || "unknown");
        const values = (stats.by_type || []).map((row) => Number(row.cnt || 0));
        drawBarChart("chart-reddit-type", labels, values, "rgba(246,185,59,0.95)", "rgba(246,185,59,0.30)", {
            title: "Reddit cache by content type",
        });

        const subLabels = (state.reddit_subreddit_counts || []).map((row) => row.subreddit || "unknown");
        const subValues = (state.reddit_subreddit_counts || []).map((row) => Number(row.cnt || 0));
        drawBarChart("chart-reddit-subreddits", subLabels, subValues, "rgba(255,226,122,0.95)", "rgba(255,226,122,0.3)", {
            title: "Reddit cache by subreddit",
        });
    }
};

const renderHealth = () => {
    const target = document.getElementById("health-metrics");
    const snapshot = document.getElementById("health-snapshot");
    const footprint = document.getElementById("health-footprint");
    const behavior = document.getElementById("health-behavior");
    const alerts = document.getElementById("health-alerts");
    if (!target) {
        return;
    }
    const metrics = state.system_metrics || {};
    target.innerHTML = "";
    [
        { label: "CPU Est", value: `${Number(metrics.cpu_percent_est || 0).toFixed(1)}% ` },
        { label: "Host Mem", value: metrics.memory_percent != null ? `${Number(metrics.memory_percent).toFixed(1)}% ` : "n/a" },
        { label: "Process RSS", value: metrics.process_rss_mb != null ? `${Number(metrics.process_rss_mb).toFixed(1)} MB` : "n/a" },
        { label: "Uptime", value: fmtDuration(metrics.uptime_seconds || 0) },
    ].forEach((metric) => {
        const node = document.createElement("div");
        node.className = "metric";
        node.innerHTML = `<b>${escapeHtml(metric.value)}</b><span>${escapeHtml(metric.label)}</span>`;
        target.appendChild(node);
    });

    if (snapshot) {
        snapshot.textContent = `CPU est ${Number(metrics.cpu_percent_est || 0).toFixed(1)}%, host memory ${metrics.memory_percent != null ? `${Number(metrics.memory_percent).toFixed(1)}%` : "n/a"}, uptime ${fmtDuration(metrics.uptime_seconds || 0)}.`;
    }
    if (footprint) {
        const loadAvg = (metrics.load_avg || [0, 0, 0]).map((v) => Number(v || 0).toFixed(2)).join(" / ");
        footprint.textContent = `Load avg ${loadAvg} | RSS ${metrics.process_rss_mb != null ? `${Number(metrics.process_rss_mb).toFixed(1)} MB` : "n/a"} `;
    }
    if (behavior) {
        const cpuText = `${Number(metrics.cpu_percent_est || 0).toFixed(1)}% CPU`;
        const memText = metrics.memory_percent != null ? `${Number(metrics.memory_percent).toFixed(1)}% memory` : "memory n/a";
        behavior.textContent = `Current readout: ${cpuText}, ${memText}, ${fmtDuration(metrics.uptime_seconds || 0)} uptime.`;
    }
    if (alerts) {
        alerts.innerHTML = "";
        [
            { label: "CPU load", value: `${Number(metrics.cpu_percent_est || 0).toFixed(1)}% ` },
            { label: "Memory load", value: metrics.memory_percent != null ? `${Number(metrics.memory_percent).toFixed(1)}% ` : "n/a" },
            { label: "Process RSS", value: metrics.process_rss_mb != null ? `${Number(metrics.process_rss_mb).toFixed(1)} MB` : "n/a" },
            { label: "Host uptime", value: fmtDuration(metrics.uptime_seconds || 0) },
        ].forEach((row) => {
            alerts.appendChild(createListItem(`🛡️ ${row.label} `, row.value));
        });
    }

    const cpuSeries = healthHistory.cpu.slice(-36);
    const memSeries = healthHistory.mem.slice(-36);
    const loadSeries = healthHistory.load.slice(-36);
    drawLineChart("chart-health-cpu", cpuSeries, [], "#ffe27a", "#57a9ff", {
        title: "CPU utilization trend",
        seriesLabels: ["CPU"],
        valueSuffix: "%",
    });
    drawLineChart("chart-health-usage", cpuSeries, memSeries, "#ffe27a", "#57a9ff", {
        title: "CPU and memory comparison",
        seriesLabels: ["CPU", "Memory"],
        valueSuffix: "%",
    });
    drawLineChart("chart-health-memory", memSeries, [], "#57a9ff", "#8cc6d7", {
        title: "Memory utilization trend",
        seriesLabels: ["Memory"],
        valueSuffix: "%",
    });
    drawLineChart("chart-health-load", loadSeries, [], "#f6b93b", "#57a9ff", {
        title: "System load average",
        seriesLabels: ["Load"],
    });
};

const redditFilters = () => ({
    content_type: document.getElementById("reddit-filter-type")?.value || "",
    relayed: document.getElementById("reddit-filter-relayed")?.value || "",
    blocked: document.getElementById("reddit-filter-blocked")?.value || "",
    subreddit: document.getElementById("reddit-filter-subreddit")?.value?.trim() || "",
    q: document.getElementById("reddit-filter-query")?.value?.trim() || "",
    sort_by: document.getElementById("reddit-sort-by")?.value || "fetched_at",
    sort_dir: document.getElementById("reddit-sort-dir")?.value || "desc",
    limit: state.reddit_cache_limit || 20,
    offset: (Math.max(1, redditPage) - 1) * (state.reddit_cache_limit || 20),
});

const buildQuery = (obj) => {
    const search = new URLSearchParams();
    Object.entries(obj).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") {
            return;
        }
        search.set(key, String(value));
    });
    return search.toString();
};

const renderRedditCacheRows = () => {
    const target = document.getElementById("reddit-cache-list");
    const meta = document.getElementById("reddit-cache-meta");
    if (!target || !meta) {
        return;
    }

    target.innerHTML = "";
    const rows = state.reddit_cache_rows || [];
    const limit = Number(state.reddit_cache_limit || 20);
    const total = Number(state.reddit_cache_total || 0);
    const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
    meta.textContent = `${rows.length} rows on page ${redditPage}/${totalPages} | total=${total}`;

    const pageInfo = document.getElementById("reddit-page-info");
    const prevButton = document.getElementById("reddit-page-prev");
    const nextButton = document.getElementById("reddit-page-next");
    if (pageInfo) {
        pageInfo.textContent = `page ${redditPage}/${totalPages}`;
    }
    if (prevButton) {
        prevButton.disabled = redditPage <= 1;
    }
    if (nextButton) {
        nextButton.disabled = redditPage >= totalPages;
    }

    if (!rows.length) {
        target.appendChild(createListItem("No Reddit cache rows", "Try a broader filter."));
        return;
    }

    rows.forEach((row) => {
        const blocked = Number(row.blocked || 0) === 1;
        const relayed = Number(row.relayed || 0) === 1;
        const title = (row.title || row.body || "").replace(/\s+/g, " ").trim();
        const subtitle = `[${row.content_type}] r/${row.subreddit} score=${row.score} relayed=${relayed ? "yes" : "no"} blocked=${blocked ? "yes" : "no"}`;

        const force = document.createElement("button");
        force.textContent = "Force Relay";
        force.onclick = async () => {
            try {
                await requestJson(`/admin/api/reddit-cache/${row.id}/relay`, {
                    method: "POST",
                    body: JSON.stringify({ force: true }),
                });
                await loadRedditCache();
                await refreshTelemetry();
            } catch (err) {
                alert(err.message);
            }
        };

        const safeRelay = document.createElement("button");
        safeRelay.textContent = "Relay (Safe)";
        safeRelay.onclick = async () => {
            try {
                await requestJson(`/admin/api/reddit-cache/${row.id}/relay`, {
                    method: "POST",
                    body: JSON.stringify({ force: false }),
                });
                await loadRedditCache();
                await refreshTelemetry();
            } catch (err) {
                alert(err.message);
            }
        };

        const unblock = document.createElement("button");
        unblock.textContent = "Unblock";
        unblock.onclick = async () => {
            try {
                await requestJson(`/admin/api/reddit-cache/${row.id}/unblock`, {
                    method: "POST",
                    body: JSON.stringify({}),
                });
                await loadRedditCache();
            } catch (err) {
                alert(err.message);
            }
        };

        const rowNode = createListItem(`#${row.id} ${title.slice(0, 180)}`, subtitle, [safeRelay, force, unblock]);
        rowNode.classList.add("reddit");
        if (blocked) {
            rowNode.classList.add("blocked");
        }

        const detail = document.createElement("div");
        detail.className = "meta";
        detail.innerHTML = `${row.author || "unknown"} | <a href="${row.permalink || "#"}" target="_blank" rel="noopener noreferrer">open permalink ↗</a> ${row.blocked_reason ? `| reason=${row.blocked_reason}` : ""}`;
        rowNode.appendChild(detail);

        target.appendChild(rowNode);
    });
};

const loadRedditCache = async () => {
    const query = buildQuery(redditFilters());
    const payload = await requestJson(`/admin/api/reddit-cache?${query}`);
    state.reddit_cache_rows = payload.rows || [];
    state.reddit_cache_total = Number(payload.total || 0);
    state.reddit_cache_limit = Number(payload.limit || state.reddit_cache_limit || 20);
    state.reddit_cache_offset = Number(payload.offset || 0);
    renderRedditCacheRows();
};

const candidateFilters = () => {
    const limitRaw = Number(document.getElementById("candidate-filter-limit")?.value || 40);
    return {
        dataset: document.getElementById("candidate-filter-dataset")?.value || "",
        status: document.getElementById("candidate-filter-status")?.value || "candidate",
        limit: Math.max(1, Math.min(300, Number.isFinite(limitRaw) ? limitRaw : 40)),
        offset: 0,
    };
};

const isCandidateRow = (row) => String(row?.status || "").trim().toLowerCase() === "candidate";

const parseCandidateOptions = (row) => {
    const raw = row?.options_json;
    if (Array.isArray(raw)) {
        return raw.map((v) => String(v || "").trim()).filter(Boolean);
    }
    if (typeof raw === "string" && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.map((v) => String(v || "").trim()).filter(Boolean);
            }
        } catch (_) {
            return [];
        }
    }
    return [];
};

const normalizeCandidateRowsForDisplay = (rows) => {
    return [...(rows || [])].sort((a, b) => {
        const dsA = String(a?.dataset_name || "");
        const dsB = String(b?.dataset_name || "");
        if (dsA !== dsB) {
            return dsA.localeCompare(dsB);
        }
        const cA = Number(a?.confidence || 0);
        const cB = Number(b?.confidence || 0);
        if (cA !== cB) {
            return cB - cA;
        }
        return Number(b?.id || 0) - Number(a?.id || 0);
    });
};

const applyCandidateFiltersSoon = (delayMs = 160) => {
    if (candidateFilterTimer) {
        clearTimeout(candidateFilterTimer);
    }
    candidateFilterTimer = setTimeout(() => {
        loadDatasetCandidates().catch((err) => {
            alert(err.message);
        });
    }, Math.max(0, Number(delayMs) || 0));
};

const isCandidateCardExpanded = (rowId) => {
    if (candidateViewMode === "expanded") {
        return true;
    }
    return expandedCandidateIds.has(Number(rowId));
};

const readStoredCandidateViewMode = () => {
    try {
        const stored = window.localStorage.getItem(candidateViewStorageKey);
        if (stored === "compact" || stored === "expanded") {
            return stored;
        }
    } catch (_) {
        return "compact";
    }
    return "compact";
};

const writeStoredCandidateViewMode = (mode) => {
    try {
        window.localStorage.setItem(candidateViewStorageKey, mode);
    } catch (_) {
        // Ignore storage failures (private mode/quota restrictions)
    }
};

const setCandidateViewMode = (mode) => {
    candidateViewMode = mode === "expanded" ? "expanded" : "compact";
    writeStoredCandidateViewMode(candidateViewMode);
    if (candidateViewMode === "expanded") {
        expandedCandidateIds = new Set();
    }
    const compactBtn = document.getElementById("candidate-view-compact");
    const expandedBtn = document.getElementById("candidate-view-expanded");
    if (compactBtn) {
        compactBtn.classList.toggle("active", candidateViewMode === "compact");
    }
    if (expandedBtn) {
        expandedBtn.classList.toggle("active", candidateViewMode === "expanded");
    }
    renderDatasetCandidates();
};

const renderDatasetCandidates = () => {
    const target = document.getElementById("dataset-candidates-list");
    const meta = document.getElementById("dataset-candidates-meta");
    if (!target || !meta) {
        return;
    }

    target.innerHTML = "";
    const rows = normalizeCandidateRowsForDisplay(state.dataset_candidates_rows || []);
    const total = Number(state.dataset_candidates_total || 0);
    const limit = Number(state.dataset_candidates_limit || 40);
    meta.textContent = `${rows.length} rows loaded | total=${total} | limit=${limit} | selected=${selectedCandidateIds.size}`;

    if (!rows.length) {
        target.appendChild(createListItem("No dataset candidates", "Run collectors or broaden the filter."));
        return;
    }

    let currentGroup = "";
    rows.forEach((row) => {
        const datasetName = String(row.dataset_name || "unknown");
        if (datasetName !== currentGroup) {
            currentGroup = datasetName;
            const group = document.createElement("div");
            group.className = "candidate-group-label";
            group.textContent = datasetName;
            target.appendChild(group);
        }

        const rowId = Number(row.id);
        const selectable = isCandidateRow(row);
        const body = String(row.body_text || "").replace(/\s+/g, " ").trim();
        const status = String(row.status || "candidate");
        const confidence = Number(row.confidence || 0).toFixed(2);
        const options = parseCandidateOptions(row);
        const answerText = String(row.answer_text || "").trim();
        const sourceName = String(row.source_name || "n/a");
        const sourceUrl = String(row.source_url || "").trim();

        if (!selectable) {
            selectedCandidateIds.delete(rowId);
        }

        const approve = document.createElement("button");
        approve.textContent = "Approve";
        approve.disabled = String(row.status || "") === "approved";
        approve.onclick = async () => {
            try {
                const result = await requestJson(`/admin/api/dataset-candidates/${row.id}/approve`, {
                    method: "POST",
                    body: JSON.stringify({}),
                });
                selectedCandidateIds.delete(rowId);
                await loadDatasetCandidates();
                if ((result.dataset || "") === activeDataset) {
                    await loadDataset(activeDataset);
                }
            } catch (err) {
                alert(err.message);
            }
        };

        const reject = document.createElement("button");
        reject.textContent = "Reject";
        reject.disabled = String(row.status || "") === "rejected";
        reject.onclick = async () => {
            try {
                reject.disabled = true;
                reject.textContent = "Rejecting...";
                const result = await requestJson(`/admin/api/dataset-candidates/${row.id}/reject`, {
                    method: "POST",
                    body: JSON.stringify({}),
                });
                if (!result?.ok) {
                    throw new Error(result?.reason || "Reject failed");
                }

                // Optimistic UI update so the status change is visible immediately.
                state.dataset_candidates_rows = (state.dataset_candidates_rows || []).map((entry) => {
                    if (Number(entry?.id) !== rowId) {
                        return entry;
                    }
                    return { ...entry, status: "rejected" };
                });

                const activeStatus = String(document.getElementById("candidate-filter-status")?.value || "candidate").trim().toLowerCase();
                if (activeStatus === "candidate") {
                    state.dataset_candidates_rows = (state.dataset_candidates_rows || []).filter((entry) => Number(entry?.id) !== rowId);
                }
                selectedCandidateIds.delete(rowId);
                renderDatasetCandidates();
                await loadDatasetCandidates();
            } catch (err) {
                reject.disabled = String(row.status || "") === "rejected";
                reject.textContent = "Reject";
                alert(err.message);
            }
        };

        const openSource = document.createElement("button");
        openSource.textContent = "Open Source";
        openSource.onclick = () => {
            if (!sourceUrl) {
                return;
            }
            window.open(sourceUrl, "_blank", "noopener");
        };
        openSource.disabled = !sourceUrl;

        const checked = selectable && selectedCandidateIds.has(rowId) ? "checked" : "";
        const disabled = selectable ? "" : "disabled";
        const expanded = isCandidateCardExpanded(rowId);
        const node = document.createElement("div");
        node.className = `list-item candidate-card ${selectable ? "is-candidate" : "is-locked"} ${expanded ? "is-expanded" : "is-collapsed"}`;
        node.innerHTML = `
            <div class="candidate-top">
                <label class="candidate-title"><input type="checkbox" data-candidate-select="${rowId}" ${checked} ${disabled}> #${row.id}</label>
                <div class="candidate-chips">
                    <span class="small-chip">status=${escapeHtml(status)}</span>
                    <span class="small-chip">conf=${escapeHtml(confidence)}</span>
                    <span class="small-chip">source=${escapeHtml(sourceName)}</span>
                </div>
            </div>
            <div class="candidate-body"></div>
            <div class="button-row"></div>
        `;

        const bodyWrap = node.querySelector(".candidate-body");
        const isTrivia = datasetName === "trivia";
        const isPoll = datasetName === "polls";
        const isDiscussion = datasetName === "discussions";

        if (isTrivia || isPoll || isDiscussion) {
            const questionLabel = isTrivia ? "Question" : (isPoll ? "Poll Prompt" : "Discussion Prompt");
            const q = document.createElement("p");
            q.className = "candidate-question";
            q.textContent = `${questionLabel}: ${body}`;
            bodyWrap.appendChild(q);

            if (options.length) {
                const optTitle = document.createElement("small");
                optTitle.className = "candidate-detail-extra";
                optTitle.textContent = isTrivia ? "Answer Choices:" : "Possible Answers:";
                bodyWrap.appendChild(optTitle);
                const list = document.createElement("ol");
                list.className = "candidate-options candidate-detail-extra";
                options.forEach((opt) => {
                    const li = document.createElement("li");
                    li.textContent = opt;
                    list.appendChild(li);
                });
                bodyWrap.appendChild(list);
            } else if (isPoll) {
                const optMissing = document.createElement("small");
                optMissing.className = "candidate-detail-extra";
                optMissing.textContent = "Possible Answers: none parsed yet";
                bodyWrap.appendChild(optMissing);
            }
            if (isTrivia && answerText) {
                const ans = document.createElement("small");
                ans.className = "candidate-answer candidate-detail-extra";
                ans.textContent = `Correct Answer: ${answerText}`;
                bodyWrap.appendChild(ans);
            } else if (isTrivia) {
                const ans = document.createElement("small");
                ans.className = "candidate-answer candidate-detail-extra";
                ans.textContent = "Correct Answer: not parsed yet";
                bodyWrap.appendChild(ans);
            }
        } else if (datasetName === "quotes") {
            const quote = document.createElement("p");
            quote.className = "candidate-question";
            quote.textContent = `Quote: ${body}`;
            bodyWrap.appendChild(quote);
        } else {
            const fact = document.createElement("p");
            fact.className = "candidate-question";
            fact.textContent = `Fact: ${body}`;
            bodyWrap.appendChild(fact);
        }

        const sourceLine = document.createElement("small");
        sourceLine.className = "candidate-source candidate-detail-extra";
        sourceLine.innerHTML = sourceUrl
            ? `Source: ${escapeHtml(sourceName)} <a class="inline-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">↗</a>`
            : `Source: ${escapeHtml(sourceName)}`;
        bodyWrap.appendChild(sourceLine);

        const actionRow = node.querySelector(".button-row");
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "candidate-toggle";
        if (candidateViewMode === "expanded") {
            toggle.textContent = "Expanded";
            toggle.disabled = true;
        } else {
            toggle.textContent = expanded ? "Collapse" : "Expand";
            toggle.onclick = () => {
                if (expandedCandidateIds.has(rowId)) {
                    expandedCandidateIds.delete(rowId);
                } else {
                    expandedCandidateIds.add(rowId);
                }
                renderDatasetCandidates();
            };
        }
        actionRow.append(toggle);
        actionRow.append(approve, reject, openSource);

        const checkbox = node.querySelector(`[data-candidate-select='${rowId}']`);
        if (checkbox) {
            checkbox.addEventListener("change", (event) => {
                if (!selectable) {
                    event.target.checked = false;
                    return;
                }
                if (event.target.checked) {
                    selectedCandidateIds.add(rowId);
                } else {
                    selectedCandidateIds.delete(rowId);
                }
                meta.textContent = `${rows.length} rows loaded | total=${total} | limit=${limit} | selected=${selectedCandidateIds.size}`;
            });
        }
        target.appendChild(node);
    });
};

const selectedCandidateIdList = () => {
    return Array.from(selectedCandidateIds)
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);
};

const runBulkCandidateAction = async (action) => {
    const candidateVisibleIds = new Set(
        (state.dataset_candidates_rows || [])
            .filter((row) => isCandidateRow(row))
            .map((row) => Number(row.id))
            .filter((id) => Number.isInteger(id) && id > 0)
    );
    const ids = selectedCandidateIdList().filter((id) => candidateVisibleIds.has(id));
    if (!ids.length) {
        throw new Error("No candidate-status rows selected");
    }
    const endpoint = action === "approve"
        ? "/admin/api/dataset-candidates/bulk-approve"
        : "/admin/api/dataset-candidates/bulk-reject";
    const payload = await requestJson(endpoint, {
        method: "POST",
        body: JSON.stringify({ ids }),
    });
    selectedCandidateIds = new Set();
    await loadDatasetCandidates();
    if (action === "approve") {
        await loadDataset(activeDataset);
    }
    return payload;
};

const loadDatasetCandidates = async () => {
    const query = buildQuery(candidateFilters());
    const payload = await requestJson(`/admin/api/dataset-candidates?${query}`);
    state.dataset_candidates_rows = payload.rows || [];
    state.dataset_candidates_total = Number(payload.total || 0);
    state.dataset_candidates_limit = Number(payload.limit || 40);
    state.dataset_candidates_offset = Number(payload.offset || 0);
    const loadedCandidateIds = new Set(
        (state.dataset_candidates_rows || [])
            .filter((row) => isCandidateRow(row))
            .map((row) => Number(row.id))
            .filter((id) => Number.isInteger(id) && id > 0)
    );
    selectedCandidateIds = new Set(Array.from(selectedCandidateIds).filter((id) => loadedCandidateIds.has(Number(id))));
    renderDatasetCandidates();
};

const pollSystemMetrics = async () => {
    if (pollSystemMetrics.inFlight) {
        return;
    }
    pollSystemMetrics.inFlight = true;
    try {
        const payload = await requestJson("/admin/api/system-metrics");
        state.system_metrics = payload || {};
        healthHistory.cpu.push(Number(payload.cpu_percent_est || 0));
        healthHistory.mem.push(Number(payload.memory_percent || 0));
        healthHistory.load.push(Number((payload.load_avg || [0])[0] || 0));
        renderHealth();
        setConnectionStatus("ok", "Connected", `Live metrics updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    } catch (err) {
        setConnectionStatus("error", "Connection issue", err.message || "Unable to load live metrics");
        throw err;
    } finally {
        pollSystemMetrics.inFlight = false;
    }
};

pollSystemMetrics.inFlight = false;

const refreshTelemetry = async () => {
    const hours = document.getElementById("filter-hours")?.value || "24";
    const runType = document.getElementById("filter-run-type")?.value || "all";
    const query = buildQuery({ hours, run_type: runType });
    const payload = await requestJson(`/admin/api/telemetry?${query}`);
    state.recent_runs = payload.recent_runs || [];
    state.llm_status_counts = payload.llm_status_counts || [];
    state.llm_skip_reasons = payload.llm_skip_reasons || [];
    state.reddit_cache_stats = payload.reddit_cache_stats || { total: 0, relayed: 0, by_type: [] };
    state.reddit_subreddit_counts = payload.reddit_subreddit_counts || [];
    state.telemetry_summary = payload.summary || {};
    state.telemetry_alerts = payload.alerts || [];
    state.command_usage_counts = payload.command_usage_counts || [];
    state.top_commands = payload.top_commands || [];
    state.command_error_rates = payload.command_error_rates || [];
    state.scheduler_topics = payload.scheduler_topics || [];
    state.scheduler_outcomes = payload.scheduler_outcomes || [];
    state.scheduler_breakdown = payload.scheduler_breakdown || [];
    state.scheduler_trends = payload.scheduler_trends || [];
    state.scheduler_outcome_timeseries = payload.scheduler_outcome_timeseries || [];
    state.scheduled_upcoming = payload.scheduled_upcoming || [];
    state.command_failure_timeseries = payload.command_failure_timeseries || [];
    state.telemetry_hours = Number(payload.hours || Number(hours));
    renderStatus();
    renderLlmAndReddit();
};

const refreshSourceStatus = async () => {
    const refreshed = await requestJson("/admin/api/source-status");
    state.source_status = refreshed.rows || [];
    renderStatus();
};

const refreshLiveData = async () => {
    const runAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (refreshLiveData.inFlight) {
        return;
    }
    refreshLiveData.inFlight = true;
    try {
        await refreshSourceStatus();
        await refreshTelemetry();
        await loadRedditCache();
        await loadRecentTasks(12);
        await pollSystemMetrics();
        setConnectionStatus("ok", "Connected", `Live data updated ${runAt}`);
    } catch (err) {
        setConnectionStatus("error", "Connection issue", err.message || "Live refresh failed");
    } finally {
        refreshLiveData.inFlight = false;
    }
};

refreshLiveData.inFlight = false;

const renderEvents = () => {
    const target = document.getElementById("pending-events");
    const summary = document.getElementById("events-summary");
    target.innerHTML = "";
    if (summary) {
        summary.textContent = `${state.pending_events.length} events pending approval`;
    }
    state.pending_events.forEach((row) => {
        const approve = document.createElement("button");
        approve.textContent = "✅ Approve";
        approve.onclick = () => setEventStatus(row.id, "approved");

        const reject = document.createElement("button");
        reject.textContent = "⛔ Reject";
        reject.onclick = () => setEventStatus(row.id, "rejected");

        const card = document.createElement("div");
        card.className = "list-item event-card";

        const top = document.createElement("div");
        top.className = "event-top";
        const titleRow = document.createElement("div");
        titleRow.className = "event-title-row";
        const heading = document.createElement("p");
        heading.className = "event-title";
        heading.textContent = `#${row.id} ${row.title}`;
        titleRow.appendChild(heading);

        const href = row.url || "";
        if (href) {
            const titleLink = document.createElement("a");
            titleLink.className = "event-link";
            titleLink.href = href;
            titleLink.target = "_blank";
            titleLink.rel = "noopener noreferrer";
            titleLink.textContent = "🔗 Open";
            titleLink.setAttribute("aria-label", `Open source for ${row.title || "event"}`);
            titleRow.appendChild(titleLink);
        }
        top.appendChild(titleRow);

        const badges = document.createElement("div");
        badges.className = "event-badges";
        const badgeA = document.createElement("span");
        badgeA.className = "badge";
        badgeA.textContent = `🌍 ${row.region || "n/a"}`;
        const badgeB = document.createElement("span");
        badgeB.className = "badge";
        badgeB.textContent = `🏷️ ${row.category || "n/a"}`;
        const badgeC = document.createElement("span");
        badgeC.className = "badge";
        badgeC.textContent = `📈 ${(Number(row.confidence || 0)).toFixed(2)}`;
        badges.append(badgeA, badgeB, badgeC);
        top.appendChild(badges);

        const meta = document.createElement("div");
        meta.className = "event-meta";

        const info = document.createElement("small");
        info.className = "event-details";
        const sourceLink = href
            ? `<a class="inline-link" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="Open ${row.source_name || "source"}">↗</a>`
            : "";
        info.innerHTML = `📅 ${row.event_date || "TBD"}<br>🛰️ ${row.source_name || "unknown"} ${sourceLink}`;
        meta.appendChild(info);

        const rowButtons = document.createElement("div");
        rowButtons.className = "event-actions";
        rowButtons.append(approve, reject);

        card.append(top, meta, rowButtons);
        target.appendChild(card);
    });
    if (!state.pending_events.length) {
        target.appendChild(createListItem("No pending events", "Queue is empty."));
    }
};

const renderSettings = () => {
    const form = document.getElementById("settings-form");
    form.innerHTML = "";
    Object.entries(state.settings).forEach(([key, value]) => {
        const label = document.createElement("label");
        label.textContent = key;
        const input = document.createElement("input");
        input.name = key;
        input.value = String(value);
        label.appendChild(input);
        form.appendChild(label);
    });
};

const renderAudit = () => {
    const target = document.getElementById("audit-list");
    target.innerHTML = "";
    state.audit.forEach((row) => {
        const item = document.createElement("div");
        item.className = "audit-item";
        item.innerHTML = `
            <div class="audit-top">
                <span class="audit-action">${row.action}</span>
                <span class="audit-meta">${row.created_at}</span>
            </div>
            <div class="audit-meta">Actor: ${row.actor_user_id || "n/a"}</div>
            <div class="audit-details">${row.details || ""}</div>
        `;
        target.appendChild(item);
    });
};

const loadDataset = async (name) => {
    activeDataset = name;
    setActivePills("[data-dataset]", "dataset", name);
    const activeLabel = document.getElementById("dataset-active-name");
    if (activeLabel) {
        activeLabel.textContent = name;
    }
    const payload = await requestJson(`/admin/api/datasets/${name}`);
    document.getElementById("dataset-editor").value = JSON.stringify(payload.data, null, 2);
};

const saveDataset = async () => {
    const editor = document.getElementById("dataset-editor");
    const data = JSON.parse(editor.value || "[]");
    await requestJson(`/admin/api/datasets/${activeDataset}`, {
        method: "POST",
        body: JSON.stringify({ data }),
    });
    alert(`Saved ${activeDataset}`);
};

const setEventStatus = async (eventId, status) => {
    await requestJson(`/admin/api/events/${eventId}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
    });
    state.pending_events = state.pending_events.filter((item) => item.id !== eventId);
    renderEvents();
};

const saveSettings = async () => {
    const updates = {};
    document.querySelectorAll("#settings-form input").forEach((input) => {
        updates[input.name] = input.value;
    });
    const payload = await requestJson("/admin/api/settings", {
        method: "POST",
        body: JSON.stringify({ settings: updates }),
    });
    state.settings = payload.settings;
    renderSettings();
    alert("Settings applied");
};

const normalizeSourceOrder = () => {
    sourceBuilderRows = sourceBuilderRows.map((row, idx) => ({ ...row, position: idx }));
    renderSourceBuilder();
};

const sourceValidationError = (source) => {
    if (!["official", "rss", "api", "scrape"].includes(String(source.tier || ""))) {
        return "tier must be official/rss/api/scrape";
    }
    if (!["event", "news"].includes(String(source.kind || ""))) {
        return "kind must be event/news";
    }
    if (!String(source.name || "").trim()) {
        return "name is required";
    }
    try {
        const u = new URL(String(source.url || ""));
        if (!["http:", "https:"].includes(u.protocol)) {
            return "url must be http/https";
        }
    } catch (_) {
        return "url must be valid";
    }
    if (source.meta !== undefined && source.meta !== null && typeof source.meta !== "object") {
        return "meta must be object";
    }
    return "";
};

const sourceRowTemplate = (source, idx) => {
    const wrapper = document.createElement("div");
    wrapper.className = "source-row";

    const err = sourceValidationError(source);
    if (err) {
        wrapper.classList.add("bad");
    }

    wrapper.innerHTML = `
      <div class="button-row">
        <button data-act="up" data-idx="${idx}">Up</button>
        <button data-act="down" data-idx="${idx}">Down</button>
        <button data-act="toggle" data-idx="${idx}">${source.enabled ? "Disable" : "Enable"}</button>
        <button data-act="remove" data-idx="${idx}">Remove</button>
      </div>
      <div class="source-grid">
        <label>Tier
          <select data-field="tier" data-idx="${idx}">
            <option value="official" ${source.tier === "official" ? "selected" : ""}>official</option>
            <option value="rss" ${source.tier === "rss" ? "selected" : ""}>rss</option>
            <option value="api" ${source.tier === "api" ? "selected" : ""}>api</option>
            <option value="scrape" ${source.tier === "scrape" ? "selected" : ""}>scrape</option>
          </select>
        </label>
        <label>Kind
          <select data-field="kind" data-idx="${idx}">
            <option value="event" ${source.kind === "event" ? "selected" : ""}>event</option>
            <option value="news" ${source.kind === "news" ? "selected" : ""}>news</option>
          </select>
        </label>
        <label>Position
          <input type="number" data-field="position" data-idx="${idx}" value="${source.position}">
        </label>
        <label>Name
          <input data-field="name" data-idx="${idx}" value="${source.name || ""}">
        </label>
        <label>URL
          <input data-field="url" data-idx="${idx}" value="${source.url || ""}">
        </label>
        <label>Enabled
          <select data-field="enabled" data-idx="${idx}">
            <option value="true" ${source.enabled ? "selected" : ""}>true</option>
            <option value="false" ${!source.enabled ? "selected" : ""}>false</option>
          </select>
        </label>
      </div>
      <div class="source-meta">
        <label>Meta: parser
          <input data-meta="parser" data-idx="${idx}" value="${source.meta?.parser || ""}">
        </label>
        <label>Meta: locale
          <input data-meta="locale" data-idx="${idx}" value="${source.meta?.locale || ""}">
        </label>
      </div>
      ${err ? `<div class="source-error">${err}</div>` : ""}
    `;

    return wrapper;
};

const collectSourceBuilder = () => {
    const rows = [];
    document.querySelectorAll(".source-row").forEach((row, idx) => {
        const get = (field) => row.querySelector(`[data-field='${field}']`)?.value;
        const parser = row.querySelector("[data-meta='parser']")?.value || "";
        const locale = row.querySelector("[data-meta='locale']")?.value || "";
        const meta = {};
        if (parser.trim()) {
            meta.parser = parser.trim();
        }
        if (locale.trim()) {
            meta.locale = locale.trim();
        }
        rows.push({
            tier: String(get("tier") || "rss").trim().toLowerCase(),
            kind: String(get("kind") || "event").trim().toLowerCase(),
            name: String(get("name") || "").trim(),
            url: String(get("url") || "").trim(),
            meta,
            enabled: String(get("enabled") || "true") === "true",
            position: Number(get("position") || idx),
        });
    });
    return rows;
};

const renderRawSourceEditor = () => {
    const lines = sourceBuilderRows.map((source) => JSON.stringify(source));
    document.getElementById("source-editor").value = lines.join("\n");
};

const renderSourceBuilder = () => {
    const target = document.getElementById("source-builder");
    if (!target) {
        return;
    }
    target.innerHTML = "";
    sourceBuilderRows.forEach((source, idx) => {
        target.appendChild(sourceRowTemplate(source, idx));
    });

    target.querySelectorAll("button[data-act]").forEach((button) => {
        button.onclick = () => {
            const idx = Number(button.dataset.idx);
            const act = button.dataset.act;
            if (act === "remove") {
                sourceBuilderRows.splice(idx, 1);
            } else if (act === "toggle") {
                sourceBuilderRows[idx].enabled = !sourceBuilderRows[idx].enabled;
            } else if (act === "up" && idx > 0) {
                [sourceBuilderRows[idx - 1], sourceBuilderRows[idx]] = [sourceBuilderRows[idx], sourceBuilderRows[idx - 1]];
            } else if (act === "down" && idx < sourceBuilderRows.length - 1) {
                [sourceBuilderRows[idx + 1], sourceBuilderRows[idx]] = [sourceBuilderRows[idx], sourceBuilderRows[idx + 1]];
            }
            normalizeSourceOrder();
            renderRawSourceEditor();
        };
    });

    target.querySelectorAll("input[data-field], select[data-field], input[data-meta]").forEach((input) => {
        input.addEventListener("change", () => {
            sourceBuilderRows = collectSourceBuilder();
            renderSourceBuilder();
            renderRawSourceEditor();
        });
    });
};

const loadSources = (runType) => {
    activeSourceType = runType;
    setActivePills("[data-source-type]", "sourceType", runType);
    sourceBuilderRows = (state.sources[runType] || []).map((source, idx) => ({
        tier: source.tier || "rss",
        kind: source.kind || "event",
        name: source.name || `source-${idx + 1}`,
        url: source.url || "",
        meta: source.meta || {},
        enabled: source.enabled !== false,
        position: Number(source.position ?? idx),
    }));
    normalizeSourceOrder();
    renderSourceBuilder();
    renderRawSourceEditor();
};

const saveSources = async () => {
    sourceBuilderRows = collectSourceBuilder();
    normalizeSourceOrder();

    for (const source of sourceBuilderRows) {
        const err = sourceValidationError(source);
        if (err) {
            throw new Error(`Source validation failed: ${err}`);
        }
    }

    const payload = await requestJson(`/admin/api/sources/${activeSourceType}`, {
        method: "POST",
        body: JSON.stringify({ sources: sourceBuilderRows }),
    });
    state.sources[activeSourceType] = payload.sources;
    loadSources(activeSourceType);
    alert("Source overrides saved");
};

const addSourceRow = () => {
    sourceBuilderRows.push({
        tier: "rss",
        kind: "event",
        name: `new-source-${sourceBuilderRows.length + 1}`,
        url: "https://",
        meta: {},
        enabled: true,
        position: sourceBuilderRows.length,
    });
    renderSourceBuilder();
    renderRawSourceEditor();
};

const loadRawIntoBuilder = () => {
    const text = document.getElementById("source-editor").value;
    const rows = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    sourceBuilderRows = rows.map((row, idx) => ({
        tier: row.tier || "rss",
        kind: row.kind || "event",
        name: row.name || `source-${idx + 1}`,
        url: row.url || "",
        meta: row.meta || {},
        enabled: row.enabled !== false,
        position: Number(row.position ?? idx),
    }));
    normalizeSourceOrder();
    renderSourceBuilder();
};

const runIngest = async (runType, triggerButton = null) => {
    const status = document.getElementById("manual-control-status");
    const originalButtonText = triggerButton ? triggerButton.textContent : "";
    if (status) {
        status.textContent = `Queueing ${runType} ingestion...`;
    }

    if (triggerButton) {
        triggerButton.disabled = true;
        triggerButton.textContent = "Running...";
    }

    try {
        const payload = await requestJson("/admin/api/ingest-now", {
            method: "POST",
            body: JSON.stringify({ run_type: runType, async: true }),
        });

        const taskId = payload?.task?.id;
        if (!taskId) {
            throw new Error("Missing task id from ingest response");
        }

        const task = await pollTaskUntilDone(taskId, {
            intervalMs: 1200,
            onUpdate: (current) => {
                if (status) {
                    status.textContent = `Running ${runType} ingestion (${current.status})...`;
                }
            },
        });

        const summary = task.result || {};
        document.getElementById("ingest-result").textContent = JSON.stringify(summary, null, 2);

        const refreshed = await requestJson("/admin/api/source-status");
        state.source_status = refreshed.rows;
        renderStatus();
        if (status) {
            status.textContent = `Completed ${runType} ingestion and refreshed source status.`;
        }
    } finally {
        if (triggerButton) {
            triggerButton.disabled = false;
            triggerButton.textContent = originalButtonText;
        }
    }
};

const initTabs = () => {
    document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            switchMainTab(tab.dataset.tab || "dashboard");
        });
    });

    document.querySelectorAll("[data-tab-target]").forEach((button) => {
        button.addEventListener("click", () => {
            switchMainTab(button.dataset.tabTarget || "dashboard");
        });
    });
};

const initHealthTabs = () => {
    const switchHealthTab = (tabName) => {
        activeHealthTab = tabName;
        document.querySelectorAll(".health-tab").forEach((button) => {
            button.classList.toggle("active", button.dataset.healthTab === tabName);
        });
        document.querySelectorAll(".health-pane").forEach((pane) => {
            pane.classList.toggle("active", pane.dataset.healthPane === tabName);
        });
        if (tabName === "metrics") {
            renderHealth();
        }
    };

    document.querySelectorAll(".health-tab").forEach((button) => {
        button.addEventListener("click", () => switchHealthTab(button.dataset.healthTab || "overview"));
    });

    switchHealthTab(activeHealthTab);
};

const initActions = () => {
    recentTasksHideCompleted = readStoredRecentTasksHideCompleted();

    const recentTasksFilterButton = document.getElementById("recent-tasks-clear-completed");
    if (recentTasksFilterButton) {
        recentTasksFilterButton.onclick = () => {
            recentTasksHideCompleted = !recentTasksHideCompleted;
            writeStoredRecentTasksHideCompleted(recentTasksHideCompleted);
            renderRecentTasks();
        };
    }

    const adminProfileForm = document.getElementById("admin-profile-form");
    if (adminProfileForm) {
        adminProfileForm.onsubmit = async (event) => {
            event.preventDefault();
            const formData = new FormData(adminProfileForm);
            const payload = Object.fromEntries(formData.entries());
            payload.is_active = Boolean(adminProfileForm.elements.is_active.checked);
            payload.is_primary = Boolean(adminProfileForm.elements.is_primary.checked);
            try {
                await requestJson("/admin/api/admin-profiles", {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
                await loadAdminProfiles();
                alert("Profile updated");
            } catch (err) {
                alert(err.message);
            }
        };
    }

    const addAdminButton = document.getElementById("add-admin-profile");
    if (addAdminButton) {
        addAdminButton.onclick = () => {
            adminDrafts.unshift({ user_id: "", display_name: "", username: "", email: "", role: "admin", is_active: true, is_primary: false, notes: "" });
            renderAdminDirectory();
        };
    }

    const refreshAdminButton = document.getElementById("refresh-admin-profiles");
    if (refreshAdminButton) {
        refreshAdminButton.onclick = async () => {
            try {
                await loadAdminProfiles();
            } catch (err) {
                alert(err.message);
            }
        };
    }

    document.querySelectorAll("[data-dataset]").forEach((button) => {
        button.onclick = () => loadDataset(button.dataset.dataset);
    });
    document.getElementById("save-dataset").onclick = async () => {
        try {
            await saveDataset();
        } catch (err) {
            alert(err.message);
        }
    };

    document.getElementById("save-settings").onclick = async () => {
        try {
            await saveSettings();
        } catch (err) {
            alert(err.message);
        }
    };

    document.querySelectorAll("[data-source-type]").forEach((button) => {
        button.onclick = () => loadSources(button.dataset.sourceType);
    });

    document.getElementById("save-sources").onclick = async () => {
        try {
            await saveSources();
        } catch (err) {
            alert(err.message);
        }
    };

    document.getElementById("add-source-row").onclick = addSourceRow;
    document.getElementById("normalize-source-order").onclick = () => {
        sourceBuilderRows = collectSourceBuilder();
        normalizeSourceOrder();
        renderRawSourceEditor();
    };
    document.getElementById("load-raw-sources").onclick = () => {
        try {
            loadRawIntoBuilder();
        } catch (err) {
            alert(`Invalid raw source JSON: ${err.message}`);
        }
    };
    document.getElementById("export-builder-sources").onclick = () => {
        sourceBuilderRows = collectSourceBuilder();
        renderRawSourceEditor();
    };

    document.querySelectorAll("[data-ingest]").forEach((button) => {
        button.onclick = async () => {
            try {
                await runIngest(button.dataset.ingest, button);
                await refreshTelemetry();
            } catch (err) {
                alert(err.message);
            }
        };
    });

    const refreshTelemetryButton = document.getElementById("refresh-telemetry");
    if (refreshTelemetryButton) {
        refreshTelemetryButton.onclick = async () => {
            try {
                await refreshTelemetry();
            } catch (err) {
                alert(err.message);
            }
        };
    }

    const redditApplyButton = document.getElementById("reddit-filter-apply");
    if (redditApplyButton) {
        redditApplyButton.onclick = async () => {
            try {
                redditPage = 1;
                await loadRedditCache();
            } catch (err) {
                alert(err.message);
            }
        };
    }

    const prevButton = document.getElementById("reddit-page-prev");
    if (prevButton) {
        prevButton.onclick = async () => {
            redditPage = Math.max(1, redditPage - 1);
            try {
                await loadRedditCache();
            } catch (err) {
                alert(err.message);
            }
        };
    }

    const nextButton = document.getElementById("reddit-page-next");
    if (nextButton) {
        nextButton.onclick = async () => {
            redditPage += 1;
            try {
                await loadRedditCache();
            } catch (err) {
                redditPage = Math.max(1, redditPage - 1);
                alert(err.message);
            }
        };
    }

    document.querySelectorAll("#reddit-sort-shortcuts button[data-reddit-sort]").forEach((button) => {
        button.onclick = async () => {
            const field = button.dataset.redditSort;
            const sortBy = document.getElementById("reddit-sort-by");
            if (sortBy) {
                sortBy.value = field;
            }
            redditPage = 1;
            try {
                await loadRedditCache();
            } catch (err) {
                alert(err.message);
            }
        };
    });

    const refreshHealthButton = document.getElementById("refresh-health");
    if (refreshHealthButton) {
        refreshHealthButton.onclick = async () => {
            try {
                await pollSystemMetrics();
            } catch (err) {
                alert(err.message);
            }
        };
    }

    const holidayApply = document.getElementById("holiday-filter-apply");
    if (holidayApply) {
        holidayApply.onclick = async () => {
            try {
                await loadHolidays();
            } catch (err) {
                alert(err.message);
            }
        };
    }

    const holidaySync = document.getElementById("holiday-sync-now");
    if (holidaySync) {
        holidaySync.onclick = async () => {
            const originalText = holidaySync.textContent;
            const meta = document.getElementById("holiday-meta");
            try {
                holidaySync.disabled = true;
                holidaySync.textContent = "Syncing...";
                if (meta) {
                    meta.textContent = "Syncing holiday feed...";
                }
                const payload = await requestJson("/admin/api/holidays/sync", {
                    method: "POST",
                    body: JSON.stringify({ async: true }),
                });
                const taskId = payload?.task?.id;
                if (!taskId) {
                    throw new Error("Missing task id from holiday sync response");
                }
                const task = await pollTaskUntilDone(taskId, {
                    intervalMs: 1200,
                    onUpdate: (current) => {
                        if (meta) {
                            meta.textContent = `Syncing holiday feed (${current.status})...`;
                        }
                    },
                });
                await loadHolidays();
                const summary = task.result || {};
                if (meta) {
                    meta.textContent = `Holiday sync complete | fetched=${Number(summary.fetched || 0)} | saved=${Number(summary.saved || 0)}`;
                }
            } catch (err) {
                alert(err.message);
            } finally {
                holidaySync.disabled = false;
                holidaySync.textContent = originalText;
            }
        };
    }

    const candidateApply = document.getElementById("candidate-filter-apply");
    if (candidateApply) {
        candidateApply.onclick = async () => {
            try {
                await loadDatasetCandidates();
            } catch (err) {
                alert(err.message);
            }
        };
    }

    const candidateDataset = document.getElementById("candidate-filter-dataset");
    if (candidateDataset) {
        candidateDataset.addEventListener("change", () => applyCandidateFiltersSoon(0));
    }

    const candidateStatus = document.getElementById("candidate-filter-status");
    if (candidateStatus) {
        candidateStatus.addEventListener("change", () => applyCandidateFiltersSoon(0));
    }

    const candidateLimit = document.getElementById("candidate-filter-limit");
    if (candidateLimit) {
        candidateLimit.addEventListener("input", () => applyCandidateFiltersSoon(200));
        candidateLimit.addEventListener("change", () => applyCandidateFiltersSoon(0));
    }

    const compactViewBtn = document.getElementById("candidate-view-compact");
    if (compactViewBtn) {
        compactViewBtn.addEventListener("click", () => setCandidateViewMode("compact"));
    }

    const expandedViewBtn = document.getElementById("candidate-view-expanded");
    if (expandedViewBtn) {
        expandedViewBtn.addEventListener("click", () => setCandidateViewMode("expanded"));
    }

    setCandidateViewMode(readStoredCandidateViewMode());

    const runDatasetIngest = document.getElementById("run-dataset-ingest");
    if (runDatasetIngest) {
        runDatasetIngest.onclick = async () => {
            const originalText = runDatasetIngest.textContent;
            const meta = document.getElementById("dataset-candidates-meta");
            try {
                runDatasetIngest.disabled = true;
                runDatasetIngest.textContent = "Collecting...";
                if (meta) {
                    meta.textContent = "Collecting suggested dataset content...";
                }

                const payload = await requestJson("/admin/api/dataset-ingest-now", {
                    method: "POST",
                    body: JSON.stringify({ async: true }),
                });

                const taskId = payload?.task?.id;
                if (!taskId) {
                    throw new Error("Missing task id from dataset ingest response");
                }

                const task = await pollTaskUntilDone(taskId, {
                    intervalMs: 1200,
                    onUpdate: (current) => {
                        if (meta) {
                            meta.textContent = `Collecting suggested dataset content (${current.status})...`;
                        }
                    },
                });

                await loadDatasetCandidates();
                await refreshTelemetry();
                const summary = task.result || {};
                if (meta) {
                    meta.textContent = `Collection complete | fetched=${Number(summary.fetched || 0)} | saved=${Number(summary.saved || 0)}`;
                }
            } catch (err) {
                alert(err.message);
            } finally {
                runDatasetIngest.disabled = false;
                runDatasetIngest.textContent = originalText;
            }
        };
    }

    const selectAllVisible = document.getElementById("candidate-select-all-visible");
    if (selectAllVisible) {
        selectAllVisible.onclick = () => {
            (state.dataset_candidates_rows || []).forEach((row) => {
                const id = Number(row.id);
                if (Number.isInteger(id) && id > 0 && isCandidateRow(row)) {
                    selectedCandidateIds.add(id);
                }
            });
            renderDatasetCandidates();
        };
    }

    const clearSelection = document.getElementById("candidate-clear-selection");
    if (clearSelection) {
        clearSelection.onclick = () => {
            selectedCandidateIds = new Set();
            renderDatasetCandidates();
        };
    }

    const bulkApprove = document.getElementById("candidate-bulk-approve");
    if (bulkApprove) {
        bulkApprove.onclick = async () => {
            try {
                const payload = await runBulkCandidateAction("approve");
                alert(`Bulk approve complete: ok=${payload.approved || 0}, failed=${payload.failed || 0}`);
            } catch (err) {
                alert(err.message);
            }
        };
    }

    const bulkReject = document.getElementById("candidate-bulk-reject");
    if (bulkReject) {
        bulkReject.onclick = async () => {
            try {
                const payload = await runBulkCandidateAction("reject");
                alert(`Bulk reject complete: ok=${payload.rejected || 0}, failed=${payload.failed || 0}`);
            } catch (err) {
                alert(err.message);
            }
        };
    }
};

const bootstrap = async () => {
    setDashboardLoading(true, "Bootstrapping admin console");
    try {
        const payload = await requestJson("/admin/api/bootstrap");
        state = { ...state, ...payload };

        state.system_metrics = payload.system_metrics || {};
        state.ai_config = payload.ai_config || {};
        state.admin_profiles = payload.admin_profiles || [];
        state.current_admin_profile = payload.current_admin_profile || null;
        state.schema_status = payload.schema_status || null;
        healthHistory.cpu = [Number(state.system_metrics.cpu_percent_est || 0)];
        healthHistory.mem = [Number(state.system_metrics.memory_percent || 0)];
        healthHistory.load = [Number((state.system_metrics.load_avg || [0])[0] || 0)];

        renderSchemaStatus();
        renderStatus();
        renderLlmAndReddit();
        renderHealth();
        renderEvents();
        renderSettings();
        renderAudit();
        renderRedditCacheRows();
        renderDatasetCandidates();
        renderAiConfig();
        renderCurrentAdminProfile();
        renderAdminDirectory();
        renderRecentTasks();
        setConnectionStatus("ok", "Connected", `Live dashboard ready ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
        void Promise.allSettled([
            loadSources("hk"),
            loadDataset("facts"),
            refreshTelemetry(),
            refreshSourceStatus(),
            loadRedditCache(),
            loadRecentTasks(12),
            loadDatasetCandidates(),
            pollSystemMetrics(),
        ]);

        if (healthPollId) {
            clearInterval(healthPollId);
        }
        if (liveRefreshId) {
            clearInterval(liveRefreshId);
        }
        healthPollId = setInterval(() => {
            pollSystemMetrics().catch(() => { });
        }, 15000);
        liveRefreshId = setInterval(() => {
            refreshLiveData().catch(() => { });
        }, 30000);
    } catch (err) {
        setConnectionStatus("error", "Connection issue", err.message || "Bootstrap failed");
        throw err;
    } finally {
        setDashboardLoading(false);
    }
};

(async () => {
    initTabs();
    initHealthTabs();
    initActions();
    renderConnectionStatus();
    try {
        await bootstrap();
    } catch (err) {
        alert(`Bootstrap failed: ${err.message}`);
    }
})();

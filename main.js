"use strict";

const fs = require("node:fs");
const path = require("node:path");
const utils = require("@iobroker/adapter-core");

const DEFAULT_ROW_CLASS = "statusanzeigeliste-row";
const DEFAULT_ARCHIVE_MAX_ENTRIES = 500;

class Statusanzeigeliste extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "statusanzeigeliste",
        });

        this.rules = [];
        this.rulesByState = new Map();
        this.states = new Map();
        this.activeMessages = new Map();
        this.archive = [];
        this.rebuildTimer = null;

        this.on("ready", () => this.onReady());
        this.on("stateChange", (id, state) => this.onStateChange(id, state));
        this.on("unload", callback => this.onUnload(callback));
    }

    get cfg() {
        return {
            enabled: this.config.enabled !== false,
            includeDate: this.config.includeDate === true || this.config.includeDate === "true",
            includeTime: this.config.includeTime === true || this.config.includeTime === "true",
            emptyText: String(this.config.emptyText || ""),
            htmlLineBreak: this.config.htmlLineBreak !== false,
            rowClass: String(this.config.rowClass || DEFAULT_ROW_CLASS).trim() || DEFAULT_ROW_CLASS,
            archiveEnabled: this.config.archiveEnabled !== false && this.config.archiveEnabled !== "false",
            archiveMaxEntries: this.normalizeArchiveLimit(this.config.archiveMaxEntries),
            emailInstance: String(this.config.emailInstance || "email.0").trim() || "email.0",
            emailRecipient: String(this.config.emailRecipient || "").trim(),
            emailSubject: String(this.config.emailSubject || "ioBroker Meldungsarchiv").trim() || "ioBroker Meldungsarchiv",
            rules: this.parseRules(this.config.rules || this.config.shorts_in),
        };
    }

    async onReady() {
        await this.initObjects();
        await this.loadPersistedData();
        await this.setStateAsync("info.connection", this.cfg.enabled, true);
        await this.setStateAsync("info.lastError", "", true);

        if (!this.cfg.enabled) {
            this.log.info("Adapter is disabled in the instance configuration");
            await this.publishMessages();
            return;
        }

        this.buildRules();
        await this.subscribeStatesAsync("archive.clear");
        await this.subscribeStatesAsync("archive.sendEmail");
        await this.subscribeRuleStates();
        await this.refreshAllRules();
        await this.installVis2Widgets();
    }

    onUnload(callback) {
        try {
            if (this.rebuildTimer) {
                this.clearTimeout(this.rebuildTimer);
                this.rebuildTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    async initObjects() {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: { name: "Information" },
            native: {},
        });

        await this.ensureState("info.connection", "Adapter active", "boolean", "indicator.connected", true, false);
        await this.ensureState("info.activeCount", "Active messages", "number", "value", true, false);
        await this.ensureState("info.lastError", "Last error", "string", "text", true, false);
        await this.ensureState("info.lastUpdate", "Last update", "string", "value.time", true, false);
        await this.ensureState("Meldungen", "Messages as HTML", "string", "html", true, false);
        await this.ensureState("html", "Messages as widget HTML", "string", "html", true, false);
        await this.ensureState("text", "Messages as plain text", "string", "text", true, false);
        await this.ensureState("json", "Messages as JSON", "string", "json", true, false);
        await this.setObjectNotExistsAsync("archive", {
            type: "channel",
            common: { name: "Message archive" },
            native: {},
        });
        await this.ensureState("archive.html", "Archive as HTML", "string", "html", true, false);
        await this.ensureState("archive.text", "Archive as plain text", "string", "text", true, false);
        await this.ensureState("archive.json", "Archive as JSON", "string", "json", true, false);
        await this.ensureState("archive.csv", "Archive as CSV export", "string", "text", true, false);
        await this.ensureState("archive.count", "Archive entries", "number", "value", true, false);
        await this.ensureState("archive.clear", "Clear archive", "boolean", "button", false, true);
        await this.ensureState("archive.sendEmail", "Send archive by email", "boolean", "button", false, true);
        await this.ensureState("archive.emailStatus", "Last email export status", "string", "text", true, false);
        await this.ensureState("archive.lastEmail", "Last successful email export", "string", "value.time", true, false);
        await this.ensureState("archive.activeState", "Persisted active messages", "string", "json", true, false);
    }

    async ensureState(id, name, type, role, read, write) {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { name, type, role, read, write },
            native: {},
        });
    }

    parseRules(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        try {
            const parsed = JSON.parse(String(value));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    buildRules() {
        this.rules = [];
        this.rulesByState.clear();

        for (const [index, raw] of this.cfg.rules.entries()) {
            if (!raw || raw.enabled === false || raw.enabled === "false") continue;

            const sourceId = this.normalizeId(raw.sourceId || raw.source || raw.name_id || raw.id);
            const compareMode = String(raw.compareMode || raw.compareWith || "constant");
            const compareStateId = this.normalizeId(raw.compareStateId || raw.compareId || raw.targetId);
            const operator = this.normalizeOperator(raw.operator || raw.if || "==");

            if (!sourceId) {
                this.log.warn(`Skipping rule ${index + 1}: source state is missing`);
                continue;
            }

            if (compareMode === "state" && !compareStateId) {
                this.log.warn(`Skipping rule ${index + 1}: compare state is missing`);
                continue;
            }

            const rule = {
                id: String(raw.id || `rule_${index + 1}`),
                index: index + 1,
                enabled: true,
                name: String(raw.name || raw.label || `Rule ${index + 1}`),
                sourceId,
                compareMode,
                compareStateId,
                compareValue: raw.compareValue !== undefined ? raw.compareValue : raw.trigger !== undefined ? raw.trigger : raw.if,
                operator,
                valueType: String(raw.valueType || "auto"),
                text: String(raw.text || raw.message || raw.room || raw.name || `Rule ${index + 1}`),
                severity: String(raw.severity || "info"),
            };

            this.rules.push(rule);
            this.addRuleForState(sourceId, rule);
            if (compareMode === "state") this.addRuleForState(compareStateId, rule);
        }

        const configuredRuleIds = new Set(this.rules.map(rule => rule.id));
        for (const id of this.activeMessages.keys()) {
            if (!configuredRuleIds.has(id)) this.activeMessages.delete(id);
        }

        this.log.info(`Statusanzeigeliste active rules: ${this.rules.length}`);
    }

    addRuleForState(id, rule) {
        if (!this.rulesByState.has(id)) this.rulesByState.set(id, []);
        this.rulesByState.get(id).push(rule);
    }

    normalizeId(value) {
        return String(value || "").trim().replace(/^state\./, "");
    }

    normalizeOperator(value) {
        const op = String(value || "==").trim().toLowerCase();
        if (["=", "==", "eq", "equal"].includes(op)) return "==";
        if (["!=", "<>", "ne", "not_equal"].includes(op)) return "!=";
        if ([">", ">=", "<", "<="].includes(op)) return op;
        if (["contains", "includes"].includes(op)) return "contains";
        return "==";
    }

    async subscribeRuleStates() {
        const ids = [...this.rulesByState.keys()];
        for (const id of ids) {
            await this.subscribeForeignStatesAsync(id);
            const state = await this.getForeignStateAsync(id);
            if (state) this.states.set(id, state);
        }
    }

    async refreshAllRules() {
        for (const rule of this.rules) {
            await this.evaluateRule(rule);
        }
        await this.publishMessages();
    }

    async onStateChange(id, state) {
        if (!state || !this.cfg.enabled) return;
        if (id === `${this.namespace}.archive.clear`) {
            if (state.val === true || state.val === "true" || state.val === 1 || state.val === "1") {
                this.archive = [];
                await this.setStateAsync("archive.clear", false, true);
                await this.publishArchive();
                this.log.info("Message archive cleared");
            }
            return;
        }
        if (id === `${this.namespace}.archive.sendEmail`) {
            if (state.val === true || state.val === "true" || state.val === 1 || state.val === "1") {
                await this.setStateAsync("archive.sendEmail", false, true);
                await this.sendArchiveEmail();
            }
            return;
        }
        this.states.set(id, state);

        const rules = this.rulesByState.get(id) || [];
        for (const rule of rules) {
            await this.evaluateRule(rule);
        }

        this.schedulePublish();
    }

    schedulePublish() {
        if (this.rebuildTimer) this.clearTimeout(this.rebuildTimer);
        this.rebuildTimer = this.setTimeout(async () => {
            this.rebuildTimer = null;
            await this.publishMessages();
        }, 50);
    }

    async evaluateRule(rule) {
        try {
            const sourceState = await this.getCachedState(rule.sourceId);
            const compareState = rule.compareMode === "state" ? await this.getCachedState(rule.compareStateId) : null;

            if (!sourceState) {
                this.setInactive(rule.id);
                return;
            }

            const left = sourceState.val;
            const right = rule.compareMode === "state" ? compareState && compareState.val : rule.compareValue;
            const active = this.compareValues(left, right, rule.operator, rule.valueType);

            if (active) {
                const existing = this.activeMessages.get(rule.id);
                const item = {
                    id: rule.id,
                    index: rule.index,
                    name: rule.name,
                    text: rule.text,
                    severity: rule.severity,
                    sourceId: rule.sourceId,
                    compareStateId: rule.compareMode === "state" ? rule.compareStateId : "",
                    operator: rule.operator,
                    sourceValue: left,
                    compareValue: right,
                    startTs: existing ? existing.startTs : Date.now(),
                };
                this.activeMessages.set(rule.id, item);
                if (!existing) this.addArchiveEvent("came", item);
            } else {
                this.setInactive(rule.id, left, right);
            }
            await this.setStateAsync("info.lastError", "", true);
        } catch (error) {
            await this.setStateAsync("info.lastError", `${rule.name}: ${error.message}`, true);
            this.log.warn(`Cannot evaluate rule "${rule.name}": ${error.message}`);
        }
    }

    async getCachedState(id) {
        if (this.states.has(id)) return this.states.get(id);
        const state = await this.getForeignStateAsync(id);
        if (state) this.states.set(id, state);
        return state;
    }

    setInactive(ruleId, sourceValue, compareValue) {
        const existing = this.activeMessages.get(ruleId);
        if (!existing) return;
        this.activeMessages.delete(ruleId);
        this.addArchiveEvent("gone", {
            ...existing,
            sourceValue,
            compareValue,
        });
    }

    normalizeArchiveLimit(value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return DEFAULT_ARCHIVE_MAX_ENTRIES;
        return Math.max(1, Math.min(10000, parsed));
    }

    async loadPersistedData() {
        this.archive = await this.readJsonArrayState("archive.json");
        this.archive = this.archive.slice(0, this.cfg.archiveMaxEntries);
        const active = await this.readJsonArrayState("archive.activeState");
        this.activeMessages.clear();
        for (const item of active) {
            if (item && item.id && Number.isFinite(Number(item.startTs))) {
                this.activeMessages.set(String(item.id), item);
            }
        }
    }

    async readJsonArrayState(id) {
        try {
            const state = await this.getStateAsync(id);
            if (!state || !state.val) return [];
            const parsed = JSON.parse(String(state.val));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    addArchiveEvent(event, item) {
        if (!this.cfg.archiveEnabled) return;
        const timestamp = Date.now();
        const entry = {
            eventId: `${timestamp}-${item.id}-${event}`,
            event,
            ruleId: item.id,
            ruleName: item.name,
            text: item.text,
            severity: item.severity || "info",
            sourceId: item.sourceId,
            sourceValue: item.sourceValue,
            compareValue: item.compareValue,
            timestamp,
            startTs: item.startTs,
            endTs: event === "gone" ? timestamp : null,
            durationMs: event === "gone" ? Math.max(0, timestamp - Number(item.startTs || timestamp)) : null,
        };
        this.archive.unshift(entry);
        if (this.archive.length > this.cfg.archiveMaxEntries) {
            this.archive.length = this.cfg.archiveMaxEntries;
        }
    }

    compareValues(left, right, operator, valueType) {
        if (right === null || right === undefined) return false;

        const type = this.resolveValueType(left, right, valueType);
        const a = this.convertValue(left, type);
        const b = this.convertValue(right, type);

        if (a === null || b === null) return false;

        switch (operator) {
            case "==":
                return a === b;
            case "!=":
                return a !== b;
            case ">":
                return a > b;
            case ">=":
                return a >= b;
            case "<":
                return a < b;
            case "<=":
                return a <= b;
            case "contains":
                return String(a).includes(String(b));
            default:
                return a === b;
        }
    }

    resolveValueType(left, right, configured) {
        if (configured && configured !== "auto") return configured;
        if (this.isNumeric(left) && this.isNumeric(right)) return "number";
        if (this.isBooleanLike(left) && this.isBooleanLike(right)) return "boolean";
        return "string";
    }

    convertValue(value, type) {
        if (type === "number") {
            const num = Number(String(value).replace(",", "."));
            return Number.isFinite(num) ? num : null;
        }
        if (type === "boolean") {
            if (typeof value === "boolean") return value;
            const text = String(value).trim().toLowerCase();
            if (["true", "1", "on", "ein", "yes", "ja"].includes(text)) return true;
            if (["false", "0", "off", "aus", "no", "nein"].includes(text)) return false;
            return null;
        }
        return String(value);
    }

    isNumeric(value) {
        if (value === "" || value === null || value === undefined) return false;
        return Number.isFinite(Number(String(value).replace(",", ".")));
    }

    isBooleanLike(value) {
        if (typeof value === "boolean") return true;
        return ["true", "false", "1", "0", "on", "off", "ein", "aus", "yes", "no", "ja", "nein"].includes(String(value).trim().toLowerCase());
    }

    async publishMessages() {
        const items = [...this.activeMessages.values()].sort((a, b) => a.index - b.index || a.startTs - b.startTs);
        const lines = items.map(item => this.formatMessage(item));
        const plain = lines.join("\n") || this.cfg.emptyText;
        const html = this.renderHtml(items);

        await this.setStateAsync("text", plain, true);
        await this.setStateAsync("Meldungen", html, true);
        await this.setStateAsync("html", html, true);
        await this.setStateAsync("json", JSON.stringify(items), true);
        await this.setStateAsync("info.activeCount", items.length, true);
        await this.setStateAsync("info.lastUpdate", new Date().toISOString(), true);
        await this.setStateAsync("archive.activeState", JSON.stringify(items), true);
        await this.publishArchive();
    }

    async publishArchive() {
        const entries = this.archive.slice(0, this.cfg.archiveMaxEntries);
        const lines = entries.map(entry => this.formatArchiveEntry(entry));
        await this.setStateAsync("archive.text", lines.join("\n"), true);
        await this.setStateAsync("archive.html", this.renderArchiveHtml(entries), true);
        await this.setStateAsync("archive.json", JSON.stringify(entries), true);
        await this.setStateAsync("archive.csv", this.renderArchiveCsv(entries), true);
        await this.setStateAsync("archive.count", entries.length, true);
    }

    renderArchiveCsv(entries) {
        const rows = [
            ["Zeitpunkt", "Ereignis", "Prioritaet", "Regel", "Meldung", "Datenpunkt", "Wert", "Dauer Sekunden"],
        ];
        for (const entry of entries) {
            rows.push([
                new Date(entry.timestamp).toISOString(),
                entry.event === "gone" ? "GEGANGEN" : "GEKOMMEN",
                entry.severity || "info",
                entry.ruleName || "",
                entry.text || "",
                entry.sourceId || "",
                entry.sourceValue ?? "",
                entry.event === "gone" ? Math.round(Number(entry.durationMs || 0) / 1000) : "",
            ]);
        }
        return rows.map(row => row.map(value => this.escapeCsv(value)).join(";")).join("\r\n");
    }

    escapeCsv(value) {
        const text = String(value ?? "");
        return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    async sendArchiveEmail() {
        try {
            const instanceId = this.cfg.emailInstance.startsWith("system.adapter.")
                ? this.cfg.emailInstance
                : `system.adapter.${this.cfg.emailInstance}`;
            const instance = await this.getForeignObjectAsync(instanceId);
            if (!instance) throw new Error(`E-Mail-Adapterinstanz ${this.cfg.emailInstance} ist nicht installiert`);
            if (instance.common && instance.common.enabled === false) {
                throw new Error(`E-Mail-Adapterinstanz ${this.cfg.emailInstance} ist deaktiviert`);
            }

            const csv = this.renderArchiveCsv(this.archive.slice(0, this.cfg.archiveMaxEntries));
            const day = new Date().toISOString().slice(0, 10);
            const message = {
                subject: this.cfg.emailSubject,
                text: `Im Anhang befindet sich das ioBroker-Meldungsarchiv mit ${this.archive.length} Eintraegen.`,
                attachments: [{
                    filename: `statusanzeigeliste-archiv-${day}.csv`,
                    content: `\uFEFF${csv}`,
                    contentType: "text/csv; charset=utf-8",
                }],
            };
            if (this.cfg.emailRecipient) message.to = this.cfg.emailRecipient;

            await new Promise((resolve, reject) => {
                this.sendTo(this.cfg.emailInstance, "send", message, response => {
                    if (response && (response.error || response.sent === false)) {
                        reject(new Error(response.error || "E-Mail-Versand fehlgeschlagen"));
                    } else {
                        resolve(response);
                    }
                });
            });

            const timestamp = new Date().toISOString();
            await this.setStateAsync("archive.emailStatus", `Erfolgreich versendet: ${timestamp}`, true);
            await this.setStateAsync("archive.lastEmail", timestamp, true);
            this.log.info(`Message archive sent via ${this.cfg.emailInstance}`);
        } catch (error) {
            await this.setStateAsync("archive.emailStatus", `Fehler: ${error.message}`, true);
            this.log.warn(`Cannot send message archive by email: ${error.message}`);
        }
    }

    formatArchiveEntry(entry) {
        const timestamp = new Date(entry.timestamp);
        const state = entry.event === "gone" ? "GEGANGEN" : "GEKOMMEN";
        const duration = entry.event === "gone" ? ` · Dauer ${this.formatDuration(entry.durationMs)}` : "";
        return `${this.formatDate(timestamp)} ${this.formatTime(timestamp)} · ${state} · ${entry.text}${duration}`;
    }

    renderArchiveHtml(entries) {
        if (!entries.length) {
            return `<div class="${this.escapeHtml(this.cfg.rowClass)} empty">Archiv ist leer</div>`;
        }
        return entries.map(entry => {
            const severity = this.escapeHtml(entry.severity || "info");
            const event = entry.event === "gone" ? "gone" : "came";
            const state = event === "gone" ? "GEGANGEN" : "GEKOMMEN";
            const timestamp = new Date(entry.timestamp);
            const duration = event === "gone" ? ` · Dauer ${this.formatDuration(entry.durationMs)}` : "";
            const text = this.escapeHtml(`${this.formatDate(timestamp)} ${this.formatTime(timestamp)} · ${entry.text}${duration}`);
            const attributes = [
                ["severity", entry.severity || "info"],
                ["event", state],
                ["timestamp", new Date(entry.timestamp).toISOString()],
                ["rule", entry.ruleName || ""],
                ["text", entry.text || ""],
                ["source", entry.sourceId || ""],
                ["value", entry.sourceValue ?? ""],
                ["duration-seconds", event === "gone" ? Math.round(Number(entry.durationMs || 0) / 1000) : ""],
            ].map(([name, value]) => `data-${name}="${this.escapeHtml(value)}"`).join(" ");
            return `<div class="${this.escapeHtml(this.cfg.rowClass)} archive ${severity} archive-${event}" ${attributes}><span class="statusanzeigeliste-archive-event">${state}</span><span class="statusanzeigeliste-archive-text">${text}</span></div>`;
        }).join("\n");
    }

    formatDuration(durationMs) {
        let seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
        const days = Math.floor(seconds / 86400);
        seconds %= 86400;
        const hours = Math.floor(seconds / 3600);
        seconds %= 3600;
        const minutes = Math.floor(seconds / 60);
        seconds %= 60;
        const parts = [];
        if (days) parts.push(`${days}d`);
        if (hours) parts.push(`${hours}h`);
        if (minutes) parts.push(`${minutes}m`);
        if (seconds || !parts.length) parts.push(`${seconds}s`);
        return parts.join(" ");
    }

    formatMessage(item) {
        const date = new Date(item.startTs);
        const parts = [];
        if (this.cfg.includeDate) parts.push(this.formatDate(date));
        if (this.cfg.includeTime) parts.push(this.formatTime(date));
        parts.push(item.text);
        return parts.filter(Boolean).join(" ");
    }

    renderHtml(items) {
        if (!items.length) {
            return this.cfg.emptyText ? `<div class="${this.escapeHtml(this.cfg.rowClass)} empty">${this.escapeHtml(this.cfg.emptyText)}</div>` : "";
        }

        return items
            .map(item => {
                const text = this.escapeHtml(this.formatMessage(item));
                const severity = this.escapeHtml(item.severity || "info");
                return `<div class="${this.escapeHtml(this.cfg.rowClass)} ${severity}" data-severity="${severity}">${text}</div>`;
            })
            .join(this.cfg.htmlLineBreak ? "\n" : "");
    }

    formatDate(date) {
        return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}`;
    }

    formatTime(date) {
        return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
    }

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    async installVis2Widgets() {
        try {
            const widgetHtml = await fs.promises.readFile(path.join(__dirname, "widgets", "statusanzeigeliste.html"), "utf8");
            const widgetCss = await fs.promises.readFile(path.join(__dirname, "widgets", "statusanzeigeliste", "statusanzeigeliste.css"), "utf8");

            await this.writeFileAsync("vis-2", "widgets/statusanzeigeliste.html", widgetHtml);
            await this.writeFileAsync("vis-2", "widgets/statusanzeigeliste/statusanzeigeliste.css", widgetCss);

            await this.patchVis2Config();
            await this.patchVis2WidgetsHtml(widgetHtml);
        } catch (error) {
            this.log.debug(`VIS-2 widget registration skipped: ${error.message}`);
        }
    }

    async patchVis2Config() {
        let config;
        try {
            config = (await this.readFileAsync("vis-2", "config.js")).file.toString("utf8");
        } catch {
            return;
        }

        if (config.includes('"statusanzeigeliste"')) return;
        const patched = config.replace(/"widgetSets"\s*:\s*\[([^\]]*)\]/, (match, list) => {
            const trimmed = String(list || "").trim();
            return `"widgetSets": [${trimmed ? `${trimmed},` : ""}"statusanzeigeliste"]`;
        });

        if (patched !== config) {
            await this.writeFileAsync("vis-2", "config.js", patched);
            this.log.info("Registered statusanzeigeliste widget set in VIS-2 config.js");
        }
    }

    async patchVis2WidgetsHtml(widgetHtml) {
        let widgets;
        try {
            widgets = (await this.readFileAsync("vis-2", "widgets.html")).file.toString("utf8");
        } catch {
            return;
        }

        const start = "<!-- --------------statusanzeigeliste.html--- START -->";
        const end = "<!-- --------------statusanzeigeliste.html--- END -->";
        const block = ["", start, widgetHtml, end, ""].join("\n");
        let patched = widgets;

        if (widgets.includes(start) && widgets.includes(end)) {
            const pattern = new RegExp(`${this.escapeRegExp(start)}[\\s\\S]*?${this.escapeRegExp(end)}`);
            patched = widgets.replace(pattern, [start, widgetHtml, end].join("\n"));
        } else if (!widgets.includes("tplStatusanzeigelisteList")) {
            patched = `${widgets}${block}`;
        }

        if (patched !== widgets) {
            await this.writeFileAsync("vis-2", "widgets.html", patched);
            this.log.info("Registered statusanzeigeliste widget templates in VIS-2 widgets.html");
        }
    }

    escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}

if (require.main !== module) {
    module.exports = options => new Statusanzeigeliste(options);
} else {
    new Statusanzeigeliste();
}

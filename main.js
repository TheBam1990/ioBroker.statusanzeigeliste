"use strict";

const fs = require("fs");
const path = require("path");
const utils = require("@iobroker/adapter-core");

const DEFAULT_ROW_CLASS = "statusanzeigeliste-row";

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
            rules: this.parseRules(this.config.rules || this.config.shorts_in),
        };
    }

    async onReady() {
        await this.initObjects();
        await this.setStateAsync("info.connection", this.cfg.enabled, true);
        await this.setStateAsync("info.lastError", "", true);

        if (!this.cfg.enabled) {
            this.log.info("Adapter is disabled in the instance configuration");
            await this.publishMessages();
            return;
        }

        this.buildRules();
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
                this.activeMessages.set(rule.id, {
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
                });
            } else {
                this.setInactive(rule.id);
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

    setInactive(ruleId) {
        this.activeMessages.delete(ruleId);
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

        if (widgets.includes("tplStatusanzeigelisteList")) return;
        const block = ["", "<!-- --------------statusanzeigeliste.html--- START -->", widgetHtml, "<!-- --------------statusanzeigeliste.html--- END -->", ""].join("\n");
        await this.writeFileAsync("vis-2", "widgets.html", `${widgets}${block}`);
        this.log.info("Registered statusanzeigeliste widget templates in VIS-2 widgets.html");
    }
}

if (require.main !== module) {
    module.exports = options => new Statusanzeigeliste(options);
} else {
    new Statusanzeigeliste();
}

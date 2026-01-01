import { Node } from "nodered";
import Timer from "timer";
import Digital from "pins/digital";
import { MCP23017 } from "MCP230XX";

const expanderCache = Object.create(null);
const MODE_MONITOR = "output";
const MODE_DRIVE = "input";
const MIN_POLL_INTERVAL = 20;
const DEFAULT_POLL_INTERVAL = 50;

function acquireExpander(address, sda, scl) {
    const key = `${address}:${sda ?? ""}:${scl ?? ""}`;
    let entry = expanderCache[key];
    if (!entry) {
        const options = { address };
        options.sda = sda;
        options.scl = scl;
        entry = { expander: new MCP23017(options), refs: 0, pins: Object.create(null) };
        expanderCache[key] = entry;
    }
    entry.refs += 1;
    return { expander: entry.expander, key };
}

function releaseExpander(key) {
    if (!key) {
        return;
    }
    const entry = expanderCache[key];
    if (!entry) {
        return;
    }
    entry.refs -= 1;
    if (entry.refs <= 0) {
        try {
            entry.expander?.close?.();
        } catch (_) {
            // ignore close errors
        }
        delete expanderCache[key];
    }
}

class MCP23017Node extends Node {
    #address;
    #pinNumber;
    #mode;
    #pollInterval;
    #usePullup;
    #sda;
    #scl;
    #cacheKey;
    #expander;
    #pin;
    #timerId;
    #lastState;
    #pinReserved;

    onStart(config) {
        super.onStart(config);

        const address = this.#readNumber(config.address);
        const pin = this.#readNumber(config.pin);
        this.#mode = config?.mode === MODE_DRIVE ? MODE_DRIVE : MODE_MONITOR;
        this.#pollInterval = Math.max(MIN_POLL_INTERVAL, this.#readNumber(config?.pollInterval, DEFAULT_POLL_INTERVAL));
        this.#usePullup = config?.pullup === true || config?.pullup === "true";
        this.#sda = this.#readNumber(config.sda);
        this.#scl = this.#readNumber(config.scl);
        this.#pinReserved = false;

        if (!Number.isInteger(address) || !Number.isInteger(pin) || pin < 0 || pin > 15) {
            const status = (this._ && this._("mcp23017.status_invalid_config")) || "invalid config";
            const errorMsg = (this._ && this._("mcp23017.error_invalid_config")) || "Invalid MCP23017 configuration";
            this.status({ fill: "red", shape: "ring", text: status });
            this.error(errorMsg);
            return;
        }

        this.#address = address;
        this.#pinNumber = pin;

        try {
            const { expander, key } = acquireExpander(address, this.#sda, this.#scl);
            this.#expander = expander;
            this.#cacheKey = key;
            this.#pin = this.#expander[this.#pinNumber];
            if (!this.#pin) {
                throw new Error("Pin index out of range");
            }
            if (!this.#reservePin()) {
                const status = (this._ && this._("mcp23017.status_pin_conflict")) || "pin in use";
                const errorMsg = (this._ && this._("mcp23017.error_pin_conflict")) || "Pin already used in opposite mode";
                this.status({ fill: "red", shape: "ring", text: status });
                this.error(errorMsg);
                this.#pin = undefined;
                this.#expander = undefined;
                releaseExpander(this.#cacheKey);
                this.#cacheKey = undefined;
                return;
            }
            this.#pinReserved = true;
        } catch (error) {
            releaseExpander(this.#cacheKey);
            this.#cacheKey = undefined;
            const status = (this._ && this._("mcp23017.status_error")) || "error";
            this.status({ fill: "red", shape: "ring", text: status });
            this.error(error?.message ?? error);
            return;
        }

        const initializing = (this._ && this._("mcp23017.status_initializing")) || "initializing";
        this.status({ fill: "grey", shape: "ring", text: initializing });

        if (this.#mode === MODE_MONITOR) {
            this.#startMonitoring();
        } else {
            this.#prepareForDriving();
        }
    }

    onMessage(msg, done) {
        if (this.#mode !== MODE_DRIVE || !this.#pin) {
            done?.();
            return;
        }

        const value = msg?.payload;
        if (value !== 0 && value !== 1) {
            const warnMsg = (this._ && this._("mcp23017.warn_invalid_payload")) || "Expected payload 0 or 1";
            this.warn(warnMsg);
            done?.();
            return;
        }

        try {
            this.#pin.mode(Digital.Output);
            this.#pin.write(value);
            this.#lastState = value;
            this.#updateStatus(value);
            this.#sendPayload(value);
            done?.();
        } catch (error) {
            const status = (this._ && this._("mcp23017.status_error")) || "error";
            this.status({ fill: "red", shape: "ring", text: status });
            this.error(error?.message ?? error, msg);
            done?.(error);
        }
    }

    onStop() {
        if (this.#timerId !== undefined) {
            Timer.clear(this.#timerId);
            this.#timerId = undefined;
        }
        if (this.#pinReserved) {
            this.#releasePin();
            this.#pinReserved = false;
        }
        releaseExpander(this.#cacheKey);
        this.#cacheKey = undefined;
        this.#expander = undefined;
        this.#pin = undefined;
        this.#lastState = undefined;
    }

    #startMonitoring() {
        try {
            this.#pin.mode(this.#usePullup ? Digital.InputPullUp : Digital.Input);
        } catch (error) {
            const status = (this._ && this._("mcp23017.status_error")) || "error";
            this.status({ fill: "red", shape: "ring", text: status });
            this.error(error?.message ?? error);
            this.onStop();
            return;
        }

        const monitoring = (this._ && this._("mcp23017.status_monitoring")) || "monitoring";
        this.status({ fill: "blue", shape: "ring", text: monitoring });
        // emit initial state immediately
        this.#poll(true);
        this.#timerId = Timer.repeat(() => this.#poll(false), this.#pollInterval);
    }

    #prepareForDriving() {
        try {
            this.#pin.mode(Digital.Output);
        } catch (error) {
            const status = (this._ && this._("mcp23017.status_error")) || "error";
            this.status({ fill: "red", shape: "ring", text: status });
            this.error(error?.message ?? error);
            this.onStop();
            return;
        }

        const ready = (this._ && this._("mcp23017.status_ready")) || "ready";
        this.status({ fill: "green", shape: "dot", text: ready });
        // ensure current output value is emitted
        const state = this.#safeRead();
        if (state !== undefined) {
            this.#lastState = state;
            this.#sendPayload(state);
        }
    }

    #poll(forceEmit) {
        if (!this.#pin) {
            return;
        }

        try {
            const state = this.#pin.read();
            if (forceEmit || state !== this.#lastState) {
                this.#lastState = state;
                this.#updateStatus(state);
                this.#sendPayload(state);
            }
        } catch (error) {
            const status = (this._ && this._("mcp23017.status_error")) || "error";
            this.status({ fill: "red", shape: "ring", text: status });
            this.error(error?.message ?? error);
        }
    }

    #updateStatus(state) {
        const label = state === 1 ? "1" : "0";
        this.status({
            fill: state ? "green" : "grey",
            shape: state ? "dot" : "ring",
            text: label
        });
    }

    #sendPayload(value) {
        this.send({ payload: value });
    }

    #readNumber(value, fallback) {
        if (value === undefined || value === null || value === "") {
            return fallback;
        }
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
    }

    #reservePin() {
        const entry = this.#cacheKey ? expanderCache[this.#cacheKey] : undefined;
        if (!entry) {
            return false;
        }
        const pins = entry.pins;
        const current = pins[this.#pinNumber];
        if (!current) {
            pins[this.#pinNumber] = { mode: this.#mode, count: 1 };
            return true;
        }
        if (current.mode !== this.#mode) {
            return false;
        }
        current.count += 1;
        return true;
    }

    #releasePin() {
        const entry = this.#cacheKey ? expanderCache[this.#cacheKey] : undefined;
        if (!entry) {
            return;
        }
        const pins = entry.pins;
        const current = pins[this.#pinNumber];
        if (!current) {
            return;
        }
        current.count -= 1;
        if (current.count <= 0) {
            delete pins[this.#pinNumber];
        }
    }

    #safeRead() {
        try {
            const state = this.#pin?.read?.();
            if (state === 0 || state === 1) {
                return state;
            }
        } catch (_) {
            // ignore read errors on initialization
        }
        return undefined;
    }

    static type = "mcp23017";

    static {
        RED.nodes.registerType(this.type, this);
    }
}

export default MCP23017Node;

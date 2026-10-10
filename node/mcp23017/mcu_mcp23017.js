import { Node } from "nodered";
import Timer from "timer";
import Digital from "pins/digital";
import { MCP23017 } from "MCP230XX";

const expanderCache = Object.create(null);
const MODE_MONITOR = "output";
const MODE_DRIVE = "input";
const MIN_POLL_INTERVAL = 20;
const DEFAULT_POLL_INTERVAL = 50;
const MIN_ADDRESS = 0x00;
const MAX_ADDRESS = 0x7F;
const MAX_POLL_ERRORS = 5;

/*
 * Status texts are locale keys: node-red-mcu-plugin relays the status to the
 * editor, which translates it in the node's namespace. Logged messages are
 * plain text (RED._ does not translate on the MCU).
 */
const STATUS = {
    initializing: "mcu_mcp23017.status_initializing",
    monitoring: "mcu_mcp23017.status_monitoring",
    ready: "mcu_mcp23017.status_ready",
    pinConflict: "mcu_mcp23017.status_pin_conflict",
    error: "mcu_mcp23017.status_error",
    invalidConfig: "mcu_mcp23017.status_invalid_config"
};

/* 0 / 1, true / false and "0" / "1" drive the pin; anything else is undefined */
function toPinValue(value) {
    if (value === 0 || value === 1)
        return value;
    if (value === true || value === "1")
        return 1;
    if (value === false || value === "0")
        return 0;
    return undefined;
}

function acquireExpander(address, sda, scl) {
    const key = `${address}:${sda ?? ""}:${scl ?? ""}`;
    let entry = expanderCache[key];
    if (!entry) {
        const options = { address };
        if (sda !== undefined) {
            options.sda = sda;
        }
        if (scl !== undefined) {
            options.scl = scl;
        }
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
    #pollErrors;

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
        this.#pollErrors = 0;

        const addressValid = Number.isInteger(address) && address >= MIN_ADDRESS && address <= MAX_ADDRESS;
        if (!addressValid || !Number.isInteger(pin) || pin < 0 || pin > 15) {
            this.status({ fill: "red", shape: "ring", text: STATUS.invalidConfig });
            this.error("Invalid MCP23017 configuration");
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
                this.status({ fill: "red", shape: "ring", text: STATUS.pinConflict });
                this.error("Pin already used in opposite mode");
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
            this.status({ fill: "red", shape: "ring", text: STATUS.error });
            this.error(error?.message ?? error);
            return;
        }

        this.status({ fill: "grey", shape: "ring", text: STATUS.initializing });

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

        const value = toPinValue(msg?.payload);
        if (value === undefined) {
            this.warn("Expected msg.payload to be 0 or 1 (true / false and \"0\" / \"1\" are accepted too)");
            done?.();
            return;
        }

        try {
            // re-assert the direction, so a reset expander recovers on the next write
            this.#pin.mode(Digital.Output);
            this.#pin.write(value);
            this.#lastState = value;
            this.#updateStatus(value);
            done?.();
        } catch (error) {
            this.status({ fill: "red", shape: "ring", text: STATUS.error });
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
        this.#pollErrors = 0;
    }

    #startMonitoring() {
        try {
            this.#pin.mode(this.#usePullup ? Digital.InputPullUp : Digital.Input);
        } catch (error) {
            this.status({ fill: "red", shape: "ring", text: STATUS.error });
            this.error(error?.message ?? error);
            this.onStop();
            return;
        }

        this.status({ fill: "blue", shape: "ring", text: STATUS.monitoring });
        // emit initial state immediately
        this.#poll(true);
        this.#timerId = Timer.repeat(() => this.#poll(false), this.#pollInterval);
    }

    #prepareForDriving() {
        try {
            this.#pin.mode(Digital.Output);
        } catch (error) {
            this.status({ fill: "red", shape: "ring", text: STATUS.error });
            this.error(error?.message ?? error);
            this.onStop();
            return;
        }

        this.status({ fill: "green", shape: "dot", text: STATUS.ready });
        // reflect the current output value in the status, this mode has no output port
        const state = this.#safeRead();
        if (state !== undefined) {
            this.#lastState = state;
            this.#updateStatus(state);
        }
    }

    #poll(forceEmit) {
        if (!this.#pin) {
            return;
        }

        try {
            const state = this.#pin.read();
            this.#pollErrors = 0;
            if (forceEmit || state !== this.#lastState) {
                this.#lastState = state;
                this.#updateStatus(state);
                this.#sendPayload(state);
            }
        } catch (error) {
            this.#pollErrors += 1;
            this.status({ fill: "red", shape: "ring", text: STATUS.error });
            if (this.#pollErrors >= MAX_POLL_ERRORS) {
                // stop polling rather than repeating the same failure forever
                if (this.#timerId !== undefined) {
                    Timer.clear(this.#timerId);
                    this.#timerId = undefined;
                }
                this.error(error?.message ?? error);
            }
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

    static type = "mcu_mcp23017";

    static {
        RED.nodes.registerType(this.type, this);
    }
}

export default MCP23017Node;

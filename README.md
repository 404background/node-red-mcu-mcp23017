# @background404/node-red-contrib-mcu-mcp23017

Node-RED MCU node (`mcu_mcp23017`) for managing individual GPIO pins on a Microchip MCP23017 I/O expander via I2C. The node works on the Moddable-based Node-RED MCU runtime and lets you monitor or drive a single pin per node instance.

## Overview

[![Watch the MCP23017 node overview](https://raw.githubusercontent.com/404background/node-red-mcu-mcp23017/main/images/thumbnail.jpg)](https://youtu.be/WkN1rGVrt4w)

Click the thumbnail to watch the video overview.

## Requirements

- Node-RED 3.0 or later
- [node-red-mcu-plugin](https://github.com/ralphwetzel/node-red-mcu-plugin) and the Moddable SDK, to build the flow for a microcontroller
- An MCP23017 I/O expander on the I2C bus

The I2C access happens only when the flow is built and run with Node-RED MCU. On a plain Node-RED runtime the node is registered but does nothing.

## Installation

```bash
npm install @background404/node-red-contrib-mcu-mcp23017
```

Or install it from the Node-RED palette manager.

## Highlights

- `Input (read pin)` mode polls the pin every 50&nbsp;ms by default, emits the initial value immediately, and reports changes as numeric `0`/`1` payloads and status text.
- `Output (drive pin)` mode accepts `0` or `1` (also `true` / `false` and the strings `"0"` / `"1"`), drives the MCP23017 pin, and shows the applied value in the node status.
- Shared expander cache and per-pin reservations help avoid conflicting configurations.

![Read mode configuration](https://raw.githubusercontent.com/404background/node-red-mcu-mcp23017/main/images/output.png)

![Drive mode configuration](https://raw.githubusercontent.com/404background/node-red-mcu-mcp23017/main/images/input.png)

## Node Configuration

| Field | Description |
| ----- | ----------- |
| Name | Optional label shown in the editor. |
| I2C Address | MCP23017 device address, entered as hex such as `0x20` or as a decimal number. |
| Pin | GPIO number (0-15). |
| SDA pin | SDA pin of the board (default 6). |
| SCL pin | SCL pin of the board (default 7). |
| Mode | `Input (read pin)` to monitor the pin, `Output (drive pin)` to control it. |
| Poll interval | Poll period in milliseconds when reading a pin (default 50 ms, minimum 20 ms). |
| Pull-up resistor | Enable internal pull-up when reading an input that needs it. |

The mode also decides the ports of the node: `Input (read pin)` has one output and no input, `Output (drive pin)` has one input and no output.

## Example Flow

A sample flow is located at `examples/mcp23017-example.json`. It is also available from the Node-RED editor menu under *Import* > *Examples* > *@background404/node-red-contrib-mcu-mcp23017*.

![Example flow wiring a read pin to a driven pin](https://raw.githubusercontent.com/404background/node-red-mcu-mcp23017/main/images/flows.png)

## License

MIT

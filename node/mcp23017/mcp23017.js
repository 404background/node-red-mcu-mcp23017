module.exports = function(RED) {
    function MCP23017Node(config) {
        RED.nodes.createNode(this, config);
        this.config = config;
    }

    RED.nodes.registerType('mcp23017', MCP23017Node);
};

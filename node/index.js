const mcp23017 = require('./mcp23017/mcp23017');

module.exports = function(RED) {
    mcp23017(RED);
};

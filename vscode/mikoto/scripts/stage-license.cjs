const { copyFileSync } = require("node:fs");
const { resolve } = require("node:path");
copyFileSync(resolve(__dirname, "../../../LICENSE"), resolve(__dirname, "../LICENSE"));

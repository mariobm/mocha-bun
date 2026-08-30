"use strict";
// CJS version for Bun - original lib/cli/one-and-dones.js is ESM
let Mocha;
try {
  Mocha = require("../mocha.cjs");
} catch {
  Mocha = require("../mocha.cjs");
}
const showKeys = (obj) => {
  console.log();
  const keys = Object.keys(obj);
  const maxKeyLength = keys.reduce((max, key) => Math.max(max, key.length), 0);
  keys
    .filter(
      (key) =>
        /^[a-z]/.test(key) && !obj[key].browserOnly && !obj[key].abstract,
    )
    .sort()
    .forEach((key) => {
      const description = obj[key].description;
      console.log(
        `    ${key.padEnd(maxKeyLength + 1)}${description ? `- ${description}` : ""}`,
      );
    });
  console.log();
};
const ONE_AND_DONES = {
  "list-interfaces": () => {
    showKeys(Mocha.interfaces);
  },
  "list-reporters": () => {
    showKeys(Mocha.reporters);
  },
};
const ONE_AND_DONE_ARGS = new Set(
  ["help", "h", "version", "V"].concat(Object.keys(ONE_AND_DONES)),
);
module.exports = { ONE_AND_DONES, ONE_AND_DONE_ARGS };
module.exports.ONE_AND_DONES = ONE_AND_DONES;
module.exports.ONE_AND_DONE_ARGS = ONE_AND_DONE_ARGS;

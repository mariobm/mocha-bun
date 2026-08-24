/**
 * ESM version for Bun - Main entry point for handling filesystem-based configuration
 * @private
 * @module
 */

import { readFileSync } from "node:fs";
import pc from "picocolors";
import { parseMochaArgs } from "./parse-args.js";
import { ONE_AND_DONE_ARGS } from "./one-and-dones.js";
import mocharc from "../mocharc.json" with { type: "json" };
import { loadConfig, findConfig } from "./config.cjs";
import { sync } from "find-up";
import debugModule from "debug";
import { createUnparsableFileError, isMochaError } from "../errors.js";

const debug = debugModule("mocha:cli:options");

const parse = (args = [], defaultValues = {}, ...configObjects) => {
  try {
    return parseMochaArgs(args, defaultValues, ...configObjects);
  } catch (err) {
    if (isMochaError(err)) {
      throw err;
    }
    console.error(pc.red(`Error: ${err.message}`));
    process.exit(1);
  }
};

export const loadRc = (args = {}) => {
  if (args.config !== false) {
    const config = args.config || findConfig();
    return config ? loadConfig(config) : {};
  }
};

export const loadPkgRc = (args = {}) => {
  let result;
  if (args.package === false) {
    return result;
  }
  result = {};
  const filepath = args.package || sync(mocharc.package);
  if (filepath) {
    let configData;
    try {
      configData = readFileSync(filepath, "utf8");
    } catch (err) {
      if (filepath == args.package) {
        throw createUnparsableFileError(
          `Unable to read ${filepath}: ${err}`,
          filepath,
        );
      } else {
        debug("failed to read default package.json at %s; ignoring", filepath);
        return result;
      }
    }
    try {
      const pkg = JSON.parse(configData);
      if (pkg.mocha) {
        debug("`mocha` prop of package.json parsed: %O", pkg.mocha);
        result = pkg.mocha;
      } else {
        debug("no config found in %s", filepath);
      }
    } catch (err) {
      throw createUnparsableFileError(
        `Unable to parse ${filepath}: ${err}`,
        filepath,
      );
    }
  }
  return result;
};

export const loadOptions = (argv = []) => {
  let args = parse(argv);
  if (
    Array.from(ONE_AND_DONE_ARGS).reduce(
      (acc, arg) => acc || arg in args,
      false,
    )
  ) {
    return args;
  }

  const envConfig = parse(process.env.MOCHA_OPTIONS || "");
  const rcConfig = loadRc(args);
  const pkgConfig = loadPkgRc(args);

  if (rcConfig) {
    args.config = false;
    args._ = args._.concat(rcConfig._ || []);
  }
  if (pkgConfig) {
    args.package = false;
    args._ = args._.concat(pkgConfig._ || []);
  }

  args = parse(
    args._,
    mocharc,
    args,
    envConfig,
    rcConfig || {},
    pkgConfig || {},
  );

  if (args.spec) {
    args._ = args._.concat(args.spec);
    delete args.spec;
  }

  args._ = Array.from(new Set(args._));

  return args;
};

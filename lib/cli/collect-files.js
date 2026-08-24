/**
 * ESM version for Bun - Collect files helpers
 * @private
 * @module
 */

import path from "node:path";
import pc from "picocolors";
import debugModule from "debug";
import { minimatch } from "minimatch";
import { constants } from "../error-constants.js";
const { NO_FILES_MATCH_PATTERN } = constants;
import { lookupFiles } from "./lookup-files.js";
import { castArray } from "../utils.cjs";

const debug = debugModule("mocha:cli:run:helpers");

/**
 * Smash together an array of test files in the correct order
 * @param {Object} [opts] - Options
 * @returns {Object} An object containing a list of files to test and unmatched files.
 * @private
 */
export default function collectFiles({
  ignore,
  extension,
  file: fileArgs,
  recursive,
  sort,
  spec,
} = {}) {
  const unmatchedSpecFiles = [];
  const specFiles = spec.reduce((specFiles, arg) => {
    try {
      const moreSpecFiles = castArray(lookupFiles(arg, extension, recursive))
        .filter((filename) =>
          ignore.every(
            (pattern) =>
              !minimatch(filename, pattern, { windowsPathsNoEscape: true }),
          ),
        )
        .map((filename) => path.resolve(filename));
      return [...specFiles, ...moreSpecFiles];
    } catch (err) {
      if (err.code === NO_FILES_MATCH_PATTERN) {
        unmatchedSpecFiles.push({ message: err.message, pattern: err.pattern });
        return specFiles;
      }
      throw err;
    }
  }, []);

  const unmatchedFiles = [];
  fileArgs.forEach((file) => {
    const fileAbsolutePath = path.resolve(file);
    try {
      require.resolve(fileAbsolutePath);
    } catch (err) {
      if (err.code === "MODULE_NOT_FOUND") {
        unmatchedFiles.push({
          pattern: file,
          absolutePath: fileAbsolutePath,
        });
        return;
      }
      throw err;
    }
  });

  if (sort) {
    specFiles.sort();
  }

  const files = [
    ...fileArgs.map((filepath) => path.resolve(filepath)),
    ...specFiles,
  ];
  debug("test files (in order): ", files);

  if (!files.length) {
    const noneFoundMsg =
      unmatchedSpecFiles.length === 1
        ? `Error: No test files found: ${JSON.stringify(
            unmatchedSpecFiles[0].pattern,
          )}`
        : "Error: No test files found";
    console.error(pc.red(noneFoundMsg));
    process.exit(1);
  } else {
    unmatchedSpecFiles.forEach((warning) => {
      console.warn(pc.yellow(`Warning: ${warning.message}`));
    });
  }

  return {
    files,
    unmatchedFiles,
  };
}

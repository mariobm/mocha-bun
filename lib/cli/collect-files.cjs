"use strict";

const path = require("node:path");
const pc = require("picocolors");
const debug = require("debug")("mocha:cli:run:helpers");
const { minimatch } = require("minimatch");
let NO_FILES_MATCH_PATTERN;
try {
  ({ NO_FILES_MATCH_PATTERN } = require("../error-constants.cjs").constants);
} catch {
  ({ NO_FILES_MATCH_PATTERN } = require("../error-constants.js").constants);
}
let lookupFiles;
try {
  ({ lookupFiles } = require("./lookup-files.js"));
} catch {
  // Bun fallback: lookup-files.js is ESM (require(esm) unsupported on Bun)
  // Provide minimal CJS implementation using fs.globSync (mirrors lookup-files.js)
  const fs = require("node:fs");
  const pathFallback = require("node:path");
  let createNoFilesMatchPatternError, createMissingArgumentError;
  try {
    ({
      createNoFilesMatchPatternError,
      createMissingArgumentError,
    } = require("../errors.cjs"));
  } catch {
    ({
      createNoFilesMatchPatternError,
      createMissingArgumentError,
    } = require("../errors.js"));
  }
  const debugFallback = require("debug")("mocha:cli:lookup-files");
  function hasMagicFallback(p) {
    return /[*?[\]{}()!+@]/.test(p);
  }
  const isHiddenOnUnix = (pathname) =>
    pathFallback.basename(pathname).startsWith(".");
  const hasMatchingExtname = (pathname, exts = []) =>
    exts
      .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
      .some((ext) => pathname.endsWith(ext));
  lookupFiles = (filepath, extensions = [], recursive = false) => {
    const files = [];
    let stat;
    if (!fs.existsSync(filepath)) {
      let pattern;
      if (hasMagicFallback(filepath)) {
        pattern = filepath;
      } else {
        const strExtensions = extensions
          .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
          .join("|");
        pattern = `${filepath}+(${strExtensions})`;
        debugFallback("looking for files using glob pattern: %s", pattern);
      }
      let matched = [];
      try {
        matched = fs.globSync(pattern, { withFileTypes: false });
      } catch (err) {
        debugFallback("fs.globSync failed for pattern %s: %O", pattern, err);
        matched = [];
      }
      matched = matched.filter((p) => {
        try {
          return !fs.statSync(p).isDirectory();
        } catch {
          return true;
        }
      });
      matched.sort((a, b) => a.localeCompare(b, "en"));
      files.push(...matched);
      if (!files.length)
        throw createNoFilesMatchPatternError(
          `Cannot find any files matching pattern "${filepath}"`,
          filepath,
        );
      return files;
    }
    try {
      stat = fs.statSync(filepath);
      if (stat.isFile() || stat.isFIFO()) return [filepath];
    } catch {
      return;
    }
    fs.readdirSync(filepath).forEach((dirent) => {
      const pathname = pathFallback.join(filepath, dirent);
      let s;
      try {
        s = fs.statSync(pathname);
        if (s.isDirectory()) {
          if (recursive)
            files.push(...lookupFiles(pathname, extensions, recursive));
          return;
        }
      } catch {
        return;
      }
      if (!extensions.length)
        throw createMissingArgumentError(
          `Argument '${extensions}' required when argument '${filepath}' is a directory`,
          "extensions",
          "array",
        );
      if (
        !s.isFile() ||
        !hasMatchingExtname(pathname, extensions) ||
        isHiddenOnUnix(pathname)
      )
        return;
      files.push(pathname);
    });
    return files;
  };
}
const { castArray } = require("../utils.cjs");

/**
 * Exports a function that collects test files from CLI parameters.
 * @see module:lib/cli/run-helpers
 * @see module:lib/cli/watch-run
 * @module
 * @private
 */

/**
 * @typedef {import('../types.d.ts').FileCollectionOptions} FileCollectionOptions
 * @typedef {import('../types.d.ts').FileCollectionResponse} FileCollectionResponse
 */

/**
 * Smash together an array of test files in the correct order
 * @param {FileCollectionOptions} [opts] - Options
 * @returns {FileCollectionResponse} An object containing a list of files to test and unmatched files.
 * @private
 */
module.exports = ({
  ignore,
  extension,
  file: fileArgs,
  recursive,
  sort,
  spec,
} = {}) => {
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

  // check that each file passed in to --file exists

  const unmatchedFiles = [];
  fileArgs.forEach((file) => {
    const fileAbsolutePath = path.resolve(file);
    try {
      // Used instead of fs.existsSync to ensure that file-ending less files are still resolved correctly
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

  // ensure we don't sort the stuff from fileArgs; order is important!
  if (sort) {
    specFiles.sort();
  }

  // add files given through --file to be ran first
  const files = [
    ...fileArgs.map((filepath) => path.resolve(filepath)),
    ...specFiles,
  ];
  debug("test files (in order): ", files);

  if (!files.length) {
    // give full message details when only 1 file is missing
    const noneFoundMsg =
      unmatchedSpecFiles.length === 1
        ? `Error: No test files found: ${JSON.stringify(
            unmatchedSpecFiles[0].pattern,
          )}` // stringify to print escaped characters raw
        : "Error: No test files found";
    console.error(pc.red(noneFoundMsg));
    process.exit(1);
  } else {
    // print messages as a warning
    unmatchedSpecFiles.forEach((warning) => {
      console.warn(pc.yellow(`Warning: ${warning.message}`));
    });
  }

  return {
    files,
    unmatchedFiles,
  };
};

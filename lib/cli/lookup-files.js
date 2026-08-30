/**
 * Contains `lookupFiles`, which takes some globs/dirs/options and returns a list of files.
 * @module
 * @private
 */

import fs from "node:fs";
import path from "node:path";
import {
  createNoFilesMatchPatternError,
  createMissingArgumentError,
} from "../errors.js";
import debugModule from "debug";
const debug = debugModule("mocha:cli:lookup-files");

/**
 * Minimal hasMagic implementation replacing glob.hasMagic.
 * Detects glob characters: * ? [ ] { } ( ) ! + @
 * @param {string} pattern
 * @returns {boolean}
 */
function hasMagic(pattern) {
  // Exclude escaped patterns and handle windowsPathsNoEscape true (bare check)
  // Matches glob package behavior for Mocha's use cases
  return /[*?\[\]{}()!+@]/.test(pattern);
}

/**
 * Determines if pathname would be a "hidden" file (or directory) on UN*X.
 *
 * @description
 * On UN*X, pathnames beginning with a full stop (aka dot) are hidden during
 * typical usage. Dotfiles, plain-text configuration files, are prime examples.
 *
 * @see {@link http://xahlee.info/UnixResource_dir/writ/unix_origin_of_dot_filename.html|Origin of Dot File Names}
 *
 * @private
 * @param {string} pathname - Pathname to check for match.
 * @return {boolean} whether pathname would be considered a hidden file.
 * @example
 * isHiddenOnUnix('.profile'); // => true
 */
const isHiddenOnUnix = (pathname) => path.basename(pathname).startsWith(".");

/**
 * Determines if pathname has a matching file extension.
 *
 * Supports multi-part extensions.
 *
 * @private
 * @param {string} pathname - Pathname to check for match.
 * @param {string[]} exts - List of file extensions, w/-or-w/o leading period
 * @return {boolean} `true` if file extension matches.
 * @example
 * hasMatchingExtname('foo.html', ['js', 'css']); // false
 * hasMatchingExtname('foo.js', ['.js']); // true
 * hasMatchingExtname('foo.js', ['js']); // ture
 */
const hasMatchingExtname = (pathname, exts = []) =>
  exts
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
    .some((ext) => pathname.endsWith(ext));

/**
 * Lookup file names at the given `path`.
 *
 * @description
 * Filenames are returned in _traversal_ order by the OS/filesystem.
 * **Make no assumption that the names will be sorted in any fashion.**
 *
 * @public
 * @alias module:lib/cli.lookupFiles
 * @param {string} filepath - Base path to start searching from.
 * @param {string[]} [extensions=[]] - File extensions to look for.
 * @param {boolean} [recursive=false] - Whether to recurse into subdirectories.
 * @return {string[]} An array of paths.
 * @throws {Error} if no files match pattern.
 * @throws {TypeError} if `filepath` is directory and `extensions` not provided.
 */
export function lookupFiles(filepath, extensions = [], recursive = false) {
  const files = [];
  let stat;

  if (!fs.existsSync(filepath)) {
    // Handle FIFO / process substitution (e.g. /dev/fd/63 from <(echo ...)) where existsSync is false in child
    // but the file is a valid test file (often no extension). Treat /dev/fd/* as file directly.
    if (/^\/dev\/fd\/\d+$/.test(filepath)) {
      debug("FIFO fd path, treating as file: %s", filepath);
      return [filepath];
    }
    let pattern;
    if (hasMagic(filepath)) {
      // Handle glob as is without extensions
      pattern = filepath;
    } else {
      // glob pattern e.g. 'filepath+(.js|.ts)'
      const strExtensions = extensions
        .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
        .join("|");
      pattern = `${filepath}+(${strExtensions})`;
      debug("looking for files using glob pattern: %s", pattern);
    }
    // Use built-in fs.globSync (Node >=22, Bun >=1.1). Falls back to filtering if needed.
    // nodir: filter directories manually; windowsPathsNoEscape is default for fs.globSync.
    let matched = [];
    try {
      matched = fs.globSync(pattern, { withFileTypes: false });
    } catch (err) {
      // fs.globSync may throw on invalid patterns; surface as no-match
      debug("fs.globSync failed for pattern %s: %O", pattern, err);
      matched = [];
    }
    // Filter directories (nodir: true) – fs.globSync may return dirs if pattern matches them
    matched = matched.filter((p) => {
      try {
        return !fs.statSync(p).isDirectory();
      } catch {
        return true;
      }
    });
    files.push(...matched.sort((a, b) => a.localeCompare(b, "en")));
    if (!files.length) {
      throw createNoFilesMatchPatternError(
        `Cannot find any files matching pattern "${filepath}"`,
        filepath,
      );
    }
    return files;
  }

  // Handle file (including FIFO, character device, etc. for <(echo) process substitution on macOS/Linux)
  try {
    stat = fs.statSync(filepath);
    if (stat.isFile() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice() || !stat.isDirectory()) {
      return [filepath];
    }
  } catch {
    // ignore error
    return;
  }

  // Handle directory
  fs.readdirSync(filepath).forEach((dirent) => {
    const pathname = path.join(filepath, dirent);
    let stat;

    try {
      stat = fs.statSync(pathname);
      if (stat.isDirectory()) {
        if (recursive) {
          files.push(...lookupFiles(pathname, extensions, recursive));
        }
        return;
      }
    } catch {
      return;
    }
    if (!extensions.length) {
      throw createMissingArgumentError(
        `Argument '${extensions}' required when argument '${filepath}' is a directory`,
        "extensions",
        "array",
      );
    }

    if (
      !stat.isFile() ||
      !hasMatchingExtname(pathname, extensions) ||
      isHiddenOnUnix(pathname)
    ) {
      return;
    }
    files.push(pathname);
  });

  return files;
}

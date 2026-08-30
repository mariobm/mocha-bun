"use strict";

// Auto-generated CJS version for Bun (original: errors.js)
const { format } = require("node:util");
let constants;
try {
  ({ constants } = require("./error-constants.cjs"));
} catch {
  ({ constants } = require("./error-constants.js"));
}
let isCI;
try {
  ({ isCI } = require("./utils.cjs"));
} catch {
  ({ isCI } = require("./utils.cjs"));
}

const MOCHA_ERRORS = new Set(Object.values(constants));

function createNoFilesMatchPatternError(message, pattern) {
  var err = new Error(message);
  err.code = constants.NO_FILES_MATCH_PATTERN;
  err.pattern = pattern;
  return err;
}
function createInvalidReporterError(message, reporter) {
  var err = new TypeError(message);
  err.code = constants.INVALID_REPORTER;
  err.reporter = reporter;
  return err;
}
function createInvalidInterfaceError(message, ui) {
  var err = new Error(message);
  err.code = constants.INVALID_INTERFACE;
  err.interface = ui;
  return err;
}
function createUnsupportedError(message) {
  var err = new Error(message);
  err.code = constants.UNSUPPORTED;
  return err;
}
function createMissingArgumentError(message, argument, expected) {
  return createInvalidArgumentTypeError(message, argument, expected);
}
function createInvalidArgumentTypeError(message, argument, expected) {
  var err = new TypeError(message);
  err.code = constants.INVALID_ARG_TYPE;
  err.argument = argument;
  err.expected = expected;
  err.actual = typeof argument;
  return err;
}
function createInvalidArgumentValueError(message, argument, value, reason) {
  var err = new TypeError(message);
  err.code = constants.INVALID_ARG_VALUE;
  err.argument = argument;
  err.value = value;
  err.reason = typeof reason !== "undefined" ? reason : "is invalid";
  return err;
}
function createInvalidExceptionError(message, value) {
  var err = new Error(message);
  err.code = constants.INVALID_EXCEPTION;
  err.valueType = typeof value;
  err.value = value;
  return err;
}
function createFatalError(message, value) {
  var err = new Error(message);
  err.code = constants.FATAL;
  err.valueType = typeof value;
  err.value = value;
  return err;
}
function createInvalidLegacyPluginError(message, pluginType, pluginId) {
  switch (pluginType) {
    case "reporter":
      return createInvalidReporterError(message, pluginId);
    case "ui":
      return createInvalidInterfaceError(message, pluginId);
    default:
      throw new Error('unknown pluginType "' + pluginType + '"');
  }
}
function createMochaInstanceAlreadyDisposedError(
  message,
  cleanReferencesAfterRun,
  instance,
) {
  var err = new Error(message);
  err.code = constants.INSTANCE_ALREADY_DISPOSED;
  err.cleanReferencesAfterRun = cleanReferencesAfterRun;
  err.instance = instance;
  return err;
}
function createMochaInstanceAlreadyRunningError(message, instance) {
  var err = new Error(message);
  err.code = constants.INSTANCE_ALREADY_RUNNING;
  err.instance = instance;
  return err;
}
function createMultipleDoneError(runnable, originalErr) {
  var title;
  try {
    title = format("<%s>", runnable.fullTitle());
    if (runnable.parent.root) {
      title += " (of root suite)";
    }
  } catch {
    title = format("<%s> (of unknown suite)", runnable.title);
  }
  var message = format(
    "done() called multiple times in %s %s",
    runnable.type ? runnable.type : "unknown runnable",
    title,
  );
  if (runnable.file) {
    message += format(" of file %s", runnable.file);
  }
  if (originalErr) {
    message += format("; in addition, done() received error: %s", originalErr);
  }
  var err = new Error(message);
  err.code = constants.MULTIPLE_DONE;
  err.valueType = typeof originalErr;
  err.value = originalErr;
  return err;
}
function createForbiddenExclusivityError(mocha) {
  var message;
  if (mocha.isWorker) {
    message = "`.only` is not supported in parallel mode";
  } else {
    message = "`.only` forbidden by --forbid-only";
    if (isCI()) {
      message += " (default in CI, add `--no-forbid-only` to allow `.only`)";
    }
  }
  var err = new Error(message);
  err.code = constants.FORBIDDEN_EXCLUSIVITY;
  return err;
}
function createInvalidPluginDefinitionError(msg, pluginDef) {
  const err = new Error(msg);
  err.code = constants.INVALID_PLUGIN_DEFINITION;
  err.pluginDef = pluginDef;
  return err;
}
function createInvalidPluginImplementationError(
  msg,
  { pluginDef, pluginImpl } = {},
) {
  const err = new Error(msg);
  err.code = constants.INVALID_PLUGIN_IMPLEMENTATION;
  err.pluginDef = pluginDef;
  err.pluginImpl = pluginImpl;
  return err;
}
function createTimeoutError(msg, timeout, file) {
  const err = new Error(msg);
  err.code = constants.TIMEOUT;
  err.timeout = timeout;
  err.file = file;
  return err;
}
function createUnparsableFileError(message) {
  var err = new Error(message);
  err.code = constants.UNPARSABLE_FILE;
  return err;
}
const isMochaError = (err) =>
  Boolean(err && typeof err === "object" && MOCHA_ERRORS.has(err.code));

module.exports = {
  createFatalError,
  createForbiddenExclusivityError,
  createInvalidArgumentTypeError,
  createInvalidArgumentValueError,
  createInvalidExceptionError,
  createInvalidInterfaceError,
  createInvalidLegacyPluginError,
  createInvalidPluginDefinitionError,
  createInvalidPluginImplementationError,
  createInvalidReporterError,
  createMissingArgumentError,
  createMochaInstanceAlreadyDisposedError,
  createMochaInstanceAlreadyRunningError,
  createMultipleDoneError,
  createNoFilesMatchPatternError,
  createTimeoutError,
  createUnparsableFileError,
  createUnsupportedError,
  isMochaError,
};

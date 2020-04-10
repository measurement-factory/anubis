const assert = require('assert');
const bunyan = require('bunyan');
const Config = require('../config/Config.js');

const Logger = bunyan.createLogger(Config.loggerParams());

function LogError(err, context) {
    Log(err, context, "error");
}

function LogException(err, context) {
    Log(err, context, "info");
}

function Log(err, context, kind) {
    assert(context);
    msg = context + ": ";
    // non-Error exceptions, like strings
    if (err.message === undefined) {
        msg += JSON.stringify(err);
    }
    else {
        if (err.stack !== undefined)
            msg += err.stack; // in Error, stack is prefixed with message
        else
            msg += err.message;
    }
    if (kind === "error")
        Logger.error(msg);
    else
        Logger.info(msg);
}

function logApiResult(method, params, result) {
    Logger.info(method, "OK, params:", JSON.stringify(params), "result:", JSON.stringify(result));
}

module.exports = {
    Logger: Logger,
    LogError: LogError,
    LogException: LogException,
    logApiResult: logApiResult
};


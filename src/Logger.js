const assert = require('assert');
const bunyan = require('bunyan');
const Config = require('./Config.js');

const Logger = bunyan.createLogger(Config.loggerParams());

function LogError(err, context) {
    Log(err, context, "error");
}

function LogExceptionMessage(err, context) {
    Log(err, context, "info");
}

function Log(err, context, kind) {
    assert(context);
    let msg = (err.message === undefined) ? JSON.stringify(err) : err.message;
    msg = context + ": " + msg;
    if (err.stack !== undefined)
        msg += " " + err.stack.toString();
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
    LogExceptionMessage: LogExceptionMessage,
    logApiResult: logApiResult
};


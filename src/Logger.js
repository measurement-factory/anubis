import assert from 'assert';
import bunyan from 'bunyan';
import Config from './Config.js';

export const Logger = bunyan.createLogger(Config.loggerParams());

export function LogError(err, context) {
    Log(err, context, "error");
}

export function LogException(err, context) {
    Log(err, context, "info");
}

export function Log(err, context, kind) {
    assert(context);
    let msg = context + ": ";
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

export function logApiResult(method, params, result) {
    Logger.info(method, "OK, params:", JSON.stringify(params), "result:", JSON.stringify(result));
}


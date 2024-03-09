const assert = require('assert');
const Config = require('./Config.js');

function sleep(msec) {
    return new Promise((resolve) => setTimeout(resolve, msec));
}

// common parameters for all API calls
function commonParams() {
    return {
        owner: Config.owner(),
        repo: Config.repo()
    };
}

const PrNumberRegex = / \(#(\d+)\)$/;

function ParsePrNumber(prMessage) {
    assert(prMessage);
    const lines = prMessage.split(/\r*\n/);
    const matched = lines[0].match(PrNumberRegex);
    if (!matched)
        return null;
    const prNumber = matched[1];
    assert(prNumber > 0);
    return prNumber;
}

function DateForDaysAgo(days) {
    let d = new Date();
    d.setDate(d.getDate() - days);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0'); //January is 0!
    const yyyy = d.getFullYear();
    return yyyy + '-' + mm + '-' + dd;
}

// An error context for promisificated wrappers.
class ErrorContext extends Error {
    // The underlying rejection may be a bot-specific Promise.reject() or
    // be caused by a GitHub API error, so 'err' contains either
    // an error string or the entire API error object.
    constructor(err, method, args) {
        assert(err);
        let msg = "";
        if (method !== undefined)
            msg = method + ", ";
        msg += "Error: " + JSON.stringify(err);
        if (args !== undefined)
            msg += ", params: " + JSON.stringify(args);
        super(msg);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
        this._err = err;
    }

    // 404 (Not found)
    notFound() {
        if (this._err.name === "HttpError")
            return this._err.code === 404;
        // We treat our local(non-API) promise rejections as
        // if the requested resource was 'not found'.
        // TODO: rework if this simple approach does not work.
        return true;
    }

    // 422 (unprocessable entity).
    // E.g., fast-forward failure returns this error.
    unprocessable() {
        if (this._err.name === "HttpError")
            return this._err.code === 422;
        return false;
    }
}

module.exports = {
    sleep: sleep,
    commonParams: commonParams,
    ParsePrNumber: ParsePrNumber,
    ErrorContext: ErrorContext,
    DateForDaysAgo: DateForDaysAgo
};


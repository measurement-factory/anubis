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

const TagRegex = /(refs\/)(tags\/.*-PR)(\d+)$/;

function MatchTag(ref) {
    return ref.match(TagRegex) !== null;
}

function ParseTag(ref) {
    const matched = ref.match(TagRegex);
    if (!matched)
        return null;
    return matched[3];
}

function StagingTag(prNum) {
    assert(prNum);
    return "tags/M-staged-PR" + prNum;
}

// An error context for promisificated wrappers.
class ErrorContext extends Error {
    // The underlying rejection may be a bot-specific Promise.reject() or
    // be caused by a GitHub API error, so 'err' contains either
    // an error string or the entire API error object.
    constructor(err, method, args) {
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
        if (Object.getPrototypeOf(this._err) === Object.prototype) {
            if ('code' in this._err)
                return this._err.code === 404;
        }
        // We treat our local(non-API) promise rejections as
        // if the requested resource was 'not found'.
        // TODO: rework if this simple approach does not work.
        return true;
    }

    // 422 (unprocessable entity).
    // E.g., fast-forward failure returns this error.
    unprocessable() {
        if (Object.getPrototypeOf(this._err) === Object.prototype) {
            if ('code' in this._err)
                return this._err.code === 422;
        }
        return false;
    }
}

module.exports = {
    sleep: sleep,
    commonParams: commonParams,
    StagingTag: StagingTag,
    MatchTag: MatchTag,
    ParseTag: ParseTag,
    ErrorContext: ErrorContext
};


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

// Identifies or refers to a PR using either
// PR number, or
// PR branch name (without 'refs' or 'heads' prefixes), or
// staging branch commit SHA (including stale commits).
class PrId
{
    constructor(type, val, msg) {
        assert(type !== undefined);
        assert(type !== null);
        assert(val !== undefined);
        assert(val !== null);
        this.type = type; // a PR identificator type ("branch", "sha" or "prNum")
        this.value = val; // a PR identificator
        this.message = (msg === undefined) ? null : msg; // the commit message or null
    }

    static BranchList(branches, msg) { return Array.from(branches, b => new PrId("branch", b, msg)); }
    static Sha(sha) { return [new PrId("sha", sha)]; }
    static PrNum(prNum) { return [new PrId("prNum", prNum.toString())]; }
    static PrNumList(list) { return Array.from(list, prNum => new PrId("prNum", prNum.toString())); }

    toString() { return `${this.type}:${this.value}`; }
}

module.exports = {
    sleep: sleep,
    commonParams: commonParams,
    ParsePrNumber: ParsePrNumber,
    ErrorContext: ErrorContext,
    PrId: PrId,
};


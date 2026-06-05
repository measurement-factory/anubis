import Config from './Config.js';

import assert from 'assert';

export function sleep(msec) {
    return new Promise((resolve) => setTimeout(resolve, msec));
}

// common parameters for all API calls
export function commonParams() {
    return {
        owner: Config.owner(),
        repo: Config.repo()
    };
}

const PrNumberRegex = / \(#(\d+)\)$/;

// this regex is applied to individual PR title and description lines, so we do not need to allow LF
export const ProhibitedCommitMessageLineCharacters = new RegExp("[^\u{20}-\u{7e}]", "u");

export function ParsePrNumber(prMessage) {
    assert(prMessage);
    const lines = prMessage.split(/\r*\n/);
    const matched = lines[0].match(PrNumberRegex);
    if (!matched)
        return null;
    const prNumber = parseInt(matched[1], 10);
    assert(!isNaN(prNumber));
    assert(prNumber > 0);
    return prNumber;
}

// Identifies or refers to a PR using either
// PR number, or
// PR branch name (without 'refs' or 'heads' prefixes), or
// staging branch commit SHA (including stale commits).
export class PrId
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
    static PrNum(prNum) { return [new PrId("prNum", prNum)]; }
    static PrNumList(list) { return Array.from(list, prNum => new PrId("prNum", prNum)); }

    toString() { return `${this.type}:${this.value}`; }
}


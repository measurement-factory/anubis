const assert = require('assert');
const Config = require('./Config.js');
const { Octokit }  = require("@octokit/rest");
const GitHub = new Octokit({
    auth: Config.githubToken(),
    request: {
        agent: undefined,
        fetch: undefined,
        timeout: Config.requestTimeout(),
    },
    baseUrl: 'https://api.github.com'
});
const Util = require('./Util.js');
const Log = require('./Logger.js');

const ErrorContext = Util.ErrorContext;
const commonParams = Util.commonParams;
const logApiResult = Log.logApiResult;

// Calculates the artificial delay for an API call (in milliseconds).
// This delay is required to overcome the "API rate limit exceeded" GitHub error for
// "core" (non-search) API calls. The current GitHub limitation is 5000/hour,
// as documented at https://docs.github.com/en/rest/reference/rate-limit.
function calculateRateLimitDelay(headers) {
    if (headers["x-ratelimit-resource"] !== "core")
        return 0;
    const used = parseInt(headers["x-ratelimit-used"]);
    // Optimization: Do not delay the first 20% of the requests.
    // This avoids most artificial delays for less busy projects while
    // keeping the remaining delays small enough for the busiest ones.
    const limit = parseInt(headers["x-ratelimit-limit"]);
    if (used < limit/5)
        return 0;
    const resetTime = parseInt(headers["x-ratelimit-reset"]) * 1000;
    const now = Date.now();
    if (resetTime <= now) {
        Log.Logger.info("stale x-ratelimit-reset value: " +  resetTime + '<=' + now);
        return 0;
    }
    const remaining = parseInt(headers["x-ratelimit-remaining"]);
    const delay = Math.round((resetTime - now)/remaining);
    Log.Logger.info("calculateRateLimitDelay: " +  delay + "(ms), used: " + used + " out of " + limit);
    return delay;
}

async function rateLimitedPromise(result) {
    const ms = calculateRateLimitDelay(result.headers);
    if (ms) {
        await Util.sleep(ms);
    }
    return result.data;
}

async function paginatedGet(githubMethod, params) {
    const iterator = GitHub.paginate.iterator(githubMethod, params);
    let result = [];
    for await (let it of iterator) {
       const data = await rateLimitedPromise(it);
       result.push(...data);
    }
    return result;
}

async function getOpenPrs() {
    let params = commonParams();

    let data = await paginatedGet(GitHub.rest.pulls.list, params);
    logApiResult(getOpenPrs.name, params, {PRs: data.length});
    for (let pr of data)
       pr.anubisProcessor = null;
    return data;
}

async function getLabels(prNum) {
    let params = commonParams();
    params.issue_number = prNum;

    const result = await GitHub.rest.issues.listLabelsOnIssue(params);
    logApiResult(getLabels.name, params, {labels: result.data.length});
    return await rateLimitedPromise(result)
}

// Gets PR metadata from GitHub
// If requested and needed, retries until GitHub calculates PR mergeable flag.
// Those retries, if any, are limited to a few minutes.
async function getPR(prNum, awaitMergeable) {
    const max = 64 * 1000 + 1; // ~2 min. overall
    for (let d = 1000; d < max; d *= 2) {
        const pr = await getRawPR(prNum);
        // pr.mergeable is useless (and not calculated?) for a closed PR
        if (pr.mergeable !== null || pr.state === 'closed' || !awaitMergeable)
            return pr;
        Log.Logger.info("PR" + prNum + ": GitHub still calculates mergeable attribute. Will retry in " + (d/1000) + " seconds");
        await Util.sleep(d);
    }
    return Promise.reject(new ErrorContext("Timed out waiting for GitHub to calculate mergeable attribute",
                getPR.name, {pr: prNum}));
}

// gets a PR from GitHub (as is)
async function getRawPR(prNum) {
    let params = commonParams();
    params.pull_number = prNum;

    const result = await GitHub.rest.pulls.get(params);
    logApiResult(getRawPR.name, params, {number: result.data.number});
    return await rateLimitedPromise(result);
}

async function getReviews(prNum) {
    let params = commonParams();
    params.pull_number = prNum;

    const reviews = await paginatedGet(GitHub.rest.pulls.listReviews, params);
    logApiResult(getReviews.name, params, {reviews: reviews.length});
    return reviews;
}

async function getCheckRuns(ref) {
    let params = commonParams();
    params.ref = ref;

    const checkRuns = await paginatedGet(GitHub.rest.checks.listForRef, params);
    logApiResult(getCheckRuns.name, params, {checkRuns: checkRuns.length});
    return checkRuns;
}

async function getStatuses(ref) {
    let params = commonParams();
    params.ref = ref;

    const result = await GitHub.rest.repos.getCombinedStatusForRef(params);
    logApiResult(getStatuses.name, params, {statuses: result.data.statuses.length});
    return await rateLimitedPromise(result);
}

async function getCommit(sha) {
    let params = commonParams();
    params.commit_sha = sha;

    const result = await GitHub.rest.git.getCommit(params);
    logApiResult(getCommit.name, params, result.data);
    return await rateLimitedPromise(result);
}

async function createCommit(treeSha, message, parents, author, committer) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.tree = treeSha;
    params.message = message;
    params.parents = parents;
    params.author = author;
    params.committer = committer;

    const result = await GitHub.rest.git.createCommit(params);
    logApiResult(createCommit.name, params, {sha: result.data.sha});
    return await rateLimitedPromise(result);
}

// returns one of: "ahead", "behind", "identical" or "diverged"
async function compareCommits(baseRef, headRef) {
    let params = commonParams();
    params.basehead = `${baseRef}...${headRef}`;

    const result = await GitHub.rest.repos.compareCommitsWithBasehead(params);
    logApiResult(compareCommits.name, params, {status: result.data.status});
    return (await rateLimitedPromise(result)).status;
}

async function getCommits(branch, since) {
    let params = commonParams();
    params.sha = branch; // sha or branch to start listing commits from
    params.since = since;

    const commits = await paginatedGet(GitHub.rest.repos.listCommits, params);
    logApiResult(getCommits.name, params, {commits: commits.length});
    return commits;
}

async function getReference(ref) {
    let params = commonParams();
    params.ref = ref;

    const result = await GitHub.rest.git.getRef(params);
    logApiResult(getReference.name, params, {ref: result.data.ref, sha: result.data.object.sha});
    return (await rateLimitedPromise(result)).object.sha;
}

async function updateReference(ref, sha, force) {
    assert(!Config.dryRun());
    assert((ref === Config.stagingBranchPath()) || !Config.stagedRun());

    let params = commonParams();
    params.ref = ref;
    params.sha = sha;
    params.force = force; // default (ensure we do ff merge).

    const result = await GitHub.rest.git.updateRef(params);
    logApiResult(updateReference.name, params, {ref: result.data.ref, sha: result.data.object.sha});
    return await rateLimitedPromise(result);
}


async function updatePR(prNum, state) {
    assert(!Config.dryRun());

    let params = commonParams();
    params.state = state;
    params.pull_number = prNum;

    const result = await GitHub.rest.pulls.update(params);
    logApiResult(updatePR.name, params, {state: result.data.state});
    return await rateLimitedPromise(result);
}

async function addLabels(params) {
    assert(!Config.dryRun());

    const result = await GitHub.rest.issues.addLabels(params);
    logApiResult(addLabels.name, params, {added: true});
    return await rateLimitedPromise(result);
}

async function removeLabel(label, prNum) {
    assert(!Config.dryRun());

    let params = commonParams();
    params.issue_number = prNum;
    params.name = label;

    const result = await GitHub.rest.issues.removeLabel(params);
    logApiResult(removeLabel.name, params, {removed: true});
    return await rateLimitedPromise(result);
}

// XXX: remove if not needed, since the "required_status_checks" api call sometimes
// does not work(?) for organization repositories (returns 404 Not Found).
//async function getProtectedBranchRequiredStatusChecks(branch) {
//    let params = commonParams();
//    params.branch = branch;
//    const promise = new Promise( (resolve, reject) => {
//      GitHub.authenticate(GitHubAuthentication);
//      GitHub.repos.getProtectedBranchRequiredStatusChecks(params, (err, res) => {
//          if (err) {
//             reject(new ErrorContext(err, getProtectedBranchRequiredStatusChecks.name, params));
//             return;
//          }
//          const result = {checks: res.data.contexts.length};
//          logApiResult(getProtectedBranchRequiredStatusChecks.name, params, result);
//          resolve(res);
//      });
//    return (await rateLimitedPromise(promise)).contexts;
//    });
//}

async function createStatus(sha, state, targetUrl, description, context) {
    assert(!Config.dryRun());

    let params = commonParams();
    params.sha = sha;
    params.state = state;
    params.target_url = targetUrl;
    params.description = description;
    params.context = context;

    const result = await GitHub.rest.repos.createCommitStatus(params);
    logApiResult(createStatus.name, params, {context: result.data.context});
    return (await rateLimitedPromise(result)).context;
}

async function getProtectedBranchRequiredStatusChecks(branch) {
    let params = commonParams();
    params.branch = branch;

    const result = await GitHub.rest.repos.getBranch(params);
    logApiResult(getProtectedBranchRequiredStatusChecks.name, params, {checks: result.data.protection.required_status_checks.contexts.length});
    return (await rateLimitedPromise(result)).protection.required_status_checks.contexts;
}

async function getUser(username) {
    const params = commonParams();
    params.username = username;

    const result = await GitHub.rest.users.getByUsername(params);
    logApiResult(getUser.name, params, {user: result.data});
    return await rateLimitedPromise(result);
}

async function getUserEmails() {
    const params = commonParams();

    const result = await GitHub.rest.users.listEmailsForAuthenticatedUser(params);
    logApiResult(getUserEmails.name, params, {emails: result.data});
    return await rateLimitedPromise(result);
}

module.exports = {
    getOpenPrs: getOpenPrs,
    getLabels: getLabels,
    getPR: getPR,
    getReviews: getReviews,
    getStatuses: getStatuses,
    getCheckRuns: getCheckRuns,
    getCommit: getCommit,
    getCommits: getCommits,
    createCommit: createCommit,
    compareCommits: compareCommits,
    getReference: getReference,
    updateReference: updateReference,
    updatePR: updatePR,
    addLabels: addLabels,
    removeLabel: removeLabel,
    createStatus: createStatus,
    getProtectedBranchRequiredStatusChecks: getProtectedBranchRequiredStatusChecks,
    getUser: getUser,
    getUserEmails: getUserEmails
};


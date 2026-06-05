import * as Log from './Logger.js';
import * as Util from './Util.js';
import Config from './Config.js';

import assert from 'assert';
import { Octokit } from "@octokit/rest";

const GitHub = new Octokit({
    auth: Config.githubToken(),
    request: {
        agent: undefined,
        fetch: undefined,
        timeout: Config.requestTimeout(),
    },
    baseUrl: Config.baseUrl()
});
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
        Log.Logger.info("stale x-ratelimit-reset value: " + resetTime + '<=' + now);
        return 0;
    }
    const remaining = parseInt(headers["x-ratelimit-remaining"]);
    const delay = Math.round((resetTime - now)/remaining);
    Log.Logger.info("calculateRateLimitDelay: " + delay + "(ms), used: " + used + " out of " + limit);
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

export async function getOpenPrs() {
    let params = commonParams();

    let data = await paginatedGet(GitHub.rest.pulls.list, params);
    logApiResult(getOpenPrs.name, params, {PRs: data.length});
    for (let pr of data)
       pr.anubisProcessor = null;
    return data;
}

export async function getLabels(prNum) {
    let params = commonParams();
    params.issue_number = prNum;

    const result = await GitHub.rest.issues.listLabelsOnIssue(params);
    logApiResult(getLabels.name, params, {labels: result.data.length});
    return await rateLimitedPromise(result);
}

/// For waitFor() code to signal that more iterations are needed
const TryAgain = Symbol("TryAgain");

// (Re)runs `code` while it returns a TryAgain value, waiting between retries.
// Meant for `code` that makes GitHub API call(s) that may not succeed on the
// first try.
async function waitFor(description, code) {
    // this limits total wait time to about 2 minutes
    const singleWaitMax = 64; // seconds
    for (let singleWait = 1; singleWait <= singleWaitMax; singleWait *= 2) {
        const result = await code();
        if (result !== TryAgain) {
            Log.Logger.info(`Done waiting for ${description}`);
            return result;
        }
        Log.Logger.info(`Still waiting for ${description}. Will retry in ${singleWait} seconds`);
        await Util.sleep(singleWait*1000);
    }
    throw new Error(`Timed out waiting for ${description}`);
}

// Gets PR metadata from GitHub
// If requested and needed, retries until GitHub calculates PR mergeable flag.
// Those retries, if any, are limited to a few minutes.
export async function getPR(prNum, awaitMergeable) {
    return await waitFor('GitHub to calculate mergeable attribute', async () => {
        const pr = await getRawPR(prNum);
        // pr.mergeable is useless (and not calculated?) for a closed PR
        if (pr.mergeable !== null || pr.state === 'closed' || !awaitMergeable)
            return pr;
        return TryAgain;
    });
}

// gets a PR from GitHub (as is)
async function getRawPR(prNum) {
    let params = commonParams();
    params.pull_number = prNum;

    const result = await GitHub.rest.pulls.get(params);
    logApiResult(getRawPR.name, params, {number: result.data.number});
    return await rateLimitedPromise(result);
}

export async function getReviews(prNum) {
    let params = commonParams();
    params.pull_number = prNum;

    const reviews = await paginatedGet(GitHub.rest.pulls.listReviews, params);
    logApiResult(getReviews.name, params, {reviews: reviews.length});
    return reviews;
}

export async function getCheckRuns(ref) {
    let params = commonParams();
    params.ref = ref;

    const checkRuns = await paginatedGet(GitHub.rest.checks.listForRef, params);
    logApiResult(getCheckRuns.name, params, {checkRuns: checkRuns.length});
    return checkRuns;
}

export async function getStatuses(ref) {
    let params = commonParams();
    params.ref = ref;

    const result = await GitHub.rest.repos.getCombinedStatusForRef(params);
    logApiResult(getStatuses.name, params, {statuses: result.data.statuses.length});
    return await rateLimitedPromise(result);
}

export async function getCommit(sha) {
    let params = commonParams();
    params.commit_sha = sha;

    const result = await GitHub.rest.git.getCommit(params);
    logApiResult(getCommit.name, params, result.data);
    return await rateLimitedPromise(result);
}

export async function createCommit(treeSha, message, parents, author, committer) {
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
export async function compareCommits(baseRef, headRef) {
    let params = commonParams();
    params.basehead = `${baseRef}...${headRef}`;

    const result = await GitHub.rest.repos.compareCommitsWithBasehead(params);
    logApiResult(compareCommits.name, params, {status: result.data.status});
    return (await rateLimitedPromise(result)).status;
}

export async function getCommits(branch, since) {
    let params = commonParams();
    params.sha = branch; // sha or branch to start listing commits from
    params.since = since;

    const commits = await paginatedGet(GitHub.rest.repos.listCommits, params);
    logApiResult(getCommits.name, params, {commits: commits.length});
    return commits;
}

export async function getReference(ref) {
    let params = commonParams();
    params.ref = ref;

    const result = await GitHub.rest.git.getRef(params);
    logApiResult(getReference.name, params, {ref: result.data.ref, sha: result.data.object.sha});
    return (await rateLimitedPromise(result)).object.sha;
}

export async function updateReference(ref, sha, force) {
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


export async function updatePR(prNum, state) {
    assert(!Config.dryRun());

    let params = commonParams();
    params.state = state;
    params.pull_number = prNum;

    const result = await GitHub.rest.pulls.update(params);
    logApiResult(updatePR.name, params, {state: result.data.state});
    return await rateLimitedPromise(result);
}

export async function addLabels(params) {
    assert(!Config.dryRun());

    const result = await GitHub.rest.issues.addLabels(params);
    logApiResult(addLabels.name, params, {added: true});
    return await rateLimitedPromise(result);
}

export async function removeLabel(label, prNum) {
    assert(!Config.dryRun());

    let params = commonParams();
    params.issue_number = prNum;
    params.name = label;

    const result = await GitHub.rest.issues.removeLabel(params);
    logApiResult(removeLabel.name, params, {removed: true});
    return await rateLimitedPromise(result);
}

export async function createComment(prNum, comment) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.issue_number = prNum;
    params.body = comment;

    const result = await GitHub.rest.issues.createComment(params);
    logApiResult(createComment.name, params, {created: true});
    return await rateLimitedPromise(result);
}

export async function getComments(prNum) {
    let params = commonParams();
    params.issue_number = prNum;

    const comments = await paginatedGet(GitHub.rest.issues.listComments, params);
    logApiResult(getComments.name, params, {comments: comments.length});
    return comments;
}

export async function createStatus(sha, state, targetUrl, description, context) {
    assert(!Config.dryRun());

    let params = commonParams();
    params.sha = sha;
    params.state = state;
    params.target_url = targetUrl;
    params.description = description;
    params.context = context;

    const result = await GitHub.rest.repos.createCommitStatus(params);
    logApiResult(createStatus.name, params, {context: result.data.context});
    await rateLimitedPromise(result);

    const checkParams = commonParams();
    checkParams.ref = sha;
    await waitFor(`GitHub to create ${context} status for the ${sha} commit`, async () => {
        const checkResult = await GitHub.rest.repos.getCombinedStatusForRef(checkParams);
        await rateLimitedPromise(checkResult);
        const statuses = checkResult.data.statuses;
        if (statuses.some(st => st.context === context))
            return statuses;
        return TryAgain;
    });

    return result.data.context;
}

export async function getProtectedBranchRequiredStatusChecks(branch) {
    let params = commonParams();
    params.branch = branch;

    const result = await GitHub.rest.repos.getBranch(params);
    logApiResult(getProtectedBranchRequiredStatusChecks.name, params, {checks: result.data.protection.required_status_checks.contexts.length});
    return (await rateLimitedPromise(result)).protection.required_status_checks.contexts;
}

export async function getUser(username) {
    const params = commonParams();
    params.username = username;

    const result = await GitHub.rest.users.getByUsername(params);
    logApiResult(getUser.name, params, {user: result.data});
    return await rateLimitedPromise(result);
}

export async function getUserEmails() {
    const params = commonParams();

    const result = await GitHub.rest.users.listEmailsForAuthenticatedUser(params);
    logApiResult(getUserEmails.name, params, {emails: result.data});
    return await rateLimitedPromise(result);
}


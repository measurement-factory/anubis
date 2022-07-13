const assert = require('assert');
const Config = require('./Config.js');
const GitHub = require('@octokit/rest')({
    timeout: Config.requestTimeout(),
    host: 'api.github.com',
    version: '3.0.0'
});
const Util = require('./Util.js');
const Log = require('./Logger.js');

const ErrorContext = Util.ErrorContext;
const commonParams = Util.commonParams;
const logApiResult = Log.logApiResult;

const GitHubAuthentication = { type: 'token', username: Config.githubUserLogin(), token: Config.githubToken() };

function defaultAppender(allPages, aPage) {
    allPages.data = allPages.data.concat(aPage.data);
}

function statusAppender(statusPages, aPage) {
    let statuses = statusPages.data.statuses;
    statusPages.data.statuses = statuses.concat(aPage.data.statuses);
}

function protectedBranchAppender(protectedBranchPages, aPage) {
    let contexts = protectedBranchPages.data.protection.required_status_checks.contexts;
    protectedBranchPages.data.protection.required_status_checks.contexts =
        contexts.concat(aPage.data.protection.required_status_checks.contexts);
}

// Calculates the artificial delay for an API call (in milliseconds).
// This delay is required to overcome the "API rate limit exceeded" GitHub error for
// "core" (non-search) API calls. The current GitHub limitation is 5000/hour,
// as documented at https://docs.github.com/en/rest/reference/rate-limit.
function calculateRateLimitDelay(result) {
    if (result.meta["x-ratelimit-resource"] !== "core")
        return 0;
    const used = parseInt(result.meta["x-ratelimit-used"]);
    // Optimization: Do not delay the first 20% of the requests.
    // This avoids most artificial delays for less busy projects while
    // keeping the remaining delays small enough for the busiest ones.
    const limit = parseInt(result.meta["x-ratelimit-limit"]);
    if (used < limit/5)
        return 0;
    const resetTime = parseInt(result.meta["x-ratelimit-reset"]) * 1000;
    const now = Date.now();
    if (resetTime <= now) {
        Log.Logger.info("stale x-ratelimit-reset value: " +  resetTime + '<=' + now);
        return 0;
    }
    const remaining = parseInt(result.meta["x-ratelimit-remaining"]);
    const delay = Math.round((resetTime - now)/remaining);
    Log.Logger.info("calculateRateLimitDelay: " +  delay + "(ms), used: " + used + " out of " + limit);
    return delay;
}

async function rateLimitedPromise(promise) {
    const result = await promise;
    const ms = calculateRateLimitDelay(result);
    if (ms) {
        await Util.sleep(ms);
    }
    return result.data;
}

async function pager(firstPage, appender) {
    assert(firstPage);

    let allPages = null;
    if (appender === undefined)
        appender = defaultAppender;

    function doPager (nPage) {
        if (allPages === null)
            allPages = nPage;
        else
            appender(allPages, nPage);

       if (GitHub.hasNextPage(nPage)) {
            return GitHub.getNextPage(nPage).then(doPager);
       }
       return allPages;
    }
    return await doPager(firstPage);
}

async function getOpenPrs() {
    const params = commonParams();
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.getAll(params, async (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getOpenPrs.name, params));
                return;
            }
            res = await pager(res);
            const result = res.data.length;
            logApiResult(getOpenPrs.name, params, result);
            for (let pr of res.data)
                pr.anubisProcessor = null;
            resolve(res);
        });
    });
    return await rateLimitedPromise(promise);
}

async function getLabels(prNum) {
    let params = commonParams();
    params.number = prNum;
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.issues.getIssueLabels(params, (err, res) => {
           if (err) {
               reject(new ErrorContext(err, getLabels.name, params));
               return;
           }
           const result = {labels: res.data.length};
           logApiResult(getLabels.name, params, result);
           resolve(res);
        });
    });
    return await rateLimitedPromise(promise);
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
    params.number = prNum;
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.get(params, (err, pr) => {
            if (err) {
                reject(new ErrorContext(err, getRawPR.name, params));
                return;
            }
            const result = {number: pr.data.number};
            logApiResult(getRawPR.name, params, result);
            resolve(pr);
       });
    });
    return await rateLimitedPromise(promise);
}

async function getReviews(prNum) {
    let params = commonParams();
    params.number = prNum;
    const promise = new Promise((resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.getReviews(params, async (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getReviews.name, params));
                return;
            }
            res = await pager(res);
            resolve(res);
        });
    });
    return await rateLimitedPromise(promise);
}

async function getStatuses(ref) {
    let params = commonParams();
    params.ref = ref;
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.repos.getCombinedStatusForRef(params, async (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getStatuses.name, params));
                return;
            }
            res = await pager(res, statusAppender);
            logApiResult(getStatuses.name, params, {statuses: res.data.statuses.length});
            assert(res.data.state === 'success' || res.data.state === 'pending' || res.data.state === 'failure');
            resolve(res);
        });
    });
    return await rateLimitedPromise(promise);
}

async function getCommit(sha) {
    let params = commonParams();
    params.sha = sha;
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.getCommit(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getCommit.name, params));
                return;
            }
            logApiResult(getCommit.name, params, res.data);
            resolve(res);
        });
    });
    return await rateLimitedPromise(promise);
}

async function createCommit(treeSha, message, parents, author, committer) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.tree = treeSha;
    params.message = message;
    params.parents = parents;
    params.author = author;
    params.committer = committer;
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.createCommit(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, createCommit.name, params));
                return;
            }
            const result = {sha: res.data.sha};
            logApiResult(createCommit.name, params, result);
            resolve(res);
        });
    });
    return await rateLimitedPromise(promise);
}

// returns one of: "ahead", "behind", "identical" or "diverged"
async function compareCommits(baseRef, headRef) {
    let params = commonParams();
    params.base = baseRef;
    params.head = headRef;
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.repos.compareCommits(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, compareCommits.name, params));
                return;
            }
            const result = {status: res.data.status};
            logApiResult(compareCommits.name, params, result);
            resolve(res);
        });
    });
    return (await rateLimitedPromise(promise)).status;
}

async function getCommits(branch, since) {
    let params = commonParams();
    params.sha = branch; // sha or branch to start listing commits from
    params.since = since;
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.repos.getCommits(params, async (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getCommits.name, params));
                return;
            }
            res = await pager(res);
            const result = {commits: res.data.length};
            logApiResult(getCommits.name, params, result);
            resolve(res);
        });
    });
    return await rateLimitedPromise(promise);
}

async function getReference(ref) {
    let params = commonParams();
    params.ref = ref;
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.getReference(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getReference.name, params));
                return;
            }
            // If the requested ref does not exist in the repository, but some
            // existing refs start with it, they will be returned as an array.
            if (Array.isArray(res.data)) {
                reject(new ErrorContext("Could not find " + params.ref + " reference", getReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logApiResult(getReference.name, params, result);
            resolve(res);
        });
    });
    return (await rateLimitedPromise(promise)).object.sha;
}

async function updateReference(ref, sha, force) {
    assert(!Config.dryRun());
    assert((ref === Config.stagingBranchPath()) || !Config.stagedRun());

    let params = commonParams();
    params.ref = ref;
    params.sha = sha;
    params.force = force; // default (ensure we do ff merge).
    const promise = new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.updateReference(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, updateReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logApiResult(updateReference.name, params, result);
            resolve(res);
       });
    });
    return (await rateLimitedPromise(promise)).object.sha;
}

async function updatePR(prNum, state) {
   assert(!Config.dryRun());
   let params = commonParams();
   params.state = state;
   params.number = prNum;
   const promise = new Promise( (resolve, reject) => {
     GitHub.authenticate(GitHubAuthentication);
     GitHub.pullRequests.update(params, (err, res) => {
        if (err) {
            reject(new ErrorContext(err, updatePR.name, params));
            return;
        }
        const result = {state: res.data.state};
        logApiResult(updatePR.name, params, result);
        resolve(res);
     });
   });
   return await rateLimitedPromise(promise);
}

async function addLabels(params) {
   assert(!Config.dryRun());
   const promise = new Promise( (resolve, reject) => {
     GitHub.authenticate(GitHubAuthentication);
     GitHub.issues.addLabels(params, (err, res) => {
        if (err) {
            reject(new ErrorContext(err, addLabels.name, params));
            return;
        }
        const result = {added: true};
        logApiResult(addLabels.name, params, result);
        resolve(res);
     });
   });
   return await rateLimitedPromise(promise);
}

async function removeLabel(label, prNum) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.number = prNum;
    params.name = label;
    const promise = new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.issues.removeLabel(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, removeLabel.name, params));
             return;
          }
          const result = {removed: true};
          logApiResult(removeLabel.name, params, result);
          resolve(res);
      });
    });
    return await rateLimitedPromise(promise);
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
    const promise = new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.createStatus(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, createStatus.name, params));
             return;
          }
          const result = {context: res.data.context};
          logApiResult(createStatus.name, params, result);
          resolve(res);
        });
    });
    return (await rateLimitedPromise(promise)).context;
}

async function getProtectedBranchRequiredStatusChecks(branch) {
    let params = commonParams();
    params.branch = branch;
    const promise = new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.getBranch(params, async (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getProtectedBranchRequiredStatusChecks.name, params));
             return;
          }
          res = await pager(res, protectedBranchAppender);
          const result = {checks: res.data.protection.required_status_checks.contexts.length};
          logApiResult(getProtectedBranchRequiredStatusChecks.name, params, result);
          resolve(res);
      });
    });
    return (await rateLimitedPromise(promise)).protection.required_status_checks.contexts;
}

async function getUser(username) {
    const params = commonParams();
    params.username = username;
    const promise = new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.users.getForUser(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getUser.name, params));
             return;
          }
          const result = {user: res.data};
          logApiResult(getUser.name, params, result);
          resolve(res);
      });
    });
    return await rateLimitedPromise(promise);
}

async function getUserEmails() {
    const params = commonParams();
    const promise = new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.users.getEmails(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getUserEmails.name, params));
             return;
          }
          const result = {emails: res.data};
          logApiResult(getUserEmails.name, params, result);
          resolve(res);
      });
    });
    return await rateLimitedPromise(promise);
}

module.exports = {
    getOpenPrs: getOpenPrs,
    getLabels: getLabels,
    getPR: getPR,
    getReviews: getReviews,
    getStatuses: getStatuses,
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


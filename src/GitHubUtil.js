const assert = require('assert');
const GitHub = require('@octokit/rest')({
    host: 'api.github.com',
    version: '3.0.0'
});
const Config = require('./Config.js');
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

async function pager(firstPage, appender) {
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

function getPRList() {
    const params = commonParams();
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.getAll(params, async (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getPRList.name, params));
                return;
            }
            res = await pager(res);
            const result = res.data.length;
            logApiResult(getPRList.name, params, result);
            resolve(res.data);
        });
    });
}

function getLabels(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.issues.getIssueLabels(params, (err, res) => {
           if (err) {
               reject(new ErrorContext(err, getLabels.name, params));
               return;
           }
           const result = {labels: res.data.length};
           logApiResult(getLabels.name, params, result);
           resolve(res.data);
        });
    });
}

// Gets a PR from GitHub, waiting for a period until GitHub calculates
// it's 'mergeable' flag. Afther the period, returns the PR as is.
async function getPR(prNum, awaitMergeable) {
    const max = 64 * 1000 + 1; // ~2 min. overall
    for (let d = 1000; d < max; d *= 2) {
        const pr = await getRawPR(prNum);
        if (!awaitMergeable || pr.mergeable !== null)
            return pr;
        Log.Logger.info("PR" + prNum + ": GitHub still caluclates mergeable status. Will retry in " + (d/1000) + " seconds");
        await Util.sleep(d);
    }
    return Promise.reject(new ErrorContext("GitHub could not calculate mergeable status",
                getPR.name, {pr: prNum}));
}

// gets a PR from GitHub (as is)
function getRawPR(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.get(params, (err, pr) => {
            if (err) {
                reject(new ErrorContext(err, getRawPR.name, params));
                return;
            }
            const result = {number: pr.data.number};
            logApiResult(getRawPR.name, params, result);
            resolve(pr.data);
       });
   });
}

function getReviews(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise((resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.getReviews(params, async (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getReviews.name, params));
                return;
            }
            res = await pager(res);
            resolve(res.data);
        });

    });
}

function getStatuses(ref) {
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.repos.getCombinedStatusForRef(params, async (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getStatuses.name, params));
                return;
            }
            res = await pager(res, statusAppender);
            logApiResult(getStatuses.name, params, {statuses: res.data.statuses.length});
            resolve(res.data);
        });
    });
}

function getCommit(sha) {
    let params = commonParams();
    params.sha = sha;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.getCommit(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getCommit.name, params));
                return;
            }
            const result = res.data;
            logApiResult(getCommit.name, params, result);
            resolve(result);
        });
  });
}

function createCommit(treeSha, message, parents, author, committer) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.tree = treeSha;
    params.message = message;
    params.parents = parents;
    params.author = author;
    params.committer = committer;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.createCommit(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, createCommit.name, params));
                return;
            }
            const result = {sha: res.data.sha};
            logApiResult(createCommit.name, params, result);
            resolve(res.data.sha);
        });
  });
}

// returns one of: "ahead", "behind", "identical" or "diverged"
function compareCommits(baseRef, headRef) {
    let params = commonParams();
    params.base = baseRef;
    params.head = headRef;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.repos.compareCommits(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, compareCommits.name, params));
                return;
            }
            const result = {status: res.data.status};
            logApiResult(compareCommits.name, params, result);
            resolve(res.data.status);
        });
  });
}

function getReference(ref) {
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.getReference(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logApiResult(getReference.name, params, result);
            resolve(res.data.object.sha);
        });
    });
}

// get all available repository tags
function getTags() {
    let params = commonParams();
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.getTags(params, async (err, res) => {
            const notFound = (err && err.code === 404);
            if (err && !notFound) {
                reject(new ErrorContext(err, getTags.name, params));
                return;
            }
            res = await pager(res);
            const result = notFound ? [] : res.data;
            logApiResult(getTags.name, params, {tags: result.length});
            resolve(result);
        });
    });
}

function createReference(sha, ref) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.sha = sha;
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.createReference(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, createReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logApiResult(createReference.name, params, result);
            resolve(res.data.object.sha);
        });
    });
}

function updateReference(ref, sha, force) {
    assert(!Config.dryRun());
    assert((ref === Config.stagingBranchPath()) || !Config.stagedRun());

    let params = commonParams();
    params.ref = ref;
    params.sha = sha;
    params.force = force; // default (ensure we do ff merge).
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.updateReference(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, updateReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logApiResult(updateReference.name, params, result);
            resolve(res.data.object.sha);
       });
    });
}

// For the record: GitHub returns 422 error if there is no such
// reference 'refs/:sha', and 404 if there is no such tag 'tags/:tag'.
// Once I saw that both errors can be returned, so looks like this
// GitHub behavior is unstable.
function deleteReference(ref) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.deleteReference(params, (err) => {
            if (err) {
                reject(new ErrorContext(err, deleteReference.name, params));
                return;
            }
            const result = {deleted: true};
            logApiResult(deleteReference.name, params, result);
            resolve(result);
       });
    });
}

function updatePR(prNum, state) {
   assert(!Config.dryRun());
   let params = commonParams();
   params.state = state;
   params.number = prNum;
   return new Promise( (resolve, reject) => {
     GitHub.authenticate(GitHubAuthentication);
     GitHub.pullRequests.update(params, (err, res) => {
        if (err) {
            reject(new ErrorContext(err, updatePR.name, params));
            return;
        }
        const result = {state: res.data.state};
        logApiResult(updatePR.name, params, result);
        resolve(result);
     });
  });
}

function addLabels(params) {
   assert(!Config.dryRun());
   return new Promise( (resolve, reject) => {
     GitHub.authenticate(GitHubAuthentication);
     GitHub.issues.addLabels(params, (err, res) => {
        if (err) {
            reject(new ErrorContext(err, addLabels.name, params));
            return;
        }
        const result = {added: true};
        logApiResult(addLabels.name, params, result);
        resolve(res.data);
     });
  });
}

function removeLabel(label, prNum) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.number = prNum;
    params.name = label;
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.issues.removeLabel(params, (err) => {
          if (err) {
             reject(new ErrorContext(err, addLabels.name, params));
             return;
          }
          const result = {removed: true};
          logApiResult(removeLabel.name, params, result);
          resolve(result);
      });
  });
}

// XXX: remove if not needed, since the "required_status_checks" api call sometimes
// does not work(?) for organization repositories (returns 404 Not Found).
//function getProtectedBranchRequiredStatusChecks(branch) {
//    let params = commonParams();
//    params.branch = branch;
//    return new Promise( (resolve, reject) => {
//      GitHub.authenticate(GitHubAuthentication);
//      GitHub.repos.getProtectedBranchRequiredStatusChecks(params, (err, res) => {
//          if (err) {
//             reject(new ErrorContext(err, getProtectedBranchRequiredStatusChecks.name, params));
//             return;
//          }
//          const result = {checks: res.data.contexts.length};
//          logApiResult(getProtectedBranchRequiredStatusChecks.name, params, result);
//          resolve(res.data.contexts);
//      });
//    });
//}

function createStatus(sha, state, targetUrl, desc, context) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.sha = sha;
    params.state = state;
    params.target_url = targetUrl;
    params.desc = desc;
    params.context = context;
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.createStatus(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, createCommit.name, params));
             return;
          }
          const result = {context: res.data.context};
          logApiResult(createStatus.name, params, result);
          resolve(res.data.context);
        });
    });
}

function getProtectedBranchRequiredStatusChecks(branch) {
    let params = commonParams();
    params.branch = branch;
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.getBranch(params, async (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getProtectedBranchRequiredStatusChecks.name, params));
             return;
          }
          res = await pager(res, protectedBranchAppender);
          const result = {checks: res.data.protection.required_status_checks.contexts.length};
          logApiResult(getProtectedBranchRequiredStatusChecks.name, params, result);
          resolve(res.data.protection.required_status_checks.contexts);
      });
    });
}

function getCollaborators() {
    const params = commonParams();
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.getCollaborators(params, async (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getCollaborators.name, params));
             return;
          }
          res = await pager(res);
          const result = {collaborators: res.data.length};
          logApiResult(getCollaborators.name, params, result);
          resolve(res.data);
      });
    });
}

function getUser(username) {
    const params = commonParams();
    params.username = username;
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.users.getForUser(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getUser.name, params));
             return;
          }
          const result = {user: res.data};
          logApiResult(getUser.name, params, result);
          resolve(res.data);
      });
    });
}

function getUserEmails() {
    const params = commonParams();
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.users.getEmails(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getUserEmails.name, params));
             return;
          }
          const result = {emails: res.data};
          logApiResult(getUserEmails.name, params, result);
          resolve(res.data);
      });
    });
}

function protectedBranchParams() {
    const params = commonParams();
    params.headers = { accept: 'application/vnd.github.luke-cage-preview+json' };
    return params;
}

function getProtectedBranchPullRequestReviewEnforcement(branch) {
    const params = protectedBranchParams();
    params.branch = branch;
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.getProtectedBranchPullRequestReviewEnforcement(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getProtectedBranchPullRequestReviewEnforcement.name, params));
             return;
          }
          logApiResult(getProtectedBranchPullRequestReviewEnforcement.name, params, res.data);
          const result = res.data.required_approving_review_count !== undefined && res.data.required_approving_review_count > 0;
          resolve(result);
      });
    });
}

function updateProtectedBranchPullRequestReviewEnforcement(branch) {
    assert(!Config.dryRun());
    const params = Object.assign(protectedBranchParams(), Config.githubPullRequestReviewEnforcementSettings());
    params.branch = branch;
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.updateProtectedBranchPullRequestReviewEnforcement(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, updateProtectedBranchPullRequestReviewEnforcement.name, params));
             return;
          }
          logApiResult(updateProtectedBranchPullRequestReviewEnforcement.name, params, res.data);
          resolve(res.data);
      });
    });
}

function removeProtectedBranchPullRequestReviewEnforcement(branch) {
    assert(!Config.dryRun());
    const params = protectedBranchParams();
    params.branch = branch;
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.removeProtectedBranchPullRequestReviewEnforcement(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, removeProtectedBranchPullRequestReviewEnforcement.name, params));
             return;
          }
          const result = {deleted: true};
          logApiResult(removeProtectedBranchPullRequestReviewEnforcement.name, params, res.data);
          resolve(result);
      });
    });
}

module.exports = {
    getPRList: getPRList,
    getLabels: getLabels,
    getPR: getPR,
    getReviews: getReviews,
    getStatuses: getStatuses,
    getCommit: getCommit,
    createCommit: createCommit,
    compareCommits: compareCommits,
    getReference: getReference,
    getTags: getTags,
    createReference: createReference,
    updateReference: updateReference,
    deleteReference: deleteReference,
    updatePR: updatePR,
    addLabels: addLabels,
    removeLabel: removeLabel,
    createStatus: createStatus,
    getProtectedBranchRequiredStatusChecks: getProtectedBranchRequiredStatusChecks,
    getProtectedBranchPullRequestReviewEnforcement: getProtectedBranchPullRequestReviewEnforcement,
    updateProtectedBranchPullRequestReviewEnforcement: updateProtectedBranchPullRequestReviewEnforcement,
    removeProtectedBranchPullRequestReviewEnforcement: removeProtectedBranchPullRequestReviewEnforcement,
    getCollaborators: getCollaborators,
    getUser: getUser,
    getUserEmails: getUserEmails
};


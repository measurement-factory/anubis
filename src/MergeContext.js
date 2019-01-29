const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');


// Action outcome, with support for paused and snoozed actions.
// For example, returned by PullRequest.process() (at higher level) or
// various checks (at low level).
class StepResult
{
    // treat as private; use static methods below instead
    constructor(delayMs) {
        assert(delayMs !== undefined);
        this._delayMs = delayMs;
    }

    // the step is successfully finished
    static Succeed() {
        return new StepResult(0);
    }

    // the step is postponed (and will be resumed some time later)
    static Suspend() {
        return new StepResult(-1);
    }

    // the step is finished with failure
    static Fail() {
        return new StepResult(null);
    }

    // the step is postponed (and will be resumed in delayMs)
    static Delay(delayMs) {
        assert(delayMs !== null && delayMs > 0);
        return new StepResult(delayMs);
    }

    succeeded() {
        return this._delayMs !== null && this._delayMs === 0;
    }

    failed() {
        return this._delayMs === null;
    }

    suspended() {
        return this._delayMs !== null && this._delayMs < 0;
    }

    delayed() {
        return this._delayMs !== null && this._delayMs > 0;
    }

    delay() {
        assert(this.delayed());
        return this._delayMs;
    }
}

// Relaying process() outcome to the caller via doProcess() exceptions:
//
// Exception          Unstage  Push-Labels  Result-of-process()
// _exLostControl()     yes      no           exception
// _exObviousFailure()  yes      yes          exception
// _exLabeledFailure()  yes      yes          exception
// any-unlisted-here    yes      yes          exception
// _exRetry()           yes      yes          null
// _exSuspend()         no       yes          StepResult.Suspend()
// _exDelay()           no       yes          StepResult.Delay()
// no-exception         no       yes          StepResult.Succeed()

// A PR-specific process()ing error.
// A PrProblem thrower must set any appropriate labels.
// Other exceptions get Config.failedOtherLabel() added automatically.
// Babel does not support extending Error; this class requires node v8+.
class PrProblem extends Error {
    constructor(message, ...params) {
        super(message, ...params);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);

        this.result_ = undefined; // may be set to null later
        this.keepStaged_ = false; // catcher should preserve the staged commit
    }

    hasResult() { return this.result_ !== undefined; }

    keepStagedRequested() { return this.keepStaged_; }

    setResult(result) {
        assert(!this.hasResult());
        assert(result !== undefined);
        this.result_ = result;
    }

    requestToKeepStaged() {
        assert(!this.keepStagedRequested());
        this.keepStaged_ = true;
    }
}

// Contains properties used for approval test status creation
class Approval {
    // treat as private; use static methods below instead
    constructor(description, state, delayMs) {
        assert(description);
        assert(state);
        assert(delayMs !== undefined);
        assert(delayMs === null || delayMs >= 0);
        this.description = description;
        this.state = state;
        // If waiting for a timeout (slow burner or fast track): > 0
        // If ready to merge the staged commit now (have enough votes or slow burner timeout): == 0
        // Otherwise (negative votes or review requested): null
        this.delayMs = delayMs;
    }

    static GrantAfterTimeout(description, delayMs) {
        assert(delayMs);
        assert(delayMs > 0);
        return new Approval(description, "pending", delayMs);
    }

    static GrantNow(description) {
        return new Approval(description, "success", 0);
    }

    static Block(description) {
        return new Approval(description, "error", null);
    }

    static Suspend(description) {
        return new Approval(description, "pending", null);
    }

    matchesGitHubStatusCheck(approvalStatus) {
        assert(approvalStatus);
        return approvalStatus.state === this.state && approvalStatus.description === this.description;
    }

    granted() { return this.delayMs !== null; }

    grantedTimeout() { return this.delayMs !== null && this.delayMs > 0; }

    toString() {
        let str = "description: " + this.description + ", state: " + this.state;
        if (this.delayMs !== null)
            str += ", delayMs: " + this.delayMs;
        return str;
    }
}

class StatusCheck
{
    constructor(raw) {
        assert(raw.context);
        assert(raw.state);
        assert(raw.target_url);
        assert(raw.description);

        this.context = raw.context;
        this.state = raw.state;
        this.targetUrl = raw.target_url;
        this.description = raw.description;
    }
}

// aggregates status checks for a PR or commit
class StatusChecks
{
    // expectedStatusCount:
    //   for staged commits: the bot-configured number of required checks (Config.stagingChecks()),
    //   for PR commits: GitHub configured number of required checks (requested from GitHub)
    // context: either "PR" or "Staging";
    constructor(expectedStatusCount, context) {
        assert(expectedStatusCount !== undefined);
        assert(expectedStatusCount !== null);
        assert(context);
        this.expectedStatusCount = expectedStatusCount;
        this.context = context;
        this.requiredStatuses = [];
        this.optionalStatuses = [];
    }

    addRequiredStatus(requiredStatus) {
        assert(requiredStatus);
        this.requiredStatuses.push(requiredStatus);
    }

    addOptionalStatus(optionalStatus) {
        assert(optionalStatus);
        this.optionalStatuses.push(optionalStatus);
    }

    hasStatus(context) {
        return this.requiredStatuses.some(el => el.context.trim() === context.trim()) ||
            this.optionalStatuses.some(el => el.context.trim() === context.trim());
    }

    // no more required status changes or additions are expected
    final() {
        return (this.requiredStatuses.length >= this.expectedStatusCount) &&
            this.requiredStatuses.every(check => check.state !== 'pending');
    }

    // something went wrong with at least one of the required status checks
    failed() {
        return this.requiredStatuses.some(check => check.state !== 'pending' && check.state !== 'success');
    }

    // the results are final and all checks were a success
    succeeded() {
        return this.final() && this.requiredStatuses.every(check => check.state === 'success');
    }

    toString() {
        let combinedStatus = "context: " + this.context + " expected/required/optional: " + this.expectedStatusCount + "/" +
            this.requiredStatuses.length + "/" + this.optionalStatuses.length + ", combined: ";
        if (this.failed())
            combinedStatus += "failure";
        else if (this.succeeded())
            combinedStatus += "success";
        else if (this.final())
            combinedStatus += "unexpected"; // final() implies failed() or succeeded()
        else
            combinedStatus += "to-be-determined";

        let requiredDetail = "";
        for (let st of this.requiredStatuses) {
            if (requiredDetail !== "")
                requiredDetail += ", ";
            requiredDetail += st.context + ": " + st.state;
        }
        let optionalDetail = "";
        for (let st of this.optionalStatuses) {
            if (optionalDetail !== "")
                optionalDetail += ", ";
            optionalDetail += st.context + ": " + st.state;
        }
        return combinedStatus + "; required: " + requiredDetail + "; optional: " + optionalDetail;
    }
}

// pull request label (e.g., M-cleared-for-merge)
class Label
{
    constructor(name, presentOnGitHub) {
        assert(arguments.length === 2);
        this.name = name;
        // we keep some unset labels to delay their removal from GitHub
        this._presentHere = true; // set from Anubis high-level code point of view
        this._presentOnGitHub = presentOnGitHub; // set from GitHub point of view
    }
    // whether the label should be considered "set" from Anubis high-level code point of view
    present() { return this.presentHere_; }

    needsRemovalFromGitHub() { return this._presentOnGitHub && !this._presentHere; }

    needsAdditionToGitHub() { return !this._presentOnGitHub && this._presentHere; }

    markForRemoval() { this.presentHere_ = false; }

    markForAddition() { this.presentHere_ = true; }
}

// Pull request labels. Hides the fact that some labels may be kept internally
// while appearing to be unset for high-level code. Delays synchronization
// with GitHub to help GitHub aggregate human-readable label change reports.
class Labels
{
    // the labels parameter is the label array received from GitHub
    constructor(labels, prNum) {
        this._prNum = prNum;
        this._labels = labels.map(label => new Label(label.name, true));
    }

    // adding a previously added or existing label is a no-op
    add(name) {
        const label = this._find(name);
        if (label)
            label.markForAddition();
        else
            this._labels.push(new Label(name, false));
    }

    // removing a previously removed or missing label is a no-op
    remove(name) {
        const label = this._find(name);
        if (label)
            label.markForRemoval();
    }

    // whether the label is present (from high-level Anubis code point of view)
    has(name) {
        const label = this._find(name);
        return label && label.present();
    }

    // brings GitHub labels in sync with ours
    async pushToGitHub() {
        let syncedLabels = [];
        for (let label of this._labels) {
            if (label.needsRemovalFromGitHub()) {
                await this._removeFromGitHub(label.name);
            } else {
                if (label.needsAdditionToGitHub())
                    await this._addToGitHub(label.name); // TODO: Optimize to add all labels at once
                // else still unchanged

                syncedLabels.push(label);
            }
        }
        this._labels = syncedLabels;
    }

    // a summary of changed labels (used for debugging)
    diff() {
        let str = "";
        for (let label of this._labels) {
            if (label.needsRemovalFromGitHub() || label.needsAdditionToGitHub()) {
                if (str.length)
                    str += ", ";
                const prefix = label.present() ? '+' : '-';
                str += prefix + label.name;
            }
        }
        return '[' + str + ']';
    }

    // removes a single label from GitHub
    async _removeFromGitHub(name) {
        try {
            await GH.removeLabel(name, this._prNum);
        } catch (e) {
            if (e.name === 'ErrorContext' && e.notFound()) {
                Log.LogException(e, "_removeFromGitHub: " + name + " not found");
                return;
            }
            throw e;
        }
    }

    // adds a single label to GitHub
    async _addToGitHub(name) {
        let params = Util.commonParams();
        params.number = this._prNum;
        params.labels = [];
        params.labels.push(name);

        await GH.addLabels(params);
    }

    _find(name) { return this._labels.find(label => label.name === name); }
}

// A state of a pull request (with regard to merging progress). One of:
// pre-staged: prior to staged commit creation
// staged: prior to staged commit merging into base
// post-staged: prior to merged PR closure
class PrState
{
    // treat as private; use static methods below instead
    constructor(state) {
        this._state = state;
    }

    static PreStaged() { return new PrState(-1); }
    static Staged() { return new PrState(0); }
    static PostStaged() { return new PrState(1); }

    preStaged() { return this._state < 0; }
    staged() { return this._state === 0; }
    postStaged() { return this._state > 0; }

    toString() {
        if (this.preStaged())
            return "pre-staged";
        if (this.staged())
            return "staged";
        assert(this.postStaged());
        return "post-staged";
    }
}

// a single GitHub pull request
class PullRequest {

    constructor(pr, anotherPrWasStaged) {

        this._rawPr = pr; // may lack pr.mergeable, see _refreshPr()

        this._shaLimit = 6; // how many SHA chars to show in debug messages

        this._approval = null; // future Approval object

        // optimization: cached _getRequiredContexts() result
        this._requiredContextsCache = null;

        this._tagSha = null;
        this._tagFresh = null;
        this._compareStatus = null;
        this._stagingSha = null;

        // optimization: cached _tagCommit() result
        this._tagCommitCache = null;

        // major methods we have called, in the call order (for debugging only)
        this._breadcrumbs = [];

        this._messageValid = null;

        this._prState = null; // calculated PrState

        this._labels = null;
        this._anotherPrWasStaged = anotherPrWasStaged;
        this._updated = false; // update() has been called

        // truthy value contains a reason for disabling _pushLabelsToGitHub()
        this._labelPushBan = false;
    }

    // creates and returns filled Approval object
    async _checkApproval() {
        assert(this._approval === null);

        const collaborators = await GH.getCollaborators();
        const pushCollaborators = collaborators.filter(c => c.permissions.push === true);
        const requestedReviewers = this._prRequestedReviewers();

        for (let collaborator of pushCollaborators) {
            if (requestedReviewers.includes(collaborator.login)) {
                this._log("requested core reviewer: " + collaborator.login);
                return Approval.Suspend("waiting for requested reviews");
            }
        }

        let reviews = await GH.getReviews(this._prNumber());

        // An array of [{reviewer, date, state}] elements,
        // where 'reviewer' is a core developer, 'date' the review date and 'state' is either
        // 'approved' or 'changes_requested'.
        let usersVoted = [];
        // add the author if needed
        if (pushCollaborators.find(el => el.login === this._prAuthor()))
            usersVoted.push({reviewer: this._prAuthor(), date: this._createdAt(), state: 'approved'});

        // Reviews are returned in chronological order; the list may contain several
        // reviews from the same reviewer, so the actual 'state' is the most recent one.
        for (let review of reviews) {
            const reviewState = review.state.toLowerCase();
            if (reviewState === 'commented')
                continue;
            // TODO: wait for it
            if (reviewState === 'pending')
                continue;

            // remove the old vote (if exists)
            usersVoted = usersVoted.filter(el => el.reviewer !== review.user.login);

            if (reviewState === 'dismissed')
                continue;

            assert(reviewState === 'approved' || reviewState === 'changes_requested');
            usersVoted.push({reviewer: review.user.login, date: review.submitted_at, state: reviewState});
        }

        const userRequested = usersVoted.find(el => el.state === 'changes_requested');
        if (userRequested !== undefined) {
            this._log("changes requested by " + userRequested.reviewer);
            return Approval.Block("blocked (see change requests)");
        }
        const usersApproved = usersVoted.filter(u => u.state !== 'changes_requested');
        this._log("approved by " + usersApproved.length + " core developer(s)");

        if (usersApproved.length < Config.necessaryApprovals()) {
            this._log("not approved by necessary " + Config.necessaryApprovals() + " votes");
            return Approval.Suspend("waiting for more votes");
        }

        const prAgeMs = new Date() - new Date(this._createdAt());
        if (usersApproved.length >= Config.sufficientApprovals()) {
            if (prAgeMs < Config.votingDelayMin())
                return Approval.GrantAfterTimeout("waiting for fast track objections", Config.votingDelayMin() - prAgeMs);
            else
                return Approval.GrantNow("approved");
        }

        if (prAgeMs >= Config.votingDelayMax())
            return Approval.GrantNow("approved (on slow burner)");

        return Approval.GrantAfterTimeout("waiting for more votes or a slow burner timeout", Config.votingDelayMax() - prAgeMs);
    }

    async _setApprovalStatus(sha) {
        assert(sha);

        // TODO: Move lower
        if (this._dryRun("setting approval status"))
            return;
        if (!Config.manageApprovalStatus())
            return;

        const combinedStatus = await GH.getStatuses(sha);
        const approvalStatus = combinedStatus.statuses ?
            combinedStatus.statuses.find(el => el.context.trim() === Config.approvalContext()) : null;

        if (approvalStatus && this._approval.matchesGitHubStatusCheck(approvalStatus)) {
            this._log("Approval status already exists: " + Config.approvalContext() + ", " + this._approval);
            return;
        }
        await GH.createStatus(sha, this._approval.state, Config.approvalUrl(), this._approval.description, Config.approvalContext());
    }

    async _getRequiredContexts() {
        if (this._requiredContextsCache)
            return this._requiredContextsCache;

        try {
            this._requiredContextsCache = await GH.getProtectedBranchRequiredStatusChecks(this._prBaseBranch());
        } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               Log.LogException(e, this._toString() + " no status checks are required");
           else
               throw e;
        }

        if (this._requiredContextsCache === undefined)
            this._requiredContextsCache = [];

        assert(this._requiredContextsCache);
        this._log("required contexts found: " + this._requiredContextsCache.length);
        return this._requiredContextsCache;
    }

    // returns filled StatusChecks object
    async _getPrStatuses() {
        const requiredContexts = await this._getRequiredContexts();
        const combinedPrStatus = await GH.getStatuses(this._prHeadSha());
        let statusChecks = new StatusChecks(requiredContexts.length, "PR");
        // fill with required status checks
        for (let st of combinedPrStatus.statuses) {
            if (requiredContexts.some(el => el.trim() === st.context.trim()))
                statusChecks.addRequiredStatus(new StatusCheck(st));
            else
                statusChecks.addOptionalStatus(new StatusCheck(st));
        }
        this._log("pr status details: " + statusChecks);
        return statusChecks;
    }

    // returns filled StatusChecks object
    async _getStagingStatuses() {
        const combinedStagingStatuses = await GH.getStatuses(this._tagSha);
        const genuineStatuses = combinedStagingStatuses.statuses.filter(st => !st.description.endsWith(Config.copiedDescriptionSuffix()));
        assert(genuineStatuses.length <= Config.stagingChecks());
        let statusChecks = new StatusChecks(Config.stagingChecks(), "Staging");
        // all genuine checks are 'required'
        for (let st of genuineStatuses)
            statusChecks.addRequiredStatus(new StatusCheck(st));

        const optionalStatuses = combinedStagingStatuses.statuses.filter(st => st.description.endsWith(Config.copiedDescriptionSuffix()));
        for (let st of optionalStatuses)
            statusChecks.addOptionalStatus(new StatusCheck(st));

        return statusChecks;
    }

    async _tagCommit() {
        if (!this._tagCommitCache)
            this._tagCommitCache = await GH.getCommit(this._tagSha);
        return this._tagCommitCache;
    }

    // Whether the PR merge commit has not changed since the PR staged commit creation.
    // Note that it does not track possible conflicts between PR base branch and the
    // PR branch (the PR merge commit is recreated only when there are no conflicts).
    // Conflicts are tracked separately, by checking _prMergeable() flag.
    async _tagIsFresh() {
        const tagCommit = await this._tagCommit();
        const prMergeSha = await GH.getReference(this._mergePath());
        const prCommit = await GH.getCommit(prMergeSha);
        const result = tagCommit.tree.sha === prCommit.tree.sha;
        this._log("tag freshness: " + result);
        return result;
    }

    // loads info about "staging tag" (if any); M-staged-PRnnn tag is a
    // PR-specific git tag pointing to the previously created staged commit
    async _loadTag() {
       if (this._tagSha)
           return;

       try {
           this._tagSha = await GH.getReference(this._stagingTag());
           if (this._tagSha) {
               this._compareStatus = await GH.compareCommits(this._prBaseBranch(), this._stagingTag());
               this._log("compareStatus: " + this._compareStatus);
               this._tagFresh = this._tagIsFresh();
           }
       } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               Log.LogException(e, this._toString() + " " + this._stagingTag() + " not found");
           else
               throw e;
       }
    }

    async _loadLabels() {
        let labels = await GH.getLabels(this._prNumber());
        assert(!this._labels);
        this._labels = new Labels(labels, this._prNumber());
    }

    // Whether there is a fresh staged commit with failed status checks.
    // Side effect: removes stale staging tag (TODO: Why?)
    // Side effect: removes fresh staging tag if tests have not failed (XXX: Why?)
    async _stagedCommitFailedTests() {
        await this._loadTag();
        if (!this._tagSha)
            return false; // no staged commit

        if (this._tagFresh) {
            const commitStatus = await this._getStagingStatuses();
            this._log("staging status details: " + commitStatus);
            if (commitStatus.failed()) {
                this._log("staging tests failed some time ago");
                if (!this._prMergeable())
                    this._log("merge commit did not change due to conflicts with " + this._prBaseBranch());
                return true; // fresh staged commit with failed status checks
            }
            // fresh staged commit with successful (or ongoing) status checks
        }
        if (!this._dryRun("deleting staging tag"))
            await GH.deleteReference(this._stagingTag());
        return false; // stale staged commit or fresh one with successful (or ongoing) status checks
    }

    // Refreshes PR metadata.
    // Checks whether this PR is still open and still wants to be merged.
    // Is used for both merging and staging actions.
    // Do not use for post-staged.
    async _checkActive() {
        assert(!this._prState.postStaged());

        await this._refreshPr();

        // TODO: Move update() here and remove its caching protection

        if (!this._prOpen())
            throw this._exLostControl("unexpected closure");

        if (this._labels.has(Config.mergedLabel()))
            throw this._exLostControl("premature " + Config.mergedLabel());

        // XXX: Move (as _exSuspend) to checkStagingPreconditions because our
        // commit-message checks already handle WIP addition to a _staged_ PR.
        if (this._wipPr())
            throw this._exObviousFailure("work-in-progress");
    }

    // whether the PR should be staged (including re-staged)
    async _checkStagingPreconditions() {
        this._log("checking staging preconditions");

        await this._checkActive();

        if (!this._prMergeable())
            throw this._exObviousFailure("GitHub will not be able to merge");

        if (await this._stagedCommitFailedTests())
            throw this._exLabeledFailure("staged commit tests will fail", Config.failedStagingChecksLabel());

        if (!this._messageValid)
            throw this._exLabeledFailure("invalid commit message", Config.failedDescriptionLabel());

        if (!this._approval.granted())
            throw this._exSuspend("waiting for approval"); // or _exObviousFailure("lack of approval") -- same effect on unstaged PRs

        const statusChecks = await this._getPrStatuses();
        if (statusChecks.failed())
            throw this._exObviousFailure("failed PR tests");

        // TODO: Reorder this._approval/statusChecks if-statements for clarity
        if (this._approval.grantedTimeout())
            throw this._exDelay("waiting for objections", this._approval.delayMs);

        if (!statusChecks.final())
            throw this._exSuspend("waiting for PR checks");

        if (this._anotherPrWasStaged)
            throw this._exSuspend("waiting for another staged PR");
    }

    // Refreshes PR GitHub state.
    // Can be used safely for any opened PR.
    // Do not use for post-staged PRs.
    async update() {
        if (this._updated)
            return;

        this._breadcrumbs.push("update");
        this._messageValid = this._prMessageValid();
        this._log("messageValid: " + this._messageValid);

        this._approval = await this._checkApproval();
        this._log("checkApproval: " + this._approval);
        await this._setApprovalStatus(this._prHeadSha());

        this._updated = true;
    }

    // brings GitHub labels in sync with ours
    async _pushLabelsToGitHub() {
        if (this._labels) {
            if (this._labelPushBan) {
                this._log("will not push changed labels:", this._labelPushBan);
                return;
            }
            this._log("pushing changed labels:", this._labels.diff());
            if (!this._dryRun("pushing labels"))
                await this._labels.pushToGitHub();
        }
    }

    // Cleans up and closes a post-staged PR, removing it from our radar for good.
    async _finalize() {
        this._breadcrumbs.push("finalize");

        assert(this._prState.postStaged());

        // Clear any positive labels (there should be no negatives here)
        // because Config.mergedLabel() set below already implies that all
        // intermediate processing steps have succeeded.
        this._removeTemporaryLabelsSetByAnubis();

        this._labels.remove(Config.clearedForMergeLabel());
        this._labels.add(Config.mergedLabel());

        // TODO: Throw _exSuspend() here, for consistency sake
        if (this._dryRun("finalize"))
            return;

        await GH.updatePR(this._prNumber(), 'closed');
        await GH.deleteReference(this._stagingTag());
        this._log("finalize completed");
    }

    // Getters

    _prNumber() { return this._rawPr.number; }

    _prHeadSha() { return this._rawPr.head.sha; }

    _prMessage() {
        return (this._rawPr.title + ' (#' + this._rawPr.number + ')' + '\n\n' + this._prBody()).trim();
    }

    _prMessageValid() {
        const lines = this._prMessage().split('\n');
        for (let line of lines) {
            if (line.length > 72)
                return false;
        }
        return true;
    }

    _wipPr() { return this._rawPr.title.startsWith('WIP:'); }

    _prRequestedReviewers() {
        let reviewers = [];
        if (this._rawPr.requested_reviewers) {
            for (let r of this._rawPr.requested_reviewers)
               reviewers.push(r.login);
        }
        return reviewers;
    }

    _prAuthor() { return this._rawPr.user.login; }

    _prMergeable() { return this._rawPr.mergeable; }

    _prBaseBranch() { return this._rawPr.base.ref; }

    _prBaseBranchPath() { return "heads/" + this._prBaseBranch(); }

    _prOpen() { return this._rawPr.state === 'open'; }

    _prBody() {
        if (this._rawPr.body === undefined || this._rawPr.body === null)
            return "";
        return this._rawPr.body.replace(/\r+\n/g, '\n');
    }

    _stagingTag() { return Util.StagingTag(this._rawPr.number); }

    _createdAt() { return this._rawPr.created_at; }

    _mergePath() { return "pull/" + this._rawPr.number + "/merge"; }

    staged() { return this._prState.staged(); }

    _debugString() {
        const detail =
            "head: " + this._rawPr.head.sha.substr(0, this._shaLimit) + ' ' +
            "history: " + this._breadcrumbs.join();
        return "PR" + this._rawPr.number + ` (${detail})`;
    }

    _log(msg) {
        Log.Logger.info(this._debugString(), msg);
    }

    _warn(msg) {
        Log.Logger.warn(this._debugString(), msg);
    }

    // TODO: Rename to _readOnly()
    // whether all GitHub/repository changes are prohibited
    _dryRun(msg) {
        if (!Config.dryRun())
            return false;
        this._log("skip '" + msg + "' due to dry_run option");
        return true;
    }

    _toString() {
        let str = this._debugString();
        if (this._tagSha !== null)
            str += ", tag: " + this._tagSha.substr(0, this._shaLimit);
        return str + ")";
    }

    // whether the staged commit and the base HEAD have independent,
    // (probably conflicting) changes
    async _tagDiverged() {
        try {
            const compareStatus = await GH.compareCommits(this._prBaseBranch(), this._stagingTag());
            return compareStatus === "diverged";
        } catch (e) {
            Log.LogError(e, this._toString() + " compare commits failed");
            return false;
        }
    }

    async _loadPrState() {
        if (!this._tagSha) {
            this._prState = PrState.PreStaged();
            return;
        }

        if (!this._compareStatus) {
            this._warn("missing compare status");
            this._prState = PrState.PreStaged();
            return;
        }

        if (this._compareStatus === "identical" || this._compareStatus === "behind") {
            this._log("already merged into base some time ago");
            this._prState = PrState.PostStaged();
            return;
        }

        if (!this._stagingSha)
            this._stagingSha = await GH.getReference(Config.stagingBranchPath());

        if (this._stagingSha !== this._tagSha) {
            this._prState = PrState.PreStaged();
            return;
        }

        if (!this._tagFresh) {
            this._prState = PrState.PreStaged();
            return;
        }

        assert(!this._anotherPrWasStaged);
        this._prState = PrState.Staged();
    }

    // Loads the raw PR from GitHub, including 'mergeable' flag.
    // May get stuck for 'post-staged' (when the PR is probably already merged/closed)
    // waiting for rawPr.mergeable.
    async _refreshPr() {
        const pr = await GH.getPR(this._prNumber(), true);
        assert(pr.number === this._prNumber());
        this._rawPr = pr;
    }

    // Whether the commit message configuration remained intact since staging.
    async _messageIsFresh() {
        const tagCommit = await this._tagCommit();
        const result = this._prMessage() === tagCommit.message;
        this._log("tag message freshness: " + result);
        return result;
    }

    async _processStagingStatuses() {
        const stagingStatus = await this._getStagingStatuses();
        this._log("staging status details: " + stagingStatus);

        if (stagingStatus.failed())
            throw this._exLabeledFailure("staging tests failed", Config.failedStagingChecksLabel());

        if (!stagingStatus.final()) {
            this._labels.add(Config.waitingStagingChecksLabel());
            throw this._exSuspend("waiting for staging tests completion");
        }

        assert(stagingStatus.succeeded());
        this._log("staging checks succeeded");
        // TODO: Spellcheck and move into _supplyStagingWithPrRequired().
        if (this._dryRun("applying required PR statues to staged"))
            throw this._exSuspend("dryRun");

        await this._supplyStagingWithPrRequired(stagingStatus);
    }

    // Creates PR-required status checks for staged commit (if possible).
    // Staged commit needs all PR-required checks (configured on GitHub)
    // so that GitHub could merge it into the protected base branch.
    async _supplyStagingWithPrRequired(stagedStatuses) {
        assert(stagedStatuses.succeeded());

        const requiredContexts = await this._getRequiredContexts();
        const prStatuses = await this._getPrStatuses();

        for (let requiredContext of requiredContexts) {
            if (stagedStatuses.hasStatus(requiredContext)) {
                this._log("_supplyStagingWithPrRequired: skip existing " + requiredContext);
                continue;
            }
            const requiredPrStatus = prStatuses.requiredStatuses.find(el => el.context.trim() === requiredContext.trim());
            assert(requiredPrStatus);
            assert(!requiredPrStatus.description.endsWith(Config.copiedDescriptionSuffix()));
            await GH.createStatus(this._tagSha, "success", requiredPrStatus.targetUrl,
                    requiredPrStatus.description + Config.copiedDescriptionSuffix(), requiredPrStatus.context);
        }
    }

    // whether target branch changes are prohibited
    _stagingOnly() {
        // TODO: The caller should not have to remember to call _dryRun() first
        assert(!this._dryRun("_stagingOnly"));
        const msg = "merge staged";

        if (Config.stagedRun()) {
            this._log("skip " + msg + " due to staged_run option");
            return true;
        }

        if (Config.guardedRun()) {
            if (this._labels.has(Config.clearedForMergeLabel())) {
                this._log("allow " + msg + " due to " + Config.clearedForMergeLabel() + " overruling guarded_run option");
                return false;
            }
            this._log("skip " + msg + " due to guarded_run option");
            return true;
        }

        return false; // no staging-only mode by default
    }

    // checks whether this staged PR can be merged
    async _checkMergePreconditions() {
        this._log("checking merge preconditions");

        await this._checkActive();

        // yes, _checkStagingPreconditions() has checked the message already,
        // but humans may have changed the original message since that check
        if (!(await this._messageIsFresh()))
            throw this._exRetry("fresh commit message");

        // yes, _checkStagingPreconditions() has checked the same message
        // already, but our _criteria_ might have changed since that check
        if (!this._messageValid)
            throw this._exLabeledFailure("commit message is now considered invalid", Config.failedDescriptionLabel());

        // TODO: unstage only if there is competition for being staged

        // yes, _checkStagingPreconditions() has checked approval already, but
        // humans may have changed their mind since that check
        if (!this._approval.granted())
            throw this._exObviousFailure("lost approval");
        if (this._approval.grantedTimeout())
            throw this._exObviousFailure("restart waiting for objections");

        const statusChecks = await this._getPrStatuses();
        if (statusChecks.failed())
            throw this._exObviousFailure("new PR branch tests appeared/failed after staging");

        if (!statusChecks.final())
            throw this._exSuspend("waiting for PR branch tests that appeared after staging");

        assert(statusChecks.succeeded());

        await this._processStagingStatuses();

        if (this._stagingOnly()) {
            // TODO: Consider adding this label unconditionally.
            this._labels.add(Config.passedStagingChecksLabel());
            throw this._exSuspend("waiting for staging-only mode to end");
        }
    }

    async _mergeToBase() {
        assert(this._tagSha);
        assert(this._compareStatus === "ahead");
        this._log("merging to base...");
        try {
            await GH.updateReference(this._prBaseBranchPath(), this._tagSha, false);
            // TODO: Move lower
            this._prState = PrState.PostStaged();
        } catch (e) {
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                if (await this._tagDiverged())
                    throw new Error("failed to fast-forward to the staged commit");
            }
            throw e;
        }
    }

    async _acquireUserProperties() {
        const emails = await GH.getUserEmails();
        for (let e of emails) {
            if (e.primary) {
                Config.githubUserEmail(e.email);
                break;
            }
        }
        assert(Config.githubUserEmail());

        const user = await GH.getUser(Config.githubUserLogin());
        Config.githubUserName(user.name);
        assert(Config.githubUserName());
    }

    async _createStaged() {
        const baseSha = await GH.getReference(this._prBaseBranchPath());
        const mergeSha = await GH.getReference("pull/" + this._prNumber() + "/merge");
        const mergeCommit = await GH.getCommit(mergeSha);
        if (!Config.githubUserName())
            await this._acquireUserProperties();
        let now = new Date();
        const committer = {name: Config.githubUserName(), email: Config.githubUserEmail(), date: now.toISOString()};

        if (this._dryRun("create staged commit"))
            throw this._exSuspend("dryRun");

        const tempCommitSha = await GH.createCommit(mergeCommit.tree.sha, this._prMessage(), [baseSha], mergeCommit.author, committer);
        this._tagSha = await GH.createReference(tempCommitSha, "refs/" + this._stagingTag());
        this._compareStatus = "ahead";
        await this._setApprovalStatus(this._tagSha);
        await GH.updateReference(Config.stagingBranchPath(), this._tagSha, true);
    }

    // Updates the PR GitHub attributes and stages it
    // for CI tests, if possible.
    async _stage() {
        this._breadcrumbs.push("stage");

        assert(this._prState.preStaged());

        // methods below compute fresh labels from scratch
        this._removeTemporaryLabelsSetByAnubis();

        await this.update();
        await this._checkStagingPreconditions();
        await this._createStaged();
        this._prState = PrState.Staged();
    }

    // Updates PR GitHub attributes and merges it into base
    // in case of successfully passed CI checks.
    async _mergeStaged() {
        this._breadcrumbs.push("merge");

        assert(this._prState.staged());

        // methods below compute fresh labels from scratch
        this._removeTemporaryLabelsSetByAnubis();

        await this.update();
        await this._setApprovalStatus(this._tagSha);
        await this._checkMergePreconditions();
        await this._mergeToBase();
    }

    // Maintain Anubis-controlled PR metadata.
    // If possible, also merge or advance the PR towards merging.
    // The caller must follow up with _pushLabelsToGitHub()!
    async _doProcess() {
        this._breadcrumbs.push("load");
        await this._loadTag();
        await this._loadLabels();
        await this._loadPrState();
        this._log("PR state: " + this._prState);

        if (this._prState.preStaged()) {
            await this._stage();
            assert(this._prState.staged());
        }

        if (this._prState.staged())
            await this._mergeStaged();

        assert(this._prState.postStaged());
        await this._finalize();
    }

    async process() {
        try {
            await this._doProcess();
            return StepResult.Succeed();
        } catch (e) {
            const knownProblem = e instanceof PrProblem;

            if (knownProblem && e.hasResult())
                this._log(e.result); // may be null
            else
                Log.LogError(e, this._toString() + " process() failure"); // TODO: Convert into a method

            // (by default) get rid of the failed staging tag (if any)
            if (!(knownProblem && e.keepStagedRequested()) &&
                !this._prState.preStaged() &&
                !this._dryRun("cleanup failed staging tag")) {
                await GH.deleteReference(this._stagingTag())
                    .catch(deleteReferenceError => {
                        // TODO: Test that this catch indeed catches deleteReference exceptions
                        Log.LogError(deleteReferenceError, this._toString() +
                            " ignoring deleteReference() error while handling a higher-level error");
                    });
            }

            if (knownProblem && e.hasResult())
                return e.result; // may be null

            // report this unknown but probably PR-specific problem to GitHub
            // XXX: We may redo this PR every run() step forever.
            // TODO: Process Config.failedOtherLabel() PRs last.
            if (!knownProblem)
                this._labels.add(Config.failedOtherLabel());

            throw e;
        } finally {
            await this._pushLabelsToGitHub();
        }
    }

    // remove intermediate step labels that may be set by us
    _removeTemporaryLabelsSetByAnubis() {
        // set by humans: Config.clearedForMergeLabel();
        this._labels.remove(Config.failedDescriptionLabel());
        this._labels.remove(Config.failedOtherLabel());
        this._labels.remove(Config.failedStagingChecksLabel());
        this._labels.remove(Config.passedStagingChecksLabel());
        this._labels.remove(Config.waitingStagingChecksLabel());
        // final (set after the PR is merged): Config.mergedLabel()
    }

    // somebody else appears to perform Anubis-only PR manipulations
    _exLostControl(why) {
        assert(arguments.length === 1);
        this._labelPushBan = why;
        assert(this._labelPushBan); // paranoid: `why` is truthy
        return new PrProblem(why);
    }

    // a problem that humans can discern via GitHub-maintained PR state
    _exObviousFailure(why) {
        assert(arguments.length === 1);
        return new PrProblem(why);
    }

    // a problem that humans cannot easily detect without an Anubis-set label
    _exLabeledFailure(why, label) {
        assert(arguments.length === 2);
        assert(!this._labelPushBan);
        this._labels.add(label);
        return new PrProblem(why);
    }

    // an obstacle that we are likely to overcome by reprocessing from scratch
    _exRetry(why) {
        assert(arguments.length === 1);
        let problem = new PrProblem(why);
        problem.setResult(null);
        return problem;
    }

    // an obstacle that should eventually disappear; GitHub will inform us
    _exSuspend(why) {
        assert(arguments.length === 1);
        let problem = new PrProblem(why);
        problem.setResult(StepResult.Suspend());
        problem.requestToKeepStaged();
        return problem;
    }

    // an obstacle that should disappear in delayMs; GitHub will not inform us
    _exDelay(why, delayMs) {
        assert(arguments.length === 2);
        let problem = new PrProblem(why);
        problem.setResult(StepResult.Delay(delayMs));
        problem.requestToKeepStaged();
        return problem;
    }
}

module.exports = {
    PullRequest: PullRequest
};


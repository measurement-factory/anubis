const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');

// Action outcome, with support for paused and snoozed actions.
// For example, is returned by PullRequest.process() (at higher level) or
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

// aggregates (required) status checks for a PR or commit
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

// Cached label state
class Label
{
    constructor(name, on, old) {
        this.name = name;
        this.on = on; // current state
        // whether this label was received from GitHub or created by the bot
        this.old = old;
    }

    toString() {
        return this.name + "(on: " + this.on + "; old: " + this.old + ")";
    }
}

// Keeps labels state (received from GitHub), caches labels modifications
// and applies them back to GitHub
class Labels
{
    // labels parameter keeps label array received from GitHub
    constructor(labels, prNum) {
        this._prNum = prNum;
        this._labels = [];
        for (let label of labels)
            this._doCache(label.name, true, true);
    }

    _doCache(name, on, old) {
        const label = this._labels.find(lbl => lbl.name === name);
        if (label)
            label.on = on;
        else {
            if (on)
                this._labels.push(new Label(name, on, old));
        }
    }

    // changes the cached label state (or adds it to the cache)
    cache(name, on) { this._doCache(name, on, false); }

    // whether the label is cached and 'on'
    has(name) {
        const label = this._labels.find(lbl => lbl.name === name);
        return label && label.on;
    }

    // removes a single label from GitHub
    async _remove(name) {
        try {
            await GH.removeLabel(name, this._prNum);
        } catch (e) {
            if (e.name === 'ErrorContext' && e.notFound()) {
                Log.LogException(e, "_remove: " + name + " not found");
                return;
            }
            throw e;
        }
    }

    // adds a single label to GitHub
    async _add(name) {
        let params = Util.commonParams();
        params.number = this._prNum;
        params.labels = [];
        params.labels.push(name);

        await GH.addLabels(params);
    }

    // applies all cached labels to GitHub
    async apply() {
        for (let label of this._labels) {
            if (label.old && !label.on)
                await this._remove(label.name);
            if (!label.old && label.on)
                await this._add(label.name);
        }
    }

    toString() {
        let str = "";
        for (let label of this._labels) {
            if ( (label.old && !label.on) || (!label.old && label.on)) {
                if (str.length)
                    str += ", ";
                str += label.toString();
            }
        }
        if (!str.length)
            return "no pending labels";
        return "pending labels: " + str;
    }
}

// manage pull request states, one of:
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

class PullRequest {

    constructor(pr) {
        // may lack pr.mergeable, see _refreshPr()
        this._rawPr = pr;
        this._shaLimit = 6;
        // information used for approval test status creation/updating
        this._approval = null;

        // optimization: cached _getRequiredContexts() result
        this._requiredContextsCache = null;

        this._tagSha = null;
        this._tagFresh = null;
        this._compareStatus = null;
        this._stagingSha = null;

        // optimization: cached _tagCommit() result
        this._tagCommitCache = null;

        // "initiator", "updater", "stager", "merger" or "finalizer" (for debugging only)
        this._role = "initiator";
        this._messageValid = null;

        this._prState = null; // calculated PrState

        this._labels = null;
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

    // Tries to load 'staging tag' (and related information) for the PR.
    async _loadTag() {
       try {
           if (this._tagSha)
               return;
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

    // Checks 'staging tag' state as merge precondition.
    // Returns true if there is a fresh merge commit with failed status checks.
    async _previousStagingFailed() {
        await this._loadTag();
        if (!this._tagSha)
            return false;

        if (this._tagFresh) {
            const commitStatus = await this._getStagingStatuses();
            this._log("staging status details: " + commitStatus);
            if (commitStatus.failed()) {
                this._log("staging checks failed some time ago");
                if (this._prMergeable() !== true)
                    this._log("merge commit did not change due to conflicts with " + this._prBaseBranch());
                return true;
            }
        }
        if (!this._dryRun("deleting staging commit"))
            await GH.deleteReference(this._stagingTag());
        return false;
    }

    // Checks whether this PR is still opened and ready for processing (i.e.,
    // not marked with 'wip' or other similar markers).
    // Is used for both merging and staging actions.
    // Do not use for post-staged.
    async _checkActive() {
        await this._refreshPr();

        if (!this._prOpen()) {
            this._logFailedCondition("opened");
            return false;
        }

        if (this._labels.has(Config.mergedLabel(), this._prNumber())) {
            this._logFailedCondition("already marked with " + Config.mergedLabel);
            return false;
        }

        if (this._wipPr()) {
            this._logFailedCondition("work-in-progress");
            return false;
        }

        return true;
    }

    // whether the PR should be staged (including re-staged)
    async _checkPreconditions() {
        this._log("checking preconditions");

        if (!(await this._checkActive()))
            return StepResult.Fail();

        if (!this._prMergeable()) {
            this._logFailedCondition("mergeable");
            return StepResult.Fail();
        }

        if (await this._previousStagingFailed()) {
            this._logFailedCondition("lack of fresh staging commit with failed checks");
            return StepResult.Fail();
        }

        const statusChecks = await this._getPrStatuses();
        if (statusChecks.failed())
            return StepResult.Fail();

        if (!this._messageValid) {
            this._logFailedCondition("valid commit message");
            return StepResult.Fail();
        }

        if (!this._approval.granted()) {
            this._logFailedCondition("approved");
            return StepResult.Fail();
        }

        if (this._approval.grantedTimeout())
            return StepResult.Delay(this._approval.delayMs);

        if (!statusChecks.final())
            return StepResult.Suspend();

        return StepResult.Succeed();
    }

    // returns filled StepResult object
    async update() {
        this._role = "updater";
        this._messageValid = this._prMessageValid();
        this._log("messageValid: " + this._messageValid);
        this._labelFailedDescription();

        this._approval = await this._checkApproval();
        this._log("checkApproval: " + this._approval);
        await this._setApprovalStatus(this._prHeadSha());
        if (this._prState.staged())
            await this._setApprovalStatus(this._tagSha);

        if (this._approval.grantedTimeout())
            return StepResult.Delay(this._approval.delayMs);

        return StepResult.Succeed();
    }

    // Label manipulation methods

    // applies the cached label state to GitHub
    async _applyLabels() {
        if (this._dryRun("apply labels"))
            return;

        this._log(this._labels.toString());
        if (this._labels)
            await this._labels.apply();
    }

    // Atomize PR post-merge cleanup: suspend this PR
    // until all required operations are complete.
    async _finalize() {
        if (this._dryRun("finalize"))
            return StepResult.Suspend();

        try {
            assert(this._prState.postStaged());
            await this._applyLabels();
            await GH.updatePR(this._prNumber(), 'closed');
            if (this._prState.postStaged())
                await GH.deleteReference(this._stagingTag());
            this._log("finalize completed");
            return StepResult.Succeed();
        } catch (e) {
            Log.LogException(e, this._toString() + " unexpected error while finalizing.");
            return StepResult.Suspend();
        }
    }

    _labelFailedDescription() {
        this._labels.cache(Config.failedDescriptionLabel(), !this._messageValid);
    }

    _unlabelPreconditionsChecking() {
        this._labels.cache(Config.passedStagingChecksLabel(), false);
        this._labels.cache(Config.waitingStagingChecksLabel(), false);
    }

    _unlabelPreconditionsChecked() {
        this._labels.cache(Config.failedOtherLabel(), false);
        this._labels.cache(Config.failedStagingChecksLabel(), false);
        this._labels.cache(Config.failedDescriptionLabel(), false);
    }

    _labelWaitingStagingChecks() {
        this._labels.cache(Config.passedStagingChecksLabel(), false);
        this._labels.cache(Config.waitingStagingChecksLabel(), true);
    }

    _labelMerged() {
        this._labels.cache(Config.waitingStagingChecksLabel(), false);
        this._labels.cache(Config.passedStagingChecksLabel(), false);
        this._labels.cache(Config.clearedForMergeLabel(), false);
        this._labels.cache(Config.mergedLabel(), true);
    }

    _labelFailedOther() {
        this._labels.cache(Config.waitingStagingChecksLabel(), false);
        this._labels.cache(Config.passedStagingChecksLabel(), false);
        this._labels.cache(Config.failedOtherLabel(), true);
    }

    _labelCleanStaged() {
        this._labels.cache(Config.waitingStagingChecksLabel());
        this._labels.cache(Config.passedStagingChecksLabel());
    }

    _labelFailedStagingChecks() {
        this._labels.cache(Config.waitingStagingChecksLabel(), false);
        this._labels.cache(Config.failedStagingChecksLabel(), true);
    }

    _labelPassedStagingChecks() {
        this._labels.cache(Config.waitingStagingChecksLabel(), false);
        this._labels.cache(Config.passedStagingChecksLabel(), true);
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

    _prBody() { return this._rawPr.body.replace(/\r+\n/g, '\n'); }

    _stagingTag() { return Util.StagingTag(this._rawPr.number); }

    _createdAt() { return this._rawPr.created_at; }

    _mergePath() { return "pull/" + this._rawPr.number + "/merge"; }

    _debugString() {
        return "PR" + this._rawPr.number + "(" + this._role + ", " + "head: " + this._rawPr.head.sha.substr(0, this._shaLimit);
    }

    _log(msg) {
        Log.Logger.info(this._debugString() + "):", msg);
    }

    _warn(msg) {
        Log.Logger.warn(this._debugString() + "):", msg);
    }

    _logFailedCondition(cond) {
        this._log("condition '" + cond + "' failed");
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

    async _cleanupFailed(deleteTag, labelsCleanup) {
        if (this._dryRun("cleanup failed merge"))
            return StepResult.Suspend();
        this._log("cleanup on failure...");
        if (labelsCleanup === undefined)
            labelsCleanup = this._labelFailedOther;
        labelsCleanup = labelsCleanup.bind(this);
        labelsCleanup();
        if (deleteTag)
            await GH.deleteReference(this._stagingTag());
        return StepResult.Fail();
    }

    async _cleanupStagingFailed() {
        return await this._cleanupFailed(true, this._labelCleanStaged);
    }

    async _cleanupStagingChecksFailed() {
        return await this._cleanupFailed(false, this._labelFailedStagingChecks);
    }

    async _cleanupMergeFailed() {
        return await this._cleanupFailed(true);
    }

    // returns filled StepResult object
    async _processStagingStatuses() {
        const stagingStatus = await this._getStagingStatuses();
        this._log("staging status details: " + stagingStatus);
        if (stagingStatus.failed()) {
            this._log("staging checks failed");
            return await this._cleanupStagingChecksFailed();
        }
        if (!stagingStatus.final()) {
            this._labelWaitingStagingChecks();
            this._log("waiting for more staging checks completing");
            return StepResult.Suspend();
        }
        assert(stagingStatus.succeeded());
        this._log("staging checks succeeded");
        if (this._dryRun("applying required PR statues to staged"))
            return StepResult.Suspend();
        await this._supplyStagingWithPrRequired(stagingStatus);
        return StepResult.Succeed();
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
    async _stagingOnly() {
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
    async _checkPostconditions() {
        this._log("checking postconditions");

        if (!(await this._checkActive()))
            return await this._cleanupStagingFailed();

        if (!(await this._messageIsFresh()))
            return await this._cleanupStagingFailed();

        const statusChecks = await this._getPrStatuses();
        if (statusChecks.failed())
            return await this._cleanupStagingFailed();

        if (!this._approval.granted()) {
            this._logFailedCondition("approved");
            return await this._cleanupStagingFailed();
        }

        if (this._approval.grantedTimeout())
            return await this._cleanupStagingFailed();

        if (!statusChecks.final())
            return StepResult.Suspend();

        const stagingResult = await this._processStagingStatuses();
        if (!stagingResult.succeeded())
            return stagingResult;

        if (await this._stagingOnly()) {
            this._labelPassedStagingChecks();
            return StepResult.Suspend();
        }
        return StepResult.Succeed();
    }

    async _mergeToBase() {
        assert(this._tagSha);
        assert(this._compareStatus === "ahead");
        this._log("merging to base...");
        try {
            await GH.updateReference(this._prBaseBranchPath(), this._tagSha, false);
            this._prState = PrState.PostStaged();
            return StepResult.Succeed();
        } catch (e) {
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                if (await this._tagDiverged()) {
                    Log.LogException(e, this._toString() + " fast-forwarding failed");
                    return await this._cleanupMergeFailed();
                }
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
        const tempCommitSha = await GH.createCommit(mergeCommit.tree.sha, this._prMessage(), [baseSha], mergeCommit.author, committer);
        this._tagSha = await GH.createReference(tempCommitSha, "refs/" + this._stagingTag());
        this._compareStatus = "ahead";
        await this._setApprovalStatus(this._tagSha);
        await GH.updateReference(Config.stagingBranchPath(), this._tagSha, true);
    }

    // returns filled StepResult object
    async _stage() {
        this._role = "stager";

        this._unlabelPreconditionsChecking();
        const conditions = await this._checkPreconditions();
        if (!conditions.succeeded()) {
            if (conditions.delayed())
                return conditions;
            // for failed() or suspended()
            return StepResult.Fail();
        }
        this._unlabelPreconditionsChecked();
        if (this._dryRun("create staged"))
            return StepResult.Suspend();
        await this._createStaged();
        this._prState = PrState.Staged();
        this._labelWaitingStagingChecks();
        return StepResult.Succeed();
    }

    // returns filled StepResult object
    async _mergeStaged() {
        this._role = "merger";

        let result = await this._checkPostconditions();
        if (result.succeeded())
            result = await this._mergeToBase();
        assert(!result.delayed());
        return result;
    }

    // Maintain Anubis-controlled PR metadata.
    // If possible, also merge or advance the PR towards merging.
    // The caller is responsible for setting PR labels computed here.
    async _doProcess(anotherPrWasStaged) {
        await this._loadTag();
        await this._loadLabels();
        await this._loadPrState();
        this._log("PR state calculated: " + this._prState.toString());
        let result = await this.update();
        if (anotherPrWasStaged) {
            assert(!result.suspended());
            return result.delayed() ? result : StepResult.Fail();
        }

        if (this._prState.preStaged()) {
            result = await this._stage();
            if (!result.succeeded())
                return result;
            assert(this._prState.staged());
        }

        if (this._prState.staged()) {
            result = await this._mergeStaged();
            if (!result.succeeded())
                return result;
            assert(this._prState.postStaged());
        }

        if (this._prState.postStaged()) {
            this._role = "finalizer";
            this._labelMerged();
        }

        return StepResult.Succeed();
    }

    async process(anotherPrWasStaged) {
        let result = null;
        try {
            result = await this._doProcess(anotherPrWasStaged);
        } catch (e) {
            await this._applyLabels();
            throw e;
        }
        if (!this._prState.postStaged())
            this._applyLabels();
        else
            result = await this._finalize();
        return result;
    }
}

module.exports = {
    PullRequest: PullRequest
};


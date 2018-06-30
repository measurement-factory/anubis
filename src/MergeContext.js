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

class PullRequest {

    constructor(pr) {
        this._rawPr = pr;
        this._shaLimit = 6;
        // information used for approval test status creation/updating
        this._approval = null;

        // optimization: cached _getRequiredContexts() result
        this._requiredContextsCache = null;

        this._tagSha = null;
        this._stagingSha = null;

        // optimization: cached _tagCommit() result
        this._tagCommitCache = null;

        this._role = null; // "updater" or "merger" (for debugging only)
        this._messageValid = null;
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

    // Tries to load 'staging tag' for the PR.
    async _loadTag() {
       try {
           if (this._tagSha)
               return;
           this._tagSha = await GH.getReference(this._stagingTag());
       } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               Log.LogException(e, this._toString() + " " + this._stagingTag() + " not found");
           else
               throw e;
       }
    }

    // Checks 'staging tag' state as merge precondition.
    // Returns true if there is a fresh merge commit with failed status checks.
    async __previousStagingFailed() {
        await this._loadTag();
        if (!this._tagSha)
            return false;

        const isFresh = await this._tagIsFresh();
        this._log("staging tag is " + (isFresh ? "fresh" : "stale"));
        if (isFresh) {
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

    async _checkTimelessConditions() {
        if (!this._prOpen()) {
            this._logFailedCondition("not opened");
            return StepResult.Fail();
        }

        if (await this._hasLabel(Config.mergedLabel(), this._prNumber())) {
            this._logFailedCondition("already merged and labeled");
            return StepResult.Fail();
        }
        return StepResult.Succeed();
    }

    // checks whether this PR can be tagged
    async _checkPreconditions() {
        this._log("checking preconditions");

        const pr = await GH.getPR(this._prNumber(), true);
        // refresh PR data
        assert(pr.number === this._prNumber());
        this._rawPr = pr;

        const timelessResult = await this._checkTimelessConditions();
        if (timelessResult.failed())
            return StepResult.Fail();

        if (this._prInProgress()) {
            this._logFailedCondition("not in progress");
            return StepResult.Fail();
        }

        if (!this._prMergeable()) {
            this._logFailedCondition("mergeable");
            return StepResult.Fail();
        }

        if (await this.__previousStagingFailed()) {
            this._logFailedCondition("fresh merge commit with failed staging checks");
            return StepResult.Fail();
        }

        const statusChecks = await this._getPrStatuses();
        if (statusChecks.failed())
            return StepResult.Fail();

        if (!this._messageValid) {
            this._logFailedCondition("commit message");
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
        this._messageValid = this._prMessageValid();
        this._log("messageValid: " + this._messageValid);
        await this._labelFailedDescription();

        this._approval = await this._checkApproval();
        this._log("checkApproval: " + this._approval);
        await this._setApprovalStatus(this._prHeadSha());
        if (await this._isStaging())
            await this._setApprovalStatus(this._tagSha);

        if (this._approval.grantedTimeout())
            return StepResult.Delay(this._approval.delayMs);

        return StepResult.Succeed();
    }

    // Label manipulation methods

    // TODO: Optimize label tests by caching all PR labels.

    async _hasLabel(label) {
        const labels = await GH.getLabels(this._prNumber());
        return labels.find(lbl => lbl.name === label) !== undefined;
    }

    async _removeLabelsIf(labels) {
        const currentLabels = await GH.getLabels(this._prNumber());
        for (let label of labels) {
            if (currentLabels.find(lbl => lbl.name === label) !== undefined)
                await this._removeLabel(label);
            else
                this._log("_removeLabelsIf: skip non-existent " + label);
        }
    }

    async _removeLabel(label) {
        try {
            await GH.removeLabel(label, this._prNumber());
        } catch (e) {
            if (e.name === 'ErrorContext' && e.notFound()) {
                Log.LogException(e, this._toString() + " removeLabel: " + label + " not found");
                return;
            }
            throw e;
        }
    }

    async _addLabel(label) {
        const currentLabels = await GH.getLabels(this._prNumber());
        if (currentLabels.find(lbl => lbl.name === label) !== undefined) {
            this._log("addLabel: skip already existing " + label);
            return;
        }

        let params = Util.commonParams();
        params.number = this._prNumber();
        params.labels = [];
        params.labels.push(label);

        await GH.addLabels(params);
    }

    async _labelFailedDescription() {
        if (this._dryRun("labeling on failed description"))
            return;
        const label = Config.failedDescriptionLabel();
        if (this._messageValid)
            await this._removeLabelsIf([label]);
        else
            await this._addLabel(label);
    }

    async _unlabelPreconditionsChecking() {
        await this._removeLabelsIf([
                Config.passedStagingChecksLabel(),
                Config.waitingStagingChecksLabel()
                ]);
    }

    async _unlabelPreconditionsChecked() {
        await this._removeLabelsIf([
                Config.failedOtherLabel(),
                Config.failedStagingChecksLabel(),
                Config.failedDescriptionLabel()
                ]);
    }

    async _labelWaitingStagingChecks() {
        await this._removeLabelsIf([
                Config.passedStagingChecksLabel()
                ]);
        await this._addLabel(Config.waitingStagingChecksLabel());
    }

    async _labelMerged() {
        await this._removeLabelsIf([
                Config.waitingStagingChecksLabel(),
                Config.passedStagingChecksLabel(),
                Config.clearedForMergeLabel()
                ]);
        await this._addLabel(Config.mergedLabel());
    }

    async _labelFailedOther() {
        await this._removeLabelsIf([
                Config.waitingStagingChecksLabel(),
                Config.passedStagingChecksLabel()
                ]);
        await this._addLabel(Config.failedOtherLabel());
    }

    async _labelCleanStaged() {
        await this._removeLabelsIf([
                Config.waitingStagingChecksLabel(),
                Config.passedStagingChecksLabel()
        ]);
    }

    async _labelFailedStagingChecks() {
        await this._removeLabelsIf([ Config.waitingStagingChecksLabel() ]);
        await this._addLabel(Config.failedStagingChecksLabel());
    }

    async _labelPassedStagingChecks() {
        await this._removeLabelsIf([ Config.waitingStagingChecksLabel() ]);
        await this._addLabel(Config.passedStagingChecksLabel());
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

    _prInProgress() { return this._rawPr.title.startsWith('WIP:'); }

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

    async _isStaging() {
        if (!this._tagSha)
            return false;
        if (!this._stagingSha)
            this._stagingSha = await GH.getReference(Config.stagingBranchPath());
        return this._stagingSha === this._tagSha;
    }

    // Whether the commit message configuration remained intact since staging.
    async _messageIsFresh() {
        const tagCommit = await this._tagCommit();
        const result = this._prMessage() === tagCommit.message;
        this._log("tag message freshness: " + result);
        return result;
    }

    // Adjusts the successfully merged PR (labels, status, tag).
    async _cleanupMerged() {
        if (this._dryRun("cleanup merged"))
            return StepResult.Suspend();

        this._log("merged, cleanup...");
        await this._labelMerged();
        await GH.updatePR(this._prNumber(), 'closed');
        await GH.deleteReference(this._stagingTag());
        return StepResult.Succeed();
    }

    async _cleanupMergeFailed(deleteTag, labelsCleanup) {
        if (this._dryRun("cleanup merge failed"))
            return StepResult.Suspend();
        this._log("merge failed, cleanup...");
        if (labelsCleanup === undefined)
            labelsCleanup = this._labelFailedOther;
        labelsCleanup = labelsCleanup.bind(this);
        await labelsCleanup();
        if (deleteTag)
            await GH.deleteReference(this._stagingTag());
        return StepResult.Fail();
    }

    // returns filled StepResult object
    async _processStagingStatuses() {
        const stagingStatus = await this._getStagingStatuses();
        this._log("staging status details: " + stagingStatus);
        if (stagingStatus.failed()) {
            this._log("staging checks failed");
            return await this._cleanupMergeFailed(false, this._labelFailedStagingChecks);
        }
        if (!stagingStatus.final()) {
            if (!this._dryRun("setting M-wating-staging-checks label"))
                await this._labelWaitingStagingChecks();
            this._log("waiting for more staging checks completing");
            return StepResult.Suspend();
        }
        assert(stagingStatus.succeeded());
        this._log("staging checks succeeded");
        if (this._dryRun("finish processing"))
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
        const msg = "finalize merging";

        if (Config.stagedRun()) {
            this._log("skip " + msg + " due to staged_run option");
            return true;
        }

        if (Config.guardedRun()) {
            if (await this._hasLabel(Config.clearedForMergeLabel(), this._prNumber())) {
                this._log("allow " + msg + " due to " + Config.clearedForMergeLabel() + " overruling guarded_run option");
                return false;
            }
            this._log("skip " + msg + " due to guarded_run option");
            return true;
        }

        return false; // no staging-only mode by default
    }

    // checks whether this tagged PR can be merged
    async _checkPostconditions() {
        this._log("checking postconditions");
        const pr = await GH.getPR(this._prNumber(), true);
        // refresh PR data
        assert(pr.number === this._rawPr.number);
        this._rawPr = pr;

        const timelessResult = await this._checkTimelessConditions();
        if (timelessResult.failed())
            return StepResult.Fail();

        if (!(await this._isStaging())) {
            this._logFailedCondition("no longer staged");
            return StepResult.Fail();
        }

        const compareStatus = await GH.compareCommits(this._prBaseBranch(), this._stagingTag());
        if (compareStatus === "identical" || compareStatus === "behind") {
            this._logFailedCondition("already merged (but not yet labeled)");
            return await this._cleanupMerged();
        }

        if (!(await this._tagIsFresh()))
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);

        if (!(await this._messageIsFresh()))
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);

        if (this._prInProgress()) {
            this._logFailedCondition("work-in-progress");
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);
        }

        const statusChecks = await this._getPrStatuses();
        if (statusChecks.failed())
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);

        if (!this._approval.granted()) {
            this._logFailedCondition("approved");
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);
        }

        if (this._approval.grantedTimeout())
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);

        if (!statusChecks.final())
            return StepResult.Suspend();

        assert(compareStatus === "ahead");

        const stagingResult = await this._processStagingStatuses();
        if (!stagingResult.succeeded())
            return stagingResult;

        if (await this._stagingOnly()) {
            await this._labelPassedStagingChecks();
            return StepResult.Suspend();
        }
        return StepResult.Succeed();
    }

    async _mergeToBase() {
        assert(this._tagSha);
        this._log("merging to base...");
        try {
            await GH.updateReference(this._prBaseBranchPath(), this._tagSha, false);
            return StepResult.Succeed();
        } catch (e) {
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                if (await this._tagDiverged()) {
                    Log.LogException(e, this._toString() + " fast-forwarding failed");
                    return await this._cleanupMergeFailed(true);
                }
            }
            throw e;
        }
    }

    // Start processing

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
        this._log("start staging...");
        const baseSha = await GH.getReference(this._prBaseBranchPath());
        const mergeSha = await GH.getReference("pull/" + this._prNumber() + "/merge");
        const mergeCommit = await GH.getCommit(mergeSha);
        if (!Config.githubUserName())
            await this._acquireUserProperties();
        let now = new Date();
        const committer = {name: Config.githubUserName(), email: Config.githubUserEmail(), date: now.toISOString()};
        const tempCommitSha = await GH.createCommit(mergeCommit.tree.sha, this._prMessage(), [baseSha], mergeCommit.author, committer);
        this._tagSha = await GH.createReference(tempCommitSha, "refs/" + this._stagingTag());
        await this._setApprovalStatus(this._tagSha);
        await GH.updateReference(Config.stagingBranchPath(), this._tagSha, true);
    }

    // returns filled StepResult object
    async _stage() {
        if (!this._dryRun("reset labels before precondition checking"))
            await this._unlabelPreconditionsChecking();

        const conditions = await this._checkPreconditions();
        if (!conditions.succeeded())
            return conditions;

        if (this._dryRun("start merging"))
            return StepResult.Suspend();

        await this._unlabelPreconditionsChecked();
        await this._createStaged();
        await this._labelWaitingStagingChecks();

        return StepResult.Succeed();
    }

    // Finish processing

    // returns filled StepResult object
    async _finishProcessing() {
        const conditions = await this._checkPostconditions();
        if (!conditions.succeeded())
            return conditions;

        const result = await this._mergeToBase();
        if (!result.succeeded())
            return result;

        this._log("merged successfully");
        return await this._cleanupMerged();

    }

    // StepResult.Succeed: this PR is in-progress
    // StepResult.Delay: this PR is delayed
    // StepResult.Fail: all other cases
    async process(running) {
        this._role = "updater";
        await this._loadTag();
        let result = await this.update();
        if (running)
            return result.delayed() ? result : StepResult.Fail();

        if (await this._isStaging()) {
            this._role = "finalizer";
            result = await this._finishProcessing();
            assert(!result.delayed());
            if (result.succeeded() || result.failed())
                return StepResult.Fail();
            // This result is when one of 'dry run' bot options is on.
            // Will wait while this option is on the way.
            assert(result.suspended());
        } else {
            this._role = "initiator";
            result = await this._stage();
            if (result.failed() || result.suspended())
                return StepResult.Fail();
            if (result.delayed())
                return result;
            assert(result.succeeded());
        }
        return StepResult.Succeed();
    }
}

module.exports = {
    PullRequest: PullRequest
};


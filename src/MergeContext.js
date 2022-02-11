const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');


// Process() outcome
class ProcessResult
{
    constructor() {
        this._delayMs = null; // reprocess in that many milliseconds
        this._prStaged = null; // this PR holds the lock on the staging branch
    }

    delayed() {
        return this._delayMs !== null;
    }

    delayMs() {
        assert(this.delayed());
        return this._delayMs;
    }

    setDelayMsIfAny(msOrNull) {
        assert(this._delayMs === null);
        if (msOrNull !== null) {
            const ms = msOrNull;
            assert(ms > 0);
            this._delayMs = ms;
        }
    }

    setPrStaged(bool) {
        assert(this._prStaged === null);
        this._prStaged = bool;
    }

    prStaged() {
        return this._prStaged;
    }
}

// Relaying process() outcome to the caller via doProcess() exceptions:
//
// Exception          Abandon  Push-Labels  Result-of-process()
// _exLostControl()     yes      no           approval delay (if any)
// _exObviousFailure()  yes      yes          approval delay (if any)
// _exWaiting()         yes      yes          approval delay (if any)
// _exLabeledFailure()  yes      yes          approval delay (if any)
// _exSuspend()         no       yes          approval delay (if any)
// any-unlisted-above   yes      yes          exception + M-failed-other
// no-exception         no       yes          null delay
//
// Notes:
// "Abandon" means moving on to merging another PR.

// A PR-specific process()ing error.
// A PrProblem thrower must set any appropriate labels.
// Other exceptions get Config.failedOtherLabel() added automatically.
// Babel does not support extending Error; this class requires node v8+.
class PrProblem extends Error {
    constructor(aStatus, message, ...params) {
        super(message, ...params);
        this.name = this.constructor.name;
        // the automated merge status associated with this problem,
        // "failure", "pending" or "success"
        this._status = aStatus;
        Error.captureStackTrace(this, this.constructor);

        this._keepStaged = false; // catcher should preserve the staged commit
        this._label = null; // the label associated with this problem
    }

    keepStagedRequested() { return this._keepStaged; }

    status() { return this._status; }

    setLabel(aLabel) { this._label = aLabel; }

    requestToKeepStaged() {
        assert(!this.keepStagedRequested());
        this._keepStaged = true;
    }

    toString() {
       return this._label ?
          this._label + ' (' + this.message + ')' :
          this.message;
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
        assert(raw.description);
        // raw.target_url may be nil. For example, Jenkins does not provide it
        // in the initial 'pending' status for merge commit, i.e., when the
        // Jenkins job was just created and queued (but has not been started).

        this.context = raw.context;
        this.state = raw.state;
        this.targetUrl = raw.target_url;
        this.description = raw.description;
    }

    failed() { return !(this.pending() || this.success()); }

    success() { return this.state === 'success'; }

    pending() { return this.state === 'pending'; }

    equals(check) {
        return this.context.trim() === check.context.trim() &&
            this.state === check.state &&
            this.targetUrl === check.targetUrl &&
            this.description === check.description;
    }
}

// aggregates a list of 'internal' (i.e., bot-reported) status checks for a PR or commit
class DerivedStatusChecks
{
    constructor(context) {
        this._context = context;
        this._approval = null;
        this._automated = null;
    }

    // creates a StatusCheck from Approval
    // returns true if the check was successfully created
    // does nothing (returning false) if the check already exists
    addApproval(approval) {
        if (!Config.manageApprovalStatus())
            return false;

        let newCheck = DerivedStatusChecks.CreateApproval(approval);

        if (!this._approval) {
            this._approval = newCheck;
            return true;
        }

        if (this._approval.equals(newCheck))
            return false;

        this._approval = newCheck;
        return true;
    }

    // adds an internal StatusCheck
    // does nothing (returning false) if the check is not internal or already exists
    add(newCheck) {
        if (!DerivedStatusChecks.Has(newCheck.context))
            return false;

        let oldCheck = this._get(newCheck);
        if (!oldCheck) {
            this._set(newCheck);
            return true;
        }

        if (oldCheck.equals(newCheck))
            return false;

        oldCheck = newCheck;
        return true;
    }

    _get(check) {
        assert(DerivedStatusChecks.Has(check.context));
        return (check.context === Config.automatedMergeStatusContext()) ?
            this._automated : this._approval;
    }

    _set(check) {
        assert(DerivedStatusChecks.Has(check.context));
        if (check.context === Config.automatedMergeStatusContext())
            this._automated = check;
        else
            this._approval = check;
    }

    // creates the 'automated merge' status check
    static CreateAutomated(state, description) {
        assert(state);
        assert(description);
        const raw = {
            state: state,
            target_url: Config.automatedMergeStatusUrl(),
            description: description,
            context: Config.automatedMergeStatusContext()
        };
        return new StatusCheck(raw);
    }

    // creates the 'approval' status check from Approval
    static CreateApproval(approval) {
        assert(approval);
        const raw = {
            state: approval.state,
            target_url: Config.approvalUrl(),
            description: approval.description,
            context: Config.approvalContext()
        };
        return new StatusCheck(raw);
    }

    // whether the context belongs to an internal status check
    static Has(context) {
        return (Config.manageApprovalStatus() && context === Config.approvalContext()) ||
               (Config.manageAutomatedMergeStatus() && context === Config.automatedMergeStatusContext());
    }

    toString() {
        let statuses = "";
        if (this._approval)
            statuses += this._approval.context + ": " + this._approval.state + "(" + this._approval.description + ")";
        if (this._automated) {
            if (statuses)
                statuses += ", ";
            statuses += this._automated.context + ": " + this._automated.state + "(" + this._automated.description + ")";
        }
        return "context: " + this._context + " checks: " + statuses;
    }
}

// aggregates 'external' (i.e., reported by a CI) status checks for a PR or staged commit
// does not include bot-reported 'internal' checks (approvals, etc.)
class StatusChecks
{
    // expectedStatusCount:
    //   for staged commits: the bot-configured number of required(external) checks (Config.stagingChecksCI()),
    //   for PR commits: GitHub configured number of required(external) checks (requested from GitHub)
    // context: either "PR" or "Staging";
    constructor(expectedStatusCount, context) {
        assert(expectedStatusCount !== undefined);
        assert(expectedStatusCount !== null);
        assert(context);
        this._expectedStatusCount = expectedStatusCount;
        this.context = context;
        this.requiredStatuses = [];
        this.optionalStatuses = [];
    }

    addRequiredStatus(requiredStatus) {
        assert(requiredStatus);
        assert(!this.hasStatus(requiredStatus.context));
        this.requiredStatuses.push(requiredStatus);
    }

    addOptionalStatus(optionalStatus) {
        assert(optionalStatus);
        assert(!this.hasStatus(optionalStatus.context));
        this.optionalStatuses.push(optionalStatus);
    }

    hasStatus(context) {
        return this.requiredStatuses.some(el => el.context.trim() === context.trim()) ||
            this.optionalStatuses.some(el => el.context.trim() === context.trim());
    }

    // no more required status changes or additions are expected
    final() {
        return (this.requiredStatuses.length >= this._expectedStatusCount) &&
            this.requiredStatuses.every(check => !check.pending());
    }

    // something went wrong with at least one of the required status checks
    failed() {
        return this.requiredStatuses.some(check => check.failed());
    }

    // the results are final and all checks were a success
    succeeded() {
        return this.final() && this.requiredStatuses.every(check => check.success());
    }

    progressString() {
        const succeeded = this.requiredStatuses.filter(check => check.success());
        const pending = this.requiredStatuses.filter(check => check.pending());
        const failed = this.requiredStatuses.filter(check => check.failed());
        return succeeded.length + " succeeded, " + pending.length + " pending, " + failed.length + " failed out of " + this._expectedStatusCount;
    }

    toString() {
        let combinedStatus = "context: " + this.context + " expected/required/optional: " + this._expectedStatusCount + "/" +
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
    present() { return this._presentHere; }

    needsRemovalFromGitHub() { return this._presentOnGitHub && !this._presentHere; }

    needsAdditionToGitHub() { return !this._presentOnGitHub && this._presentHere; }

    markAsAdded() { this._presentOnGitHub = true; }

    markForRemoval() { this._presentHere = false; }

    markForAddition() { this._presentHere = true; }
}

// Pull request labels. Hides the fact that some labels may be kept internally
// while appearing to be unset for high-level code. By default, delays
// synchronization with GitHub to help GitHub aggregate human-readable label
// change reports.
class Labels
{
    // the labels parameter is the label array received from GitHub
    constructor(labels, prNum) {
        this._prNum = prNum;
        this._labels = labels.map(label => new Label(label.name, true));
    }

    // adding a previously added or existing label is a no-op
    add(name) {
        let label = this._find(name);
        if (label) {
            label.markForAddition();
        } else {
            label = new Label(name, false);
            this._labels.push(label);
        }
        return label;
    }

    // adds a label, updating GitHub without waiting for pushToGitHub()
    async addImmediately(name) {
        const label = this.add(name);
        if (label.needsAdditionToGitHub())
            await this._addToGitHub(label);
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
                    await this._addToGitHub(label); // TODO: Optimize to add all labels at once
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
    async _addToGitHub(label) {
        let params = Util.commonParams();
        params.number = this._prNum;
        params.labels = [];
        params.labels.push(label.name);

        await GH.addLabels(params);

        label.markAsAdded();
    }

    _find(name) { return this._labels.find(label => label.name === name); }
}

// A state of an open pull request (with regard to merging progress). One of:
// brewing: neither staged nor merged;
// staged: with a staged commit that may be merged into the base branch either
//         immediately or after successful tests completion;
// merged: with a staged commit that has been merged into the base branch.
// Here, PR "staged commit" is a commit at the tip of the staging branch
// with commit title ending with the PR number (see PrNumberRegex).
class PrState
{
    // treat as private; use static methods below instead
    constructor(state) {
        this._state = state;
    }

    static Brewing() { return new PrState(-1); }
    static Staged() { return new PrState(0); }
    static Merged() { return new PrState(1); }

    brewing() { return this._state < 0; }
    staged() { return this._state === 0; }
    merged() { return this._state > 0; }

    toString() {
        if (this.brewing())
            return "brewing";
        if (this.staged())
            return "staged";
        assert(this.merged());
        return "merged";
    }
}

// Determines the feature branch position relative to its base branch: ahead,
// merged, or diverged. This class essentially decides whether/which one of
// the two branches is fully contained in another.
class BranchPosition
{
    constructor(baseRef, featureRef) {
        assert(baseRef !== featureRef);
        this._baseRef = baseRef;
        this._featureRef = featureRef;
        this._status = null;
    }

    async compute() {
        this._status = await GH.compareCommits(this._baseRef, this._featureRef);
    }

    // feature > base:
    // the feature branch contains the base branch and some additional commits
    ahead() {
        assert(this._status);
        return this._status === "ahead";
    }

    // feature <= base:
    // either both branches point to same commit (e.g., just merged) or
    // there are new commits on base since the feature branch was merged
    merged() {
        assert(this._status);
        return this._status === "identical" || this._status === "behind";
    }

    // neither ahead nor merged:
    // both base and the feature branch have unique-to-them commits
    diverged() {
        assert(this._status);
        // this._status should be "diverged", but we also handle any new/unexpected statuses here
        return !(this.ahead() || this.merged());
    }
}

// a single GitHub pull request
class PullRequest {

    constructor(pr, banStaging) {
        this._rawPr = pr; // may be rather old and lack pr.mergeable; see _loadRawPr()

        this._shaLimit = 6; // how many SHA chars to show in debug messages

        this._approval = null; // future Approval object

        // optimization: cached _getRequiredContexts() result
        this._requiredContextsCache = null;

        this._stagedPosition = null;

        // this PR staged commit received from GitHub, if any
        this._stagedCommit = null;

        // major methods we have called, in the call order (for debugging only)
        this._breadcrumbs = [];

        this._messageValid = null;

        this._prState = null; // calculated PrState

        this._labels = null;

        // while unexpected, PR merging and closing is not prohibited when staging is
        this._stagingBanned = banStaging;

        // GitHub 'external' statuses of the staged commit
        this._stagedStatuses = null;

        // GitHub 'external' statuses of the PR branch head commit
        this._prStatuses = null;

        // GitHub 'internal' statuses of the staged commit
        this._derivedStagedStatuses = null;

        // GitHub 'internal' statuses of the PR branch head commit
        this._derivedPrStatuses = null;

        this._updated = false; // _update() has been called

        // truthy value contains a reason for disabling _pushLabelsToGitHub()
        this._labelPushBan = false;
    }

    // this PR will need to be reprocessed in this many milliseconds
    // returns null if this PR does not need to be reprocessed on a timer
    _delayMs() {
        if (this._approval && this._approval.grantedTimeout())
            return this._approval.delayMs; // always positive
        return null;
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
            if (!pushCollaborators.find(el => el.login === review.user.login))
                continue;

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

    async _setApprovalStatuses() {
        if (!Config.manageApprovalStatus())
            return;

        await this._createApprovalStatus(this._prHeadSha());
        if (this._stagedSha())
            await this._createApprovalStatus(this._stagedSha());
    }

    async _createApprovalStatus(sha) {
        if (this._dryRun("creating approval status"))
            return;

        assert(sha);
        let derivedStatuses = this._derivedStatuses(sha);
        assert(derivedStatuses);

        if (derivedStatuses.addApproval(this._approval))
            await GH.createStatus(sha, this._approval.state, Config.approvalUrl(), this._approval.description, Config.approvalContext());
    }

    _derivedStatuses(sha) {
        return (sha === this._prHeadSha()) ? this._derivedPrStatuses : this._derivedStagedStatuses;
    }

    _waitingForStagingTestsMsg() {
        assert(this._stagedStatuses);
        return "waiting for staging tests (" + this._stagedStatuses.progressString() + ")";
    }

    async _setAutomatedStepBrewing() {
        assert(this._prState.brewing());
        const prCheck = DerivedStatusChecks.CreateAutomated("pending", "not staged yet");
        await this._applyAutomatedStatus(prCheck, this._prHeadSha());
        // staged commit does not exist yet
    }

    async _setAutomatedStepStaged() {
        assert(this._prState.staged());
        const prCheck = DerivedStatusChecks.CreateAutomated("pending", "staged at " + this._stagedShaBrief());
        await this._applyAutomatedStatus(prCheck, this._prHeadSha());

        assert(this._stagedStatuses);
        if (!this._stagedStatuses.final() && !this._stagedStatuses.failed()) {
            const stagedCheck = DerivedStatusChecks.CreateAutomated("pending", this._waitingForStagingTestsMsg());
            await this._applyAutomatedStatus(stagedCheck, this._stagedSha());
        }
        // other cases (errors or final_success) are handled elsewhere
    }

    async _setAutomatedStepMerged() {
        assert(this._prState.merged());
        const check = DerivedStatusChecks.CreateAutomated("success", Config.mergedLabel());
        await this._applyAutomatedStatus(check, this._prHeadSha());
        if (this._stagedSha())
            await this._applyAutomatedStatus(check, this._stagedSha());
    }

    async _setAutomatedForProblem(problem) {
        if (!Config.manageAutomatedMergeStatus())
            return;

        const prCheck = DerivedStatusChecks.CreateAutomated(problem.status(),
                (this._prState && this._prState.staged()) ? "staged at " + this._stagedShaBrief() : problem.toString());
        await this._applyAutomatedStatus(prCheck, this._prHeadSha());

        if (this._stagedSha()) {
            const stagedCheck = DerivedStatusChecks.CreateAutomated(problem.status(), problem.toString());
            await this._applyAutomatedStatus(stagedCheck, this._stagedSha());
        }
    }

    async _setAutomatedForStaged(state, description) {
        if (!Config.manageAutomatedMergeStatus())
            return;
        assert(this._stagedSha());
        const check = DerivedStatusChecks.CreateAutomated(state, description);
        await this._applyAutomatedStatus(check, this._stagedSha());
    }

    async _applyAutomatedStatus(check, sha) {
        if (this._dryRun("creating automated merge status"))
            return;

        let derivedStatuses = this._derivedStatuses(sha);
        // Statuses may be still empty after an early unknown error.
        // We should avoid updating the automated status until this general
        // (and possibly PR-unrelated) problem is resolved.
        if (!derivedStatuses)
            return;

        assert(DerivedStatusChecks.Has(check.context));
        if (derivedStatuses.add(check))
            await GH.createStatus(sha, check.state, check.targetUrl, check.description, check.context);
        else
            this._log("_applyAutomatedStatus: skip duplicate " + check.context + ": " + check.description);
    }

    async _getRequiredContexts() {
        if (this._requiredContextsCache)
            return this._requiredContextsCache;

        try {
            this._requiredContextsCache = await GH.getProtectedBranchRequiredStatusChecks(this._prBaseBranch());
        } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               this._logEx(e, "no status checks are required");
           else
               throw e;
        }

        if (this._requiredContextsCache === undefined)
            this._requiredContextsCache = [];

        assert(this._requiredContextsCache);
        this._log("required contexts found: " + this._requiredContextsCache.length);
        return this._requiredContextsCache;
    }

    async _getPrStatuses() {
        const requiredContexts = await this._getRequiredContexts();
        const combinedPrStatus = await GH.getStatuses(this._prHeadSha());
        this._derivedPrStatuses = new DerivedStatusChecks("PR");
        this._prStatuses = new StatusChecks(requiredContexts.length - Config.derivativeRequiredChecks(), "PR");
        // fill with required status checks
        for (let st of combinedPrStatus.statuses) {
            const check = new StatusCheck(st);
            if (DerivedStatusChecks.Has(st.context)) {
                this._derivedPrStatuses.add(check, "PR");
                continue;
            }
            if (requiredContexts.some(el => el.trim() === st.context.trim()))
                this._prStatuses.addRequiredStatus(check);
            else
                this._prStatuses.addOptionalStatus(check);
        }
        this._log("pr internal status details: " + this._derivedPrStatuses);
        this._log("pr external status details: " + this._prStatuses);
    }

    async _getStagingStatuses() {
        const combinedStagingStatuses = await GH.getStatuses(this._stagedSha());
        const genuineStatuses = combinedStagingStatuses.statuses.filter(st =>
                !st.description.endsWith(Config.copiedDescriptionSuffix()));
        assert(genuineStatuses.length <= Config.stagingChecks()); // PR approval
        this._derivedStagedStatuses = new DerivedStatusChecks("Staging");
        this._stagedStatuses = new StatusChecks(Config.stagingChecksCI(), "Staging");
        // all genuine checks are 'required'
        for (let st of genuineStatuses) {
            const check = new StatusCheck(st);
            if (DerivedStatusChecks.Has(st.context))
                this._derivedStagedStatuses.add(check, "staged");
            else
                this._stagedStatuses.addRequiredStatus(check);
        }

        const optionalStatuses = combinedStagingStatuses.statuses.filter(st => st.description.endsWith(Config.copiedDescriptionSuffix()));
        for (let st of optionalStatuses) {
            const check = new StatusCheck(st);
            if (DerivedStatusChecks.Has(st.context))
                this._derivedStagedStatuses.add(check, "staged");
            else
                this._stagedStatuses.addOptionalStatus(check);
        }

        this._log("staging internal status details: " + this._derivedStagedStatuses);
        this._log("staging external status details: " + this._stagedStatuses);
    }

    // Determines whether the existing staged commit is equivalent to a staged
    // commit that could be created right now. Relies on PR merge commit being fresh.
    // TODO: check whether the staging checks list has changed since the staged commit creation.
    async _stagedCommitIsFresh() {
        assert(this._stagedSha());
        if (this._stagedPosition.ahead() &&
            // check this separately because GitHub does not recreate PR merge commits
            // for conflicted PR branches (leaving stale PR merge commits).
            this._prMergeable() &&
            await this._messageIsFresh()) {

            const prMergeSha = await GH.getReference(this._mergePath());
            const prCommit = await GH.getCommit(prMergeSha);
            // whether the PR branch has not changed
            if (this._stagedCommit.tree.sha === prCommit.tree.sha) {
                this._log("the staged commit is fresh");
                return true;
            }
        }
        this._log("the staged commit is stale");
        return false;
    }

    // loads info about the PR staged commit, if any
    async _loadStaged() {
        assert(!this._stagedSha());
        const stagedSha = await GH.getReference(Config.stagingBranchPath());
        const stagedCommit = await GH.getCommit(stagedSha);
        const prNum = Util.ParsePrNumber(stagedCommit.message);
        if (prNum !== null && this._prNumber().toString() === prNum) {
            this._log("found staged commit " + stagedSha);
            this._stagedCommit = stagedCommit;
            return;
        }
        this._log("staged commit does not exist");
    }

    async _loadLabels() {
        let labels = await GH.getLabels(this._prNumber());
        assert(!this._labels);
        this._labels = new Labels(labels, this._prNumber());
    }

    // stop processing if it is prohibited by a human-controlled label
    _checkForHumanLabels() {
        if (this._labels.has(Config.failedStagingOtherLabel()))
            throw this._exLabeledFailure("an unexpected error during staging some time ago", Config.failedStagingOtherLabel());
    }

    // Checks whether this PR is still open and still wants to be merged.
    // This is a common part of staging and merging precondition checks.
    async _checkActive() {
        if (!this._prOpen())
            throw this._exLostControl("unexpected closure");

        if (this._labels.has(Config.mergedLabel()))
            throw this._exLostControl("premature " + Config.mergedLabel());
    }

    // whether the PR should be staged (including re-staged)
    async _checkStagingPreconditions() {
        this._log("checking staging preconditions");

        await this._checkActive();

        // TODO: If multiple failures need labeling, label all of them.

        // already checked in _checkForHumanLabels()
        assert(!this._labels.has(Config.failedStagingOtherLabel()));

        if (this._labels.has(Config.failedStagingChecksLabel()))
            throw this._exLabeledFailure("staged commit tests failed some time ago", Config.failedStagingChecksLabel());

        if (this._wipPr())
            throw this._exWaiting("waiting on WIP");

        if (!this._messageValid)
            throw this._exLabeledFailure("invalid commit message", Config.failedDescriptionLabel());

        if (!this._prMergeable())
            throw this._exObviousFailure("GitHub will not be able to merge");

        if (!this._approval.granted())
            throw this._exWaiting("waiting for approval");

        if (this._approval.grantedTimeout())
            throw this._exWaiting("waiting for objections");

        if (this._stagingBanned)
            throw this._exWaiting("waiting for another staged PR");

        if (this._prStatuses.failed())
            throw this._exObviousFailure("failed PR tests");

        if (!this._prStatuses.final())
            throw this._exWaiting("waiting for PR tests");

        assert(this._prStatuses.succeeded());
    }

    // refreshes Anubis-managed part of the GitHub PR state
    async _update() {
        if (this._updated)
            return;

        this._breadcrumbs.push("update");

        assert(!this._prState.merged());

        this._messageValid = this._prMessageValid();
        this._log("messageValid: " + this._messageValid);

        this._approval = await this._checkApproval();
        this._log("checkApproval: " + this._approval);
        await this._setApprovalStatuses();

        this._updated = true;
    }

    // brings GitHub labels in sync with ours
    async _pushLabelsToGitHub() {
        if (this._labels) {
            if (this._labelPushBan) {
                this._log("will not push changed labels: " + this._labelPushBan);
                return;
            }
            this._log("pushing changed labels: " + this._labels.diff());
            if (!this._dryRun("pushing labels"))
                await this._labels.pushToGitHub();
        }
    }

    // cleans up and closes a merged PR, removing it from our radar for good
    async _finalize() {
        this._breadcrumbs.push("finalize");

        assert(this._prState.merged());

        // Clear any positive labels (there should be no negatives here)
        // because Config.mergedLabel() set below already implies that all
        // intermediate processing steps have succeeded.
        this._removeTemporaryLabels();

        this._labels.remove(Config.clearedForMergeLabel());
        this._labels.add(Config.mergedLabel());

        if (!this._dryRun("closing PR"))
            await GH.updatePR(this._prNumber(), 'closed');

        this._log("finalize completed");
    }

    // Getters

    _prNumber() { return this._rawPr.number; }

    _prHeadSha() { return this._rawPr.head.sha; }

    _prMessage() {
        return (this._rawPr.title + ' (#' + this._rawPr.number + ')' + '\n\n' + this._prBody()).trim();
    }

    // returns the position of the first non-ASCII_printable character (or -1)
    _invalidCharacterPosition(str) {
        const prohibitedCharacters = /[^\u{20}-\u{7e}]/u;
        const match = prohibitedCharacters.exec(str);
        return match ? match.index : -1;
    }

    _prMessageValid() {
        // _prBody() removed CRs in CRLF sequences
        // other CRs are not treated specially (and are banned)
        const lines = this._prMessage().split('\n');
        for (let i = 0; i < lines.length; ++i) {
            const line = lines[i];
            const invalidPosition = this._invalidCharacterPosition(line);
            if (invalidPosition !== -1) {
                this._warn(`PR message has an invalid character at line ${i}, offset ${invalidPosition}`);
                return false;
            }
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

    _defaultRepoBranch() { return this._rawPr.base.repo.default_branch; }

    _prMergeable() {
        // requires GH.getPR() call
        assert(this._rawPr.mergeable !== undefined);
        return this._rawPr.mergeable;
    }

    _prBaseBranch() { return this._rawPr.base.ref; }

    _prBaseBranchPath() { return "heads/" + this._prBaseBranch(); }

    _prOpen() { return this._rawPr.state === 'open'; }

    _prBody() {
        if (this._rawPr.body === undefined || this._rawPr.body === null)
            return "";
        return this._rawPr.body.replace(/\r+\n/g, '\n');
    }

    _createdAt() { return this._rawPr.created_at; }

    _mergePath() { return "pull/" + this._rawPr.number + "/merge"; }

    _stagedSha() { return this._stagedCommit ? this._stagedCommit.sha : null; }

    _stagedShaBrief() { return this._stagedSha() ? this._stagedSha().substr(0, this._shaLimit) : null; }

    staged() { return this._prState.staged(); }

    _debugString() {
        const sha = this._stagedShaBrief();
        const staged = sha ? "staged: " + sha + ' ' : "";
        const detail =
            "head: " + this._rawPr.head.sha.substr(0, this._shaLimit) + ' ' + staged +
            "history: " + this._breadcrumbs.join();
        return "PR" + this._rawPr.number + ` (${detail})`;
    }

    // TODO: support variable number of arguments
    _log(msg) {
        Log.Logger.info(this._debugString(), msg);
    }

    // TODO: support variable number of arguments
    _warn(msg) {
        Log.Logger.warn(this._debugString(), msg);
    }

    _logError(e, msg) {
        Log.LogError(e, this._toString() + ' ' + msg);
    }

    _logEx(e, msg) {
        Log.LogException(e, this._toString() + ' ' + msg);
    }

    // TODO: consider moving this and other similar checks
    // directly into GH methods
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
        if (this._stagedSha())
            str += ", staged: " + this._stagedSha().substr(0, this._shaLimit);
        return str + ")";
    }

    _dateForDaysAgo(days) {
        let d = new Date();
        d.setDate(d.getDate() - days);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0'); //January is 0!
        const yyyy = d.getFullYear();
        return yyyy + '-' + mm + '-' + dd;
    }

    /// Checks whether the PR base branch has this PR's staged commit merged.
    async _mergedSomeTimeAgo() {
        const dateSince = this._dateForDaysAgo(100);
        let commits = null;

        if (this._prBaseBranch() === this._defaultRepoBranch()) {
            // Optimization: GitHub can search the default repository branch (which is usually master)
            // by commit message substring
            const query = 'repo:' + Config.owner() + "/" + Config.repo() +
                '+ (#' + this._prNumber() + ')' +
                '+author:' + this._prAuthor() +
                '+committer-date:>' + dateSince;
            commits = await GH.searchCommits(query); // searches the default branch
        } else {
            commits = await GH.getCommits(this._prBaseBranch(), dateSince, this._prAuthor()); // searches any branch
        }

        let mergedSha = null;
        for (let commit of commits) {
            const num = Util.ParsePrNumber(commit.commit.message);
            if (num && num === this._prNumber().toString()) {
                assert(!mergedSha); // the PR can be merged only once
                mergedSha = commit.sha;
            }
        }

        if (mergedSha) {
            this._log("was merged some time ago at " + mergedSha);
            return true;
        }
        return false;
    }

    async _loadPrState() {
        if (!this._stagedSha()) {
            if (await this._mergedSomeTimeAgo())
                await this._enterMerged();
            else
                await this._enterBrewing();
            return;
        }

        assert(this._stagedPosition);

        if (this._stagedPosition.merged()) {
            this._log("already merged into base some time ago");
            await this._enterMerged();
            return;
        }

        // statuses are needed by _setAutomatedForStaged() below
        await this._getStagingStatuses();

        if (!(await this._stagedCommitIsFresh())) {
            const problem = this._exObviousFailure("staged commit tests are stale");
            await this._setAutomatedForStaged(problem.status(), problem.toString());
            await this._enterBrewing();
            return;
        }

        assert(this._stagedPosition.ahead());

        // Do not vainly recreate staged commit which will definitely fail again,
        // since the PR+base code is yet unchanged and the existing errors still persist
        if (this._stagedStatuses.failed()) {
            this._labels.add(Config.failedStagingChecksLabel());
            const problem = this._exLabeledFailure("staged commit tests failed some time ago", Config.failedStagingChecksLabel());
            await this._setAutomatedForStaged(problem.status(), problem.toString());
            await this._enterBrewing();
            return;
        }

        await this._enterStaged();
    }

    async _enterBrewing() {
        this._log("_enterBrewing");
        this._prState = PrState.Brewing();
        this._stagedCommit = null;
        this._stagedStatuses = null;
        this._derivedStagedStatuses = null;
        assert(this._prStatuses === null);
        await this._getPrStatuses();
        // XXX: a problem during 'brewing' will overwrite this automated status,
        // thus creating status duplicates on each run (until the problem is fixed).
        // await this._setAutomatedStepBrewing();
    }

    async _enterStaged() {
        this._log("_enterStaged");
        this._prState = PrState.Staged();
        if (!this._stagedStatuses)
            await this._getStagingStatuses();
        await this._getPrStatuses();
        await this._setAutomatedStepStaged();
    }

    async _enterMerged() {
        this._log("_enterMerged");
        this._prState = PrState.Merged();
        await this._setAutomatedStepMerged();
    }

    // loads raw PR metadata from GitHub
    async _loadRawPr() {
        // GH.getPR() may become slow (and even fail) on merged PRs because
        // GitHub may take its time (or even fail) to calculate pr.mergeable.
        // Fortunately, we do not need that field for merged PRs.
        if (this._stagedSha()) {
           this._stagedPosition = new BranchPosition(this._prBaseBranch(), Config.stagingBranch());
           await this._stagedPosition.compute();
        }
        const waitForMergeable = !(this._stagedPosition && this._stagedPosition.merged());
        const pr = await GH.getPR(this._prNumber(), waitForMergeable);
        assert(pr.number === this._prNumber());
        this._rawPr = pr;
    }

    // Whether the commit message configuration remained intact since staging.
    async _messageIsFresh() {
        const result = this._prMessage() === this._stagedCommit.message;
        this._log("staged commit message freshness: " + result);
        return result;
    }

    async _processStagingStatuses() {
        if (!this._stagedStatuses)
           this._stagedStatuses = new StatusChecks(Config.stagingChecksCI(), "Staging");

        if (this._stagedStatuses.failed())
            throw this._exLabeledFailure("staged commit tests have failed", Config.failedStagingChecksLabel());

        if (!this._stagedStatuses.final()) {
            this._labels.add(Config.waitingStagingChecksLabel());
            throw this._exSuspend(this._waitingForStagingTestsMsg());
        }

        assert(this._stagedStatuses.succeeded());
        this._labels.add(Config.passedStagingChecksLabel());
        this._log("staging checks succeeded");

        await this._supplyStagingWithPrRequired();
    }

    // Creates PR-required status checks for staged commit (if possible).
    // Staged commit needs all PR-required checks (configured on GitHub)
    // so that GitHub could merge it into the protected base branch.
    async _supplyStagingWithPrRequired() {
        assert(this._stagedStatuses.succeeded());

        const requiredContexts = await this._getRequiredContexts();

        for (let requiredContext of requiredContexts) {
            if (this._stagedStatuses.hasStatus(requiredContext)) {
                this._log("_supplyStagingWithPrRequired: skip existing " + requiredContext);
                continue;
            }

            if (DerivedStatusChecks.Has(requiredContext)) {
                this._log("_supplyStagingWithPrRequired: skip internal " + requiredContext);
                continue;
            }

            const requiredPrStatus = this._prStatuses.requiredStatuses.find(el => el.context.trim() === requiredContext.trim());
            assert(requiredPrStatus);
            assert(!requiredPrStatus.description.endsWith(Config.copiedDescriptionSuffix()));

            if (this._dryRun("applying required PR statuses to staged"))
                continue;

            const check = new StatusCheck({
                    state: "success",
                    target_url: requiredPrStatus.targetUrl,
                    description: requiredPrStatus.description + Config.copiedDescriptionSuffix(),
                    context: requiredPrStatus.context
                });

            await GH.createStatus(this._stagedSha(), check.state, check.targetUrl,
                    check.description, check.context);

            this._stagedStatuses.addOptionalStatus(check);
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

        // yes, _checkStagingPreconditions() has checked the same message
        // already, but our _criteria_ might have changed since that check
        if (!this._messageValid)
            throw this._exLabeledFailure("invalid commit message", Config.failedDescriptionLabel());

        if (this._wipPr())
            throw this._exWaiting("waiting on WIP");

        // TODO: unstage only if there is competition for being staged

        // yes, _checkStagingPreconditions() has checked approval already, but
        // humans may have changed their mind since that check
        if (!this._approval.granted())
            throw this._exWaiting("waiting for approval");
        if (this._approval.grantedTimeout())
            throw this._exWaiting("waiting for objections");

        if (this._prStatuses.failed())
            throw this._exObviousFailure("failed PR tests");

        if (!this._prStatuses.final())
            throw this._exSuspend("waiting for PR tests");

        assert(this._prStatuses.succeeded());

        await this._processStagingStatuses();
    }

    async _mergeToBase() {
        assert(this._stagedSha());
        assert(this._stagedPosition.ahead());
        this._log("merging to base...");

        if (this._dryRun("merging to base"))
            throw this._exSuspend("waiting for the dry-run mode to end");

        if (this._stagingOnly())
            throw this._exSuspend("waiting for staging-only mode to end");

        assert(!this._stagingBanned);

        await this._setAutomatedForStaged('success', 'will be merged as ' + this._stagedShaBrief());

        try {
            await GH.updateReference(this._prBaseBranchPath(), this._stagedSha(), false);
        } catch (e) {
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                await this._stagedPosition.compute();
                if (this._stagedPosition.diverged())
                    this._log("could not fast-forward, the base " + this._prBaseBranchPath() + " was probably modified while we were merging");
            }
            throw e;
        }

        await this._enterMerged();
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
            throw this._exWaiting("waiting for the dry-run mode to end");

        this._stagedCommit = await GH.createCommit(mergeCommit.tree.sha, this._prMessage(), [baseSha], mergeCommit.author, committer);

        assert(!this._stagingBanned);
        await GH.updateReference(Config.stagingBranchPath(), this._stagedSha(), true);

        this._stagedPosition = new BranchPosition(this._prBaseBranch(), Config.stagingBranch());
        await this._stagedPosition.compute();
        assert(this._stagedPosition.ahead());

        await this._enterStaged();
    }

    // updates and, if possible, advances (i.e. stages) a brewing GitHub PR
    async _stage() {
        this._breadcrumbs.push("stage");

        assert(this._prState.brewing());

        // methods below compute fresh labels from scratch
        this._removeTemporaryLabels();

        await this._update();
        await this._checkStagingPreconditions();
        await this._createStaged();
    }

    // updates and, if possible, advances (i.e. merges) a staged GitHub PR
    async _mergeStaged() {
        this._breadcrumbs.push("merge");

        assert(this._prState.staged());

        // methods below compute fresh labels from scratch
        this._removeTemporaryLabels();

        await this._update();
        await this._checkMergePreconditions();
        await this._mergeToBase();
    }

    // Maintain Anubis-controlled PR metadata.
    // If possible, also merge or advance the PR towards merging.
    // The caller must follow up with _pushLabelsToGitHub()!
    async _doProcess() {
        this._breadcrumbs.push("load");

        /*
         * Until _loadRawPr(), we must avoid this._rawPr fields except .number.
         * TODO: Refactor to eliminate the risk of too-early this._rawPr use.
         */

        await this._loadLabels();

        // methods below compute fresh labels from scratch without worrying
        // about stale labels, so we clear all the labels that we must sync
        this._removeTemporaryLabels();

        this._checkForHumanLabels();

        await this._loadStaged();
        await this._loadRawPr(); // requires this._loadStaged()
        await this._loadPrState(); // requires this._loadRawPr() and this._loadLabels()
        this._log("PR state: " + this._prState);

        if (this._prState.brewing()) {
            await this._stage();
            assert(this._prState.staged());
        }

        if (this._prState.staged())
            await this._mergeStaged();

        assert(this._prState.merged());
        await this._finalize();
    }

    // Updates and, if possible, advances PR towards (and including) merging.
    // If reprocessing is needed in X milliseconds, returns X.
    // Otherwise, returns null.
    async process() {
        try {
            await this._doProcess();
            assert(this._prState.merged());
            return new ProcessResult();
        } catch (e) {
            const knownProblem = e instanceof PrProblem;
            let currentKnownProblem = null;

            if (knownProblem) {
                this._log("did not merge: " + e.message);
                currentKnownProblem = e;
            } else {
                this._logEx(e, "process() failure");
            }

            const suspended = knownProblem && e.keepStagedRequested(); // whether _exSuspend() occured

            let result = new ProcessResult();

            if (this._prState && this._prState.staged() && suspended)
                result.setPrStaged(true);
            else
                this._removePositiveStagingLabels();

            if (knownProblem) {
                result.setDelayMsIfAny(this._delayMs());
                await this._setAutomatedForProblem(currentKnownProblem);
                return result;
            }

            // report this unknown but probably PR-specific problem on GitHub
            // XXX: We may keep redoing this PR every run() step forever, without any GitHub events.
            // TODO: Process Config.failedOtherLabel() PRs last and ignore their failures.
            if (!this._labels)
                this._labels = new Labels([], this._prNumber());

            if (this._stagedSha()) { // the PR is staged now or was staged some time ago
                // avoid livelocking
                this._labels.add(Config.failedStagingOtherLabel());
                currentKnownProblem = this._exLabeledFailure("an unexpected error during staging",
                        Config.failedStagingOtherLabel());
            } else {
                // Since knownProblem is false, either there was no failedStagingOtherLabel()
                // or the problem happened before we could check for it. In the latter case,
                // that label will remain set, and we will add failedOtherLabel(), reflecting the
                // compound nature of the problem.
                this._labels.add(Config.failedOtherLabel());
                currentKnownProblem = this._exLabeledFailure("an unexpected error",
                        Config.failedOtherLabel());
            }
            await this._setAutomatedForProblem(currentKnownProblem);
            throw e;
        } finally {
            await this._pushLabelsToGitHub();
        }
    }

    // Remove all labels that satisfy both criteria:
    // * We set it. Some labels are only set by humans. A label X qualifies if
    //   there is a labels.add(X) call somewhere.
    // * We remove it. Some labels are only removed by humans. Some labels are
    //   not meant to be removed at all! It is impossible to test this
    //   criterion by searching Anubis code because some labels are only
    //   removed by this method. Consult Anubis documentation instead.
    // TODO: Add these properties to labels and iterate over all labels here.
    _removeTemporaryLabels() {
        // Config.clearedForMergeLabel() can only be set by a human
        // Config.failedStagingChecksLabel() can only be removed by a human
        // Config.failedStagingOtherLabel() can only be removed by a human
        this._labels.remove(Config.failedDescriptionLabel());
        this._labels.remove(Config.failedOtherLabel());
        this._labels.remove(Config.passedStagingChecksLabel());
        this._labels.remove(Config.waitingStagingChecksLabel());
        // Config.mergedLabel() is not meant to be removed by anybody
    }

    // remove labels that have no sense for a failed staged PR
    _removePositiveStagingLabels() {
        this._labels.remove(Config.passedStagingChecksLabel());
        this._labels.remove(Config.waitingStagingChecksLabel());
    }

    /* _ex*() methods below are mutually exclusive: first match wins */

    // a problem that, once resolved, does not require reprocessing from scratch
    // only meaningful for staged PRs
    _exSuspend(why) {
        assert(arguments.length === 1);
        let problem = new PrProblem("pending", why);
        problem.requestToKeepStaged();
        return problem;
    }

    // somebody else appears to perform Anubis-only PR manipulations
    // minimize changes to avoid conflicts (but do not block other PRs)
    _exLostControl(why) {
        assert(arguments.length === 1);
        this._labelPushBan = why;
        assert(this._labelPushBan); // paranoid: `why` is truthy
        return new PrProblem("failure", why);
    }

    // a problem that humans can discern via GitHub-maintained PR state
    // reprocessing will be required after the problem is fixed
    _exObviousFailure(why) {
        assert(arguments.length === 1);
        return new PrProblem("failure", why);
    }

    // Indicates an event which this PR is waiting for. Differs from _exSuspend()
    // that reprocessing from scratch will be required after eceiving the event.
    _exWaiting(why) {
        assert(arguments.length === 1);
        return new PrProblem("pending", why);
    }

    // a problem that humans cannot easily detect without an Anubis-set label
    // reprocessing will be required after the problem is fixed
    _exLabeledFailure(why, label) {
        assert(arguments.length === 2);
        assert(!this._labelPushBan);
        this._labels.add(label);
        let problem = new PrProblem("failure", why);
        problem.setLabel(label);
        return problem;
    }
}

// promises to update/advance the given PR, hiding PullRequest from callers
function Process(rawPr, banStaging) {
    let pr = new PullRequest(rawPr, banStaging);
    return pr.process();
}


module.exports = {
    Process: Process
};


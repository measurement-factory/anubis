const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');

// Contains properties used for approval test status creation
class Approval {

    constructor(description, state, delayMs) {
        assert(description);
        assert(state);
        this.description = description;
        this.state = state;
        // If waiting for a timeout to merge the staged commit: > 0
        // If ready to merge the staged commit now: == 0
        // Otherwise (e.g., failed description, negative votes, or review requested): null
        this.delayMs = delayMs;
    }

    static GrantAfterTimeout(description, delayMs) {
        assert(delayMs > 0);
        return new Approval(description, "pending", delayMs);
    }

    static GrantNow(description) {
        return new Approval(description, "success", 0);
    }

    static Block(description) {
        return new Approval(description, "pending", null);
    }

    matchesGitHubStatusCheck(approvalStatus) {
        assert(approvalStatus);
        return approvalStatus.state === this.state && approvalStatus.description === this.description;
    }

    blocked() { return this.delayMs === null; }

    toString() { return "description: " + this.description + ", state: " + this.state; }
}

// Processing a single PR
class MergeContext {

    constructor(pr, tSha) {
        // true when fast-forwarding master into staging_branch fails
        this._pr = pr;
        this._tagSha = (tSha === undefined) ? null : tSha;
        this._shaLimit = 6;
        // information used for approval test status creation/updating
        this._approval = null;
    }

    // Returns 'true' if all PR checks passed successfully and merging
    // started,'false' if we can't start the PR due to some failed checks.
    async startProcessing() {
        // TODO: Optimize old/busy repo by quitting unless _prOpen().

        // TODO: Optimize label tests by caching all PR labels here.

        if (!this._dryRun("reset labels before precondition checking"))
            await this._unlabelPreconditionsChecking();

        if (!(await this._checkMergeConditions("precondition")))
            return false;

        // 'slow burner' case
        if (this.delay())
            return false;

        if (this._dryRun("start merging"))
            return false;

        await this._unlabelPreconditionsChecked();
        await this._startMerging();
        await this._labelWaitingStagingChecks();
        return true;
    }

    // Returns 'true' if the PR processing was finished (it was merged or
    // an error occurred so that we need to start it from scratch);
    // 'false' if the PR is still in-process (delayed for some reason).
    async finishProcessing() {

        if (!this._prOpen()) {
            this._log("was unexpectedly closed");
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);
        }

        if (await this._needRestart()) {
            this._log("PR will be restarted");
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);
        }

        const commitStatus = await this._checkStatuses(this._tagSha, Config.stagingChecks(), true);
        if (commitStatus === 'pending') {
            this._log("waiting for more staging checks completing");
            return false;
        } else if (commitStatus === 'failure') {
            this._log("staging checks failed");
            return await this._cleanupMergeFailed(false, this._labelFailedStagingChecks);
        }
        assert(commitStatus === 'success');
        this._log("staging checks succeeded");

        const compareStatus = await GH.compareCommits(this._prBaseBranch(), this._stagingTag());
        if (compareStatus === "identical" || compareStatus === "behind") {
            this._log("already merged");
            return await this._cleanupMerged();
        }

        // We need to check for divergence here because _tagIsFresh() does not track
        // conflicts between the base and this PR (GitHub-generated auto commit is
        // recreated only when there are not conflicts).
        if (compareStatus === "diverged") {
            this._log("PR branch and it's base branch diverged");
            return await this._cleanupMergeFailed(true, this._labelCleanStaged);
        }

        assert(compareStatus === "ahead");

        if (this._dryRun("finish processing"))
            return false;

        if (await this._stagingOnly("finish processing")) {
            await this._labelPassedStagingChecks();
            return false;
        }

        if (!(await this._finishMerging()))
            return true;
        this._log("merged successfully");
        return await this._cleanupMerged();
    }

    // Tries to load 'staging tag' for the PR.
    async _loadTag() {
       try {
           this._tagSha = await GH.getReference(this._stagingTag());
       } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               Log.LogException(e, this._toString() + " " + this._stagingTag() + " not found");
           else
               throw e;
       }
    }

    // Check 'staging tag' state as merge precondition.
    // Returns true if there is a fresh tag with 'failure' status.
    async _stagingFailed() {
        await this._loadTag();
        if (!this._tagSha)
            return false;

        const isFresh = await this._tagIsFresh();
        this._log("staging tag is " + (isFresh ? "fresh" : "stale"));
        if (isFresh) {
            const commitStatus = await this._checkStatuses(this._tagSha, Config.stagingChecks());
            if (commitStatus === 'failure') {
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

    // whether the tag and GitHub-generated PR 'merge commit' are equal
    async _tagIsFresh() {
        const tagCommit = await GH.getCommit(this._tagSha);
        const prMergeSha = await GH.getReference(this._mergePath());
        const prCommit = await GH.getCommit(prMergeSha);
        return tagCommit.tree.sha === prCommit.tree.sha;
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

    // whether the being-in-merge PR state changed so that
    // we should abort merging and start it from scratch
    async _needRestart() {
        if (!(await this._tagIsFresh()))
            return true;
        if (!(await this._checkMergeConditions("postcondition")))
            return true;
        return false;
    }

    // checks whether the PR is ready for merge
    async _checkMergeConditions(what) {
        this._log("checking merge " + what + "s...");
        this._approval = null;

        const pr = await GH.getPR(this._number(), true);
        // refresh PR data
        assert(pr.number === this._pr.number);
        this._pr = pr;

        if (!this._prOpen()) {
            this._log(what + " 'open' failed");
            return false;
        }

        if (this._prInProgress()) {
            this._log(what + " 'not in progress' failed");
            return false;
        }

        // For now, PR commit message validation is only a precondition,
        // do not validate it after 'staging commit' is created.
        // TODO: check whether the commit message is unchanged between
        // 'precondition' and 'postcondition' steps
        if (what === "precondition") {
            const messageValid = this._prMessageValid();
            if (!this._dryRun("labeling on failed description"))
                await this._labelFailedDescription(messageValid);
            if (!messageValid) {
                this._log(what + " 'commit message' failed");
                return false;
            }
        }

        if (!this._prMergeable()) {
            this._log(what + " 'mergeable' failed");
            return false;
        }

        const approval = await this._checkApproval();
        this._log("checkApproval: " + approval);
        await this._setApprovalStatus(approval, this._prHeadSha());
        if (what === "postcondition")
            await this._setApprovalStatus(approval, this._tagSha);

        const commitStatus = await this._checkStatuses(this._prHeadSha());
        if (commitStatus !== 'success') {
            this._log(what + " 'status' failed, status is " + commitStatus);
            return false;
        }

        if (await this._hasLabel(Config.mergedLabel(), this._number())) {
            this._log(what + " 'already merged' failed");
            return false;
        }

        if (approval.blocked()) {
            this._log(what + " 'approved' failed");
            return false;
        }

        if (what === "precondition") {
            if (await this._stagingFailed()) {
                this._log(what + " 'fresh tag with failed staging checks' failed'");
                return false;
            }
        }
        this._approval = approval;
        return true;
    }

    // Creates a 'staging commit' and adjusts staging_branch.
    async _startMerging() {
        this._log("start merging...");
        const baseSha = await GH.getReference(this._prBaseBranchPath());
        const mergeSha = await GH.getReference("pull/" + this._number() + "/merge");
        const mergeCommit = await GH.getCommit(mergeSha);
        if (!Config.githubUserName())
            await this._acquireUserProperties();
        let now = new Date();
        const committer = {name: Config.githubUserName(), email: Config.githubUserEmail(), date: now.toISOString()};
        const tempCommitSha = await GH.createCommit(mergeCommit.tree.sha, this._prMessage(), [baseSha], mergeCommit.author, committer);
        this._tagSha = await GH.createReference(tempCommitSha, "refs/" + this._stagingTag());
        await this._setApprovalStatus(this._approval, this._tagSha);
        await GH.updateReference(Config.stagingBranchPath(), this._tagSha, true);
    }

    // fast-forwards base into staging_branch
    // returns 'true' on success, 'false' on failure,
    // throws on unexpected error
    async _finishMerging() {
        assert(this._tagSha);
        this._log("finish merging...");
        try {
            await GH.updateReference(this._prBaseBranchPath(), this._tagSha, false);
            return true;
        } catch (e) {
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                if (await this._tagDiverged()) {
                    Log.LogException(e, this._toString() + " fast-forwarding failed");
                    await this._cleanupMergeFailed(true);
                    return false;
                }
            }
            throw e;
        }
    }

    // Adjusts the successfully merged PR (labels, status, tag).
    // Returns 'true' if the PR cleaup was completed, 'false'
    // otherwise.
    async _cleanupMerged() {
        if (this._dryRun("cleanup merged"))
            return false;

        this._log("merged, cleanup...");
        await this._labelMerged();
        await GH.updatePR(this._number(), 'closed');
        await GH.deleteReference(this._stagingTag());
        return true;
    }

    // Adjusts PR when it's merge was failed(labels and tag).
    // Returns 'true' if the PR cleaup was completed, 'false'
    // otherwise.
    async _cleanupMergeFailed(deleteTag, labelsCleanup) {
        if (this._dryRun("cleanup merge failed"))
            return false;
        this._log("merge failed, cleanup...");
        if (labelsCleanup === undefined)
            labelsCleanup = this._labelFailedOther;
        labelsCleanup = labelsCleanup.bind(this);
        await labelsCleanup();
        if (deleteTag)
            await GH.deleteReference(this._stagingTag());
        return true;
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
                return Approval.Block("waiting for requested reviews");
            }
        }

        let reviews = await GH.getReviews(this._number());

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
            if (reviewState !== 'approved' && reviewState !== 'changes_requested')
                continue;
            if (!pushCollaborators.find(el => el.login === review.user.login))
                continue;
            usersVoted = usersVoted.filter(el => el.reviewer !== review.user.login);
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
            return Approval.Block("waiting for more votes");
        }

        const prAgeMs = new Date() - new Date(this._createdAt());
        if (prAgeMs < Config.votingDelayMin())
            return Approval.GrantAfterTimeout("waiting for fast track objections", Config.votingDelayMin() - prAgeMs);

        if (usersApproved.length >= Config.sufficientApprovals())
            return Approval.GrantNow("approved");

        if (prAgeMs >= Config.votingDelayMax())
            return Approval.GrantNow("approved (on slow burner)");

        return Approval.GrantAfterTimeout("waiting for more votes or a slow burner timeout", Config.votingDelayMax() - prAgeMs);
    }

    async _setApprovalStatus(approval, sha) {
        assert(approval);
        assert(sha);

        if (this._dryRun("setting approval status"))
            return;
        if (!Config.manageApprovalStatus())
            return;

        const combinedStatus = await GH.getStatuses(sha);
        const approvalStatus = combinedStatus.statuses ?
            combinedStatus.statuses.find(el => el.context.trim() === Config.approvalContext()) : null;

        if (approvalStatus && approval.matchesGitHubStatusCheck(approvalStatus)) {
            this._log("Approval status already exists: " + Config.approvalContext() + ", " + approval.toString());
            return;
        }
        await GH.createStatus(sha, approval.state, Config.approvalUrl(), approval.description, Config.approvalContext());
    }

    // returns one of:
    // 'pending' if some of required checks are 'pending'
    // 'success' if all of required are 'success'
    // 'error' otherwise
    // checksNumber: the explicit number of requires status checks
    // andSupplyRequired: if provided, append missing 'required' statuses
    // to the ref (if the ref has the corresponding matching status already)
    async _checkStatuses(ref, checksNumber, andSupplyRequired) {
        let requiredContexts;
        try {
            requiredContexts = await GH.getProtectedBranchRequiredStatusChecks(this._prBaseBranch());
        } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               Log.LogException(e, this._toString() + " no status checks are required");
           else
               throw e;
        }
        // https://developer.github.com/v3/repos/statuses/#get-the-combined-status-for-a-specific-ref
        // state is one of 'failure', 'error', 'pending' or 'success'.
        // We treat both 'failure' and 'error' as an 'error'.
        let combinedStatus = await GH.getStatuses(ref);
        if (requiredContexts === undefined || requiredContexts.length === 0) {
            this._log("no required contexts found");
            // rely on all available checks then
            return combinedStatus.state;
        }
        // If checksNumber was passed, we use required status context string matching
        // for required checks counting. Gotten tag checks are compared against those
        // configured for protected base branch. For simplicity, we use 'starts with'
        // matching rule.
        // For example, if we configured three required checks(Config.stagingChecks=3) but
        // the branch has a single required check named 'Jenkins(build test)',
        // the bot will wait for three checks with 'Jenkins(build test).*' names.
        const needMatching = checksNumber !== undefined;
        const requiredChecksNumber = needMatching ? checksNumber : requiredContexts.length;

        // An array of [{context, state}] elements
        let requiredChecks = [];
        // filter out non-required checks
        for (let st of combinedStatus.statuses) {
            if (requiredContexts.find((el) => { return needMatching ?
                         st.context.startsWith(el.trim()) : (el.trim() === st.context.trim());}))
                requiredChecks.push({context: st.context, state: st.state, targetUrl: st.target_url, description: st.description});
        }

        if (requiredChecks.length < requiredChecksNumber || requiredChecks.find(check => check.state === 'pending'))
            return 'pending';

        const prevLen = requiredChecks.length;
        requiredChecks = requiredChecks.filter(check => check.state === 'success');
        const ret = (prevLen === requiredChecks.length);
        if (ret && andSupplyRequired) {
            for (let requiredContext of requiredContexts) {
                // go further only if the passed check context is not a required one
                if (requiredChecks.find(el => el.context.trim() === requiredContext.trim()) === undefined) {
                    // go further only if the passed check context matches the required one
                    const matched = requiredChecks.find(el => el.context.startsWith(requiredContext.trim()));
                    // Before a 'staged' commit can be applied, it should have all required checks passed.
                    // We create a new "required" check, taking other attributes like targetUrl
                    // from an already succeeded (matching) check (there can be several matching checks,
                    // e.g., from different Jenkins nodes). After that, there will be two checks
                    // referencing the same targetUrl.
                    if (matched && !this._dryRun("required status check creation"))
                        await GH.createStatus(ref, "success", matched.targetUrl, matched.description, requiredContext);
                }
            }
        }

        return ret ? 'success' : 'failure';
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

    // Label manipulation methods

    async _hasLabel(label) {
        const labels = await GH.getLabels(this._number());
        return labels.find(lbl => lbl.name === label) !== undefined;
    }

    async _removeLabelsIf(labels) {
        const currentLabels = await GH.getLabels(this._number());
        for (let label of labels) {
            if (currentLabels.find(lbl => lbl.name === label) !== undefined)
                await this._removeLabel(label);
            else
                this._log("_removeLabelsIf: skip non-existent " + label);
        }
    }

    async _removeLabel(label) {
        try {
            await GH.removeLabel(label, this._number());
        } catch (e) {
            if (e.name === 'ErrorContext' && e.notFound()) {
                Log.LogException(e, this._toString() + " removeLabel: " + label + " not found");
                return;
            }
            throw e;
        }
    }

    async _addLabel(label) {
        const currentLabels = await GH.getLabels(this._number());
        if (currentLabels.find(lbl => lbl.name === label) !== undefined) {
            this._log("addLabel: skip already existing " + label);
            return;
        }

        let params = Util.commonParams();
        params.number = this._number();
        params.labels = [];
        params.labels.push(label);

        await GH.addLabels(params);
    }

    async _labelFailedDescription(isValid) {
        const label = Config.failedDescriptionLabel();
        if (isValid)
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

    // the processing of this PR is delayed on this
    // number of milliseconds
    delay() { return this._approval === null ? null : this._approval.delayMs; }

    _number() { return this._pr.number; }

    _prHeadSha() { return this._pr.head.sha; }

    _prMessage() {
        return this._pr.title + ' (#' + this._pr.number + ')' + '\n\n' + this._prBody();
    }

    _prMessageValid() {
        const lines = this._prMessage().split('\n');
        for (let line of lines) {
            if (line.length > 72)
                return false;
        }
        return true;
    }

    _prInProgress() { return this._pr.title.startsWith('WIP:'); }

    _prRequestedReviewers() {
        let reviewers = [];
        if (this._pr.requested_reviewers) {
            for (let r of this._pr.requested_reviewers)
               reviewers.push(r.login);
        }
        return reviewers;
    }

    _prAuthor() { return this._pr.user.login; }

    _prMergeable() { return this._pr.mergeable; }

    _prBaseBranch() { return this._pr.base.ref; }

    _prBaseBranchPath() { return "heads/" + this._prBaseBranch(); }

    _prOpen() { return this._pr.state === 'open'; }

    _prBody() { return this._pr.body.replace(/\r+\n/g, '\n'); }

    _stagingTag() { return Util.StagingTag(this._pr.number); }

    _createdAt() { return this._pr.created_at; }

    _mergePath() { return "pull/" + this._pr.number + "/merge"; }

    _debugString() {
        return "PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit);
    }

    _log(msg) {
        Log.Logger.info(this._debugString() + "):", msg);
    }

    // TODO: Rename to _readOnly()
    // whether all GitHub/repository changes are prohibited
    _dryRun(msg) {
        if (!Config.dryRun())
            return false;
        this._log("skip " + msg + " due to dry_run option");
        return true;
    }

    // whether target branch changes are prohibited
    async _stagingOnly(msg) {
        // TODO: The caller should not have to remember to call _dryRun() first
        assert(!this._dryRun("_stagingOnly"));

        if (Config.stagedRun()) {
            this._log("skip " + msg + " due to staged_run option");
            return true;
        }

        if (Config.guardedRun()) {
            if (await this._hasLabel(Config.clearedForMergeLabel(), this._number())) {
                this._log("allow " + msg + " due to " + Config.clearedForMergeLabel() + " overruling guarded_run option");
                return false;
            }
            this._log("skip " + msg + " due to guarded_run option");
            return true;
        }

        return false; // no staging-only mode by default
    }

    _toString() {
        let str = this._debugString();
        if (this._tagSha !== null)
            str += ", tag: " + this._tagSha.substr(0, this._shaLimit);
        return str + ")";
    }
} // MergeContext

module.exports = MergeContext;


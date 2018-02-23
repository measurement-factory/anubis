const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');

// Processing a single PR
class MergeContext {

    constructor(pr, tSha) {
        // true when fast-forwarding master into staging_branch fails
        this._pr = pr;
        this._tagSha = (tSha === undefined) ? null : tSha;
        this._shaLimit = 6;
        // the remainder (>0) of the min or max voting delay (in ms)
        this._votingDelay = null;
    }

    // Returns 'true' if all PR checks passed successfully and merging
    // started,'false' if we can't start the PR due to some failed checks.
    async startProcessing() {
        if (!this._dryRun("reset labels before precondition checking"))
            await this._unlabelPreconditionsChecking();

        if (!(await this._checkMergeConditions("precondition")))
            return false;

        // 'slow burner' case
        if (this._votingDelay > 0)
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
            return await this._cleanupMergeFailed(true);
        }

        const commitStatus = await this._checkStatuses(this._tagSha, Config.stagingChecks());
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
        // note that _needRestart() below would notice that the tag is "diverged",
        // but we check compareStatus first to avoid useless api requests
        if (compareStatus === "diverged") {
            this._log("PR branch and it's base branch diverged");
            return await this._cleanupMergeFailed(true);
        }
        if (await this._needRestart()) {
            this._log("PR will be restarted");
            return await this._cleanupMergeFailed(true);
        }

        assert(compareStatus === "ahead");

        if (this._dryRun("finish processing"))
            return false;

        if (this._stagedRun("finish processing")) {
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
               this._log(this._stagingTag() + " not found");
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
        if (!Config.dryRun())
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
            if (!Config.dryRun())
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

        const commitStatus = await this._checkStatuses(this._prHeadSha());
        if (commitStatus !== 'success') {
            this._log(what + " 'status' failed, status is " + commitStatus);
            return false;
        }

        if (await this._hasLabel(Config.mergedLabel(), this._number())) {
            this._log(what + " 'already merged' failed");
            return false;
        }

        const delay = await this._checkApproved();
        if (delay === null) {
            this._log(what + " 'approved' failed");
            return false;
        }

        if (what === "precondition") {
            if (await this._stagingFailed()) {
                this._log(what + " 'fresh tag with failed staging checks' failed'");
                return false;
            }
        }

        this._votingDelay = delay;
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
        await GH.updateReference(Config.stagingBranchPath(), this._tagSha, true);
    }

    // fast-forwards base into staging_branch
    // returns 'true' on success, 'false' on failure,
    // throws on unexpected error
    async _finishMerging() {
        assert(this._tagSha);
        assert(!Config.stagedRun());
        this._log("finish merging...");
        try {
            await GH.updateReference(this._prBaseBranchPath(), this._tagSha, false);
            return true;
        } catch (e) {
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                this._log("fast-forwarding failed");
                await this._cleanupMergeFailed(true);
                return false;
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

    // If approved, returns the number for milliseconds to wait for,
    // or '0', meaning 'ready'. If not approved or disqualified returns null.
    async _checkApproved() {
        const collaborators = await GH.getCollaborators();
        const pushCollaborators = collaborators.filter(c => c.permissions.push === true);
        const requestedReviewers = this._prRequestedReviewers();

        for (let collaborator of pushCollaborators) {
            if (requestedReviewers.includes(collaborator.login)) {
                this._log("requested core reviewer: " + collaborator.login);
                return null;
            }
        }

        let reviews = await GH.getReviews(this._number());

        const prAgeMs = new Date() - new Date(this._createdAt());
        if (prAgeMs < Config.votingDelayMin()) {
            this._log("in minimal voting period");
            return Config.votingDelayMin() - prAgeMs;
        }

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
            return null;
        }
        const usersApproved = usersVoted.filter(u => u.state !== 'changes_requested');
        this._log("approved by " + usersApproved.length + " core developer(s)");

        if (usersApproved.length < Config.necessaryApprovals()) {
            this._log("not approved by necessary " + Config.necessaryApprovals() + " votes");
            return null;
        }
        if (usersApproved.length >= Config.sufficientApprovals() || prAgeMs >= Config.votingDelayMax())
            return 0;
        this._log("in maximum voting period");
        return Config.votingDelayMax() - prAgeMs;
    }

    // returns one of:
    // 'pending' if some of required checks are 'pending'
    // 'success' if all of required are 'success'
    // 'error' otherwise
    // checksNumber: the explicit number of requires status checks
    async _checkStatuses(ref, checksNumber) {
        let requiredContexts;
        try {
            requiredContexts = await GH.getProtectedBranchRequiredStatusChecks(this._prBaseBranch());
        } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               this._log("required status checks not found not found");
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
                requiredChecks.push({context: st.context, state: st.state});
        }

        if (requiredChecks.length < requiredChecksNumber || requiredChecks.find(check => check.state === 'pending'))
            return 'pending';

        const prevLen = requiredChecks.length;
        requiredChecks = requiredChecks.filter(check => check.state === 'success');
        return prevLen === requiredChecks.length ? 'success' : 'failure';
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
                this._log("removeLabel: " + label + " not found");
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
                Config.passedStagingChecksLabel()
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
    delay() { return this._votingDelay; }

    _number() { return this._pr.number; }

    _prHeadSha() { return this._pr.head.sha; }

    _prMessage() {
        return this._pr.title + ' (#' + this._pr.number + ')' + '\n\n' + this._pr.body;
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

    _stagingTag() { return Util.StagingTag(this._pr.number); }

    _createdAt() { return this._pr.created_at; }

    _mergePath() { return "pull/" + this._pr.number + "/merge"; }

    _debugString() {
        return "PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit);
    }

    _log(msg) {
        Log.Logger.info(this._debugString() + "):", msg);
    }

    _dryRun(msg) {
        if (!Config.dryRun())
            return false;
        this._log("skip " + msg + " due to dry_run option");
        return true;
    }

    _stagedRun(msg) {
        if (!Config.stagedRun())
            return false;
        this._log("skip " + msg + " due to staged_run option");
        return true;
    }

    _toString() {
        let str = this._debugString();
        if (this._tagSha !== null)
            str += ", tag: " + this._tagSha.substr(0, this._shaLimit);
        return str + ")";
    }
} // MergeContext

module.exports = MergeContext;


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
    constructor(message, ...params) {
        super(message, ...params);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);

        this._keepStaged = false; // catcher should preserve the staged commit
    }

    keepStagedRequested() { return this._keepStaged; }

    requestToKeepStaged() {
        assert(!this.keepStagedRequested());
        this._keepStaged = true;
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
}

// aggregates status checks for a PR or commit
class StatusChecks
{
    // TODO: we should distinguish CI-reported (genuine) statuses from
    // bot-reported (derivative) statuses, such as approvals.
    // For example, failed() should count only genuine statuses, whereas
    // final() should count all statuses.

    // expectedStatusCount:
    //   for staged commits: the bot-configured number of required checks (Config.stagingChecks()),
    //   for PR commits: GitHub configured number of required checks (requested from GitHub)
    // context: either "PR" or "Staging";
    // contextsRequiredByGitHubConfig: the GitHub protected branch checks in a format of a list of string contexts
    constructor(expectedStatusCount, context, contextsRequiredByGitHubConfig) {
        assert(expectedStatusCount !== undefined);
        assert(expectedStatusCount !== null);
        assert(context);
        assert(contextsRequiredByGitHubConfig);
        this.expectedStatusCount = expectedStatusCount;
        this.context = context;
        this._approvalIsRequired = contextsRequiredByGitHubConfig.some(el => el.trim() === Config.approvalContext());
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

    hasApprovalStatus(approval) {
        const statusesToSearch = this._approvalIsRequired ? this.requiredStatuses : this.optionalStatuses;
        return statusesToSearch.some(el =>
                el.context.trim() === Config.approvalContext() &&
                el.state === approval.state &&
                el.description === approval.description);
    }

    setApprovalStatus(approval) {
        let raw = {
            state: approval.state,
            target_url: Config.approvalUrl(),
            description: approval.description,
            context: Config.approvalContext()
        };
        const check = new StatusCheck(raw);
        if (this._approvalIsRequired) {
            this.requiredStatuses = this.requiredStatuses.filter(st => st.context !== Config.approvalContext());
            this.addRequiredStatus(check);
        } else {
            this.optionalStatuses = this.optionalStatuses.filter(st => st.context !== Config.approvalContext());
            this.addOptionalStatus(check);
        }
    }

    // no more required status changes or additions are expected
    final() {
        return (this.requiredStatuses.length >= this.expectedStatusCount) &&
            this.requiredStatuses.every(check => !check.pending());
    }

    // something went wrong with at least one of the required status checks
    failed() {
        return this._failedExcept(Config.approvalContext());
    }

    // Whether at least one of the required status checks failed.
    // Ignores checks with the given context, when searching.
    _failedExcept(context) {
        const filteredChecks = this.requiredStatuses.filter(st => context ? st.context !== context : true);
        return filteredChecks.some(check => check.failed());
    }

    // the results are final and all checks were a success
    succeeded() {
        return this.final() && this.requiredStatuses.every(check => check.success());
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

// Forward iterator for fields in the 'name:value' format.
class FieldsTokenizer
{
    constructor(str) {
        this._lines = str.split('\n');
        this._remainingFields = [];
        this._tokenizeAll();
    }

    // returns the next parsed field in the {name, value, raw} format
    nextField() {
        assert(!this.atEnd());
        return this._remainingFields.shift();
    }

    // parses all input in advance
    _tokenizeAll() {
        while (this._lines.length) {
            const line = this._lines.shift();

            // treat an empty line as the end of input
            if (line.trim().length === 0)
                break;

            if (/^\s/.test(line))
                throw new Error(`a field cannot start with whitespace: ${line}`);

            const pos = line.search(':');
            if (pos < 0)
                throw new Error(`a field without a name:value delimiter: '${line}'`);

            const name = line.substring(0, pos);
            const value = line.substring(pos+1);
            if (this._remainingFields.some(el => el.name.toUpperCase() === name.toUpperCase() &&
                        el.value.toUpperCase() === value.toUpperCase())) {
                throw new Error(`duplicates are not allowed: ${line}`);
            }
            this._remainingFields.push({name: name, value: value, raw: line});
        }
    }

    atEnd() { return this._remainingFields.length === 0; }

    // returns the (yet) unparsed string
    remaining() { return this._lines.join('\n'); }
}

// computes future commit message from raw PR
class CommitMessage
{
    constructor(rawPr, defaultAuthor) {

        // the (required) commit message title
        this._title = rawPr.title + ' (#' + rawPr.number + ')';

        // PR description has three optional parts: [header]+[body]+[trailer]
        // The parts are separated by empty lines.

        // The header is dedicated to Anubis-recognized/consumed PR metadata.
        // The commit message only retains the body and the trailer.

        // PR description without the header and trailer parts
        this._body = null;

        // optional commit attributes recognized by GitHub, git, and/or Project
        // these attributes are partially validated by Anubis
        // stored in the original text format
        this._trailer = null;

        // GitHub-suggested commit author
        // uses {name, email, date} format
        assert(defaultAuthor);
        this._defaultAuthor = defaultAuthor;

        // optional commit author specified by 'Authored-by' header field
        // uses {name, email} format
        // overwrites this._defaultAuthor's name and email
        this._customAuthor = null;

        // We want to validate all trailers and only trailers for formatting
        // errors. Unfortunately, there is no reliable way to detect trailer
        // presence. Thus, we will miss some trailers (and merge some PRs with
        // buggy trailers), and we will validate some non-trailers (and block
        // some valid PRs). The current implementation considers excessive
        // blocking to be the lesser of the two evils: We treat any last
        // paragraph that starts with /\S+:/ as a trailer _unless_ it starts
        // with one of these common expressions.
        this.phonyTrailers = [
            // common paragraph labels or introductory words
            /^TODO:/i,
            /^XXX:/i,
            /^Motivation:/i,
            /^Context:/i,
            /^Note:/i,
            /^NP:/i,
            /^Typo:/i,

            // quoted messages (that should have been indented but were not)
            /^error:/i,
            /^warning:/i,

            // e.g., a C++ class member name or a name inside a namespace
            /^\w+::/,

            // raw URLs
            /^http[s]?:/i,

            // markdown citations/references and footnotes
            /^\[\^\d+\]:/
        ];

        this._checkRaw(this._title);

        if (rawPr.body !== undefined && rawPr.body !== null)
            this._parse(rawPr.body);
    }

    // complete message for the future commit
    whole() {
        assert(this._title.length); // the only required part
        let message = this._title;
        if (this._body !== null)
            message += '\n\n' + this._body;
        if (this._trailer !== null)
            message += '\n\n' + this._trailer;
        return message;
    }

    // the future commit author in the {name, email, date} format
    author()
    {
        if (this._customAuthor === null)
            return this._defaultAuthor;
        return {name: this._customAuthor.name, email: this._customAuthor.email, date: this._defaultAuthor.date};
    }

    // returns the position of the first non-ASCII_printable character (or -1)
    _invalidCharacterPosition(str) {
        const prohibitedCharacters = /[^\u{20}-\u{7e}]/u;
        const match = prohibitedCharacters.exec(str);
        return match ? match.index : -1;
    }

    // removes leading empty lines and trims the end
    _trim(str) {
        // cannot just use trim() to preserve the first line indentation (if any).
        return str.replace(/^\s*\n+/g, '').trimEnd();
    }

    // basic checks for an unparsed message
    _checkRaw(message) {
        // CRs in CRLF sequences already removed
        // other CRs are not treated specially (and are banned)
        const lines = message.split('\n');
        for (let i = 0; i < lines.length; ++i) {
            const line = lines[i];
            const invalidPosition = this._invalidCharacterPosition(line);

            if (invalidPosition !== -1)
                throw new Error(`bad character at line ${i}, offset ${invalidPosition}`);

            // allow excessively long whitespace-only lines
            // that some copy-pasted PR descriptions may include
            const trimmedLine = this._trim(line);
            if (trimmedLine.length > 72)
                throw new Error(`too long line '${trimmedLine}'`);
        }
    }

    _parse(prDescriptionRaw) {
        const prDescription = prDescriptionRaw.replace(/\r+\n/g, '\n');
        this._checkRaw(prDescription);
        const prDescriptionWithoutHeader = this._extractHeader(prDescription);
        const prDescriptionWithoutHeaderAndTrailer = this._extractTrailer(prDescriptionWithoutHeader);
        this._parseBody(prDescriptionWithoutHeaderAndTrailer);
    }

    // authorField is a {name, value, raw}
    _parseAuthor(authorField) {
        const trimmedValue = this._trim(authorField.value);
        const cred = trimmedValue.match(/^ ([\w][^@<>,]*) <(\S+@\S+\.\S+)>$/);
        if (!cred)
            throw new Error(`unsupported ${authorField.name} value format: ${authorField.value}`);

        if (cred[0].includes(','))
            throw new Error(`${authorField.name} author name with a comma: ${authorField.value}`);

        return {name: cred[1].trim(), email: cred[2].trim()};
    }

    _extractHeader(prDescriptionRaw) {
        const prDescription = this._trim(prDescriptionRaw);
        if (/^ {0,3}Authored-by:/.test(prDescription)) {
            let tokenizer = new FieldsTokenizer(prDescription);
            const authorField = tokenizer.nextField();
            assert(authorField);
            this._customAuthor = this._parseAuthor(authorField);
            if (!tokenizer.atEnd())
                throw new Error(`unexpected header lines after a single Authored-by attribute`);
            return tokenizer.remaining();
        } else {
            return prDescription;
        }
    }

    _extractTrailer(prDescriptionWithoutHeaderRaw) {
        const prDescriptionWithoutHeader = this._trim(prDescriptionWithoutHeaderRaw);
        // index of the last occurrence of '\n\n'
        let trailerCandidateIndex = prDescriptionWithoutHeader.search(/\n\n(?!.*\n\n)/s);
        // Does the text have at most one paragraph?
        trailerCandidateIndex = trailerCandidateIndex < 0 ? 0 : trailerCandidateIndex + 2
        const trailerCandidate = prDescriptionWithoutHeader.substring(trailerCandidateIndex);
        const trailerStart = trailerCandidate.match(/^ {0,3}(\S+:)/);
        if (trailerStart && !this.phonyTrailers.some(el => el.test(trailerStart[1]))) {
            this._parseTrailer(prDescriptionWithoutHeader.substring(trailerCandidateIndex));
            return prDescriptionWithoutHeader.substring(0, trailerCandidateIndex);
        }
        Log.Logger.info("assuming no trailer");
        return prDescriptionWithoutHeader;
    }

    _parseBody(prDescriptionWithoutHeaderAndTrailerRaw) {
        const prDescriptionWithoutHeaderAndTrailer = this._trim(prDescriptionWithoutHeaderAndTrailerRaw);
        if (prDescriptionWithoutHeaderAndTrailer.length > 0) {
            this._checkForTypos(prDescriptionWithoutHeaderAndTrailer);
            this._body = prDescriptionWithoutHeaderAndTrailer;
        }
    }

    _parseTrailer(trailerRaw) {
        const trailer = this._trim(trailerRaw);
        let tokenizer = new FieldsTokenizer(trailer);

        if (tokenizer.atEnd())
            throw new Error(`an empty trailer`);

        while (!tokenizer.atEnd()) {
            const field = tokenizer.nextField();
            if (field.name === "Co-authored-by") {
                const coAuthor = JSON.stringify(this._parseAuthor(field));
                this._log(`accepting trailer field: ${coAuthor}`);
            } else {
                this._checkForTypos(field.name);
            }
            this._checkForTypos(field.value);
        }

        if (trailer.length > 0)
            this._trailer = trailer;
    }

    // checks the PR message (or its part) for some common/expected typos that may occur
    // when filling in PR attributes
    _checkForTypos(text) {
        const possibleAuthoredByTypoRegex = /^\s*\S*authored[-_]?by/mi;
        if (text.search(possibleAuthoredByTypoRegex) >= 0)
            throw new Error(`suspicious '*Authored-by' attribute in the PR description`);
    }

    _log(msg) {
        Log.Logger.info(msg);
    }
}

// a single GitHub pull request
class PullRequest {

    constructor(pr, banStaging) {
        this._rawPr = pr; // may be rather old and lack pr.mergeable; see _loadRawPr()

        this._shaLimit = 6; // how many SHA chars to show in debug messages

        this._approval = null; // future Approval object

        // a list of proteced branch contexts received from GitHub
        this._contextsRequiredByGitHubConfig = null;

        this._stagedPosition = null;

        // this PR merge commit received from GitHub, if any
        this._mergeCommit = null;

        // this PR staged commit received from GitHub, if any
        this._stagedCommit = null;

        // major methods we have called, in the call order (for debugging only)
        this._breadcrumbs = [];

        this._prState = null; // calculated PrState

        this._labels = null;

        // while unexpected, PR merging and closing is not prohibited when staging is
        this._stagingBanned = banStaging;

        // GitHub statuses of the staged commit
        this._stagedStatuses = null;

        // GitHub statuses of the PR branch head commit
        this._prStatuses = null;

        this._updated = false; // _update() has been called

        // the user should see abandonedStagingChecksLabel()
        this._signalAbandonmentOfStagingChecks = false;

        // truthy value contains a reason for disabling _pushLabelsToGitHub()
        this._labelPushBan = false;

        this._commitMessage = undefined;
    }

    // this PR will need to be reprocessed in this many milliseconds
    // returns null if this PR does not need to be reprocessed on a timer
    _delayMs() {
        if (this._approval && this._approval.grantedTimeout())
            return this._approval.delayMs; // always positive
        return null;
    }

    // whether the given GitHub user is a core developer
    _coreDeveloper(role, userLogin, userId) {
        const coreId = Config.coreDeveloperIds().get(userLogin);
        if (!coreId)
            return false;
        this._log(`${role} is a core developer: ${userLogin}=${userId}`);
        // die if we are misconfigured and/or the userLogin has moved to another user
        assert.strictEqual(coreId, userId);
        return true;
    }

    // creates and returns filled Approval object
    async _checkApproval() {
        assert(this._approval === null);

        const requestedReviewers = this._prRequestedReviewers();

        for (let reviewerEntry of requestedReviewers.entries()) {
            if (this._coreDeveloper('requested reviewer', reviewerEntry[0], reviewerEntry[1]))
                return Approval.Suspend("waiting for requested reviews");
        }

        let reviews = await GH.getReviews(this._prNumber());

        // An array of [{reviewer, date, state}] elements,
        // where 'reviewer' is a core developer, 'date' the review date and 'state' is either
        // 'approved' or 'changes_requested'.
        let usersVoted = [];
        // add the author if needed
        if (this._coreDeveloper('PR author', this._prAuthor(), this._prAuthorId()))
            usersVoted.push({reviewer: this._prAuthor(), date: this._createdAt(), state: 'approved'});

        // Reviews are returned in chronological order; the list may contain several
        // reviews from the same reviewer, so the actual 'state' is the most recent one.
        for (let review of reviews) {
            if (!this._coreDeveloper('reviewer', review.user.login, review.user.id))
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

        assert(this._prStatuses);

        if (!this._prStatuses.hasApprovalStatus(this._approval)) {
            await this._createApprovalStatus(this._prHeadSha());
            this._prStatuses.setApprovalStatus(this._approval);
        }

        if (this._stagedStatuses && !this._stagedStatuses.hasApprovalStatus(this._approval)) {
            await this._createApprovalStatus(this._stagedSha());
            this._stagedStatuses.setApprovalStatus(this._approval);
        }
    }

    async _createApprovalStatus(sha) {
        if (this._dryRun("creating approval status"))
            return;
        await GH.createStatus(sha, this._approval.state, Config.approvalUrl(), this._approval.description, Config.approvalContext());
    }

    async _loadRequiredContexts() {
        assert(!this._contextsRequiredByGitHubConfig);

        try {
            this._contextsRequiredByGitHubConfig = await GH.getProtectedBranchRequiredStatusChecks(this._prBaseBranch());
        } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               this._logEx(e, "no status checks are required");
           else
               throw e;
        }

        if (this._contextsRequiredByGitHubConfig === undefined)
            this._contextsRequiredByGitHubConfig = [];

        assert(this._contextsRequiredByGitHubConfig);
        this._log("required contexts found: " + this._contextsRequiredByGitHubConfig.length);
    }

    // returns filled StatusChecks object
    async _getPrStatuses() {
        const combinedPrStatus = await GH.getStatuses(this._prHeadSha());
        let statusChecks = new StatusChecks(this._contextsRequiredByGitHubConfig.length, "PR", this._contextsRequiredByGitHubConfig);
        // fill with required status checks
        for (let st of combinedPrStatus.statuses) {
            if (this._contextsRequiredByGitHubConfig.some(el => el.trim() === st.context.trim()))
                statusChecks.addRequiredStatus(new StatusCheck(st));
            else
                statusChecks.addOptionalStatus(new StatusCheck(st));
        }
        this._log("pr status details: " + statusChecks);
        return statusChecks;
    }

    // returns filled StatusChecks object
    async _getStagingStatuses() {
        const combinedStagingStatuses = await GH.getStatuses(this._stagedSha());
        const genuineStatuses = combinedStagingStatuses.statuses.filter(st => !st.description.endsWith(Config.copiedDescriptionSuffix()));
        assert(genuineStatuses.length <= Config.stagingChecks());
        let statusChecks = new StatusChecks(Config.stagingChecks(), "Staging", this._contextsRequiredByGitHubConfig);
        // all genuine checks, except for PR approval, are 'required'
        // PR approval may be either 'required' or 'optional' (depending on the GitHub settings)
        for (let st of genuineStatuses) {
            const check = new StatusCheck(st);
            if (check.context.trim() === Config.approvalContext())
                statusChecks.setApprovalStatus(check);
            else
                statusChecks.addRequiredStatus(check);
        }

        const optionalStatuses = combinedStagingStatuses.statuses.filter(st => st.description.endsWith(Config.copiedDescriptionSuffix()));
        for (let st of optionalStatuses) {
            // PR approval status must be 'genuine' (it is never copied)
            assert(st.context.trim() !== Config.approvalContext());
            statusChecks.addOptionalStatus(new StatusCheck(st));
        }

        this._log("staging status details: " + statusChecks);
        return statusChecks;
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
            this._stagedCommitMetadataIsFresh()) {

            const prMergeSha = await GH.getReference(this._mergePath());
            const prCommit = await GH.getCommit(prMergeSha);
            // whether the PR branch has not changed
            if (this._stagedCommit.tree.sha === prCommit.tree.sha) {
                const stagedCommitDate = new Date(this._stagedCommit.committer.date);
                const prCommitDate = new Date(prCommit.committer.date);
                // check that a 'no-change' PR commit did not update the merge commit
                // (which keeps the old tree object in this case)
                if (stagedCommitDate >= prCommitDate) {
                    this._log("the staged commit is fresh");
                    return true;
                }
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
            throw this._exObviousFailure("an unexpected error during staging some time ago");
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
            throw this._exObviousFailure("staged commit tests failed");

        if (this._draftPr())
            throw this._exObviousFailure("just a draft");

        if (!this._commitMessage)
            throw this._exLabeledFailure("invalid commit message", Config.failedDescriptionLabel());

        if (!this._prMergeable())
            throw this._exObviousFailure("GitHub will not be able to merge");

        if (!this._approval.granted())
            throw this._exObviousFailure("waiting for approval");

        if (this._approval.grantedTimeout())
            throw this._exObviousFailure("waiting for objections");

        if (this._stagingBanned)
            throw this._exObviousFailure("waiting for another staged PR");

        if (this._prStatuses.failed())
            throw this._exObviousFailure("failed PR tests");

        if (!this._prStatuses.final())
            throw this._exObviousFailure("waiting for PR checks");

        assert(this._prStatuses.succeeded());
    }

    // refreshes Anubis-managed part of the GitHub PR state
    async _update() {
        if (this._updated)
            return;

        this._breadcrumbs.push("update");

        assert(!this._prState.merged());

        // paranoid null check: must be undefined or non-null
        this._log("messageValid: " + (this._commitMessage !== undefined && this._commitMessage !== null));

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

    _draftPr() {
        // TODO: Remove this backward compatibility code after 2021-12-24.
        if (this._rawPr.title.startsWith('WIP:'))
            return true;

        return this._rawPr.draft;
    }

    _prRequestedReviewers() {
        let reviewers = new Map();
        if (this._rawPr.requested_reviewers) {
            for (let r of this._rawPr.requested_reviewers)
               reviewers.set(r.login, r.id);
        }
        return reviewers;
    }

    _prAuthor() { return this._rawPr.user.login; }

    _prAuthorId() { return this._rawPr.user.id; }

    _defaultRepoBranch() { return this._rawPr.base.repo.default_branch; }

    _prMergeable() {
        // requires GH.getPR() call
        assert(this._rawPr.mergeable !== undefined);
        return this._rawPr.mergeable;
    }

    _prBaseBranch() { return this._rawPr.base.ref; }

    _prBaseBranchPath() { return "heads/" + this._prBaseBranch(); }

    _prOpen() { return this._rawPr.state === 'open'; }

    _createdAt() { return this._rawPr.created_at; }

    _mergePath() { return "pull/" + this._rawPr.number + "/merge"; }

    _stagedSha() { return this._stagedCommit ? this._stagedCommit.sha : null; }

    staged() { return this._prState.staged(); }

    _debugString() {
        const staged = this._stagedSha() ? "staged: " + this._stagedSha().substr(0, this._shaLimit) + ' ' : "";
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
        let mergedSha = null;
        let commits = await GH.getCommits(this._prBaseBranch(), dateSince);
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
                this._enterMerged();
            else
                await this._enterBrewing();
            return;
        }

        assert(this._stagedPosition);

        if (this._stagedPosition.merged()) {
            this._log("already merged into base some time ago");
            this._enterMerged();
            return;
        }

        if (!(await this._stagedCommitIsFresh())) {
            this._signalAbandonmentOfStagingChecks = true;
            await this._enterBrewing();
            return;
        }

        assert(this._stagedPosition.ahead());

        const stagedStatuses = await this._getStagingStatuses();
        // Do not vainly recreate staged commit which will definitely fail again,
        // since the PR+base code is yet unchanged and the existing errors still persist
        if (stagedStatuses.failed()) {
            this._labels.add(Config.failedStagingChecksLabel());
            await this._enterBrewing();
            return;
        }

        await this._enterStaged(stagedStatuses);
    }

    async _enterBrewing() {
        this._prState = PrState.Brewing();
        assert(this._prStatuses === null);
        this._prStatuses = await this._getPrStatuses();
    }

    async _enterStaged(stagedStatuses) {
        this._prState = PrState.Staged();

        // do not signal about the old staged commit when we have a new one
        this._signalAbandonmentOfStagingChecks = false; // may already be false

        assert(this._stagedStatuses === null);
        if (stagedStatuses)
            this._stagedStatuses = stagedStatuses;
        else
            this._stagedStatuses = await this._getStagingStatuses();
        this._prStatuses = await this._getPrStatuses();
    }

    _enterMerged() {
        this._prState = PrState.Merged();

        // do not signal about the old staged commit when we have a merged one
        this._signalAbandonmentOfStagingChecks = false; // may already be false
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

        if (this._prMergeable()) {
            const mergeSha = await GH.getReference("pull/" + this._prNumber() + "/merge");
            this._mergeCommit = await GH.getCommit(mergeSha);
            try {
                this._commitMessage = new CommitMessage(this._rawPr, this._mergeCommit.author);
            } catch (e) {
                this._logEx(e, "cannot parse commit message");
            }
        }
    }

    // Whether the staged commit metadata remained intact since staging.
    _stagedCommitMetadataIsFresh() {
        if (!this._commitMessage) {
            this._log("staged commit message became invalid (and will be treated as stale)");
            return false;
        }
        const result = this._commitMessage.whole() === this._stagedCommit.message;
        this._log("staged commit message freshness: " + result);
        if (!result)
            return false;

        const oldAuthor = this._stagedCommit.author;
        const newAuthor = this._commitMessage.author();
        const authorIsFresh = oldAuthor.name === newAuthor.name && oldAuthor.email === newAuthor.email;
        this._log("staged commit author freshness: " + authorIsFresh);
        if (!authorIsFresh)
            return false;

        return true;
    }

    async _processStagingStatuses() {
        assert(this._stagedStatuses);
        if (this._stagedStatuses.failed())
            throw this._exLabeledFailure("staging tests failed", Config.failedStagingChecksLabel());

        if (!this._stagedStatuses.final()) {
            this._labels.add(Config.waitingStagingChecksLabel());
            throw this._exSuspend("waiting for staging tests completion");
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

        for (let requiredContext of this._contextsRequiredByGitHubConfig) {
            if (this._stagedStatuses.hasStatus(requiredContext)) {
                this._log("_supplyStagingWithPrRequired: skip existing " + requiredContext);
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
        if (!this._commitMessage)
            throw this._exLabeledFailure("commit message is now considered invalid", Config.failedDescriptionLabel());

        // yes, _checkStagingPreconditions() has checked this already, but
        // humans may have changed the PR stage since that check, and our
        // checking code might have changed as well
        if (this._draftPr())
            throw this._exObviousFailure("became a draft");

        // TODO: unstage only if there is competition for being staged

        // yes, _checkStagingPreconditions() has checked approval already, but
        // humans may have changed their mind since that check
        if (!this._approval.granted())
            throw this._exObviousFailure("lost approval");
        if (this._approval.grantedTimeout())
            throw this._exObviousFailure("restart waiting for objections");

        if (this._prStatuses.failed())
            throw this._exObviousFailure("new PR branch tests appeared/failed after staging");

        if (!this._prStatuses.final())
            throw this._exSuspend("waiting for PR branch tests that appeared after staging");

        assert(this._prStatuses.succeeded());

        await this._processStagingStatuses();
    }

    async _mergeToBase() {
        assert(this._stagedSha());
        assert(this._stagedPosition.ahead());
        this._log("merging to base...");

        if (this._dryRun("merging to base"))
            throw this._exSuspend("dryRun");

        if (this._stagingOnly())
            throw this._exSuspend("waiting for staging-only mode to end");

        assert(!this._stagingBanned);

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

        this._enterMerged();
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
        if (!Config.githubUserName())
            await this._acquireUserProperties();
        let now = new Date();
        const committer = {name: Config.githubUserName(), email: Config.githubUserEmail(), date: now.toISOString()};

        if (this._dryRun("create staged commit"))
            throw this._exObviousFailure("dryRun");

        this._stagedCommit = await GH.createCommit(this._mergeCommit.tree.sha, this._commitMessage.whole(), [baseSha], this._commitMessage.author(), committer);

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
        await this._loadRequiredContexts();
        await this._loadPrState(); // requires this._loadRawPr(), this._loadRequiredContexts() and this._loadLabels()
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

            if (knownProblem)
                this._log("did not merge: " + e.message);
            else
                this._logEx(e, "process() failure");

            if (this._signalAbandonmentOfStagingChecks)
                this._labels.add(Config.abandonedStagingChecksLabel());

            const suspended = knownProblem && e.keepStagedRequested(); // whether _exSuspend() occured

            let result = new ProcessResult();

            if (this._prState && this._prState.staged() && suspended)
                result.setPrStaged(true);
            else
                this._removePositiveStagingLabels();

            if (knownProblem) {
                result.setDelayMsIfAny(this._delayMs());
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
            } else {
                // Since knownProblem is false, either there was no failedStagingOtherLabel()
                // or the problem happened before we could check for it. In the latter case,
                // that label will remain set, and we will add failedOtherLabel(), reflecting the
                // compound nature of the problem.
                this._labels.add(Config.failedOtherLabel());
            }
            throw e;
        } finally {
            await this._pushLabelsToGitHub();
        }
    }

    // Remove all labels that satisfy both criteria:
    // * We set it. This excludes labels that are only set by humans. A label
    //   X qualifies if there is a labels.add(X) call somewhere.
    // * We remove it. This includes labels that are also removed by humans.
    //   This excludes labels that are only removed by humans and labels that
    //   are not meant to be removed at all. It is impossible to test this
    //   criterion by searching Anubis code because some labels are only
    //   removed by this method. Consult Anubis documentation instead.
    // TODO: Add these properties to labels and iterate over all labels here.
    _removeTemporaryLabels() {
        // Config.clearedForMergeLabel() can only be set by a human
        // Config.failedStagingOtherLabel() can only be removed by a human
        this._labels.remove(Config.failedDescriptionLabel());
        this._labels.remove(Config.failedOtherLabel());
        this._labels.remove(Config.passedStagingChecksLabel());
        this._labels.remove(Config.waitingStagingChecksLabel());
        this._labels.remove(Config.failedStagingChecksLabel());
        this._labels.remove(Config.abandonedStagingChecksLabel());
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
        let problem = new PrProblem(why);
        problem.requestToKeepStaged();
        return problem;
    }

    // somebody else appears to perform Anubis-only PR manipulations
    // minimize changes to avoid conflicts (but do not block other PRs)
    _exLostControl(why) {
        assert(arguments.length === 1);
        this._labelPushBan = why;
        assert(this._labelPushBan); // paranoid: `why` is truthy
        return new PrProblem(why);
    }

    // a problem that humans can discern via GitHub-maintained PR state
    // reprocessing will be required after the problem is fixed
    _exObviousFailure(why) {
        assert(arguments.length === 1);
        return new PrProblem(why);
    }

    // a problem that humans cannot easily detect without an Anubis-set label
    // reprocessing will be required after the problem is fixed
    _exLabeledFailure(why, label) {
        assert(arguments.length === 2);
        assert(!this._labelPushBan);
        this._labels.add(label);
        return new PrProblem(why);
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


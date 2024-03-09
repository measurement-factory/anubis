const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');

class PrScanResult {
    constructor(prs) {
        this.scanDate = new Date(); // the scan starting time
        this.awakePrs = [...prs]; // PRs that were not delayed during the scan
        this.minDelay = null; // if there are delayed PRs, pause them for at least this many milliseconds
    }

    isStillUnchanged(freshRawPr, freshScanDate) {
        const savedRawPr = this.awakePrs.find(el => el.number === freshRawPr.number);
        if (!savedRawPr)
            return false; // this scan has not seen freshRawPR
        if (savedRawPr.updated_at !== freshRawPr.updated_at)
            return false; // PR has changed since this scan
        // treat recently updated PRs as changed PRs to reduce the probability of ignoring
        // (PRs with) subsequent same-timestamp changes
        const unmodifiedDurationMs = freshScanDate - new Date(savedRawPr.updated_at);
        return unmodifiedDurationMs > 1000*3600;
    }

    forgetDelayedPr(rawPr, delay) {
        const oldPrs = this.awakePrs;
        this.awakePrs = this.awakePrs.filter(el => el.number !== rawPr.number);
        assert(oldPrs.length === this.awakePrs.length + 1); // one PR was removed
        if (this.minDelay === null || this.minDelay > delay)
            this.minDelay = delay;
    }
}

// PrScanResult produced by the last successfully finished PrMerger.execute() call
let _LastScan = null;

// A single Anubis processing step:
// Updates and, to the extent possible, advances each open PR. Once.
class PrMerger {

    constructor() {
        this._total = 0; // the number of open PRs received from GitHub
        this._errors = 0; // the number of PRs with processing failures

        // here, "ignored" or "skipped" means "not given to MergeContext.Process()"
        this._ignored = 0; // the number of PRs skipped due to human markings; TODO: Rename to _ignoredAsMarked
        this._ignoredAsUnchanged = 0; // the number of PRs skipped due to lack of PR updates
        this._todo = null; // raw PRs to be processed
        // an array of {sha, prNum} pairs extracted from the staging branch history (for the last 30 days)
        this._stagingBranchCommits = [];
    }

    // Implements a single Anubis processing step.
    // Returns suggested wait time until the next step (in milliseconds).
    async execute(lastScan, prIds) {
        Logger.info("runStep running");
        Logger.info('prIds: [' + prIds.join() + ']');

        this._todo = await GH.getOpenPrs();
        this._total = this._todo.length;
        Logger.info(`Received ${this._total} PRs from GitHub:`, this._prNumbers());

        await this._getStagingBranchCommits();

        let updatedPrs = Array.from(prIds, (id) => {
            if (id === null) // an event handler could not extract id
                return id;

            if (typeof(id) === "number") // PR number
                return id.toString();

            if (id.length === 40) { // staged sha
                const commit = this._stagingBranchCommits.find(e => e.sha === id);
                if (commit)
                    return commit.prNum;
            } else { // PR branch
                const pr = this._todo.find(p => p.head.ref === id);
                if (pr)
                    return pr.number.toString();
            }
            Logger.warn(`could not find a PR by ${id}`);
            return null;
        });

        // remove duplicates
        updatedPrs = updatedPrs.filter((v, idx) => updatedPrs.indexOf(v) === idx);

        await this._determineProcessingOrder(await this._current());

        if (updatedPrs.some(el => el === null)) {
            Logger.warn('discarding PR scan optimization');
            updatedPrs = null;
        } else {
            Logger.info('recently updated PRs: [' + updatedPrs.join() + ']');
        }

        let somePrWasStaged = false;
        let currentScan = new PrScanResult(this._todo);
        while (this._todo.length) {
            try {
                const rawPr = this._todo.shift();

                if (rawPr.labels.some(el => el.name === Config.ignoredByMergeBotsLabel())) {
                    this._ignored++;
                    Logger.info(`Ignoring PR${rawPr.number} due to ${Config.ignoredByMergeBotsLabel()} label`);
                    continue;
                }

                const clearedForMerge = rawPr.labels.some(el => el.name === Config.clearedForMergeLabel());
                const updated = !updatedPrs || updatedPrs.some(el => el === rawPr.number);

                // If a PR A was cleared for merge, it may be ready for merge (no updates are expected)
                // but waiting for another PR B which is currently being merged. If we switched back to PR A
                // it may remain still ready for merge so we need to process it anyway.
                if (!clearedForMerge && !updated && lastScan && lastScan.isStillUnchanged(rawPr, currentScan.scanDate)) {
                    const updatedAt = new Date(rawPr.updated_at);
                    Logger.info(`Ignoring PR${rawPr.number} because it has not changed since ${updatedAt.toISOString()}`);
                    this._ignoredAsUnchanged++;
                    continue;
                }

                const result = await MergeContext.Process(rawPr, somePrWasStaged);
                assert(!somePrWasStaged || !result.prStaged());
                somePrWasStaged = somePrWasStaged || result.prStaged();

                // delayed PRs will be processed (when the delay expires) even if not updated
                if (result.delayed())
                    currentScan.forgetDelayedPr(rawPr, result.delayMs());

            } catch (e) {
                Log.LogError(e, "PrMerger.runStep");
                this._errors++;
            }
        }

        if (this._errors)
            throw new Error(`Failed to process ${this._errors} out of ${this._total} PRs.`);

        Logger.info("Successfully handled all " + this._total + " PRs; processed/ignored/unchanged: " +
            (this._total - this._ignored - this._ignoredAsUnchanged) + "/" +
            this._ignored + "/" +
            this._ignoredAsUnchanged);

        return currentScan;
    }

    // a string enumerating PR numbers of _todo PRs
    _prNumbers() {
        const numbers = this._todo.map(pr => pr.number);
        return '[' + numbers.join() + ']';
    }

    async _clearedForMerge(prNum) {
        const labels = await GH.getLabels(prNum);
        return labels.find(lbl => lbl.name === Config.clearedForMergeLabel()) !== undefined;
    }

    // establishes correct PRs processing order
    async _determineProcessingOrder(stagingPr) {
        // temporary add a field used for sorting below
        for (let pr of this._todo)
            pr.clearedForMerge = await this._clearedForMerge(pr.number);

        this._todo.sort((pr1, pr2) => {
            // In all of the comments below, PR X' number is less than PR Y's.
            return (
                // Process cleared-for-merge Y before any uncleared X (even a
                // staged X!) to be able to merge Y without X getting cleared.
                (Config.guardedRun() && (pr2.clearedForMerge - pr1.clearedForMerge)) ||
                // Process staged Y before unstaged X to keep testing commit Y
                // when X suddenly becomes stage-able.
                (stagingPr && ((pr2.number === stagingPr.number) - (pr1.number === stagingPr.number))) ||
                // Merge in ascending PR number order because that is what
                // most humans find natural and can easily rely on.
                (pr1.number - pr2.number)
            );
        });

        // remove the temporary field
        for (let pr of this._todo)
            delete pr.clearedForMerge;

        Logger.info("PR processing order:", this._prNumbers());
    }

    async _getStagingBranchCommits() {
        this._stagingBranchCommits = [];
        const stagedCommits = await GH.getCommits(Config.stagingBranchPath(), Util.DateForDaysAgo(30));
        if (stagedCommits.length) {
            for (let commit of stagedCommits) {
                const prNum = Util.ParsePrNumber(commit.commit.message);
                if (prNum === null)
                    Logger.warn(`Could not parse PR number for a staging ${commit.sha}`);
                else
                    this._stagingBranchCommits.push({sha: commit.sha, prNum: prNum});
            }
        } else {
            const stagedBranchSha = await GH.getReference(Config.stagingBranchPath());
            const stagedHeadCommit = await GH.getCommit(stagedBranchSha);
            const prNum = Util.ParsePrNumber(stagedHeadCommit.message);
            if (prNum === null)
                Logger.warn(`Could not parse PR number for a head staging ${stagedHeadCommit.sha}`);
            else
                this._stagingBranchCommits.push({sha: stagedHeadCommit.sha, prNum: prNum});
        }
    }

    // Returns a raw PR with a staged commit (or null).
    // If that PR exists, it is in either a "staged" or "merged" state.
    async _current() {
        Logger.info("Looking for the current PR...");
        if (!this._stagingBranchCommits.length) {
            Logger.info("Could not track a PR by the staged branch.");
        } else {
            Logger.info("Staged branch head sha: " + this._stagingBranchCommits[0].sha);
            const prNum = this._stagingBranchCommits[0].prNum;
            const pr = await GH.getPR(prNum, false);
            if (pr.state === 'open') {
                Logger.info("PR" + prNum + " is the current");
                return pr;
            }
            Logger.info("Tracked PR" + prNum + " by the staged branch but it is already closed.");
        }
        Logger.info("No current PR found.");
        return null;
    }
} // PrMerger

// promises to process all PRs once, hiding PrMerger from callers
async function Step(prIds) {
    const lastScan = _LastScan;
    _LastScan = null;
    const mergerer = new PrMerger();
    _LastScan = await mergerer.execute(lastScan, prIds);
    return _LastScan.minDelay;
}

module.exports = Step;


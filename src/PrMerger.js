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
    }

    isStillUnchanged(freshRawPr, freshScanDate) {
        const savedRawPr = this.awakePrs.find(el => el.number === freshRawPr.number);
        if (!savedRawPr)
            return false; // this scan has not seen freshRawPR
        if (savedRawPr.updated_at !== freshRawPr.updated_at)
            return false; // PR has changed since this scan
        // treat recently updated PRs as changed PRs thus factoring in a
        // (slight) possibility of same-timestamp changes
        const unmodifiedDurationMs = freshScanDate - new Date(savedRawPr.updated_at);
        return unmodifiedDurationMs > 1000*3600;
    }

    forgetPr(rawPr) {
        assert(this.awakePrs.find(el => el.number === rawPr.number));
        this.awakePrs = this.awakePrs.filter(el => el.number !== rawPr.number);
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
    }

    // Implements a single Anubis processing step.
    // Returns suggested wait time until the next step (in milliseconds).
    async execute() {
        Logger.info("runStep running");

        this._todo = await GH.getOpenPrs();
        this._total = this._todo.length;
        Logger.info(`Received ${this._total} PRs from GitHub:`, this._prNumbers());

        await this._determineProcessingOrder(await this._current());

        let minDelay = null;

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

                // There are usually few 'cleared' PRs (i.e., ready for merge), so do not ignore them.
                // This should help handle sutiations where some of such 'cleared' PRs were updated just after
                // this scan has been started. Other (non-cleared) PRs (that are not going to be merged now anyway)
                // can be ignored until the next scan.
                // TODO: also handle a situation when the PR becomes 'cleared' just after this scan began.
                if (!clearedForMerge && _LastScan && _LastScan.isStillUnchanged(rawPr, currentScan.scanDate)) {
                    const updatedAt = new Date(rawPr.updated_at);
                    Logger.info(`Ignoring PR${rawPr.number} because it has not changed since ${updatedAt.toISOString()}`);
                    this._ignoredAsUnchanged++;
                    continue;
                }

                const result = await MergeContext.Process(rawPr, somePrWasStaged);
                assert(!somePrWasStaged || !result.prStaged());
                somePrWasStaged = somePrWasStaged || result.prStaged();
                if (result.delayed() && (minDelay === null || minDelay > result.delayMs()))
                    minDelay = result.delayMs();

                // delayed PRs will be processed (when the delay expires) even if not updated
                if (result.delayed())
                    currentScan.forgetPr(rawPr);

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

        _LastScan = currentScan;

        return minDelay;
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

    // Returns a raw PR with a staged commit (or null).
    // If that PR exists, it is in either a "staged" or "merged" state.
    async _current() {
        Logger.info("Looking for the current PR...");
        const stagedBranchSha = await GH.getReference(Config.stagingBranchPath());
        const stagedBranchCommit = await GH.getCommit(stagedBranchSha);
        Logger.info("Staged branch head sha: " + stagedBranchCommit.sha);
        const prNum = Util.ParsePrNumber(stagedBranchCommit.message);
        if (prNum === null) {
            Logger.info("Could not track a PR by the staged branch.");
        } else {
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
function Step() {
    try {
        let mergerer = new PrMerger();
        return mergerer.execute();
    } catch (e) {
        _LastScan = null;
        throw e;
    }
}

module.exports = Step;


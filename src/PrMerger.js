const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');

// A single Anubis processing step:
// Updates and, to the extent possible, advances each open PR. Once.
class PrMerger {

    constructor() {
        this._total = 0; // the number of open PRs received from GitHub
        this._errors = 0; // the number of PRs with processing failures
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
        while (this._todo.length) {
            try {
                const rawPr = this._todo.shift();
                const result = await MergeContext.Process(rawPr, somePrWasStaged);
                assert(!somePrWasStaged || !result.prStaged());
                somePrWasStaged = somePrWasStaged || result.prStaged();
                if (result.delayed() && (minDelay === null || minDelay > result.delayMs()))
                    minDelay = result.delayMs();
            } catch (e) {
                Log.LogError(e, "PrMerger.runStep");
                this._errors++;
            }
        }

        if (this._errors)
            throw new Error(`Failed to process ${this._errors} out of ${this._total} PRs.`);

        Logger.info("Successfully processed all " + this._total + " PRs.");
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
        const stagedSha = await GH.getReference(Config.stagingBranchPath());
        const stagedCommit = await GH.getCommit(stagedSha);
        const prNum = Util.ParsePrNumber(stagedCommit.message);
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
    let mergerer = new PrMerger();
    return mergerer.execute();
}

module.exports = Step;


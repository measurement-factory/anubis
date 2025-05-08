import assert from 'assert';
import Config from './Config.js';
import * as Log from './Logger.js';
const Logger = Log.Logger;
import * as GH from './GitHubUtil.js';
import * as Util from './Util.js';
import Process from './MergeContext.js';

class PrScanResult {
    constructor(prs) {
        this.scanDate = new Date(); // the scan starting time
        this.awakePrs = [...prs]; // PRs that were not delayed during the scan
        // PRs that wait for some timeout to expire.
        // Each array element is an {number, expirationDate} structure,
        // where the number field represents PR number of Number type and
        // expirationDate member has a Date type
        this.delayedPrs = [];
        this.minDelay = null; // if there are delayed PRs, pause them for at least this many milliseconds
    }

    isStillUnchanged(updatedPrs, freshRawPr, freshScanDate) {
        assert.strictEqual(arguments.length, 3);
        if (updatedPrs === null)
            return false;

        if (updatedPrs.some(el => el === freshRawPr.number))
            return false;

        // A cleared for merging PR B may be waiting for PR A being merged. When
        // PR A is merged or its merging fails, we may need to advance PR B, even
        // though PR B remains unchanged from GitHub metadata/events point of view.
        // This could be optimized further by touching cleared PRs in reaction to
        // staged commit events instead, but perhaps there are never enough cleared
        // PRs to warrant further optimizations.
        if (freshRawPr.labels.some(el => el.name === Config.clearedForMergeLabel()))
            return false;

        // XXX: The above concern also applies to PRs that are not "cleared for
        // merging" but can be proactively staged in anticipation of that
        // clearance. TODO: Mark the first such PR that is waiting for the
        // staging branch "lock" and treat it as "changed", returning false.

        const savedRawPr = this.awakePrs.find(el => el.number === freshRawPr.number);
        if (savedRawPr) {
            if (savedRawPr.updated_at !== freshRawPr.updated_at)
                return false; // PR has changed since this scan

            // treat recently updated PRs as changed PRs to reduce the probability of ignoring
            // (PRs with) subsequent same-timestamp changes
            const unmodifiedDurationMs = freshScanDate - new Date(savedRawPr.updated_at);
            return unmodifiedDurationMs > 1000*3600;
        }

        const delayedPr = this.delayedPrs.find(el => el.number === freshRawPr.number);
        if (!delayedPr)
            return false; // this scan has not seen freshRawPr (neither awakePrs nor delayedPrs have it)
        return delayedPr.expirationDate > freshScanDate;
    }

    forgetDelayedPr(rawPr, delay) {
        const oldPrs = this.awakePrs;
        this.awakePrs = this.awakePrs.filter(el => el.number !== rawPr.number);
        assert(oldPrs.length === this.awakePrs.length + 1); // one PR was removed

        assert(!this.delayedPrs.some(el => el.number === rawPr.number));
        let date = new Date();
        date.setSeconds(date.getSeconds() + delay/1000);
        this.delayedPrs.push({number: rawPr.number, expirationDate: date});
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
        this._stagedBranchSha = null; // the SHA of the branch head
    }

    // Implements a single Anubis processing step.
    // Returns suggested wait time until the next step (in milliseconds).
    async execute(lastScan, prIds) {
        Logger.info("runStep running");

        this._todo = await GH.getOpenPrs();
        this._total = this._todo.length;
        Logger.info(`Received ${this._total} PRs from GitHub:`, this._prNumbers());

        const currentPr = await this._current();
        await this._determineProcessingOrder(currentPr);

        let updatedPrs = await this._prNumbersFromIds(prIds, currentPr, this._todo);
        // Treat the 'null' updatedPrs below as if all PRs have been 'updated'.
        // An empty updatedPrs means that none of the PRs has been updated.
        if (updatedPrs === null) {
            Logger.info('will not use PR scan optimization');
        } else {
            if (currentPr)
                updatedPrs.push(currentPr.number);
            // remove duplicates
            updatedPrs = updatedPrs.filter((v, idx) => updatedPrs.indexOf(v) === idx);
            const prNumbers = updatedPrs.join();
            Logger.info(`Got events since ${lastScan.scanDate.toISOString()} for these PRs: [${prNumbers}]`);
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

                // The 'lastScan' check turns off optimization for the initial scan.
                if (lastScan && lastScan.isStillUnchanged(updatedPrs, rawPr, currentScan.scanDate)) {
                    const updatedAt = new Date(rawPr.updated_at);
                    Logger.info(`Ignoring PR${rawPr.number} because it has not changed since ${updatedAt.toISOString()}`);
                    this._ignoredAsUnchanged++;
                    continue;
                }

                const result = await Process(rawPr, somePrWasStaged);
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

    _extractPrNumber(message, source) {
        const prNum = Util.ParsePrNumber(message);
        if (prNum === null) {
            Logger.warn(`Could not get PR number by parsing ${source} message`);
            return null;
        } else {
            Logger.info(`Got PR${prNum} from ${source} message`);
            return prNum;
        }
    }

    // Translates each element of prIds into a PR number.
    // Returns an array of PR numbers if it could translate all Ids or null otherwise.
    async _prNumbersFromIds(prIds, currentPr, prList) {
        assert(prIds !== undefined);
        if (prIds === null)
            return null;

        let prNumList = [];

        for (let id of prIds) {
            if (id.type === "prNum") {
                prNumList.push(id.value);
            } else if (id.type === "sha") {
                assert(!currentPr || this._stagedBranchSha !== null);
                if (currentPr && (id.value === this._stagedBranchSha)) {
                    prNumList.push(currentPr.number);
                } else {
                    const commit = await GH.getCommit(id.value);
                    const prNum = this._extractPrNumber(commit.message, id.value);
                    if (prNum === null)
                        continue;
                    prNumList.push(prNum);
                }
            } else {
                assert(id.type === "branch");
                if (id.value === Config.stagingBranch()) {
                    assert(id.message !== null);
                    const prNum = this._extractPrNumber(id.message, id.value);
                    if (prNum === null)
                        continue;
                    prNumList.push(prNum);
                } else {
                    const pr = prList.find(p => p.head.ref === id.value);
                    if (!pr) {
                        Logger.info(`Could not find a PR by ${id} branch`);
                        continue;
                    }
                    prNumList.push(pr.number);
                }
            }
        }
        return prNumList;
    }

    // Returns a raw PR with a staged commit (or null).
    // If that PR exists, it is in either a "staged" or "merged" state.
    async _current() {
        Logger.info("Looking for the current PR...");
        this._stagedBranchSha = await GH.getReference(Config.stagingBranchPath());
        const stagedBranchCommit = await GH.getCommit(this._stagedBranchSha);
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
export default async function Step(prIds) {
    assert(prIds !== undefined);
    if (prIds !== null)
        Logger.info('prIds: [' + prIds.join() + ']');
    const lastScan = _LastScan;
    _LastScan = null;
    const mergerer = new PrMerger();
    _LastScan = await mergerer.execute(lastScan, prIds);
    return _LastScan.minDelay;
}


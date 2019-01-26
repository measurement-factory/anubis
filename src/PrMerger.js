const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');
const PullRequest = MergeContext.PullRequest;

// Gets PR list from GitHub and processes some/all PRs from this list.
class PrMerger {

    constructor() {
        this.total = 0;
        this.errors = 0;
        // stores the the number of milliseconds to be re-run
        // for the oldest 'slow burner'
        this.rerunIn = null;
        this._todo = null; // raw PRs to be processed
        this._tags = null; // tags pointing to staged commits of _todo PRs
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

    // gets open PRs from GitHub and processes them one by one
    async runStep() {
        Logger.info("runStep running");

        this._todo = await GH.getOpenPrs();
        Logger.info("PRs received from GitHub:", this._prNumbers());

        await this._importTags(await GH.getTags()); // needs this._todo

        await this._determineProcessingOrder(await this._current());

        let somePrWasStaged = false;
        while (this._todo.length) {
            try {
                const rawPr = this._todo.shift();
                this.total++;
                let pr = new PullRequest(rawPr, somePrWasStaged);
                const result = await pr.process();
                somePrWasStaged = somePrWasStaged || pr.staged();
                if (result.delayed() && (this.rerunIn === null || this.rerunIn > result.delay()))
                    this.rerunIn = result.delay();
            } catch (e) {
                this.errors++;
                if (this._todo.length)
                    Log.LogError(e, "PrMerger.runStep");
                else
                    throw e;
            }
        }
    }

    // forgets PR-unrelated tags and
    // deletes (from GitHub) PR tags which do not have a corresponding open PR
    async _cleanTags(rawTags) {
        assert(rawTags);

        assert(!this._tags);
        this._tags = [];

        for (let tag of rawTags) {
            let prNum = Util.ParseTag(tag.ref);
            if (prNum === null)
                continue;
            for (let pr of this._todo) {
                if (prNum === pr.number.toString()) {
                    prNum = null;
                    this._tags.push(tag);
                    break;
                }
            }
            if (prNum !== null) {
                if (!Config.dryRun())
                    await GH.deleteReference(Util.StagingTag(prNum));
            }
        }
    }

    // returns raw PR having staging commit at the tip of the staging branch (or null)
    // if that PR exists, it is either "staged" or "post-staged"
    async _current() {
        Logger.info("Looking for the current PR...");
        const stagingSha = await GH.getReference(Config.stagingBranchPath());
        // search for a tag, the staging_branch points to,
        // and parse out PR number from the tag name
        const tag = this._tags.find((t) => { return (t.object.sha === stagingSha) && Util.MatchTag(t.ref); });
        if (tag === undefined) {
            Logger.info("No current PR found.");
            return null;
        }
        const prNum = Util.ParseTag(tag.ref);
        Logger.info("PR" + prNum + " is the current");
        const stagingPr = await GH.getPR(prNum, false);
        assert(stagingPr.state === "open");
        return stagingPr;
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }
} // PrMerger

module.exports = PrMerger;


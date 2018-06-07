const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');
const MergeInitiator = MergeContext.MergeInitiator;
const MergeFinalizer = MergeContext.MergeFinalizer;

// Gets PR list from GitHub and processes some/all PRs from this list.
class PrMerger {

    constructor() {
        this.total = 0;
        this.errors = 0;
        // stores the the number of milliseconds to be re-run
        // for the oldest 'slow burner'
        this.rerunIn = null;
    }

    async _clearedForMerge(prNum) {
        const labels = await GH.getLabels(prNum);
        return labels.find(lbl => lbl.name === Config.clearedForMergeLabel()) !== undefined;
    }

    async _getPRList(finalizer) {
        let prList = await GH.getPRList();
        for (let pr of prList) {
            pr.clearedForMerge = await this._clearedForMerge(pr.number);
            if (finalizer && finalizer.prNumber() === pr.number)
                pr.anubisProcessor = finalizer;
            else
                pr.anubisProcessor = new MergeInitiator(pr);
        }

        prList.sort((pr1, pr2) => { return (Config.guardedRun() && (pr2.clearedForMerge - pr1.clearedForMerge)) ||
                pr2.anubisProcessor.isFinalizer() - pr1.anubisProcessor.isFinalizer() ||
                pr1.number - pr2.number;
        });
        this._logPRList(prList);
        return prList;
    }

    _logPRList(prList) {
        let prStr = prList.length ? "Got PRs from GitHub: " : "PR list is empty";
        for (let pr of prList)
            prStr += pr.number + " ";
        Logger.info(prStr);
    }

    // Gets PR list from GitHub and processes them one by one.
    // Returns if either all PRs have been processed(merged or skipped), or
    // there is a PR still-in-merge.
    async runStep() {
        Logger.info("runStep running");
        const finalizer = await this._current();
        const prList = await this._getPRList(finalizer);

        this.total = 0;
        while (prList.length) {
            try {
                const pr = prList.shift();
                this.total++;
                const result = await pr.anubisProcessor.process();
                if (!this.prDone(pr.anubisProcessor, result))
                    return true;
            } catch (e) {
                this.errors++;
                if (prList.length)
                    Log.LogError(e, "PrMerger.runStep");
                else
                    throw e;
            }
        }
        return false;
    }

    // 'true': the PR processing finished (succeeded or failed)
    // 'false': the PR is still in progress (started or suspended)
    prDone(processor, result) {
        if (processor.isFinalizer()) {
            assert(!result.delayed());
            if (result.succeeded() || result.failed())
                return true;
            // This result is when one of'dry run' bot options is on.
            // Will wait while this option is on the way.
            assert(result.suspended());
        } else {
            assert(processor.isInitiator());
            if (result.failed() || result.suspended())
                return true;

            if (result.delayed()) {
                if (this.rerunIn === null || this.rerunIn > result.delay())
                    this.rerunIn = result.delay();
                assert(this.rerunIn);
                return true;
            }

            assert(result.succeeded());
        }
        return false;
    }

    // Loads 'being-in-merge' PR, if exists (the PR has tag and staging_branch points to the tag).
    async _current() {
        Logger.info("Looking for the current PR...");
        const stagingSha = await GH.getReference(Config.stagingBranchPath());
        // request all repository tags
        let tags = await GH.getTags();
        // search for a tag, the staging_branch points to,
        // and parse out PR number from the tag name
        const tag = tags.find((t) => { return (t.object.sha === stagingSha) && Util.MatchTag(t.ref); });
        if (tag === undefined) {
            Logger.info("No current PR found.");
            return null;
        }
        const prNum = Util.ParseTag(tag.ref);
        Logger.info("PR" + prNum + " is the current");
        const stagingPr = await GH.getPR(prNum, false);
        return new MergeFinalizer(stagingPr, stagingSha);
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }
} // PrMerger

module.exports = PrMerger;


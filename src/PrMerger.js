const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');
const PrUpdater = MergeContext.PrUpdater;
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

    /// Obtain PR list from GitHub, updates GitHub PR state
    /// (labels, approvals, etc.) and filters out PRs not ready
    /// for further processing.
    /// Returns a sorted list of PRs ready-for-processing.
    async _preparePRList(finalizer) {
        let prs = await GH.getPRList();
        this._logPRList(prs, "PRs got from GitHub: ");
        let prList = [];
        for (let pr of prs) {
            if (finalizer && finalizer.prNumber() === pr.number) {
                // TODO: update PR metatata the current PR also
                pr.anubisProcessor = finalizer;
                prList.push(pr);
            } else {
                let updater = new PrUpdater(pr);
                const result = await updater.process();
                if (!result.failed()) {
                    pr.anubisProcessor = new MergeInitiator(pr);
                    prList.push(pr);
                }
            }
        }
        prList.sort((pr1, pr2) => { return (Config.guardedRun() && (pr2.clearedForMerge - pr1.clearedForMerge)) ||
                pr2.anubisProcessor.isFinalizer() - pr1.anubisProcessor.isFinalizer() ||
                pr1.number - pr2.number;
        });
        this._logPRList(prList, "PRs selected for processing: ");
        return prList;
    }

    _logPRList(prList, description) {
        let prStr = description;
        if (prList.length === 0)
            prStr += "empty list";
        else {
            for (let pr of prList)
                prStr += pr.number + " ";
        }
        Logger.info(prStr);
    }

    // Gets PR list from GitHub and processes them one by one.
    // Returns if either all PRs have been processed(merged or skipped), or
    // there is a PR still-in-merge.
    async runStep() {
        Logger.info("runStep running");
        const finalizer = await this._current();
        const prList = await this._preparePRList(finalizer);

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


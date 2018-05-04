const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');

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

    async _getPRList() {
        let prList = await GH.getPRList();
        for (let pr of prList)
            pr.clearedForMerge = await this._clearedForMerge(pr.number);

        prList.sort((pr1, pr2) => { return pr2.clearedForMerge - pr1.clearedForMerge || pr1.number - pr2.number; });
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
        const currentContext = await this._current();
        if (currentContext && !(await this._finishContext(currentContext)))
            return true; // still in-process

        const prList = await this._getPRList();
        this._logPRList(prList);

        while (prList.length) {
            try {
                const pr = prList.shift();
                let context = new MergeContext(pr);
                this.total++;
                const mergeStart = await context.startProcessing();
                if (mergeStart.succeeded())
                    return true;
                else if (mergeStart.delayed()) {
                    // the first found will give us the minimal delay
                    if (this.rerunIn === null)
                        this.rerunIn = mergeStart.delay();
                } else {
                    assert(mergeStart.failed() || mergeStart.suspended());
                }

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

    // Continues executing the context and returns:
    // 'true': the context executing was finished (succeeded or failed)
    // 'false': the context is still in progress
    async _finishContext(context) {
        this.total = 1;
        const mergeFinish = await context.finishProcessing();
        assert(!mergeFinish.delayed());
        if (mergeFinish.succeeded() || mergeFinish.failed())
            return true;
        // This result is when one of'dry run' bot options is on.
        // Will wait while this option is on the way.
        assert(mergeFinish.suspended());
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
        return new MergeContext(stagingPr, stagingSha);
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }
} // PrMerger


module.exports = PrMerger;


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
    }

    async _clearedForMerge(prNum) {
        const labels = await GH.getLabels(prNum);
        return labels.find(lbl => lbl.name === Config.clearedForMergeLabel()) !== undefined;
    }

    /// Obtains PR list from GitHub, updates GitHub PR state
    /// (labels, approvals, etc.)
    /// Returns a sorted list of PRs ready-for-processing.
    async _preparePRList(stagingPr) {
        let prList = await GH.getPRList();
        for (let pr of prList)
            pr.clearedForMerge = await this._clearedForMerge(pr.number);
        this._logPRList(prList, "PRs got from GitHub: ");

        // Include a not-fully-cleanupped staging PR (if it is missing),
        // since the list contains only opened PRs
        if (stagingPr && !prList.some(pr => pr.number === stagingPr.number))
            prList.push(stagingPr);

        prList.sort((pr1, pr2) => { return (Config.guardedRun() && (pr2.clearedForMerge - pr1.clearedForMerge)) ||
                (stagingPr && ((pr2.number === stagingPr.number) - (pr1.number === stagingPr.number))) ||
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
        const stagingPr = await this._current();
        const prList = await this._preparePRList(stagingPr);

        this.total = 0;
        let suspendedEarlier = false;
        while (prList.length) {
            try {
                const rawPr = prList.shift();
                this.total++;
                let pr = new PullRequest(rawPr);
                const result = await pr.process(suspendedEarlier);
                suspendedEarlier = suspendedEarlier || result.suspended();
                if (result.delayed() && (this.rerunIn === null || this.rerunIn > result.delay()))
                    this.rerunIn = result.delay();
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

    // returns raw PR having staging commit at the tip of the staging branch (or null)
    // if that PR exists, it is either "staged" or "post-staged"
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
        if (stagingPr.state !== "open")
            Logger.warn("PR" + stagingPr.number + " was closed but needs cleanup");
        return stagingPr;
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }
} // PrMerger

module.exports = PrMerger;

